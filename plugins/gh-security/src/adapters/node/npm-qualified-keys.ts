// The version-qualified keys of npm parents that the manifest has already
// (#333, #295). node.sh has no such pass. It is a declared parity exception,
// in the header of `apply-constraint.ts`.
//
// npm uses the first key of the override block that matches a copy of a
// parent (`getEdgeRule` and `getNodeRule` in `@npmcli/arborist`,
// `lib/override-set.js`). The other keys for that parent have no effect on
// the copy. Real npm 11.19.0 installs showed this. With `"nx@22.7.7": {...}`
// in the block, a new bare `"nx": {...}` key after it kept the child of nx
// 22.7.7. The child moved when the constraint was inside `"nx@22.7.7"`.
//
// When npm builds the tree, it matches a key by the range of the edge to
// the copy. The lockfile does not give that range, so this pass reads the
// version of the copy, as the placement pass does. The two agree when the
// selector admits the copy. A key whose selector does not admit the copy,
// but whose text or `"."` value does, can match the copy through its edge.
// Real runs showed both results.
//
// For each normal copy of a parent on the line, the pass finds the first key
// that matches it. When that key has a selector, the constraint goes inside
// that key, with `putRuleNested`. The pass drops each key of the normal write
// that reaches no other copy. That key would have no effect. A copy whose
// first key has no selector, or that no key matches, takes the normal write.
//
// When the qualified keys serve each normal copy on the line, a bare pair for
// the package after them has no effect. The pass supersedes a pair on the
// line, and reports it. A pair on another line stays as it is.
//
// Four refusals, each before any write:
//
//   - A key whose selector does not admit a copy on the line, but whose value
//     does, comes before the first key that the selector admits.
//   - A key that serves a copy is also the first key of a copy whose child is
//     on another major line. A constraint inside that key would move that line.
//   - A key that serves a copy has a pin for the package that is not on the
//     major line of the range, or that has no floor major.
//   - A key serves a copy, and the parent has a copy with no version. npm
//     gives an edge of a tag, a directory or a file the first key by name.
//
// This file ships. It imports nothing outside the plugin.

import { type Failure, failed } from '../../lib/envelope.ts'
import { rangeFloorMajor } from '../../semver/ranges.ts'
import { entriesOf, equal, get, or, render, toText, unique } from './jq-json.ts'
import { stripSelector } from './list-pins.ts'
import { isRecord } from './manifest.ts'
import type { Placement } from './npm-placement.ts'
import { type Edge, MISSING, type Qualifiers } from './parent-qualifiers.ts'
import { satisfiesAll } from './validate.ts'

/** The qualified keys of the manifest that serve the copies of one parent. */
export type QualifiedKeys = {
  /** The keys that get the constraint, in the order of the block. */
  readonly keys: readonly string[]
  /** Some normal copy of the parent on the line still needs the normal write. */
  readonly rest: boolean
  /** A bare pair for the package, on the line, that the keys make inert. */
  readonly supersedeBare: boolean
}

/** The inputs of the pass. */
export type QualifiedKeyQuery = {
  /** `.overrides // {}` of package.json. */
  readonly overrides: unknown
  readonly edges: readonly Edge[]
  readonly parents: readonly string[]
  readonly qualifiers: Qualifiers
  readonly placements: ReadonlyMap<string, Placement>
  readonly pkg: string
  readonly range: string
}

/** What the pass gives: the keys of each parent, and the qualifiers that still have an effect. */
export type QualifiedKeyResult = {
  readonly keys: ReadonlyMap<string, QualifiedKeys>
  readonly qualifiers: Qualifiers
}

/**
 * The selector admits the version. A selector that the range rules cannot
 * read admits no version here. npm refuses some of them as a key, such as
 * `nx@>=`.
 */
const admits = (version: string, selector: string): boolean => {
  try {
    return satisfiesAll(version, selector)
  } catch {
    return false
  }
}

/** A floor major that differs from `target`, or one of the two that has none. */
const otherLine = (value: unknown, target: number | null): boolean => {
  const floor = rangeFloorMajor(toText(value))
  return floor === null || target === null || floor !== target
}

/**
 * The child version has a floor major, and it is not `target`. A child with
 * no major is on the line.
 */
const childOffLine = (cver: unknown, target: number | null): boolean => {
  const floor = rangeFloorMajor(toText(cver))
  return floor !== null && target !== null && floor !== target
}

/**
 * The text value of a key, or its `"."` value, or null. npm moves a copy
 * that the key matches to it.
 */
const movedTo = (value: unknown): string | null => {
  const text = isRecord(value) ? value['.'] : value
  return typeof text === 'string' ? text : null
}

/** One normal copy of a parent, and where the write for it goes. */
type Copy = {
  readonly pver: string
  /**
   * The qualifier of the normal write that reaches the copy: '' for the
   * bare key, undefined for none.
   */
  readonly intended: string | undefined
  /** The first key that matches the copy. Null when no key matches, or the first is bare. */
  readonly first: string | null
  /** The keys before the first match whose value admits the copy, but whose selector does not. */
  readonly unsure: readonly string[]
}

/**
 * The qualified keys of the manifest for each parent of the call. It also
 * gives the qualifiers, less those that would write a key with no effect.
 * It gives a failure for each refusal.
 */
export const qualifiedKeysOf = (query: QualifiedKeyQuery): QualifiedKeyResult | Failure => {
  const { overrides, pkg, placements } = query
  const target = rangeFloorMajor(query.range)
  const block = entriesOf(overrides)
  const keys = new Map<string, QualifiedKeys>()
  const qualifiers = new Map(query.qualifiers)
  for (const parent of unique(query.parents)) {
    const placement = placements.get(parent)
    // The normal write does not run for this parent (#147).
    if (placement !== undefined && !placement.has_normal_online) continue
    const own = qualifiers.get(parent) ?? []
    /** The qualifier of the normal write for a copy on the line. */
    const intendedOf = (version: string): string | undefined =>
      own.length === 0 ? '' : own.find((each) => admits(version, each))
    /** The first key of the parent that matches the version, and the unsure keys before it. */
    const scan = (pver: string): Pick<Copy, 'first' | 'unsure'> => {
      const unsure: string[] = []
      for (const [key, value] of block) {
        const { name, selector } = stripSelector(key)
        if (name !== parent) continue
        if (selector === null) return { first: null, unsure }
        if (admits(pver, selector)) return { first: key, unsure }
        const moved = movedTo(value)
        if (moved !== null && admits(pver, moved)) unsure.push(key)
      }
      return { first: null, unsure }
    }
    // A copy with no version matches no selector here. The last refusal stops on it.
    const copies: Copy[] = query.edges
      .filter(({ parent: name }) => name === parent)
      .filter(
        ({ pver }) =>
          placement === undefined || placement.normal_pvers.some((each) => equal(each, pver)),
      )
      .map(({ pver, cver }) => {
        const version = toText(pver)
        return {
          pver: version,
          intended: childOffLine(cver, target) ? undefined : intendedOf(version),
          ...scan(version),
        }
      })
    const unsure = copies.filter(
      ({ intended, unsure: each }) => intended !== undefined && each.length > 0,
    )
    if (unsure.length > 0) {
      const detail = unique(unsure.flatMap(({ unsure: each }) => each)).map((key) => ({
        parent,
        key,
        versions: unique(
          unsure.filter(({ unsure: each }) => each.includes(key)).map(({ pver }) => pver),
        ),
      }))
      return failed(
        `apply_constraint: cannot scope '${pkg}': a pre-existing version-qualified override key for its parent has a selector that does not admit a copy on this line, and a value that does: ${render(detail, null)}. npm can match that key through the range of the edge to the copy, and move the copy to that value, so neither a constraint inside that key nor a new key after it can be shown to take effect (issue #333), so nothing was written; reconcile the existing override by hand.`,
      )
    }
    const served = unique(
      copies.flatMap(({ intended, first }) =>
        intended !== undefined && first !== null ? [first] : [],
      ),
    )
    if (served.length === 0) continue
    const offLine = copies.filter(
      ({ intended, first }) => intended === undefined && first !== null && served.includes(first),
    )
    if (offLine.length > 0) {
      const detail = unique(offLine.map(({ first }) => first)).map((key) => ({
        parent,
        key,
        other_line_versions: unique(
          offLine.filter(({ first }) => first === key).map(({ pver }) => pver),
        ),
      }))
      return failed(
        `apply_constraint: cannot scope '${pkg}' on this line: a pre-existing version-qualified override key for its parent is the first key that npm matches for copies on this line and for copies whose '${pkg}' is on other major lines: ${render(detail, null)}. A constraint inside that key would move those lines across their major boundary, and a new key after it has no effect on the copies it matches (issues #333 and #132), so nothing was written; reconcile the existing override by hand.`,
      )
    }
    const pins = served.flatMap((key) => {
      const value = or(get(overrides, key), null)
      if (!isRecord(value) || !Object.hasOwn(value, pkg)) return []
      return otherLine(value[pkg], target) ? [{ parent, key, value: value[pkg] }] : []
    })
    if (pins.length > 0) {
      return failed(
        `apply_constraint: a pre-existing pin for '${pkg}' INSIDE the version-qualified override key of its parent pins a DIFFERENT major line: ${render(pins, null)}. npm matches that key first, so a new key after it has no effect, and overwriting the pin would strip that line's protection (issues #333 and #132), so nothing was written; reconcile the existing override by hand.`,
      )
    }
    const ordered = block.map(([key]) => key).filter((key) => served.includes(key))
    if (copies.some(({ pver }) => pver === MISSING)) {
      return failed(
        `apply_constraint: cannot scope '${pkg}': its parent has a copy with no version in the lockfile, beside pre-existing version-qualified override keys that npm matches first for other copies: ${render([{ parent, keys: ordered }], null)}. npm can match such a key for the copy with no version, so neither a constraint inside it nor a new key after it can be shown to take effect (issue #333), so nothing was written; reconcile the existing override by hand.`,
      )
    }
    const unserved = copies.filter(
      ({ intended, first }) => intended !== undefined && first === null,
    )
    const rest = unserved.length > 0
    const bare = or(get(overrides, parent), null)
    keys.set(parent, {
      keys: ordered,
      rest,
      supersedeBare:
        !rest && isRecord(bare) && Object.hasOwn(bare, pkg) && !otherLine(bare[pkg], target),
    })
    // A qualifier that reaches no unserved copy would write a key with no effect.
    const kept = own.filter((each) => unserved.some(({ intended }) => intended === each))
    if (kept.length === 0) qualifiers.delete(parent)
    else qualifiers.set(parent, kept)
  }
  return { keys, qualifiers }
}
