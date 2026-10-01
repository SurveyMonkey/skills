// How `apply_constraint` reads `package-lock.json` (#222). The passes of
// `verb_apply_constraint` read it with jq: `npm_declaration_rows`,
// `NPM_PATH_JQ`, `NPM_COPY_ROWS_JQ`, the placement pass and the stale entry
// pass. So this reader keeps the values of the file as they are, and each
// step reads them with the jq rules of `jq-json.ts`. It throws where jq
// stops.
//
// `src/lockfiles/npm.ts` reads the same file for the read verbs and
// `validate`. It drops the root entry, and a version that is not a text.
// These passes keep both, as node.sh does: a parent named `__root__` is the
// root manifest.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { addBlocks, entriesOf, get, or } from './jq-json.ts'
import { NO_DOCUMENT, readManifest } from './manifest.ts'

/** The lockfile: its text, the whole document, and its `packages` object. */
export type NpmLock = {
  readonly text: string
  /** The parsed document, or `NO_DOCUMENT` for a file of only white space. */
  readonly document: unknown
  /** `.packages // {}`, as pairs in file order. An empty list has no pairs. */
  readonly entries: readonly (readonly [string, unknown])[]
  /** The same entries, by key. */
  readonly byKey: ReadonlyMap<string, unknown>
}

/**
 * The lockfile of the tree at `root`. It throws for a file that is not
 * there or that does not parse. A file with no document has no entries,
 * because jq writes no row for it.
 */
export const readNpmLock = (root: string): NpmLock => {
  const path = join(root, 'package-lock.json')
  const text = readFileSync(path, 'utf8')
  const document = readManifest(path)
  const entries = document === NO_DOCUMENT ? [] : entriesOf(or(get(document, 'packages'), {}))
  return { text, document, entries, byKey: new Map(entries) }
}

/**
 * The text of a lockfile path after its last `node_modules/`, as jq's
 * `split("node_modules/") | last` reads it. No caller gives the empty root
 * path, for which jq answers null.
 */
export const lastSegment = (path: string): string => path.split('node_modules/').at(-1) as string

/** `pname`: `.name` of the entry, else the last segment of its path. The root is ''. */
export const nameAt = (lock: NpmLock, path: string): unknown =>
  path === '' ? '' : or(get(lock.byKey.get(path), 'name'), lastSegment(path))

/**
 * `deps`: the three blocks of an entry that declare a dependency, merged. A
 * later block wins a key.
 */
export const declarationsOf = (entry: unknown): readonly (readonly [string, unknown])[] =>
  entriesOf(
    addBlocks(
      ['dependencies', 'optionalDependencies', 'peerDependencies'].map((block) =>
        or(get(entry, block), {}),
      ),
    ),
  )

// A copy under `node_modules/`, with a scoped name as two segments (#121).
const LAST_COPY = /\/?node_modules\/(@[^/]+\/)?[^/]+$/

/** `prefixes`: `path`, then each directory above it that npm looks in. */
const prefixes = (path: string): readonly string[] => {
  if (path === '') return ['']
  const rest = path.replace(LAST_COPY, '')
  if (rest !== path) return [path, ...prefixes(rest)]
  return path.includes('node_modules/') ? [path] : [path, '']
}

/** `candidates`: where npm looks for the copy that the entry at `path` declares as `key`. */
export const candidatesOf = (path: string, key: string): readonly string[] =>
  prefixes(path).map((prefix) => `${prefix === '' ? '' : `${prefix}/`}node_modules/${key}`)

/** `resolve`: the first candidate that the lockfile holds, or null. */
export const resolveFrom = (lock: NpmLock, path: string, key: string): string | null =>
  candidatesOf(path, key).find((candidate) => lock.byKey.has(candidate)) ?? null

/** The parent that the rows of node.sh name for the entry at `path`. */
const parentAt = (path: string): string => (path === '' ? '__root__' : lastSegment(path))

/** One row of `NPM_COPY_ROWS_JQ`, with the values as the file holds them. */
export type CopyRow = {
  readonly parent: string
  /** `.version // null` of the parent entry. */
  readonly parent_version: unknown
  /** The version of the first candidate that has one, or null. */
  readonly resolved: unknown
}

/**
 * `npm_copy_rows`: one row for each key that declares `pkg`, by the name or
 * by an `npm:${pkg}@` alias. The root is a parent too.
 */
export const copyRows = (lock: NpmLock, pkg: string): readonly CopyRow[] =>
  lock.entries.flatMap(([path, entry]) =>
    declarationsOf(entry).flatMap(([key, specifier]): CopyRow[] => {
      if (typeof specifier !== 'string') return []
      if (key !== pkg && !specifier.startsWith(`npm:${pkg}@`)) return []
      const resolved = candidatesOf(path, key)
        .filter((candidate) => lock.byKey.has(candidate))
        .map((candidate) => or(get(lock.byKey.get(candidate), 'version'), null))
        .find((version) => version !== null)
      return [
        {
          parent: parentAt(path),
          parent_version: or(get(entry, 'version'), null),
          resolved: resolved ?? null,
        },
      ]
    }),
  )

/**
 * `@tsv` of jq: a backslash, a tab, a line feed and a carriage return each
 * get an escape. The rows of node.sh keep that text.
 */
const tsv = (text: string): string =>
  text
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')

/** One row of `npm_declaration_rows`, in the text of `@tsv`. */
export type DeclarationRow = {
  readonly parent: string
  readonly key: string
  readonly value: string
}

/** `npm_declaration_rows`: each declaration of a text value, with the parent that declares it. */
export const declarationRows = (lock: NpmLock): readonly DeclarationRow[] =>
  lock.entries.flatMap(([path, entry]) =>
    declarationsOf(entry).flatMap(([key, value]) =>
      typeof value === 'string'
        ? [{ parent: tsv(parentAt(path)), key: tsv(key), value: tsv(value) }]
        : [],
    ),
  )
