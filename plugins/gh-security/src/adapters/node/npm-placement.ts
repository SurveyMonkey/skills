// Override-placed parents of npm (#147, #153), ported from the placement
// pass of `verb_apply_constraint` in node.sh (#222). The jq there is the
// specification.
//
// An override rule of the manifest can name a parent as a child key of another
// rule: `{"A": {"B": "<range>"}}`. npm scopes such a copy of B to the rule
// that placed it. A top-level `"B": {...}` key never matches that copy. So
// the constraint nests inside the rule, and the `"."` self key keeps the
// range of the parent.
//
// A rule path places a copy only when the lockfile corroborates it. The
// chain of dependents of the copy must have the root and each segment of
// the rule, in order. Each selector of the rule must admit the version of
// its copy. The walk is one level set for each segment of the rule, so a
// graph with many branches stays cheap, and a cycle ends.
//
// Each copy of a parent is placed or normal. A placed copy takes the nested
// write, and a normal copy takes the top-level key. With `tightenBare`, the
// subject is the package itself.
//
// The pass also has the refusals of placement, and the rule pins that a
// tighten moves. Each refusal comes before any write.
//
// This file ships. It imports nothing outside the plugin.

import { type Failure, failed } from '../../lib/envelope.ts'
import { rangeFloorMajor } from '../../semver/ranges.ts'
import {
  entriesOf,
  equal,
  get,
  getPath,
  or,
  render,
  split,
  test,
  toText,
  trimStart,
  unique,
} from './jq-json.ts'
import { factsOf, stripSelector } from './list-pins.ts'
import { isRecord, NO_DOCUMENT } from './manifest.ts'
import { declarationsOf, lastSegment, type NpmLock, nameAt, resolveFrom } from './npm-lock.ts'
import { satisfiesAll } from './validate.ts'

/** What the pass finds for one subject: the rules that place it, and how its copies split. */
export type Placement = {
  /** Each corroborated rule path with no selector on its last key. */
  readonly rulepaths: readonly (readonly string[])[]
  /** Each corroborated rule path whose last key has a selector. */
  readonly qualified_rulepaths: readonly (readonly string[])[]
  /** Each rule path whose `npm:` value places the subject under an alias key. */
  readonly alias_rulepaths: readonly (readonly string[])[]
  /** The versions of the placed copies, unique. */
  readonly placed_pvers: readonly unknown[]
  /** The versions of the normal copies, unique. */
  readonly normal_pvers: readonly unknown[]
  readonly has_normal: boolean
  /** A normal copy resolves the package on the target line, or on a line that it cannot read. */
  readonly has_normal_online: boolean
  /** The other major lines that a placed copy resolves the package on, unique. */
  readonly placed_offline: readonly string[]
}

/** One key path of the override block, and its value. */
type KeyPath = { readonly path: readonly string[]; readonly value: unknown }

/** `key_paths`: each key path of the block, a key before the keys under it. */
const keyPaths = (block: unknown, path: readonly string[]): KeyPath[] =>
  entriesOf(block).flatMap(([key, value]) => [
    { path: [...path, key], value },
    ...(isRecord(value) ? keyPaths(value, [...path, key]) : []),
  ])

/** Group pairs by their first value: each key once, with its values unique. */
const groupPairs = (pairs: readonly (readonly [string, string])[]): Map<string, string[]> => {
  const grouped = new Map<string, string[]>()
  for (const [key, value] of pairs) grouped.set(key, [...(grouped.get(key) ?? []), value])
  return new Map([...grouped].map(([key, values]) => [key, unique(values)]))
}

/** One copy of a subject: its lockfile path, its version, and the major of the child it resolves. */
type SubjectCopy = { readonly path: string; readonly pver: unknown; readonly cm: string | null }

/** The inputs of the pass. */
export type PlacementQuery = {
  readonly lock: NpmLock
  /** `.overrides // {}` of package.json. */
  readonly overrides: unknown
  readonly pkg: string
  readonly parents: readonly string[]
  /** The floor major of the range as jq writes it, or '' when it has none. */
  readonly target: string
  readonly tighten: boolean
}

/** The graph of the lockfile: each copy and the copies that it declares. */
const graphOf = (lock: NpmLock) => {
  // The logical parents of each copy: the entries whose declarations resolve to it.
  const parentsOf = groupPairs(
    lock.entries.flatMap(([path, entry]) =>
      declarationsOf(entry).flatMap(([key, value]): (readonly [string, string])[] => {
        if (typeof value !== 'string') return []
        const target = resolveFrom(lock, path, key)
        return target === null ? [] : [[target, path]]
      }),
    ),
  )
  const childrenOf = groupPairs(
    [...parentsOf].flatMap(([child, parents]) => parents.map((parent) => [parent, child] as const)),
  )
  /**
   * `down_from`: each entry with a proper chain of dependents up to a seed.
   * Each entry enters the set once, so a cycle ends.
   */
  const downFrom = (seeds: readonly string[]): Set<string> => {
    const seen = new Set<string>()
    let frontier = seeds
    while (frontier.length > 0) {
      const next = new Set<string>()
      for (const entry of frontier) {
        for (const child of childrenOf.get(entry) ?? []) if (!seen.has(child)) next.add(child)
      }
      for (const child of next) seen.add(child)
      frontier = [...next]
    }
    return seen
  }
  return { downFrom }
}

/**
 * The placement of each subject that a corroborated rule, or an alias rule,
 * places. It throws where jq stops.
 */
export const placementsOf = (query: PlacementQuery): ReadonlyMap<string, Placement> => {
  const { lock, overrides, pkg, target, tighten } = query
  // jq writes no placement for a lockfile with no document, and the next
  // pass of node.sh stops on that empty text (exit 2).
  if (lock.document === NO_DOCUMENT) throw new Error('package-lock.json holds no document')
  const { downFrom } = graphOf(lock)
  const keys = lock.entries.map(([path]) => path)
  /** `seg_ok`: the segment names the entry, and its selector admits the version of the entry. */
  const segmentAdmits = (path: string, segment: string): boolean => {
    const { name, selector } = stripSelector(segment)
    if (!equal(nameAt(lock, path), name)) return false
    if (selector === null) return true
    const version = or(get(lock.byKey.get(path), 'version'), null)
    return version !== null && satisfiesAll(toText(version), selector)
  }
  /** `realizers`: the entries from which a chain realizes `reversed`, outermost segment first. */
  const realizers = (reversed: readonly string[]): ReadonlySet<string> =>
    reversed.reduceRight<ReadonlySet<string> | null>(
      (next, segment) =>
        downFrom(
          keys.filter((path) => segmentAdmits(path, segment) && (next === null || next.has(path))),
        ),
      null,
    ) as ReadonlySet<string>
  const nested = keyPaths(overrides, []).filter(
    ({ path }) => path.length > 1 && path.at(-1) !== '.',
  )
  /** The major of the child copy at `path`, as `npm_copy_rows` reads it. */
  const childMajor = (path: string | null): string | null => {
    if (path === null) return null
    const head = split(trimStart(or(get(lock.byKey.get(path), 'version'), ''), 'v'), '.')[0] ?? null
    return test(head, /^[0-9]+$/) ? (head as string) : null
  }
  /** The copies of a subject: the entries of the package, or the parent entries that host it. */
  const copiesOf = (subject: string): SubjectCopy[] =>
    lock.entries.flatMap(([path, entry]): SubjectCopy[] => {
      // The root has the name '', and a subject is never empty.
      if (!equal(nameAt(lock, path), subject)) return []
      const pver = or(get(entry, 'version'), null)
      if (tighten) return [{ path, pver, cm: null }]
      return declarationsOf(entry).flatMap(([key, value]): SubjectCopy[] =>
        typeof value === 'string' && (key === pkg || value.startsWith(`npm:${pkg}@`))
          ? [{ path, pver, cm: childMajor(resolveFrom(lock, path, key)) }]
          : [],
      )
    })
  const placements = new Map<string, Placement>()
  for (const subject of tighten ? [pkg] : query.parents) {
    const copies = copiesOf(subject)
    const corroborated = nested
      .filter(({ path }) => stripSelector(path.at(-1) as string).name === subject)
      .flatMap(({ path }) => {
        const { selector } = stripSelector(path.at(-1) as string)
        const admitted = copies.filter(
          ({ pver }) =>
            selector === null || (pver !== null && satisfiesAll(toText(pver), selector)),
        )
        if (admitted.length === 0) return []
        const reach = realizers(path.slice(0, -1).reverse())
        const placed = admitted.filter(({ path: copy }) => reach.has(copy))
        return placed.length === 0
          ? []
          : [{ path, qualified: selector !== null, placed: placed.map(({ path: copy }) => copy) }]
      })
    const aliasPaths = nested
      .filter(({ value }) => {
        if (typeof value !== 'string') return false
        const facts = factsOf(value)
        return facts.kind === 'alias' && facts.alias_package === subject
      })
      .filter(({ path }) =>
        lock.entries.some(
          ([key, entry]) =>
            key !== '' &&
            lastSegment(key) === path.at(-1) &&
            equal(or(get(entry, 'name'), ''), subject),
        ),
      )
      .map(({ path }) => path)
    if (corroborated.length === 0 && aliasPaths.length === 0) continue
    const placedPaths = new Set(corroborated.flatMap(({ placed }) => placed))
    const placedCopies = copies.filter(({ path }) => placedPaths.has(path))
    const normalCopies = copies.filter(({ path }) => !placedPaths.has(path))
    const versions = (each: readonly SubjectCopy[]) =>
      unique(each.map(({ pver }) => pver).filter((pver) => pver !== null))
    placements.set(subject, {
      rulepaths: corroborated.filter(({ qualified }) => !qualified).map(({ path }) => path),
      qualified_rulepaths: corroborated
        .filter(({ qualified }) => qualified)
        .map(({ path }) => path),
      alias_rulepaths: aliasPaths,
      placed_pvers: versions(placedCopies),
      normal_pvers: versions(normalCopies),
      has_normal: normalCopies.length > 0,
      has_normal_online: normalCopies.some(
        ({ cm }) => target === '' || cm === null || cm === target,
      ),
      placed_offline: unique(
        placedCopies.flatMap(({ cm }) =>
          target !== '' && cm !== null && cm !== target ? [cm] : [],
        ),
      ),
    })
  }
  return placements
}

/** The dash of the tighten refusal of node.sh, U+2014, which the message keeps byte for byte. */
const DASH = String.fromCodePoint(0x2014)

/** `dotted`: a rule path as `overrides.a.b`. */
const dotted = (path: readonly string[]): string => ['overrides', ...path].join('.')

/** The floor major of a value of the block, read from its text. */
const floorOf = (value: unknown): number | null => rangeFloorMajor(toText(value))

/** A floor major that differs from `target`, or one of the two that has none. */
const otherLine = (floor: number | null, target: number | null): boolean =>
  floor === null || target === null || floor !== target

/**
 * The first refusal of placement, in the order of node.sh, or null. Each
 * message quotes the rule paths involved, as compact JSON. With
 * `tightenBare`, only the alias refusal applies: a tighten moves the value
 * that a rule key already has.
 */
export const placementRefusal = (
  placements: ReadonlyMap<string, Placement>,
  overrides: unknown,
  pkg: string,
  range: string,
  tighten: boolean,
): Failure | null => {
  const target = rangeFloorMajor(range)
  const each = [...placements]
  const detail = (value: unknown): string => render(value, null)
  const alias = each.flatMap(([parent, { alias_rulepaths }]) =>
    alias_rulepaths.map((path) => ({ parent, rule: dotted(path) })),
  )
  if (alias.length > 0) {
    return failed(
      `apply_constraint: cannot scope '${pkg}': a pre-existing override rule places its parent through an npm: ALIAS child key, and the lockfile carries the alias-installed copy: ${detail(alias)}. A top-level key never matches an override-placed copy (issue #147), and writing through an alias-keyed rule is not a shape these scripts have verified npm to honor, so nothing was written; reconcile the existing override by hand.`,
    )
  }
  if (tighten) return null
  const qualified = each.flatMap(([parent, { qualified_rulepaths }]) =>
    qualified_rulepaths.map((path) => ({ parent, rule: dotted(path) })),
  )
  if (qualified.length > 0) {
    return failed(
      `apply_constraint: cannot scope '${pkg}': the override rule placing its parent uses a version-qualified child key: ${detail(qualified)}. Nesting a new entry under a selector-carrying rule key is not a shape these scripts have verified npm to honor, and a top-level key never matches an override-placed copy (issues #147 and #132), so nothing was written; reconcile the existing override by hand.`,
    )
  }
  const offline = each.flatMap(([parent, { rulepaths, placed_offline }]) =>
    placed_offline.length > 0
      ? [{ parent, rules: rulepaths.map(dotted), other_line_majors: placed_offline }]
      : [],
  )
  if (offline.length > 0) {
    return failed(
      `apply_constraint: cannot scope '${pkg}' on this line: the override rule(s) placing its parent also reach parent copies whose resolution of '${pkg}' sits on other major line(s): ${detail(offline)}. A key nested inside a rule cannot be version-qualified to separate the lines, and nothing top-level reaches a placed copy (issues #147 and #132), so nothing was written; reconcile the existing override by hand.`,
    )
  }
  const dead = each.flatMap(([parent, { has_normal }]) => {
    if (has_normal) return []
    const value = or(get(overrides, parent), null)
    if (!isRecord(value) || !Object.hasOwn(value, pkg)) return []
    return otherLine(floorOf(value[pkg]), target)
      ? [{ parent, key: `overrides.${parent}.${pkg}`, value: value[pkg] }]
      : []
  })
  if (dead.length > 0) {
    return failed(
      `apply_constraint: a pre-existing top-level override for '${pkg}' under an override-placed parent pins a DIFFERENT major line: ${detail(dead)}. Every copy of that parent is placed by a rule, so the key matches nothing (issue #147), but a different-line value is not deleted on this call's own judgment (issue #132 semantics); nothing was written, reconcile the existing override by hand.`,
    )
  }
  const rulePins = each.flatMap(([parent, { rulepaths }]) =>
    rulepaths.flatMap((path) => {
      const current = getPath(overrides, path)
      if (!isRecord(current) || !Object.hasOwn(current, pkg)) return []
      return otherLine(floorOf(current[pkg]), target)
        ? [{ parent, rule: dotted(path), value: current[pkg] }]
        : []
    }),
  )
  if (rulePins.length > 0) {
    return failed(
      `apply_constraint: a pre-existing pin for '${pkg}' INSIDE the override rule placing its parent pins a DIFFERENT major line: ${detail(rulePins)}. Overwriting it would strip that line's protection and keeping it would smother this fix (issues #147 and #132), so nothing was written; reconcile the existing override by hand.`,
    )
  }
  return null
}

/**
 * The rule paths that a `--tighten-bare` of a placed package moves: each
 * rule that places it and has a pin on the line of `range`. The pin is the
 * value of the rule, or its `"."` key. A placement whose rules have no pin
 * on the line is a refusal: a top-level key never matches a placed copy
 * (#147). A package with no rule path gets no rule pins.
 */
export const tightenedRules = (
  placement: Placement | undefined,
  overrides: unknown,
  pkg: string,
  range: string,
): readonly (readonly string[])[] | Failure => {
  const paths = [...(placement?.rulepaths ?? []), ...(placement?.qualified_rulepaths ?? [])]
  if (paths.length === 0) return []
  const target = rangeFloorMajor(range)
  const covered = paths.filter((path) => {
    const current = getPath(overrides, path)
    const pin = isRecord(current) ? or(get(current, '.'), null) : current
    return typeof pin === 'string' && target !== null && rangeFloorMajor(pin) === target
  })
  if (covered.length > 0) return covered
  return failed(
    `apply_constraint: --tighten-bare cannot reach '${pkg}': its copies are placed by pre-existing override rule(s) ${render(paths.map(dotted), null)}, none of which carries a pin on this line to tighten, and a top-level bare key never matches an override-placed copy (issue #147) ${DASH} writing one would be silently inert. Nothing was written; reconcile the existing override by hand.`,
  )
}
