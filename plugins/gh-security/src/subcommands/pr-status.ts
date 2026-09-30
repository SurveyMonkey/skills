// `gh-security pr-status [--env-prefix <prefix>] <pr-url>...`: read the state of
// the pull requests this flow opened. This is the port of
// `scripts/common/pr-status.sh`.
//
// **Read-only, and the whole command.** It runs `gh pr view` and nothing that
// changes a pull request. PRs open ready for review (ADR 008), so nothing in this
// plugin acts on a PR after it is created. The callers print this as
// information: the closing report of the orchestrator, and the standalone
// audit-pins command. Interpreting it is the job of the caller.
//
// Output: `{"prs": [...]}`, one entry per URL, in argument order.
//
//   { url, number, repo, state, is_draft, head, base, merge_state, behind,
//     conflict, checks, check_counts: {total, passed, failed, pending},
//     failing_checks }
//
// A URL that could not be read is `{url, error}` in place of those fields. Either
// it is not a GitHub pull request URL, or `gh pr view` failed on it, or its
// answer had a shape that this command cannot read.
//
//   - `checks` is `passed`, `failed`, `pending` or `none`, from
//     `statusCheckRollup`. The rollup mixes two node shapes. A CheckRun has
//     `status` and `conclusion`. A legacy StatusContext has only `state`. A
//     command that reads one shape only reports the wrong state for a
//     repository with the other. An empty rollup is `none`, never `passed`: no
//     CI at all, or a rollup that is not filled yet, is a fact to show, and not
//     a green light. This flow observes checks, and never prescribes them (ADR
//     008, carried forward from ADR 002).
//   - `merge_state` is `mergeStateStatus` as `gh` gave it. UNKNOWN is a real
//     state just after a push, and the caller must not read it as clean or
//     behind. Most PRs read UNKNOWN when the closing report runs, seconds after
//     they were created.
//
// Exit 1 when any URL made an error entry. The report is written on stdout in
// full either way: report, and fail. **One bad URL never costs the others their
// entries** (issue #87).
//
// `--env-prefix` is the opaque command prefix that the environment needs (issue
// #193). It wraps the runner that the `gh` client uses, so `gh` runs as
// `<prefix> gh ...`. Nothing here names a tool, or looks for one.
//
// This file ships. It imports nothing outside the plugin.

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { failedReport } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { failed, type JsonObject, type JsonValue } from '../lib/envelope.ts'
import { createGhClient, type GhClient, type GhClientOptions, GhError } from '../lib/gh.ts'
import { type Runner, run } from '../lib/process.ts'

const USAGE = 'usage: gh-security pr-status [--env-prefix <prefix>] <pr-url>...'

/** https://github.com/OWNER/REPO/pull/123, and nothing else. */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([0-9]+)$/

/** How much of an unreadable answer goes into the error entry. */
const SHOWN_CHARACTERS = 200

/** How a `gh` client is made for one repository. A test gives its own. */
export type ClientFactory = (options: GhClientOptions) => GhClient

type CheckState = 'passed' | 'failed' | 'pending'

/** A JSON object, and not `null`, an array or a scalar. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** jq's `//`: the value, unless it is `null` or `false`. */
const present = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false

/** A field of the answer as JSON. A field that is not there reads `null`, as in jq. */
const field = (view: Record<string, unknown>, name: string): JsonValue =>
  (view[name] ?? null) as JsonValue

/**
 * The state of one rollup node. A node that has a `state` is a StatusContext,
 * the legacy commit status. Any other node is a CheckRun.
 */
const nodeState = (node: Record<string, unknown>): CheckState => {
  if (present(node.state)) {
    if (node.state === 'SUCCESS') return 'passed'
    return node.state === 'PENDING' || node.state === 'EXPECTED' ? 'pending' : 'failed'
  }
  // A node with no `status` has not finished. One with no `conclusion` failed.
  if (node.status !== 'COMPLETED') return 'pending'
  const { conclusion } = node
  return conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED'
    ? 'passed'
    : 'failed'
}

/** The name that a report gives a failing node. */
const nameOf = (node: Record<string, unknown>): JsonValue => {
  if (present(node.name)) return node.name as JsonValue
  return present(node.context) ? (node.context as JsonValue) : 'unknown'
}

const checksOf = (total: number, states: readonly CheckState[]): string => {
  if (total === 0) return 'none'
  if (states.includes('failed')) return 'failed'
  return states.includes('pending') ? 'pending' : 'passed'
}

const countOf = (states: readonly CheckState[], wanted: CheckState): number =>
  states.filter((state) => state === wanted).length

/**
 * The entry for one answer of `gh pr view`, or `null` when the answer has a
 * shape that this command cannot read: a rollup that is not a list of objects.
 */
const entryFor = (url: string, repo: string, view: Record<string, unknown>): JsonObject | null => {
  const rollup: unknown = present(view.statusCheckRollup) ? view.statusCheckRollup : []
  if (!Array.isArray(rollup) || !rollup.every(isRecord)) return null
  const states = rollup.map(nodeState)
  return {
    url,
    number: field(view, 'number'),
    repo,
    state: field(view, 'state'),
    is_draft: field(view, 'isDraft'),
    head: field(view, 'headRefName'),
    base: field(view, 'baseRefName'),
    merge_state: field(view, 'mergeStateStatus'),
    behind: view.mergeStateStatus === 'BEHIND',
    conflict: view.mergeStateStatus === 'DIRTY',
    checks: checksOf(rollup.length, states),
    check_counts: {
      total: rollup.length,
      passed: countOf(states, 'passed'),
      failed: countOf(states, 'failed'),
      pending: countOf(states, 'pending'),
    },
    failing_checks: rollup.filter((_node, index) => states[index] === 'failed').map(nameOf),
  }
}

const errorEntry = (url: string, error: string): JsonObject => ({ url, error })

/** The entry for one URL. A failure of `gh` is an entry, and any other throw is a defect. */
const entryForUrl = async (
  url: string,
  makeClient: ClientFactory,
  options: Omit<GhClientOptions, 'repository'>,
): Promise<JsonObject> => {
  const match = PULL_REQUEST_URL.exec(url)
  const number = Number(match?.[3])
  if (match === null || !Number.isSafeInteger(number)) {
    return errorEntry(url, 'not a GitHub pull request URL')
  }
  const repo = `${match[1]}/${match[2]}`
  let view: Record<string, unknown>
  try {
    view = await makeClient({ ...options, repository: repo }).viewPullRequest({
      pullRequest: number,
    })
  } catch (error) {
    if (!(error instanceof GhError)) throw error
    return errorEntry(url, error.detail)
  }
  return (
    entryFor(url, repo, view) ??
    errorEntry(
      url,
      `gh pr view output could not be parsed: ${JSON.stringify(view).slice(0, SHOWN_CHARACTERS)}`,
    )
  )
}

/**
 * The handler. The `gh` client factory and the process runner are parameters:
 * an example gives a mock client, or a runner that records its argv.
 */
export const prStatus = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, { 'env-prefix': { type: 'string', default: '' } })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals: urls } = parsed.value
  if (urls.length === 0) return failed(USAGE)

  const prefix = parseEnvPrefix(options['env-prefix'])
  const prefixed: Runner = (command, args = [], runOptions) => {
    const line = withEnvPrefix(prefix, { command, args })
    return spawn(line.command, line.args, runOptions)
  }
  const clientOptions = { env: context.env, run: prefixed }

  const entries: JsonObject[] = []
  for (const url of urls) {
    entries.push(await entryForUrl(url, makeClient, clientOptions))
  }
  const report: JsonObject = { prs: entries }
  const unreadable = entries.filter((entry) => 'error' in entry).length
  return unreadable === 0
    ? { outcome: 'ok', value: report }
    : failedReport(`${unreadable} of ${entries.length} pull request URLs could not be read`, report)
}

export const prStatusCommand: CommandHandler = (context) => prStatus(context, createGhClient, run)
