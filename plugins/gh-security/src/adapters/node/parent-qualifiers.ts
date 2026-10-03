// The version qualifiers of the parent keys of pnpm and npm (#100, #132),
// ported from `qual_result`, the refusal of the shared parent, the drop of
// the placed qualifiers and `bare_conflict` in `verb_apply_constraint` of
// node.sh (#222). The jq there is the specification.
//
// A bare parent key matches each resolved copy of the parent. The lockfile
// can resolve a parent at more than one version, each copy with its own
// major of the child. A bare key then moves each copy onto the line of the
// call. So the key carries a qualifier for each copy whose child is on the
// target line.
//
//   - pnpm: the exact version of each such copy.
//   - npm: the exact version of each such copy, except for the copies that
//     satisfy the spec that the root manifest declares for the parent. Those
//     share one key with that spec, byte for byte. npm refuses the install
//     (EOVERRIDE) for any other key that intersects the spec of a direct
//     dependency.
//
// The npm carve-out has its own routes:
//
//   - A root spec that also admits a copy on another line is refused. No
//     key keeps both the EOVERRIDE rule and the line apart.
//   - A root spec that the range rules cannot read, such as a dist-tag or
//     `file:`, gives the bare key.
//   - A prerelease copy is never covered by the root spec. It gets its own
//     exact key.
//   - A copy whose version is not plain semver gives the bare key.
//   - A copy with no version gives the bare key, for pnpm and npm alike.
//
// A parent with one version keeps the bare key. Yarn keys stay bare, so this
// pass does not run for yarn.
//
// A pnpm parent can also have a copy from outside the registry. Examples are
// a git URL, a codeload tarball and a `file:` path. No key qualified by a
// registry version matches that copy. So where the keys of that parent must
// be version-qualified, the call refuses before any write (#50, ruling 2).
// The plain key reaches each copy of the parent. So with one registry copy,
// the plain key covers the other copy too. Where a copy has the package on
// another major line, the plain key moves it across that line, and the call
// refuses (#50). Both refusals are declared parity exceptions. For the
// writes of node.sh, see `pnpmEdges`.
//
// This file ships. It imports nothing outside the plugin.

import { type Failure, failed } from '../../lib/envelope.ts'
import * as pnpm from '../../lockfiles/pnpm.ts'
import { rangeFloorMajor } from '../../semver/ranges.ts'
import type { NodeDetection } from './detect.ts'
import { equal, get, or, render, split, test, toText, trimStart, unique } from './jq-json.ts'
import { isRecord } from './manifest.ts'
import { copyRows, type NpmLock } from './npm-lock.ts'
import type { Placement } from './npm-placement.ts'
import { satisfiesAll } from './validate.ts'

/** One edge to the package: the parent, the version of its copy, and the version of the child. */
type Edge = { readonly parent: string; readonly pver: unknown; readonly cver: unknown }

/** The missing value of an edge, as the rows of node.sh write it. */
const MISSING = '-'

/**
 * A parent version from outside the registry (#50). A registry version starts
 * with a digit, as `parent.version` of the pnpm reader does. A git URL, with
 * or without an `@`, a codeload tarball and a `file:` path do not.
 */
const isOutsideRegistry = (parentVersion: string | null): parentVersion is string =>
  parentVersion !== null && !/^[0-9]/.test(parentVersion)

/**
 * The edges of pnpm, from `pnpm_edge_rows`. A child version that does not
 * start with a digit is `-` here. node.sh keeps its text, and reads no
 * major from it unless it starts with `v` and then a digit. pnpm writes no
 * such version: a declared divergence.
 *
 * The parent name ends at its first `@` here, and at its last `@` in
 * node.sh (#50). The two differ only for a parent version with an `@`, for
 * example a `git+ssh://git@` copy. node.sh gives that copy a different
 * parent name, so no parent of the call matches it.
 *
 * The port drops the edge of each copy from outside the registry. For a
 * version with an `@`, node.sh does this in effect. For another version,
 * such as a `git+https` URL, node.sh keeps the edge. Then it can write a key
 * that names the URL: a declared parity exception (#50).
 * `pnpmCopiesOutsideRegistry` keeps these copies for the refusals of #50.
 */
export const pnpmEdges = (text: string, pkg: string): readonly Edge[] =>
  pnpm
    .scan(text, pkg)
    .edges.filter(({ parentVersion }) => !isOutsideRegistry(parentVersion))
    .map(({ parent, parentVersion, version }) => ({
      parent: parent.name,
      pver: parentVersion ?? MISSING,
      cver: version ?? MISSING,
    }))

/** The versions from outside the registry of each pnpm parent of `pkg`, in the order of the file. */
export const pnpmCopiesOutsideRegistry = (
  text: string,
  pkg: string,
): ReadonlyMap<string, readonly string[]> => {
  const copies = pnpm
    .scan(text, pkg)
    .edges.flatMap(({ parent, parentVersion }) =>
      isOutsideRegistry(parentVersion) ? [{ name: parent.name, version: parentVersion }] : [],
    )
  return new Map(
    copies.map(({ name }) => [
      name,
      copies.filter((copy) => copy.name === name).map(({ version }) => version),
    ]),
  )
}

/** The edges of npm, from `npm_copy_rows`. */
export const npmEdges = (lock: NpmLock, pkg: string): readonly Edge[] =>
  copyRows(lock, pkg).map(({ parent, parent_version, resolved }) => ({
    parent,
    pver: or(parent_version, MISSING),
    cver: or(resolved, MISSING),
  }))

// `looks_range`: a spec that the range rules can read.
const LOOKS_RANGE = /^[ \t\n\v\f\r]*[v=^~><*0-9]/

// `is_plain_semver`: a version that can become an npm key selector.
const PLAIN_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+/

const ROOT_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** `root_decl`: the first text that a block of the root manifest declares for `parent`, or null. */
const rootSpecOf = (manifest: unknown, parent: string): string | null => {
  const specs = ROOT_BLOCKS.map((block) => or(get(or(get(manifest, block), {}), parent), null))
  return (specs.find((spec) => typeof spec === 'string') as string | undefined) ?? null
}

/** jq's `contains` of a text in a text. It throws for any other value. */
const contains = (value: unknown, part: string): boolean => {
  if (typeof value !== 'string') throw new Error('cannot test a value that is not a text')
  return value.includes(part)
}

/** What the pass gives for one parent. */
type Verdict = {
  readonly parent: string
  readonly refused: boolean
  readonly root_spec: string | null
  readonly leaks: readonly unknown[]
  readonly bare: boolean
  readonly qualifiers: readonly unknown[]
}

/** The inputs of the pass. */
export type QualifierQuery = {
  readonly location: NodeDetection['override_location']
  readonly edges: readonly Edge[]
  readonly parents: readonly string[]
  /** The floor major of the range as jq writes it, or '' when it has none. */
  readonly target: string
  /** package.json, for the root spec of npm. */
  readonly manifest: unknown
}

/** The major line of a child version, as `qual_result` reads it, or null when it has none. */
const lineOf = (cver: unknown): string | null => {
  // jq stops on an empty major, as `test` does on a value that is not a text.
  const major = split(trimStart(cver, 'v'), '.')[0]
  return test(major, /^[0-9]+$/) ? (major as string) : null
}

/** `qual_result`, for one parent that the lockfile resolves at more than one version. */
const verdictOf = (query: QualifierQuery, parent: string): Verdict | null => {
  const { location, target } = query
  const edges = query.edges.filter((edge) => edge.parent === parent)
  const read = edges.filter(({ pver }) => pver !== MISSING)
  if (unique(read.map(({ pver }) => pver)).length <= 1) return null
  const unreadable = edges.some(({ pver }) => pver === MISSING)
  const rows = read.map(({ pver, cver }) => ({ pver, cm: lineOf(cver) }))
  const onLine = unique(
    rows.filter(({ cm }) => target === '' || cm === null || cm === target).map(({ pver }) => pver),
  )
  const offLine = unique(
    rows.filter(({ cm }) => target !== '' && cm !== null && cm !== target).map(({ pver }) => pver),
  )
  const declared = location === 'overrides' ? rootSpecOf(query.manifest, parent) : null
  // node.sh also drops an `npm:` alias spec here. `looks_range` refuses
  // each one too: it starts with `n`.
  const spec = declared !== null && LOOKS_RANGE.test(declared) ? declared : null
  const covered = onLine.filter(
    (pver) => spec !== null && !contains(pver, '-') && satisfiesAll(toText(pver), spec),
  )
  const exact = onLine.filter((pver) => !covered.some((each) => equal(each, pver)))
  const leaks =
    covered.length > 0 ? offLine.filter((pver) => satisfiesAll(toText(pver), spec as string)) : []
  return {
    parent,
    // A leak needs a covered copy, so `leaks` is empty without one.
    refused: leaks.length > 0,
    root_spec: spec,
    leaks,
    bare:
      unreadable ||
      (declared !== null && spec === null) ||
      (location === 'overrides' && exact.some((pver) => !test(pver, PLAIN_SEMVER))),
    qualifiers: [...(covered.length > 0 ? [spec] : []), ...exact],
  }
}

/**
 * The qualifiers of each parent. Each one is a text: a version of pnpm, or
 * the root spec or a plain semver version of npm. The npm pass stops on a
 * version that is not a text before it can be a qualifier.
 */
export type Qualifiers = ReadonlyMap<string, readonly string[]>

/**
 * The qualifiers of each parent that needs them, in the order of the call.
 * A parent that is refused, or that falls back to the bare key, has none.
 * The refusal of a shared parent (#132) is a failure, unless each copy of
 * that parent on the line is placed (#147). Then the nested write serves
 * it. A qualifier that covers only placed copies is dropped: no placed copy
 * matches a top-level key. It throws where jq stops.
 */
export const qualifiersOf = (
  query: QualifierQuery,
  placements: ReadonlyMap<string, Placement>,
  pkg: string,
): Qualifiers | Failure => {
  const verdicts = query.parents.flatMap((parent) => verdictOf(query, parent) ?? [])
  const refused = verdicts
    .filter(({ refused: each }) => each)
    .map(({ parent, root_spec, leaks }) => ({ parent, root_spec, other_line_versions: leaks }))
    .filter(({ parent }) => {
      const placement = placements.get(parent)
      return placement === undefined || placement.has_normal_online
    })
  if (refused.length > 0) {
    return failed(
      `apply_constraint: cannot scope '${pkg}' on this line: the root manifest's own declared spec for a shared parent also admits that parent's copies on other major lines, so every key npm's EOVERRIDE rule allows would drag those lines across their major boundary (issue #132). Detail: ${render(refused, null)}. Nothing was written. This is the shared-parent shape: escalate it like a fatal cross-line move; the remedy is a bump of the shared parent or dropping the dependent that pins it.`,
    )
  }
  const qualifiers = new Map<string, readonly string[]>()
  for (const { parent, refused: no, bare, qualifiers: each } of verdicts) {
    if (!(no || bare) && each.length > 0) qualifiers.set(parent, each as readonly string[])
  }
  if (placements.size === 0) return qualifiers
  return new Map(
    [...qualifiers].flatMap(([parent, each]) => {
      const placement = placements.get(parent)
      if (placement === undefined) return [[parent, each] as const]
      const kept = each.filter(
        (qualifier) =>
          !placement.placed_pvers.some((pver) => equal(pver, qualifier)) ||
          placement.normal_pvers.some((pver) => equal(pver, qualifier)),
      )
      return kept.length === 0 ? [] : [[parent, kept] as const]
    }),
  )
}

/**
 * `bare_conflict`: a bare nested key of the manifest, for a parent that
 * this call qualifies, on another major line. A delete of that key strips
 * the protection of its line. If the key stays, the qualified keys do
 * nothing: npm matches the bare key first. So the call refuses (#132). A
 * key on the same line is no conflict: the write removes it, and reports it
 * as superseded.
 */
export const bareConflict = (
  qualifiers: Qualifiers,
  placements: ReadonlyMap<string, Placement>,
  manifest: unknown,
  pkg: string,
  range: string,
): Failure | null => {
  const target = rangeFloorMajor(range)
  const overrides = or(get(manifest, 'overrides'), {})
  const conflict = [...qualifiers.keys()]
    .sort((a, b) => Number(a > b) - Number(a < b))
    .map((parent) => ({ parent, value: or(get(overrides, parent), null) }))
    .find(({ value }) => {
      if (!isRecord(value) || !Object.hasOwn(value, pkg)) return false
      const floor = rangeFloorMajor(toText(value[pkg]))
      return floor === null || target === null || floor !== target
    })
  if (conflict === undefined) return null
  const detail = {
    parent: conflict.parent,
    value: (conflict.value as Readonly<Record<string, unknown>>)[pkg],
    parent_also_override_placed: placements.has(conflict.parent),
  }
  return failed(
    `apply_constraint: a pre-existing bare override for '${pkg}' under a parent this call must version-qualify pins a DIFFERENT major line: ${render(detail, null)}. Deleting it would strip that line's protection and keeping it would leave the qualified keys inert (npm matches the bare key first), so nothing was written; reconcile the existing override by hand (issue #132). When parent_also_override_placed is true, that parent additionally has override-placed copies this fix would have served by nesting inside their placing rule (issue #147).`,
  )
}

/**
 * The refusal of #50 (ruling 2): a pnpm parent that this call qualifies has a
 * copy from outside the registry, such as a git copy. No key qualified by a
 * registry version matches that copy, so the fix would leave it as it is. The
 * detail names each such parent, in the order of the call, with the versions
 * of those copies.
 */
export const outsideRegistryRefusal = (
  qualifiers: Qualifiers,
  outside: ReadonlyMap<string, readonly string[]>,
  pkg: string,
): Failure | null => {
  const detail = [...qualifiers.keys()].flatMap((parent) => {
    const versions = outside.get(parent)
    return versions === undefined ? [] : [{ parent, versions_outside_registry: versions }]
  })
  if (detail.length === 0) return null
  return failed(
    `apply_constraint: cannot scope '${pkg}' under a pnpm parent with a copy from outside the registry, such as a git copy. Each parent in the detail also resolves at two or more registry versions, so its keys must name a registry version ('<parent>@<version>>${pkg}'), and no such key matches the other copy (issue #50). Detail: ${render(detail, null)}. Nothing was written. The remedy is a registry version for that dependency, or one registry copy of the parent, so that the plain '<parent>>${pkg}' key covers each copy.`,
  )
}

/**
 * The pnpm parents of `pkg` with a copy whose `pkg` is on a major line other
 * than `target`. A copy from outside the registry counts too. As in
 * `qual_result`, a child with no readable line counts as on the line. With
 * no `target`, no copy is off the line.
 */
export const pnpmParentsOffLine = (
  text: string,
  pkg: string,
  target: string,
): ReadonlySet<string> =>
  new Set(
    pnpm
      .scan(text, pkg)
      .edges.filter(({ version }) => {
        const line = lineOf(version ?? MISSING)
        return target !== '' && line !== null && line !== target
      })
      .map(({ parent }) => parent.name),
  )

/**
 * The second refusal of #50. A pnpm parent of the call keeps the plain key,
 * and it has a copy from outside the registry. pnpm applies the plain key to
 * each copy of the parent. So where a copy of the parent has `pkg` on another
 * major line, the plain key moves that copy across its line. The detail names
 * each such parent, in the order of the call, with the versions of its copies
 * from outside the registry. The call runs it after `outsideRegistryRefusal`,
 * which refuses first each qualified parent with such a copy.
 */
export const plainKeyRefusal = (
  parents: readonly string[],
  outside: ReadonlyMap<string, readonly string[]>,
  offLine: ReadonlySet<string>,
  pkg: string,
): Failure | null => {
  const detail = [...new Set(parents)].flatMap((parent) => {
    const versions = outside.get(parent)
    if (versions === undefined || !offLine.has(parent)) return []
    return [{ parent, versions_outside_registry: versions }]
  })
  if (detail.length === 0) return null
  return failed(
    `apply_constraint: cannot scope '${pkg}' under a pnpm parent with a copy from outside the registry, such as a git copy. Each parent in the detail keeps the plain '<parent>>${pkg}' key, and pnpm applies that key to each copy of the parent. A copy of the parent has '${pkg}' on another major line, so the key would move that copy across its line (issue #50). Detail: ${render(detail, null)}. Nothing was written. The remedy is a registry version for that dependency, so that a key can name each copy of the parent.`,
  )
}
