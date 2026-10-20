// `gh-security reap-batch <results.json>`. The seam is the exported handler.
// It takes the `gh` client factory and the process runner as parameters, so
// an example gives a client from `harness/gh.ts` and real git. `gh` is the one
// mock boundary (`mocking.md`). Each repository is real (`harness/git.ts`), and
// each expected report is written by hand from the contract in the header of
// the command.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import type { JsonValue } from '#gh-security/lib/envelope.ts'
import { createGhClient } from '#gh-security/lib/gh.ts'
import { type Runner, run } from '#gh-security/lib/process.ts'
import type { ClientFactory } from '#gh-security/subcommands/pr-status.ts'
import { reapBatch, reapBatchCommand } from '#gh-security/subcommands/reap-batch.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
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

  it('reaps a success whose cleanup is not null', async () => {
    const at = world()
    fixed(at)
    const result = success(PLAIN, { cleanup: { left_behind: ['x'], errors: ['y'] } })
    expect(
      await only(reapAll(at, [entry(at.repo, result)], { 'octo/app#12': view('OPEN') })),
    ).toMatchObject({ reaped: true, left_behind: [], errors: [] })
    expect(branches(at)).toEqual(['main'])
  })

  it('keeps a branch whose tip is on the default branch and not on origin', async () => {
    const at = world()
    fixed(at)
    // The reap gives no default branch, as reap-agent-artifacts.sh did not.
    at.fixtures.git(`${workOf(at.repo, PLAIN)}/fix`, 'reset', '-q', '--hard', 'origin/main')
    expect(
      await only(reapAll(at, [entry(at.repo, success())], { 'octo/app#12': view('OPEN') })),
    ).toMatchObject({ reaped: true, left_behind: [PLAIN.branch_name], errors: [] })
    expect(branches(at)).toEqual(['fix/dependabot-example-pkg-6x', 'main'])
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
  left_behind: [],
  errors: [],
  ...changes,
})

/** What stays of a group whose worktree and branch are on disk, when no reap ran. */
const stays = (at: World, group: Group = PLAIN): JsonValue[] => [
  workOf(at.repo, group),
  group.branch_name,
]

/** The one report of a run over one entry. */
const only = async (answer: Promise<CommandResult>): Promise<JsonValue> => {
  const result = await answer
  if (result?.outcome !== 'ok') throw new Error(`not ok: ${JSON.stringify(result)}`)
  const reports = result.value as JsonValue[]
  expect(reports).toHaveLength(1)
  return reports[0] as JsonValue
}

describe('a success whose pull request is not OPEN', () => {
  it.each(['MERGED', 'CLOSED', 'UNKNOWN', ''])(
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
          left_behind: stays(at),
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
    ).toEqual(kept(at, { pr_url: URL, reason, errors: [reason], left_behind: stays(at) }))
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
        left_behind: stays(at),
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
        left_behind: stays(at),
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

describe('the loop over the entries', () => {
  const OTHER: Group = {
    package: 'other-pkg',
    major_line: '1',
    branch_name: 'fix/dependabot-other-pkg-1x',
  }

  it('gives one report for each entry, in entry order, and a refused reap does not stop the next', async () => {
    const at = world()
    fixed(at, OTHER)
    // The worktree root of the repository is a link out of it, so the reap
    // of the first entry refuses its paths.
    const elsewhere = join(realpathSync(at.sandbox.path), 'elsewhere')
    mkdirSync(elsewhere)
    const root = join(at.repo, '.claude', 'worktrees')
    const moved = join(at.repo, '.claude', 'moved')
    at.fixtures.git(at.repo, 'worktree', 'move', `${workOf(at.repo, OTHER)}/fix`, `${moved}-fix`)
    rmSync(root, { recursive: true })
    symlinkSync(elsewhere, root)
    const result = await reapAll(
      at,
      [
        entry(at.repo, success()),
        entry(at.repo, null, { group: OTHER }),
        entry(at.repo, success(OTHER, { pr_url: 'https://github.com/octo/lib/pull/3' }), {
          group: OTHER,
        }),
      ],
      { 'octo/app#12': view('OPEN'), 'octo/lib#3': view('MERGED') },
    )
    if (result?.outcome !== 'ok') throw new Error(JSON.stringify(result))
    const reports = result.value as Record<string, JsonValue>[]
    expect(reports.map((report) => [report.package, report.result_status, report.reaped])).toEqual([
      ['example-pkg', 'success', false],
      ['other-pkg', 'missing', false],
      ['other-pkg', 'success', false],
    ])
    expect(reports[0]).toMatchObject({
      reason: 'the reap refused the paths, so nothing was removed',
      errors: [
        `the reap refused the paths, so nothing was removed: the work path is not under ${at.repo}/.claude/worktrees/: ${elsewhere}/fix-dependabot-example-pkg-6x. Nothing was removed.`,
      ],
      // Nothing of the first group is on disk, so nothing stays.
      left_behind: [],
    })
    expect(reports[1]).toMatchObject({
      reason: `missing result block at entry 1 of ${join(at.sandbox.path, 'results.json')}`,
    })
    expect(reports[2]).toMatchObject({ pr_state: 'MERGED' })
  })

  it('reaps each entry in its own repository', async () => {
    const at = world()
    const second: World = {
      ...at,
      repo: at.fixtures.create(join(realpathSync(at.sandbox.path), 'r2')),
    }
    fixed(at)
    fixed(second)
    const result = await reapAll(
      at,
      [
        entry(at.repo, success()),
        entry(second.repo, success(PLAIN, { pr_url: 'https://github.com/octo/lib/pull/3' })),
      ],
      { 'octo/app#12': view('MERGED'), 'octo/lib#3': view('OPEN') },
    )
    if (result?.outcome !== 'ok') throw new Error(JSON.stringify(result))
    expect(
      (result.value as Record<string, JsonValue>[]).map((report) => report.worktree_path),
    ).toEqual([workOf(at.repo, PLAIN), workOf(second.repo, PLAIN)])
    expect(existsSync(`${workOf(at.repo, PLAIN)}/fix`)).toBe(true)
    expect(branches(at)).toEqual(['fix/dependabot-example-pkg-6x', 'main'])
    expect(existsSync(workOf(second.repo, PLAIN))).toBe(false)
    expect(branches(second)).toEqual(['main'])
  })

  it('reports a reap that failed part way, and still reaps the next entry', async () => {
    const at = world()
    fixed(at)
    fixed(at, OTHER)
    // A directory with no write bit in the work directory stops its removal.
    const locked = join(workOf(at.repo, PLAIN), 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'held'), '')
    chmodSync(locked, 0o555)
    try {
      const result = await reapAll(
        at,
        [
          entry(at.repo, success()),
          entry(at.repo, success(OTHER, { pr_url: 'https://github.com/octo/lib/pull/3' }), {
            group: OTHER,
          }),
        ],
        { 'octo/app#12': view('OPEN'), 'octo/lib#3': view('OPEN') },
      )
      if (result?.outcome !== 'ok') throw new Error(JSON.stringify(result))
      const [first, second] = result.value as Record<string, JsonValue>[]
      expect(first).toMatchObject({
        reaped: true,
        reason: null,
        left_behind: [workOf(at.repo, PLAIN)],
      })
      expect(first?.errors).toEqual([
        expect.stringMatching(new RegExp(`^${workOf(at.repo, PLAIN)} was not removed: E`)),
      ])
      expect(second).toMatchObject({ reaped: true, left_behind: [], errors: [] })
      expect(branches(at)).toEqual(['main'])
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('reads a major_line that the dispatch gives as a number', async () => {
    const at = world()
    const dispatch = entry(at.repo, null) as { dispatch: { group: Record<string, JsonValue> } }
    dispatch.dispatch.group.major_line = 6
    expect(await only(reapAll(at, [dispatch as unknown as JsonValue]))).toMatchObject({
      major_line: '6',
      worktree_path: workOf(at.repo, PLAIN),
    })
  })
})

describe('the env_prefix of an entry', () => {
  it('wraps the gh call of the pull request read, and never the git of the reap', async () => {
    const at = world()
    fixed(at)
    const calls: string[][] = []
    const spawn: Runner = (command, args = [], options) => {
      calls.push([command, ...args])
      if (command === 'git') return run(command, args, options)
      return Promise.resolve({
        status: 0,
        signal: null,
        stdout: JSON.stringify(view('OPEN')),
        stderr: '',
        combined: JSON.stringify(view('OPEN')),
        timedOut: false,
        elapsedMs: 0,
        startFailure: null,
        streamErrors: [],
      })
    }
    const file = join(at.sandbox.path, 'results.json')
    writeFileSync(
      file,
      JSON.stringify([entry(at.repo, success(), { envPrefix: 'env GH_SECURITY_EXAMPLE=1' })]),
    )
    const result = await reapBatch(context(at, [file]), createGhClient, spawn)
    expect(result).toMatchObject({ outcome: 'ok', value: [{ reaped: true, errors: [] }] })
    const gh = calls.filter((call) => call[0] !== 'git')
    expect(gh.map((call) => call.slice(0, 6))).toEqual([
      ['env', 'GH_SECURITY_EXAMPLE=1', 'gh', 'pr', 'view', '12'],
    ])
    expect(calls.filter((call) => call[0] === 'git').length).toBeGreaterThan(0)
  })

  it('wraps only the read of its own entry', async () => {
    const at = world()
    const calls: string[][] = []
    const spawn: Runner = (command, args = []) => {
      calls.push([command, ...args])
      const stdout = JSON.stringify(view('MERGED'))
      return Promise.resolve({
        status: 0,
        signal: null,
        stdout,
        stderr: '',
        combined: stdout,
        timedOut: false,
        elapsedMs: 0,
        startFailure: null,
        streamErrors: [],
      })
    }
    const file = join(at.sandbox.path, 'results.json')
    writeFileSync(
      file,
      JSON.stringify([
        entry(at.repo, success(), { envPrefix: 'env GH_SECURITY_EXAMPLE=1' }),
        entry(at.repo, success(PLAIN, { pr_url: 'https://github.com/octo/lib/pull/3' })),
      ]),
    )
    expect(await reapBatch(context(at, [file]), createGhClient, spawn)).toMatchObject({
      outcome: 'ok',
      value: [{ pr_state: 'MERGED' }, { pr_state: 'MERGED' }],
    })
    // The git of each check of what stays runs with no prefix.
    expect(calls.filter((call) => call[0] !== 'git').map((call) => call.slice(0, 5))).toEqual([
      ['env', 'GH_SECURITY_EXAMPLE=1', 'gh', 'pr', 'view'],
      ['gh', 'pr', 'view', '3', '--repo'],
    ])
  })
})

// Round 7 ruling 12 on #229. When no reap ran, `left_behind` names only what
// is on disk: the work directory when the path exists, and the branch when
// `refs/heads/<branch>` exists in the repository root of the entry.
describe('what stays when no reap ran', () => {
  const FIELD = join(FIXTURES_ROOT, 'summarize-run', 'field-run')
  const specimen = (name: string): JsonValue =>
    JSON.parse(readFileSync(join(FIELD, name), 'utf8')) as JsonValue

  it('names nothing for the brace-expansion entry of the field run, where neither was made', async () => {
    // The entry is the third of the Workflow result, unchanged. Its repository
    // root is not on this machine, so no path under it exists, and no branch.
    // The report of post-agent.sh named both (the specimen). The port names
    // neither, and that is the one difference.
    const at = world()
    const field = specimen('workflow-result.json') as { result: JsonValue[] }
    const before = specimen('post-agent-brace-expansion-2.report.json') as Record<string, JsonValue>
    expect(before.left_behind).toEqual([
      '/Users/example/src/octo/app/.claude/worktrees/fix-dependabot-brace-expansion-2x',
      'fix/dependabot-brace-expansion-2x',
    ])
    expect(await only(reapAll(at, [field.result[2] as JsonValue]))).toEqual({
      ...before,
      left_behind: [],
    })
  })

  const failure = success(PLAIN, {
    status: 'failure',
    pr_url: null,
    action: null,
    resolved_version: null,
    risk: null,
    failure: { phase: 'worktree', detail: 'setup failed' },
  })

  /** The failure report, with `left_behind` and `errors` as given. */
  const failed = (at: World, left: JsonValue[], errors: JsonValue[] = []) =>
    kept(at, {
      result_status: 'failure',
      reason: "failure: the agent's result was a failure",
      left_behind: left,
      errors,
    })

  it('names nothing when neither the work directory nor the branch exists', async () => {
    const at = world()
    expect(await only(reapAll(at, [entry(at.repo, failure)]))).toEqual(failed(at, []))
  })

  it('names the work directory alone when only the directory exists', async () => {
    const at = world()
    mkdirSync(workOf(at.repo, PLAIN), { recursive: true })
    expect(await only(reapAll(at, [entry(at.repo, failure)]))).toEqual(
      failed(at, [workOf(at.repo, PLAIN)]),
    )
  })

  it('names the branch alone when only the branch exists', async () => {
    const at = world()
    at.fixtures.git(at.repo, 'branch', PLAIN.branch_name, 'origin/main')
    expect(await only(reapAll(at, [entry(at.repo, failure)]))).toEqual(
      failed(at, [PLAIN.branch_name]),
    )
  })

  it('names both when both exist', async () => {
    const at = world()
    fixed(at)
    expect(await only(reapAll(at, [entry(at.repo, failure)]))).toEqual(failed(at, stays(at)))
  })

  it('keeps the branch, and names the read, when git cannot read the ref', async () => {
    // The root is a directory, but not a repository, so the read fails. A
    // read that failed is never an absent branch.
    const at = world()
    const root = join(realpathSync(at.sandbox.path), 'plain')
    mkdirSync(root)
    const report = (await only(reapAll(at, [entry(root, failure)]))) as Record<string, JsonValue>
    expect(report.left_behind).toEqual([PLAIN.branch_name])
    // git names the parent it stopped at in words that depend on the file
    // system, so the example checks the start and the end of one line.
    expect(report.errors).toEqual([
      expect.stringMatching(
        new RegExp(
          `^git rev-parse refs/heads/${PLAIN.branch_name} failed: fatal: not a git repository [^\\n]*\\S$`,
        ),
      ),
    ])
  })

  // A runner stands in for the git of the ref read only, so the example can
  // give an answer that real git gives rarely.
  it.each([
    [
      'git does not start',
      {
        status: null,
        signal: null,
        text: '',
        startFailure: { code: 'ENOENT', message: 'spawn git ENOENT' },
      },
      'spawn git ENOENT',
    ],
    [
      'git writes two lines',
      { status: 128, signal: null, text: 'fatal: one\nfatal: two\n', startFailure: null },
      'fatal: one fatal: two',
    ],
    [
      'a signal ends git',
      { status: null, signal: 'SIGKILL', text: '', startFailure: null },
      'killed by SIGKILL',
    ],
    [
      'git exits 128 with no text',
      { status: 128, signal: null, text: '', startFailure: null },
      'exit 128',
    ],
    [
      'git exits 1 with text',
      { status: 1, signal: null, text: 'warning: x\n', startFailure: null },
      'warning: x',
    ],
    [
      'git exits 1 and a stream is lost',
      {
        status: 1,
        signal: null,
        text: '',
        startFailure: null,
        streamErrors: [{ code: 'EIO', message: 'read EIO' }],
      },
      'a pipe failed: EIO, read EIO',
    ],
  ])('keeps the branch, and names the read on one line, when %s', async (_name, answer, words) => {
    const at = world()
    const spawn: Runner = (command, args = [], options) =>
      args.includes('rev-parse')
        ? Promise.resolve({
            status: answer.status,
            signal: answer.signal as NodeJS.Signals | null,
            stdout: '',
            stderr: answer.text,
            combined: answer.text,
            timedOut: false,
            elapsedMs: 0,
            startFailure: answer.startFailure,
            streamErrors: 'streamErrors' in answer ? answer.streamErrors : [],
          })
        : run(command, args, options)
    const file = join(at.sandbox.path, 'results.json')
    writeFileSync(file, JSON.stringify([entry(at.repo, failure)]))
    expect(await only(reapBatch(context(at, [file]), viewing({}), spawn))).toEqual(
      failed(
        at,
        [PLAIN.branch_name],
        [`git rev-parse refs/heads/${PLAIN.branch_name} failed: ${words}`],
      ),
    )
  })

  it('reads the branch through a repository root that is a link', async () => {
    const at = world()
    at.fixtures.git(at.repo, 'branch', PLAIN.branch_name, 'origin/main')
    const link = join(realpathSync(at.sandbox.path), 'link')
    symlinkSync(at.repo, link)
    expect(await only(reapAll(at, [entry(link, failure)]))).toMatchObject({
      left_behind: [PLAIN.branch_name],
      errors: [],
    })
  })

  it('keeps both, and names each stat, when a stat fails for another reason than an absent path', async () => {
    // A parent with no search permission makes each stat under it fail with
    // EACCES. That is not an absent path.
    const at = world()
    const locked = join(realpathSync(at.sandbox.path), 'locked')
    const root = join(locked, 'repo')
    mkdirSync(root, { recursive: true })
    chmodSync(locked, 0)
    try {
      const report = (await only(reapAll(at, [entry(root, failure)]))) as Record<string, JsonValue>
      const work = report.worktree_path as string
      expect(report.left_behind).toEqual([work, PLAIN.branch_name])
      expect(report.errors).toEqual([
        `stat failed: EACCES: permission denied, stat '${work}'`,
        `stat failed: EACCES: permission denied, stat '${root}'`,
      ])
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it.each([
    ['is there', true],
    ['is absent', false],
  ])(
    'keeps the work directory whose stat fails, and reads a branch that %s',
    async (_name, has) => {
      // The root reads, but the parent of the work directory does not.
      const at = world()
      if (has) at.fixtures.git(at.repo, 'branch', PLAIN.branch_name, 'origin/main')
      const worktrees = join(at.repo, '.claude', 'worktrees')
      mkdirSync(worktrees, { recursive: true })
      chmodSync(worktrees, 0)
      try {
        const report = (await only(reapAll(at, [entry(at.repo, failure)]))) as Record<
          string,
          JsonValue
        >
        const work = report.worktree_path as string
        expect(report.left_behind).toEqual(has ? [work, PLAIN.branch_name] : [work])
        expect(report.errors).toEqual([`stat failed: EACCES: permission denied, stat '${work}'`])
      } finally {
        chmodSync(worktrees, 0o755)
      }
    },
  )

  it('names the failed stat and the failed ref read together', async () => {
    // The root is a plain directory, so the ref read fails too.
    const at = world()
    const root = join(realpathSync(at.sandbox.path), 'plain')
    const worktrees = join(root, '.claude', 'worktrees')
    mkdirSync(worktrees, { recursive: true })
    chmodSync(worktrees, 0)
    try {
      const report = (await only(reapAll(at, [entry(root, failure)]))) as Record<string, JsonValue>
      const work = report.worktree_path as string
      expect(report.left_behind).toEqual([work, PLAIN.branch_name])
      expect(report.errors).toEqual([
        `stat failed: EACCES: permission denied, stat '${work}'`,
        expect.stringMatching(
          new RegExp(
            `^git rev-parse refs/heads/${PLAIN.branch_name} failed: fatal: not a git repository`,
          ),
        ),
      ])
    } finally {
      chmodSync(worktrees, 0o755)
    }
  })

  it('names nothing under a repository root that is a file', async () => {
    const at = world()
    const root = join(at.sandbox.path, 'a-file')
    writeFileSync(root, '')
    expect(await only(reapAll(at, [entry(root, failure)]))).toMatchObject({
      left_behind: [],
      errors: [],
    })
  })

  it('names only what exists for a refused reap', async () => {
    // The worktree root is a link out of the repository, so contain refuses
    // the paths. The branch exists, and no work directory does.
    const at = world()
    const elsewhere = join(realpathSync(at.sandbox.path), 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(join(at.repo, '.claude'))
    symlinkSync(elsewhere, join(at.repo, '.claude', 'worktrees'))
    at.fixtures.git(at.repo, 'branch', PLAIN.branch_name, 'origin/main')
    expect(
      await only(reapAll(at, [entry(at.repo, success())], { 'octo/app#12': view('OPEN') })),
    ).toMatchObject({
      reaped: false,
      reason: 'the reap refused the paths, so nothing was removed',
      left_behind: [PLAIN.branch_name],
    })
  })
})

describe('a results file that is refused', () => {
  const refused = async (at: World, text: string) => {
    const file = join(at.sandbox.path, 'results.json')
    writeFileSync(file, text)
    return { file, result: await reapBatch(context(at, [file]), viewing({}), run) }
  }

  it.each([
    [[], 'usage: gh-security reap-batch <results.json>'],
    [['a.json', 'b.json'], 'usage: gh-security reap-batch <results.json>'],
    [['--bogus', 'a.json'], expect.stringMatching(/^Unknown option '--bogus'/)],
  ])('refuses the command line %j', async (args, message) => {
    const at = world()
    expect(await reapBatch(context(at, args), viewing({}), run)).toEqual({
      outcome: 'failed',
      error: message,
    })
  })

  it('refuses a file that cannot be read', async () => {
    const at = world()
    const file = join(at.sandbox.path, 'absent.json')
    const result = await reapBatch(context(at, [file]), viewing({}), run)
    expect(result).toMatchObject({ outcome: 'failed' })
    expect((result as { error: string }).error).toMatch(
      new RegExp(`^reap-batch: cannot read ${file}: ENOENT`),
    )
  })

  it('refuses a file that is not JSON', async () => {
    const at = world()
    const { file, result } = await refused(at, '{not json')
    expect(result).toEqual({ outcome: 'failed', error: `reap-batch: ${file} is not JSON` })
  })

  it.each([
    ['an object', '{}', 'is not a list of workflow entries'],
    ['an empty list', '[]', 'has no entry'],
  ])('refuses %s', async (_name, text, problem) => {
    const at = world()
    const { file, result } = await refused(at, text)
    expect(result).toEqual({ outcome: 'failed', error: `reap-batch: ${file} ${problem}` })
  })

  const GONE = Symbol('gone')

  /** One valid entry, with the value at `path` set, or removed for `GONE`. */
  const edited = (repo: string, path: readonly string[], to: unknown): unknown => {
    const value = structuredClone(entry(repo, null)) as Record<string, unknown>
    const at = path.slice(0, -1).reduce((node, key) => node[key] as Record<string, unknown>, value)
    const last = path[path.length - 1] as string
    if (to === GONE) Reflect.deleteProperty(at, last)
    else at[last] = to
    return value
  }

  it.each([
    ['has no dispatch object', ['dispatch'], []],
    ['has a dispatch.repo_root that is not text', ['dispatch', 'repo_root'], ''],
    ['has a dispatch.env_prefix that is not text', ['dispatch', 'env_prefix'], null],
    ['has no dispatch.group object', ['dispatch', 'group'], GONE],
    ['has no dispatch.group object', ['dispatch', 'group'], []],
    ['has a dispatch.group.package that is not text', ['dispatch', 'group', 'package'], 5],
    ['has a dispatch.group.branch_name that is not text', ['dispatch', 'group', 'branch_name'], ''],
    [
      'has a dispatch.group.major_line that is not text or a whole number',
      ['dispatch', 'group', 'major_line'],
      1.5,
    ],
    [
      'has a dispatch.group.major_line that is not text or a whole number',
      ['dispatch', 'group', 'major_line'],
      -1,
    ],
    [
      'has a dispatch.group.major_line that is not text or a whole number',
      ['dispatch', 'group', 'major_line'],
      '',
    ],
    ['has a mispaired that is not true or false', ['mispaired'], 'no'],
    ['has no result', ['result'], GONE],
  ] as const)('refuses an entry that %s, and reaps no entry', async (problem, path, to) => {
    const at = world()
    fixed(at)
    const { file, result } = await refused(
      at,
      JSON.stringify([entry(at.repo, success()), edited(at.repo, path, to)]),
    )
    expect(result).toEqual({ outcome: 'failed', error: `reap-batch: ${file} entry 1 ${problem}` })
    expect(existsSync(`${workOf(at.repo, PLAIN)}/fix`)).toBe(true)
    expect(branches(at)).toEqual(['fix/dependabot-example-pkg-6x', 'main'])
  })

  it.each(['null', '[]'])('refuses an entry %s, as it is not an object', async (value) => {
    const at = world()
    const { file, result } = await refused(at, `[${value}]`)
    expect(result).toEqual({
      outcome: 'failed',
      error: `reap-batch: ${file} entry 0 is not an object`,
    })
  })
})

describe('the command', () => {
  it('runs the handler, which refuses a bare invocation with its usage', async () => {
    const at = world()
    expect(await reapBatchCommand(context(at, []))).toEqual({
      outcome: 'failed',
      error: 'usage: gh-security reap-batch <results.json>',
    })
  })
})

describe('the report', () => {
  it('has the keys of post-agent.sh, in its order', async () => {
    const at = world()
    const report = await only(reapAll(at, [entry(at.repo, null)]))
    expect(Object.keys(report as Record<string, JsonValue>)).toEqual([
      'package',
      'major_line',
      'branch',
      'worktree_path',
      'result_status',
      'pr_url',
      'pr_state',
      'reaped',
      'reason',
      'left_behind',
      'errors',
    ])
  })
})
