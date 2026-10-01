// The stale npm lockfile entries that an override must move (#124), ported
// from the last jq pass of `verb_apply_constraint` in node.sh (#222).
//
// npm keeps no trace of `overrides` in package-lock.json. On a plain
// install, an entry that the lockfile has wins over a new override: the
// copy stays at its locked version, and the override does nothing. So the
// call removes each stale entry before the install.
//
// A stale entry is a copy of the package, by resolved name only, on the
// major line of the floor of the range, that does not satisfy the range. A
// copy on another line belongs to a sibling group, and a copy that already
// satisfies the range needs no move. An entry with no version, such as a
// workspace link, is never stale.
//
// When the pass cannot judge the lockfile, it says why, with
// `performed: false` and a `reason`: the range has no floor major, or the
// lockfile has no `packages` object (lockfileVersion 1).
//
// This file ships. It imports nothing outside the plugin.

import { rangeFloorMajor } from '../../semver/ranges.ts'
import { parseVersion } from '../../semver/versions.ts'
import type { ApplyConstraintAnswer } from '../adapter.ts'
import { equal, get, jqType, or } from './jq-json.ts'
import { isRecord, NO_DOCUMENT } from './manifest.ts'
import { lastSegment, type NpmLock } from './npm-lock.ts'
import { byText } from './parents.ts'
import { satisfiesAll } from './validate.ts'

/** What the pass gives: the answer, and the lockfile to write when it removed an entry. */
export type Invalidation = {
  readonly invalidated: ApplyConstraintAnswer['lockfile_invalidated']
  /** The lockfile without the stale entries, or null when the pass removed none. */
  readonly lockfile: unknown
}

/** `stale`: the entry at `key` is a stale copy of `pkg` on the line `floor`. */
const isStale = (
  key: string,
  entry: unknown,
  pkg: string,
  range: string,
  floor: number,
): boolean => {
  if (!key.includes('node_modules/') || !isRecord(entry)) return false
  if (!equal(or(get(entry, 'name'), lastSegment(key)), pkg)) return false
  const version = entry.version
  if (typeof version !== 'string') return false
  return (parseVersion(version).core[0] ?? null) === floor && !satisfiesAll(version, range)
}

/** The stale entry pass over the lockfile. It throws where jq stops. */
export const invalidationOf = (lock: NpmLock, pkg: string, range: string): Invalidation => {
  if (lock.document === NO_DOCUMENT) throw new Error('package-lock.json holds no document')
  const floor = rangeFloorMajor(range)
  if (floor === null) {
    return {
      invalidated: { performed: false, keys: [], reason: 'unreadable_range_floor' },
      lockfile: null,
    }
  }
  const packages = get(lock.document, 'packages')
  if (jqType(packages) !== 'object') {
    return {
      invalidated: { performed: false, keys: [], reason: 'no_packages_object' },
      lockfile: null,
    }
  }
  const keys = Object.entries(packages as Readonly<Record<string, unknown>>)
    .filter(([key, entry]) => isStale(key, entry, pkg, range, floor))
    .map(([key]) => key)
    .sort(byText)
  const kept = Object.fromEntries(
    Object.entries(packages as Readonly<Record<string, unknown>>).filter(
      ([key]) => !keys.includes(key),
    ),
  )
  return {
    invalidated: { performed: true, keys },
    lockfile: keys.length === 0 ? null : { ...(lock.document as object), packages: kept },
  }
}
