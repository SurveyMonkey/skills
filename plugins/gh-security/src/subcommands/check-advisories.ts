// `gh-security check-advisories [--env-prefix <prefix>] [--ecosystem <eco>]
// [--version <v>] <package>`: every published advisory range for one package.
// This is the port of `scripts/common/check-advisories.sh`.
//
// Output: `{package, ecosystem, advisory_count, withdrawn_excluded,
// vulnerable_ranges[], advisories[], version, matched_ranges[],
// unevaluated_ranges[], adapter_errors[], verdict}`.
//
// `--ecosystem` defaults to `npm`. It is not a fallback: a caller that routes
// a package of another ecosystem must pass its ecosystem, because the
// advisories endpoint matches names for each registry, and the same name
// exists in several.
//
// This is the pin audit's source of truth for whether a pinned package is
// still dangerous. It unions the vulnerable ranges of **every published
// advisory** for the package, and not the advisory that prompted the pin. A
// pin keeps vulnerable versions out of the lockfile, so an advisory that is
// published after the pin never matched an installed version, and never
// became a Dependabot alert. A judgment from the alert history asks whether
// anything was reported while the pin protected the repository. The answer is
// no by construction.
//
// With `--version`, each range is evaluated against that version by the
// `range_facts` verb of the adapter for the ecosystem, because what a range
// admits is a question for the ecosystem (ADR 001). The adapter comes from the
// registry, in process.
//
// Verdicts, and why there are four:
//   vulnerable    - at least one advisory range admits the version.
//   safe          - advisories exist, every range was evaluated, none matched.
//   unknown       - no range matched, but one could not be evaluated. It is
//                   never safe, because the range that could not be evaluated
//                   is where an unnoticed match would hide.
//   no-advisories - the query succeeded and returned nothing for this
//                   package. It is NOT a synonym for safe. A pin may exist
//                   for a reason that is not security, and a misspelled name
//                   or the wrong ecosystem gives the same empty answer.
// With no `--version` the verdict is null, except `no-advisories` when the
// query returned nothing.
//
// Carried over from the script: an advisory with no range gives no range to
// evaluate. With `--version`, a package whose advisories all lack a range reads
// as `safe`.
//
// A `range_facts` answer without `parseable` or `satisfied` is an error (ADR
// 001). A verb that fails is not an error: its range is unevaluated, and the
// failure goes into `adapter_errors`, so a broken adapter shows its cause
// rather than an audit where every pin is inconclusive. An answer with
// `parseable` true and a `satisfied` that is not true or false is treated the
// same way (ruling 12 on #225). The script read the text `true` as a match, and
// read each other value of that kind as no match. A `parseable` that is not
// true or false is also an `adapter_errors` entry (#302). A `parseable` of
// false is an answer: the range is unevaluated, with no entry.
//
// `--env-prefix` is the opaque command prefix that the environment needs
// (issue #193). It wraps the runner that the `gh` client uses, so `gh` runs as
// `<prefix> gh ...`. Nothing here names a tool, or looks for one.
//
// Differences from the script:
//   - The script takes `--adapter <path>` beside `--version`. There is no path
//     here, because the adapter is in process. `--version` alone asks for a
//     verdict, and the adapter comes from `--ecosystem`. `--adapter` is an
//     unknown option.
//   - `--version` for an ecosystem with no adapter is exit 3, unsupported, and
//     asks GitHub nothing. The script has no such answer: its caller gives it
//     an adapter path, and it never looks at the ecosystem.
//   - `adapter_errors[].error` is the message of the failed verb. The script
//     quoted the text that its child wrote on stderr.
//   - The package and the ecosystem are encoded in the query. The script put
//     them in as they were.
//   - A parseable range with a `satisfied` that is not true or false is
//     unevaluated and goes into `adapter_errors`. The script counted the text
//     `true` as a match, and each other such value as no match, so a package
//     could read `safe` (ruling 12).
//   - A `parseable` that is not true or false is unevaluated, and goes into
//     `adapter_errors` (#302). The script read the text `true` as true. A
//     `parseable` of false is unevaluated, with no entry.
//   - A failure is `{"error": ...}` on stdout and prose on stderr, as
//     `cli.md` says. The script wrote the JSON on stderr.
//
// This file ships. It imports nothing outside the plugin.

import { type selectAdapter as select, selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import {
  exitCodeFor,
  failed,
  type JsonObject,
  type JsonValue,
  ok,
  unsupported,
} from '../lib/envelope.ts'
import { createGhClient, type GhClient, type GhClientOptions, GhError } from '../lib/gh.ts'
import { type Runner, run } from '../lib/process.ts'

const USAGE =
  'usage: gh-security check-advisories [--env-prefix <prefix>] [--ecosystem <eco>] ' +
  '[--version <v>] <package>'

/** How a `gh` client is made. A test gives its own. */
export type ClientFactory = (options: GhClientOptions) => GhClient

/**
 * The default of `--version`. A real argument cannot hold a NUL, so no
 * command line can give this value, and an empty `--version` stays distinct
 * from an absent one.
 */
const NOT_GIVEN = '\0'

/** How much of the message of a failed verb goes into `adapter_errors`. */
const SHOWN_CHARACTERS = 300

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A field of an object as JSON. A field that is not there reads `null`, as in jq. */
const field = (object: Record<string, unknown>, name: string): JsonValue =>
  (object[name] ?? null) as JsonValue

/** Unique and sorted by the bytes of the text, as jq's `unique` sorts. */
const uniqueSorted = (texts: readonly string[]): string[] =>
  [...new Set(texts)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))

/** The vulnerability entries of an advisory. A missing list is an empty one. */
const vulnerabilitiesOf = (advisory: Record<string, unknown>): Record<string, unknown>[] => {
  const list = advisory.vulnerabilities
  if (list === undefined || list === null) return []
  if (!Array.isArray(list) || !list.every(isRecord)) {
    throw new Error(
      `the vulnerabilities of ${field(advisory, 'ghsa_id')} are not a list of objects`,
    )
  }
  return list
}

/** Whether an entry is about this package in this ecosystem. */
const isAbout = (entry: Record<string, unknown>, name: string, ecosystem: string): boolean => {
  const target = entry.package
  if (target === undefined || target === null) return false
  if (!isRecord(target)) throw new Error('a vulnerability has a package that is not an object')
  return target.name === name && target.ecosystem === ecosystem
}

/** The range of an entry, or null. */
const rangeOf = (entry: Record<string, unknown>): string | null => {
  const range = entry.vulnerable_version_range
  if (range === undefined || range === null) return null
  if (typeof range !== 'string') throw new Error('a vulnerable_version_range is not text')
  return range
}

interface Listing {
  readonly withdrawn: number
  readonly advisories: JsonObject[]
  readonly ranges: string[]
}

/**
 * The advisories that are about the package. `affects` filters the advisory
 * and not its entries, so an advisory that the query returned still holds
 * entries for other packages. The name is matched exactly. A withdrawn
 * advisory is one that GitHub retracted, and a pin is not held for it.
 */
const listing = (
  all: readonly Record<string, unknown>[],
  name: string,
  ecosystem: string,
): Listing => {
  const about = all.filter((advisory) =>
    vulnerabilitiesOf(advisory).some((entry) => isAbout(entry, name, ecosystem)),
  )
  const kept = about.filter(
    (advisory) => advisory.withdrawn_at === undefined || advisory.withdrawn_at === null,
  )
  const entries = kept.flatMap((advisory) =>
    vulnerabilitiesOf(advisory)
      .filter((entry) => isAbout(entry, name, ecosystem))
      .map((entry) => {
        const patched = entry.first_patched_version
        const range = rangeOf(entry)
        const json: JsonObject = {
          ghsa_id: field(advisory, 'ghsa_id'),
          cve_id: field(advisory, 'cve_id'),
          severity: field(advisory, 'severity'),
          type: field(advisory, 'type'),
          published_at: field(advisory, 'published_at'),
          summary: field(advisory, 'summary'),
          url: field(advisory, 'html_url'),
          vulnerable_version_range: range,
          first_patched_version: isRecord(patched)
            ? field(patched, 'identifier')
            : ((patched ?? null) as JsonValue),
        }
        return { json, range }
      }),
  )
  const advisories = entries.map((entry) => entry.json)
  const ranges = uniqueSorted(
    entries.flatMap((entry) => (entry.range === null ? [] : [entry.range])),
  )
  return { withdrawn: about.length - kept.length, advisories, ranges }
}

/** The error text of a failed verb: one line, cut, with no white space at the end. */
const oneLine = (text: string): string =>
  text
    .replaceAll('\n', ' ')
    .slice(0, SHOWN_CHARACTERS)
    .replace(/[ \t\n\v\f\r]+$/, '')

/**
 * The handler. The `gh` client factory, the process runner and the registry
 * are parameters: an example gives a mock client, a runner that records its
 * argv, or an adapter whose `range_facts` is broken.
 */
export const checkAdvisories = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
  route: typeof select,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, {
    'env-prefix': { type: 'string', default: '' },
    ecosystem: { type: 'string', default: 'npm' },
    version: { type: 'string', default: NOT_GIVEN },
  })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals } = parsed.value
  const name = positionals[0] ?? ''
  if (options.ecosystem === '' || options.version === '' || name === '') return failed(USAGE)
  const { ecosystem } = options
  const version = options.version === NOT_GIVEN ? null : options.version

  // The adapter is chosen before GitHub is asked: with no adapter there is
  // nothing to evaluate the ranges with.
  const adapter = version === null ? null : route(ecosystem)
  if (adapter?.supported === false) {
    return unsupported(
      ecosystem,
      `check-advisories cannot evaluate ranges for the ecosystem ${ecosystem}: ${adapter.reason}.`,
    )
  }

  const prefix = parseEnvPrefix(options['env-prefix'])
  const prefixed: Runner = (command, args = [], runOptions) => {
    const line = withEnvPrefix(prefix, { command, args })
    return spawn(line.command, line.args, runOptions)
  }
  let all: readonly Record<string, unknown>[]
  try {
    all = await makeClient({ env: context.env, run: prefixed }).listAdvisories({
      package: name,
      ecosystem,
    })
  } catch (error) {
    if (!(error instanceof GhError)) throw error
    return failed(`Failed to fetch advisories for ${name} (${ecosystem}): ${error.detail}`)
  }

  let found: Listing
  try {
    found = listing(all, name, ecosystem)
  } catch (error) {
    // Only a shape that this command cannot read throws here.
    return failed(
      `Failed to parse advisories for ${name} (${ecosystem}): ${(error as Error).message}`,
    )
  }

  const matched: string[] = []
  const unevaluated: string[] = []
  const adapterErrors: JsonObject[] = []
  if (adapter?.supported === true && version !== null) {
    for (const range of found.ranges) {
      const answer = adapter.adapter.rangeFacts(range, version)
      if (answer.outcome !== 'ok') {
        // Keep what the adapter said. A broken adapter then names its cause,
        // and the range stays unevaluated, never folded into "safe".
        adapterErrors.push({ range, status: exitCodeFor(answer), error: oneLine(answer.error) })
        unevaluated.push(range)
        continue
      }
      const facts: object = answer.value
      if (!('parseable' in facts) || !('satisfied' in facts)) {
        return failed(
          `check-advisories: adapter's range_facts omitted parseable/satisfied for '${range}'; ` +
            'the contract requires both (ADR 001).',
        )
      }
      if (typeof facts.parseable !== 'boolean') {
        // A range is readable or it is not: `parseable` is a boolean in
        // `RangeFactsAnswer`. Any other value is a broken answer, and it goes
        // into `adapter_errors` (issue #302).
        adapterErrors.push({
          range,
          status: 1,
          error: `range_facts gave a parseable that is not true or false (ADR 001): ${JSON.stringify(facts.parseable)}`,
        })
        unevaluated.push(range)
      } else if (!facts.parseable) unevaluated.push(range)
      else if (typeof facts.satisfied !== 'boolean') {
        // A parseable range has a truth value (ADR 001). Without one, the range
        // is not evaluated, and it must never count toward `safe` (ruling 12).
        adapterErrors.push({
          range,
          status: 1,
          error: `range_facts gave parseable true and a satisfied that is not true or false (ADR 001): ${JSON.stringify(facts.satisfied)}`,
        })
        unevaluated.push(range)
      } else if (facts.satisfied) matched.push(range)
    }
  }

  const matchedRanges = uniqueSorted(matched)
  const unevaluatedRanges = uniqueSorted(unevaluated)
  let verdict: string | null = null
  if (found.advisories.length === 0) verdict = 'no-advisories'
  else if (version !== null) {
    if (matchedRanges.length > 0) verdict = 'vulnerable'
    else verdict = unevaluatedRanges.length > 0 ? 'unknown' : 'safe'
  }
  return ok({
    package: name,
    ecosystem,
    advisory_count: found.advisories.length,
    withdrawn_excluded: found.withdrawn,
    vulnerable_ranges: found.ranges,
    advisories: found.advisories,
    version,
    matched_ranges: matchedRanges,
    unevaluated_ranges: unevaluatedRanges,
    adapter_errors: adapterErrors,
    verdict,
  })
}

export const checkAdvisoriesCommand: CommandHandler = (context) =>
  checkAdvisories(context, createGhClient, run, selectAdapter)
