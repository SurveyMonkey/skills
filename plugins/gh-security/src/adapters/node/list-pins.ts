// `list_pins` for the node adapter, ported from `verb_list_pins`, `PINS_JQ`
// and `workspace_manifest_view` in node.sh (#221). The jq there is the
// specification.
//
// The verb reads the override file that the detection names. That file can
// be `pnpm-workspace.yaml`. Then the pins are the entries of its
// `overrides:` block, and the verb does not read the `pnpm.overrides` of
// package.json as pins (#159). Its keys are in `manifest_pnpm_overrides`.
// The verb does not run `detect`.
//
// Three states of the block, not two (ADR 001). No block is `count: 0`. A
// block that is present but not an object is a failure: a count of 0 for it
// tells the audit that the repository pins nothing.
//
// This file ships. It imports nothing outside the plugin.

import { join } from 'node:path'

import { type Envelope, failed } from '../../lib/envelope.ts'
import { rangeParseable } from '../../semver/ranges.ts'
import type { ListPinsAnswer, Pin, PinValue, Tree } from '../adapter.ts'
import { attempt } from './attempt.ts'
import { hasWorkspaceOverrides, type NodeDetection } from './detect.ts'
import { field, isRecord, NO_DOCUMENT, readManifest } from './manifest.ts'
import { byText } from './parents.ts'
import { workspaceOverrides } from './workspace-overrides.ts'

/** What {@link blockOf} answers where jq stops, for the `try` of `override_block`. */
export const INVALID = Symbol('invalid')

/**
 * `override_block`: the block, null when there is none, or {@link INVALID}.
 * A file that holds no document stays {@link NO_DOCUMENT}.
 */
export const blockOf = (
  manifest: unknown,
  location: NodeDetection['override_location'],
): unknown => {
  if (manifest === NO_DOCUMENT) return manifest
  try {
    const block =
      location === 'pnpm.overrides'
        ? field(field(manifest, 'pnpm'), 'overrides')
        : field(manifest, location)
    // `// null`: false is null too.
    return block === false ? null : block
  } catch {
    return INVALID
  }
}

/** jq's `type`. No document has no type: jq writes nothing for it. */
export const typeOf = (value: unknown): string => {
  if (value === NO_DOCUMENT) return ''
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export const MERGE_FAILED =
  "workspace_manifest_view: cannot merge the pnpm-workspace.yaml overrides into package.json's view (is package.json valid JSON?)"

/**
 * `workspace_manifest_view`: package.json with `pnpm.overrides` replaced by
 * the block of `pnpm-workspace.yaml`. When the file has no block, the view
 * drops `pnpm.overrides` of package.json instead: pnpm 11 does not read it.
 * The view keeps no document as no document. It throws where jq stops.
 */
export const workspaceView = (
  root: string,
  manifest: unknown,
  block: Readonly<Record<string, string>>,
): unknown => {
  if (manifest === NO_DOCUMENT) return manifest
  const pnpm = field(manifest, 'pnpm')
  if (hasWorkspaceOverrides(root)) {
    // `(.pnpm //= {}) | .pnpm.overrides = $ov`.
    const container = pnpm === null || pnpm === false ? {} : pnpm
    if (!isRecord(container)) throw new Error('.pnpm is not an object')
    return { ...(manifest as object), pnpm: { ...container, overrides: block } }
  }
  if (!isRecord(pnpm)) return manifest
  const rest = Object.fromEntries(Object.entries(pnpm).filter(([key]) => key !== 'overrides'))
  return { ...(manifest as object), pnpm: rest }
}

/**
 * The document that the pins come from, or a failure with the words of
 * node.sh. The block of `pnpm-workspace.yaml` is read first, so that its
 * refusal comes before the refusal of package.json.
 */
const sourceOf = (tree: Tree<NodeDetection>, workspace: boolean): Envelope<unknown> => {
  const path = join(tree.root, 'package.json')
  if (!workspace) {
    const manifest = attempt(() => readManifest(path))
    return manifest.outcome === 'ok' ? manifest : failed('list_pins: cannot read package.json')
  }
  return attempt(() => {
    const block = Object.fromEntries(
      workspaceOverrides(tree.root).map(({ key, value }) => [key, value]),
    )
    try {
      return workspaceView(tree.root, readManifest(path), block)
    } catch {
      throw new Error(MERGE_FAILED)
    }
  })
}

/**
 * `(.pnpm.overrides // {}) | keys` of package.json, sorted as jq sorts
 * them. It throws where jq stops. For an array, jq answers its indexes.
 * This port refuses an array, which is not a block of override entries.
 * That is a divergence from node.sh. No fixture has this shape.
 */
const manifestOverrideKeys = (root: string): readonly string[] => {
  try {
    const overrides = field(field(readManifest(join(root, 'package.json')), 'pnpm'), 'overrides')
    if (overrides === null || overrides === false) return []
    if (!isRecord(overrides)) throw new Error('pnpm.overrides is not an object')
    return Object.keys(overrides).sort(byText)
  } catch {
    throw new Error('list_pins: cannot read package.json')
  }
}

/** `strip_selector`: a version selector follows the last `@`, when that `@` is not the first character. */
export const stripSelector = (target: string): { name: string; selector: string | null } => {
  const at = target.lastIndexOf('@')
  return at <= 0
    ? { name: target, selector: null }
    : { name: target.slice(0, at), selector: target.slice(at + 1) }
}

type Facts = Pick<Pin, 'kind' | 'range' | 'alias_package' | 'alias_range'>

const facts = (kind: Pin['kind'], range: string | null = null): Facts => ({
  kind,
  range,
  alias_package: null,
  alias_range: null,
})

/** `value_facts`: what the value is. Only `range` is a version pin. */
export const factsOf = (value: PinValue): Facts => {
  if (typeof value !== 'string') return facts('unparseable')
  if (value.startsWith('$')) return facts('reference')
  if (value.startsWith('npm:')) {
    // The version after the last `@` is optional (#48).
    const rest = value.slice(4)
    const at = rest.lastIndexOf('@')
    return at <= 0
      ? { ...facts('alias'), alias_package: rest }
      : { ...facts('alias'), alias_package: rest.slice(0, at), alias_range: rest.slice(at + 1) }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return facts('protocol')
  return rangeParseable(value) ? facts('range', value) : facts('unparseable')
}

/** `pin`: one entry of the answer. */
const pinOf = (
  key: string,
  path: readonly string[],
  parents: readonly string[],
  target: string,
  value: PinValue,
): Pin => {
  const { name, selector } = stripSelector(target)
  return {
    key,
    path,
    package: name,
    selector,
    parents,
    scope: parents.length === 0 ? 'bare' : 'scoped',
    value,
    ...factsOf(value),
  }
}

/** jq's `split`: an empty text has no parts. */
const split = (text: string, separator: string): string[] =>
  text === '' ? [] : text.split(separator)

/** `pnpm_key`: `>` scopes, and the target follows the last `>`. */
const pnpmKey = (key: string): { parents: string[]; target: string } => {
  const at = key.lastIndexOf('>')
  return at === -1
    ? { parents: [], target: key }
    : { parents: split(key.slice(0, at), '>'), target: key.slice(at + 1) }
}

/** `yarn_key`: `/` scopes. The parent is one segment, or two for a scoped name. */
export const yarnKey = (key: string): { parents: string[]; target: string } => {
  const segments = split(key, '/')
  const head = key.startsWith('@') ? 2 : 1
  return segments.length <= head
    ? { parents: [], target: key }
    : {
        parents: [segments.slice(0, head).join('/')],
        target: segments.slice(head).join('/'),
      }
}

/** `npm_walk`: npm nests, so each leaf of the block is an entry, and its key path is the parents. */
const npmLeaves = (
  block: Readonly<Record<string, PinValue>>,
  path: readonly string[],
): { path: readonly string[]; value: PinValue }[] =>
  Object.entries(block).flatMap(([key, value]) =>
    isRecord(value)
      ? npmLeaves(value as Readonly<Record<string, PinValue>>, [...path, key])
      : [{ path: [...path, key], value }],
  )

const pinsOf = (
  location: NodeDetection['override_location'],
  block: Readonly<Record<string, PinValue>>,
): readonly Pin[] => {
  if (location === 'overrides') {
    return npmLeaves(block, []).map(({ path, value }) => {
      const last = path.length - 1
      // A `.` key names the parent itself, so it is the pin of that parent.
      const self = path[last] === '.' && path.length > 1
      const target = path[self ? last - 1 : last] as string
      return pinOf(path[0] as string, path, path.slice(0, self ? -2 : -1), target, value)
    })
  }
  const keyOf = location === 'pnpm.overrides' ? pnpmKey : yarnKey
  return Object.entries(block).map(([key, value]) => {
    const { parents, target } = keyOf(key)
    return pinOf(key, [...parents, target], parents, target, value)
  })
}

/** `verb_list_pins`. */
export const listPins = (tree: Tree<NodeDetection>): Envelope<ListPinsAnswer> => {
  const { detection } = tree
  const location = detection.override_location
  const workspace = detection.override_file === 'pnpm-workspace.yaml'
  const source = sourceOf(tree, workspace)
  if (source.outcome !== 'ok') return source
  const block = blockOf(source.value, location)
  if (block === INVALID) {
    return failed(
      `list_pins: the container holding '${location}' in package.json is not an object, so the override block cannot be read. Refusing to report a manifest this script cannot read as a repository with no pins.`,
    )
  }
  if (block !== null && !isRecord(block)) {
    return failed(
      `list_pins: '${location}' in package.json is a ${typeOf(block)}, not an object of override entries. Refusing to report a manifest this script cannot read as a repository with no pins.`,
    )
  }
  return attempt(() => {
    const pins = pinsOf(location, (block ?? {}) as Readonly<Record<string, PinValue>>)
    return {
      pm: detection.pm,
      override_location: location,
      override_file: detection.override_file,
      block_present: block !== null,
      count: pins.length,
      bare_count: pins.filter(({ scope }) => scope === 'bare').length,
      manifest_pnpm_overrides: workspace ? manifestOverrideKeys(tree.root) : [],
      pins,
    }
  })
}
