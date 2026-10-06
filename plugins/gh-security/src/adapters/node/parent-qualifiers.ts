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
// a git URL, a codeload tarball and a `file:` path. pnpm matches the version
// of a parent key against the version in the manifest of each copy, not
// against its URL (#313). A real pnpm 10.34.5 install showed this for a
// codeload, a `git+https` and a `file:` copy. The `packages:` entry of such a
// copy gives that version as `version:`. So the pass reads that copy as a
// copy at its manifest version, and qualifies it as it qualifies a registry
// copy (`debug@4.3.4>ms`).
//
// Two refusals stay, each before any write. Both are declared parity
// exceptions (#50, #313):
//
//   - The keys of a parent must be version-qualified, and a copy from outside
//     the registry has no manifest version to name. No qualified key matches
//     that copy.
//   - A key of the call reaches a copy of a parent with such a copy, and that
//     copy has the package on another major line. The plain key reaches each
//     copy. A qualified key reaches each copy at its version, also a copy from
//     outside the registry with the same manifest version.
//
// For the writes of node.sh, see `pnpmEdges`.
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

/** One pnpm edge to `pkg`, with the version that a parent key can name. */
type PnpmCopy = {
  readonly parent: string
  /** The version from outside the registry, or null for a registry copy. */
  readonly outside: string | null
  /**
   * The version that a key qualified by it matches: the registry version,
   * or the manifest version of a copy from outside the registry (#313).
   * Null when there is none, or when it does not start with a digit.
   */
  readonly named: string | null
  readonly child: string | null
}

/** A manifest version that a key can name: one that starts with a digit, as a registry version does. */
const readable = (version: string | undefined): string | null =>
  version !== undefined && /^[0-9]/.test(version) ? version : null

/** Each pnpm edge to `pkg`, in the order of the file. */
const pnpmCopies = (text: string, pkg: string): readonly PnpmCopy[] => {
  const manifests = pnpm.manifestVersions(text)
  return pnpm.scan(text, pkg).edges.map(({ parent, parentVersion, version }) => {
    const outside = isOutsideRegistry(parentVersion) ? parentVersion : null
    return {
      parent: parent.name,
      outside,
      named:
        outside === null ? parentVersion : readable(manifests.get(`${parent.name}@${outside}`)),
      child: version,
    }
  })
}

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
 * A copy from outside the registry has the edge of its manifest version
 * here (#313). The port drops the edge of such a copy with no manifest
 * version. node.sh reads no manifest version. For a version with an `@`, it
 * drops the edge in effect. For another version, such as a `git+https` URL,
 * it keeps the edge with the URL as its version, and can write a key that
 * names the URL. pnpm matches no such key. Both are declared parity
 * exceptions (#50, #313). `pnpmCopiesWithNoVersion` keeps the dropped copies
 * for the refusals.
 */
export const pnpmEdges = (text: string, pkg: string): readonly Edge[] =>
  pnpmCopies(text, pkg)
    .filter(({ outside, named }) => outside === null || named !== null)
    .map(({ parent, named, child }) => ({
      parent,
      pver: named ?? MISSING,
      cver: child ?? MISSING,
    }))

/** The versions of a list of copies, by parent, in the order of the file. */
const byParent = (copies: readonly PnpmCopy[]): ReadonlyMap<string, readonly string[]> =>
  new Map(
    copies.map(({ parent }) => [
      parent,
      copies.flatMap((copy) => (copy.parent === parent ? [copy.outside as string] : [])),
    ]),
  )

/** The versions from outside the registry of each pnpm parent of `pkg`, in the order of the file. */
export const pnpmCopiesOutsideRegistry = (
  text: string,
  pkg: string,
): ReadonlyMap<string, readonly string[]> =>
  byParent(pnpmCopies(text, pkg).filter(({ outside }) => outside !== null))

/**
 * The versions from outside the registry of each pnpm parent of `pkg` whose
 * `packages:` entry gives no manifest version that a key can name (#313).
 */
export const pnpmCopiesWithNoVersion = (
  text: string,
  pkg: string,
): ReadonlyMap<string, readonly string[]> =>
  byParent(pnpmCopies(text, pkg).filter(({ outside, named }) => outside !== null && named === null))

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
 * The first refusal of #50 and #313: a pnpm parent that this call qualifies
 * has a copy from outside the registry, such as a git copy, whose
 * `packages:` entry gives no manifest version. pnpm matches a qualified key
 * against the manifest version of a copy, so no qualified key matches that
 * copy, and the fix would leave it as it is. The detail names each such
 * parent, in the order of the call, with the versions of those copies.
 */
export const outsideRegistryRefusal = (
  qualifiers: Qualifiers,
  noVersion: ReadonlyMap<string, readonly string[]>,
  pkg: string,
): Failure | null => {
  const detail = [...qualifiers.keys()].flatMap((parent) => {
    const versions = noVersion.get(parent)
    return versions === undefined ? [] : [{ parent, versions_outside_registry: versions }]
  })
  if (detail.length === 0) return null
  return failed(
    `apply_constraint: cannot scope '${pkg}' under a pnpm parent with a copy from outside the registry, such as a git copy, whose 'packages:' entry gives no manifest version. Each parent in the detail resolves at two or more versions, so its keys must name a version ('<parent>@<version>>${pkg}'). pnpm matches that version against the manifest version of each copy, and the lockfile gives none for the copies in the detail, so no such key matches them (issues #50 and #313). Detail: ${render(detail, null)}. Nothing was written. The remedy is a registry version for that dependency, or one registry copy of the parent, so that the plain '<parent>>${pkg}' key covers each copy.`,
  )
}

/**
 * The versions that a key can name of the pnpm copies of each parent whose
 * `pkg` is on a major line other than `target`: the registry version, or the
 * manifest version of a copy from outside the registry (#313). A copy with no
 * such version gives null. As in `qual_result`, a child with no readable line
 * counts as on the line. With no `target`, no copy is off the line.
 */
export const pnpmOffLineVersions = (
  text: string,
  pkg: string,
  target: string,
): ReadonlyMap<string, readonly (string | null)[]> => {
  const offLine = pnpmCopies(text, pkg).filter(({ child }) => {
    const line = lineOf(child ?? MISSING)
    return target !== '' && line !== null && line !== target
  })
  return new Map(
    offLine.map(({ parent }) => [
      parent,
      offLine.filter((copy) => copy.parent === parent).map(({ named }) => named),
    ]),
  )
}

/**
 * The second refusal of #50 and #313. A pnpm parent of the call has a copy
 * from outside the registry, and a key of the call reaches a copy of that
 * parent with `pkg` on another major line. The key would move that copy
 * across its line. The plain key reaches each copy of the parent. A
 * qualified key reaches each copy at its version, so it reaches an off-line
 * copy with the same version as a copy on the line. The detail names each
 * such parent, in the order of the call, with the versions of its copies
 * from outside the registry. The call runs it after `outsideRegistryRefusal`.
 */
export const plainKeyRefusal = (
  parents: readonly string[],
  qualifiers: Qualifiers,
  outside: ReadonlyMap<string, readonly string[]>,
  offLine: ReadonlyMap<string, readonly (string | null)[]>,
  pkg: string,
): Failure | null => {
  const detail = [...new Set(parents)].flatMap((parent) => {
    const versions = outside.get(parent)
    const keys = qualifiers.get(parent)
    const reached = (offLine.get(parent) ?? []).filter(
      (version) => keys === undefined || keys.some((key) => key === version),
    )
    if (versions === undefined || reached.length === 0) return []
    return [{ parent, versions_outside_registry: versions }]
  })
  if (detail.length === 0) return null
  return failed(
    `apply_constraint: cannot scope '${pkg}' under a pnpm parent with a copy from outside the registry, such as a git copy. For each parent in the detail, a key of the call reaches a copy that has '${pkg}' on another major line, so the key would move that copy across its line. The plain '<parent>>${pkg}' key reaches each copy of the parent, and '<parent>@<version>>${pkg}' reaches each copy whose manifest version is that version, so no key names the copies on the line apart from that copy (issues #50 and #313). Detail: ${render(detail, null)}. Nothing was written. The remedy is a registry version for that dependency, so that a key can name each copy of the parent.`,
  )
}
