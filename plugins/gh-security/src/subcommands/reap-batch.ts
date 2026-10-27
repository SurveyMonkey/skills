// `gh-security reap-batch <results.json>`: the post-agent step of
// `resolve-alerts` phase 6, for each entry of the workflow result. This is the
// contract of #229, and the port of the loop that phase 6 ran by hand: one
// `post-agent.sh` call for each entry, with an empty result file for a `null`
// or `mispaired` entry. The step for one entry is `src/post-agent.ts`, which
// has the report shape and each difference from the deleted script.
//
// Input: `results.json`, the value that `workflows/fix-groups.mjs` returns.
// It is a list, in dispatch order, of `{dispatch, result, mispaired}`:
//   - `dispatch` is the payload of the group: `group` (`package`,
//     `branch_name`, and `major_line` as text or a whole number),
//     `repo_root`, and an optional `env_prefix`.
//   - `result` is the agent result, or `null` when the agent gave none.
//   - `mispaired` is true when the result names another group. Its result is
//     never read.
//
// Output: `[report, ...]`, one report for each entry, in entry order. The
// command exits 0 whatever each entry found: a pull request that is not
// open, a reap that left something, or a reap that refused its paths is in
// its report, and never stops the entries after it.
//
// The command fails, with exit 1, before it reads a pull request or reaps an
// entry, in these cases:
//   - a bad command line: no file, more than one, or an option,
//   - a file that cannot be read, is not JSON, is not a list, or has no entry,
//   - an entry that is not an object, or whose `dispatch` lacks a field
//     above, or has a field of another type, or that has no `result` key, or
//     a `mispaired` that is not true or false.
// So a malformed file reaps nothing. The workflow checks the dispatch of each
// group before it starts (`validateArgs`), so a refusal here is a file that
// the workflow did not write.
//
// `--out <file>` writes the answer to the file too, and a failure writes its
// report or its `{"error": ...}` there (`cli/out-file.ts`). `run.ts` takes
// the flag out before this handler runs (#346).
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { failed, ok, thrownText } from '../lib/envelope.ts'
import { createGhClient } from '../lib/gh.ts'
import { type Runner, run } from '../lib/process.ts'
import { type Named, type PostAgentReport, postAgent } from '../post-agent.ts'
import type { Git } from '../reap.ts'
import { type ClientFactory, entryForUrl } from './pr-status.ts'

const USAGE = 'usage: gh-security reap-batch <results.json>'

/** One entry of the workflow result, after its check. */
interface Entry {
  readonly repoRoot: string
  readonly envPrefix: string | undefined
  readonly dispatch: Named
  readonly result: unknown
  readonly mispaired: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** `major_line` as text: text that is not empty, or a whole number. */
const lineOf = (value: unknown): string | null => {
  if (isText(value)) return value
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : null
}

/** One entry, or the reason that it is not an entry. */
const entryOf = (value: unknown): Entry | string => {
  if (!isRecord(value)) return 'is not an object'
  const { dispatch } = value
  if (!isRecord(dispatch)) return 'has no dispatch object'
  const { repo_root: repoRoot, env_prefix: envPrefix, group } = dispatch
  if (!isText(repoRoot)) return 'has a dispatch.repo_root that is not text'
  if (envPrefix !== undefined && typeof envPrefix !== 'string') {
    return 'has a dispatch.env_prefix that is not text'
  }
  if (!isRecord(group)) return 'has no dispatch.group object'
  if (!isText(group.package)) return 'has a dispatch.group.package that is not text'
  if (!isText(group.branch_name)) return 'has a dispatch.group.branch_name that is not text'
  const line = lineOf(group.major_line)
  if (line === null) return 'has a dispatch.group.major_line that is not text or a whole number'
  if (typeof value.mispaired !== 'boolean') return 'has a mispaired that is not true or false'
  if (!('result' in value)) return 'has no result'
  return {
    repoRoot,
    envPrefix,
    dispatch: { package: group.package, major_line: line, branch: group.branch_name },
    result: value.result,
    mispaired: value.mispaired,
  }
}

/** Every entry of the file, or the reason that the file is refused. */
const readEntries = (file: string): Entry[] | string => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return `cannot read ${file}: ${thrownText(error)}`
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return `${file} is not JSON`
  }
  if (!Array.isArray(value)) return `${file} is not a list of workflow entries`
  if (value.length === 0) return `${file} has no entry`
  const entries: Entry[] = []
  for (const [index, element] of value.entries()) {
    const entry = entryOf(element)
    if (typeof entry === 'string') return `${file} entry ${index} ${entry}`
    entries.push(entry)
  }
  return entries
}

/**
 * The handler. The `gh` client factory and the process runner are parameters:
 * an example gives a mock client, or a runner that records its argv. The
 * runner starts git for the reap, with no prefix, and `gh` for the pull
 * request read, under the prefix of the entry.
 */
export const reapBatch = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, {})
  if (parsed.outcome !== 'ok') return parsed
  const [file, ...rest] = parsed.value.positionals
  if (file === undefined || rest.length > 0) return failed(USAGE)
  const entries = readEntries(file)
  if (typeof entries === 'string') return failed(`reap-batch: ${entries}`)

  const env = context.env as NodeJS.ProcessEnv
  const git: Git = (dir, args) => spawn('git', ['-C', dir, ...args], { env })
  const reports: PostAgentReport[] = []
  for (const [index, entry] of entries.entries()) {
    const prefix = parseEnvPrefix(entry.envPrefix)
    const prefixed: Runner = (command, args = [], options) => {
      const line = withEnvPrefix(prefix, { command, args })
      return spawn(line.command, line.args, options)
    }
    reports.push(
      await postAgent(
        {
          result: entry.result,
          mispaired: entry.mispaired,
          where: `entry ${index} of ${file}`,
          repoRoot: entry.repoRoot,
          dispatch: entry.dispatch,
        },
        {
          readPullRequest: (url) => entryForUrl(url, makeClient, { env, run: prefixed }),
          git,
        },
      ),
    )
  }
  return ok(reports)
}

export const reapBatchCommand: CommandHandler = (context) => reapBatch(context, createGhClient, run)
