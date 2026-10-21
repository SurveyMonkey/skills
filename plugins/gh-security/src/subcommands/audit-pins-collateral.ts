// What `test-pin` reads from the two whole-tree maps: whether the two verbs
// agree about the tested package, and which other packages moved. These are
// ports of the jq programs in `cmd_test_pin` of
// `audit-pins-driver.sh` (deleted in #236), as pure functions.
//
// A large collateral fan-out is checked, not sampled, unless it is a
// platform-binary family (audit-driver.md). Each condition of the family is
// checked, and none is assumed: two or more members, each name past the
// shared prefix ends in an `<os>-<arch>` pair with only libc or ABI tokens
// after it, one baseline and one new version for all, and no member of the
// family elsewhere in the tree that did not move.
//
// This file ships. It imports nothing outside the plugin.

import { equal, split } from '../adapters/node/jq-json.ts'
import { compareJq, uniqueJq } from '../jq.ts'
import type { JsonObject } from '../lib/envelope.ts'
import type { Resolutions } from './audit-pins-common.ts'

/** jq's `a - b` on two lists: each entry of `a` that is in no place of `b`. */
export const minus = <T>(a: readonly T[], b: readonly T[]): T[] =>
  a.filter((each) => !b.some((other) => equal(each, other)))

/** The versions of one package in a map, sorted and each once. None is an empty list. */
const versionsIn = (resolutions: Resolutions, pkg: string): string[] =>
  uniqueJq(Object.hasOwn(resolutions, pkg) ? (resolutions[pkg] as readonly string[]) : [])

/**
 * How the map and `resolved_versions` disagree about the tested package
 * after the removal, or null when they agree. Both are compared as sorted
 * lists of versions, each once, so one version at two paths is not a
 * disagreement.
 */
export const disagreementOf = (
  now: Resolutions,
  pkg: string,
  resolved: readonly string[],
): JsonObject | null => {
  const map = versionsIn(now, pkg)
  if (equal(map, resolved)) return null
  const common = { map, resolved_versions: [...resolved] }
  if (map.length === 0 && resolved.length > 0) {
    return {
      shape: 'alias-key',
      ...common,
      detail:
        'this pin is keyed on an npm: alias of the package named in its value, so the map holds ' +
        'that copy under the real package name \u2014 the name an advisory query needs \u2014 while ' +
        'resolved_versions answers under both. The map therefore has no entry for the key this pin ' +
        'uses, and the two views cannot be compared under one name (#46).',
    }
  }
  if (map.length > 0 && resolved.length > 0 && minus(map, resolved).length === 0) {
    return {
      shape: 'shared-install-key',
      ...common,
      detail:
        `the name ${pkg} is carried by two different packages in this tree: one entry installs a ` +
        `package under this key while a dependency pulls the real ${pkg}. resolved_versions ` +
        'answers under both senses of the name and merges them; the map keeps each under what it ' +
        'resolves to. The adapter cannot tell which sense the name was meant in, and neither can ' +
        'the key this pin uses (#48; the alias exception in ADR 001).',
    }
  }
  return {
    shape: 'parser-disagreement',
    ...common,
    detail:
      'resolution_map and resolved_versions disagree about this package after normalizing both to ' +
      'sorted unique version strings. One of the two parsers is wrong; no winner is picked here.',
  }
}

const OS = [
  'android',
  'darwin',
  'freebsd',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
  'win',
  'aix',
]
const ARCH = [
  'arm',
  'arm64',
  'ia32',
  'x64',
  'x86',
  'x86_64',
  'mips64el',
  'ppc64',
  'riscv64',
  's390x',
  'loong64',
  'wasm32',
  'universal',
]
const ABI = ['gnu', 'musl', 'gnueabihf', 'eabi', 'eabihf', 'msvc', 'static']

/** `famkey`: the scope of a scoped name, the name up to its first `-`, or the whole name. */
export const familyKey = (name: string): string => {
  if (name.startsWith('@')) return `${name.split('/')[0]}/`
  const dash = name.indexOf('-')
  return dash === -1 ? name : name.slice(0, dash + 1)
}

/** `platform_tail`: the name past `key` ends in an `<os>-<arch>` pair, then ABI tokens only. */
export const platformTail = (name: string, key: string): boolean => {
  const tokens = split(name.slice(key.length), '-')
  return tokens.some(
    (token, index) =>
      index < tokens.length - 1 &&
      OS.includes(token) &&
      ARCH.includes(tokens[index + 1] as string) &&
      tokens.slice(index + 2).every((each) => ABI.includes(each)),
  )
}

/** One package that moved, before the family rule. */
export interface Move {
  readonly package: string
  readonly baseline: string[]
  readonly without_pin: string[]
  readonly newly_admitted: string[]
}

/**
 * Each package whose versions differ between the two maps, sorted by
 * package. `together` reads this list for a set of removals, with no family
 * rule.
 */
export const movesBetween = (base: Resolutions, now: Resolutions): Move[] =>
  uniqueJq([...Object.keys(base), ...Object.keys(now)])
    .map((name) => ({ name, before: versionsIn(base, name), after: versionsIn(now, name) }))
    .filter(({ before, after }) => !equal(before, after))
    .map(({ name, before, after }) => ({
      package: name,
      baseline: before,
      without_pin: after,
      newly_admitted: minus(after, before),
    }))

const byPackage = (a: { readonly package?: unknown }, b: { readonly package?: unknown }): number =>
  compareJq(a.package, b.package)

/**
 * Each other package whose versions differ between the two maps, with the
 * family rule applied, sorted by package. The second answer is each family
 * that was sampled, once, sorted by its key.
 */
export const collateralOf = (
  base: Resolutions,
  now: Resolutions,
  pkg: string,
): { readonly changes: JsonObject[]; readonly families: JsonObject[] } => {
  const all = uniqueJq([...Object.keys(base), ...Object.keys(now)])
  const moves = movesBetween(base, now).filter((move) => move.package !== pkg)
  const groups = new Map<string, Move[]>()
  for (const move of moves) {
    const key = familyKey(move.package)
    groups.set(key, [...(groups.get(key) ?? []), move])
  }
  const changes: JsonObject[] = []
  const families = new Map<string, JsonObject>()
  for (const [key, members] of groups) {
    const inTree = all.filter((name) => familyKey(name) === key).length
    const sampled =
      members.length >= 2 &&
      members.every((member) => platformTail(member.package, key)) &&
      uniqueJq(members.map((member) => member.baseline)).length === 1 &&
      uniqueJq(members.map((member) => member.without_pin)).length === 1 &&
      inTree === members.length
    if (!sampled) {
      changes.push(
        ...members.map((member) => ({
          ...member,
          judged: true,
          represented_by: null,
          family: null,
        })),
      )
      continue
    }
    const ordered = [...members].sort(byPackage)
    const sample = (ordered[0] as Move).package
    const family = {
      key,
      size: ordered.length,
      members: ordered.map((member) => member.package),
      sample,
      shared_version: (ordered[0] as Move).without_pin.join(', '),
    }
    families.set(key, family)
    changes.push(
      ...ordered.map((member) => ({
        ...member,
        judged: member.package === sample,
        represented_by: member.package === sample ? null : sample,
        family,
      })),
    )
  }
  return {
    changes: changes.sort(byPackage),
    families: [...families.entries()]
      .sort(([a], [b]) => compareJq(a, b))
      .map(([, family]) => family),
  }
}
