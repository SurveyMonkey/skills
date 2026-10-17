// `gh-security reap-batch <results.json>`. The seam is the exported handler.
// It takes the `gh` client factory and the process runner as parameters, so
// an example gives a client from `harness/gh.ts` and real git. `gh` is the one
// mock boundary (`mocking.md`). Each repository is real (`harness/git.ts`), and
// each expected report is written by hand from the contract in the header of
// the command. `parity-reap-batch.test.ts` compares the command with the
// capture of `post-agent.sh`.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import type { JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import type { ClientFactory } from '#gh-security/subcommands/pr-status.ts'
import { reapBatch } from '#gh-security/subcommands/reap-batch.ts'
import { createGhMock } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

vi.setConfig({ testTimeout: 60_000 })

interface Group {
  readonly package: string
  readonly major_line: string
  readonly branch_name: string
}

const PLAIN: Group = {
  package: 'example-pkg',
  major_line: '6',
  branch_name: 'fix/dependabot-example-pkg-6x',
}

const URL = 'https://github.com/octo/app/pull/12'

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly repo: string
}

const world = (): World => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const repo = fixtures.create(join(realpathSync(sandbox.path), 'r'))
  return { sandbox, fixtures, repo }
}

const workOf = (repo: string, group: Group): string =>
  `${repo}/.claude/worktrees/fix-dependabot-${group.package.replaceAll('/', '-')}-${group.major_line}x`

/** The worktree of a fix agent that committed its fix and pushed it. */
const fixed = (at: World, group: Group = PLAIN): void => {
  mkdirSync(join(at.repo, '.claude', 'worktrees'), { recursive: true })
  const tree = `${workOf(at.repo, group)}/fix`
  at.fixtures.git(at.repo, 'worktree', 'add', '-q', tree, '-b', group.branch_name, 'origin/main')
  at.fixtures.commit(tree, 'fix: the fix', 'fix.txt')
  at.fixtures.push(at.repo, group.branch_name)
}

/** An agent result, as the Result contract of `agents/fix-dependency.md` gives it. */
const success = (group: Group = PLAIN, changes: Record<string, JsonValue> = {}) => ({
  status: 'success',
  package: group.package,
  major_line: group.major_line,
  repo: 'octo/app',
  branch: group.branch_name,
  pr_url: URL,
  action: 'direct-update',
  resolved_version: '6.1.0',
  risk: { band: 'Low', score: 1, f4: 0, f5: 0 },
  observations: [],
  requires_major_bump: [],
  bare_override: 'none',
  no_op: null,
  failure: null,
  cleanup: null,
  ...changes,
})

/** One entry of the workflow result, as `pairEntry` of `fix-groups.mjs` makes it. */
const entry = (
  repo: string,
  result: JsonValue,
  options: { group?: Group; mispaired?: boolean; envPrefix?: string } = {},
): JsonValue => ({
  dispatch: {
    group: { ...(options.group ?? PLAIN), repo: 'octo/app' },
    repo_root: repo,
    default_branch: 'main',
    ...(options.envPrefix === undefined ? {} : { env_prefix: options.envPrefix }),
  },
  result,
  mispaired: options.mispaired ?? false,
})

const view = (state: string): Record<string, unknown> => ({
  number: 12,
  state,
  isDraft: false,
  headRefName: PLAIN.branch_name,
  baseRefName: 'main',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
})

/** A factory whose clients answer `gh pr view` from `views`, by repository and number. */
const viewing =
  (views: Readonly<Record<string, Record<string, unknown> | Error>>): ClientFactory =>
  (options) => ({
    ...createGhMock(),
    viewPullRequest: (pull) =>
      createGhMock({
        viewPullRequest: views[`${options.repository}#${pull.pullRequest}`],
      }).viewPullRequest(pull),
  })

const context = (at: World, args: readonly string[]): CommandContext => ({
  args,
  env: at.sandbox.env,
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

/** Write `results` to a file, and run the command on it. */
const reapAll = (
  at: World,
  results: JsonValue,
  views: Readonly<Record<string, Record<string, unknown> | Error>> = {},
): Promise<CommandResult> => {
  const file = join(at.sandbox.path, 'results.json')
  writeFileSync(file, `${JSON.stringify(results)}\n`)
  return reapBatch(context(at, [file]), viewing(views), run)
}

/** The local branches of the repository. */
const branches = (at: World): string[] =>
  at.fixtures
    .git(at.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter((line) => line !== '')

describe('a success whose pull request reads OPEN', () => {
  it('reaps the worktree, the work directory and the branch, and reports a clean sweep', async () => {
    const at = world()
    fixed(at)
    const work = workOf(at.repo, PLAIN)
    expect(await reapAll(at, [entry(at.repo, success())], { 'octo/app#12': view('OPEN') })).toEqual(
      {
        outcome: 'ok',
        value: [
          {
            package: 'example-pkg',
            major_line: '6',
            branch: 'fix/dependabot-example-pkg-6x',
            worktree_path: work,
            result_status: 'success',
            pr_url: URL,
            pr_state: 'OPEN',
            reaped: true,
            reason: null,
            left_behind: [],
            errors: [],
          },
        ],
      },
    )
    expect(existsSync(work)).toBe(false)
    expect(branches(at)).toEqual(['main'])
  })
})
