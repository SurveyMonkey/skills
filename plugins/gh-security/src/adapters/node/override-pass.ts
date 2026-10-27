// The write pass of `apply_constraint` (#222), ported from the main jq pass
// of `verb_apply_constraint` in node.sh. The jq there is the specification.
//
// The pass changes one manifest document in memory, and gives the entries
// that it wrote with the same keys and values (#48). Each write goes
// through `putOverride`, `putRoot`, `putNested`, `putRuleNested` or
// `tightenRule`. So nothing lands in the manifest without an entry in
// `written`.
//
//   - A direct constraint retargets a declaration of the root in
//     `dependencies` or `devDependencies`, and keeps its form: an exact pin
//     stays exact, `^` stays `^`, and an `npm:` alias keeps its protocol and
//     the package that it names. For a key with no such declaration, it
//     writes a bare override.
//   - A scoped constraint writes a key for each declared key of each parent:
//     `parent>pkg` for pnpm, `parent/pkg` for yarn, and a nested object for
//     npm. A pnpm or npm parent with qualifiers gets one key for each
//     qualifier, from `parent-qualifiers.ts`. An npm parent that a rule
//     places takes the nested write inside each rule that places it (#147).
//     A version-qualified npm parent key that npm matches first for a copy
//     takes the write for that copy, as a rule does (#333).
//   - Inside each npm target key, a child key `<pkg>@<selector>` that npm
//     matches first for the copy takes the write (#354). A plain key after
//     it has no effect. The pass refuses a child key that npm can match
//     when the lockfile cannot show which key npm matches. It also refuses
//     a matched child key whose value is not a text on the line.
//   - A bare npm parent key can hold an entry that this call does not
//     write, or no entry. That key stays before the new qualified keys, so
//     they have no effect. The pass refuses it (#355).
//   - `tightenBare` moves each bare key that covers the major line of the
//     range, and the rule pins of `tightenedRules` (#104, #147). With
//     nothing to move, it writes the plain key.
//   - An aliased parent declaration gets its key, with the value
//     `npm:<pkg>@<range>` (#46).
//
// The override container is made only when an entry goes into it. So a
// direct update leaves no empty block in a manifest that had none.
//
// This file ships. It imports nothing outside the plugin.

import { type Failure, failed } from '../../lib/envelope.ts'
import { rangeFloorMajor } from '../../semver/ranges.ts'
import type { ApplyConstraintAnswer, PinValue } from '../adapter.ts'
import type { NodeDetection } from './detect.ts'
import {
  entriesOf,
  equal,
  get,
  getPath,
  has,
  or,
  render,
  setPath,
  split,
  startsWith,
  test,
  withKey,
  withoutKey,
} from './jq-json.ts'
import { stripSelector, yarnKey } from './list-pins.ts'
import { isRecord } from './manifest.ts'
import type { Placement } from './npm-placement.ts'
import {
  type ChildEdge,
  type FirstKey,
  type QualifiedKeys,
  type SelectorKey,
  scanKeys,
} from './npm-qualified-keys.ts'
import { pinFloor, type Qualifiers, writeKeysOf } from './parent-qualifiers.ts'

type Written = ApplyConstraintAnswer['written'][number]

type Superseded = ApplyConstraintAnswer['superseded_keys'][number]

/** The inputs of the pass. */
export type PassQuery = {
  readonly location: NodeDetection['override_location']
  readonly pkg: string
  readonly range: string
  readonly parents: readonly string[]
  readonly tighten: boolean
  /** The keys that the root declares the package under. */
  readonly rootKeys: readonly string[]
  /** The keys that each parent declares the package under. */
  readonly keysByParent: ReadonlyMap<string, readonly string[]>
  readonly qualifiers: Qualifiers
  readonly placements: ReadonlyMap<string, Placement>
  /** The qualified npm parent keys that npm matches first for a copy (#333). */
  readonly qualifiedKeys: ReadonlyMap<string, QualifiedKeys>
  /** The rule paths that a tighten moves. */
  readonly tightened: readonly (readonly string[])[]
  /** The edges into the package from the copies of a parent, under a declared key (#354). */
  readonly childEdges: (parent: string, key: string) => readonly ChildEdge[]
}

/**
 * What the pass gives: the new manifest, and the entries it wrote and
 * removed. A refusal comes with the manifest as it was and no entries. The
 * caller writes no file for it.
 */
export type PassResult = {
  readonly manifest: unknown
  readonly written: readonly Written[]
  readonly superseded: readonly Superseded[]
  readonly refusal: Failure | null
}

/** The stop of the pass for a refusal. `writePass` catches it. */
class Refused extends Error {
  readonly failure: Failure
  constructor(failure: Failure) {
    super(failure.error)
    this.failure = failure
  }
}

/**
 * `.a.b[key] = value`, where each container on the way is made when it is
 * null or false (`//= {}`).
 */
const setUnder = (target: unknown, path: readonly string[], value: unknown): unknown => {
  const [head, ...rest] = path as [string, ...string[]]
  if (rest.length === 0) return withKey(target, head, value)
  return withKey(target, head, setUnder(or(get(target, head), {}), rest, value))
}

/** The path of the override container of a location. */
const CONTAINER: Readonly<Record<NodeDetection['override_location'], readonly string[]>> = {
  'pnpm.overrides': ['pnpm', 'overrides'],
  resolutions: ['resolutions'],
  overrides: ['overrides'],
}

/** jq's `+` of a text and a value: null adds nothing. */
const plus = (text: string, value: string | null): string => text + (value ?? '')

/**
 * The write pass over `input`. It throws where jq stops. A refusal comes
 * back in `refusal`, not as a throw.
 */
export const writePass = (input: unknown, query: PassQuery): PassResult => {
  try {
    return passOver(input, query)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    return { manifest: input, written: [], superseded: [], refusal: error.failure }
  }
}

const passOver = (input: unknown, query: PassQuery): PassResult => {
  const { location, pkg, range, qualifiers, placements } = query
  let manifest = input
  const written: Written[] = []
  const superseded: Superseded[] = []
  const alias = `npm:${pkg}@${range}`
  const target = rangeFloorMajor(range)

  /** The pin value under the key `key` is on the major line of the range. */
  const onLine = (value: unknown, key: string): boolean =>
    target !== null && pinFloor(value, pkg, key) === target

  const note = (parent: string | null, path: readonly string[], value: unknown): void => {
    written.push({ parent, path, value: value as PinValue })
  }

  /**
   * `spec`: the range in the form of the declaration that it replaces. An
   * exact pin gets the floor, `^` and `~` keep their operator, and any
   * other form gets the range. The floor is null for a range with nothing
   * after `>=`, as in jq.
   */
  const spec = (current: unknown): string | null => {
    const lower = split(range.replace(/^>=[ \t\n\v\f\r]*/, ''), ' ')[0] ?? null
    if (current === null) return range
    if (test(current, /^[0-9]/)) return lower
    if (startsWith(current, '^')) return plus('^', lower)
    if (startsWith(current, '~')) return plus('~', lower)
    return range
  }

  /** `retarget`: as `spec`, and an `npm:` declaration keeps its protocol and its package. */
  const retarget = (existing: unknown): string | null => {
    if (typeof existing !== 'string' || !existing.startsWith('npm:')) return spec(existing)
    const rest = existing.slice(4)
    const at = rest.lastIndexOf('@')
    const [name, current] = at <= 0 ? [rest, null] : [rest.slice(0, at), rest.slice(at + 1)]
    return plus(`npm:${name}@`, spec(current))
  }

  const putOverride = (parent: string | null, key: string, value: unknown): void => {
    const path = [...CONTAINER[location], key]
    manifest = setUnder(manifest, path, value)
    note(parent, path, value)
  }

  const putRoot = (key: string): void => {
    for (const block of ['dependencies', 'devDependencies']) {
      if (has(or(get(manifest, block), {}), key)) {
        const value = retarget(getPath(manifest, [block, key]))
        manifest = setPath(manifest, [block, key], value)
        note(null, [block, key], value)
        return
      }
    }
    putOverride(null, key, key === pkg ? range : alias)
  }

  /**
   * The child keys of `key` in the object at `path` that take the write,
   * and if the plain key takes it too (#354). npm uses the first child key
   * whose selector matches the edge into the copy. A plain key matches
   * each edge. The scan reads each edge from a copy of the parent, as
   * `scanKeys` reads an edge into a parent. A child key that takes the
   * write must hold a text on the line of the range. Any other child key
   * that npm can match stops the pass with a refusal. So does a parent
   * with no edge that the lockfile can show.
   */
  const childWrite = (
    parent: string,
    path: readonly string[],
    key: string,
  ): { readonly into: readonly string[]; readonly plain: boolean } => {
    const container = getPath(get(manifest, 'overrides'), path)
    const own = isRecord(container)
      ? Object.keys(container).flatMap((each) => {
          const { name, selector } = stripSelector(each)
          return name === key ? [{ key: each, selector }] : []
        })
      : []
    const plainAt = own.findIndex(({ selector }) => selector === null)
    const before = plainAt < 0 ? own : own.slice(0, plainAt)
    if (before.length === 0) return { into: [], plain: true }
    // An edge that the range rules cannot read, or no edge at all, shows no key.
    const unread: FirstKey = { first: null, unsure: [(before[0] as SelectorKey).key] }
    const edges = query.childEdges(parent, key)
    const scans =
      edges.length === 0
        ? [unread]
        : edges.map((edge) => (edge.range ? scanKeys(own, edge.cver, edge.spec) : unread))
    const into = new Set<string>()
    let plain = false
    for (const { first, unsure } of scans) {
      if (unsure.length > 0) {
        const detail = [{ parent, path, key: unsure[0] }]
        throw new Refused(
          failed(
            `apply_constraint: cannot scope '${pkg}': npm can match a pre-existing version-qualified child key for the package inside the override key of its parent through an edge into the copy, and the lockfile cannot show which key it matches: ${render(detail, null)}. So neither a constraint inside that child key nor a plain key beside it can be shown to take effect (issue #354), so nothing was written; reconcile the existing override by hand.`,
          ),
        )
      }
      if (first === null) plain = true
      else into.add(first)
    }
    for (const child of into) {
      const current = (container as Readonly<Record<string, unknown>>)[child]
      if (typeof current === 'string' && onLine(current, key)) continue
      const detail = [{ parent, path, key: child, value: current }]
      throw new Refused(
        failed(
          `apply_constraint: a pre-existing version-qualified child key for '${pkg}' inside the override key of its parent is the first key that npm matches for the copy, and its value is not a text on the same major line: ${render(detail, null)}. A plain key beside it has no effect, and overwriting the value would strip that line's protection (issues #354 and #132), so nothing was written; reconcile the existing override by hand.`,
        ),
      )
    }
    return { into: [...into], plain }
  }

  /** Write `value` into each child key of `into` in the object at `path`, and report a changed value. */
  const putChildren = (
    parent: string,
    path: readonly string[],
    into: readonly string[],
    value: string,
  ): void => {
    for (const child of into) {
      const previous = getPath(get(manifest, 'overrides'), [...path, child])
      if (!equal(previous, value)) {
        superseded.push({
          parent,
          path: ['overrides', ...path, child],
          value: previous as PinValue,
        })
      }
      manifest = withKey(
        manifest,
        'overrides',
        setPath(get(manifest, 'overrides'), [...path, child], value),
      )
      note(parent, ['overrides', ...path, child], value)
    }
  }

  /** One nested npm entry, under the bare parent key or a qualified `parent@<sel>` key. */
  const putNested = (parent: string, outer: string, key: string, value: string): void => {
    const { into, plain } = childWrite(parent, [outer], key)
    putChildren(parent, [outer], into, value)
    if (!plain) return
    const overrides = or(get(manifest, 'overrides'), {})
    const current = or(get(overrides, outer), {})
    const base = typeof current === 'string' ? {} : current
    if (!isRecord(base)) throw new Error(`cannot add to the override "${outer}"`)
    manifest = withKey(manifest, 'overrides', withKey(overrides, outer, withKey(base, key, value)))
    note(parent, ['overrides', outer, key], value)
  }

  /**
   * The nested write inside a rule that places the parent (#147). A rule
   * with a value that is not an object keeps it under the `"."` key, and
   * that entry is marked `preserved`: it quotes a value that was there. A
   * different pin for the package inside the rule is superseded, and
   * reported. A pin on another line was refused before this pass. A child
   * key with a selector that npm matches first takes the write (#354).
   */
  const putRuleNested = (
    parent: string,
    rule: readonly string[],
    key: string,
    value: string,
  ): void => {
    const { into, plain } = childWrite(parent, rule, key)
    putChildren(parent, rule, into, value)
    if (!plain) return
    let overrides = get(manifest, 'overrides')
    const current = getPath(overrides, rule)
    if (!isRecord(current)) {
      overrides = setPath(overrides, rule, { '.': current })
      written.push({
        parent,
        path: ['overrides', ...rule, '.'],
        value: current as PinValue,
        preserved: true,
      })
    } else if (Object.hasOwn(current, key) && !equal(current[key], value)) {
      superseded.push({
        parent,
        path: ['overrides', ...rule, key],
        value: current[key] as PinValue,
      })
    }
    manifest = withKey(manifest, 'overrides', setPath(overrides, [...rule, key], value))
    note(parent, ['overrides', ...rule, key], value)
  }

  /** `--tighten-bare` on a placed package: the pin of the rule moves, in place (#147). */
  const tightenRule = (rule: readonly string[]): void => {
    const overrides = get(manifest, 'overrides')
    const current = getPath(overrides, rule)
    const path = isRecord(current) ? [...rule, '.'] : rule
    const value = spec(isRecord(current) ? get(current, '.') : current)
    manifest = withKey(manifest, 'overrides', setPath(overrides, path, value))
    note(null, ['overrides', ...path], value)
  }

  /**
   * Remove the pair `overrides[parent][key]`, and the parent key when it
   * holds nothing more, and report the pair as superseded. Only an object
   * that holds the key is a pair.
   */
  const supersedePair = (parent: string, key: string): void => {
    const overrides = get(manifest, 'overrides')
    const pair = get(overrides, parent)
    if (!isRecord(pair) || !Object.hasOwn(pair, key)) return
    superseded.push({ parent, path: ['overrides', parent, key], value: pair[key] as PinValue })
    const rest = withoutKey(pair, key) as Readonly<Record<string, unknown>>
    const next =
      Object.keys(rest).length === 0
        ? withoutKey(overrides, parent)
        : withKey(overrides, parent, rest)
    manifest = withKey(manifest, 'overrides', next)
  }

  /** The scoped entry of one parent, in the syntax of the location. */
  const putScoped = (parent: string, key: string, value: string): void => {
    const qualified = qualifiers.get(parent) ?? []
    if (location === 'pnpm.overrides') {
      if (qualified.length === 0) putOverride(parent, `${parent}>${key}`, value)
      for (const qualifier of qualified) {
        putOverride(parent, `${parent}@${qualifier}>${key}`, value)
      }
      return
    }
    if (location === 'resolutions') {
      putOverride(parent, `${parent}/${key}`, value)
      return
    }
    const placement = placements.get(parent)
    if (placement !== undefined) {
      // A pair that a run before #147 wrote matches no copy when each copy
      // is placed. A pair on another line was refused before this pass.
      if (!placement.has_normal) supersedePair(parent, key)
      for (const rule of placement.rulepaths) putRuleNested(parent, rule, key, value)
      if (!placement.has_normal_online) return
    }
    const existing = query.qualifiedKeys.get(parent)
    if (existing !== undefined) {
      // A bare pair after the keys has no effect when they serve each copy on
      // the line. A pair on another line stays (#355).
      if (
        existing.supersedeBare &&
        onLine(get(get(get(manifest, 'overrides'), parent), key), key)
      ) {
        supersedePair(parent, key)
      }
      for (const outer of existing.keys) putRuleNested(parent, [outer], key, value)
      if (!existing.rest) return
    }
    if (qualified.length === 0) {
      putNested(parent, parent, key, value)
      return
    }
    // npm matches a bare key for this parent before the qualified keys after
    // it, so they are inert. Only a pair on the same line gets here. The
    // pass removes each pair of the call. A bare key that holds any other
    // entry stays, and so does an empty bare key. npm reads a value that is
    // not an object as a key with no entry (`lib/override-set.js:9-30`). So
    // the pass refuses each of these (#355).
    const bare = get(or(get(manifest, 'overrides'), {}), parent)
    const writeKeys = writeKeysOf(query.keysByParent, parent, pkg)
    const others = isRecord(bare)
      ? Object.keys(bare).filter((each) => !writeKeys.includes(each))
      : []
    if (bare !== null && (!isRecord(bare) || others.length > 0 || Object.keys(bare).length === 0)) {
      const detail = [{ parent, keys: others }]
      throw new Refused(
        failed(
          `apply_constraint: cannot scope '${pkg}': the bare override key of a parent that this call must version-qualify stays after the write, as it holds no entry or an entry that this call does not write: ${render(detail, null)}. npm matches that bare key before each qualified key after it, so such a key has no effect, and a key before it would drop those entries for the copies that it matches (issue #355), so nothing was written; reconcile the existing override by hand.`,
        ),
      )
    }
    supersedePair(parent, key)
    for (const qualifier of qualified) {
      putNested(parent, `${parent}@${qualifier}`, key, value)
    }
  }

  /**
   * `covering_bare_keys`: each bare key of the block that pins the package
   * on the major line of the range. That is the plain key, and each
   * `pkg@<selector>` key whose selector has the same floor major. A pnpm
   * key with `>` and a yarn key with a parent pin another package.
   */
  const coveringKeys = (): string[] => {
    return entriesOf(or(getPath(manifest, CONTAINER[location]), {}))
      .filter(([, value]) => typeof value === 'string')
      .map(([key]) => key)
      .filter((key) => {
        if (location === 'pnpm.overrides') return !key.includes('>')
        if (location === 'resolutions') return yarnKey(key).parents.length === 0
        return true
      })
      .filter((key) => {
        if (key === pkg) return true
        if (!key.startsWith(`${pkg}@`)) return false
        const { name, selector } = stripSelector(key)
        return name === pkg && target !== null && rangeFloorMajor(selector as string) === target
      })
      .sort((a, b) => Number(a > b) - Number(a < b))
  }

  if (query.tighten) {
    const covering = coveringKeys()
    if (covering.length === 0 && query.tightened.length === 0) putOverride(null, pkg, range)
    for (const key of covering) putOverride(null, key, range)
    for (const rule of query.tightened) tightenRule(rule)
    // A placement shadows only its placed copies. The normal copies need
    // the plain key too (#153).
    if (
      covering.length === 0 &&
      query.tightened.length > 0 &&
      placements.get(pkg)?.has_normal === true
    ) {
      putOverride(null, pkg, range)
    }
  } else if (query.parents.length === 0) {
    if (query.rootKeys.length === 0) putOverride(null, pkg, range)
    for (const key of query.rootKeys) putRoot(key)
  } else {
    for (const parent of query.parents) {
      for (const key of writeKeysOf(query.keysByParent, parent, pkg)) {
        putScoped(parent, key, key === pkg ? range : alias)
      }
    }
  }
  return { manifest, written, superseded, refusal: null }
}
