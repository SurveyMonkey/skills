// `audit-pins baseline`: the head of phase 4, the port of `cmd_baseline` in
// `scripts/common/audit-pins-driver.sh`. It runs one install for the whole
// audit, and reads the two baselines that each pin is measured against: the
// whole-tree map, and `resolved_versions` of each package that a testable
// pin names. The contract is in the header of `audit-pins.ts`.
//
// This file ships. It imports nothing outside the plugin.

import { toText } from '../adapters/node/jq-json.ts'
import type { CommandResult } from '../cli/command.ts'
import { uniqueJq } from '../jq.ts'
import { parseArguments } from '../lib/args.ts'
import type { JsonObject, JsonValue } from '../lib/envelope.ts'
import {
  type AuditPinsDeps,
  die,
  failPhase,
  inconclusive,
  loadSession,
  mapUnreadable,
  onTree,
  promised,
  resolutionsOf,
  resolvedList,
  setFindings,
  setKey,
  settle,
  stop,
  testOrder,
} from './audit-pins-common.ts'
import { installOnce } from './fix-group-common.ts'

/** The words of a `resolution_map` that the adapter does not implement. */
export const MAP_NOT_IMPLEMENTED =
  "the adapter does not implement resolution_map, so no other package's resolution was re-checked"

/** The baseline phase. */
export const baseline = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: AuditPinsDeps,
): Promise<CommandResult> =>
  settle(async () => {
    const parsed = parseArguments(args, { work: { type: 'string', default: '' } })
    if (parsed.outcome !== 'ok') stop(parsed)
    if (parsed.value.work === '') die('baseline: --work is required')
    const session = loadSession(parsed.value.work, env, deps)

    // The name of the lockfile comes from the adapter, never from `pm`: a
    // restore of a file that is not there fails where the check of the
    // restore cannot see it.
    const detected = session.tree()
    if (detected.outcome !== 'ok') {
      failPhase(
        'install',
        `adapter detect failed, so the lockfile this phase restores between every pin has no name: ${detected.error}`,
      )
    }
    const lockfile = toText(
      promised('install', detected.value.detection, 'adapter detect', 'lockfile'),
    )
    setKey(session, 'lockfile', lockfile)

    // One install for the whole audit. The tree is restored between pins, so
    // both baselines stay valid for each pin. A tree that could not be built
    // is never the baseline: a package manager that rewrote part of the
    // lockfile before it failed changes the result of each pin.
    const install = await installOnce(session)
    if (!install.ok) {
      failPhase(
        'install',
        'the with-all-pins baseline install failed, so no pin was tested. One failure reported ' +
          'honestly beats a whole audit of plausible-looking verdicts. Quoting the package ' +
          `manager: ${install.output}`,
      )
    }

    // A map that the adapter does not implement and a map that fails take
    // two routes. The first has no whole-tree view, so each verdict covers
    // the named package only. The second is a parser that refuses this
    // lockfile, and that refusal is the answer (audit-driver.md).
    const map = onTree(session, (tree) => session.adapter.resolutionMap(tree))
    let mapAvailable = false
    let baseMap: JsonValue = null
    let unreadable: number | null = null
    if (map.outcome === 'ok') {
      mapAvailable = true
      baseMap = map.value as unknown as JsonObject
      unreadable = mapUnreadable('install', map.value, 'the with-all-pins baseline resolution_map')
      if (resolutionsOf(map.value) === null) {
        failPhase(
          'install',
          'the baseline resolution_map carries no resolutions object, so there is nothing to diff a removal against.',
        )
      }
    } else if (map.outcome === 'not-implemented') {
      setKey(session, 'map_refusal', MAP_NOT_IMPLEMENTED)
    } else {
      failPhase(
        'install',
        `the baseline resolution_map failed on this lockfile: ${map.error}. A parser that ` +
          'refuses a lockfile it could not read is answering, and a diff against a map that was ' +
          'never built reports every package unchanged.',
      )
    }

    // One `resolved_versions` for each package that a testable pin names.
    const order = testOrder(session)
    const packages: JsonObject[] = []
    const refused: JsonObject[] = []
    for (const pkg of uniqueJq(order.map((pin) => pin.package))) {
      const answer = onTree(session, (tree) => session.adapter.resolvedVersions(tree, pkg))
      if (answer.outcome !== 'ok') {
        failPhase(
          'install',
          `the baseline lockfile could not be parsed for ${pkg} (resolved_versions): ` +
            `${answer.error}. A failed parse is never an empty result.`,
        )
      }
      const { present, versions } = resolvedList(
        'install',
        answer.value,
        `resolved_versions ${pkg} (the with-all-pins baseline)`,
      )
      if (!present) {
        // The manifest pins this package and the tree was just installed
        // from it. So `present: false` is a claim of the parser about itself,
        // and each later step reads it as the cue for `removable` (#44, #46).
        refused.push({
          package: pkg,
          baseline: answer.value as unknown as JsonObject,
          detail:
            `the with-all-pins baseline reports present: false for ${pkg}, which the manifest ` +
            'pins and the tree was just installed from. That is a claim the parser is making about ' +
            'itself, not about the tree, and every later step reads present: false as "the ' +
            'package left the tree" \u2014 this flow\'s cue for removable (#44, #46). The pin was ' +
            'not tested.',
        })
      }
      packages.push({ package: pkg, present, versions })
    }

    setKey(session, 'baseline_map', baseMap)
    setKey(session, 'map_available', mapAvailable)
    setKey(session, 'baseline_unreadable_entries', unreadable)
    setKey(session, 'baseline_packages', packages)
    setKey(session, 'baseline_inconclusive', refused)
    setKey(session, 'baseline_done', true)

    // Each pin on a package with `present: false` is recorded inconclusive
    // here, and never tested.
    setFindings(
      session,
      order.flatMap((pin) => {
        const bad = refused.find((entry) => entry.package === pin.package)
        return bad === undefined
          ? []
          : [
              inconclusive(
                pin,
                false,
                bad.detail as string,
                'this pin was never tested, so no other package in the tree was compared',
              ),
            ]
      }),
    )

    const refusedPackages = refused.map((entry) => entry.package)
    return {
      status: 'ok',
      step: 'baseline',
      lockfile,
      resolution_map_available: mapAvailable,
      unreadable_entries: unreadable,
      whole_tree_view: mapAvailable && unreadable === 0,
      packages,
      inconclusive: refused,
      test_order: order.filter((pin) => !refusedPackages.includes(pin.package)),
    }
  })
