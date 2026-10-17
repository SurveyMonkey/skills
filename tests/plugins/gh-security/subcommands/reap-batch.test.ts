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
import { createGhMock, ghFails } from '#harness/gh.ts'
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

/** The report of an entry that was not reaped, with the given fields changed. */
const kept = (at: World, changes: Record<string, JsonValue>, group: Group = PLAIN) => ({
  package: group.package,
  major_line: group.major_line,
  branch: group.branch_name,
  worktree_path: workOf(at.repo, group),
  result_status: 'success',
  pr_url: null,
  pr_state: null,
  reaped: false,
  reason: null,
  left_behind: [workOf(at.repo, group), group.branch_name],
  errors: [],
  ...changes,
})

/** The one report of a run over one entry. */
const only = async (answer: Promise<CommandResult>): Promise<JsonValue> => {
  const result = await answer
  if (result?.outcome !== 'ok') throw new Error(`not ok: ${JSON.stringify(result)}`)
  const reports = result.value as JsonValue[]
  expect(reports).toHaveLength(1)
  return reports[0] as JsonValue
}

describe('a success whose pull request is not OPEN', () => {
  it.each(['MERGED', 'CLOSED'])(
    'is reported with state %s, and nothing is reaped',
    async (state) => {
      const at = world()
      fixed(at)
      expect(
        await only(reapAll(at, [entry(at.repo, success())], { 'octo/app#12': view(state) })),
      ).toEqual(
        kept(at, {
          pr_url: URL,
          pr_state: state,
          reason: `pull request is not open (state=${state})`,
        }),
      )
      expect(existsSync(`${workOf(at.repo, PLAIN)}/fix`)).toBe(true)
      expect(branches(at)).toEqual(['fix/dependabot-example-pkg-6x', 'main'])
    },
  )
})

describe('a pull request that cannot be read', () => {
  it('names the gh failure, and nothing is reaped', async () => {
    const at = world()
    fixed(at)
    const reason = 'pr-status could not read the pull request: no pull requests found'
    expect(
      await only(
        reapAll(at, [entry(at.repo, success())], {
          'octo/app#12': ghFails('no pull requests found'),
        }),
      ),
    ).toEqual(kept(at, { pr_url: URL, reason, errors: [reason] }))
    expect(branches(at)).toEqual(['fix/dependabot-example-pkg-6x', 'main'])
  })

  it('names a pr_url that is not a pull request URL', async () => {
    const at = world()
    const reason = 'pr-status could not read the pull request: not a GitHub pull request URL'
    expect(
      await only(reapAll(at, [entry(at.repo, success(PLAIN, { pr_url: 'not-a-url' }))])),
    ).toEqual(kept(at, { pr_url: 'not-a-url', reason, errors: [reason] }))
  })

  it('names an answer with no state', async () => {
    const at = world()
    const { state: _, ...stateless } = view('OPEN')
    const reason = `pr-status returned an entry with no usable state for ${URL}`
    expect(
      await only(reapAll(at, [entry(at.repo, success())], { 'octo/app#12': stateless })),
    ).toEqual(kept(at, { pr_url: URL, reason, errors: [reason] }))
  })
})

describe('a result that is not a success', () => {
  it('reports a no-op, and reads no pull request', async () => {
    const at = world()
    const noOp = success(PLAIN, {
      status: 'no-op',
      pr_url: null,
      action: null,
      risk: null,
      no_op: { reason: 'already-fixed', evidence: {} },
    })
    expect(await only(reapAll(at, [entry(at.repo, noOp)]))).toEqual(
      kept(at, {
        result_status: 'no-op',
        reason: 'no-op: the agent made no fix, so there is nothing to verify or reap',
      }),
    )
  })

  it('reports a failure, and reads no pull request', async () => {
    const at = world()
    const failure = success(PLAIN, {
      status: 'failure',
      pr_url: null,
      action: null,
      resolved_version: null,
      risk: null,
      failure: { phase: 'install', detail: 'the install failed' },
    })
    expect(await only(reapAll(at, [entry(at.repo, failure)]))).toEqual(
      kept(at, { result_status: 'failure', reason: "failure: the agent's result was a failure" }),
    )
  })
})

describe('a result that cannot be read', () => {
  const unparsable = (at: World, file: string) =>
    kept(at, {
      result_status: 'unparsable',
      reason: `unparseable result block at entry 0 of ${file}`,
    })

  it.each([
    ['a success with no pr_url', success(PLAIN, { pr_url: null })],
    ['an unknown status', success(PLAIN, { status: 'pending' })],
    ['a package that is not text', success(PLAIN, { package: 5 })],
    ['an empty branch', success(PLAIN, { branch: '' })],
    ['a no-op with no major_line', { status: 'no-op', package: 'example-pkg', branch: 'b' }],
    ['a result that is not an object', 'done'],
    ['a result that is a list', [success()]],
  ])('reports %s as unparsable, from the dispatch', async (_name, result) => {
    const at = world()
    expect(await only(reapAll(at, [entry(at.repo, result)]))).toEqual(
      unparsable(at, join(at.sandbox.path, 'results.json')),
    )
  })
})

describe('an entry with no result', () => {
  it('reports a null result as missing, from the dispatch', async () => {
    const at = world()
    fixed(at)
    const file = join(at.sandbox.path, 'results.json')
    expect(await only(reapAll(at, [entry(at.repo, null)]))).toEqual(
      kept(at, {
        result_status: 'missing',
        reason: `missing result block at entry 0 of ${file}`,
      }),
    )
    expect(branches(at)).toEqual(['fix/dependabot-example-pkg-6x', 'main'])
  })

  it('reports a mispaired entry as missing, and never reads its result', async () => {
    const at = world()
    fixed(at)
    const file = join(at.sandbox.path, 'results.json')
    const other: Group = {
      package: 'other-pkg',
      major_line: '1',
      branch_name: 'fix/dependabot-other-pkg-1x',
    }
    // The result names another group. A reader of its pr_url or branch would
    // reap that group, or ask gh about its pull request.
    expect(await only(reapAll(at, [entry(at.repo, success(other), { mispaired: true })]))).toEqual(
      kept(at, {
        result_status: 'missing',
        reason: `mispaired result at entry 0 of ${file}: it names another group, so it was not read`,
      }),
    )
    expect(branches(at)).toEqual(['fix/dependabot-example-pkg-6x', 'main'])
  })
})

describe('a result that disagrees with its dispatch', () => {
  it('reports each disagreement, and reaps the group of the result', async () => {
    const at = world()
    fixed(at)
    const dispatched: Group = { package: 'other-pkg', major_line: '7', branch_name: 'fix/other' }
    const report = await only(
      reapAll(at, [entry(at.repo, success(), { group: dispatched })], {
        'octo/app#12': view('OPEN'),
      }),
    )
    expect(report).toMatchObject({
      package: 'example-pkg',
      reaped: true,
      left_behind: [],
      errors: [
        "the result's package ('example-pkg') disagrees with the dispatch's group.package ('other-pkg')",
        "the result's major_line ('6') disagrees with the dispatch's group.major_line ('7')",
        "the result's branch ('fix/dependabot-example-pkg-6x') disagrees with the dispatch's group.branch_name ('fix/other')",
      ],
    })
    expect(branches(at)).toEqual(['main'])
  })
})

describe('a scoped package', () => {
  const SCOPED: Group = {
    package: '@example-scope/example-pkg',
    major_line: '2',
    branch_name: 'fix/dependabot-@example-scope/example-pkg-2x',
  }

  it('reaps one flat work directory, and keeps the slash of the branch', async () => {
    const at = world()
    fixed(at, SCOPED)
    const report = await only(
      reapAll(at, [entry(at.repo, success(SCOPED), { group: SCOPED })], {
        'octo/app#12': view('OPEN'),
      }),
    )
    expect(report).toMatchObject({
      worktree_path: `${at.repo}/.claude/worktrees/fix-dependabot-@example-scope-example-pkg-2x`,
      branch: 'fix/dependabot-@example-scope/example-pkg-2x',
      reaped: true,
      left_behind: [],
      errors: [],
    })
    expect(existsSync(join(at.repo, '.claude', 'worktrees', 'fix-dependabot-@example-scope'))).toBe(
      false,
    )
    expect(branches(at)).toEqual(['main'])
  })
})
