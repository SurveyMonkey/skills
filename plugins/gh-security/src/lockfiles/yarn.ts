// The Yarn Berry `yarn.lock` reader, ported from node.sh (#220, RFC 002):
// `YARN_LOCATOR_AWK` behind `yarn_versions` and `yarn_resolution_pairs`,
// `YARN_DECLARATION_AWK` behind `yarn_parents`, and `YARN_COPY_AWK` behind
// `yarn_copy_rows` (#221). The awk there is the specification. This reads only the lines those programs read. It is not a
// YAML parser.
//
// Every entry has one `resolution:` locator, which stays stable when several
// descriptors share one block. Yarn Classic has none, and `detect` refuses it
// before a reader runs.
//
// This file ships. It imports nothing outside the plugin.

import {
  aliasTarget,
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

/** What a locator resolves to: the three answers of `locator_row`. */
type Reading =
  | {
      readonly kind: 'registry'
      /** The package the code is. */
      readonly name: string
      /** The name the copy is installed under. */
      readonly key: string
      readonly version: string
    }
  | { readonly kind: 'local' | 'unreadable'; readonly version: null }

const LOCAL: Reading = { kind: 'local', version: null }
const UNREADABLE: Reading = { kind: 'unreadable', version: null }

// A protocol whose target is not a published release.
const LOCAL_PROTOCOL =
  /^(workspace|portal|exec|link|file|git|git[+]ssh|git[+]http|git[+]https|http|https|ssh|github|gitlab|bitbucket):$/

// A full semver, not just a first digit: anything else is a misread locator.
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$/

// The first `resolution: "` of a line, to the next quote.
const RESOLUTION = /resolution: "([^"]*)"/

const locatorOf = (line: string): string | null => RESOLUTION.exec(line)?.[1] ?? null

/**
 * The text before and after the first `@` after the first character, so a
 * scoped name keeps its own `@`. With no such `@`, all of it is the name.
 */
const splitName = (locator: string): [string, string] => {
  const at = `${locator}@`.indexOf('@', 1)
  return [locator.slice(0, at), locator.slice(at + 1)]
}

/**
 * Decode one level. Berry encodes a wrapped locator once per level. Decode
 * `%25` last, or one pass opens two levels.
 */
const decoded = (text: string): string =>
  text
    .replace(/%3[Aa]/g, ':')
    .replaceAll('%23', '#')
    .replaceAll('%40', '@')
    .replaceAll('%25', '%')

/**
 * Read one locator. A `patch:` wraps a published release, so the reader
 * unwraps it and asks again, once per level. An `npm:` descriptor that is not
 * a version is an alias, and the copy is the package it names.
 */
const readLocator = (locator: string): Reading => {
  const [key] = splitName(locator)
  let name = key
  let current = locator
  for (;;) {
    const [, descriptor] = splitName(decoded(current))
    const colon = descriptor.indexOf(':') + 1
    const protocol = descriptor.slice(0, colon)
    const value = descriptor.slice(colon)
    if (protocol === 'npm:') {
      // Parameters that Berry adds after `::`, such as `__archiveUrl`, are not the version.
      const version = before(value, '::')
      if (SEMVER.test(version)) return { kind: 'registry', name, key, version }
      // The alias target ends at the last `@`. With none after the first
      // character, the next pass reads nothing.
      const at = Math.max(version.lastIndexOf('@'), 0)
      name = version.slice(0, at)
      current = `${name}@npm:${version.slice(at + 1)}`
    } else if (protocol === 'patch:') {
      // From the first `#` on is the patch file and its data.
      current = before(value, '#')
    } else {
      return LOCAL_PROTOCOL.test(protocol) ? LOCAL : UNREADABLE
    }
  }
}

const lines = (text: string): string[] => text.split('\n')

const read = (text: string) => {
  const readings = lines(text).flatMap((line) => {
    const locator = locatorOf(line)
    return locator === null ? [] : [{ locator, reading: readLocator(locator) }]
  })
  const coverage: Coverage = guarded('yarn', {
    entries: readings.length,
    expected: readings.length,
    read: readings.filter(({ reading }) => reading.kind !== 'unreadable').length,
  })
  const rows = readings.flatMap(({ locator, reading }) =>
    reading.kind === 'registry' ? [{ ...reading, locator }] : [],
  )
  return { coverage, rows }
}

/** Every copy of `pkg`, found by the package it is or by its alias key. */
export const resolvedVersions = (text: string, pkg: string): ResolvedVersions => {
  const { coverage, rows } = read(text)
  const copies = rows
    .filter(({ name, key }) => name === pkg || key === pkg)
    .map(({ version, locator }) => ({ version, path: locator }))
  return { coverage, copies: uniqueCopies(copies) }
}

/** Every package at a registry version, keyed by the package it is. */
export const resolutionMap = (text: string): ResolutionMap => {
  const { coverage, rows } = read(text)
  return {
    coverage,
    resolutions: groupResolutions(rows.map(({ name, version }) => ({ package: name, version }))),
  }
}

/**
 * The parent that the locator of an entry names. A workspace gives `null`: it
 * is the repository's own code, so an override cannot be scoped to it. An empty
 * locator has no name, so it also gives `null`.
 */
const parentOf = (locator: string): Parent | null => {
  const [name] = splitName(locator)
  return name === '' || locator.includes('@workspace:')
    ? null
    : { name, version: readLocator(locator).version }
}

const DECLARATIONS = /^ {2}(dependencies|peerDependencies|optionalDependencies):/

/** A declaration line of a block: the declared name and specifier, without quotes. */
const declarationOf = (line: string): { name: string; specifier: string } => {
  const declaration = line.slice(4)
  const declared = before(declaration, ':')
  return {
    name: declared.replaceAll('"', ''),
    specifier: declaration
      .slice(declared.length + 1)
      .replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '')
      .replaceAll('"', ''),
  }
}

/** The start of an entry, or of the file header: a line that is not indented and not a comment. */
const ENTRY_START = /^[^ \t\n\v\f\r#]/

/**
 * Each entry that declares `pkg` in `dependencies`, `optionalDependencies` or
 * `peerDependencies`, by the name or through an `npm:` alias of it. See #47
 * and #49. The colon must follow the block name, so `peerDependenciesMeta` is
 * not read.
 */
export const parents = (text: string, pkg: string): readonly Parent[] => {
  const found: Parent[] = []
  let parent: Parent | null = null
  let inDeclarations = false
  for (const line of lines(text)) {
    if (ENTRY_START.test(line)) {
      parent = null
      inDeclarations = false
    }
    const locator = locatorOf(line)
    if (locator !== null) {
      parent = parentOf(locator)
      continue
    }
    if (DECLARATIONS.test(line)) {
      inDeclarations = true
      continue
    }
    if (/^ {2}[a-zA-Z]/.test(line)) inDeclarations = false
    if (parent !== null && inDeclarations && /^ {4}/.test(line) && line.includes(':')) {
      const { name, specifier } = declarationOf(line)
      if (name === pkg || aliasTarget(specifier) === pkg) found.push(parent)
    }
  }
  return uniqueParents(found)
}

/**
 * `yarn_copy_rows`: one row for each declaration of `pkg`, by the name or by
 * an `npm:${pkg}@` alias, in the three blocks of each entry. The version of
 * the parent is its `version:` line. `resolved` is the `version:` of the
 * entry whose key list holds the descriptor `<name>@<specifier>`.
 */
export const copies = (text: string, pkg: string): readonly Copy[] => {
  const versions = new Map<string, string>()
  const declared: { parent: string; version: string; name: string; specifier: string }[] = []
  let descriptors: readonly string[] = []
  let version = ''
  let parent: Parent | null = null
  let inDeclarations = false
  for (const line of lines(text)) {
    if (ENTRY_START.test(line)) {
      // The key list: `"a@npm:^1.0.0, a@npm:^1.1.0":`, without its quotes.
      descriptors = line.endsWith(':') ? line.slice(0, -1).replaceAll('"', '').split(', ') : []
      version = ''
      parent = null
      inDeclarations = false
      continue
    }
    if (line.startsWith('  version: ')) {
      version = line
        .slice(11)
        .replaceAll('"', '')
        .replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '')
      for (const descriptor of descriptors) versions.set(descriptor, version)
      continue
    }
    const locator = locatorOf(line)
    if (locator !== null) {
      parent = parentOf(locator)
      continue
    }
    if (DECLARATIONS.test(line)) {
      inDeclarations = true
      continue
    }
    if (/^ {2}[a-zA-Z]/.test(line)) inDeclarations = false
    if (parent !== null && inDeclarations && /^ {4}/.test(line) && line.includes(':')) {
      declared.push({ parent: parent.name, version, ...declarationOf(line) })
    }
  }
  const alias = `npm:${pkg}@`
  return declared
    .filter(({ name, specifier }) => name === pkg || specifier.startsWith(alias))
    .map(({ parent: owner, version: ownerVersion, name, specifier }) => ({
      parent: owner,
      parent_version: ownerVersion,
      range: name === pkg ? specifier.replace(/^npm:/, '') : specifier.slice(alias.length),
      resolved: versions.get(`${name}@${specifier}`) ?? null,
    }))
}
