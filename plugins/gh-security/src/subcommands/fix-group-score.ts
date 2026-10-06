// `fix-group score`: phase 5, the port of `cmd_score` in
// `scripts/common/fix-group.sh`. It reads the lockfile after the fix, hands
// the facts to the risk scorer, and answers `ready_for_pr` with the whole
// report for the pull request. The contract is in the header of
// `fix-group.ts`.
//
// The adapter verbs run in process, and so does the scorer
// (`src/merge-risk/score.ts`, #233, ruling 9). It scores the worktree, and
// asks the adapter of the state for each comparison. The bash ran
// `score-merge-risk.sh` as a child.
//
// The order of the steps and of the state writes is the order of the bash:
// `post_fix`, the why file, `declared_post`, the scorer, and `risk`. Then
// the state keys of `apply` are read. So a state that `apply` did not finish
// still runs the scorer, as in the bash.
//
// This file ships. It imports nothing outside the plugin.

import { renameSync, writeFileSync } from 'node:fs'

import type { CommandResult } from '../cli/command.ts'
import { fieldOf, orElse, tostring } from '../jq.ts'
import { type Failure, failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import { type RiskFactor, scoreMergeRisk } from '../merge-risk/score.ts'
import {
  readOptionalStrings,
  readOptionalValue,
  readString,
  readValue,
  type StateFile,
  writeKey,
} from '../state.ts'
import { failPhase, type Loaded, promisedField } from './fix-group-common.ts'
import { lineVersions, movesOf } from './fix-group-ladder.ts'

/** The text of the state failure for a key that is absent or null. */
const unusable = (state: StateFile, key: string): Failure =>
  failed(
    `the state file at ${state.path} has no usable value for '${key}'. ` +
      'Run the earlier steps first; an absent or empty value is never read as a ' +
      'legitimate answer here.',
  )

/** A JSON object, or null for any other value. */
const recordOf = (value: unknown): JsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null

/** The state of the run, and the one writer of its keys. */
interface Keeper {
  state: StateFile
}

/** Write one key, as `state_set` does. */
const save = (keeper: Keeper, key: string, value: JsonValue): Failure | null => {
  const written = writeKey(keeper.state, key, value)
  if (written.outcome !== 'ok') return failed(written.error)
  keeper.state = written.value
  return null
}

/**
 * The lowest version on the line, by the comparison of the adapter. The port
 * of `lowest_on_line`. `none` is a payload with no version on the line, and
 * `unreadable` is a payload or a comparison that cannot be read.
 */
type Lowest = { readonly version: string } | 'none' | 'unreadable'

const lowestOnLine = (loaded: Loaded, payload: unknown, line: string): Lowest => {
  const versions = lineVersions(payload, line)
  if (versions === null) return 'unreadable'
  // The bash read one version for each line of text.
  const names = versions.flatMap((version) => version.split('\n')).filter((name) => name !== '')
  let lowest = names[0]
  if (lowest === undefined) return 'none'
  for (const name of names.slice(1)) {
    const compared = loaded.adapter.compareVersions(name, lowest)
    if (compared.outcome !== 'ok' || !Object.hasOwn(compared.value, 'result')) return 'unreadable'
    const result = tostring(compared.value.result)
    if (result === '-1') lowest = name
    else if (result !== '0' && result !== '1') return 'unreadable'
  }
  return { version: lowest }
}

/**
 * One declared range for each range, and one for each line of a range.
 * The adapter makes the list distinct. Null when `ranges` is neither null
 * nor a list of text.
 */
const rangesOf = (declared: JsonObject): string[] | null => {
  const ranges = fieldOf(declared, 'ranges')
  if (ranges === null) return []
  if (!Array.isArray(ranges) || !ranges.every((range) => typeof range === 'string')) return null
  return (ranges as string[]).flatMap((range) => range.split('\n')).filter((range) => range !== '')
}

/** The number of `parents_read`, with an absent, null or false value as none. Null for another value. */
const parentsRead = (declared: JsonObject): number | null => {
  const parents = orElse(fieldOf(declared, 'parents_read'), [])
  return Array.isArray(parents) ? parents.length : null
}

/** The score phase, on a loaded state. `work` is the text of `--work`. */
export const score = async (loaded: Loaded, work: string): Promise<CommandResult> => {
  const { driver, adapter } = loaded
  const pkg = driver.package
  const line = driver.majorLine
  const keeper: Keeper = { state: driver.state }

  const action = readOptionalValue(keeper.state, 'action')
  if (action === null || action === '') return failed("score: run 'apply' first")
  if (typeof action !== 'string') {
    return failed(
      `the state file at ${keeper.state.path} has no usable value for 'action': ` +
        `expected text, found ${JSON.stringify(action)}.`,
    )
  }
  // A no-op is terminal at `apply`. There is no change to score and no PR
  // to open. A rating here would be for a diff that does not exist (#34).
  if (action === 'no-op') {
    return failed('score: apply returned no_op, which is terminal. There is no change to score.')
  }

  const postTree = loaded.tree()
  const post = postTree.outcome === 'ok' ? adapter.resolvedVersions(postTree.value, pkg) : postTree
  if (post.outcome !== 'ok') {
    return failPhase('validate', `resolved_versions ${pkg} failed after the fix: ${post.error}`)
  }
  const postPresent = promisedField(
    'validate',
    post.value,
    `resolved_versions ${pkg} (after the fix)`,
    'present',
  )
  if ('outcome' in postPresent) return postPresent
  const postSaved = save(keeper, 'post_fix', post.value as unknown as JsonObject)
  if (postSaved !== null) return postSaved

  // The why capture has its own package-qualified name under the work
  // directory. A predictable name in a shared directory lets a sibling agent
  // overwrite it mid-run (#133). A scoped name used as it is would name a
  // directory that the work directory does not have (a sibling of #161).
  const packagePath = readString(keeper.state, 'package_path')
  if (packagePath.outcome !== 'ok') return packagePath
  const whyFile = `${work}/why-${packagePath.value}.json`
  const whyTree = loaded.tree()
  const why =
    whyTree.outcome === 'ok'
      ? await adapter.why(whyTree.value, pkg, { run: loaded.pm, env: loaded.env })
      : whyTree
  if (why.outcome !== 'ok') {
    return failPhase('validate', `why ${pkg} failed after the fix: ${why.error}`)
  }
  const whyRaw = promisedField('validate', why.value, `why ${pkg} (after the fix)`, 'raw')
  if ('outcome' in whyRaw) return whyRaw
  // Written through a temporary file in the same directory, and then renamed.
  try {
    writeFileSync(`${whyFile}.tmp`, `${JSON.stringify(why.value)}\n`)
    renameSync(`${whyFile}.tmp`, whyFile)
  } catch {
    return failPhase(
      'validate',
      `the why capture could not be written to ${whyFile}, so the risk scorer has no --why-json to read.`,
    )
  }

  // Always give the line. Without it, the verb collects every declaration of
  // the name in the lockfile. Parents on lines that the override never
  // touched then score as distance that this fix crossed (#76).
  const declaredTree = loaded.tree()
  const declaredAnswer =
    declaredTree.outcome === 'ok'
      ? adapter.declaredRanges(declaredTree.value, pkg, Number(line))
      : declaredTree
  if (declaredAnswer.outcome !== 'ok') {
    return failPhase(
      'validate',
      `declared_ranges --line ${line} ${pkg} failed after the fix: ${declaredAnswer.error}`,
    )
  }
  const declaredPresent = promisedField(
    'validate',
    declaredAnswer.value,
    `declared_ranges --line ${line} ${pkg} (after the fix)`,
    'ranges',
  )
  if ('outcome' in declaredPresent) return declaredPresent
  const declared = declaredAnswer.value as unknown as JsonObject
  const declaredSaved = save(keeper, 'declared_post', declared)
  if (declaredSaved !== null) return declaredSaved

  // The `--before` comes from the baseline after the control install, so the
  // delta is the fix's own. On a lockfile refresh, the refresh is the
  // change, and the snapshot from before the drift is the honest before.
  const beforeSource = readValue(
    keeper.state,
    action === 'lockfile-refresh' ? 'pre_drift' : 'baseline',
  )
  if (beforeSource.outcome !== 'ok') return beforeSource
  const beforePresent = promisedField(
    'validate',
    beforeSource.value,
    'the pre-fix resolved_versions snapshot',
    'present',
  )
  if ('outcome' in beforePresent) return beforePresent
  let before = ''
  if (tostring(beforePresent.value) === 'true') {
    const lowest = lowestOnLine(loaded, beforeSource.value, line)
    if (lowest === 'unreadable') {
      return failPhase(
        'validate',
        `the pre-fix lockfile snapshot could not be compared for the ${line}.x line, so F1's ` +
          '--before cannot be stated. A version taken from another line would be scored as ' +
          "this fix's delta (#76).",
      )
    }
    // Present, but nothing of it on this line. `--before` is then omitted,
    // and the scorer scores F1 as a major, which is the safe direction. A
    // version from another major line is never put in its place (#76).
    before = lowest === 'none' ? '' : lowest.version
  }
  const lowestAfter = lowestOnLine(loaded, post.value, line)
  if (typeof lowestAfter === 'string') {
    return failPhase(
      'validate',
      `the post-fix lockfile carries no comparable ${line}.x version of ${pkg}, so this fix has ` +
        'no resolved version to report. Passed on as an empty --after, this surfaces as the ' +
        'risk scorer failing, which names the scorer for an unreadable lockfile (#76).',
    )
  }
  const after = lowestAfter.version

  const scope = readString(keeper.state, 'override_scope')
  if (scope.outcome !== 'ok') return scope
  const bare = readString(keeper.state, 'bare_override')
  if (bare.outcome !== 'ok') return bare

  const ranges = rangesOf(declared)
  if (ranges === null) {
    return failPhase(
      'validate',
      "declared_ranges answered a 'ranges' that is neither null nor a list of text, so no " +
        `--declared-range can be read from it. ranges: ${JSON.stringify(fieldOf(declared, 'ranges'))}`,
    )
  }
  // An empty list is the `none` sentinel. Without it the scorer cannot tell
  // "no range could be read" from "no range is out of date".
  const scored = scoreMergeRisk(
    {
      package: pkg,
      before,
      after,
      why: why.value,
      whyLabel: whyFile,
      overrideScope: scope.value,
      declaredRanges: ranges.length === 0 ? 'none' : ranges,
    },
    {
      name: driver.adapter,
      compareVersions: adapter.compareVersions,
      rangeFacts: adapter.rangeFacts,
    },
    driver.worktree,
  )
  // A failed scorer is a phase failure, as every other failure of this
  // phase. The detail is the text of the bash: the script name, and the
  // JSON error that the script wrote.
  if (scored.outcome !== 'ok') {
    return failPhase(
      'validate',
      `score-merge-risk.sh failed: ${JSON.stringify({ error: scored.error })}`,
    )
  }
  const risk = scored.value
  const riskSaved = save(keeper, 'risk', risk)
  if (riskSaved !== null) return riskSaved

  // The sentinel has two causes, and they are different facts: nothing could
  // be read, or parents were read and declared nothing.
  let rangesCause: JsonValue = null
  if (ranges.length === 0) {
    const read = parentsRead(declared)
    if (read === null) {
      return failPhase(
        'validate',
        "declared_ranges answered a 'parents_read' that is not a list, so the reason for the " +
          `empty ranges cannot be told. parents_read: ${JSON.stringify(fieldOf(declared, 'parents_read'))}`,
      )
    }
    rangesCause = read === 0 ? 'none_readable' : 'parents_declared_nothing'
  }

  // Each stored value is read before the report is built. An absent
  // required value is never a default. A report that names no edit is not
  // ready for a PR.
  const applyResult = readValue(keeper.state, 'apply_result')
  if (applyResult.outcome !== 'ok') return applyResult
  const validateResult = readValue(keeper.state, 'validate')
  if (validateResult.outcome !== 'ok') return validateResult
  const applied = readOptionalValue(keeper.state, 'applied_parents')
  const parents =
    applied !== null && applied !== false
      ? applied
      : readOptionalValue(keeper.state, 'eligible_parents')
  if (parents === null) return unusable(keeper.state, 'applied_parents // eligible_parents')
  const drift = readValue(keeper.state, 'drift_commit')
  if (drift.outcome !== 'ok') return drift
  const observationsFirst = readValue(keeper.state, 'observations_first')
  if (observationsFirst.outcome !== 'ok') return observationsFirst
  const signals = readOptionalStrings(keeper.state, 'install_signals')
  if (signals.outcome !== 'ok') return signals

  const apply = recordOf(applyResult.value)
  const validate = recordOf(validateResult.value)
  if (apply === null || validate === null) {
    return failPhase(
      'validate',
      'the stored apply_result and validate report are not JSON objects, so the report of this ' +
        `step cannot be assembled. apply_result: ${JSON.stringify(applyResult.value)}. ` +
        `validate: ${JSON.stringify(validateResult.value)}`,
    )
  }
  return ok({
    status: 'ready_for_pr',
    package: pkg,
    major_line: line,
    branch: driver.branchName,
    work,
    worktree: driver.worktree,
    why_json: whyFile,
    action,
    override_scope: scope.value,
    bare_override: bare.value,
    drift_commit: drift.value,
    resolved_version: after,
    before: before === '' ? null : before,
    risk: {
      band: risk.band,
      score: risk.score,
      f4: (risk.factors[3] as RiskFactor).score,
      f5: (risk.factors[4] as RiskFactor).score,
      markdown: risk.markdown,
      coverage: risk.coverage,
      ci: risk.ci,
    },
    written: orElse(fieldOf(apply, 'written'), []) as JsonValue,
    superseded_keys: orElse(fieldOf(apply, 'superseded_keys'), []) as JsonValue,
    override_file: fieldOf(apply, 'override_file') as JsonValue,
    alias_lookup: fieldOf(apply, 'alias_lookup') as JsonValue,
    lockfile_invalidated: fieldOf(apply, 'lockfile_invalidated') as JsonValue,
    observations: orElse(fieldOf(apply, 'observations'), []) as JsonValue,
    observations_pre_fix: observationsFirst.value,
    install_signals: signals.value,
    applied_parents: parents,
    requires_major_bump: orElse(fieldOf(validate, 'requires_major_bump'), []) as JsonValue,
    other_line_moves: fieldOf(validate, 'other_line_moves') as JsonValue,
    benign_moves: movesOf(fieldOf(validate, 'other_line_moves') as JsonValue, 'benign_dedup'),
    validate,
    why_raw: whyRaw.value as JsonValue,
    declared_ranges: orElse(fieldOf(declared, 'ranges'), []) as JsonValue,
    declared_ranges_cause: rangesCause,
    parents_unreadable: orElse(fieldOf(declared, 'parents_unreadable'), []) as JsonValue,
    parents_malformed: orElse(fieldOf(declared, 'parents_malformed'), []) as JsonValue,
  })
}
