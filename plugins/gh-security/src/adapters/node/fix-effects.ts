// `fixEffects` for the node adapter (#334): what a fix did beside its
// target. It compares the tree after the fix install with the files of the
// last commit. In the fix driver, that commit is the tree after the control
// install. It reports two kinds, which `adapter.ts` names. Neither changes
// the risk score (ruling 4).
//
// A stale version-qualified key. npm gives each copy of a parent the first
// rule that an edge into the copy matches (`getEdgeRule` in
// `@npmcli/arborist`, `lib/override-set.js`). A key such as `"nx@22.7.7"`
// matches an edge whose spec intersects `22.7.7`. Real npm 11.19.0 runs
// showed two more facts, which the PR of #334 records:
//
//   - A copy of nx that a rule places, such as `"@nx/workspace": {"nx":
//     ...}`, gets the child of that rule, and never the top-level key. The
//     lockfile still records the spec `22.7.7` for that edge.
//   - The peer range of @nx/devkit matched `"nx@22.7.7"` for a copy of nx
//     22.7.10, so the key still moved its children.
//
// So the key reaches a copy through an edge when the copy is not placed
// (`npm-placement.ts`), and the spec of the edge matches the selector:
//
//   - An exact spec: the selector admits that version.
//   - A range, beside an exact selector: the range admits the selector.
//   - Anything else: a range beside a range selector, a selector that the
//     range rules cannot read, or a spec that is not a version or a range.
//     The range rules have no `intersects`, and npm takes a tag, a file or
//     a directory edge by name. So the key counts as reached.
//
// A key is stale when it reached a copy before the fix, and reaches none
// after it. A key that only the manifest after the fix has counts as one
// that reached a copy before. Each read uses the manifest of its own side.
// The verb reads only the top-level keys of the block. It does not check
// that an earlier key of the block wins the edge first. A key that it
// cannot decide is never named, so it names fewer keys than npm would,
// never more.
//
// A downgrade. For each dependent at the same path before and after the
// fix, each package that it declares resolves to a copy on each side. When
// the copy after the fix has a lower version, the verb names the package,
// the path of that copy, and the two versions. Only two plain semver
// versions are compared. The target of the fix is never named. A dependent
// at a new path is not compared.
//
// The verb only reads. It fails for a file that it cannot read, a file that
// is not JSON, and a lockfile with no packages. It is unsupported for pnpm
// and Yarn.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Envelope, failed, unsupported } from '../../lib/envelope.ts'
import { rangeParseable } from '../../semver/ranges.ts'
import { compareVersions } from '../../semver/versions.ts'
import type { CommitSource, FixEffectsAnswer, FixObservation, Tree } from '../adapter.ts'
import { attempt } from './attempt.ts'
import type { NodeDetection } from './detect.ts'
import { compare, entriesOf, equal, get, has, or, toText, unique } from './jq-json.ts'
import { stripSelector } from './list-pins.ts'
import { lastSegment, type NpmLock, nameAt, resolveFrom } from './npm-lock.ts'
import { placementsOf } from './npm-placement.ts'
import { admits, exactOf, LOOKS_RANGE, specsInto } from './npm-qualified-keys.ts'

// jq reads a byte order mark at the start of the file. `JSON.parse` does not.
const BYTE_ORDER_MARK = /^﻿/

/**
 * The document of a JSON text. It throws with the words of `where`. Text of
 * only white space is not JSON here.
 */
const documentOf = (text: string, where: string): unknown => {
  try {
    return JSON.parse(text.replace(BYTE_ORDER_MARK, ''))
  } catch {
    throw new Error(`fix_effects: ${where} is not JSON.`)
  }
}

/** The lockfile of one side. A lockfile with no packages is an error, never an empty answer. */
const lockOf = (text: string, side: string): NpmLock => {
  const where = `the package-lock.json of ${side}`
  const document = documentOf(text, where)
  const entries = entriesOf(or(get(document, 'packages'), {}))
  if (entries.length === 0) throw new Error(`fix_effects: ${where} holds no packages.`)
  return { text, document, entries, byKey: new Map(entries) }
}

/** `.overrides // {}` of the manifest of one side. */
const overridesOf = (text: string, side: string): unknown =>
  or(get(documentOf(text, `the package.json of ${side}`), 'overrides'), {})

/** One side of the compare: its lockfile and its override block. */
type Side = { readonly lock: NpmLock; readonly overrides: unknown }

/** The edge spec matches the selector, or the verb cannot tell that it does not. */
const matches = (spec: string, selector: string): boolean => {
  const exact = exactOf(spec)
  if (exact !== null) return admits(exact, selector)
  if (!LOOKS_RANGE.test(spec.trim())) return true
  const one = exactOf(selector)
  return one === null || admits(one, spec)
}

/** The key `parent@selector` reaches a copy of the parent through some edge. */
const reaches = ({ lock, overrides }: Side, parent: string, selector: string): boolean => {
  if (!rangeParseable(selector)) return true
  const placement = placementsOf({
    lock,
    overrides,
    pkg: parent,
    parents: [],
    target: '',
    tighten: true,
  }).get(parent)
  return lock.entries
    .filter(([path]) => path !== '' && lastSegment(path) === parent)
    .filter(
      ([, entry]) =>
        placement === undefined ||
        placement.normal_pvers.some((each) => equal(each, or(get(entry, 'version'), null))),
    )
    .some(([path]) => specsInto(lock, path).some((spec) => matches(toText(spec), selector)))
}

/** The version-qualified keys that reached a copy before the fix, and reach none after it. */
const staleKeys = (before: Side, after: Side): FixObservation[] =>
  entriesOf(after.overrides).flatMap(([key]): FixObservation[] => {
    const { name, selector } = stripSelector(key)
    if (selector === null || reaches(after, name, selector)) return []
    if (has(before.overrides, key) && !reaches(before, name, selector)) return []
    const installed = after.lock.entries
      .filter(([path]) => path !== '' && lastSegment(path) === name)
      .map(([, entry]) => or(get(entry, 'version'), null))
      .filter((version): version is string => typeof version === 'string')
    return [
      {
        type: 'stale_qualified_override',
        key,
        parent: name,
        selector,
        installed: unique(installed),
      },
    ]
  })

const EDGE_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** The keys that an entry declares in any block. */
const declaredKeys = (entry: unknown): string[] =>
  EDGE_BLOCKS.flatMap((block) => entriesOf(or(get(entry, block), {})).map(([key]) => key))

/** The version of the copy at `path`, when it is text. */
const versionAt = (lock: NpmLock, path: string): string | null => {
  const version = get(lock.byKey.get(path), 'version')
  return typeof version === 'string' ? version : null
}

/** `a` is lower than `b`. Only two plain semver versions compare. */
const lower = (a: string, b: string): boolean =>
  exactOf(a) !== null && exactOf(b) !== null && compareVersions(a, b) < 0

/** Each package that a dependent at the same path now gets at a lower version. */
const downgrades = (before: NpmLock, after: NpmLock, pkg: string): FixObservation[] => {
  const found = new Map<string, FixObservation>()
  for (const [from, entry] of after.entries) {
    if (!before.byKey.has(from)) continue
    for (const key of unique([...declaredKeys(entry), ...declaredKeys(before.byKey.get(from))])) {
      const was = resolveFrom(before, from, key)
      const now = resolveFrom(after, from, key)
      if (was === null || now === null) continue
      const name = nameAt(after, now)
      if (name === pkg || !equal(nameAt(before, was), name)) continue
      const old = versionAt(before, was)
      const next = versionAt(after, now)
      if (old === null || next === null || !lower(next, old)) continue
      const observation: FixObservation = {
        type: 'untargeted_downgrade',
        package: toText(name),
        path: now,
        before: old,
        after: next,
      }
      found.set(JSON.stringify(observation), observation)
    }
  }
  return [...found.values()].sort((a, b) =>
    compare(
      [get(a, 'package'), get(a, 'path'), get(a, 'before')],
      [get(b, 'package'), get(b, 'path'), get(b, 'before')],
    ),
  )
}

/** A file of the last commit, or a failure that names it. */
const fromCommit = async (
  before: CommitSource,
  file: string,
): Promise<{ readonly text: string } | Envelope<never>> => {
  const read = await before(file)
  return read.outcome === 'ok'
    ? { text: read.value }
    : failed(`fix_effects: cannot read ${file} as the last commit has it: ${read.error}`)
}

/** `fixEffects`. */
export const fixEffects = async (
  tree: Tree<NodeDetection>,
  pkg: string,
  before: CommitSource,
): Promise<Envelope<FixEffectsAnswer>> => {
  const { pm } = tree.detection
  if (pm !== 'npm') {
    return unsupported(
      pm,
      `fix_effects reads npm override keys and package-lock.json only, not ${pm}.`,
    )
  }
  const lockText = await fromCommit(before, 'package-lock.json')
  if (!('text' in lockText)) return lockText
  const manifestText = await fromCommit(before, 'package.json')
  if (!('text' in manifestText)) return manifestText
  return attempt(() => {
    const was: Side = {
      lock: lockOf(lockText.text, 'the last commit'),
      overrides: overridesOf(manifestText.text, 'the last commit'),
    }
    const now: Side = {
      lock: lockOf(readFileSync(join(tree.root, 'package-lock.json'), 'utf8'), 'the tree'),
      overrides: overridesOf(readFileSync(join(tree.root, 'package.json'), 'utf8'), 'the tree'),
    }
    return {
      pm,
      package: pkg,
      observations: [...staleKeys(was, now), ...downgrades(was.lock, now.lock, pkg)],
    }
  })
}
