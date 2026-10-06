// `gh-security score-merge-risk --package <pkg> --after <version>
// --why-json <file|-> --override-scope <none|scoped|bare-tightened|bare-added>
// --declared-range <range|none> [--declared-range <range>]...
// [--before <version>]`: the merge-risk rating of one fix. This is the CLI
// of `src/merge-risk/score.ts`, and the port of the command line of
// `scripts/common/score-merge-risk.sh` (#233).
//
// It runs from the root of the tree being scored. `--why-json -` reads the
// why payload from stdin. `--declared-range` is required: one for each
// distinct range that a dependent declares, or the one sentinel `none`.
//
// `fix-group score` calls the scorer in process. This command is for a
// prompt that scores a fix outside the fix driver: the audit-pins agent
// scores each pin removal this way, and #237 moves it from the script to
// this command.
//
// Differences from the script, each declared with #233:
//   - There is no `--adapter`. The adapter is the node one, from the
//     registry, in process. `--adapter` is an unknown argument.
//   - A failure is `{"error": ...}` on stdout, with the same message on
//     stderr. The script wrote the JSON to stderr.
//   - A why file that cannot be read is a why payload with no JSON object.
//     The script stopped with the error of `cat`.
//   - The tree is the directory of the process, by its physical path. The
//     script named `$PWD`.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { type selectAdapter as select, selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { failed, ok } from '../lib/envelope.ts'
import {
  isOverrideScope,
  SCOPE_ERROR,
  scoreMergeRisk as score,
  withoutBom,
} from '../merge-risk/score.ts'

/** The flags that take a value. Each other word is an unknown argument. */
const FLAGS = [
  '--package',
  '--before',
  '--after',
  '--why-json',
  '--override-scope',
  '--declared-range',
]

/** The flags that must be there, in the order the script checks them. */
const REQUIRED = ['--package', '--after', '--why-json', '--override-scope']

/** Read the why payload: stdin for `-`, else the file. Undefined when nothing parses. */
const readWhy = (path: string | null, context: CommandContext): unknown => {
  try {
    return JSON.parse(
      withoutBom(path === null ? context.io.readStdin() : readFileSync(path, 'utf8')),
    )
  } catch {
    return undefined
  }
}

/**
 * The handler. The registry is a parameter, so an example can give an
 * adapter whose answers break the contract. `cwd` is the root of the tree
 * being scored, and a relative `--why-json` is relative to it.
 */
export const scoreMergeRisk = (
  context: CommandContext,
  route: typeof select,
  cwd: string,
): CommandResult => {
  const values = new Map<string, string>()
  const ranges: string[] = []
  const args = context.args
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string
    if (!FLAGS.includes(flag)) return failed(`Unknown argument: ${flag}`)
    const value = args[index + 1] ?? ''
    if (value === '') return failed(`${flag} requires a value`)
    if (flag === '--declared-range') ranges.push(value)
    else values.set(flag, value)
  }
  const missing = REQUIRED.find((flag) => !values.has(flag))
  if (missing !== undefined) return failed(`Missing required argument: ${missing}`)
  if (ranges.length === 0) {
    return failed(
      'Missing required argument: --declared-range. Pass one per distinct range a dependent ' +
        'declares, or --declared-range none if none could be read.',
    )
  }
  const stated = ranges.filter((range) => range !== 'none')
  if (stated.length > 0 && stated.length < ranges.length) {
    return failed(
      '--declared-range none states that no ranges could be read; it cannot be combined with ' +
        'declared ranges',
    )
  }
  const scope = values.get('--override-scope') as string
  if (!isOverrideScope(scope)) return failed(SCOPE_ERROR)
  const whyJson = values.get('--why-json') as string
  const whyPath = whyJson === '-' ? null : resolve(cwd, whyJson)
  if (whyPath !== null && !statSync(whyPath, { throwIfNoEntry: false })?.isFile()) {
    return failed(
      `--why-json file not found: ${whyJson}. The classification it carries decides F2 and the ` +
        'whole affected surface, so there is nothing to fall back to.',
    )
  }
  const routed = route('npm')
  if (!routed.supported) return failed(routed.reason)
  const adapter = routed.adapter
  const report = score(
    {
      package: values.get('--package') as string,
      before: values.get('--before') ?? '',
      after: values.get('--after') as string,
      why: readWhy(whyPath, context),
      whyLabel: whyJson,
      overrideScope: scope,
      declaredRanges: stated.length > 0 ? stated : 'none',
    },
    {
      name: routed.name,
      compareVersions: adapter.compareVersions,
      rangeFacts: adapter.rangeFacts,
    },
    cwd,
  )
  return report.outcome === 'ok' ? ok(report.value) : report
}

/** The registry entry: the handler, with the directory of the process as the tree. */
export const scoreMergeRiskCommand: CommandHandler = (context) =>
  scoreMergeRisk(context, selectAdapter, process.cwd())
