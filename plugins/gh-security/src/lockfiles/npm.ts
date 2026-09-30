// The npm `package-lock.json` reader, ported from node.sh (#220, RFC 002):
// `npm_versions`, `npm_parse_counts`, `npm_resolution_pairs` and the
// declaration reader behind `npm_parents`. The jq there is the specification.
//
// A copy is known by the name it resolves to and by the key it is installed
// under. The two differ only for an `npm:` alias, which records the real name
// in `.name` (#44, #46).
//
// This file ships. It imports nothing outside the plugin.

import {
  aliasTarget,
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

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new LockfileError(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
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

/**
 * Each copy that declares `pkg` in `dependencies`, `optionalDependencies` or
 * `peerDependencies`, by the name or through an `npm:` alias of it. A peer
 * declaration is why the copy is in the tree at all (#49). The root is not a
 * parent: an override cannot be scoped to it.
 */
export const parents = (text: string, pkg: string): readonly Parent[] =>
  uniqueParents(
    entriesOf(text)
      .filter(({ key }) => key !== '')
      .filter(({ value }) => {
        const declared = {
          ...recordOf(value.dependencies),
          ...recordOf(value.optionalDependencies),
          ...recordOf(value.peerDependencies),
        }
        return Object.entries(declared).some(
          ([name, specifier]) =>
            typeof specifier === 'string' && (name === pkg || aliasTarget(specifier) === pkg),
        )
      })
      .map((entry) => ({ name: installedName(entry.key), version: textOf(entry.value.version) })),
  )
