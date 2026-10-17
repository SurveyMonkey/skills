// The post-agent step for one workflow entry: parse the agent result, verify
// its pull request, reap only on `OPEN`, and report. This is the port of
// `scripts/common/post-agent.sh` (#229).

import type { JsonObject } from './lib/envelope.ts'
import type { Git } from './reap.ts'
import { contain, reap } from './reap.ts'

export type PostAgentReport = {
  readonly package: string
  readonly major_line: string
  readonly branch: string
  readonly worktree_path: string
  readonly result_status: string
  readonly pr_url: string | null
  readonly pr_state: string | null
  readonly reaped: boolean
  readonly reason: string | null
  readonly left_behind: string[]
  readonly errors: string[]
}

export interface PostAgentInput {
  readonly result: unknown
  readonly repoRoot: string
}

export interface PostAgentDeps {
  readonly readPullRequest: (url: string) => Promise<JsonObject>
  readonly git: Git
}

export const postAgent = async (
  input: PostAgentInput,
  deps: PostAgentDeps,
): Promise<PostAgentReport> => {
  const result = input.result as Record<string, string>
  const pkg = result.package as string
  const line = result.major_line as string
  const branch = result.branch as string
  const url = result.pr_url as string
  const worktreePath = `${input.repoRoot}/.claude/worktrees/fix-dependabot-${pkg.replaceAll('/', '-')}-${line}x`
  const pr = await deps.readPullRequest(url)
  const target = await contain(
    { repoRoot: input.repoRoot, work: worktreePath, worktree: `${worktreePath}/fix`, branch },
    deps.git,
  )
  if (target.outcome !== 'ok') throw new Error(target.error)
  const reaped = await reap(target.value, { pushed: true, defaultBranch: null }, deps.git)
  return {
    package: pkg,
    major_line: line,
    branch,
    worktree_path: worktreePath,
    result_status: 'success',
    pr_url: url,
    pr_state: String(pr.state),
    reaped: true,
    reason: null,
    left_behind: reaped.left_behind,
    errors: reaped.errors,
  }
}
