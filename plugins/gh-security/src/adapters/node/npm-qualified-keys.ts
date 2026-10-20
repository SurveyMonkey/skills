// The version-qualified keys of npm parents that the manifest has already
// (#333, #295). node.sh has no such pass. It is a declared parity exception,
// in the header of `apply-constraint.ts`.
//
// npm uses the first key of the override block whose name and selector match
// a copy of a parent (`getEdgeRule` and `getNodeRule` in
// `@npmcli/arborist`, `lib/override-set.js`). The other keys for that parent
// have no effect on the copy. A real npm 11.19.0 install showed this. With
// `"nx@22.7.7": {...}` in the block, a new bare `"nx": {...}` key after it
// kept the child of nx 22.7.7. The child moved when the constraint was inside
// `"nx@22.7.7"`.
//
// npm matches a key by the version of the copy, and by the range of the edge
// to the copy. In a lockfile that npm wrote, a copy that a key matches has a
// version that the selector admits. So this pass reads the version of the
// copy, as the placement pass does.
//
// For each normal copy of a parent on the line, the pass finds the first key
// that matches it. When that key has a selector, the constraint goes inside
// that key, with `putRuleNested`. The keys of the normal write that reach no
// other copy are dropped, because each of them would have no effect. A copy
// whose first key has no selector, or that no key matches, takes the normal
// write.
//
// When the qualified keys serve each normal copy, a bare pair for the package
// after them has no effect. A pair on the line is superseded, and reported. A
// pair on another line stays as it is.
//
// Two refusals, each before any write:
//
//   - A key that serves a copy is also the first key of a copy whose child is
//     on another major line. A constraint inside that key would move that line.
//   - A key that serves a copy has a pin for the package on another major
//     line.
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
  /** Some normal copy of the parent still needs the normal write. */
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
 * The selector admits the version. npm's `semver.satisfies` answers false
 * for a range that it cannot read. The range rules here stop on such a
 * range, so the pass gives false too.
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

/** One normal copy of a parent, and where the write for it goes. */
type Copy = {
  readonly pver: string
  /** The qualifier of the normal write that reaches the copy: '' for the bare key, null for none. */
  readonly intended: string | null
  /** The first qualified key that matches the copy, or null. */
  readonly first: string | null
}

/**
 * The qualified keys of the manifest for each parent of the call, and the qualifiers
 * with the keys that would have no effect dropped. It gives a failure for
 * each refusal.
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
    /** The first key of the block for the parent that matches the version. */
    const firstOf = (pver: string): string | null => {
      const found = block.find(([key]) => {
        const { name, selector } = stripSelector(key)
        return name === parent && (selector === null || admits(pver, selector))
      })
      return found === undefined || stripSelector(found[0]).selector === null ? null : found[0]
    }
    const copies: Copy[] = query.edges
      .filter(({ parent: name, pver }) => name === parent && pver !== MISSING)
      .filter(
        ({ pver }) =>
          placement === undefined || placement.normal_pvers.some((each) => equal(each, pver)),
      )
      .map(({ pver }) => {
        const version = toText(pver)
        return {
          pver: version,
          intended: own.length === 0 ? '' : (own.find((each) => admits(version, each)) ?? null),
          first: firstOf(version),
        }
      })
    const served = unique(
      copies.flatMap(({ intended, first }) => (intended !== null && first !== null ? [first] : [])),
    )
    if (served.length === 0) continue
    const offLine = copies.filter(
      ({ intended, first }) => intended === null && first !== null && served.includes(first),
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
    const unserved = copies.filter(({ intended, first }) => intended !== null && first === null)
    const rest = unserved.length > 0
    const bare = or(get(overrides, parent), null)
    keys.set(parent, {
      keys: block.map(([key]) => key).filter((key) => served.includes(key)),
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
