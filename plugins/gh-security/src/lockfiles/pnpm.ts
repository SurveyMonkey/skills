// The pnpm `pnpm-lock.yaml` reader, ported from node.sh (#220, RFC 002):
// `PNPM_LOCATOR_AWK` behind `pnpm_versions` and `pnpm_resolution_pairs`, and
// the snapshots scan behind `pnpm_parents`. The awk there is the
// specification. This reads only the lines those programs read. It is not a
// YAML parser.
//
// This file ships. It imports nothing outside the plugin.

import {
  before,
  type Coverage,
  groupResolutions,
  guarded,
  type Parent,
  type ResolutionMap,
  type ResolvedVersions,
  uniqueCopies,
  uniqueParents,
} from './shared.ts'

/** What a `packages:` key resolves to: the three answers of `pnpm_split`. */
type Reading =
  | { readonly kind: 'registry'; readonly name: string; readonly version: string }
  | { readonly kind: 'local' | 'unreadable' }

const LOCAL: Reading = { kind: 'local' }
const UNREADABLE: Reading = { kind: 'unreadable' }

// Where a version would be, a local or remote target has a protocol (#48).
const LOCAL_PROTOCOL =
  /^(link|file|workspace|portal|catalog|exec|git|git[+]ssh|git[+]http|git[+]https|http|https|ssh|github|gitlab|bitbucket):/

const TOP_LEVEL = /^[a-zA-Z]/
const ENTRY_KEY = /^ {2}[^ ]/

const lines = (text: string): string[] => text.split('\n')

/** One candidate split: the name before `at`, the version or protocol after it. */
const readAt = (key: string, at: number): Reading => {
  const name = key.slice(0, at)
  const version = key.slice(at + 1)
  if (/^[0-9]/.test(version)) return { kind: 'registry', name, version }
  return LOCAL_PROTOCOL.test(version) ? LOCAL : UNREADABLE
}

/**
 * Split on the first `@` after the first character. This is the separator
 * even for a git URL that has its own `@` (#49). If that split reads nothing,
 * try the last `@`. A scoped lockfileVersion 6 key starts `/@scope/`, so its
 * first `@` is part of the name.
 */
const readKey = (key: string): Reading =>
  [...new Set([key.indexOf('@', 1), key.lastIndexOf('@')])]
    .filter((at) => at >= 1)
    .reduce<Reading>(
      (reading, at) => (reading.kind === 'unreadable' ? readAt(key, at) : reading),
      UNREADABLE,
    )

/** Each `packages:` key, without the peer suffix, the colon and the quotes. */
const packageKeys = (text: string): string[] => {
  const keys: string[] = []
  let inPackages = false
  for (const line of lines(text)) {
    if (line.startsWith('packages:')) {
      inPackages = true
      continue
    }
    if (TOP_LEVEL.test(line)) inPackages = false
    if (inPackages && ENTRY_KEY.test(line)) {
      keys.push(before(line.slice(2), '(').replace(/:$/, '').replaceAll("'", ''))
    }
  }
  return keys
}

type Row = { readonly name: string; readonly version: string }

const read = (text: string): { coverage: Coverage; rows: Row[] } => {
  const readings = packageKeys(text).map(readKey)
  const coverage = guarded('pnpm', {
    entries: readings.length,
    expected: readings.length,
    read: readings.filter(({ kind }) => kind !== 'unreadable').length,
  })
  return {
    coverage,
    rows: readings.flatMap((reading) => (reading.kind === 'registry' ? [reading] : [])),
  }
}

/** Every copy of `pkg`. A pnpm key has no alias name. */
export const resolvedVersions = (text: string, pkg: string): ResolvedVersions => {
  const { coverage, rows } = read(text)
  const copies = rows
    .filter(({ name }) => name === pkg)
    .map(({ name, version }) => ({ version, path: `${name}@${version}` }))
  return { coverage, copies: uniqueCopies(copies) }
}

/** Every package at a registry version. */
export const resolutionMap = (text: string): ResolutionMap => {
  const { coverage, rows } = read(text)
  return {
    coverage,
    resolutions: groupResolutions(rows.map(({ name, version }) => ({ package: name, version }))),
  }
}

/**
 * The parent that a `snapshots:` key names. The name ends at the first `@`
 * after the first character, not at the last. A git key such as
 * `debug@git+ssh://git@host/...` has an `@` in its URL (#50).
 */
const parentOf = (key: string): Parent => {
  const at = `${key}@`.indexOf('@', 1)
  const version = key.slice(at + 1)
  return { name: key.slice(0, at), version: /^[0-9]/.test(version) ? version : null }
}

/**
 * Each snapshot whose `dependencies:` or `optionalDependencies:` block names
 * `pkg`. An optional edge is a declaration an override can reach (#160).
 * Only `snapshots:` is read: a lockfileVersion 6 lockfile has none, and its
 * `packages:` keys are no parents (#103).
 */
export const parents = (text: string, pkg: string): readonly Parent[] => {
  const found: Parent[] = []
  let inSnapshots = false
  let parent: Parent | null = null
  let inEdges = false
  for (const line of lines(text)) {
    if (line.startsWith('snapshots:')) {
      inSnapshots = true
      continue
    }
    if (TOP_LEVEL.test(line)) inSnapshots = false
    if (!inSnapshots) continue
    if (ENTRY_KEY.test(line)) {
      const key = line
        .slice(2)
        .replace(/:[ \t\n\v\f\r]*(\{\})?[ \t\n\v\f\r]*$/, '')
        .replaceAll("'", '')
      const named = parentOf(before(key, '('))
      parent = named.name === '' ? null : named
      inEdges = false
      continue
    }
    if (/^ {4}(dependencies|optionalDependencies):/.test(line)) {
      inEdges = true
      continue
    }
    if (/^ {4}[a-zA-Z]/.test(line)) inEdges = false
    if (parent !== null && inEdges && /^ {6}/.test(line)) {
      const edge = line.slice(6)
      if (edge.includes(':') && before(edge, ':').replaceAll("'", '') === pkg) found.push(parent)
    }
  }
  return uniqueParents(found)
}
