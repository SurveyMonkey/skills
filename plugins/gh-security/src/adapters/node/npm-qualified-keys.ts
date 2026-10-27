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
//   - A git spec with a `#semver:<range>` part: npm matches a key through that
//     range, as for a range edge (`getEdgeRule`, `lib/override-set.js:103-109`
//     in arborist 9.9.1). The pass reads the edge as that range (#359), when
//     `rangeParseable` accepts it. It refuses any other range, such as a
//     hyphen range, which `satisfies` reads but `rangeParseable` does not.
//   - Any other spec, such as a tag, a git URL with no range or a directory:
//     npm takes the first key by name, or skips each qualified key for a git
//     URL.
//
// For each normal copy of a parent on the line, the pass finds the first key
// that matches it. When that key has a selector, the constraint goes inside
// that key, with `putRuleNested`. The pass drops each key of the normal write
// that reaches no other copy. That key would have no effect. A copy whose
// first key has no selector, or that no key matches, takes the normal write.
//
// When the qualified keys serve each normal copy on the line, a bare pair
// after them has no effect. The write pass supersedes each pair of the call
// on the line, and reports it. A pair on another line stays as it is.
//
// The write pass removes a bare key that holds only pairs of the call on the
// line, when the parent has qualifiers (#355). npm then matches the next key
// for the parent. So the scan skips that bare key, and a later qualified key
// can take the write. A real npm 11.19.0 run showed this: after the bare key
// went, `debug@^3` was the first key of debug 3.2.7.
//
// `scanKeys` also reads the child keys inside a target key of the write
// (#354). `childEdgesOf` gives the edges for it.
//
// Five refusals, each before any write, for a parent with a qualified key:
//
//   - A git edge into a copy has a `#semver:` range that the range rules
//     cannot read.
//   - A copy of the parent has an edge of any other spec, or no edge.
//   - A copy, on any line, has an unsure key before its first match, or two
//     edges that match different keys.
//   - A key that serves a copy is also the first key of a copy whose child is
//     on another major line. A constraint inside that key would move that line.
//   - A key that serves a copy has a pin for the package. The pin is on
//     another major line, or the pin or the range has no floor major.
//
// This file ships. It imports nothing outside the plugin.

import { type Failure, failed } from '../../lib/envelope.ts'
import { rangeFloorMajor, rangeParseable } from '../../semver/ranges.ts'
import { entriesOf, equal, get, or, render, toText, unique } from './jq-json.ts'
import { stripSelector } from './list-pins.ts'
import { isRecord } from './manifest.ts'
import { candidatesOf, declarationsOf, lastSegment, type NpmLock, resolveFrom } from './npm-lock.ts'
import type { Placement } from './npm-placement.ts'
import { MISSING, pinFloor, type Qualifiers, writeKeysOf } from './parent-qualifiers.ts'
import { satisfiesAll } from './validate.ts'

/** The qualified keys of the manifest that serve the copies of one parent. */
export type QualifiedKeys = {
  /** The keys that get the constraint, in the order of the block. */
  readonly keys: readonly string[]
  /** Some normal copy of the parent on the line still needs the normal write. */
  readonly rest: boolean
  /**
   * The keys serve each normal copy on the line, so a bare pair after them
   * has no effect. The write pass supersedes each such pair on the line.
   */
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
  /** The keys that each parent declares the package under. */
  readonly keysByParent: ReadonlyMap<string, readonly string[]>
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
export const admits = (version: string, selector: string): boolean => {
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
export const LOOKS_RANGE = /^[v=^~><*0-9]/

/** The version of an exact spec or selector, or null. */
export const exactOf = (spec: string): string | null => EXACT.exec(spec.trim())?.[1] ?? null

// A git spec, as npm-package-arg reads one: a `git+` or `git:` URL, a host
// prefix, or an `owner/repo` shorthand. A git spec of another form, such as an
// https URL of a host, does not match. Its edge is then an edge of another
// spec, and the pass refuses it. The shorthand has no `@` before the `#`.
// npm-package-arg reads a spec that starts with `.` or `~/` as a directory
// (`isPosixFile`, `npa.js:20`). The shorthand here does not start with `.` or
// `~`. npm reads `~owner/repo` as git, but no GitHub owner starts with `~`.
const GIT_SPEC =
  /^(?:git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|gist:|(?![.~])[^/:@#\s]+\/[^/:@#\s]+#)/i

/**
 * The `#semver:` range of a git spec, as `setGitAttrs` of npm-package-arg
 * reads it. It is the text after `semver:` up to the next `:`. It comes from
 * the part of the committish that starts with `semver:`. Parts split at `::`.
 * It is null for a git spec with no such part, and for a spec that is not a
 * git spec.
 * npm-package-arg also decodes percent escapes in the range. This function
 * does not, so the pass refuses such a range as one it cannot read.
 */
export const gitRangeOf = (spec: string): string | null => {
  const hash = spec.indexOf('#')
  if (hash < 0 || !GIT_SPEC.test(spec)) return null
  const part = spec
    .slice(hash + 1)
    .split('::')
    .find((each) => each.startsWith('semver:'))
  return part === undefined ? null : part.slice('semver:'.length).replace(/:.*$/, '')
}

const EDGE_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** The specs of the edges into the copy at `path`, from each entry that depends on it. */
export const specsInto = (lock: NpmLock, path: string): readonly unknown[] =>
  lock.entries.flatMap(([from, entry]) =>
    EDGE_BLOCKS.flatMap((block) => entriesOf(or(get(entry, block), {})))
      .filter(([key]) => resolveFrom(lock, from, key) === path)
      .map(([, spec]) => spec),
  )

/**
 * One edge from a copy of a parent into the package (#354). `spec` is the
 * declared spec: the `#semver:` range of a git spec, or the text. `range` is
 * true when the range rules can read it. An `npm:` alias spec is not a range
 * here, so the write pass refuses a child key beside it. `cver` is the
 * version of the child copy.
 */
export type ChildEdge = { readonly spec: string; readonly range: boolean; readonly cver: string }

/**
 * The edges into the package under the declared key `name`, from each copy
 * of `parent` in the lockfile.
 */
export const childEdgesOf = (lock: NpmLock, parent: string, name: string): readonly ChildEdge[] => {
  return lock.entries
    .filter(([path]) => lastSegment(path) === parent)
    .flatMap(([path, entry]) =>
      declarationsOf(entry).flatMap(([key, specifier]): ChildEdge[] => {
        if (key !== name || typeof specifier !== 'string') return []
        const git = gitRangeOf(specifier.trim())
        const spec = git ?? specifier
        const cver = [
          ...candidatesOf(path, key).map((each) =>
            or(get(lock.byKey.get(each) ?? null, 'version'), null),
          ),
          MISSING,
        ].find((each) => each !== null)
        return [
          {
            spec,
            range: LOOKS_RANGE.test(spec.trim()) && (git === null || rangeParseable(git)),
            cver: toText(cver),
          },
        ]
      }),
    )
}

/** One key of the override block, and its selector, or null for a bare key. */
export type SelectorKey = { readonly key: string; readonly selector: string | null }

/** The first key that an edge matches, and the keys before it that npm can also match. */
export type FirstKey = { readonly first: string | null; readonly unsure: readonly string[] }

/**
 * The first key of `own` that one edge spec matches, for a copy at `pver`,
 * and the unsure keys before it. A bare key ends the scan with no first key:
 * npm matches it for each edge.
 */
export const scanKeys = (own: readonly SelectorKey[], pver: string, spec: string): FirstKey => {
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
  /** The `#semver:` ranges of git edges into the copy that the range rules cannot read. */
  readonly unreadable: readonly string[]
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
    const quals = qualifiers.get(parent) ?? []
    const bare = or(get(overrides, parent), null)
    // The write pass removes a bare key that holds only pairs of this call on
    // the line, for a parent with qualifiers (#355). npm then matches the
    // next key, so the scan skips the bare key.
    const writeKeys = writeKeysOf(query.keysByParent, parent, pkg)
    const removed =
      quals.length > 0 &&
      isRecord(bare) &&
      Object.keys(bare).length > 0 &&
      Object.entries(bare).every(
        ([key, value]) => writeKeys.includes(key) && pinFloor(value) === target && target !== null,
      )
    const scanned = removed ? own.filter(({ selector }) => selector !== null) : own
    if (scanned.every(({ selector }) => selector === null)) continue
    /** The qualifier of the normal write for a copy on the line. */
    const intendedOf = (version: string): string | undefined =>
      quals.length === 0 ? '' : quals.find((each) => admits(version, each))
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
        // A git edge with a `#semver:` range is read as that range.
        const edges = specsInto(lock, path).map((spec) => {
          const text = toText(spec)
          return { text, git: gitRangeOf(text.trim()) }
        })
        const specs = edges.map(({ text, git }) => git ?? text)
        const readable = specs.filter((spec) => LOOKS_RANGE.test(spec.trim()))
        const found = readable.map((spec) => scanKeys(scanned, version, spec))
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
          unreadable: edges.flatMap(({ git }) =>
            git === null || rangeParseable(git) ? [] : [git],
          ),
        }
      })
    const qualified = own.flatMap(({ key, selector }) => (selector === null ? [] : [key]))
    const ranges = unique(copies.flatMap(({ unreadable }) => unreadable))
    if (ranges.length > 0) {
      return failed(
        `apply_constraint: cannot scope '${pkg}': a git edge into a copy of its parent has a '#semver:' range that the range rules cannot read, beside pre-existing version-qualified override keys for that parent: ${render([{ parent, keys: qualified, ranges }], null)}. npm matches a key for such an edge only through that range, so neither a constraint inside a key nor a new key after it can be shown to take effect (issue #359), so nothing was written; reconcile the existing override by hand.`,
      )
    }
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
        `apply_constraint: cannot scope '${pkg}': npm can match a pre-existing version-qualified override key for its parent through an edge into a copy, and the lockfile cannot show which key it matches: ${render(detail, null)}. So neither a constraint inside a key nor a new key after it can be shown to take effect (issue #333), so nothing was written; reconcile the existing override by hand.`,
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
    keys.set(parent, {
      keys: qualified.filter((key) => served.includes(key)),
      rest,
      supersedeBare: !rest,
    })
    // A qualifier that reaches no unserved copy would write a key with no effect.
    const kept = quals.filter((each) => unserved.some(({ intended }) => intended === each))
    if (kept.length === 0) qualifiers.delete(parent)
    else qualifiers.set(parent, kept)
  }
  return { keys, qualifiers }
}
