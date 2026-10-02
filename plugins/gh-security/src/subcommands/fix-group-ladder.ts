// The decisions of `fix-group apply`, as pure functions: the range, the
// remediation ladder and its stop conditions, the parents that a violation
// path names, the widest shape that was written, and the empty diff. Each
// function reads JSON values and gives a verdict. None of them reads a file
// or starts a child, so a test calls each one with no git repository (#232).
// `fix-group-apply.ts` holds the order of the steps. The contract is in the
// header of `fix-group.ts`.
//
// Each function is the port of a jq filter or a shell test in
// `cmd_apply`, `apply_call`, `validate_call`, `fix_install_step`,
// `uncovered_parents` and `line_versions` of `scripts/common/fix-group.sh`.
//
// This file ships. It imports nothing outside the plugin.

import { orElse, uniqueJq } from '../jq.ts'
import type { JsonValue } from '../lib/envelope.ts'

/**
 * The fix installs of one run, across each `apply` of the run. One `apply`
 * spends at most three: the first install, step 1 and step 2. The count is
 * in the state, so a re-run of `apply` continues it. So the fourth install
 * is the last, and `install_budget_exhausted` can occur.
 */
export const FIX_INSTALL_BUDGET = 4

/** A JSON object, or null for any other value. */
const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * The range of the fix: `>=<fixed> <next major>`. It always has an upper
 * bound, so it never installs a later major. `3.1.2` gives `>=3.1.2 <4`, and
 * `0.5.3` gives `>=0.5.3 <1`. The major is the digits at the start, after
 * any `v`, `V` or `=`, up to the next other character. Null when there are
 * none.
 */
export const rangeOf = (fixed: string): string | null => {
  const major = (/^[vV=]*([0-9]*)/.exec(fixed) as RegExpExecArray)[1] as string
  return major === '' ? null : `>=${fixed} <${Number(major) + 1}`
}

/**
 * The alerts of the group that have no `vulnerable_range`, as the number of
 * each, or `<unnumbered>`. A range must be text that is not empty. An alert
 * that is not an object has no range.
 */
export const uncheckedAlerts = (alerts: readonly unknown[]): unknown[] =>
  alerts.flatMap((alert) => {
    const record = recordOf(alert)
    const range = record?.vulnerable_range
    if (typeof range === 'string' && range !== '') return []
    return [orElse(record?.number, '<unnumbered>')]
  })

/**
 * The first written entry that sets an `npm:` value for another package
 * (#49). An entry with `preserved: true` quotes a value that was there
 * before, so it is not checked (#147). Null when there is no such entry.
 */
export const retargetOf = (written: readonly unknown[], pkg: string): unknown => {
  for (const entry of written) {
    const record = recordOf(entry)
    if (record === null || record.preserved === true) continue
    const value = record.value
    if (typeof value !== 'string' || !value.startsWith('npm:')) continue
    const rest = value.slice('npm:'.length)
    const at = rest.lastIndexOf('@')
    const named = at <= 0 ? rest : rest.slice(0, at)
    if (named !== pkg) return entry
  }
  return null
}

/** A name without the version that a per-copy entry has (#85). */
export const bareName = (key: string): string => {
  const at = key.lastIndexOf('@')
  return at <= 0 ? key : key.slice(0, at)
}

/**
 * The parent that an npm install path names: the segment before the last
 * `node_modules`, or the two segments for a scoped parent. Null for a path
 * that names no parent.
 */
export const parentOf = (path: string): string | null => {
  const segments = path.split('/')
  const last = segments.lastIndexOf('node_modules')
  if (last <= 0) return null
  if (last >= 2 && (segments[last - 2] as string).startsWith('@')) {
    return `${segments[last - 2]}/${segments[last - 1]}`
  }
  return segments[last - 1] as string
}

/** What step 1 of the ladder could read from the violation paths. */
export interface ParentDerivation {
  /** The parents to add: unique, sorted, and not yet applied. */
  readonly parents: string[]
  readonly paths_naming_a_parent: number
  readonly paths_naming_only_the_copy: number
  readonly opaque_paths: string[]
  /** False when no path names a parent, as on pnpm and Yarn Berry. */
  readonly possible: boolean
  readonly reason: string | null
}

const NO_PARENT_IN_PATH =
  "no violating copy's path names its enclosing parent: pnpm reports <name>@<version> and " +
  'Yarn Berry the resolution locator <name>@npm:<version>, both of which name the copy ' +
  'itself. No parent can be derived from this report, and none was invented.'

const INSTALL_PATH = /(^|\/)node_modules\//

/**
 * Step 1 of the ladder: the parents of the copies that violate. Only an npm
 * path names a parent. pnpm and Yarn Berry name the copy, so there the step
 * cannot run, and the answer says so. A parent on another major line never
 * gets an entry (#83), and a parent that has one already is not added again.
 */
export const parentDerivation = (
  paths: readonly string[],
  otherLines: readonly string[],
  applied: readonly string[],
  pkg: string,
): ParentDerivation => {
  const shaped = paths.filter((path) => INSTALL_PATH.test(path))
  const opaque = paths.filter((path) => !INSTALL_PATH.test(path))
  const others = otherLines.map(bareName)
  const named = uniqueJq(
    shaped
      .map(parentOf)
      .filter((parent): parent is string => parent !== null)
      .map(bareName)
      .filter((parent) => parent !== pkg && parent !== 'node_modules'),
  )
  return {
    parents: named.filter((parent) => !others.includes(parent) && !applied.includes(parent)),
    paths_naming_a_parent: shaped.length,
    paths_naming_only_the_copy: opaque.length,
    opaque_paths: uniqueJq(opaque),
    possible: shaped.length > 0,
    reason: shaped.length > 0 ? null : NO_PARENT_IN_PATH,
  }
}

/**
 * The `lockfile_invalidated` of an `apply_constraint` answer, as the
 * evidence has it: the value, or `{}` for null, false or absent.
 */
export const invalidationOf = (answer: Record<string, unknown>): unknown =>
  orElse(answer.lockfile_invalidated, {})

/**
 * Step 3 of the ladder: the stale-lockfile stop. It stops when the
 * invalidation pass did not run and gives a reason, or ran and removed no
 * entry. Then only a new lockfile can help, and that needs a person.
 */
export const staleLockfile = (invalidated: unknown): boolean => {
  const record = recordOf(invalidated)
  if (record === null) return false
  if (record.performed === false && Object.hasOwn(record, 'reason')) return true
  if (record.performed !== true) return false
  const keys = orElse(record.keys, [])
  return Array.isArray(keys) && keys.length === 0
}

/** Where the ladder is. 0: no step yet. 1: step 1 ran. 2: step 2 ran. */
export type LadderStep = 0 | 1 | 2

/** What the ladder does next, after a validate that failed. */
export type Rung =
  /** Step 1: scope the constraint to these parents too, then install again. */
  | { readonly kind: 'add_parents'; readonly parents: readonly string[] }
  /** Step 2: the bare override, `--tighten-bare`, then install again. */
  | { readonly kind: 'tighten_bare' }
  /** Step 3: the stale-lockfile stop, a failure of the phase. */
  | { readonly kind: 'stale_lockfile' }
  /** Nothing is left that the ladder can do: a judgment for the agent. */
  | { readonly kind: 'judgment' }

/**
 * The next rung. `uncovered` is the parents that step 1 found, and is read
 * only at step 0. The ladder never goes back: a step that ran is not run
 * again in the same `apply`. Step 4, a line with no copy, comes before this
 * function, at each failed validate.
 */
export const nextRung = (
  step: LadderStep,
  uncovered: readonly string[],
  invalidated: unknown,
): Rung => {
  if (step === 0 && uncovered.length > 0) return { kind: 'add_parents', parents: uncovered }
  if (step <= 1) return { kind: 'tighten_bare' }
  return staleLockfile(invalidated) ? { kind: 'stale_lockfile' } : { kind: 'judgment' }
}

/** True when the run has no fix install left. */
export const budgetSpent = (installs: number): boolean => installs >= FIX_INSTALL_BUDGET

/**
 * The entries of `other_line_moves` whose class is the one given. An entry
 * that is not an object is fatal: a move that cannot be read never lets the
 * run go on. Null or absent is no move, as with no baseline. A value that is
 * neither a list nor null is one fatal move.
 */
export const movesOf = (
  moves: JsonValue | undefined,
  kind: 'fatal' | 'benign_dedup',
): JsonValue[] => {
  if (moves === null || moves === undefined) return []
  if (!Array.isArray(moves)) return kind === 'fatal' ? [moves] : []
  return moves.filter((move) => {
    const record = recordOf(move)
    return record === null ? kind === 'fatal' : record.class === kind
  })
}

/** The widest shape that `written[]` holds. `mode` of the answer is never read. */
export type Shape = 'bare' | 'direct' | 'scoped' | 'none'

/** A top-level key of an override block, with no parent in it. */
const isBareKey = (path: readonly unknown[]): boolean => {
  if (path[0] === 'pnpm') return path.length === 3 && path[1] === 'overrides'
  if (path[0] === 'overrides' || path[0] === 'resolutions') return path.length === 2
  return false
}

/**
 * The widest shape that `apply_constraint` wrote. A `preserved` entry is a
 * value that was there before, so it does not count. A transitive package
 * with no eligible parent gets a bare key with `mode: direct`, so `mode` is
 * not the answer. Null when an entry cannot be read: an entry that is not an
 * object, or a `path` that is neither a list nor null.
 */
export const widestShape = (written: readonly unknown[]): Shape | null => {
  const entries: { parent: unknown; path: readonly unknown[] }[] = []
  for (const entry of written) {
    const record = recordOf(entry)
    if (record === null) return null
    if (record.preserved === true) continue
    const path = record.path ?? []
    if (!Array.isArray(path)) return null
    entries.push({ parent: record.parent ?? null, path })
  }
  if (entries.some((entry) => entry.parent === null && isBareKey(entry.path))) return 'bare'
  if (
    entries.some((entry) => ['dependencies', 'devDependencies'].includes(entry.path[0] as string))
  ) {
    return 'direct'
  }
  return entries.length > 0 ? 'scoped' : 'none'
}

/** The three labels of a fix that `score` and the pull request read. */
export interface Labels {
  readonly action: 'bare-override' | 'direct-update' | 'scoped-override' | 'lockfile-refresh'
  readonly override_scope: 'bare-tightened' | 'bare-added' | 'none' | 'scoped'
  readonly bare_override: 'tightened' | 'added' | 'none'
}

/**
 * The labels of a shape. A step 2 is a bare override, whatever it wrote. A
 * bare override is `tightened` only when an observation from before the
 * first `apply_constraint` of the run named this package. Else this run
 * added it. Nothing written is `scoped`, the narrowest claim. The empty diff
 * can change it to a lockfile refresh later.
 */
export const labelsOf = (
  shape: Shape,
  tightenBare: boolean,
  observationsFirst: readonly unknown[],
): Labels => {
  if (tightenBare || shape === 'bare') {
    const tightened = observationsFirst.some(
      (observation) => recordOf(observation)?.targets_this_package === true,
    )
    return tightened
      ? { action: 'bare-override', override_scope: 'bare-tightened', bare_override: 'tightened' }
      : { action: 'bare-override', override_scope: 'bare-added', bare_override: 'added' }
  }
  if (shape === 'direct') {
    return { action: 'direct-update', override_scope: 'none', bare_override: 'none' }
  }
  return { action: 'scoped-override', override_scope: 'scoped', bare_override: 'none' }
}

/** The labels of a fix whose content is the drift commit. */
export const LOCKFILE_REFRESH: Labels = {
  action: 'lockfile-refresh',
  override_scope: 'none',
  bare_override: 'none',
}

/**
 * The versions of one major line in a `resolved_versions` answer: unique and
 * sorted. Null when the answer cannot be read: not an object, no `versions`
 * list, or an entry whose `version` is not text. Null is never the empty
 * list, because two failed reads that compare equal give a false no-op
 * (#146).
 */
export const lineVersions = (payload: unknown, line: string): string[] | null => {
  const record = recordOf(payload)
  if (record === null || !Array.isArray(record.versions)) return null
  const versions: string[] = []
  for (const entry of record.versions) {
    const version = recordOf(entry)?.version
    if (typeof version !== 'string') return null
    versions.push(version)
  }
  const onLine = new RegExp(`^${line}([.]|$)`)
  return uniqueJq(versions.filter((version) => onLine.test(version)))
}

/** What an empty diff after the fix install is. */
export type EmptyDiff = 'no_op' | 'lockfile_refresh' | 'disagree'

/**
 * The fix install changed nothing. The drift commit says which install
 * cleared the alerts. With no drift commit, or with the same versions of
 * the line on the two sides of it, the default branch has the fix: a no-op.
 * With other versions, the control install made the fix: a lockfile
 * refresh. A side with no version of the line disagrees with `validate`,
 * which found the line, so it is no evidence for either answer.
 */
export const emptyDiff = (
  drift: boolean,
  preDrift: readonly string[],
  baseline: readonly string[],
): EmptyDiff => {
  if (preDrift.length === 0 || baseline.length === 0) return 'disagree'
  const same =
    preDrift.length === baseline.length &&
    preDrift.every((version, index) => version === baseline[index])
  return !drift || same ? 'no_op' : 'lockfile_refresh'
}
