// `gh-security reap-batch <results.json>`.

import { readFileSync } from 'node:fs'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { ok } from '../lib/envelope.ts'
import { createGhClient } from '../lib/gh.ts'
import { type Runner, run } from '../lib/process.ts'
import { type PostAgentReport, postAgent } from '../post-agent.ts'
import type { Git } from '../reap.ts'
import { type ClientFactory, entryForUrl } from './pr-status.ts'

interface Entry {
  readonly dispatch: {
    readonly repo_root: string
    readonly env_prefix?: string
    readonly group: { package: string; major_line: string; branch_name: string }
  }
  readonly result: unknown
  readonly mispaired: boolean
}

export const reapBatch = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
): Promise<CommandResult> => {
  const file = context.args[0] as string
  const entries = JSON.parse(readFileSync(file, 'utf8')) as Entry[]
  const git: Git = (dir, args) =>
    spawn('git', ['-C', dir, ...args], { env: context.env as NodeJS.ProcessEnv })
  const reports: PostAgentReport[] = []
  for (const [index, entry] of entries.entries()) {
    const prefix = parseEnvPrefix(entry.dispatch.env_prefix)
    const prefixed: Runner = (command, args = [], options) => {
      const line = withEnvPrefix(prefix, { command, args })
      return spawn(line.command, line.args, options)
    }
    const { group } = entry.dispatch
    reports.push(
      await postAgent(
        {
          result: entry.result,
          mispaired: entry.mispaired,
          where: `entry ${index} of ${file}`,
          repoRoot: entry.dispatch.repo_root,
          dispatch: {
            package: group.package,
            major_line: String(group.major_line),
            branch: group.branch_name,
          },
        },
        {
          readPullRequest: (url) =>
            entryForUrl(url, makeClient, { env: context.env, run: prefixed }),
          git,
        },
      ),
    )
  }
  return ok(reports)
}

export const reapBatchCommand: CommandHandler = (context) => reapBatch(context, createGhClient, run)
