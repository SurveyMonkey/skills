// `apply_constraint` for the node adapter, ported from
// `verb_apply_constraint` in node.sh (#222). The bash there is the
// specification. This file holds the order of the passes and the refusal of
// each, as node.sh runs them. Each pass has its own file:
//
//   constraint-request.ts       the argument parse
//   constraint-observations.ts  the entries that the call saw
//   alias-keys.ts               the declared keys of the root and the parents
//   npm-placement.ts            the npm parents that a rule places
//   parent-qualifiers.ts        the version qualifiers of pnpm and npm
//   override-pass.ts            the write of the manifest
//   workspace-write.ts          the write of pnpm-workspace.yaml
//   lockfile-invalidation.ts    the stale npm lockfile entries
//
// It is a write verb, so it refuses outside a linked worktree (ADR 001,
// "Invocation"). As in node.sh, the guard is its first statement. The verb
// does not run `detect`.
//
// The passes read package.json, and write it last. So each refusal comes
// before a write. The three writes are in the order of node.sh:
// pnpm-workspace.yaml, then package.json, then package-lock.json. A failure
// after a write keeps that write, as in node.sh. A manifest that is the
// same document after the pass is not written, so its bytes stay as they
// are (#159). A written manifest keeps the indent of the file, and ends with
// a newline.
//
// Where jq stops in a pass that node.sh gives no message, bash exits 5 with
// the text of jq. The port answers `failed` with its own text.
//
// node.sh writes each file through `mktemp` and `mv`, so a written file has
// the mode 0600. The port writes in place, and the file keeps its mode.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Envelope, Failure } from '../../lib/envelope.ts'
import { rangeFloorMajor } from '../../semver/ranges.ts'
import { requireLinkedWorktree } from '../../worktree.ts'
import type { ApplyConstraintAnswer, ConstraintRequest, Tree } from '../adapter.ts'
import { aliasLookup, rootKeys } from './alias-keys.ts'
import { attempt } from './attempt.ts'
import { pnpmObservations, unscopedOverrides } from './constraint-observations.ts'
import { requestOf } from './constraint-request.ts'
import type { NodeDetection } from './detect.ts'
import { equal, get, getPath, indentOf, or, render, withKey, withoutKey } from './jq-json.ts'
import { blockOf, INVALID, MERGE_FAILED, typeOf, workspaceView } from './list-pins.ts'
import { invalidationOf } from './lockfile-invalidation.ts'
import { isRecord, NO_DOCUMENT, readManifest } from './manifest.ts'
import { type NpmLock, readNpmLock } from './npm-lock.ts'
import { type Placement, placementRefusal, placementsOf, tightenedRules } from './npm-placement.ts'
import { writePass } from './override-pass.ts'
import {
  bareConflict,
  npmEdges,
  pnpmEdges,
  type Qualifiers,
  qualifiersOf,
} from './parent-qualifiers.ts'
import { workspaceOverrides } from './workspace-overrides.ts'
import { writeWorkspaceOverrides } from './workspace-write.ts'

const CANNOT_READ_MANIFEST = 'apply_constraint: cannot read package.json'

const CANNOT_READ_LOCKFILE = 'apply_constraint: cannot read package-lock.json'

/** The value of `compute`, or a throw with the words of the `die` that node.sh runs there. */
const dieOn = <T>(message: string, compute: () => T): T => {
  try {
    return compute()
  } catch {
    throw new Error(message)
  }
}

/** The value, or a throw with the text of a failure. */
const orStop = <T>(value: T | Failure): T => {
  if (isFailure(value)) throw new Error(value.error)
  return value
}

const isFailure = (value: unknown): value is Failure =>
  isRecord(value) && value.outcome === 'failed' && typeof value.error === 'string'

/** `[ -f path ]`: a regular file, after symlinks. */
const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true

/** The floor major of the range as `jq -r` writes it, or '' when it has none. */
const targetOf = (range: string): string => {
  const floor = rangeFloorMajor(range)
  return floor === null ? '' : String(floor)
}

/**
 * The document that the passes read: package.json, or for the workspace
 * file of pnpm, the view of package.json with the block of that file in
 * place of `pnpm.overrides` (#159).
 */
const sourceOf = (root: string, manifest: unknown, workspace: boolean): unknown => {
  if (!workspace) return manifest
  const block = Object.fromEntries(workspaceOverrides(root).map(({ key, value }) => [key, value]))
  try {
    return workspaceView(root, manifest, block)
  } catch {
    throw new Error(MERGE_FAILED)
  }
}

/** The block of the source, or the refusal of node.sh for a block that it cannot read. */
const blockIn = (source: unknown, location: NodeDetection['override_location']): unknown => {
  const block = blockOf(source, location)
  if (block === INVALID) {
    throw new Error(
      `apply_constraint: the container holding '${location}' in package.json is not an object, so the override block cannot be read. Refusing to merge a constraint into a manifest this script cannot read.`,
    )
  }
  if (block !== null && !isRecord(block)) {
    throw new Error(
      `apply_constraint: '${location}' in package.json is a ${typeOf(block)}, not an object of override entries. Refusing to merge a constraint into a block this script cannot read.`,
    )
  }
  return block
}

/** The final map of the workspace block. jq stops on a value that is not a text. */
const workspaceMap = (manifest: unknown): Readonly<Record<string, string>> => {
  const map = or(getPath(manifest, ['pnpm', 'overrides']), {}) as Readonly<Record<string, unknown>>
  if (!Object.values(map).every((value) => typeof value === 'string')) {
    throw new Error('pnpm-workspace.yaml overrides: an entry is not a text')
  }
  return map as Readonly<Record<string, string>>
}

/** The passes, in the order of node.sh. It throws with the text of each refusal. */
const run = (tree: Tree<NodeDetection>, request: ConstraintRequest): ApplyConstraintAnswer => {
  const { root, detection } = tree
  const { pkg, range, parents, tightenBare: tighten } = request
  const location = detection.override_location
  const workspace = detection.override_file === 'pnpm-workspace.yaml'
  const manifestPath = join(root, 'package.json')
  const manifest = dieOn(CANNOT_READ_MANIFEST, () => readManifest(manifestPath))
  // node.sh keeps the `pnpm` field of package.json, and puts it back after
  // the pass. jq stops on a top level that is not an object or null.
  const original = workspace
    ? dieOn(CANNOT_READ_MANIFEST, () =>
        manifest === NO_DOCUMENT ? null : or(get(manifest, 'pnpm'), null),
      )
    : null
  const source = sourceOf(root, manifest, workspace)
  const block = blockIn(source, location)
  const observations = [
    ...unscopedOverrides(location, block, pkg),
    ...(detection.pm === 'pnpm'
      ? dieOn(CANNOT_READ_MANIFEST, () => pnpmObservations(detection, manifest))
      : []),
  ]
  const keys = dieOn(CANNOT_READ_MANIFEST, () => rootKeys(manifest, pkg))
  let lock: NpmLock | null = null
  const npmLock = (): NpmLock => {
    lock ??= readNpmLock(root)
    return lock
  }
  const lookup = aliasLookup(detection.pm, pkg, parents, npmLock, () =>
    readFileSync(join(root, 'yarn.lock'), 'utf8'),
  )
  const lockPath = join(root, 'package-lock.json')
  let placements: ReadonlyMap<string, Placement> = new Map()
  let tightened: readonly (readonly string[])[] = []
  if (location === 'overrides' && isFile(lockPath) && (tighten || parents.length > 0)) {
    const overrides = dieOn(CANNOT_READ_MANIFEST, () => or(get(manifest, 'overrides'), {}))
    placements = dieOn(CANNOT_READ_LOCKFILE, () =>
      placementsOf({
        lock: npmLock(),
        overrides,
        pkg,
        parents,
        target: targetOf(range),
        tighten,
      }),
    )
    const refusal = placementRefusal(placements, overrides, pkg, range, tighten)
    if (refusal !== null) throw new Error(refusal.error)
    if (tighten) tightened = orStop(tightenedRules(placements.get(pkg), overrides, pkg, range))
  }
  let qualifiers: Qualifiers = new Map()
  if (location !== 'resolutions' && parents.length > 0) {
    const edges =
      location === 'pnpm.overrides'
        ? pnpmEdges(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), pkg)
        : npmEdges(npmLock(), pkg)
    qualifiers = orStop(
      qualifiersOf(
        { location, edges, parents, target: targetOf(range), manifest },
        placements,
        pkg,
      ),
    )
  }
  if (location === 'overrides' && qualifiers.size > 0) {
    const conflict = bareConflict(qualifiers, placements, manifest, pkg, range)
    if (conflict !== null) throw new Error(conflict.error)
  }
  const indent = indentOf(readFileSync(manifestPath, 'utf8'))
  const pass = dieOn('apply_constraint: failed to rewrite package.json', () =>
    writePass(source, {
      location,
      pkg,
      range,
      parents,
      tighten,
      rootKeys: keys,
      keysByParent: lookup.keysByParent,
      qualifiers,
      placements,
      tightened,
    }),
  )
  let output = pass.manifest
  if (workspace) {
    writeWorkspaceOverrides(root, workspaceMap(pass.manifest))
    output = original === null ? withoutKey(output, 'pnpm') : withKey(output, 'pnpm', original)
  }
  // A document that did not change keeps its bytes (#159 review).
  if (!equal(output, manifest)) {
    dieOn(`apply_constraint: cannot replace package.json in ${root}`, () =>
      writeFileSync(manifestPath, `${render(output, indent)}\n`),
    )
  }
  let invalidated: ApplyConstraintAnswer['lockfile_invalidated'] = { performed: false, keys: [] }
  const wroteOverride = pass.written.some(({ path }) => path[0] === 'overrides')
  if (location === 'overrides' && wroteOverride && isFile(lockPath)) {
    const current = npmLock()
    const result = dieOn(CANNOT_READ_LOCKFILE, () => invalidationOf(current, pkg, range))
    invalidated = result.invalidated
    if (result.lockfile !== null) {
      writeFileSync(lockPath, `${render(result.lockfile, indentOf(current.text))}\n`)
    }
  }
  return {
    pm: detection.pm,
    package: pkg,
    range,
    override_location: location,
    override_file: detection.override_file,
    mode: tighten ? 'tighten-bare' : parents.length === 0 ? 'direct' : 'scoped',
    parents,
    written: pass.written,
    superseded_keys: pass.superseded,
    alias_lookup: {
      source: detection.pm === 'pnpm' ? 'unsupported' : 'lockfile',
      parents_unresolved: lookup.unresolved,
    },
    lockfile_invalidated: invalidated,
    observations,
  }
}

/** `verb_apply_constraint`. */
export const applyConstraint = (
  tree: Tree<NodeDetection>,
  input: ConstraintRequest,
): Envelope<ApplyConstraintAnswer> => {
  const guard = requireLinkedWorktree(tree.root, "refusing to run 'apply_constraint' here")
  if (guard.outcome !== 'ok') return guard
  const request = requestOf(input)
  if (request.outcome !== 'ok') return request
  return attempt(() => run(tree, request.value))
}
