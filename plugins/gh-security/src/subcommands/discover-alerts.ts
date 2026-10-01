// `gh-security discover-alerts [--env-prefix <prefix>] [--branch-style slash|flat]
// [--stdin] <owner/repo>`: read the open Dependabot alerts of one repository,
// and rank them in groups, one for each package major line. This is the port
// of `scripts/common/discover-alerts.sh`.
//
// One repository for each call. The repositories in scope are the checkouts on
// disk, and `discover-repos` names them (ADR 011).
//
// Output: `{actionable, skipped}`.
//   actionable  groups with a fix and no open pull request, sorted by
//               severity, then EPSS, then package, then major line.
//   skipped     groups with no fix, with an open pull request, or with a
//               search for one that failed, each with its `reason`.
//
// Each group: `{package, ecosystem, major_line, max_severity,
// max_epss_percentile, alert_count, alerts[], sibling_alerts[],
// highest_fixed_version, branch_name, repo}`. A skipped group also has
// `reason`. A group with an open pull request also has `open_pr_url`, and a
// group whose search failed also has `error`. Each alert: `{number, cve, ghsa,
// severity, summary, vulnerable_range, fixed_in, epss_percentile,
// relationship, manifest}`.
//
// **One group for each package major line, not for each package** (#19). A
// package that resolves at several majors has a different patched version on
// each line, and a fix of one line leaves the others vulnerable. The line is
// the first number of `first_patched_version`. The read first removes the
// white space at each end, and each `v` and `=` at the start. An identifier
// with no plain first number has no usable line. Its line is `none`, and its
// group is skipped.
//
// `sibling_alerts` names every OTHER line of the same package, skipped lines
// too: its major (null for `none`) and the unique ranges of its alerts. The
// fix agent gives it to `validate --sibling-alerts` (#105). `[]` is a claim:
// no other line of this package has open alerts.
//
// `highest_fixed_version` comes from the adapter's `compare_versions`, in
// process, because semver and PEP 440 do not agree (ADR 001). A comparison
// that fails, or that gives no usable result, is an error (#39). For an
// ecosystem with no adapter, the order is the version sort of GNU `sort -V`,
// because the group only shows that some fix exists.
//
// `--branch-style` picks the form of each `branch_name`:
// `fix/dependabot-<package>-<line>x` (`slash`, the default) or
// `fix-dependabot-<package>-<line>x` (`flat`). A line of `none` ends in
// `-unfixed`. A remote with a branch named `fix` refuses every `fix/*` push
// (#123). The caller probes the remote and gives the style.
//
// **The open pull request check** asks GitHub, for each group with a fix, if
// an open pull request has one of these heads:
//   - the group's own branch;
//   - under the slash style, the flat name too, because a repository can
//     flip back from flat;
//   - for the newest line of a package under the slash style, the name from
//     before the split into lines, `fix/dependabot-<package>`.
// A search that fails skips the group with `PR check failed`. It never reads
// as "no pull request".
//
// **`--stdin` reads the alerts from stdin** (#54), in the shape that the
// alerts endpoint gives: a list of pages of alerts, or a list of alerts. Only
// the fetch moves. The groups, their order, the names and the open pull
// request check are the same, so the same alerts give the same output. This
// lets a caller group the alerts again with another `--branch-style`, with no
// second fetch. An alert with a `repository` must name the target, so alerts
// of two repositories never go into one answer.
//
// `--env-prefix` is the opaque command prefix that the environment needs
// (issue #193). It wraps the runner that the `gh` client uses, so `gh` runs as
// `<prefix> gh ...`. Nothing here names a tool, or looks for one.
//
// Differences from the script:
//   - Each call to GitHub names the host `github.com`. A bare `owner/repo`
//     follows `GH_HOST`, and could ask another server.
//   - The target must be `<owner>/<repo>`, and one target only. The script
//     takes the last word, and gives any word to the alerts path.
//   - An alert must be an object. The script drops a null alert with no word.
//   - A package name must be text. The script fails on most other values.
//   - `--stdin` and the `repository` check are new (#54).
//   - The version sort for an ecosystem with no adapter is GNU's, without its
//     rule for an empty name. No candidate is empty.
//   - A line that ends in a line break, as in the identifier `"7\n.1.0"`, is
//     not a number to jq 1.8, so the grouping fails (`jq.ts`).
//   - A failure is `{"error": ...}` on stdout and prose on stderr, as
//     `cli.md` says. The script wrote the JSON on stderr.
//
// This file ships. It imports nothing outside the plugin.

import { type selectAdapter as select, selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import {
  compareJq,
  fieldOf,
  majorNumber,
  majorOf,
  orElse,
  pathOf,
  sortJq,
  tostring,
  uniqueJq,
} from '../jq.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import { createGhClient, type GhClient, type GhClientOptions, GhError } from '../lib/gh.ts'
import { type Runner, type RunResult, run } from '../lib/process.ts'

const USAGE =
  'usage: gh-security discover-alerts [--env-prefix <prefix>] [--branch-style slash|flat] ' +
  '[--stdin] <owner/repo>'

/** How a `gh` client is made. A test gives its own. */
type ClientFactory = (options: GhClientOptions) => GhClient

type Style = 'slash' | 'flat'

/** The one host that this command asks. */
const GITHUB_HOST = 'github.com'

/** `<owner>/<repo>`: two names, with no slash and no white space in either. */
const TARGET = /^([^/\s]+)\/([^/\s]+)$/

/** Text without the newlines at its end, as `$( )` removes them. */
const chomp = (text: string): string => text.replace(/\n+$/, '')

/** The rank of a severity: critical first, and any other word last. */
const severityRank = (severity: unknown): number => {
  if (severity === 'critical') return 0
  if (severity === 'high') return 1
  if (severity === 'medium') return 2
  return severity === 'low' ? 3 : 4
}

const branchName = (style: Style, name: string, line: string): string => {
  const prefix = style === 'flat' ? 'fix-dependabot-' : 'fix/dependabot-'
  return `${prefix}${name}-${line === 'none' ? 'unfixed' : `${line}x`}`
}

/** The name before the split into lines (#19). It is a slash name. */
const legacyName = (name: string): string => `fix/dependabot-${name}`

/** The line of an alert: the major of its patched version, or `none`. */
const lineOf = (alert: unknown): string =>
  majorOf(
    orElse(pathOf(alert, 'security_vulnerability', 'first_patched_version', 'identifier'), ''),
  ) ?? 'none'

/** A group before the open pull request check. */
interface Group {
  readonly fields: JsonObject
  readonly name: string
  readonly line: string
  readonly ecosystem: unknown
  readonly fixedVersions: readonly unknown[]
  readonly newest: boolean
}

/** One alert, as the output gives it. */
const alertOf = (alert: unknown): JsonObject => {
  const identifier = pathOf(alert, 'security_vulnerability', 'first_patched_version', 'identifier')
  const json = {
    number: fieldOf(alert, 'number'),
    cve: pathOf(alert, 'security_advisory', 'cve_id'),
    ghsa: pathOf(alert, 'security_advisory', 'ghsa_id'),
    severity: pathOf(alert, 'security_advisory', 'severity'),
    summary: pathOf(alert, 'security_advisory', 'summary'),
    vulnerable_range: pathOf(alert, 'security_vulnerability', 'vulnerable_version_range'),
    fixed_in: orElse(identifier, 'none'),
    epss_percentile: orElse(pathOf(alert, 'security_advisory', 'epss', 'percentile'), 0),
    relationship: orElse(pathOf(alert, 'dependency', 'relationship'), 'unknown'),
    manifest: orElse(pathOf(alert, 'dependency', 'manifest_path'), 'unknown'),
  }
  return json as JsonObject
}

/** jq's `-(x)`, which stops with an error for a value that is not a number. */
const negated = (value: unknown): number => {
  if (typeof value !== 'number') throw new Error(`${JSON.stringify(value)} cannot be negated`)
  return -value
}

/**
 * The jq program of the script: group by package and line, find the newest
 * line of each package and the siblings of each line, then rank. It throws
 * where jq stops with an error, and for a package name that is not text
 * (the header).
 */
const groupAlerts = (alerts: readonly unknown[]): Group[] => {
  const named = alerts.flatMap((alert) => {
    const name = pathOf(alert, 'dependency', 'package', 'name')
    if (name === null) return []
    if (typeof name !== 'string')
      throw new Error(`a package name is not text: ${JSON.stringify(name)}`)
    return [{ alert, key: [name, lineOf(alert)] as const }]
  })
  const groups: { name: string; line: string; alerts: unknown[] }[] = []
  for (const { alert, key } of named.sort((a, b) => compareJq(a.key, b.key))) {
    const last = groups.at(-1)
    if (last !== undefined && last.name === key[0] && last.line === key[1]) last.alerts.push(alert)
    else groups.push({ name: key[0], line: key[1], alerts: [alert] })
  }

  const newest = new Map<string, number>()
  for (const { name, line } of groups) {
    if (line === 'none') continue
    newest.set(name, Math.max(newest.get(name) ?? Number.NEGATIVE_INFINITY, majorNumber(line)))
  }

  const built = groups.map(({ name, line, alerts: members }) => {
    const severities = members.map((alert) => pathOf(alert, 'security_advisory', 'severity'))
    const epss = members.map((alert) =>
      orElse(pathOf(alert, 'security_advisory', 'epss', 'percentile'), 0),
    )
    const maxSeverity = severities.reduce((best, next) =>
      severityRank(next) < severityRank(best) ? next : best,
    )
    const maxEpss = sortJq(epss).at(-1)
    const fields: JsonObject = {
      package: name,
      ecosystem: pathOf(members[0], 'dependency', 'package', 'ecosystem') as JsonValue,
      major_line: line,
      max_severity: maxSeverity as JsonValue,
      max_epss_percentile: maxEpss as JsonValue,
      alert_count: members.length,
      alerts: members.map(alertOf),
    }
    return {
      fields,
      name,
      line,
      ecosystem: fields.ecosystem,
      // An alert with a usable line has an identifier that is not null or
      // false, so the script's `// empty` drops nothing here.
      fixedVersions: members
        .filter((alert) => lineOf(alert) !== 'none')
        .map((alert) =>
          pathOf(alert, 'security_vulnerability', 'first_patched_version', 'identifier'),
        ),
      newest: line !== 'none' && newest.get(name) === majorNumber(line),
      sortKey: [severityRank(maxSeverity), negated(maxEpss), name, line],
    }
  })

  for (const group of built) {
    group.fields.sibling_alerts = built
      .filter((other) => other.name === group.name && other.line !== group.line)
      .map((other) => ({
        major: other.line === 'none' ? null : majorNumber(other.line),
        vulnerable_ranges: uniqueJq(
          (other.fields.alerts as JsonObject[]).map((alert) => alert.vulnerable_range as JsonValue),
        ),
      }))
  }
  return built.sort((a, b) => compareJq(a.sortKey, b.sortKey))
}

/**
 * GNU's `order` in `verrevcmp`: `~` first, then a digit or the end, then a
 * letter, then every other byte.
 */
const order = (byte: number | undefined): number => {
  if (byte === undefined) return 0
  if (isDigit(byte)) return 0
  if (isAlpha(byte)) return byte
  return byte === 0x7e ? -1 : byte + 256
}

const isDigit = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x30 && byte <= 0x39
const isAlpha = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)

/** GNU's `verrevcmp`, over bytes. */
const verrevcmp = (a: Uint8Array, b: Uint8Array): number => {
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const left = order(a[i])
      const right = order(b[j])
      if (left !== right) return left - right
      i += 1
      j += 1
    }
    while (a[i] === 0x30) i += 1
    while (b[j] === 0x30) j += 1
    let firstDiff = 0
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (firstDiff === 0) firstDiff = (a[i] as number) - (b[j] as number)
      i += 1
      j += 1
    }
    if (isDigit(a[i])) return 1
    if (isDigit(b[j])) return -1
    if (firstDiff !== 0) return firstDiff
  }
  return 0
}

/**
 * GNU's `file_prefixlen`: the length without the suffix, which is a run of
 * `.` and a letter or `~`, then letters, digits and `~`, at the end.
 */
const prefixLength = (text: Uint8Array): number => {
  let prefix = 0
  let i = 0
  while (i < text.length) {
    i += 1
    prefix = i
    while (
      i + 1 < text.length &&
      text[i] === 0x2e &&
      (isAlpha(text[i + 1] as number) || text[i + 1] === 0x7e)
    ) {
      i += 2
      while (
        i < text.length &&
        (isAlpha(text[i] as number) || isDigit(text[i]) || text[i] === 0x7e)
      )
        i += 1
    }
  }
  return prefix
}

/**
 * The rank of GNU's rule for a dot at the start: `.` first, then `..`, then
 * each other name with a dot at the start, then every other name.
 */
const dotRank = (text: Uint8Array): number => {
  if (text[0] !== 0x2e) return 3
  if (text.length === 1) return 0
  return text.length === 2 && text[1] === 0x2e ? 1 : 2
}

/**
 * The order of `sort -V` for two candidates: GNU's `filevercmp`, then the
 * bytes, as `sort` breaks a tie. A candidate is never empty, so the rule of
 * `filevercmp` for an empty name is not here.
 */
export const compareVersionText = (a: string, b: string): number => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  const dots = dotRank(left) - dotRank(right)
  if (dots !== 0) return dots
  const leftPrefix = prefixLength(left)
  const rightPrefix = prefixLength(right)
  const first = verrevcmp(left.subarray(0, leftPrefix), right.subarray(0, rightPrefix))
  const whole =
    first !== 0 || (leftPrefix === left.length && rightPrefix === right.length)
      ? first
      : verrevcmp(left, right)
  return whole === 0 ? Buffer.compare(left, right) : whole
}

/**
 * The highest candidate, or an error that the command reports as it is. The
 * caller gives at least one candidate, so the script's `none` for no
 * candidate is not here.
 */
const highestOf = (
  ecosystem: string,
  candidates: readonly string[],
  route: typeof select,
): { readonly highest: string } | { readonly error: string } => {
  const adapter = route(ecosystem)
  let best = ''
  for (const candidate of candidates) {
    if (best === '') {
      best = candidate
      continue
    }
    if (!adapter.supported) {
      if (compareVersionText(candidate, best) >= 0) best = candidate
      continue
    }
    const answer = adapter.adapter.compareVersions(candidate, best)
    if (answer.outcome !== 'ok') {
      return {
        error: `compare_versions failed for ${ecosystem} (${candidate} vs ${best}): ${answer.error}`,
      }
    }
    const value: unknown = answer.value
    const result: unknown =
      typeof value === 'object' && value !== null
        ? (value as { result?: unknown }).result
        : undefined
    if (result === 1) best = candidate
    else if (result !== 0 && result !== -1) {
      return {
        error: `compare_versions returned no usable result for ${ecosystem} (${candidate} vs ${best}): ${JSON.stringify(answer.value)}`,
      }
    }
  }
  return { highest: best }
}

/** The alerts on stdin, or the reason they cannot be read. */
const alertsOnStdin = (text: string, target: string): unknown[] | string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return `Invalid JSON on stdin for ${target}`
  }
  if (!Array.isArray(parsed)) {
    const message = (parsed as { message?: unknown } | null)?.message
    return `Unexpected alerts on stdin for ${target}: ${typeof message === 'string' ? message : 'not a JSON array'}`
  }
  return parsed.flat(Number.POSITIVE_INFINITY)
}

/** Why the alerts cannot be grouped for this target, or null when they can. */
const refusalOf = (alerts: readonly unknown[], target: string): string | null => {
  for (const alert of alerts) {
    // The flat list holds no list, so an object here is not a list.
    if (typeof alert !== 'object' || alert === null) {
      return `an alert is not an object: ${JSON.stringify(alert)}`
    }
    const repository = (alert as Record<string, unknown>).repository
    if (repository === undefined || repository === null) continue
    const fullName = (repository as { full_name?: unknown }).full_name
    if (typeof fullName !== 'string' || fullName.toLowerCase() !== target.toLowerCase()) {
      return `an alert names another repository: ${JSON.stringify(repository)}`
    }
  }
  return null
}

/**
 * The handler. The `gh` client factory, the process runner and the registry
 * are parameters. So an example can give a stand-in client, a runner that
 * records its argv, or an adapter whose `compare_versions` is broken.
 */
export const discoverAlerts = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
  route: typeof select,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, {
    'env-prefix': { type: 'string', default: '' },
    'branch-style': { type: 'string', default: 'slash', choices: ['slash', 'flat'] },
    stdin: { type: 'boolean' },
  })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals } = parsed.value
  if (positionals.length !== 1) return failed(USAGE)
  const target = positionals[0] as string
  const pair = TARGET.exec(target)
  if (pair === null)
    return failed(`discover-alerts needs the repository as <owner>/<repo>: ${target}`)
  const [, owner, repo] = pair as unknown as [string, string, string]
  const style: Style = options['branch-style']

  const prefix = parseEnvPrefix(options['env-prefix'])
  const prefixed: Runner = (command, args = [], runOptions) => {
    const line = withEnvPrefix(prefix, { command, args })
    return spawn(line.command, line.args, runOptions)
  }
  const client = makeClient({ env: context.env, run: prefixed })

  let alerts: readonly unknown[]
  if (options.stdin) {
    const read = alertsOnStdin(context.io.readStdin(), target)
    if (typeof read === 'string') return failed(read)
    alerts = read
  } else {
    try {
      alerts = await client.listDependabotAlerts({ host: GITHUB_HOST, owner, repo })
    } catch (error) {
      if (!(error instanceof GhError)) throw error
      // A gh that exits 0 can still fail: its body is not the promised shape,
      // or a pipe broke. Only the first case is an unexpected response.
      // `cause` is the RunResult of the call (`lib/gh.ts`). A stand-in can
      // give another value.
      const cause = error.cause as Partial<RunResult> | null | undefined
      const broken = (cause?.streamErrors?.length ?? 0) > 0
      return failed(
        error.status === 0 && !broken
          ? `Unexpected API response for ${target}: ${error.detail}`
          : `Failed to fetch alerts for ${target}: ${error.detail}`,
      )
    }
  }
  const refusal = refusalOf(alerts, target)
  if (refusal !== null) return failed(`Unexpected alerts for ${target}: ${refusal}`)

  let groups: Group[]
  try {
    groups = groupAlerts(alerts)
  } catch (error) {
    // A shape that jq cannot read, or a name that is not text, throws here.
    // Each throw is an Error.
    return failed(`Failed to group alerts for ${target}: ${(error as Error).message}`)
  }

  const repository = `${GITHUB_HOST}/${owner}/${repo}`
  const actionable: JsonObject[] = []
  const skipped: JsonObject[] = []
  for (const group of groups) {
    const name = chomp(group.name)
    const line = chomp(group.line)
    // The script reads each line that `jq -r` prints as a candidate, so an
    // identifier with a line break gives one candidate for each line.
    const fixes = group.fixedVersions
      .flatMap((version) => tostring(version).split('\n'))
      .filter((fix) => fix !== '')
    let highest = 'none'
    if (fixes.length > 0) {
      // The script read the ecosystem through `$( )`, which removes the
      // newlines at its end.
      const found = highestOf(chomp(tostring(orElse(group.ecosystem, 'unknown'))), fixes, route)
      if ('error' in found) return failed(found.error)
      highest = found.highest
    }
    const branch = branchName(style, name, line)
    const enriched: JsonObject = {
      ...group.fields,
      highest_fixed_version: highest,
      branch_name: branch,
      repo: target,
    }
    // The script skips on the text `none`, so a candidate `none` that sorts
    // highest also skips the group.
    if (highest === 'none') {
      skipped.push({ ...enriched, reason: 'no fix available' })
      continue
    }

    const flatTwin = style === 'slash' ? branchName('flat', name, line) : null
    const candidates = [branch]
    if (flatTwin !== null) candidates.push(flatTwin)
    if (group.newest && style === 'slash') candidates.push(legacyName(name))
    let outcome: JsonObject | null = null
    for (const head of candidates) {
      let url: string | undefined
      try {
        url = (await client.searchOpenPullRequests({ repository, head }))[0]?.url
      } catch (error) {
        if (!(error instanceof GhError)) throw error
        outcome = { reason: 'PR check failed', error: error.detail }
        break
      }
      if (url === undefined || url === '') continue
      let reason = 'open PR exists'
      if (head === flatTwin) reason = `open PR exists (flat-scheme branch ${head})`
      else if (head !== branch) reason = `open PR exists (legacy branch ${head})`
      outcome = { reason, open_pr_url: url }
      break
    }
    if (outcome === null) actionable.push(enriched)
    else skipped.push({ ...enriched, ...outcome })
  }
  return ok({ actionable, skipped })
}

export const discoverAlertsCommand: CommandHandler = (context) =>
  discoverAlerts(context, createGhClient, run, selectAdapter)
