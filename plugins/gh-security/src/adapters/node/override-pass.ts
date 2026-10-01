// The write pass of `apply_constraint` (#222), ported from the main jq pass
// of `verb_apply_constraint` in node.sh. The jq there is the specification.
//
// The pass changes one manifest document in memory, and gives the entries
// that it wrote with the same keys and values (#48). Each write goes
// through `putOverride`, `putRoot`, `putNested`, `putRuleNested` or
// `tightenRule`. So nothing lands in the manifest without an entry in
// `written`.
//
//   - A direct constraint retargets the declaration of the root, and keeps
//     its form: an exact pin stays exact, `^` stays `^`, and an `npm:`
//     alias keeps its protocol and the package that it names. With no
//     declaration, it writes a bare override.
//   - A scoped constraint writes one key for each parent: `parent>pkg` for
//     pnpm, `parent/pkg` for yarn, and a nested object for npm. Each pnpm
//     and npm key carries the qualifiers of `parent-qualifiers.ts`. An npm
//     parent that a rule places takes the nested write inside each rule
//     that places it (#147).
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
import type { Qualifiers } from './parent-qualifiers.ts'

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
  /** The rule paths that a tighten moves. */
  readonly tightened: readonly (readonly string[])[]
}

/** What the pass gives: the new manifest, and the entries it wrote and removed. */
export type PassResult = {
  readonly manifest: unknown
  readonly written: readonly Written[]
  readonly superseded: readonly Superseded[]
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

/** The write pass over `manifest`. It throws where jq stops. */
export const writePass = (input: unknown, query: PassQuery): PassResult => {
  const { location, pkg, range, qualifiers, placements } = query
  let manifest = input
  const written: Written[] = []
  const superseded: Superseded[] = []
  const alias = `npm:${pkg}@${range}`

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

  /** One nested npm entry, under the bare parent key or a qualified `parent@<sel>` key. */
  const putNested = (parent: string, outer: string, key: string, value: string): void => {
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
   * reported. A pin on another line was refused before this pass.
   */
  const putRuleNested = (
    parent: string,
    rule: readonly string[],
    key: string,
    value: string,
  ): void => {
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
    if (qualified.length === 0) {
      putNested(parent, parent, key, value)
      return
    }
    // npm matches a bare pair for this parent first, so beside it the
    // qualified keys are inert. Only a pair on the same line gets here.
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
    const target = rangeFloorMajor(range)
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
      const keys = query.keysByParent.get(parent) ?? []
      for (const key of keys.length === 0 ? [pkg] : keys) {
        putScoped(parent, key, key === pkg ? range : alias)
      }
    }
  }
  return { manifest, written, superseded }
}
