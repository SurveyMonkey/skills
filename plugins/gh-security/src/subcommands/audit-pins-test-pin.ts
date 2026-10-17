// `audit-pins test-pin`: phase 4, one pin for each install, the port of
// `cmd_test_pin` in `scripts/common/audit-pins-driver.sh`. It removes one
// entry, checks that the edit landed, installs, reads what resolves now and
// the whole-tree map, records the finding, and returns the tree to HEAD. The
// contract is in the header of `audit-pins.ts`.
//
// One pin for each install, always. When several pins go at once, each
// removal can change the resolution of the others, so a batch result is not
// evidence about any one pin.
//
// This file ships. It imports nothing outside the plugin.

import { equal, render, toText } from '../adapters/node/jq-json.ts'
import { isRecord } from '../adapters/node/manifest.ts'
import type { CommandResult } from '../cli/command.ts'
import { parseArguments } from '../lib/args.ts'
import type { JsonObject, JsonValue } from '../lib/envelope.ts'
import { readOptionalValue } from '../state.ts'
import { MAP_NOT_IMPLEMENTED } from './audit-pins-baseline.ts'
import { collateralOf, disagreementOf, minus } from './audit-pins-collateral.ts'
import {
  type AuditPinsDeps,
  countOrNull,
  die,
  failPhase,
  inconclusive,
  isList,
  loadSession,
  mapUnreadable,
  type OrderedPin,
  onTree,
  optionalText,
  promised,
  type Resolutions,
  recordFinding,
  requiredValue,
  resolutionsOf,
  resolvedList,
  restoreTree,
  type Session,
  settle,
  stateValue,
  stop,
  testOrder,
  UNJUDGED,
} from './audit-pins-common.ts'
import { removeManifestPaths, removeWorkspaceKey } from './audit-pins-removal.ts'
import { installOnce } from './fix-group-common.ts'

const NOT_TO_COMPLETION =
  'this pin was not tested to completion, so no other package in the tree was compared'

/** The pin that `--path` or `--key` names in `test_order`, or exit 1. */
const pinOf = (order: readonly OrderedPin[], key: string, path: string): OrderedPin => {
  if (path !== '') {
    let wanted: unknown
    try {
      wanted = JSON.parse(path)
    } catch {
      wanted = null
    }
    if (!Array.isArray(wanted))
      die('test-pin: --path must be a JSON array, as list_pins reports it')
    return (
      order.find((pin) => equal(pin.path, wanted)) ??
      die(`test-pin: no testable pin at path ${path}`)
    )
  }
  const matches = order.filter((pin) => pin.key === key)
  if (matches.length === 0) die(`test-pin: no testable pin with key '${key}'`)
  // A key is not unique in a manifest: npm nests `{"rimraf": {".": ...,
  // "glob": ...}}` under one key. So a key that names more than one pin is
  // refused, and never resolved by position. The path is the identity.
  if (matches.length > 1) {
    die(
      `test-pin: '${key}' names ${matches.length} pins in this manifest, so it does not identify ` +
        "one. Pass --path with the pin's own path array, which list_pins reports.",
    )
  }
  return matches[0] as OrderedPin
}

/** Remove the entry, or restore the tree and end the phase. */
const removePin = async (session: Session, pin: OrderedPin): Promise<void> => {
  if (session.overrideFile === 'pnpm-workspace.yaml') {
    const status = removeWorkspaceKey(session.worktree, pin.key)
    if (status === 0) return
    await restoreTree(session, pin.key)
    failPhase(
      'install',
      status === 2
        ? `the pnpm-workspace.yaml overrides block carries no entry '${pin.key}', so nothing was ` +
            'removed and an install of it would have been an install of the manifest this audit started with.'
        : `the pnpm-workspace.yaml overrides block could not be edited to remove '${pin.key}'. ` +
            "This driver reads exactly the flat 'key: value' block the adapter round-trips and " +
            'refuses anything else, because a wrong write corrupts a file pnpm reads on every install.',
    )
  }
  const root = stateValue(
    session,
    'install',
    'override_root',
    isList,
    'type == "array"',
    "the override block's address",
  )
  const error = removeManifestPaths(session.worktree, root, [pin.path])
  if (error === null) return
  await restoreTree(session, pin.key)
  failPhase(
    'install',
    `package.json could not be rewritten to remove ${render(pin.path, null)}, so the manifest ` +
      'does not parse and every verdict measured against an install of it would be fiction. The ' +
      `file was restored, not repaired by re-editing around the error. Quoting the error: ${error}`,
  )
}

/**
 * Whether `list_pins` still lists a pin at `path`. The answer is an object,
 * which `promised` checked. Pins that cannot be read list it.
 */
const stillListed = (answer: unknown, path: readonly string[]): boolean => {
  const pins = (answer as Record<string, unknown>).pins
  return !Array.isArray(pins) || pins.some((pin) => !isRecord(pin) || equal(pin.path, path))
}

/** Check against phase 2's count that the edit landed, or restore and end the phase. */
const verifyRemoval = async (session: Session, pin: OrderedPin, count: number): Promise<void> => {
  const after = onTree(session, (tree) => session.adapter.listPins(tree))
  if (after.outcome !== 'ok') {
    await restoreTree(session, pin.key)
    failPhase('install', `list_pins failed after removing ${pin.key}: ${after.error}`)
  }
  const afterCount = promised(
    'install',
    after.value,
    `list_pins (after removing ${pin.key})`,
    'count',
  )
  if (stillListed(after.value, pin.path)) {
    await restoreTree(session, pin.key)
    failPhase(
      'install',
      `the entry at ${render(pin.path, null)} is still present after the removal of ${pin.key}, ` +
        'so the install would have been an install of the manifest this audit started with and ' +
        'the verdict would have read as a tested removal.',
    )
  }
  if (afterCount !== count - 1) {
    await restoreTree(session, pin.key)
    failPhase(
      'install',
      `removing ${pin.key} left ${toText(afterCount)} pins where phase 2 counted ${count}, and one ` +
        `less is ${count - 1}. An edit that silently matched nothing, or that matched a similar key ` +
        'elsewhere in the manifest, produces exactly this.',
    )
  }
}

/** Record a finding, restore the tree, and give the answer of the step. */
const finish = async (
  session: Session,
  pin: OrderedPin,
  finding: JsonObject,
): Promise<JsonValue> => {
  recordFinding(session, finding)
  await restoreTree(session, pin.key)
  return { status: 'ok', step: 'test-pin', finding }
}

/** What the map says after the removal. */
interface MapAfter {
  readonly now: Resolutions | null
  readonly unreadable: number | null
  readonly refusal: string
}

/** The whole-tree map after the removal, or the reason that there is none. */
const mapAfter = (session: Session, pin: OrderedPin): MapAfter => {
  if (readOptionalValue(session.state, 'map_available') !== true) {
    return {
      now: null,
      unreadable: null,
      refusal:
        optionalText(session, 'map_refusal') ||
        "the with-all-pins baseline found no whole-tree resolution_map, so no other package's resolution was re-checked",
    }
  }
  const map = onTree(session, (tree) => session.adapter.resolutionMap(tree))
  if (map.outcome === 'ok') {
    const description = `the resolution_map taken after removing ${pin.key}`
    const unreadable = mapUnreadable('install', map.value, description)
    const now = resolutionsOf(map.value)
    if (now === null) {
      failPhase(
        'install',
        `${description} carries no resolutions object, so there is nothing to diff this removal against.`,
      )
    }
    return { now, unreadable, refusal: '' }
  }
  return {
    now: null,
    unreadable: null,
    refusal:
      map.outcome === 'not-implemented'
        ? MAP_NOT_IMPLEMENTED
        : `resolution_map refused this lockfile after removing ${pin.key}: ${map.error}`,
  }
}

/** The test-pin phase. */
export const testPin = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: AuditPinsDeps,
): Promise<CommandResult> =>
  settle(async () => {
    const parsed = parseArguments(args, {
      work: { type: 'string', default: '' },
      key: { type: 'string', default: '' },
      path: { type: 'string', default: '' },
    })
    if (parsed.outcome !== 'ok') stop(parsed)
    const { work, key, path } = parsed.value
    if (work === '') die('test-pin: --work is required')
    const session = loadSession(work, env, deps)
    if (key === '' && path === '') die('test-pin requires --key or --path')
    if (readOptionalValue(session.state, 'baseline_done') !== true) {
      die(
        "test-pin: run 'baseline' first. Without the with-all-pins baseline there is nothing to measure a removal against.",
      )
    }
    const pin = pinOf(testOrder(session), key, path)
    const refused = stateValue(
      session,
      'install',
      'baseline_inconclusive',
      isList,
      'type == "array"',
      "the baseline's inconclusive list",
    )
    if (refused.some((entry) => isRecord(entry) && entry.package === pin.package)) {
      die(
        `test-pin: the baseline recorded ${pin.package} inconclusive (present: false), so this ` +
          "pin is not tested. Recording it and never testing it is the baseline's answer, not a step to redo.",
      )
    }
    const count = requiredValue(session, 'pins_count')
    if (typeof count !== 'number') {
      die(
        `the state file at ${session.state.path} has no usable value for 'pins_count': ` +
          `expected a number, found ${JSON.stringify(count)}.`,
      )
    }

    // Steps 1 to 3: remove exactly that entry, and check against phase 2's
    // count that the edit landed, before anything installs.
    await removePin(session, pin)
    await verifyRemoval(session, pin, count)

    // Step 4: the install. An install that fails is a result. It stops this
    // pin, not the run, and a pin is never removable off a failed install.
    const install = await installOnce(session)
    if (!install.ok) {
      return finish(
        session,
        pin,
        inconclusive(
          pin,
          false,
          `the install without this pin failed, so nothing about the removal was observed: ${install.output}`,
          NOT_TO_COMPLETION,
        ),
      )
    }

    // Step 5: what resolves now. A failed parse is never an empty result.
    const resolved = onTree(session, (tree) => session.adapter.resolvedVersions(tree, pin.package))
    if (resolved.outcome !== 'ok') {
      return finish(
        session,
        pin,
        inconclusive(
          pin,
          true,
          'the lockfile could not be parsed for this package after the removal, and a failed ' +
            `parse is never an empty result: ${resolved.error}`,
          NOT_TO_COMPLETION,
        ),
      )
    }
    const { present, versions: withoutPin } = resolvedList(
      'install',
      resolved.value,
      `resolved_versions ${pin.package} (after removing ${pin.key})`,
    )
    // The snapshot of the baseline must be there: a missing one read as an
    // empty one makes each version that resolves now look newly admitted.
    const snapshots = stateValue(
      session,
      'install',
      'baseline_packages',
      isList,
      'type == "array"',
      'the with-all-pins baseline snapshots',
    )
    const snapshot = snapshots.find((entry) => isRecord(entry) && entry.package === pin.package)
    const withPin = isRecord(snapshot) ? snapshot.versions : null
    if (!Array.isArray(withPin)) {
      failPhase(
        'install',
        `the with-all-pins baseline holds no snapshot for ${pin.package}, so there is nothing to ` +
          'measure this removal against. Run baseline before test-pin; a missing snapshot read as ' +
          'an empty one would make every version resolving now look newly admitted.',
      )
    }

    // Step 6: the whole-tree map. Zero unread entries is the strongest claim
    // of coverage, so a count that nobody read is null and never zero (#48).
    const baseMap = stateValue(
      session,
      'install',
      'baseline_map',
      (value): value is JsonObject | null => value === null || isRecord(value),
      'type == "object" or type == "null"',
      'the with-all-pins baseline resolution_map',
    )
    const baseUnreadable = readOptionalValue(session.state, 'baseline_unreadable_entries')
    const after = mapAfter(session, pin)
    let refusal = after.refusal
    const wholeTree = after.now !== null && baseUnreadable === 0 && after.unreadable === 0

    // The two verbs must agree about the tested package.
    const disagreement =
      after.now === null ? null : disagreementOf(after.now, pin.package, withoutPin)
    if (disagreement !== null) {
      return finish(session, pin, {
        ...pin,
        status: 'inconclusive',
        tested: true,
        detail: disagreement.detail as string,
        disagreement,
        collateral_not_checked_reason: NOT_TO_COMPLETION,
        resolved_with_pin: withPin,
        resolved_without_pin: withoutPin,
        attributable_versions: null,
        ...UNJUDGED,
      })
    }

    // The versions of this pin are the ones that resolve after the removal
    // and not in the baseline. The whole list also holds the copies that a
    // sibling pin or another parent gives.
    const delta = minus(withoutPin, withPin as unknown[])
    let collateral: JsonValue = null
    let families: JsonValue = []
    let collateralVerdict: JsonValue = null
    if (wholeTree) {
      const base = resolutionsOf(baseMap)
      if (base === null) {
        failPhase(
          'install',
          "this pin's finding could not be assembled, so nothing was recorded for it.",
        )
      }
      const moved = collateralOf(base, after.now as Resolutions, pin.package)
      collateral = moved.changes
      families = moved.families
    } else {
      collateralVerdict = 'not-checked'
      // A map that was read in part is its own reason, and it comes before
      // an absent one: the report owes the count of unread entries (#48).
      if (after.now !== null) {
        refusal =
          `the resolution_map could not read ${optionalText(session, 'baseline_unreadable_entries')} ` +
          `lockfile entries at the baseline and ${after.unreadable} after this removal, so it is not a whole-tree view`
      }
    }

    // `present: false` after the removal: the pin was the only thing that
    // held the package in the tree, so nothing new resolved to judge.
    return finish(session, pin, {
      ...pin,
      status: 'tested',
      tested: true,
      left_tree: !present,
      detail: present
        ? "tested; the advisory judgment is phase 5's"
        : 'the package is no longer resolved at all: removing this pin took it out of the tree entirely, so nothing new resolved to judge',
      collateral_not_checked_reason: refusal === '' ? null : refusal,
      resolved_with_pin: withPin,
      resolved_without_pin: withoutPin,
      attributable_versions: delta as JsonValue[],
      sibling_pins: [],
      collateral_changes: collateral,
      collateral_verdict: collateralVerdict,
      sampled_families: families,
      whole_tree_view: wholeTree,
      unreadable_entries: { baseline: countOrNull(baseUnreadable), without_pin: after.unreadable },
      advisory_verdict: null,
      advisory_count: null,
      matched_ranges: [],
    })
  })
