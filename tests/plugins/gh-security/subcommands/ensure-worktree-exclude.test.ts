// `gh-security ensure-worktree-exclude`. The seam is the exported function and the
// handler. Every example runs on a real repository built by `harness/git.ts`,
// and the expected file text is written by hand. The bash script is compared in
// `parity-ensure-worktree-exclude.test.ts`.
//
// The concurrency example starts real processes, because the lock is for
// processes. Inside one process the change runs without a pause, so two calls
// never overlap there.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext } from '#gh-security/cli/command.ts'
import { run } from '#gh-security/lib/process.ts'
import {
  ensureWorktreeExclude,
  ensureWorktreeExcludeCommand,
  LINE,
  LOCK_TIMING,
  type LockTiming,
} from '#gh-security/subcommands/ensure-worktree-exclude.ts'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

/** A short wait, so an example that meets a held lock does not wait for seconds. */
const QUICK: LockTiming = { attempts: 3, waitMs: 1 }

const notRoot = process.getuid?.() !== 0

const setup = () => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const root = join(realpathSync(sandbox.path), 'scene')
  mkdirSync(root)
  const repo = fixtures.createAt(root, 'repo')
  const gitDir = join(repo, '.git')
  return {
    sandbox,
    fixtures,
    root,
    repo,
    gitDir,
    info: join(gitDir, 'info'),
    exclude: join(gitDir, 'info', 'exclude'),
    lock: join(gitDir, 'info', '.exclude.gh-security.lock'),
    ensure: (target: string, timing: LockTiming = LOCK_TIMING) =>
      ensureWorktreeExclude(target, sandbox.env, timing),
  }
}

const added = (repo: string, exclude: string) => ({
  outcome: 'ok',
  value: { repo_root: repo, exclude_path: exclude, line: LINE, action: 'added' },
})

const present = (repo: string, exclude: string) => ({
  outcome: 'ok',
  value: { repo_root: repo, exclude_path: exclude, line: LINE, action: 'already-present' },
})

describe('ensureWorktreeExclude: the change', () => {
  it('adds the line to a repository whose exclude file lacks it, and keeps the rules there', async () => {
    const { repo, exclude, ensure } = setup()
    writeFileSync(exclude, '# user rules\nbuild/\n')
    expect(await ensure(repo)).toEqual(added(repo, exclude))
    expect(readFileSync(exclude, 'utf8')).toBe('# user rules\nbuild/\n.claude/worktrees/\n')
  })

  it('creates the exclude file, with mode 644, when the repository has none', async () => {
    const { repo, exclude, ensure } = setup()
    rmSync(exclude, { force: true })
    expect(await ensure(repo)).toEqual(added(repo, exclude))
    expect(readFileSync(exclude, 'utf8')).toBe('.claude/worktrees/\n')
    expect(statSync(exclude).mode & 0o777).toBe(0o644)
  })

  it('creates the info directory when the repository has none', async () => {
    const { repo, info, exclude, ensure } = setup()
    rmSync(info, { recursive: true, force: true })
    expect(await ensure(repo)).toEqual(added(repo, exclude))
    expect(readFileSync(exclude, 'utf8')).toBe('.claude/worktrees/\n')
  })

  it('does not join the line onto a last line that has no newline', async () => {
    const { repo, exclude, ensure } = setup()
    writeFileSync(exclude, 'build/')
    await ensure(repo)
    expect(readFileSync(exclude, 'utf8')).toBe('build/\n.claude/worktrees/\n')
  })

  it('writes the line alone into an empty exclude file', async () => {
    const { repo, exclude, ensure } = setup()
    writeFileSync(exclude, '')
    await ensure(repo)
    expect(readFileSync(exclude, 'utf8')).toBe('.claude/worktrees/\n')
  })

  it('keeps the mode of an exclude file that is there', async () => {
    const { repo, exclude, ensure } = setup()
    writeFileSync(exclude, 'build/\n')
    chmodSync(exclude, 0o600)
    await ensure(repo)
    expect(statSync(exclude).mode & 0o777).toBe(0o600)
  })

  it('reports already-present, and writes nothing, when the line is there', async () => {
    const { repo, exclude, ensure } = setup()
    writeFileSync(exclude, 'build/\n.claude/worktrees/\n')
    const before = statSync(exclude).mtimeMs
    expect(await ensure(repo)).toEqual(present(repo, exclude))
    expect(readFileSync(exclude, 'utf8')).toBe('build/\n.claude/worktrees/\n')
    expect(statSync(exclude).mtimeMs).toBe(before)
  })

  it('matches the whole line, so a longer line does not count', async () => {
    const { repo, exclude, ensure } = setup()
    writeFileSync(exclude, '.claude/worktrees/keep\n')
    expect(await ensure(repo)).toEqual(added(repo, exclude))
    expect(readFileSync(exclude, 'utf8')).toBe('.claude/worktrees/keep\n.claude/worktrees/\n')
  })

  it('is idempotent: the second call reports already-present', async () => {
    const { repo, exclude, ensure } = setup()
    await ensure(repo)
    expect(await ensure(repo)).toEqual(present(repo, exclude))
    expect(
      readFileSync(exclude, 'utf8')
        .split('\n')
        .filter((line) => line === LINE),
    ).toHaveLength(1)
  })

  it('resolves a linked worktree to the shared git directory', async () => {
    const { fixtures, root, repo, exclude, ensure } = setup()
    fixtures.branch(repo, 'fix')
    const worktree = join(root, 'wt')
    fixtures.worktree(repo, worktree, 'fix')
    expect(await ensure(worktree)).toEqual(added(worktree, exclude))
    expect(readFileSync(exclude, 'utf8')).toContain('.claude/worktrees/\n')
  })

  it('resolves a subdirectory of the repository to the same file', async () => {
    const { repo, exclude, ensure } = setup()
    rmSync(exclude, { force: true })
    mkdirSync(join(repo, 'packages'))
    const result = await ensure(join(repo, 'packages'))
    expect(result.outcome === 'ok' && result.value.action).toBe('added')
    expect(readFileSync(exclude, 'utf8')).toBe('.claude/worktrees/\n')
  })

  it('leaves no lock and no temporary file behind', async () => {
    const { repo, info, ensure } = setup()
    await ensure(repo)
    expect(readdirSync(info).filter((name) => name.startsWith('.exclude'))).toEqual([])
  })
})

describe('ensureWorktreeExclude: the lock', () => {
  it('leaves one line when several processes run at once', async () => {
    const { sandbox, repo, exclude } = setup()
    writeFileSync(exclude, 'build/\n')
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(process.execPath, [ENTRY, 'ensure-worktree-exclude', repo], { env: sandbox.env }),
      ),
    )
    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0, 0, 0])
    const actions = results.map(
      (result) => (JSON.parse(result.stdout) as { action: string }).action,
    )
    expect(actions.filter((action) => action === 'added')).toHaveLength(1)
    expect(actions.filter((action) => action === 'already-present')).toHaveLength(5)
    expect(readFileSync(exclude, 'utf8')).toBe('build/\n.claude/worktrees/\n')
  })

  it('waits for a lock that another run holds, then writes the line', async () => {
    const { repo, exclude, lock, ensure } = setup()
    mkdirSync(lock)
    const pending = ensure(repo, { attempts: 200, waitMs: 5 })
    setTimeout(() => rmSync(lock, { recursive: true }), 40)
    expect(await pending).toEqual(added(repo, exclude))
    expect(existsSync(lock)).toBe(false)
  })

  it('reports already-present when the holder wrote the line first', async () => {
    const { repo, exclude, lock, ensure } = setup()
    mkdirSync(lock)
    const pending = ensure(repo, { attempts: 200, waitMs: 5 })
    setTimeout(() => {
      writeFileSync(exclude, '.claude/worktrees/\n')
      rmSync(lock, { recursive: true })
    }, 40)
    expect(await pending).toEqual(present(repo, exclude))
  })

  it('gives up on a lock that stays held, and leaves that lock alone', async () => {
    const { repo, lock, ensure } = setup()
    mkdirSync(lock)
    expect(await ensure(repo, QUICK)).toEqual({
      outcome: 'failed',
      error: `could not acquire ${lock}`,
    })
    expect(existsSync(lock)).toBe(true)
  })

  it('removes a lock that a killed process left, and writes the line', async () => {
    const { repo, exclude, lock, ensure } = setup()
    mkdirSync(lock)
    const twoMinutesAgo = new Date(Date.now() - 120_000)
    utimesSync(lock, twoMinutesAgo, twoMinutesAgo)
    expect(await ensure(repo, QUICK)).toEqual(added(repo, exclude))
    expect(existsSync(lock)).toBe(false)
  })
})

describe('ensureWorktreeExclude: the refusals', () => {
  it('refuses a directory that does not exist', async () => {
    const { root, ensure } = setup()
    expect(await ensure(join(root, 'gone'))).toEqual({
      outcome: 'failed',
      error: `repo_root does not exist: ${join(root, 'gone')}`,
    })
  })

  it('refuses a path that is a file', async () => {
    const { repo, ensure } = setup()
    expect(await ensure(join(repo, 'file.txt'))).toEqual({
      outcome: 'failed',
      error: `repo_root does not exist: ${join(repo, 'file.txt')}`,
    })
  })

  it('refuses a directory that is not a repository', async () => {
    const { root, ensure } = setup()
    mkdirSync(join(root, 'plain'))
    expect(await ensure(join(root, 'plain'))).toEqual({
      outcome: 'failed',
      error: `not a git repository: ${join(root, 'plain')}`,
    })
  })

  it('refuses a repository when git is not on the path', async () => {
    const { sandbox, repo } = setup()
    const empty = sandbox.join('empty-bin')
    mkdirSync(empty)
    expect(await ensureWorktreeExclude(repo, { PATH: empty }, LOCK_TIMING)).toEqual({
      outcome: 'failed',
      error: `not a git repository: ${repo}`,
    })
  })

  it('refuses an exclude path that is a directory, and leaves no temporary file', async () => {
    const { repo, info, exclude, ensure } = setup()
    rmSync(exclude, { force: true })
    mkdirSync(exclude)
    expect(await ensure(repo)).toEqual({ outcome: 'failed', error: `cannot publish ${exclude}` })
    expect(readdirSync(info).filter((name) => name.startsWith('.exclude'))).toEqual([])
  })

  it.skipIf(!notRoot)(
    'refuses an exclude file that cannot be read, and does not overwrite it',
    async () => {
      const { repo, exclude, ensure } = setup()
      writeFileSync(exclude, 'build/\n')
      chmodSync(exclude, 0o000)
      expect(await ensure(repo)).toEqual({ outcome: 'failed', error: `cannot read ${exclude}` })
      chmodSync(exclude, 0o644)
      expect(readFileSync(exclude, 'utf8')).toBe('build/\n')
    },
  )

  it.skipIf(!notRoot)(
    'refuses a git directory that cannot be written, with the JSON contract',
    async () => {
      const { repo, gitDir, info, ensure } = setup()
      rmSync(info, { recursive: true, force: true })
      chmodSync(gitDir, 0o555)
      try {
        expect(await ensure(repo)).toEqual({ outcome: 'failed', error: `cannot create ${info}` })
      } finally {
        chmodSync(gitDir, 0o755)
      }
    },
  )

  it.skipIf(!notRoot)('refuses an info directory that cannot be written', async () => {
    const { repo, info, lock, ensure } = setup()
    chmodSync(info, 0o555)
    try {
      expect(await ensure(repo, QUICK)).toEqual({
        outcome: 'failed',
        error: `could not acquire ${lock}`,
      })
    } finally {
      chmodSync(info, 0o755)
    }
  })
})

describe('the ensure-worktree-exclude command', () => {
  const contextFor = (
    args: readonly string[],
    env: Record<string, string | undefined>,
  ): CommandContext => ({
    args,
    env,
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
    commandNames: [],
  })
  const USAGE = 'usage: gh-security ensure-worktree-exclude <repo_root>'

  it('adds the line to the repository that it is given', async () => {
    const { sandbox, repo, exclude } = setup()
    expect(await ensureWorktreeExcludeCommand(contextFor([repo], sandbox.env))).toEqual(
      added(repo, exclude),
    )
  })

  it.each([
    ['no argument', []],
    ['an empty argument', ['']],
    ['two arguments', ['a', 'b']],
  ])('answers the usage line for %s', async (_name, args) => {
    expect(await ensureWorktreeExcludeCommand(contextFor(args, {}))).toEqual({
      outcome: 'failed',
      error: USAGE,
    })
  })

  it('refuses a flag that it does not know', async () => {
    const result = await ensureWorktreeExcludeCommand(contextFor(['--nope', 'x'], {}))
    expect(result?.outcome).toBe('failed')
    expect(result?.outcome === 'failed' && result.error).toContain('--nope')
  })

  it('prints the report on stdout and exits 0 when the entry point runs it', async () => {
    const { sandbox, repo, exclude } = setup()
    const result = await run(process.execPath, [ENTRY, 'ensure-worktree-exclude', repo], {
      env: sandbox.env,
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      repo_root: repo,
      exclude_path: exclude,
      line: LINE,
      action: 'added',
    })
  })

  it('prints the error on stdout and stderr and exits 1 when the entry point refuses', async () => {
    const { sandbox, root } = setup()
    const result = await run(
      process.execPath,
      [ENTRY, 'ensure-worktree-exclude', join(root, 'gone')],
      {
        env: sandbox.env,
      },
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      error: `repo_root does not exist: ${join(root, 'gone')}`,
    })
    expect(result.stderr.trim()).toBe(`repo_root does not exist: ${join(root, 'gone')}`)
  })
})
