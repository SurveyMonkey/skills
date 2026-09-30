// The pnpm `pnpm-lock.yaml` reader, ported from node.sh (#220, RFC 002):
// `PNPM_LOCATOR_AWK` behind `pnpm_versions` and `pnpm_resolution_pairs`,
// `pnpm_scan_rows` behind `pnpm_parents`, `pnpm_copy_rows` and `why`,
// `pnpm_root_child_major` and `pnpm_lockfile_v9` (#221). The awk there is the
// specification. This reads only the lines those programs read. It is not a
// YAML parser.
//
// This file ships. It imports nothing outside the plugin.

import {
  before,
  type Copy,
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

/** The dependency blocks of an importer. */
type ImporterKind = 'dependencies' | 'devDependencies' | 'optionalDependencies'

/** An importer (the root `.` or a workspace package) that declares the package. */
type Importer = { readonly path: string; readonly kind: ImporterKind }

/** A `dependencies:` or `optionalDependencies:` edge from a snapshot to the package. */
export type Edge = {
  readonly parent: Parent
  /**
   * The text after the `@` of the parent key, or `null` when it is empty.
   * `parent.version` holds only a version that starts with a digit. This
   * also holds a `file:` or a URL version, as `pnpm_copy_rows` does.
   */
  readonly parentVersion: string | null
  /** The version that the edge resolves, or `null` when it does not start with a digit. */
  readonly version: string | null
  readonly kind: 'dependencies' | 'optionalDependencies'
  /** The snapshot key of the parent has a `(pkg@` peer suffix: pnpm resolved the package as a peer. */
  readonly suffixed: boolean
}

/** What `pnpm_scan_rows` finds for one package. */
type Scan = {
  readonly importers: readonly Importer[]
  /** Each snapshot whose key has a `(pkg@` peer suffix, in the order of the file. */
  readonly suffixes: readonly Parent[]
  readonly edges: readonly Edge[]
}

const IMPORTER_KIND = /^ {4}(dependencies|devDependencies|optionalDependencies):[ \t\n\v\f\r]*$/

/** The name before the first `:` of a dependency line, without its quotes, or null. */
const declaredName = (line: string): string | null =>
  line.includes(':') ? before(line, ':').replaceAll("'", '') : null

/**
 * `pnpm_scan_rows`: one pass over `importers:` and `snapshots:`. Only
 * `snapshots:` has edges: a lockfileVersion 6 lockfile has none, and its
 * `packages:` keys are no parents (#103). The name of a parent ends at the
 * first `@` after the first character, not at the last. A git key such as
 * `debug@git+ssh://git@host/...` has an `@` in its URL (#50).
 */
export const scan = (text: string, pkg: string): Scan => {
  const importers: Importer[] = []
  const suffixes: Parent[] = []
  const edges: Edge[] = []
  let section = ''
  let importer = ''
  let importerKind: ImporterKind | null = null
  let parent: Parent | null = null
  let parentVersion: string | null = null
  let suffixed = false
  let kind: Edge['kind'] | null = null
  for (const line of lines(text)) {
    if (line.startsWith('importers:') || line.startsWith('snapshots:')) {
      section = line.slice(0, 9)
      continue
    }
    if (TOP_LEVEL.test(line)) section = ''
    if (section === 'importers') {
      const kindLine = IMPORTER_KIND.exec(line)
      if (ENTRY_KEY.test(line)) {
        importer = line
          .slice(2)
          .replace(/:[ \t\n\v\f\r]*$/, '')
          .replaceAll("'", '')
        importerKind = null
      } else if (kindLine !== null) {
        importerKind = kindLine[1] as ImporterKind
      } else if (/^ {4}[^ ]/.test(line)) {
        importerKind = null
      } else if (importerKind !== null && /^ {6}[^ ]/.test(line)) {
        if (declaredName(line.slice(6)) === pkg)
          importers.push({ path: importer, kind: importerKind })
      }
      continue
    }
    if (section !== 'snapshots') continue
    if (ENTRY_KEY.test(line)) {
      const key = line
        .slice(2)
        .replace(/:[ \t\n\v\f\r]*(\{\})?[ \t\n\v\f\r]*$/, '')
        .replaceAll("'", '')
      const locator = before(key, '(')
      const named = parentOf(locator)
      parent = named.name === '' ? null : named
      parentVersion = locator.slice(named.name.length + 1) || null
      suffixed = key.includes(`(${pkg}@`)
      if (parent !== null && suffixed) suffixes.push(parent)
      kind = null
      continue
    }
    const block = /^ {4}(dependencies|optionalDependencies):/.exec(line)
    if (block !== null) {
      kind = block[1] as Edge['kind']
      continue
    }
    if (/^ {4}[a-zA-Z]/.test(line)) kind = null
    if (parent !== null && kind !== null && /^ {6}/.test(line)) {
      const edge = line.slice(6)
      if (declaredName(edge) === pkg) {
        // The value, trimmed and without quotes or a peer suffix.
        const resolved = before(
          edge
            .slice(edge.indexOf(':') + 1)
            .replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '')
            .replaceAll("'", ''),
          '(',
        )
        edges.push({
          parent,
          parentVersion,
          version: /^[0-9]/.test(resolved) ? resolved : null,
          kind,
          suffixed,
        })
      }
    }
  }
  return { importers, suffixes, edges }
}

/**
 * Each snapshot whose `dependencies:` or `optionalDependencies:` block names
 * `pkg`. An optional edge is a declaration an override can reach (#160).
 */
export const parents = (text: string, pkg: string): readonly Parent[] =>
  uniqueParents(scan(text, pkg).edges.map((edge) => edge.parent))

/**
 * `pnpm_copy_rows`: one row for each edge to `pkg`. A snapshot records what
 * resolved, never what was declared, so no row has a range (#100).
 */
export const copies = (text: string, pkg: string): readonly Copy[] =>
  scan(text, pkg).edges.map(({ parent, parentVersion, version }) => ({
    parent: parent.name,
    parent_version: parentVersion,
    range: null,
    resolved: version,
  }))

/**
 * `pnpm_root_child_major` before its major: the version of `pkg` that the
 * root importer `.` resolves, or `null`. The first `version:` line under the
 * declaration wins. A peer suffix is not part of the version.
 */
export const rootVersion = (text: string, pkg: string): string | null => {
  let inImporters = false
  let isRoot = false
  let inSection = false
  let isDependency = false
  for (const line of lines(text)) {
    if (line.startsWith('importers:')) {
      inImporters = true
      continue
    }
    if (TOP_LEVEL.test(line)) inImporters = false
    if (!inImporters) continue
    if (ENTRY_KEY.test(line)) {
      isRoot =
        line
          .slice(2)
          .replace(/:[ \t\n\v\f\r]*$/, '')
          .replaceAll("'", '') === '.'
      inSection = false
      isDependency = false
    } else if (!isRoot) {
      // Only the root importer counts.
    } else if (IMPORTER_KIND.test(line)) {
      inSection = true
      isDependency = false
    } else if (/^ {4}[^ ]/.test(line)) {
      inSection = false
    } else if (inSection && /^ {6}[^ ]/.test(line)) {
      isDependency =
        line
          .slice(6)
          .replace(/:[ \t\n\v\f\r]*$/, '')
          .replaceAll("'", '') === pkg
    } else if (inSection && isDependency && line.startsWith('        version:')) {
      return before(line.replace(/^ {8}version:[ \t\n\v\f\r]*/, '').replaceAll("'", ''), '(')
    }
  }
  return null
}

/**
 * `pnpm_lockfile_v9`: the first `lockfileVersion:` line names major 9. The
 * value is the second field of the line, as awk splits it, without quotes.
 */
export const isV9 = (text: string): boolean => {
  const line = lines(text).find((each) => each.startsWith('lockfileVersion:'))
  const value = (line?.split(/[ \t]+/)[1] ?? '').replace(/['"]/g, '')
  return /^9([.]|$)/.test(value)
}
