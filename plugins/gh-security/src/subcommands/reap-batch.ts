// `gh-security reap-batch <results.json>`.

import { readFileSync } from 'node:fs'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { ok } from '../lib/envelope.ts'
import { createGhClient } from '../lib/gh.ts'
import { type Runner, run } from '../lib/process.ts'
import { postAgent } from '../post-agent.ts'
import type { Git } from '../reap.ts'
import { type ClientFactory, entryForUrl } from './pr-status.ts'

export const reapBatch = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
): Promise<CommandResult> => {
  const file = context.args[0] as string
  const entries = JSON.parse(readFileSync(file, 'utf8')) as {
    dispatch: { repo_root: string }
    result: unknown
  }[]
  const git: Git = (dir, args) =>
    spawn('git', ['-C', dir, ...args], { env: context.env as NodeJS.ProcessEnv })
  const reports = []
  for (const entry of entries) {
    reports.push(
      await postAgent(
        { result: entry.result, repoRoot: entry.dispatch.repo_root },
        {
          readPullRequest: (url) => entryForUrl(url, makeClient, { env: context.env, run: spawn }),
          git,
        },
      ),
    )
  }
  return ok(reports)
}

export const reapBatchCommand: CommandHandler = (context) => reapBatch(context, createGhClient, run)
