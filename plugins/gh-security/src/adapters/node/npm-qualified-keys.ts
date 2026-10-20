// The version-qualified keys of npm parents that the manifest has already
// (#333, #295). node.sh has no such pass. It is a declared parity exception,
// in the header of `apply-constraint.ts`.
//
// npm uses the first key of the override block that matches a copy of a
// parent (`getEdgeRule` in `@npmcli/arborist`, `lib/override-set.js`). The
// other keys for that parent have no effect on the copy. Real npm 11.19.0
// installs showed this. With `"nx@22.7.7": {...}` in the block, a new bare
// `"nx": {...}` key after it kept the child of nx 22.7.7. The child moved
// when the constraint was inside `"nx@22.7.7"`.
//
// npm matches a key by the spec of each edge into the copy, not by the
// version of the copy. The lockfile gives that spec: the entry that depends
// on the parent declares it. This pass reads it:
//
//   - An exact version: the first key whose selector admits that version.
//   - A range that the copy satisfies: a selector that admits the copy
//     matches. An exact selector outside the range does not. npm can match
//     any other selector through the range, so that key is unsure.
//   - Any other spec, such as a tag, a git URL or a directory: npm takes the
//     first key by name, or skips each qualified key for a git URL.
//
// For each normal copy of a parent on the line, the pass finds the first key
// that matches it. When that key has a selector, the constraint goes inside
// that key, with `putRuleNested`. The pass drops each key of the normal write
// that reaches no other copy. That key would have no effect. A copy whose
// first key has no selector, or that no key matches, takes the normal write.
//
// When the qualified keys serve each normal copy on the line, a bare pair
// after them has no effect. The pass supersedes a pair on the line, and
// reports it. A pair on another line stays as it is.
//
// Four refusals, each before any write, for a parent with a qualified key:
//
//   - A copy of the parent has an edge of any other spec, or no edge.
//   - A copy has an unsure key before its first match, or two edges that
//     match different keys.
//   - A key that serves a copy is also the first key of a copy whose child is
//     on another major line. A constraint inside that key would move that line.
//   - A key that serves a copy has a pin for the package. The pin is on
//     another major line, or the pin or the range has no floor major.
//
// This file ships. It imports nothing outside the plugin.

import { type Failure, failed } from '../../lib/envelope.ts'
import { rangeFloorMajor } from '../../semver/ranges.ts'
import { entriesOf, equal, get, or, render, toText, unique } from './jq-json.ts'
import { stripSelector } from './list-pins.ts'
import { isRecord } from './manifest.ts'
import { candidatesOf, declarationsOf, lastSegment, type NpmLock, resolveFrom } from './npm-lock.ts'
import type { Placement } from './npm-placement.ts'
import { MISSING, type Qualifiers } from './parent-qualifiers.ts'
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
  readonly lock: NpmLock
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
  return floor === null || floor !== target
}

/**
 * The child version has a floor major, and it is not `target`. A child with
 * no major is on the line.
 */
const childOffLine = (cver: unknown, target: number | null): boolean => {
  const floor = rangeFloorMajor(toText(cver))
  return floor !== null && target !== null && floor !== target
}

// An exact version, as npm reads a spec or a selector of one version.
const EXACT = /^[v=]*([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?)$/

// A spec that the range rules can read, as `looks_range` reads it.
const LOOKS_RANGE = /^[v=^~><*0-9]/

/** The version of an exact spec or selector, or null. */
const exactOf = (spec: string): string | null => EXACT.exec(spec.trim())?.[1] ?? null

const EDGE_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** The specs of the edges into the copy at `path`, from each entry that depends on it. */
const specsInto = (lock: NpmLock, path: string): readonly unknown[] =>
  lock.entries.flatMap(([from, entry]) =>
    EDGE_BLOCKS.flatMap((block) => entriesOf(or(get(entry, block), {})))
      .filter(([key]) => resolveFrom(lock, from, key) === path)
      .map(([, spec]) => spec),
  )

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
  /** The keys that npm can match for the copy, other than `first`. */
  readonly unsure: readonly string[]
  /** An edge into the copy has a spec that is not a version or a range, or no edge comes in. */
  readonly other: boolean
}

/**
 * The qualified keys of the manifest for each parent of the call. It also
 * gives the qualifiers, less those that would write a key with no effect.
 * It gives a failure for each refusal. It throws where jq stops.
 */
export const qualifiedKeysOf = (query: QualifiedKeyQuery): QualifiedKeyResult | Failure => {
  const { overrides, lock, pkg, placements } = query
  const target = rangeFloorMajor(query.range)
  const block = entriesOf(overrides)
  const keys = new Map<string, QualifiedKeys>()
  const qualifiers = new Map(query.qualifiers)
  for (const parent of unique(query.parents)) {
    const placement = placements.get(parent)
    // The normal write does not run for this parent (#147).
    if (placement !== undefined && !placement.has_normal_online) continue
    /** The keys of the block for the parent, in order, with their selectors. */
    const own = block.flatMap(([key]) => {
      const { name, selector } = stripSelector(key)
      return name === parent ? [{ key, selector }] : []
    })
    if (own.every(({ selector }) => selector === null)) continue
    const quals = qualifiers.get(parent) ?? []
    /** The qualifier of the normal write for a copy on the line. */
    const intendedOf = (version: string): string | undefined =>
      quals.length === 0 ? '' : quals.find((each) => admits(version, each))
    /** The first key that one edge spec matches, and the unsure keys before it. */
    const scan = (pver: string, spec: string): Pick<Copy, 'first' | 'unsure'> => {
      const exact = exactOf(spec)
      const sure = exact !== null || admits(pver, spec)
      const unsure: string[] = []
      for (const { key, selector } of own) {
        if (selector === null) return { first: null, unsure }
        if (exact !== null) {
          if (admits(exact, selector)) return { first: key, unsure }
          continue
        }
        if (sure && admits(pver, selector)) return { first: key, unsure }
        const one = exactOf(selector)
        if (!(sure && one !== null && !admits(one, spec))) unsure.push(key)
      }
      return { first: null, unsure }
    }
    // Each copy of the parent that declares the package, as `npm_copy_rows` reads it.
    const copies: Copy[] = lock.entries
      .filter(([path]) => lastSegment(path) === parent)
      .flatMap(([path, entry]) =>
        declarationsOf(entry).flatMap(([key, specifier]) =>
          typeof specifier === 'string' && (key === pkg || specifier.startsWith(`npm:${pkg}@`))
            ? [{ path, pver: or(get(entry, 'version'), MISSING), key }]
            : [],
        ),
      )
      .filter(
        ({ pver }) =>
          placement === undefined || placement.normal_pvers.some((each) => equal(each, pver)),
      )
      .map(({ path, pver, key }) => {
        const version = toText(pver)
        // The version of the first candidate that has one, as `npm_copy_rows` reads it.
        const cver = [
          ...candidatesOf(path, key).map((each) =>
            or(get(lock.byKey.get(each) ?? null, 'version'), null),
          ),
          MISSING,
        ].find((each) => each !== null)
        const specs = specsInto(lock, path).map(toText)
        const readable = specs.filter((spec) => LOOKS_RANGE.test(spec.trim()))
        const found = readable.map((spec) => scan(version, spec))
        const firsts = unique(found.map(({ first }) => first))
        return {
          pver: version,
          intended: childOffLine(cver, target) ? undefined : intendedOf(version),
          first: firsts[0] ?? null,
          unsure: unique([
            ...found.flatMap(({ unsure }) => unsure),
            ...(firsts.length > 1 ? firsts.filter((each) => each !== null) : []),
          ]),
          other: readable.length === 0 || readable.length < specs.length,
        }
      })
    const qualified = own.flatMap(({ key, selector }) => (selector === null ? [] : [key]))
    const others = unique(copies.filter(({ other }) => other).map(({ pver }) => pver))
    if (others.length > 0) {
      return failed(
        `apply_constraint: cannot scope '${pkg}': a copy of its parent has an edge whose spec is not a version or a range, such as a tag, a git URL or a directory, beside pre-existing version-qualified override keys for that parent: ${render([{ parent, keys: qualified, versions: others }], null)}. npm gives such an edge the first key by name, or skips each qualified key for a git URL, so neither a constraint inside a key nor a new key after it can be shown to take effect (issue #333), so nothing was written; reconcile the existing override by hand.`,
      )
    }
    const unsure = copies.filter(({ unsure: each }) => each.length > 0)
    if (unsure.length > 0) {
      const detail = unique(unsure.flatMap(({ unsure: each }) => each)).map((key) => ({
        parent,
        key,
        versions: unique(
          unsure.filter(({ unsure: each }) => each.includes(key)).map(({ pver }) => pver),
        ),
      }))
      return failed(
        `apply_constraint: cannot scope '${pkg}': npm can match a pre-existing version-qualified override key for its parent through the range of an edge into a copy, and the lockfile cannot show which key it matches: ${render(detail, null)}. So neither a constraint inside a key nor a new key after it can be shown to take effect (issue #333), so nothing was written; reconcile the existing override by hand.`,
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
    const unserved = copies.filter(
      ({ intended, first }) => intended !== undefined && first === null,
    )
    const rest = unserved.length > 0
    const bare = or(get(overrides, parent), null)
    keys.set(parent, {
      keys: qualified.filter((key) => served.includes(key)),
      rest,
      supersedeBare:
        !rest && isRecord(bare) && Object.hasOwn(bare, pkg) && !otherLine(bare[pkg], target),
    })
    // A qualifier that reaches no unserved copy would write a key with no effect.
    const kept = quals.filter((each) => unserved.some(({ intended }) => intended === each))
    if (kept.length === 0) qualifiers.delete(parent)
    else qualifiers.set(parent, kept)
  }
  return { keys, qualifiers }
}
