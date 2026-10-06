// The reap module: `contain` and `reap`. git and the filesystem are real: each
// example builds a repository with a bare origin through `harness/git.ts`,
// in its own sandbox. A git failure comes from the git shim of that harness
// on PATH. The expected values are written by hand from the header of
// `src/reap.ts`. Each refusal also proves that the disk did not change.
// `parity-reap.test.ts` compares the module with the capture of the bash.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { type JsonValue, ok } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import {
  type BranchPolicy,
  type Contained,
  contain,
  type Git,
  reap,
  resolvePhysical,
} from '#gh-security/reap.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

vi.setConfig({ testTimeout: 60_000 })

const BRANCH = 'fix/dependabot-example-pkg-6x'
const LEAF = 'fix-dependabot-example-pkg-6x'

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly root: string
  readonly repo: string
  readonly work: string
  readonly wt: string
  readonly git: Git
}

const world = (): World => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const root = join(realpathSync(sandbox.path), 'r')
  const repo = fixtures.create(root)
  const work = join(repo, '.claude', 'worktrees', LEAF)
  return { sandbox, fixtures, root, repo, work, wt: join(work, 'fix'), git: gitIn(sandbox.env) }
}

const gitIn =
  (env: NodeJS.ProcessEnv): Git =>
  (dir, args) =>
    run('git', ['-C', dir, ...args], { env })

/** git through the shim, which refuses the named subcommands. */
const shimmed = (w: World, ...failing: string[]): Git => {
  const shim = w.fixtures.gitShim(...failing)
  return gitIn({
    ...w.sandbox.env,
    PATH: `${shim.directory}:${w.sandbox.env.PATH}`,
    GIT_STUB_FAIL: shim.failing,
  })
}

const addWorktree = (w: World): void => {
  mkdirSync(join(w.repo, '.claude', 'worktrees'), { recursive: true })
  w.fixtures.git(w.repo, 'worktree', 'add', '-q', w.wt, '-b', BRANCH, 'origin/main')
}

const commitIn = (w: World, file: string): void => {
  writeFileSync(join(w.wt, file), `${file}\n`)
  w.fixtures.git(w.wt, 'add', '-A')
  w.fixtures.git(w.wt, 'commit', '-qm', `fix: ${file}`)
}

const push = (w: World): void => {
  w.fixtures.git(w.wt, 'push', '-q', 'origin', BRANCH)
}

/** A directory that holds one file and cannot be written, so nothing in it can go. */
const lockDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'held'), '')
  chmodSync(dir, 0o555)
}

/** Each path under the root, with its kind, then the worktrees and the refs. */
const disk = (w: World): JsonValue => {
  const paths: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const relPath = rel === '' ? name : `${rel}/${name}`
      if (relPath === 'origin.git' || relPath === 'work/.git') continue
      const stat = lstatSync(path)
      paths.push(`${stat.isSymbolicLink() ? 'l' : stat.isDirectory() ? 'd' : 'f'} ${relPath}`)
      if (stat.isDirectory()) walk(path, relPath)
    }
  }
  walk(w.root, '')
  return {
    paths,
    worktrees: w.fixtures.git(w.repo, 'worktree', 'list', '--porcelain'),
    refs: w.fixtures.git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
  }
}

const target = (w: World, overrides: Partial<Parameters<typeof contain>[0]> = {}) => ({
  repoRoot: w.repo,
  work: w.work,
  worktree: w.wt,
  branch: BRANCH,
  ...overrides,
})

const contained = async (w: World, overrides = {}): Promise<Contained> => {
  const answer = await contain(target(w, overrides), w.git)
  if (answer.outcome !== 'ok') throw new Error(answer.error)
  return answer.value
}

const ORIGIN_ONLY: BranchPolicy = { pushed: true, defaultBranch: null }

describe('contain', () => {
  it('answers the paths with their links resolved', async () => {
    const w = world()
    symlinkSync(w.repo, join(w.root, 'alias'))
    const alias = join(w.root, 'alias')
    const answer = await contain(
      target(w, {
        repoRoot: alias,
        work: join(alias, '.claude', 'worktrees', LEAF),
        worktree: join(alias, '.claude', 'worktrees', LEAF, 'fix'),
      }),
      w.git,
    )
    expect(answer).toEqual(ok({ repoRoot: w.repo, work: w.work, worktree: w.wt, branch: BRANCH }))
  })

  it.each<
    [
      string,
      (w: World) => void,
      (w: World) => Partial<Parameters<typeof contain>[0]>,
      (w: World) => string,
    ]
  >([
    [
      'a repository root that is not there',
      () => {},
      (w) => ({ repoRoot: join(w.root, 'missing') }),
      (w) => `repo_root does not exist: ${w.root}/missing`,
    ],
    [
      'a repository root that is not a repository',
      (w) => mkdirSync(join(w.root, 'plain')),
      (w) => ({ repoRoot: join(w.root, 'plain') }),
      (w) => `not a git repository: ${w.root}/plain`,
    ],
    [
      'a branch that starts with a dash',
      () => {},
      () => ({ branch: '-D' }),
      () => 'branch name must not begin with a dash: -D',
    ],
    [
      'a branch name that git refuses',
      () => {},
      () => ({ branch: 'a..b' }),
      () => 'not a valid branch name: a..b',
    ],
    [
      'a work path with a .. segment, even when it resolves inside',
      (w) => mkdirSync(join(w.repo, '.claude', 'worktrees', 'there'), { recursive: true }),
      (w) => ({ work: `${join(w.repo, '.claude', 'worktrees', 'there')}/../${LEAF}` }),
      (w) =>
        `the work path must not contain a .. segment: ${w.repo}/.claude/worktrees/there/../${LEAF}`,
    ],
    [
      'a work path outside the worktree root',
      (w) => mkdirSync(join(w.root, 'outside', LEAF), { recursive: true }),
      (w) => ({ work: join(w.root, 'outside', LEAF) }),
      (w) =>
        `the work path is not under ${w.repo}/.claude/worktrees/: ${w.root}/outside/${LEAF}. Nothing was removed.`,
    ],
    [
      'the worktree root itself',
      (w) => mkdirSync(join(w.repo, '.claude', 'worktrees'), { recursive: true }),
      (w) => ({ work: join(w.repo, '.claude', 'worktrees') }),
      (w) =>
        `the work path is not under ${w.repo}/.claude/worktrees/: ${w.repo}/.claude/worktrees. Nothing was removed.`,
    ],
    [
      'the worktree root itself, with a slash at its end',
      (w) => mkdirSync(join(w.repo, '.claude', 'worktrees'), { recursive: true }),
      (w) => ({ work: `${join(w.repo, '.claude', 'worktrees')}/` }),
      (w) =>
        `the work path is not under ${w.repo}/.claude/worktrees/: ${w.repo}/.claude/worktrees. Nothing was removed.`,
    ],
    [
      'a worktree root that a link moved out of the repository',
      (w) => {
        addWorktree(w)
        mkdirSync(join(w.root, 'elsewhere'))
        renameSync(join(w.repo, '.claude', 'worktrees'), join(w.root, 'elsewhere', 'wt'))
        symlinkSync(join(w.root, 'elsewhere', 'wt'), join(w.repo, '.claude', 'worktrees'))
      },
      () => ({}),
      (w) =>
        `the work path is not under ${w.repo}/.claude/worktrees/: ${w.root}/elsewhere/wt/${LEAF}. Nothing was removed.`,
    ],
    [
      'a work path other than the one that setup recorded',
      (w) => {
        addWorktree(w)
        mkdirSync(join(w.repo, '.claude', 'worktrees', 'other'))
      },
      (w) => ({ work: join(w.repo, '.claude', 'worktrees', 'other'), recordedWork: w.work }),
      (w) =>
        `--work names ${w.repo}/.claude/worktrees/other, but setup recorded this run's workspace as ${w.work}. A removal is only ever issued against the path this run created; nothing was removed.`,
    ],
    [
      'a worktree path with a .. segment',
      (w) => addWorktree(w),
      (w) => ({ worktree: `${w.work}/../${LEAF}/fix` }),
      (w) => `the worktree path must not contain a .. segment: ${w.work}/../${LEAF}/fix`,
    ],
    [
      'a worktree path that a link takes outside',
      (w) => {
        mkdirSync(w.work, { recursive: true })
        mkdirSync(join(w.root, 'outside', 'fix'), { recursive: true })
        symlinkSync(join(w.root, 'outside', 'fix'), w.wt)
      },
      () => ({}),
      (w) =>
        `the worktree path resolves outside ${w.repo}/.claude/worktrees/: ${w.root}/outside/fix. Nothing was removed.`,
    ],
  ])('refuses %s, and changes nothing', async (_case, arrange, overrides, message) => {
    const w = world()
    arrange(w)
    const before = disk(w)
    expect(await contain(target(w, overrides(w)), w.git)).toEqual({
      outcome: 'failed',
      error: message(w),
    })
    expect(disk(w)).toEqual(before)
  })

  it('accepts the work path that setup recorded, through a link', async () => {
    const w = world()
    addWorktree(w)
    symlinkSync(w.work, join(w.root, 'link'))
    const answer = await contain(
      target(w, { work: join(w.root, 'link'), recordedWork: w.work }),
      w.git,
    )
    expect(answer).toEqual(ok({ repoRoot: w.repo, work: w.work, worktree: w.wt, branch: BRANCH }))
  })
})

describe('resolvePhysical', () => {
  it('walks up past a directory that cannot be searched', () => {
    const w = world()
    const shut = join(w.root, 'shut')
    mkdirSync(join(shut, 'inner'), { recursive: true })
    chmodSync(shut, 0)
    try {
      expect(resolvePhysical(join(shut, 'inner', 'leaf'))).toBe(`${w.root}/shut/inner/leaf`)
    } finally {
      chmodSync(shut, 0o755)
    }
  })

  it('makes a relative path absolute', () => {
    expect(resolvePhysical('no-such-leaf')).toBe(join(realpathSync(process.cwd()), 'no-such-leaf'))
  })
})

describe('reap', () => {
  it('removes the worktree and the work directory, and deletes a tip that is on origin', async () => {
    const w = world()
    addWorktree(w)
    commitIn(w, 'fix.txt')
    push(w)
    const tip = w.fixtures.sha(w.repo, BRANCH)
    expect(await reap(await contained(w), ORIGIN_ONLY, w.git)).toEqual({
      repo_root: w.repo,
      branch: BRANCH,
      work: w.work,
      worktree: { path: w.wt, action: 'removed' },
      work_dir: { path: w.work, action: 'removed' },
      branch_ref: { action: 'deleted', reason: 'tip-on-origin', local_tip: tip, origin_tip: tip },
      left_behind: [],
      errors: [],
    })
    expect(existsSync(w.work)).toBe(false)
    expect(w.fixtures.branches(w.repo)).toEqual(['main'])
    expect(w.fixtures.git(w.repo, 'worktree', 'list', '--porcelain')).toBe(
      `worktree ${w.repo}\nHEAD ${w.fixtures.sha(w.repo, 'main')}\nbranch refs/heads/main`,
    )
  })

  it('removes a dirty worktree', async () => {
    const w = world()
    addWorktree(w)
    writeFileSync(join(w.wt, 'file.txt'), 'changed\n')
    writeFileSync(join(w.wt, 'new.txt'), 'new\n')
    const report = await reap(await contained(w), { pushed: false, defaultBranch: 'main' }, w.git)
    expect([report.worktree.action, report.work_dir.action, report.branch_ref.action]).toEqual([
      'removed',
      'removed',
      'deleted',
    ])
    expect(existsSync(w.work)).toBe(false)
  })

  it.each<[string, (w: World) => void, BranchPolicy, string, string]>([
    [
      'a tip at the default branch, with no rule for it',
      () => {},
      ORIGIN_ONLY,
      'left',
      'no-remote-tracking-ref',
    ],
    [
      'a tip at the default branch',
      () => {},
      { pushed: false, defaultBranch: 'main' },
      'deleted',
      'tip-on-default',
    ],
    [
      'a pushed tip, when the push is not confirmed',
      (w) => {
        commitIn(w, 'fix.txt')
        push(w)
      },
      { pushed: false, defaultBranch: 'main' },
      'left',
      'push-not-confirmed',
    ],
    [
      'a tip ahead of origin',
      (w) => {
        commitIn(w, 'fix.txt')
        push(w)
        commitIn(w, 'more.txt')
      },
      ORIGIN_ONLY,
      'left',
      'tip-not-on-origin',
    ],
    [
      'a tip that the caller proves is its own leftover',
      (w) => commitIn(w, 'fix.txt'),
      { pushed: true, defaultBranch: 'main', leftover: async () => true },
      'deleted',
      'own-leftover',
    ],
    [
      'a tip that the caller does not claim',
      (w) => commitIn(w, 'fix.txt'),
      { pushed: true, defaultBranch: 'main', leftover: async () => false },
      'left',
      'no-remote-tracking-ref',
    ],
  ])('decides the branch for %s', async (_case, arrange, policy, action, reason) => {
    const w = world()
    addWorktree(w)
    arrange(w)
    const report = await reap(await contained(w), policy, w.git)
    expect([report.branch_ref.action, report.branch_ref.reason]).toEqual([action, reason])
    expect(report.left_behind).toEqual(action === 'left' ? [BRANCH] : [])
    expect(report.errors).toEqual([])
    expect(w.fixtures.branches(w.repo)).toEqual(action === 'left' ? [BRANCH, 'main'] : ['main'])
  })

  it('reports nothing to do when nothing is there', async () => {
    const w = world()
    expect(await reap(await contained(w), ORIGIN_ONLY, w.git)).toEqual({
      repo_root: w.repo,
      branch: BRANCH,
      work: w.work,
      worktree: { path: w.wt, action: 'absent' },
      work_dir: { path: w.work, action: 'absent' },
      branch_ref: {
        action: 'absent',
        reason: 'no-local-branch',
        local_tip: null,
        origin_tip: null,
      },
      left_behind: [],
      errors: [],
    })
  })

  it('removes the one admin entry of a registration whose directory is gone', async () => {
    const w = world()
    w.fixtures.branch(w.repo, 'sibling')
    w.fixtures.worktree(w.repo, join(w.repo, '.claude', 'worktrees', 'sibling'), 'sibling')
    addWorktree(w)
    commitIn(w, 'fix.txt')
    push(w)
    renameSync(w.wt, join(w.root, 'moved-away'))
    // An entry with no `gitdir` file, before the others in name order.
    mkdirSync(join(w.repo, '.git', 'worktrees', 'aaa'))
    const report = await reap(await contained(w), ORIGIN_ONLY, w.git)
    expect([report.worktree.action, report.work_dir.action, report.branch_ref.action]).toEqual([
      'stale-registration-removed',
      'removed',
      'deleted',
    ])
    expect(readdirSync(join(w.repo, '.git', 'worktrees'))).toEqual(['aaa', 'sibling'])
  })

  it('refuses a stale registration that no admin entry names', async () => {
    const w = world()
    addWorktree(w)
    const admin = join(w.repo, '.git', 'worktrees', 'fix')
    renameSync(w.wt, join(w.root, 'moved-away'))
    // git lists a gitdir with no `/.git` at its end as the path itself. So
    // the list names the worktree, and the entry text names no `.git`.
    writeFileSync(join(admin, 'gitdir'), `${w.wt}\n`)
    const report = await reap(await contained(w), ORIGIN_ONLY, w.git)
    expect(report.worktree).toEqual({ path: w.wt, action: 'stale-registration' })
    expect(report.work_dir).toEqual({ path: w.work, action: 'skipped' })
    expect(report.errors[0]).toBe(`a registration for ${w.wt} survives and no admin entry names it`)
    expect(report.left_behind.slice(0, 2)).toEqual([w.wt, w.work])
    expect(existsSync(w.work)).toBe(true)
  })

  it('reports an admin entry that cannot be removed', async () => {
    const w = world()
    addWorktree(w)
    rmTree(w.wt)
    const entries = join(w.repo, '.git', 'worktrees')
    chmodSync(entries, 0o555)
    try {
      const report = await reap(await contained(w), ORIGIN_ONLY, w.git)
      expect(report.worktree.action).toBe('stale-registration')
      expect(report.errors[0]).toMatch(
        new RegExp(`^could not remove the admin entry ${entries}/fix: EACCES`),
      )
    } finally {
      chmodSync(entries, 0o755)
    }
  })

  it('reads no admin entry when git cannot name its common directory', async () => {
    const w = world()
    addWorktree(w)
    rmTree(w.wt)
    const report = await reap(
      await contained(w),
      ORIGIN_ONLY,
      shimmed(w, 'rev-parse --git-common-dir'),
    )
    expect(report.worktree.action).toBe('stale-registration')
  })

  it('fails closed when the worktree list cannot be read', async () => {
    const w = world()
    mkdirSync(w.work, { recursive: true })
    const report = await reap(await contained(w), ORIGIN_ONLY, shimmed(w, 'worktree list'))
    expect(report.worktree).toEqual({ path: w.wt, action: 'failed' })
    expect(report.work_dir.action).toBe('skipped')
    expect(report.errors[0]).toBe('git worktree list failed: git stub: refusing worktree list')
    expect(existsSync(w.work)).toBe(true)
  })

  it('quotes why git did not start', async () => {
    const w = world()
    const target = await contained(w)
    const missing: Git = (dir, args) =>
      run('no-such-git-here', ['-C', dir, ...args], { env: w.sandbox.env })
    const report = await reap(target, ORIGIN_ONLY, missing)
    expect(report.worktree.action).toBe('failed')
    expect(report.errors[0]).toMatch(/^git worktree list failed: .*no-such-git-here.*ENOENT/)
  })

  it('removes a plain directory at the worktree path', async () => {
    const w = world()
    mkdirSync(w.wt, { recursive: true })
    writeFileSync(join(w.wt, 'x'), 'x\n')
    const report = await reap(await contained(w), ORIGIN_ONLY, w.git)
    expect([report.worktree.action, report.work_dir.action]).toEqual(['not-a-worktree', 'removed'])
    expect(existsSync(w.work)).toBe(false)
  })

  it('keeps a work path that is a file, and fails', async () => {
    const w = world()
    mkdirSync(join(w.repo, '.claude', 'worktrees'), { recursive: true })
    writeFileSync(w.work, 'x\n')
    const report = await reap(await contained(w), ORIGIN_ONLY, w.git)
    expect(report.work_dir).toEqual({ path: w.work, action: 'not-a-directory' })
    expect(report.errors).toEqual([`the work path exists and is not a directory: ${w.work}`])
    expect(report.left_behind).toEqual([w.work])
    expect(existsSync(w.work)).toBe(true)
  })

  it('keeps the work directory when the worktree cannot be removed', async () => {
    const w = world()
    addWorktree(w)
    lockDir(join(w.wt, 'locked'))
    try {
      const report = await reap(await contained(w), { pushed: false, defaultBranch: 'main' }, w.git)
      expect(report.worktree).toEqual({ path: w.wt, action: 'failed' })
      expect(report.work_dir).toEqual({ path: w.work, action: 'skipped' })
      expect(report.errors[0]).toBe(
        `git worktree remove --force ${w.wt} failed: error: failed to delete '${w.wt}': Permission denied`,
      )
      expect(report.left_behind.slice(0, 2)).toEqual([w.wt, w.work])
      expect(existsSync(join(w.work, 'fix', 'locked', 'held'))).toBe(true)
    } finally {
      chmodSync(join(w.wt, 'locked'), 0o755)
    }
  })

  it('reports a work directory that does not go', async () => {
    const w = world()
    addWorktree(w)
    lockDir(join(w.work, 'locked'))
    try {
      const report = await reap(await contained(w), { pushed: false, defaultBranch: 'main' }, w.git)
      expect(report.work_dir).toEqual({ path: w.work, action: 'failed' })
      // The text after the colon is node's, and its errno differs by
      // platform: EACCES on the file, or ENOTEMPTY on the directory.
      expect(report.errors).toHaveLength(1)
      expect(report.errors[0]?.startsWith(`${w.work} was not removed: E`)).toBe(true)
      expect(existsSync(join(w.work, 'locked', 'held'))).toBe(true)
      expect(report.left_behind).toEqual([w.work])
      expect(report.branch_ref.action).toBe('deleted')
    } finally {
      chmodSync(join(w.work, 'locked'), 0o755)
    }
  })

  it('leaves the branch when a ref cannot be read', async () => {
    const w = world()
    addWorktree(w)
    const report = await reap(
      await contained(w),
      { pushed: true, defaultBranch: 'main' },
      shimmed(w, 'rev-parse --verify --quiet refs/remotes/origin/main'),
    )
    expect(report.branch_ref).toEqual({
      action: 'left',
      reason: 'tip-read-failed',
      local_tip: w.fixtures.sha(w.repo, 'main'),
      origin_tip: null,
    })
    expect(report.errors).toEqual([
      'git rev-parse refs/remotes/origin/main failed: git stub: refusing rev-parse --verify --quiet refs/remotes/origin/main',
    ])
    expect(w.fixtures.branches(w.repo)).toEqual([BRANCH, 'main'])
  })

  it('reports a branch delete that git refuses', async () => {
    const w = world()
    addWorktree(w)
    const report = await reap(
      await contained(w),
      { pushed: false, defaultBranch: 'main' },
      shimmed(w, 'branch -D'),
    )
    expect(report.branch_ref.action).toBe('left')
    expect(report.branch_ref.reason).toBe('delete-failed')
    expect(report.errors).toEqual([`git branch -D ${BRANCH} failed: git stub: refusing branch -D`])
    expect(report.left_behind).toEqual([BRANCH])
  })
})

/** Take a worktree directory away, and keep its registration. */
const rmTree = (path: string): void => {
  renameSync(path, `${path}.gone`)
}
