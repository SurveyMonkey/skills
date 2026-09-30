// The npm `package-lock.json` reader, ported from node.sh (#220, RFC 002):
// `npm_versions`, `npm_parse_counts`, `npm_resolution_pairs`, the
// declaration reader behind `npm_parents`, and `NPM_COPY_ROWS_JQ` behind
// `npm_copy_rows` (#221). The jq there is the specification.
//
// A copy is known by the name it resolves to and by the key it is installed
// under. The two differ only for an `npm:` alias, which records the real name
// in `.name` (#44, #46).
//
// This file ships. It imports nothing outside the plugin.

import {
  aliasTarget,
  type Copy,
  type Coverage,
  groupResolutions,
  guarded,
  LockfileError,
  type Parent,
  type Resolution,
  type ResolutionMap,
  type ResolvedCopy,
  type ResolvedVersions,
  uniqueCopies,
  uniqueParents,
} from './shared.ts'

type Entry = {
  /** The `.packages` key. */
  readonly key: string
  readonly value: Readonly<Record<string, unknown>>
}

const EMPTY: Readonly<Record<string, unknown>> = {}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  isRecord(value) ? value : EMPTY

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const NODE_MODULES = 'node_modules/'

/** The key after its last `node_modules/`: the name the copy is installed as. */
const installedName = (key: string): string => key.replace(/^.*node_modules\//s, '')

/** npm's own name for the copy: `.name` for an alias, else the installed name. */
const packageName = ({ key, value }: Entry): string => textOf(value.name) ?? installedName(key)

// jq reads a leading byte order mark, and `JSON.parse` does not.
const BYTE_ORDER_MARK = /^\uFEFF/

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text.replace(BYTE_ORDER_MARK, ''))
  } catch (error) {
    throw new LockfileError(`package-lock.json is not valid JSON: ${String(error)}`, {
      cause: error,
    })
  }
}

const entriesOf = (text: string): Entry[] => {
  const packages = recordOf(parse(text)).packages
  if (!isRecord(packages)) {
    throw new LockfileError(
      'package-lock.json has no .packages object (lockfileVersion 1 is unsupported)',
    )
  }
  return Object.entries(packages).map(([key, value]) => ({ key, value: recordOf(value) }))
}

const installed = (entry: Entry): boolean => entry.key.includes(NODE_MODULES)

// A workspace link has no version of its own. The map and the guard both
// skip it (#48).
const rowEntries = (entries: readonly Entry[]): Entry[] =>
  entries.filter((entry) => installed(entry) && entry.value.link !== true)

// A row needs a version that starts with a digit (#49).
const rowOf = (entry: Entry): Resolution[] => {
  const version = textOf(entry.value.version)
  return version !== null && /^[0-9]/.test(version)
    ? [{ package: packageName(entry), version }]
    : []
}

const coverageOf = (entries: readonly Entry[]): Coverage => {
  const rows = rowEntries(entries)
  return guarded('npm', {
    entries: entries.filter(({ key }) => key !== '').length,
    expected: rows.length,
    read: rows.flatMap(rowOf).length,
  })
}

/** Every copy of `pkg`, found by its own name or by its alias key. */
export const resolvedVersions = (text: string, pkg: string): ResolvedVersions => {
  const entries = entriesOf(text)
  const coverage = coverageOf(entries)
  const copies = entries.flatMap((entry): ResolvedCopy[] => {
    const version = textOf(entry.value.version)
    const named = packageName(entry) === pkg || installedName(entry.key) === pkg
    return installed(entry) && version !== null && named ? [{ version, path: entry.key }] : []
  })
  return { coverage, copies: uniqueCopies(copies) }
}

/** Every package at a registry version, keyed by the name it resolves to. */
export const resolutionMap = (text: string): ResolutionMap => {
  const entries = entriesOf(text)
  const coverage = coverageOf(entries)
  return { coverage, resolutions: groupResolutions(rowEntries(entries).flatMap(rowOf)) }
}

const BLOCKS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/**
 * The three blocks of an entry that declare a dependency, merged. A later
 * block wins a key. jq's `// {}` reads null and false as no block. For
 * another value that is not an object, jq's `add` stops, and so does this.
 */
const declarationsOf = ({ key, value }: Entry): Readonly<Record<string, unknown>> =>
  Object.assign(
    {},
    ...BLOCKS.map((block) => {
      const declared = value[block]
      if (declared === undefined || declared === null || declared === false) return EMPTY
      if (!isRecord(declared)) {
        throw new LockfileError(
          `package-lock.json: ${key} has a ${block} block that is not an object`,
        )
      }
      return declared
    }),
  )

/**
 * The `NPM_PATH_JQ` walk up `node_modules`: `path`, then each directory above
 * it that npm looks in. A scoped name is two path segments (#121). A
 * workspace key has no `node_modules/`, so the root follows it. A path that
 * does not get shorter, but holds `node_modules/`, is a shape that the walk
 * does not know, and the root does not follow it.
 */
const prefixes = (path: string): readonly string[] => {
  if (path === '') return ['']
  const rest = path.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, '')
  if (rest !== path) return [path, ...prefixes(rest)]
  return path.includes(NODE_MODULES) ? [path] : [path, '']
}

/** Where npm looks for the copy that the entry at `path` declares under `key`. */
const candidates = (path: string, key: string): readonly string[] =>
  prefixes(path).map((prefix) => `${prefix === '' ? '' : `${prefix}/`}${NODE_MODULES}${key}`)

/**
 * `npm_copy_rows`: one row for each key that declares `pkg`, by the name or
 * by an `npm:${pkg}@` alias. The three blocks of each copy merge first, and
 * a later block wins a key. `resolved` is the version of the first candidate
 * on the walk up that has one. The root is not a parent.
 */
export const copies = (text: string, pkg: string): readonly Copy[] => {
  const entries = entriesOf(text)
  const byKey = new Map(entries.map((entry) => [entry.key, entry.value]))
  const alias = `npm:${pkg}@`
  return entries
    .filter(({ key }) => key !== '')
    .flatMap(({ key: path, value }) =>
      Object.entries(declarationsOf({ key: path, value })).flatMap(([key, specifier]): Copy[] => {
        if (typeof specifier !== 'string') return []
        if (key !== pkg && !specifier.startsWith(alias)) return []
        const resolved = candidates(path, key)
          .map((candidate) => textOf(byKey.get(candidate)?.version))
          .find((version) => version !== null)
        return [
          {
            parent: installedName(path),
            parent_version: textOf(value.version),
            range: key === pkg ? specifier : specifier.slice(alias.length),
            resolved: resolved ?? null,
          },
        ]
      }),
    )
}

/**
 * Each copy that declares `pkg` in `dependencies`, `optionalDependencies` or
 * `peerDependencies`, by the name or through an `npm:` alias of it. A peer
 * declaration is why the copy is in the tree at all (#49). The root is not a
 * parent: an override cannot be scoped to it. A workspace package is a parent,
 * named by its path, as in `npm_parents`.
 */
export const parents = (text: string, pkg: string): readonly Parent[] =>
  uniqueParents(
    entriesOf(text)
      .filter(({ key }) => key !== '')
      .filter((entry) =>
        Object.entries(declarationsOf(entry)).some(
          ([name, specifier]) =>
            typeof specifier === 'string' && (name === pkg || aliasTarget(specifier) === pkg),
        ),
      )
      .map((entry) => ({ name: installedName(entry.key), version: textOf(entry.value.version) })),
  )
