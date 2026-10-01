// The keys that the dependents declare a package under (#46, #48), ported
// from `declared_keys_of` and `alias_keys_from_lockfile` in node.sh (#222).
// An override entry must name the key that the dependent used:
// `overrides.lodash` does not move a copy installed as `lodash-alias`.
//
// The keys of the root come from package.json. The keys of each parent come
// from the lockfile, never from `node_modules/<parent>/package.json`: that
// file is not there before an install (ADR 001). A parent whose declaration
// the lockfile does not hold is named as unresolved, never skipped. pnpm
// records no declared key, so each pnpm parent is unresolved.
//
// This file ships. It imports nothing outside the plugin.

import { aliasTarget } from '../../lockfiles/shared.ts'
import { declarations } from '../../lockfiles/yarn.ts'
import type { NodeDetection } from './detect.ts'
import { entriesOf, get, or, unique } from './jq-json.ts'
import { declarationRows, type NpmLock } from './npm-lock.ts'

const ROOT_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/**
 * `declared_keys_of`: each key of the four blocks of the root manifest that
 * names `pkg`, or that holds `npm:${pkg}` with or without a version. Unique,
 * and sorted. It throws where jq stops.
 */
export const rootKeys = (manifest: unknown, pkg: string): readonly string[] =>
  unique(
    ROOT_BLOCKS.flatMap((block) =>
      entriesOf(or(get(manifest, block), {})).flatMap(([key, value]) =>
        key === pkg ||
        (typeof value === 'string' && (value.startsWith(`npm:${pkg}@`) || value === `npm:${pkg}`))
          ? [key]
          : [],
      ),
    ),
  )

/** What `alias_keys_from_lockfile` answers for the parents of the call. */
export type AliasLookup = {
  /** The declared keys of each parent that the lockfile holds, unique and sorted. */
  readonly keysByParent: ReadonlyMap<string, readonly string[]>
  /** The parents that the lockfile holds no declaration for, in the order of the call. */
  readonly unresolved: readonly string[]
}

/** One declaration: the parent, the declared key, and the declared value. */
type Row = { readonly parent: string; readonly key: string; readonly value: string }

/** `declaration_rows`: the rows of the manager, or none for pnpm. */
const rowsOf = (
  pm: NodeDetection['pm'],
  lockfile: () => NpmLock,
  yarnText: () => string,
): readonly Row[] => {
  if (pm === 'npm') return declarationRows(lockfile())
  if (pm === 'yarn') {
    return declarations(yarnText()).map(({ parent, name, specifier }) => ({
      parent: parent.name,
      key: name,
      value: specifier,
    }))
  }
  return []
}

/** `alias_keys_from_lockfile`. The lockfile is read only for npm and yarn. */
export const aliasLookup = (
  pm: NodeDetection['pm'],
  pkg: string,
  parents: readonly string[],
  lockfile: () => NpmLock,
  yarnText: () => string,
): AliasLookup => {
  const rows = rowsOf(pm, lockfile, yarnText)
  const declared = new Set(rows.map(({ parent }) => parent))
  const keysByParent = new Map<string, readonly string[]>()
  for (const parent of parents.filter((each) => declared.has(each))) {
    const keys = rows
      .filter((row) => row.parent === parent)
      .filter(({ key, value }) => key === pkg || aliasTarget(value) === pkg)
      .map(({ key }) => key)
    keysByParent.set(parent, unique(keys))
  }
  return { keysByParent, unresolved: parents.filter((parent) => !declared.has(parent)) }
}
