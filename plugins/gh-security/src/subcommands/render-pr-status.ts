// `gh-security render-pr-status --bands <bands.json> <report.json>...`: write
// the closing table of `resolve-alerts` phase 8 from the answers of
// `pr-status`. This is the contract of #193 and #230, built here and not
// ported.
//
// Input, all as files. The allow hook gives no decision for a command with a
// redirection (`cli.md`).
//   report.json   one answer of `pr-status`, `{"prs": [...]}`. The caller makes
//                 one call of `pr-status` for each repository, under the
//                 `env_prefix` of that repository. So it has one file for each
//                 call. Two files of the same repository give one table.
//   --bands       one JSON object, from each PR URL to its merge-risk band
//                 (`Low`, `Medium` or `High`) or to `null` for a PR that has no
//                 score. The report of `pr-status` has no band. The band is in
//                 the `risk` of the Workflow result that opened the PR. So the
//                 caller passes it here, and this command does not guess it.
//
// Output: `{"markdown": "..."}`. A command can only write JSON (`run.ts`).
//   - one table for each repository, in the order of first appearance. The
//     columns are the URL, the band, the check state and the merge state.
//     Error entries whose url is not a PR URL have one table of their own,
//     "not a pull request URL", in the same order.
//   - for a repository with more than one PR, a paragraph that names them
//     together. This command counts them in the reports: each entry with a PR
//     URL is a PR that the run opened. It reads no dispatch plan.
//   - a footnote for each state that the tables show, on what that state is
//     worth. The footnotes of the "what that check state is worth" list of
//     phase 8 are the behaviour.
//
// An entry with `error` is a row that names the error, and the other entries
// still have their rows. This command exits 0 for a report that has such an
// entry: `pr-status` already failed, and this command did its job.
//
// The command fails, with exit 1, in these cases:
//   - a bad command line, no `--bands` or no file,
//   - a file that cannot be read, is not JSON, or has not the shape of an
//     answer of `pr-status`, or has no entry,
//   - a PR URL that two entries give,
//   - a bands file that is not an object, has a band that is not one of the
//     three or `null`, lacks a PR of the reports, or names a PR that no
//     report has.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { failed, type JsonValue, ok } from '../lib/envelope.ts'

const USAGE = 'usage: gh-security render-pr-status --bands <bands.json> <report.json>...'

/** https://github.com/OWNER/REPO/pull/123, and nothing else. */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[0-9]+$/

const BANDS = ['Low', 'Medium', 'High']

const CHECK_STATES = ['none', 'pending', 'passed', 'failed']

/** What the table shows for a PR that has no score. */
const NOT_SCORED = 'not scored'

/** The heading for error entries whose URL is not a PR URL. */
const NOT_A_PULL_REQUEST = 'not a pull request URL'

/** A JSON object, and not `null`, a list or a scalar. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0

/** One entry of a report that `pr-status` could read. */
interface Read {
  readonly url: string
  readonly repo: string
  readonly error?: undefined
  readonly checks: string
  readonly total: number
  readonly pending: number
  readonly failing: readonly string[]
  readonly mergeState: string
  readonly behind: boolean
  readonly conflict: boolean
  readonly draft: boolean
}

/** One entry of a report that `pr-status` could not read. */
interface Unread {
  readonly url: string
  readonly repo: string
  readonly error: string
}

type Entry = Read | Unread

/** One file, as JSON, or the reason that it is not. */
const readJson = (path: string, given: string): { value: JsonValue } | string => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return `cannot read ${given}: ${(error as Error).message}`
  }
  try {
    return { value: JSON.parse(text) as JsonValue }
  } catch {
    return `${given} is not JSON`
  }
}

/** The entry for one element of `prs`, or the reason that it is not an entry. */
const entryOf = (value: unknown): Entry | string => {
  if (!isRecord(value)) return 'is not an object'
  const { url } = value
  if (typeof url !== 'string') return 'has a url that is not text'
  const repo = PULL_REQUEST_URL.exec(url)?.[1]
  // `pr-status` gives an error entry for a URL that is not a PR URL, so an
  // error entry keeps its row under a heading of its own.
  if ('error' in value) {
    if (typeof value.error !== 'string') return `has an error that is not text: ${url}`
    return { url, repo: repo ?? NOT_A_PULL_REQUEST, error: value.error }
  }
  if (repo === undefined) return `has a url that is not a GitHub pull request URL: ${url}`
  const counts = value.check_counts
  const failing = value.failing_checks
  if (typeof value.checks !== 'string' || !CHECK_STATES.includes(value.checks)) {
    return `has a checks that is not one of ${CHECK_STATES.join(', ')}: ${url}`
  }
  if (!isRecord(counts) || !isCount(counts.total) || !isCount(counts.pending)) {
    return `has a check_counts without a total and a pending count: ${url}`
  }
  if (!Array.isArray(failing) || !failing.every((name) => typeof name === 'string')) {
    return `has a failing_checks that is not a list of text: ${url}`
  }
  if (typeof value.merge_state !== 'string') return `has a merge_state that is not text: ${url}`
  for (const name of ['behind', 'conflict', 'is_draft']) {
    if (typeof value[name] !== 'boolean') return `has a ${name} that is not true or false: ${url}`
  }
  return {
    url,
    repo,
    checks: value.checks,
    total: counts.total,
    pending: counts.pending,
    failing: failing as string[],
    mergeState: value.merge_state,
    behind: value.behind as boolean,
    conflict: value.conflict as boolean,
    draft: value.is_draft as boolean,
  }
}

/** The entries of one file, or the reason that it is not an answer of `pr-status`. */
const entriesOf = (value: JsonValue, given: string): Entry[] | string => {
  const problem = (why: string) => `${given} is not an answer of pr-status: ${why}`
  if (!isRecord(value) || Object.keys(value).join() !== 'prs' || !Array.isArray(value.prs)) {
    return problem('not an object with one field, prs, that is a list')
  }
  if (value.prs.length === 0) return problem('prs has no entry')
  const entries: Entry[] = []
  for (const [index, element] of value.prs.entries()) {
    const entry = entryOf(element)
    if (typeof entry === 'string') return problem(`prs[${index}] ${entry}`)
    entries.push(entry)
  }
  return entries
}

/** The band of each PR URL, or the reason that the file is not a bands file. */
const bandsOf = (value: JsonValue, given: string): Map<string, string | null> | string => {
  if (!isRecord(value)) return `${given} is not a JSON object`
  const bands = new Map<string, string | null>()
  for (const [url, band] of Object.entries(value)) {
    if (band !== null && !BANDS.includes(band as string)) {
      return `${given} gives ${url} a band that is not ${BANDS.join(', ')} or null`
    }
    bands.set(url, band as string | null)
  }
  return bands
}

/** Text that is safe inside a table cell. */
const cell = (text: string): string => text.replaceAll('|', '\\|').replace(/\r\n?|\n/g, ' ')

const checksCell = (entry: Read): string => {
  if (entry.checks === 'pending') {
    return `pending (${entry.total - entry.pending} of ${entry.total} finished)`
  }
  return entry.checks === 'failed' ? `failed: ${cell(entry.failing.join(', '))}` : entry.checks
}

const mergeCell = (entry: Read): string =>
  [entry.mergeState, entry.behind ? 'behind' : '', entry.conflict ? 'conflict' : '']
    .concat(entry.draft ? 'draft' : '')
    .filter((part) => part !== '')
    .join(', ')

const rowOf = (entry: Entry, band: string | null | undefined): string => {
  const shown = band ?? NOT_SCORED
  return entry.error === undefined
    ? `| ${entry.url} | ${shown} | ${checksCell(entry)} | ${cell(mergeCell(entry))} |`
    : `| ${cell(entry.url)} | ${shown} | not read: ${cell(entry.error)} | - |`
}

/** The paragraph for a repository that the run opened more than one PR against. */
const sameRepoNote = (repo: string, entries: readonly Entry[]): string =>
  `${repo} has ${entries.length} pull requests from this run: ${entries.map((entry) => entry.url).join(', ')}. ` +
  'They edit the same overrides block. Merging one leaves the rest behind, and the second to merge may conflict. ' +
  'Use Update branch for the usual case. Close a conflicted fix PR and run this skill again for that package.'

const tableOf = (
  repo: string,
  entries: readonly Entry[],
  bands: ReadonlyMap<string, string | null>,
): string => {
  const lines = [
    `## ${repo}`,
    '',
    '| PR | Merge risk | Checks | Merge state |',
    '| --- | --- | --- | --- |',
    ...entries.map((entry) => rowOf(entry, bands.get(entry.url))),
  ]
  // The entries under NOT_A_PULL_REQUEST are not PRs, and share no overrides block.
  if (entries.length > 1 && repo !== NOT_A_PULL_REQUEST) lines.push('', sameRepoNote(repo, entries))
  return lines.join('\n')
}

/** What each state is worth, for the states that the entries show. */
const footnotes = (entries: readonly Entry[]): string[] => {
  const reads = entries.filter((entry): entry is Read => entry.error === undefined)
  const notes: [boolean, string][] = [
    [
      reads.some((entry) => entry.checks === 'none'),
      '`none`: no check has reported yet. On a repository with CI, the workflows have usually not started.',
    ],
    [
      reads.some((entry) => entry.checks === 'pending'),
      '`pending`: the count shows how many checks have finished. The rest still run.',
    ],
    [
      reads.some((entry) => entry.checks === 'passed'),
      '`passed` is provisional. Checks appear as workflows start, and a job that has not reported is invisible. Absent is not pending. Do not read the set as CI-complete.',
    ],
    [
      reads.some((entry) => entry.checks === 'failed'),
      '`failed`: the table names the failing checks. Open these PRs first.',
    ],
    [
      reads.some((entry) => entry.mergeState === 'UNKNOWN'),
      '`UNKNOWN`: GitHub has not computed mergeability yet. This is ordinary right after a push. It is not clean and not behind. `behind` and `conflict` are not established, and `false` there is not a sign of a clean PR.',
    ],
    [
      reads.some((entry) => entry.behind),
      '`behind`: GitHub has computed mergeability, and the PR needs a rebase.',
    ],
    [
      reads.some((entry) => entry.conflict),
      '`conflict`: GitHub has computed mergeability, and the PR has a conflicting change.',
    ],
    [
      reads.some((entry) => entry.draft),
      '`draft`: these PRs open ready, so a person converted each draft PR.',
    ],
  ]
  return notes.filter(([shown]) => shown).map(([, text]) => `- ${text}`)
}

/** The handler. The current directory is a parameter. */
export const renderPrStatus = (context: CommandContext, cwd: string): CommandResult => {
  const parsed = parseCommandLine(context.args, { bands: { type: 'string', default: '' } })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals: files } = parsed.value
  if (options.bands === '' || files.length === 0) return failed(USAGE)
  const fail = (why: string) => failed(`render-pr-status: ${why}`)

  const bandsText = readJson(resolve(cwd, options.bands), options.bands)
  if (typeof bandsText === 'string') return fail(bandsText)
  const bands = bandsOf(bandsText.value, options.bands)
  if (typeof bands === 'string') return fail(bands)

  const entries: Entry[] = []
  for (const given of files) {
    const text = readJson(resolve(cwd, given), given)
    if (typeof text === 'string') return fail(text)
    const found = entriesOf(text.value, given)
    if (typeof found === 'string') return fail(found)
    entries.push(...found)
  }

  const twice = entries.find(
    (entry, index) => entries.findIndex((e) => e.url === entry.url) < index,
  )
  if (twice !== undefined) return fail(`the PR ${twice.url} is in two entries`)
  const lacking = entries.find((entry) => !bands.has(entry.url))
  if (lacking !== undefined) return fail(`${options.bands} has no band for ${lacking.url}`)
  const unknown = [...bands.keys()].find((url) => !entries.some((entry) => entry.url === url))
  if (unknown !== undefined) return fail(`${options.bands} names ${unknown}, which no report has`)

  const repos = [...new Set(entries.map((entry) => entry.repo))]
  const tables = repos.map((repo) =>
    tableOf(
      repo,
      entries.filter((entry) => entry.repo === repo),
      bands,
    ),
  )
  const notes = footnotes(entries)
  const sections =
    notes.length === 0
      ? tables
      : [...tables, ['## What the states are worth', '', ...notes].join('\n')]
  return ok({ markdown: `${sections.join('\n\n')}\n` })
}

export const renderPrStatusCommand: CommandHandler = (context) =>
  renderPrStatus(context, process.cwd())
