// `fix-group apply`: phase 4, the port of `cmd_apply` in
// `scripts/common/fix-group.sh`. It writes the constraint, runs the fix
// install, and asks `validate` whether the alerts are clear. When they are
// not, it goes up the remediation ladder. This file holds the order of the
// steps and the state that they share. Each decision is a pure function in
// `fix-group-ladder.ts`. The contract is in the header of `fix-group.ts`.
//
// The ladder, after a validate that fails:
//   step 4  a line with no copy stops the phase, at each failed validate.
//   step 1  scope the constraint to the parents that the violation paths
//           name, then install and validate again. Only npm paths name one.
//   step 2  the bare override (`--tighten-bare`), then install and validate
//           again. It is the widest change, so it comes last.
//   step 3  the stale-lockfile stop.
//   then    a judgment for the agent: `validate_failed_after_ladder`.
//
// The adapter verbs run in process. The package manager that `install`
// starts and the git call run under the prefix. `apply` runs one git
// command, `status --porcelain`. It never prunes a worktree (git.md).
//
// This file ships. It imports nothing outside the plugin.

import { type CommandResult, type FailedReport, failedReport } from '../cli/command.ts'
import { fieldOf, orElse, tostring, uniqueJq } from '../jq.ts'
import { type Failure, failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import {
  readOptionalStrings,
  readOptionalValue,
  readString,
  readValue,
  type StateFile,
  writeKey,
} from '../state.ts'
import { failPhase, type Loaded, outputOf, promisedField, runInstall } from './fix-group-common.ts'
import {
  budgetSpent,
  emptyDiff,
  FIX_INSTALL_BUDGET,
  invalidationOf,
  type LadderStep,
  LOCKFILE_REFRESH,
  labelsOf,
  lineVersions,
  movesOf,
  nextRung,
  type ParentDerivation,
  parentDerivation,
  rangeOf,
  retargetOf,
  uncheckedAlerts,
  widestShape,
} from './fix-group-ladder.ts'

/** A step that ends the phase: exit 1, 2 or 3. */
type Stop = FailedReport | Failure

/** Exit 2: a decision that goes back to the agent. Fail closed, never guess. */
const needsJudgment = (decisionPoint: string, evidence: JsonObject): FailedReport =>
  failedReport(
    `fix-group: needs judgment at ${decisionPoint}`,
    { status: 'needs_judgment', decision_point: decisionPoint, evidence },
    2,
  )

/** A JSON object, or null for any other value. */
const recordOf = (value: unknown): JsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null

/** The failure for a state key whose value is not a list of names. */
const notNames = (state: StateFile, key: string, value: JsonValue): Failure =>
  failed(
    `the state file at ${state.path} has no usable value for '${key}': ` +
      `expected a list of names, found ${JSON.stringify(value)}.`,
  )

const isNames = (value: JsonValue): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === 'string')

/** What the steps of one `apply` share. */
interface Run {
  readonly loaded: Loaded
  readonly range: string
  /** Each distinct `vulnerable_range` of the group, sorted. */
  readonly vulnerable: readonly string[]
  /** The baseline snapshot, after the control install. */
  readonly baseline: JsonValue
  /** The JSON text of `group.sibling_alerts`, or null when the group has no such key (#105). */
  readonly siblings: string | null
  state: StateFile
  /** The fix installs of the run, from the state. */
  installs: number
  applied: string[]
  /** The last `apply_constraint` answer. */
  answer: JsonObject
  /** The last `validate` answer, or null before the first. */
  validate: JsonObject | null
  validateOk: boolean
  tightenBare: boolean
  derivation: ParentDerivation | null
  /** The union of the install signals of the run, as the state has it after each install. */
  signals: string[]
}

/** Write one key into the state of the run. */
const save = (run: Run, key: string, value: JsonValue): Failure | null => {
  const written = writeKey(run.state, key, value)
  if (written.outcome !== 'ok') return failed(written.error)
  run.state = written.value
  return null
}

/** The list of a promised field of the answer, or the failure of the phase. */
const listField = (
  answer: JsonObject,
  source: string,
  key: 'written' | 'observations',
  why: string,
): FailedReport | null => {
  const field = promisedField('apply', answer, source, key)
  if ('outcome' in field) return field
  return Array.isArray(field.value)
    ? null
    : failPhase(
        'apply',
        `apply_constraint answered ${key === 'written' ? "a 'written'" : "an 'observations'"} that is not an array. ${why}`,
      )
}

/** One `apply_constraint`, with the parents of the run. The port of `apply_call`. */
const applyCall = (run: Run, tightenBare: boolean): Stop | null => {
  const { adapter, driver } = run.loaded
  const pkg = driver.package
  const tree = run.loaded.tree()
  const answer =
    tree.outcome === 'ok'
      ? adapter.applyConstraint(tree.value, {
          pkg,
          range: run.range,
          parents: run.applied,
          tightenBare,
        })
      : tree
  // What is known: the verb failed and no install ran. What is not known:
  // whether it wrote to the manifest before it failed.
  if (answer.outcome !== 'ok') {
    return failPhase(
      'apply',
      'apply_constraint exited non-zero, so no fix install was run and no PR was opened. ' +
        'Whether it wrote anything before failing is not observed here; the worktree is ' +
        `discarded on cleanup either way. Quoting the adapter verbatim: ${answer.error}`,
    )
  }
  const value = answer.value as unknown as JsonObject
  const source = `apply_constraint ${pkg}`
  const stop =
    listField(
      value,
      source,
      'written',
      'It is the only statement of what actually changed, and every classification below reads it.',
    ) ??
    listField(
      value,
      source,
      'observations',
      'A missing one silently turns every tightened bare override into an added one in the PR body.',
    )
  if (stop !== null) return stop
  const retarget = retargetOf(value.written as JsonValue[], pkg)
  if (retarget !== null) {
    return failPhase(
      'apply',
      "apply_constraint retargeted a declaration that merely collides with this package's name: " +
        `${JSON.stringify(retarget)}. The adapter cannot tell the two senses of the key apart and ` +
        'neither can this flow, so the fix install was not run and no PR was opened. Escalate as ' +
        'a repository that needs the name collision resolved by hand (#49).',
    )
  }
  run.answer = value
  return null
}

/** Add the signals of one install to the union in the state. */
const recordSignals = (run: Run, signals: readonly string[]): Failure | null => {
  const previous = readOptionalStrings(run.state, 'install_signals')
  if (previous.outcome !== 'ok') return previous
  run.signals = uniqueJq([...previous.value, ...signals])
  return save(run, 'install_signals', run.signals)
}

/** One fix install, against the budget of the run. The port of `fix_install_step`. */
const fixInstall = async (run: Run): Promise<Stop | null> => {
  if (budgetSpent(run.installs)) {
    return needsJudgment('install_budget_exhausted', {
      fix_installs: run.installs,
      budget: FIX_INSTALL_BUDGET,
      validate: run.validate,
    })
  }
  run.installs += 1
  const counted = save(run, 'fix_installs', run.installs)
  if (counted !== null) return counted
  const install = await runInstall(run.loaded)
  const recorded = recordSignals(run, install.signals)
  if (recorded !== null) return recorded
  if (install.ok) return null
  // The phase of the evidence is `install`: the agent copies it to its
  // result. A failure that the ladder does not cover is for the agent.
  return needsJudgment('install_failure', {
    phase: 'install',
    error: install.output,
    registry_timeout_retry: install.retried,
    fix_installs: run.installs,
    install_signals: install.signals as string[],
    written: run.answer.written as JsonValue,
  })
}

/** One `validate` of the line. The port of `validate_call`. */
const validateCall = (run: Run): Stop | null => {
  const { adapter, driver } = run.loaded
  const pkg = driver.package
  const tree = run.loaded.tree()
  const answer =
    tree.outcome === 'ok'
      ? adapter.validate(tree.value, pkg, run.range, {
          line: driver.majorLine,
          vulnerable: run.vulnerable,
          baseline: JSON.stringify(run.baseline),
          siblingAlerts: run.siblings,
        })
      : tree
  if (answer.outcome !== 'ok') {
    return failPhase('validate', `validate produced no readable report: ${answer.error}`)
  }
  const value = answer.value as unknown as JsonObject
  if (!Object.hasOwn(value, 'ok')) {
    return failPhase('validate', 'validate produced no readable report: ')
  }
  run.validate = value
  run.validateOk = value.ok === true
  // A fatal move on another line stops the run. The checks of `--line`
  // cannot see a copy outside the line (#83).
  const fatal = movesOf(value.other_line_moves, 'fatal')
  if (fatal.length > 0) {
    return failPhase(
      'validate',
      `the install moved a copy of ${pkg} on a major line this group does not own. Narrowing ` +
        'the key is not the remedy; escalate the repository. other_line_moves fatal entries: ' +
        `${JSON.stringify(fatal)}. Entries apply_constraint wrote: ` +
        `${JSON.stringify(run.answer.written)}`,
    )
  }
  return null
}

/** One more constraint, install and validate. The steps of the ladder all end so. */
const attempt = async (run: Run, tightenBare: boolean): Promise<Stop | null> =>
  applyCall(run, tightenBare) ?? (await fixInstall(run)) ?? validateCall(run)

/** The parents on other major lines, from the `declared_ranges` answer of `classify`. */
const otherLines = (run: Run): string[] | null => {
  const declared = readOptionalValue(run.state, 'declared')
  if (declared !== null && recordOf(declared) === null) return null
  const other = orElse(fieldOf(declared, 'parents_other_lines'), []) as JsonValue
  return isNames(other) ? other : null
}

/**
 * Step 1: read the parents from the violation paths. The answer is the
 * parents to add, or the failure of the phase.
 */
const deriveParents = (run: Run, validate: JsonObject): Stop | readonly string[] => {
  const violations = validate.violations
  if (
    !Array.isArray(violations) ||
    !violations.every((entry) => typeof recordOf(entry)?.path === 'string')
  ) {
    return failPhase(
      'validate',
      "validate reported a violation with no readable 'path', so the ladder's first step " +
        'cannot tell which copies name a parent and which name only themselves. It is part of ' +
        'the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); dropped instead, the ' +
        "entry counts in neither total and the run reports the pnpm/Yarn 'no parent in the path " +
        `shape' finding about a report that simply stopped answering. violations: ` +
        `${JSON.stringify(fieldOf(validate, 'violations'))}`,
    )
  }
  const other = otherLines(run)
  if (other === null) {
    return failPhase(
      'validate',
      "validate's violations[] could not be read for the ladder's first step: " +
        JSON.stringify(violations),
    )
  }
  const paths = violations.map((entry) => (entry as JsonObject).path as string)
  run.derivation = parentDerivation(paths, other, run.applied, run.loaded.driver.package)
  return run.derivation.parents
}

/**
 * The ladder: each step until validate passes, or a stop. The answer is
 * null when validate passed.
 */
const ladder = async (run: Run): Promise<Stop | null> => {
  const { driver } = run.loaded
  const line = driver.majorLine
  let step: LadderStep = 0
  while (!run.validateOk) {
    const validate = run.validate as JsonObject
    // Step 4 first: with no copy of the line installed, the override does
    // nothing, and no step can change that.
    const present = promisedField(
      'validate',
      validate,
      `validate --line ${line} ${driver.package}`,
      'line_present',
    )
    if ('outcome' in present) return present
    if (tostring(present.value) === 'false') {
      return failPhase(
        'validate',
        `line_present is false: nothing on the ${line}.x line of ${driver.package} is ` +
          'installed, so there was nothing here to fix and the override applied does nothing. ' +
          `requires_major_bump: ${JSON.stringify(fieldOf(validate, 'requires_major_bump'))}`,
      )
    }
    let uncovered: readonly string[] = []
    if (step === 0) {
      const derived = deriveParents(run, validate)
      if ('outcome' in derived) return derived
      uncovered = derived
    }
    const invalidated = invalidationOf(run.answer)
    const rung = nextRung(step, uncovered, invalidated)
    if (rung.kind === 'add_parents') {
      step = 1
      run.applied = uniqueJq([...run.applied, ...rung.parents])
      const stop = save(run, 'applied_parents', run.applied) ?? (await attempt(run, false))
      if (stop !== null) return stop
    } else if (rung.kind === 'tighten_bare') {
      step = 2
      run.tightenBare = true
      const stop = await attempt(run, true)
      if (stop !== null) return stop
    } else if (rung.kind === 'stale_lockfile') {
      return failPhase(
        'validate',
        'validation still fails and the lockfile-invalidation pass cannot account for it: ' +
          `${JSON.stringify(invalidated)}. Deleting a whole lockfile needs interactive ` +
          'confirmation this flow cannot obtain, so lockfile regeneration is likely required ' +
          'and needs a human-driven session.',
      )
    } else {
      return needsJudgment('validate_failed_after_ladder', {
        validate,
        written: run.answer.written as JsonValue,
        applied_parents: run.applied,
        tighten_bare_applied: run.tightenBare,
        lockfile_invalidated: invalidated as JsonValue,
        parent_derivation: run.derivation as unknown as JsonValue,
      })
    }
  }
  return null
}

/** The checks before the first write, and the run that they give. */
const prepare = (loaded: Loaded): Stop | Run => {
  const state = loaded.driver.state
  const relationship = readOptionalValue(state, 'relationship')
  if (relationship === null || relationship === '') return failed("apply: run 'classify' first")
  // Without the baseline, validate gets `--baseline null`, and a move on
  // another line is "not checked" in place of "checked and clean" (#146).
  const baseline = readOptionalValue(state, 'baseline')
  if (baseline === null) {
    return failed(
      "apply: run 'baseline' first. Without its post-control-install snapshot, validate is " +
        "handed --baseline null, which reports every cross-line move as 'not checked' rather " +
        'than as checked and clean (#146).',
    )
  }
  const alerts = readValue(state, 'group.alerts')
  if (alerts.outcome !== 'ok') return alerts
  if (!Array.isArray(alerts.value) || alerts.value.length === 0) {
    return failed(
      "apply: the group payload carries no alerts array; run 'setup' with a complete group",
    )
  }
  // An alert with no range is never dropped from `--vulnerable`: then
  // validate cannot say whether it is clear.
  const unchecked = uncheckedAlerts(alerts.value)
  if (unchecked.length > 0) {
    return failPhase(
      'apply',
      `alert(s) ${JSON.stringify(unchecked)} in this group carry no vulnerable_range, so ` +
        'validate cannot be asked whether they were cleared. Dropping them from --vulnerable ' +
        'would let unresolved_alerts come back empty for an alert nothing checked: the silent ' +
        'partial fix that flag exists to prevent. Nothing was written.',
    )
  }
  const fixed = readString(state, 'group.highest_fixed_version')
  if (fixed.outcome !== 'ok') return fixed
  // The count is read strictly. A default of zero would unbound the run.
  const count = readValue(state, 'fix_installs')
  if (count.outcome !== 'ok') return count
  const installs = tostring(count.value)
  if (!/^[0-9]+$/.test(installs)) {
    return failed(
      `apply: the state file's fix_installs is '${installs}', which is not a count. The ` +
        'fix-install budget cannot be enforced against it, and defaulting it to zero would ' +
        'silently unbound the run.',
    )
  }
  const range = rangeOf(fixed.value)
  if (range === null)
    return failed(`apply: highest_fixed_version '${fixed.value}' has no readable major`)
  // `[]` is an answer, and goes to validate as `[]`. With no key, the flag
  // is not given, and validate calls each move on another line fatal (#105).
  // The read of `group.alerts` found the group, so it is an object.
  const group = readOptionalValue(state, 'group') as JsonObject
  let siblings: string | null = null
  if (Object.hasOwn(group, 'sibling_alerts')) {
    const value = readValue(state, 'group.sibling_alerts')
    if (value.outcome !== 'ok') return value
    siblings = JSON.stringify(value.value)
  }
  return {
    loaded,
    range,
    vulnerable: uniqueJq(
      alerts.value.map((alert) => (alert as JsonObject).vulnerable_range as string),
    ),
    baseline,
    siblings,
    state,
    installs: Number(installs),
    applied: [],
    answer: {},
    validate: null,
    validateOk: false,
    tightenBare: false,
    derivation: null,
    signals: [],
  }
}

/**
 * The parents of the first constraint: none for a direct dependency, else
 * the eligible parents of `classify`.
 */
const firstParents = (run: Run): Failure | string[] => {
  if (readOptionalValue(run.state, 'relationship') === 'direct') return []
  const eligible = readValue(run.state, 'eligible_parents')
  if (eligible.outcome !== 'ok') return eligible
  return isNames(eligible.value)
    ? eligible.value
    : notNames(run.state, 'eligible_parents', eligible.value)
}

/**
 * The observations from before the first `apply_constraint` of the run, or
 * null when the run has none yet. A re-run keeps the first: a new read sees
 * the override that this run wrote, and calls a bare override that it
 * added `tightened`.
 */
const storedObservations = (run: Run): Failure | JsonValue[] | null => {
  if (!Object.hasOwn(run.state.data, 'observations_first')) return null
  const stored = readValue(run.state, 'observations_first')
  if (stored.outcome !== 'ok') return stored
  return Array.isArray(stored.value)
    ? stored.value
    : failed(
        `the state file at ${run.state.path} has no usable value for 'observations_first': ` +
          `expected a list, found ${JSON.stringify(stored.value)}.`,
      )
}

/** The answer for an empty diff with no change to report: the line was already fixed. */
const noOp = (run: Run, drift: boolean): Stop | CommandResult => {
  const { driver } = run.loaded
  const line = driver.majorLine
  const validate = run.validate as JsonObject
  const field = promisedField(
    'validate',
    validate,
    `validate --line ${line} ${driver.package}`,
    'resolved_versions',
  )
  if ('outcome' in field) return field
  if (!Array.isArray(field.value) || field.value.length === 0) {
    return failPhase(
      'validate',
      `the fix install changed nothing and validate names no resolved version of ` +
        `${driver.package}, so there is no evidence that the ${line}.x line is already fixed. ` +
        'A no_op reported on an empty resolved_versions is an assertion, not a finding.',
    )
  }
  const resolved = field.value
    .map((version) => (version === null ? '' : tostring(version)))
    .join(', ')
  const saved = save(run, 'action', 'no-op')
  if (saved !== null) return saved
  const driftNote = drift
    ? '. A drift commit exists but left this line where the committed lockfile had it, so it ' +
      'clears none of the alerts in this group'
    : ''
  return ok({
    status: 'no_op',
    package: driver.package,
    major_line: line,
    resolved_version: resolved,
    drift_commit: drift,
    no_op: {
      reason:
        `the ${line}.x line is already fixed on the default branch: the fix install changed ` +
        `nothing and validate clears every alert in this group against the resolved ${resolved}` +
        driftNote,
      evidence: {
        diff: '',
        resolved_version: resolved,
        validate: {
          ok: validate.ok as JsonValue,
          violations: fieldOf(validate, 'violations') as JsonValue,
          unresolved_alerts: fieldOf(validate, 'unresolved_alerts') as JsonValue,
          other_line_moves: fieldOf(validate, 'other_line_moves') as JsonValue,
          checked: fieldOf(validate, 'checked') as JsonValue,
        },
        merged_pr_url: null,
      },
    },
  })
}

/**
 * The fix install changed nothing. The drift commit decides: a no-op, or a
 * lockfile refresh whose content is the drift commit. The answer is the
 * end of the phase, or null for a lockfile refresh.
 */
const unchanged = (run: Run, drift: boolean): Stop | CommandResult | null => {
  const line = run.loaded.driver.majorLine
  const pre = readValue(run.state, 'pre_drift')
  if (pre.outcome !== 'ok') return pre
  const preLine = lineVersions(pre.value, line)
  if (preLine === null) {
    return failPhase(
      'validate',
      'the pre-drift lockfile snapshot could not be read, so whether the control install ' +
        `cleared the ${line}.x line cannot be decided. It is never assumed unchanged: that ` +
        "reports a real lockfile-refresh fix as 'already fixed' and leaves the alerts open (#146).",
    )
  }
  const baseLine = lineVersions(run.baseline, line)
  if (baseLine === null) {
    return failPhase(
      'validate',
      'the post-control-install baseline snapshot could not be read, so whether the control ' +
        `install cleared the ${line}.x line cannot be decided (#146).`,
    )
  }
  const verdict = emptyDiff(drift, preLine, baseLine)
  if (verdict === 'disagree') {
    return failPhase(
      'validate',
      'the fix install changed nothing, and telling a true no-op from a lockfile-refresh needs ' +
        `the ${line}.x versions on both sides of the control install. One side carries none ` +
        'while validate reports the line present, so the snapshots disagree and ' +
        "'already fixed on the default branch' is not a conclusion this evidence supports " +
        `(#146). pre_drift=${JSON.stringify(preLine)} baseline=${JSON.stringify(baseLine)}`,
    )
  }
  return verdict === 'no_op' ? noOp(run, drift) : null
}

/** After validate passed: the labels of the fix, the state, and the answer. */
const finish = async (run: Run, observationsFirst: JsonValue[]): Promise<CommandResult> => {
  const { driver } = run.loaded
  const status = await run.loaded.git(driver.worktree, ['status', '--porcelain'])
  if (status.status !== 0) {
    return failPhase(
      'validate',
      `git status --porcelain failed in the worktree: ${outputOf(status)}`,
    )
  }
  const porcelain = outputOf(status)
  // The drift flag is read strictly. A value that is not true or false must
  // not take the no-op branch, which leaves the alerts open (#146).
  const driftValue = readValue(run.state, 'drift_commit')
  if (driftValue.outcome !== 'ok') return driftValue
  if (typeof driftValue.value !== 'boolean') {
    return failPhase(
      'validate',
      `the state file's drift_commit is '${tostring(driftValue.value)}', which is neither true ` +
        'nor false. It decides whether an empty fix diff is a true no-op or a lockfile-refresh, ' +
        "and anything unreadable there defaults toward no_op: that reports a real fix as 'already " +
        "fixed' and leaves the alerts open (#146).",
    )
  }
  const drift = driftValue.value
  const written = run.answer.written as JsonValue[]
  const shape = widestShape(written)
  if (shape === null) {
    return failPhase(
      'apply',
      `apply_constraint's written[] could not be classified: ${JSON.stringify(written)}`,
    )
  }
  let labels = labelsOf(shape, run.tightenBare, observationsFirst)
  if (porcelain === '') {
    const end = unchanged(run, drift)
    if (end !== null) return end
    labels = LOCKFILE_REFRESH
  }

  // The install signals are the union that the last install wrote. Each
  // key goes in the order of the bash.
  const validate = run.validate as JsonObject
  for (const [key, value] of [
    ['action', labels.action],
    ['override_scope', labels.override_scope],
    ['bare_override', labels.bare_override],
    ['apply_result', run.answer],
    ['validate', validate],
    ['applied_parents', run.applied],
    ['tighten_bare', run.tightenBare],
  ] as const) {
    const saved = save(run, key, value)
    if (saved !== null) return saved
  }
  const answer = run.answer
  return ok({
    status: 'ok',
    step: 'apply',
    action: labels.action,
    override_scope: labels.override_scope,
    bare_override: labels.bare_override,
    applied_parents: run.applied,
    parent_derivation: run.derivation as unknown as JsonValue,
    install_signals: run.signals,
    written: answer.written as JsonValue,
    superseded_keys: fieldOf(answer, 'superseded_keys') as JsonValue,
    alias_lookup: fieldOf(answer, 'alias_lookup') as JsonValue,
    lockfile_invalidated: fieldOf(answer, 'lockfile_invalidated') as JsonValue,
    override_file: fieldOf(answer, 'override_file') as JsonValue,
    observations: answer.observations as JsonValue,
    observations_pre_fix: observationsFirst,
    requires_major_bump: orElse(validate.requires_major_bump, []) as JsonValue,
    other_line_moves: fieldOf(validate, 'other_line_moves') as JsonValue,
    benign_moves: movesOf(validate.other_line_moves, 'benign_dedup') as JsonValue[],
  })
}

/** The apply phase, on a loaded state. */
export const apply = async (loaded: Loaded): Promise<CommandResult> => {
  const run = prepare(loaded)
  if ('outcome' in run) return run
  // The first write: the range of the fix.
  const ranged = save(run, 'range', run.range)
  if (ranged !== null) return ranged
  const parents = firstParents(run)
  if ('outcome' in parents) return parents
  run.applied = parents
  const stored = storedObservations(run)
  if (stored !== null && 'outcome' in stored) return stored

  const first = applyCall(run, false)
  if (first !== null) return first
  let observationsFirst = stored
  if (observationsFirst === null) {
    observationsFirst = run.answer.observations as JsonValue[]
    const saved = save(run, 'observations_first', observationsFirst)
    if (saved !== null) return saved
  }
  const stop = (await fixInstall(run)) ?? validateCall(run) ?? (await ladder(run))
  if (stop !== null) return stop
  return finish(run, observationsFirst)
}
