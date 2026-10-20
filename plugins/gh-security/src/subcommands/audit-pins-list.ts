// `audit-pins list`: phase 2, the port of `cmd_list` in
// `audit-pins-driver.sh` (deleted in #236). It reads the pins of the worktree
// through `list_pins`, routes each by its kind, orders the testable pins bare
// first, and writes the state file. The contract is in the header of
// `audit-pins.ts`.
//
// This file ships. It imports nothing outside the plugin.

import { mkdirSync, statSync } from 'node:fs'

import { render, toText } from '../adapters/node/jq-json.ts'
import { isRecord } from '../adapters/node/manifest.ts'
import type { CommandResult } from '../cli/command.ts'
import { parseArguments } from '../lib/args.ts'
import { type JsonObject, type JsonValue, thrownText } from '../lib/envelope.ts'
import { createState } from '../state.ts'
import {
  type AuditPinsDeps,
  die,
  failPhase,
  promised,
  settle,
  stop,
  treeOf,
} from './audit-pins-common.ts'

/** The address of each override block inside `package.json`. */
const OVERRIDE_ROOTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['overrides', ['overrides']],
  ['resolutions', ['resolutions']],
  ['pnpm.overrides', ['pnpm', 'overrides']],
])

/**
 * The words that each kind other than `range` earns. An alias is not a pin
 * that is no longer necessary: it is how the repository gets another
 * implementation, and its removal changes which code ships.
 */
const KIND_DETAIL: ReadonlyMap<unknown, string> = new Map([
  [
    'alias',
    'a redirect to a different package, not a version pin: removing it changes which code ships',
  ],
  ['protocol', 'a patch, a local path, a workspace or git target, not a version pin'],
  ['reference', 'npm\'s "$pkg" form, deferring to a declared dependency, not a version pin'],
  [
    'unparseable',
    'a value this adapter cannot read, so it is not a version pin this audit can test, and the report says so',
  ],
])

/** jq's `.key`: the value, or null when the object has no such key. */
const fieldOrNull = (pin: JsonObject, key: string): JsonValue =>
  Object.hasOwn(pin, key) ? (pin[key] as JsonValue) : null

/** `[ -d path ]`: a directory, after symlinks. A path that cannot be read is not one. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The list phase. */
export const list = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: AuditPinsDeps,
): Promise<CommandResult> =>
  settle(async (): Promise<JsonValue> => {
    const parsed = parseArguments(args, {
      work: { type: 'string', default: '' },
      worktree: { type: 'string', default: '' },
      ecosystem: { type: 'string', default: 'npm' },
      'env-prefix': { type: 'string', default: '' },
    })
    if (parsed.outcome !== 'ok') stop(parsed)
    const { work, worktree, ecosystem } = parsed.value
    const envPrefix = parsed.value['env-prefix']
    if (work === '') die('list requires --work')
    if (worktree === '') die('list requires --worktree')
    if (!isDirectory(worktree)) die(`list: no such worktree: ${worktree}`)
    const route = deps.route(ecosystem)
    if (!route.supported) die(`list: the ecosystem '${ecosystem}' has no adapter: ${route.reason}`)
    try {
      mkdirSync(work, { recursive: true })
    } catch (error) {
      die(`list: cannot create ${work}: ${thrownText(error)}`)
    }

    const tree = treeOf(route.adapter, worktree, env)
    const answer = tree.outcome === 'ok' ? route.adapter.listPins(tree.value) : tree
    if (answer.outcome !== 'ok') {
      failPhase(
        'list',
        `list_pins failed: ${answer.error}. A non-zero exit is not an empty result: the adapter ` +
          'fails rather than reporting zero pins when the override block is present but is not an ' +
          'object of entries, and a manifest the adapter refused to read is never reported as a ' +
          'repository that pins nothing.',
      )
    }
    const pinsAnswer: unknown = answer.value
    const count = promised('list', pinsAnswer, 'list_pins', 'count')
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      failPhase(
        'list',
        `list_pins reported a count of '${toText(count)}', which is not a non-negative integer.`,
      )
    }
    const overrideFile = toText(promised('list', pinsAnswer, 'list_pins', 'override_file'))
    const location = toText(promised('list', pinsAnswer, 'list_pins', 'override_location'))
    const pm = toText(promised('list', pinsAnswer, 'list_pins', 'pm'))
    const pins = (pinsAnswer as Record<string, unknown>).pins
    if (!Array.isArray(pins)) {
      failPhase(
        'list',
        "list_pins answered a 'pins' that is not an array; it is the only statement of what this repository pins.",
      )
    }
    if (pins.length !== count) {
      failPhase(
        'list',
        `list_pins reported count=${count} beside ${pins.length} entries. The two disagree, and ` +
          'this flow verifies every later edit against that count.',
      )
    }

    // The workspace block is addressed by key, not by a path in a JSON
    // document, so its root is the empty path.
    const root =
      overrideFile === 'pnpm-workspace.yaml'
        ? []
        : (OVERRIDE_ROOTS.get(location) ??
          die(
            `list: list_pins reported an override_location this driver cannot address: ${location}`,
          ))

    // Only a `range` is a version pin. Each other kind is a finding, not a test.
    if (!pins.every(isRecord)) {
      failPhase(
        'list',
        `list_pins' entries could not be routed by kind: ${render(pinsAnswer, null)}`,
      )
    }
    const routed = (pins as JsonObject[]).map((pin): JsonObject => {
      const range = pin.kind === 'range'
      return {
        ...pin,
        finding: range ? 'testable' : 'not-a-version-pin',
        detail: range ? null : (KIND_DETAIL.get(pin.kind) ?? 'not a version pin'),
      }
    })

    // Bare pins first: they constrain each consumer in the tree, so they cost
    // the most and are the most likely to be too broad. `test-pin` runs once
    // for each entry, in this order.
    const testable = routed.filter((pin) => pin.finding === 'testable')
    const order = [
      ...testable.filter((pin) => pin.scope === 'bare'),
      ...testable.filter((pin) => pin.scope !== 'bare'),
    ].map((pin) => ({
      key: fieldOrNull(pin, 'key'),
      path: fieldOrNull(pin, 'path'),
      package: fieldOrNull(pin, 'package'),
      scope: fieldOrNull(pin, 'scope'),
      value: fieldOrNull(pin, 'value'),
    }))

    const written = createState(work, {
      work,
      worktree,
      adapter: route.name,
      ecosystem,
      env_prefix: envPrefix,
      override_file: overrideFile,
      override_location: location,
      override_root: [...root],
      pm,
      pins_count: count,
      pins: routed,
      test_order: order,
      findings: [],
      baseline_done: false,
    })
    if (written.outcome !== 'ok') die(`list: ${written.error}`)

    // A count of 0 is a whole answer, and not the answer of a refused
    // manifest: the repository has nothing to audit.
    if (count === 0) {
      return {
        status: 'no_pins',
        step: 'list',
        pm,
        override_file: overrideFile,
        override_location: location,
        count: 0,
        pins: [],
        test_order: [],
        pr_skipped_reason: 'no pins',
      }
    }
    return {
      status: 'ok',
      step: 'list',
      pm,
      override_file: overrideFile,
      override_location: location,
      count,
      test_order: order,
      not_a_version_pin: routed
        .filter((pin) => pin.finding === 'not-a-version-pin')
        .map((pin) => ({
          key: fieldOrNull(pin, 'key'),
          path: fieldOrNull(pin, 'path'),
          package: fieldOrNull(pin, 'package'),
          kind: fieldOrNull(pin, 'kind'),
          value: fieldOrNull(pin, 'value'),
          detail: fieldOrNull(pin, 'detail'),
        })),
    }
  })
