// `gh-security fix-group cleanup`, and the signal hook of `fix-group setup`.
// The seam is the exported handler, with the runner, the registry and the
// signals of the process as parameters. git is real: `setup` makes the
// worktree in a repository with a bare origin from `harness/git.ts`. A git
// failure comes from the git shim of that harness on PATH. The expected
// values are written by hand from the header of `fix-group.ts`.
// `parity-reap.test.ts` compares the port with the capture of
// `fix-group.sh cleanup`.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import type { Signals } from '#gh-security/signals.ts'
import { fixGroup } from '#gh-security/subcommands/fix-group.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

vi.setConfig({ testTimeout: 60_000 })

const BRANCH = 'fix/dependabot-example-pkg-6x'
const DRIFT = 'chore(deps): refresh lockfile (control install, no manifest change)'
const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')
const LEFT =
  "left in place: the tip is not on origin and is not this flow's own leftover, and a commit " +
  'that never reached the remote is the one thing here that cannot be recreated'

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly root: string
  readonly repo: string
  readonly groupFile: string
  readonly work: string
  readonly wt: string
  readonly env: NodeJS.ProcessEnv
}

const world = (): World => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const root = join(realpathSync(sandbox.path), 'r')
  const repo = fixtures.create(root)
  for (const role of ['AUTHOR', 'COMMITTER']) {
    sandbox.env[`GIT_${role}_NAME`] = 'Fixture'
    sandbox.env[`GIT_${role}_EMAIL`] = 'fixture@example.invalid'
  }
  const groupFile = join(root, 'group.json')
  writeFileSync(
    groupFile,
    JSON.stringify({
      package: 'example-pkg',
      ecosystem: 'npm',
      major_line: '6',
      highest_fixed_version: '6.1.0',
      branch_name: BRANCH,
      alerts: [{ number: 1, vulnerable_range: '< 6.1.0' }],
    }),
  )
  const work = join(repo, '.claude', 'worktrees', 'fix-dependabot-example-pkg-6x')
  return { sandbox, fixtures, root, repo, groupFile, work, wt: join(work, 'fix'), env: sandbox.env }
}

interface Answer {
  readonly status: number
  readonly json: JsonValue
  readonly stderr: string
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) throw new Error('fix-group answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value, stderr: '' }
  if ('report' in result) {
    return { status: result.exitCode ?? 1, json: result.report, stderr: result.error }
  }
  return { status: exitCodeFor(result), json: { error: result.error }, stderr: result.error }
}

const contextOf = (
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  stderr: string[] = [],
): CommandContext => ({
  args,
  env,
  io: { stdout: () => {}, stderr: (text) => stderr.push(text), readStdin: () => '' },
  commandNames: [],
})

const call = async (w: World, args: readonly string[], env = w.env): Promise<Answer> =>
  answerOf(await fixGroup(contextOf(env, args), { spawn: run, route: selectAdapter }))

const setupArgs = (w: World): string[] => [
  'setup',
  '--group-json',
  w.groupFile,
  '--repo-root',
  w.repo,
  '--default-branch',
  'main',
]

const setUp = async (w: World): Promise<void> => {
  expect((await call(w, setupArgs(w))).status).toBe(0)
}

const commitIn = (w: World, file: string, subject = `fix: ${file}`): void => {
  mkdirSync(join(w.wt, file, '..'), { recursive: true })
  writeFileSync(join(w.wt, file), `${file}\n`)
  w.fixtures.git(w.wt, 'add', '-A')
  w.fixtures.git(w.wt, 'commit', '-qm', subject)
}

const refusing = (w: World, ...failing: string[]): NodeJS.ProcessEnv => {
  const shim = w.fixtures.gitShim(...failing)
  return { ...w.env, PATH: `${shim.directory}:${w.env.PATH}`, GIT_STUB_FAIL: shim.failing }
}

/** The report of a cleanup in which nothing failed, with the named changes. */
const clean = (w: World, changes: Record<string, JsonValue>): Answer => ({
  status: 0,
  json: {
    status: 'ok',
    step: 'cleanup',
    worktree_removed: true,
    worktree: { path: w.wt, action: 'removed' },
    work_dir: { path: w.work, action: 'removed' },
    branch: BRANCH,
    branch_deleted: true,
    branch_tip: w.fixtures.sha(w.repo, 'main'),
    reason: 'tip still equals origin/main: there is nothing on the branch to lose',
    detail: null,
    errors: [],
    left_behind: [],
    ...changes,
  },
  stderr: '',
})

describe('fix-group cleanup', () => {
  it('removes a fresh workspace and deletes its branch, which is at origin/main', async () => {
    const w = world()
    await setUp(w)
    expect(await call(w, ['cleanup', '--work', w.work])).toEqual(clean(w, {}))
    expect(existsSync(w.work)).toBe(false)
    expect(w.fixtures.branches(w.repo)).toEqual(['main'])
  })

  it('deletes a pushed branch with --pushed', async () => {
    const w = world()
    await setUp(w)
    commitIn(w, 'fix.txt')
    w.fixtures.git(w.wt, 'push', '-q', 'origin', BRANCH)
    const tip = w.fixtures.sha(w.repo, BRANCH)
    expect(await call(w, ['cleanup', '--work', w.work, '--pushed'])).toEqual(
      clean(w, {
        branch_tip: tip,
        reason: 'pushed: the remote carries the same commits, so the local ref is a duplicate',
      }),
    )
  })

  it.each([
    ['a pushed branch without --pushed', true, []],
    ['a branch that never reached origin', false, ['--pushed']],
  ])('keeps %s', async (_case, pushed, flags) => {
    const w = world()
    await setUp(w)
    commitIn(w, 'fix.txt')
    if (pushed) w.fixtures.git(w.wt, 'push', '-q', 'origin', BRANCH)
    const tip = w.fixtures.sha(w.repo, BRANCH)
    expect(await call(w, ['cleanup', '--work', w.work, ...flags])).toEqual(
      clean(w, {
        branch_deleted: false,
        branch_tip: tip,
        reason: LEFT,
        detail: `branch ${BRANCH} left in place at ${tip}`,
        left_behind: [BRANCH],
      }),
    )
    expect(w.fixtures.branches(w.repo)).toEqual([BRANCH, 'main'])
  })

  it.each([
    ['the lockfile', 'package-lock.json', true],
    ['the yarn cache', '.yarn/cache/a.zip', true],
    ['the manifest', 'package.json', false],
  ])('judges one drift commit over %s', async (_case, file, deleted) => {
    const w = world()
    await setUp(w)
    commitIn(w, file, DRIFT)
    const answer = await call(w, ['cleanup', '--work', w.work])
    const json = answer.json as Record<string, JsonValue>
    expect([json.branch_deleted, json.reason]).toEqual([
      deleted,
      deleted
        ? "the only commit is this flow's drift commit, which a rerun's control install regenerates equivalently from the same manifests"
        : LEFT,
    ])
  })

  it('keeps two drift commits', async () => {
    const w = world()
    await setUp(w)
    commitIn(w, 'package-lock.json', DRIFT)
    commitIn(w, 'yarn.lock', DRIFT)
    expect((await call(w, ['cleanup', '--work', w.work])).json).toMatchObject({
      branch_deleted: false,
      reason: LEFT,
    })
  })

  it('removes the stale registration of a worktree directory that is gone', async () => {
    const w = world()
    await setUp(w)
    // The directory goes and its registration stays.
    rmSync(w.wt, { recursive: true, force: true })
    expect(await call(w, ['cleanup', '--work', w.work])).toEqual(
      clean(w, {
        worktree_removed: false,
        worktree: { path: w.wt, action: 'stale-registration-removed' },
      }),
    )
    expect(w.fixtures.branches(w.repo)).toEqual(['main'])
  })

  it('exits 3 and keeps the work directory when the worktree does not come off', async () => {
    const w = world()
    await setUp(w)
    mkdirSync(join(w.wt, 'locked'))
    writeFileSync(join(w.wt, 'locked', 'held'), '')
    chmodSync(join(w.wt, 'locked'), 0o555)
    try {
      const failure = `git worktree remove --force ${w.wt} failed: error: failed to delete '${w.wt}': Permission denied`
      const detail =
        `${failure}; ${w.work} was left on disk: deleting it while the worktree registration ` +
        'survives is the state that blocks a later worktree add on this path and any branch -D ' +
        `of ${BRANCH}, and git worktree remove refuses to clean it up afterwards. Remove the ` +
        'registration first, by hand.'
      expect(await call(w, ['cleanup', '--work', w.work])).toEqual({
        status: 3,
        json: {
          ...(clean(w, {}).json as Record<string, JsonValue>),
          status: 'failure',
          phase: 'worktree',
          worktree_removed: false,
          worktree: { path: w.wt, action: 'removal-failed' },
          work_dir: { path: w.work, action: 'kept-registration-live' },
          detail,
          errors: [failure],
          left_behind: [w.wt, w.work],
        },
        stderr: `fix-group: cleanup failure: ${detail}`,
      })
      expect(existsSync(join(w.work, 'state.json'))).toBe(true)
    } finally {
      chmodSync(join(w.wt, 'locked'), 0o755)
    }
  })

  it('exits 3 when the work directory does not go', async () => {
    const w = world()
    await setUp(w)
    mkdirSync(join(w.work, 'locked'))
    writeFileSync(join(w.work, 'locked', 'held'), '')
    chmodSync(join(w.work, 'locked'), 0o555)
    try {
      const answer = await call(w, ['cleanup', '--work', w.work])
      const json = answer.json as Record<string, JsonValue>
      expect([answer.status, json.status, json.work_dir]).toEqual([
        3,
        'failure',
        { path: w.work, action: 'removal-failed' },
      ])
      expect(String(json.detail).startsWith(`${w.work} was not removed: E`)).toBe(true)
    } finally {
      chmodSync(join(w.work, 'locked'), 0o755)
    }
  })

  it('keeps the branch when a ref cannot be read, and exits 3', async () => {
    const w = world()
    await setUp(w)
    const env = refusing(w, `rev-parse --verify --quiet refs/remotes/origin/${BRANCH}`)
    const answer = await call(w, ['cleanup', '--work', w.work], env)
    const tip = w.fixtures.sha(w.repo, 'main')
    const failure = `git rev-parse refs/remotes/origin/${BRANCH} failed: git stub: refusing rev-parse --verify --quiet refs/remotes/origin/${BRANCH}`
    expect(answer.status).toBe(3)
    expect(answer.json).toMatchObject({
      branch_deleted: false,
      reason:
        'left in place: a ref could not be read, so whether the tip is a duplicate of pushed work ' +
        'is unknown, and a branch is never deleted on an unknown',
      detail: `${failure}; branch ${BRANCH} left in place at ${tip}`,
      errors: [failure],
    })
  })

  it('keeps a branch whose local ref cannot be read, and names no tip', async () => {
    const w = world()
    await setUp(w)
    const env = refusing(w, `rev-parse --verify --quiet refs/heads/${BRANCH}`)
    const answer = await call(w, ['cleanup', '--work', w.work], env)
    const failure = `git rev-parse refs/heads/${BRANCH} failed: git stub: refusing rev-parse --verify --quiet refs/heads/${BRANCH}`
    expect(answer.status).toBe(3)
    expect(answer.json).toMatchObject({
      branch_deleted: false,
      branch_tip: null,
      detail: failure,
      errors: [failure],
      left_behind: [BRANCH],
    })
    expect(w.fixtures.branches(w.repo)).toEqual([BRANCH, 'main'])
  })

  it.each<[string, (w: World) => void, Record<string, JsonValue>]>([
    [
      'a plain directory at the worktree path',
      (w) => {
        w.fixtures.git(w.repo, 'worktree', 'remove', '--force', w.wt)
        mkdirSync(w.wt)
      },
      { worktree_removed: false, worktree: { action: 'not-a-worktree' } },
    ],
    [
      'a registration that no admin entry names',
      (w) => {
        renameSync(w.wt, `${w.wt}.gone`)
        writeFileSync(join(w.repo, '.git', 'worktrees', 'fix', 'gitdir'), `${w.wt}\n`)
      },
      {
        status: 'failure',
        worktree: { action: 'stale-registration' },
        work_dir: { action: 'kept-registration-live' },
      },
    ],
  ])('reports %s in the words of the report', async (_case, arrange, expected) => {
    const w = world()
    await setUp(w)
    arrange(w)
    expect((await call(w, ['cleanup', '--work', w.work])).json).toMatchObject(expected)
  })

  it('exits 3 when git refuses the branch delete', async () => {
    const w = world()
    await setUp(w)
    const answer = await call(w, ['cleanup', '--work', w.work], refusing(w, 'branch -D'))
    const failure = `git branch -D ${BRANCH} failed: git stub: refusing branch -D`
    expect(answer.status).toBe(3)
    expect(answer.json).toMatchObject({
      branch_deleted: false,
      reason: 'left in place: git branch -D failed',
      errors: [failure],
    })
  })

  it('reports no branch when there is none', async () => {
    const w = world()
    await setUp(w)
    w.fixtures.git(w.repo, 'worktree', 'remove', '--force', w.wt)
    w.fixtures.git(w.repo, 'branch', '-q', '-D', BRANCH)
    expect(await call(w, ['cleanup', '--work', w.work, '--pushed'])).toEqual(
      clean(w, {
        worktree_removed: false,
        worktree: { path: w.wt, action: 'absent' },
        branch_deleted: false,
        branch_tip: null,
        reason: null,
      }),
    )
  })

  it('runs each git call under the prefix of the state', async () => {
    const w = world()
    const log = join(w.root, 'prefix.log')
    const prefix = join(w.root, 'wrap')
    writeFileSync(prefix, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec "$@"\n`)
    chmodSync(prefix, 0o755)
    expect((await call(w, [...setupArgs(w), '--env-prefix', prefix])).status).toBe(0)
    writeFileSync(log, '')
    expect((await call(w, ['cleanup', '--work', w.work])).status).toBe(0)
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((line) => line.startsWith(`git -C ${w.repo} `))).toBe(true)
  })

  it.each<[string, (w: World) => string[], (w: World) => string]>([
    ['no --work', () => ['cleanup'], () => 'cleanup: --work is required'],
    [
      'a work path outside the worktree root',
      (w) => {
        mkdirSync(join(w.root, 'outside'))
        cpSync(join(w.work, 'state.json'), join(w.root, 'outside', 'state.json'))
        return ['cleanup', '--work', join(w.root, 'outside')]
      },
      (w) =>
        `cleanup: the work path is not under ${w.repo}/.claude/worktrees/: ${w.root}/outside. Nothing was removed.`,
    ],
  ])('refuses %s, and changes nothing', async (_case, args, message) => {
    const w = world()
    await setUp(w)
    const argv = args(w)
    const branches = w.fixtures.branches(w.repo)
    expect(await call(w, argv)).toEqual({
      status: 1,
      json: { error: message(w) },
      stderr: message(w),
    })
    expect(existsSync(join(w.wt, '.git'))).toBe(true)
    expect(w.fixtures.branches(w.repo)).toEqual(branches)
  })

  it('refuses a workspace that moved after setup, and changes nothing', async () => {
    const w = world()
    await setUp(w)
    const moved = join(w.repo, '.claude', 'worktrees', 'moved')
    renameSync(w.work, moved)
    const message =
      `cleanup: --work names ${moved}, but setup recorded this run's workspace as ${w.work}. ` +
      'A removal is only ever issued against the path this run created; nothing was removed.'
    expect(await call(w, ['cleanup', '--work', moved])).toEqual({
      status: 1,
      json: { error: message },
      stderr: message,
    })
    expect(existsSync(join(moved, 'fix', '.git'))).toBe(true)
    expect(w.fixtures.branches(w.repo)).toEqual([BRANCH, 'main'])
  })

  it('refuses a state with no work path', async () => {
    const w = world()
    await setUp(w)
    const state = JSON.parse(readFileSync(join(w.work, 'state.json'), 'utf8')) as Record<
      string,
      JsonValue
    >
    delete state.work
    writeFileSync(join(w.work, 'state.json'), JSON.stringify(state))
    const answer = await call(w, ['cleanup', '--work', w.work])
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("has no usable value for 'work'")
    expect(existsSync(join(w.wt, '.git'))).toBe(true)
  })

  it('refuses a work directory with no state file', async () => {
    const w = world()
    mkdirSync(w.work, { recursive: true })
    const answer = await call(w, ['cleanup', '--work', w.work])
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain('no readable state file')
    expect(existsSync(w.work)).toBe(true)
  })

  it('refuses an option that cleanup does not take', async () => {
    const w = world()
    const answer = await call(w, ['cleanup', '--work', w.work, '--bogus'])
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("'--bogus'")
  })
})

describe('a signal during fix-group setup', () => {
  const signalsOf = () => {
    const log: string[] = []
    const listeners = new Map<string, (signal: NodeJS.Signals) => void>()
    const signals: Signals = {
      on: (signal, listener) => {
        listeners.set(signal, listener)
      },
      off: (signal) => {
        listeners.delete(signal)
      },
      exit: (status) => {
        log.push(`exit ${status}`)
      },
    }
    return { log, listeners, signals }
  }

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'removes the worktree, the work directory and the branch on %s',
    async (signal, status) => {
      const w = world()
      const { log, listeners, signals } = signalsOf()
      const stderr: string[] = []
      // The runner sends the signal after `worktree add`, as a signal that
      // comes while the worktree is there.
      const sending = async (command: string, args: readonly string[] = [], options = {}) => {
        const result = await run(command, args, options)
        if (args.slice(2, 4).join(' ') === 'worktree add') listeners.get(signal)?.(signal)
        return result
      }
      await fixGroup(
        contextOf(w.env, setupArgs(w), stderr),
        { spawn: sending, route: selectAdapter },
        signals,
      )
      expect(log).toEqual([`exit ${status}`])
      expect(existsSync(w.work)).toBe(false)
      expect(w.fixtures.branches(w.repo)).toEqual(['main'])
      expect(w.fixtures.git(w.repo, 'worktree', 'list', '--porcelain').split('\n')[0]).toBe(
        `worktree ${w.repo}`,
      )
      const prefix = `fix-group: setup stopped by ${signal}: `
      const line = stderr.join('')
      expect(line.startsWith(prefix)).toBe(true)
      expect(JSON.parse(line.slice(prefix.length))).toEqual({
        repo_root: w.repo,
        branch: BRANCH,
        work: w.work,
        worktree: { path: w.wt, action: 'removed' },
        work_dir: { path: w.work, action: 'removed' },
        branch_ref: {
          action: 'deleted',
          reason: 'tip-on-default',
          local_tip: w.fixtures.sha(w.repo, 'main'),
          origin_tip: null,
        },
        left_behind: [],
        errors: [],
      })
    },
  )

  it('removes nothing when the paths fail containment, and says so', async () => {
    const w = world()
    const { log, listeners, signals } = signalsOf()
    const stderr: string[] = []
    const sending = async (command: string, args: readonly string[] = [], options = {}) => {
      const result = await run(command, args, options)
      if (args.slice(2, 4).join(' ') === 'worktree add') listeners.get('SIGTERM')?.('SIGTERM')
      return result
    }
    // A repository root with a `..` segment gives a work path with one.
    const dotted = `${w.repo}/../work`
    const args = setupArgs(w).map((arg) => (arg === w.repo ? dotted : arg))
    await fixGroup(
      contextOf(w.env, args, stderr),
      { spawn: sending, route: selectAdapter },
      signals,
    )
    expect(log).toEqual(['exit 143'])
    expect(existsSync(join(w.wt, '.git'))).toBe(true)
    expect(existsSync(join(w.work, 'state.json'))).toBe(true)
    expect(w.fixtures.branches(w.repo)).toEqual([BRANCH, 'main'])
    expect(w.fixtures.git(w.repo, 'worktree', 'list', '--porcelain')).toContain(
      `worktree ${w.wt}\n`,
    )
    expect(stderr.join('')).toBe(
      `fix-group: setup stopped by SIGTERM: ${JSON.stringify({
        outcome: 'failed',
        error: `the work path must not contain a .. segment: ${dotted}/.claude/worktrees/fix-dependabot-example-pkg-6x`,
      })}\n`,
    )
  })

  it('reaps nothing when git refuses worktree add, as the paths can be of another run', async () => {
    const w = world()
    const { log, listeners, signals } = signalsOf()
    const stderr: string[] = []
    // Another run makes its worktree at the same path just before this one.
    const sending = async (command: string, args: readonly string[] = [], options = {}) => {
      if (args.slice(2, 4).join(' ') === 'worktree add') {
        w.fixtures.branch(w.repo, 'other')
        w.fixtures.worktree(w.repo, w.wt, 'other')
      }
      const result = await run(command, args, options)
      if (args.slice(2, 4).join(' ') === 'worktree add') listeners.get('SIGTERM')?.('SIGTERM')
      return result
    }
    await fixGroup(
      contextOf(w.env, setupArgs(w), stderr),
      { spawn: sending, route: selectAdapter },
      signals,
    )
    expect(log).toEqual(['exit 143'])
    expect(existsSync(join(w.wt, '.git'))).toBe(true)
    // git makes the branch before it refuses the path. The branch stays at
    // origin/main, and the stale-branch guard of the next setup clears it.
    expect(w.fixtures.branches(w.repo)).toEqual([BRANCH, 'main', 'other'])
    expect(stderr.join('')).toBe(
      'fix-group: setup stopped by SIGTERM: git refused worktree add, so nothing was reaped\n',
    )
  })

  it('reaps when a signal stopped worktree add, which then has no status', async () => {
    const w = world()
    const { log, listeners, signals } = signalsOf()
    const sending = async (command: string, args: readonly string[] = [], options = {}) => {
      const result = await run(command, args, options)
      if (args.slice(2, 4).join(' ') !== 'worktree add') return result
      listeners.get('SIGINT')?.('SIGINT')
      return { ...result, status: null }
    }
    await fixGroup(
      contextOf(w.env, setupArgs(w)),
      { spawn: sending, route: selectAdapter },
      signals,
    )
    expect(log).toEqual(['exit 130'])
    expect(existsSync(w.work)).toBe(false)
    expect(w.fixtures.branches(w.repo)).toEqual(['main'])
  })

  it('keeps the workspace when no signal comes', async () => {
    const w = world()
    const { log, signals } = signalsOf()
    const answer = answerOf(
      await fixGroup(contextOf(w.env, setupArgs(w)), { spawn: run, route: selectAdapter }, signals),
    )
    expect(answer.status).toBe(0)
    expect(log).toEqual([])
    expect(existsSync(join(w.wt, '.git'))).toBe(true)
  })

  it('removes the workspace when SIGTERM stops a real process', async () => {
    const w = world()
    // The prefix runs each git call. After `worktree add`, it sends SIGTERM to
    // the command, which then holds a worktree.
    const hold = join(w.root, 'hold.sh')
    writeFileSync(
      hold,
      [
        '"$@"',
        'status=$?',
        'case " $* " in *" worktree add "*) kill -s TERM "$PPID" ;; esac',
        'exit "$status"',
        '',
      ].join('\n'),
    )
    chmodSync(hold, 0o755)
    const result = await run(
      process.execPath,
      [ENTRY, 'fix-group', ...setupArgs(w), '--env-prefix', `sh ${hold}`],
      { env: w.env },
    )
    expect([result.status, result.stdout]).toEqual([143, ''])
    expect(existsSync(w.work)).toBe(false)
    expect(w.fixtures.branches(w.repo)).toEqual(['main'])
  })
})
