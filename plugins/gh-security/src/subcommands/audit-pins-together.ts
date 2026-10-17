// `audit-pins together`: phase 7, the port of `cmd_together`,
// `remove_candidates` and `run_attempt` in
// `scripts/common/audit-pins-driver.sh`. The contract is in the header of
// `audit-pins.ts`.
//
// Phases 4 and 5 tested one pin for each install, so no set of pins has been
// installed together yet, and a pull request removes a set. So the rule is
// absolute: a pull request never removes a set that was not installed and
// judged as a set. Attempt 1 is that test, with each removable pin. Attempt
// 2 is the one fallback, without the pins that had siblings. There is no
// third attempt.
//
// This file ships. It imports nothing outside the plugin.

import { equal, render, toText } from '../adapters/node/jq-json.ts'
import { isRecord } from '../adapters/node/manifest.ts'
import type { CommandResult } from '../cli/command.ts'
import { fieldOf } from '../jq.ts'
import { parseArguments } from '../lib/args.ts'
import type { JsonObject, JsonValue } from '../lib/envelope.ts'
import { readOptionalValue } from '../state.ts'
import { movesBetween } from './audit-pins-collateral.ts'
import {
  type AuditPinsDeps,
  die,
  FINDINGS_SHAPE,
  failPhase,
  isFindings,
  isList,
  jqJoin,
  jqLength,
  jqValues,
  linesOf,
  loadSession,
  mapUnreadable,
  onTree,
  optionalText,
  orEmpty,
  promised,
  requiredText,
  requiredValue,
  resolutionsOf,
  restoreTree,
  type Session,
  settle,
  stateValue,
  stop,
} from './audit-pins-common.ts'
import { advisoryFor } from './audit-pins-judge.ts'
import { removeManifestPaths, removeWorkspaceKey } from './audit-pins-removal.ts'
import { installOnce, outputOf } from './fix-group-common.ts'

/** A pin of a candidate set, as `{key, path, package, value, status}` picks it. */
type Candidate = JsonObject & { readonly path: JsonValue }

/** What one attempt found. */
interface Attempt {
  readonly result: 'clean' | 'dirty' | 'partial'
  readonly detail: string
  readonly collateral: JsonValue[]
  readonly verdicts: JsonObject[]
}

const isKeyList = (path: JsonValue): path is string[] =>
  Array.isArray(path) && path.every((key) => typeof key === 'string')

/**
 * Remove each candidate from the override file, or restore the tree and end
 * the run: `remove_candidates`. The workspace file loses one key at a time,
 * by the deleter that `test-pin` uses, with #327 open (round 7 ruling 5).
 */
const removeCandidates = async (session: Session, candidates: readonly Candidate[]) => {
  if (session.overrideFile === 'pnpm-workspace.yaml') {
    for (const key of linesOf(candidates.map((candidate) => candidate.key ?? null))) {
      if (removeWorkspaceKey(session.worktree, key) === 0) continue
      await restoreTree(session, 'the combined set')
      failPhase(
        'compose',
        `the pnpm-workspace.yaml overrides block could not be edited to remove '${key}', so the combined set was never installed.`,
      )
    }
    return
  }
  const paths = candidates.map((candidate) => candidate.path)
  const root = stateValue(
    session,
    'compose',
    'override_root',
    isList,
    'type == "array"',
    "the override block's address",
  )
  const error = paths.every(isKeyList)
    ? removeManifestPaths(session.worktree, root, paths)
    : 'a candidate path is not a list of keys'
  if (error === null) return
  await restoreTree(session, 'the combined set')
  failPhase(
    'compose',
    `package.json could not be rewritten to remove the candidate set ${render(paths, null)}. Quoting the error: ${error}`,
  )
}

/** The keys that `list_pins` still gives at a candidate path, as jq selects them. */
const stillListed = (answer: unknown, candidates: readonly Candidate[]): JsonValue[] =>
  jqValues((answer as Record<string, unknown>).pins).flatMap((pin) => {
    const path = fieldOf(pin, 'path')
    return candidates.some((candidate) => equal(candidate.path, path))
      ? [fieldOf(pin, 'key') as JsonValue]
      : []
  })

/** Remove the set, check the edit, install, and judge what moved: `run_attempt`. */
const runAttempt = async (
  session: Session,
  deps: AuditPinsDeps,
  attempt: number,
  candidates: readonly Candidate[],
): Promise<Attempt> => {
  const label = `attempt ${attempt}`
  await removeCandidates(session, candidates)

  // Check that the edits landed before the install. One removal that
  // matched nothing installs a manifest that still holds the pin.
  const after = onTree(session, (tree) => session.adapter.listPins(tree))
  if (after.outcome !== 'ok') {
    await restoreTree(session, label)
    failPhase('compose', `list_pins failed after composing ${label}: ${after.error}`)
  }
  const afterCount = promised('compose', after.value, `list_pins (${label})`, 'count')
  const count = requiredValue(session, 'pins_count')
  if (typeof count !== 'number') {
    die(
      `the state file at ${session.state.path} has no usable value for 'pins_count': ` +
        `expected a number, found ${JSON.stringify(count)}.`,
    )
  }
  let still: JsonValue[] = []
  try {
    still = stillListed(after.value, candidates)
  } catch {
    failPhase(
      'compose',
      `${label} could not be checked against list_pins' reply, so whether the removals landed is unknown and no verdict is reported as if it were.`,
    )
  }
  if (still.length > 0) {
    await restoreTree(session, label)
    failPhase(
      'compose',
      `${label} still carries the candidate key(s) ${render(still, null)} after the removal, so the install would have been an install of a manifest still holding them.`,
    )
  }
  const left = count - candidates.length
  if (afterCount !== left) {
    await restoreTree(session, label)
    failPhase(
      'compose',
      `${label} left ${toText(afterCount)} pins where phase 2 counted ${count} and ${candidates.length} entries were removed, which should leave ${left}.`,
    )
  }

  // A failed install is a fact about the environment, not about the pins,
  // so it ends the run and attempt 2 does not run.
  const install = await installOnce(session)
  if (!install.ok) {
    await restoreTree(session, label)
    failPhase(
      'compose',
      `${label}'s combined install failed, so the map was not read and attempt 2 was not tried: ${install.output}`,
    )
  }

  // A partial view of the tree fails the attempt closed, never into a PR.
  const map = onTree(session, (tree) => session.adapter.resolutionMap(tree))
  const none = { collateral: [], verdicts: [] }
  if (map.outcome !== 'ok') {
    return {
      ...none,
      result: 'partial',
      detail: `${label} could not read a whole-tree resolution_map: ${map.error}`,
    }
  }
  const unreadable = mapUnreadable('compose', map.value, `${label}'s resolution_map`)
  if (unreadable !== 0) {
    return {
      ...none,
      result: 'partial',
      detail: `${label}'s resolution_map could not read ${unreadable} lockfile entries, so it is not a whole-tree view`,
    }
  }

  // Each package is compared with the baseline, not only the named ones: a
  // set of overrides reaches further than any one of them.
  const baseMap = stateValue(
    session,
    'compose',
    'baseline_map',
    (value): value is JsonObject | null => value === null || isRecord(value),
    'type == "object" or type == "null"',
    'the with-all-pins baseline resolution_map',
  )
  const base = resolutionsOf(baseMap)
  const now = resolutionsOf(map.value)
  if (base === null || now === null) {
    failPhase(
      'compose',
      `${label}'s map could not be diffed against the with-all-pins baseline, so nothing is known about what the set moved.`,
    )
  }
  const collateral = movesBetween(base, now) as unknown as JsonObject[]
  const verdicts: JsonObject[] = []
  for (const move of collateral) {
    const name = move.package as string
    for (const version of linesOf(move.newly_admitted as string[])) {
      const answer = await advisoryFor(session, deps, name, version)
      verdicts.push({
        package: name,
        version,
        verdict: answer.verdict,
        matched_ranges: answer.matched_ranges as JsonValue,
      })
    }
  }

  // Clean only when each version that the set let in is safe. `unknown` and
  // `no-advisories` are not safe: here the answer becomes a change to a real
  // repository.
  const dirty = verdicts.filter((each) => each.verdict !== 'safe')
  if (dirty.length === 0) return { result: 'clean', detail: '', collateral, verdicts }
  const detail = orEmpty(() =>
    dirty
      .map(
        (each) =>
          `${label} admitted ${each.package} ${each.version} (${each.verdict}` +
          (jqLength(each.matched_ranges) > 0 ? ` via ${jqJoin(each.matched_ranges, '; ')}` : '') +
          ')',
      )
      .join('; '),
  )
  return { result: 'dirty', detail, collateral, verdicts }
}

const pick = (finding: JsonObject): Candidate => ({
  key: finding.key ?? null,
  path: finding.path ?? null,
  package: finding.package ?? null,
  value: finding.value ?? null,
  status: finding.status ?? null,
})

const reasonOf = (attempt: Attempt): string =>
  attempt.result === 'partial' ? 'partial resolution map' : 'combined test failed'

/** The together phase. */
export const together = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: AuditPinsDeps,
): Promise<CommandResult> =>
  settle(async (): Promise<JsonValue> => {
    const parsed = parseArguments(args, { work: { type: 'string', default: '' } })
    if (parsed.outcome !== 'ok') stop(parsed)
    if (parsed.value.work === '') die('together: --work is required')
    const session = loadSession(parsed.value.work, env, deps)
    // Before `judge`, each finding is still `tested`, so the set is empty,
    // and this step would report an audit that never judged anything.
    if (readOptionalValue(session.state, 'judge_done') !== true) {
      die(
        "together: run 'judge' first. Before it runs every finding is still 'tested', so the candidate set is empty and this step would report 'no removable pins found' for an advisory judgment that never happened.",
      )
    }
    const findings = stateValue(
      session,
      'compose',
      'findings',
      isFindings,
      FINDINGS_SHAPE,
      "phase 5's findings",
    )
    const first = findings
      .filter((each) => each.status === 'removable' || each.status === 'removable-individually')
      .map(pick)
    const second = findings.filter((each) => each.status === 'removable').map(pick)
    if (first.length === 0) {
      return {
        status: 'no_candidates',
        step: 'together',
        pr_skipped_reason: 'no removable pins found',
        pr_skipped_detail:
          'the audit ran and every pin it tested was kept, so there is nothing to open a PR about',
      }
    }

    // Each diff is measured against the baseline map, so a partial baseline
    // makes both attempts unmeasurable.
    if (
      readOptionalValue(session.state, 'map_available') !== true ||
      readOptionalValue(session.state, 'baseline_unreadable_entries') !== 0
    ) {
      const unreadable = optionalText(session, 'baseline_unreadable_entries') || 'unavailable'
      return {
        status: 'partial_map',
        step: 'together',
        pr_skipped_reason: 'partial resolution map',
        pr_skipped_detail: `the with-all-pins baseline resolution_map was unavailable or partial (unreadable_entries: ${unreadable}), so no combined attempt can be measured against it and none was run`,
      }
    }

    // A tracked `.yarn/cache` goes back to HEAD too: the residue of each pin
    // would otherwise reach the commit of phase 8. git is asked whether the
    // cache is tracked, because a checkout of a path that git does not track
    // is an error.
    const tracked = await session.git(session.worktree, ['ls-files', '--', '.yarn/cache'])
    if (tracked.status !== 0) {
      failPhase(
        'restore',
        `git ls-files -- .yarn/cache failed in the worktree: ${outputOf(tracked)}`,
      )
    }
    if (outputOf(tracked) !== '') {
      const checkout = await session.git(session.worktree, [
        'checkout',
        'HEAD',
        '--',
        '.yarn/cache',
      ])
      if (checkout.status !== 0) {
        failPhase(
          'restore',
          `git checkout HEAD -- .yarn/cache failed, so per-pin cache residue would have reached the removal commit: ${outputOf(checkout)}`,
        )
      }
    }

    // Phase 8 stages the commit by this name, so an empty one is refused.
    const lockfile = requiredText(session.state, 'lockfile')
    const ready = (
      attempt: number,
      removed: readonly Candidate[],
      run: Attempt,
      left: JsonValue[],
    ) => ({
      status: 'ready_for_pr',
      step: 'together',
      attempt,
      removed_keys: removed.map((each) => each.key ?? null),
      removed: [...removed],
      left_behind: left,
      collateral: run.collateral,
      advisory_verdicts: run.verdicts,
      lockfile,
      override_file: session.overrideFile,
    })

    const one = await runAttempt(session, deps, 1, first)
    // The removals stay in the tree: that diff is what phase 8 commits.
    if (one.result === 'clean') return ready(1, first, one, [])
    await restoreTree(session, 'attempt 1')

    // An empty set, or the same set, leaves attempt 2 nothing to try.
    if (second.length === 0 || equal(second, first)) {
      const why =
        second.length === 0
          ? 'attempt 2 set was empty because every removable finding carried sibling ambiguity'
          : "attempt 2 was not run: no finding was removable-individually, so its set is attempt 1's set and narrowing had nothing to drop"
      return {
        status: 'combined_failed',
        step: 'together',
        attempt: 1,
        pr_skipped_reason: reasonOf(one),
        pr_skipped_detail: `${one.detail}; ${why}`,
      }
    }

    const two = await runAttempt(session, deps, 2, second)
    if (two.result === 'clean') {
      const left = first
        .filter((each) => each.status === 'removable-individually')
        .map((each) => ({
          key: each.key ?? null,
          reason: `${one.detail}; excluded from attempt 2`,
        }))
      return ready(2, second, two, left)
    }
    await restoreTree(session, 'attempt 2')
    // The reason is the one that the last attempt ended with.
    return {
      status: 'combined_failed',
      step: 'together',
      attempt: 2,
      pr_skipped_reason: reasonOf(two),
      pr_skipped_detail: `${one.detail}; ${two.detail}`,
    }
  })
