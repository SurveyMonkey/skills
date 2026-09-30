// `declared_ranges` for the node adapter, ported from `verb_declared_ranges`,
// `DECLARED_RANGE_JQ` and `resolved_major_for_parent` in node.sh (#221). The
// bash there is the specification.
//
// The verb collects the ranges that the dependents of a package declare: the
// root manifest, and each parent. Some parents answer from the manifest at
// `node_modules/<parent>/`, which is the state that the install left. These
// are a parent with no copy row, and a parent with one copy and an installed
// manifest. Else the lockfile answers for each copy of the parent (#85). A
// pnpm copy row has no range, but its line is known (#100).
//
// With a `line`, a dependent whose copy of the package is on another major
// line is in `parents_other_lines` (#76). A dependent whose line is unknown
// stays in: a range too many is safe, and a range dropped is not. A parent
// that the lockfile answers for gets its line from its row. For npm and
// yarn, the root and a parent that its manifest answers for get the line
// from node resolution over the installed tree. The nested copy is first,
// then the hoisted one. For pnpm, the root gets its line from `importers:`,
// and each parent from its rows.
//
// The verb does not run `detect`.
//
// This file ships. It imports nothing outside the plugin.

import { statSync } from 'node:fs'
import { join } from 'node:path'

import { type Envelope, failed } from '../../lib/envelope.ts'
import * as pnpm from '../../lockfiles/pnpm.ts'
import type { Copy } from '../../lockfiles/shared.ts'
import type { DeclaredRangesAnswer, Tree } from '../adapter.ts'
import { attempt } from './attempt.ts'
import type { NodeDetection } from './detect.ts'
import { field, isRecord, NO_DOCUMENT, readManifest } from './manifest.ts'
import { byText, lockfileText, namesOf, readerOf } from './parents.ts'

/** The name that node.sh gives the root when it is a dependent. */
const ROOT = '__root__'

/** `[ -f path ]`: a regular file, after symlinks. */
const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true

/**
 * The major of a version: the digits before the first `.`, or null when
 * that is not all digits. With `ltrimstr`, one leading `v` goes first.
 */
const majorOf = (version: string, ltrimstr: boolean): string | null => {
  const text = ltrimstr && version.startsWith('v') ? version.slice(1) : version
  const major = text.split('.')[0] as string
  return /^[0-9]+$/.test(major) ? major : null
}

/**
 * `declared_ranges_of`: the string values that `blocks` declare for `pkg`,
 * under its name or under an `npm:${pkg}@` alias, in block order. It throws
 * where jq stops: a block that is not an object, a list or null.
 */
const rangesIn = (manifest: unknown, blocks: readonly string[], pkg: string): string[] => {
  if (manifest === NO_DOCUMENT) return []
  const alias = `npm:${pkg}@`
  return blocks.flatMap((block) => {
    const value = field(manifest, block)
    if (value === null || value === false) return []
    if (!isRecord(value) && !Array.isArray(value)) {
      throw new Error(`declared_ranges: ${block} in a manifest is not an object`)
    }
    return Object.entries(value).flatMap(([key, range]): string[] => {
      if (typeof range !== 'string') return []
      if (key === pkg) return [range]
      return range.startsWith(alias) ? [range.slice(alias.length)] : []
    })
  })
}

/**
 * `resolved_major_for_parent`: the major of the copy of `pkg` that `parent`
 * reaches in the installed tree, or null. A manifest with no readable major
 * sends the search to the next candidate.
 */
const installedMajor = (root: string, parent: string, pkg: string): string | null => {
  for (const path of [
    join(root, 'node_modules', parent, 'node_modules', pkg, 'package.json'),
    join(root, 'node_modules', pkg, 'package.json'),
  ]) {
    if (!isFile(path)) continue
    let version: unknown
    try {
      const manifest = readManifest(path)
      version = isRecord(manifest) ? manifest.version : null
    } catch {
      continue
    }
    const major = typeof version === 'string' ? majorOf(version, true) : null
    if (major !== null) return major
  }
  return null
}

/** The four lists of parents, and the ranges, as the verb collects them. */
type Collected = {
  ranges: string[]
  read: string[]
  withoutRange: string[]
  unreadable: string[]
  malformed: string[]
  otherLines: string[]
}

/**
 * One parent, from the rows of the lockfile for its copies. A copy on
 * another line is named with its version, because a parent on two lines is
 * in `parents_read` too.
 */
const fromCopies = (
  collected: Collected,
  parent: string,
  rows: readonly Copy[],
  line: string | null,
): void => {
  let read = false
  let unread = false
  for (const row of rows) {
    const major = majorOf(row.resolved ?? '', true)
    if (line !== null && major !== null && major !== line) {
      collected.otherLines.push(
        row.parent_version === null ? parent : `${parent}@${row.parent_version}`,
      )
      continue
    }
    // A row with no range, an empty range or `-` is unread. Each pnpm row
    // has no range: its snapshots record what resolved, never what was
    // declared (#100). An npm or Yarn row gets here for a `""` or `-` range.
    if (row.range !== null && row.range !== '' && row.range !== '-') {
      collected.ranges.push(row.range)
      read = true
    } else {
      unread = true
    }
  }
  if (read) collected.read.push(parent)
  else if (unread) collected.unreadable.push(parent)
}

/** One parent, from its installed manifest. */
const fromManifest = (collected: Collected, root: string, parent: string, pkg: string): void => {
  const path = join(root, 'node_modules', parent, 'package.json')
  if (!isFile(path)) {
    collected.unreadable.push(parent)
    return
  }
  let found: string[]
  try {
    found = rangesIn(
      readManifest(path),
      ['dependencies', 'optionalDependencies', 'peerDependencies'],
      pkg,
    )
  } catch {
    // On disk, but it does not parse, or jq cannot read a block of it: a
    // damaged install, not an absent one.
    collected.unreadable.push(parent)
    collected.malformed.push(parent)
    return
  }
  collected.read.push(parent)
  // node.sh reads the ranges as lines of text. Empty ranges give only empty
  // lines, which the shell drops, so the parent declares no range.
  if (found.every((range) => range === '')) collected.withoutRange.push(parent)
  else collected.ranges.push(...found)
}

const collect = (tree: Tree<NodeDetection>, pkg: string, line: string | null) => {
  const { root, detection } = tree
  const text = lockfileText(tree)
  const reader = readerOf(tree)
  const parents = namesOf(reader.parents(text, pkg))
  let rootRange =
    rangesIn(
      readManifest(join(root, 'package.json')),
      ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'],
      pkg,
    )[0] ?? ''
  const collected: Collected = {
    ranges: [],
    read: [],
    withoutRange: [],
    unreadable: [],
    malformed: [],
    otherLines: [],
  }
  // The root is a dependent too, and `line` filters it on the same rule. pnpm
  // reads its line from `importers:`: there may be no install (#100).
  if (rootRange !== '' && line !== null) {
    const rootMajor =
      detection.pm === 'pnpm'
        ? majorOf(pnpm.rootVersion(text, pkg) ?? '', false)
        : installedMajor(root, ROOT, pkg)
    if (rootMajor !== null && rootMajor !== line) {
      collected.otherLines.push(ROOT)
      rootRange = ''
    }
  }
  const copies = reader.copies(text, pkg)
  for (const parent of parents) {
    const rows = copies.filter((row) => row.parent === parent)
    const count = new Set(rows.map((row) => row.parent_version)).size
    const installed = isFile(join(root, 'node_modules', parent, 'package.json'))
    if (count > 1 || (count >= 1 && !installed)) {
      fromCopies(collected, parent, rows, line)
      continue
    }
    if (line !== null) {
      // pnpm links no child under `node_modules/<parent>/`, so its rows say
      // the line. Any row on the line keeps the parent (#100).
      let major: string | null
      if (detection.pm === 'pnpm') {
        const majors = rows.flatMap((row) => majorOf(row.resolved ?? '', true) ?? [])
        major = majors.includes(line) ? line : (majors[0] ?? null)
      } else {
        major = installedMajor(root, parent, pkg)
      }
      if (major !== null && major !== line) {
        collected.otherLines.push(parent)
        continue
      }
    }
    fromManifest(collected, root, parent, pkg)
  }
  if (rootRange !== '') collected.ranges.push(rootRange)
  return { collected, rootRange }
}

/** `verb_declared_ranges`. */
export const declaredRanges = (
  tree: Tree<NodeDetection>,
  pkg: string,
  line: number | null,
): Envelope<DeclaredRangesAnswer> => {
  if (pkg === '') return failed('declared_ranges requires a package name')
  if (line !== null && !(Number.isInteger(line) && line >= 0)) {
    return failed(`declared_ranges: --line must be a major number, got '${line}'`)
  }
  return attempt(() => {
    const { collected, rootRange } = collect(tree, pkg, line === null ? null : String(line))
    const ranges = collected.ranges
      .flatMap((range) => range.split('\n'))
      .filter((range) => range !== '')
    return {
      pm: tree.detection.pm,
      package: pkg,
      line,
      ranges: [...new Set(ranges)].sort(byText),
      root_range: rootRange === '' ? null : rootRange,
      parents_read: collected.read,
      parents_without_range: collected.withoutRange,
      parents_unreadable: collected.unreadable,
      parents_malformed: collected.malformed,
      parents_other_lines: collected.otherLines,
    }
  })
}
