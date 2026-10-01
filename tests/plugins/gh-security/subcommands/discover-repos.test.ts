// `gh-security discover-repos`. The seam is the exported handler, with the
// git runner, the device lookup and the directory listing as parameters. Most
// examples run real git on real directories built by `harness/git.ts`
// (`mocking.md`: git is never mocked). A stand-in runner appears only for a
// git failure that real git cannot be made to give on demand: dubious
// ownership, a git that prints nothing, a git that is missing. The expected
// values are written by hand from the contract in the header of the command.
// The bash script is compared in `parity-discover-repos.test.ts`.
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { type Runner, type RunResult, run } from '#gh-security/lib/process.ts'
import {
  type DiscoverDeps,
  discoverRepos,
  discoverReposCommand,
  nodeDeps,
} from '#gh-security/subcommands/discover-repos.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

const notRoot = process.getuid?.() !== 0

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly root: string
}

const world = (): World => {
  const sandbox = createSandbox()
  const root = join(realpathSync(sandbox.path), 'w')
  mkdirSync(root)
  return { sandbox, fixtures: createGitFixtures(sandbox), root }
}

const initRepo = (w: World, directory: string, ...extra: string[]): void => {
  mkdirSync(directory, { recursive: true })
  w.fixtures.git(directory, 'init', '-q', ...extra)
}

const context = (w: World, args: readonly string[], env: Record<string, string> = {}) => {
  const value: CommandContext = {
    args,
    env: { ...w.sandbox.env, ...env },
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
    commandNames: [],
  }
  return value
}

/** The real seams, with the working directory far from every fixture. */
const discover = (
  w: World,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; deps?: Partial<DiscoverDeps> } = {},
): Promise<CommandResult> =>
  discoverRepos(
    context(w, args, options.env),
    { ...nodeDeps, ...options.deps },
    options.cwd ?? '/nowhere',
  )

const value = (result: CommandResult): unknown => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value
}

const failure = (result: CommandResult): string => {
  if (result === undefined || result.outcome !== 'failed') {
    throw new Error(`expected a failure: ${JSON.stringify(result)}`)
  }
  return result.error
}

/** A `RunResult` for a stand-in runner. */
const reply = (fields: Partial<RunResult> = {}): RunResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
  ...fields,
})

/**
 * A runner that answers `git --version` with success, and every other call
 * with `others`. The calls are recorded.
 */
const standIn = (others: (args: readonly string[]) => RunResult) => {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] =
    []
  const runner: Runner = async (command, args = [], options) => {
    calls.push({ command, args, env: options?.env })
    return args[0] === '--version' ? reply() : others(args)
  }
  return { runner, calls }
}

/** The scratch workspace: every shape that is listed, and every shape that is not. */
const workspace = (w: World) => {
  const work = join(w.root, 'workspace')
  for (const name of ['app/src', 'lib', 'scratch', 'nested/deep', 'Zeta', 'alpha', 'my app']) {
    mkdirSync(join(work, name), { recursive: true })
  }
  mkdirSync(join(work, 'bare'))
  mkdirSync(join(work, '.hidden'))
  mkdirSync(join(w.root, 'outside'))
  mkdirSync(join(w.root, 'elsewhere', 'sub'), { recursive: true })
  for (const name of ['app', 'lib', '.hidden', 'nested/deep', 'Zeta', 'alpha', 'my app']) {
    initRepo(w, join(work, name))
  }
  initRepo(w, join(w.root, 'outside'))
  initRepo(w, join(w.root, 'elsewhere'))
  initRepo(w, join(work, 'bare'), '--bare')
  symlinkSync('app', join(work, 'app-link'))
  symlinkSync('../elsewhere/sub', join(work, 'into-elsewhere'))
  symlinkSync('../outside', join(work, 'outside-link'))
  writeFileSync(join(work, 'notes.txt'), '')
  return work
}

describe('a target inside a checkout', () => {
  it.each([
    ['the root itself', 'app', ''],
    ['a subdirectory', 'app', 'src'],
    ['a path with a space', 'my app', ''],
  ])('answers that checkout root from %s', async (_name, repo, below) => {
    const w = world()
    const work = workspace(w)
    const target = below === '' ? join(work, repo) : join(work, repo, below)
    expect(value(await discover(w, [target]))).toEqual({ target, repos: [join(work, repo)] })
  })

  it('answers the root of a linked worktree, which is a checkout in its own right', async () => {
    const w = world()
    const primary = join(w.root, 'primary')
    initRepo(w, primary)
    w.fixtures.git(primary, 'commit', '-q', '--allow-empty', '-m', 'init')
    const linked = join(w.root, 'holder', 'wt')
    w.fixtures.git(primary, 'worktree', 'add', '-q', '-b', 'wktr-spec', linked)
    expect(value(await discover(w, [linked]))).toEqual({ target: linked, repos: [linked] })
  })
})

describe('a target that holds checkouts', () => {
  it('lists every immediate checkout root, sorted by the path emitted, and nothing else', async () => {
    const w = world()
    const work = workspace(w)
    // `Zeta` sorts before `alpha` in the byte order. The link out of the
    // workspace is listed where it resolves, which is first.
    expect(value(await discover(w, [work]))).toEqual({
      target: work,
      repos: [
        join(w.root, 'outside'),
        join(work, 'Zeta'),
        join(work, 'alpha'),
        join(work, 'app'),
        join(work, 'lib'),
        join(work, 'my app'),
      ],
    })
  })

  // Each shape that must never reach the list is named, so a leak says which.
  it.each([
    ['bare repository', 'workspace/bare'],
    ['dot-directory', 'workspace/.hidden'],
    ['checkout two levels down', 'workspace/nested/deep'],
    ['plain directory', 'workspace/scratch'],
    ['regular file', 'workspace/notes.txt'],
    ['checkout that a link into a subdirectory would drag in', 'elsewhere'],
    ['link that names a checkout already listed', 'workspace/app-link'],
    ['link into a subdirectory', 'workspace/into-elsewhere'],
  ])('never lists the %s', async (_name, path) => {
    const w = world()
    const work = workspace(w)
    const { repos } = value(await discover(w, [work])) as { repos: string[] }
    expect(repos).not.toContain(join(w.root, path))
  })

  it('resolves a symlinked target', async () => {
    const w = world()
    const work = workspace(w)
    symlinkSync(work, join(w.root, 'link'))
    const answer = value(await discover(w, [join(w.root, 'link')])) as { target: string }
    expect(answer.target).toBe(work)
  })

  it('resolves a relative path against the working directory it is given', async () => {
    const w = world()
    const work = workspace(w)
    expect(value(await discover(w, ['app'], { cwd: work }))).toEqual({
      target: join(work, 'app'),
      repos: [join(work, 'app')],
    })
  })

  it.each([
    ['no argument', []],
    ['an empty argument', ['']],
  ])('defaults to the working directory for %s', async (_name, args) => {
    const w = world()
    const work = workspace(w)
    const answer = value(await discover(w, args, { cwd: work })) as { target: string }
    expect(answer.target).toBe(work)
  })

  it('reads an argument after -- as a path, even one that starts with a dash', async () => {
    const w = world()
    initRepo(w, join(w.root, 'workspace', '-dash'))
    const answer = value(await discover(w, ['--', '-dash'], { cwd: join(w.root, 'workspace') }))
    expect(answer).toEqual({
      target: join(w.root, 'workspace', '-dash'),
      repos: [join(w.root, 'workspace', '-dash')],
    })
  })

  it('answers an empty list for a directory with no repositories', async () => {
    const w = world()
    mkdirSync(join(w.root, 'empty'))
    expect(value(await discover(w, [join(w.root, 'empty')]))).toEqual({
      target: join(w.root, 'empty'),
      repos: [],
    })
  })

  it('ignores an ambient GIT_DIR, which would answer one repository for any path', async () => {
    const w = world()
    const work = workspace(w)
    const answer = value(
      await discover(w, [work], { env: { GIT_DIR: join(work, 'app', '.git') } }),
    ) as { repos: string[] }
    expect(answer.repos).toHaveLength(6)
  })

  it('ignores an ambient GIT_CEILING_DIRECTORIES, which would hide the enclosing checkout', async () => {
    const w = world()
    const work = workspace(w)
    const target = join(work, 'app', 'src')
    expect(
      value(await discover(w, [target], { env: { GIT_CEILING_DIRECTORIES: join(work, 'app') } })),
    ).toEqual({ target, repos: [join(work, 'app')] })
  })

  it('strips each variable that lets the environment answer, and pins the collation', async () => {
    const w = world()
    const { runner, calls } = standIn(() =>
      reply({ status: 128, stderr: 'fatal: not a git repository\n' }),
    )
    mkdirSync(join(w.root, 'plain'))
    await discover(w, [join(w.root, 'plain')], {
      deps: { git: runner },
      env: {
        GIT_DIR: '/x',
        GIT_WORK_TREE: '/x',
        GIT_COMMON_DIR: '/x',
        GIT_CEILING_DIRECTORIES: '/x',
        GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
        LC_ALL: 'en_US.UTF-8',
        GIT_CONFIG_GLOBAL: '/kept',
      },
    })
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.env).toMatchObject({ LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/kept' })
      for (const name of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_CEILING_DIRECTORIES',
        'GIT_DISCOVERY_ACROSS_FILESYSTEM',
      ]) {
        expect(call.env).not.toHaveProperty(name)
      }
    }
  })

  it('skips a bare child under safe.bareRepository=explicit, and lists the checkout beside it', async () => {
    const w = world()
    const work = join(w.root, 'holder')
    initRepo(w, join(work, 'app'))
    initRepo(w, join(work, 'bare'), '--bare')
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.bareRepository',
      GIT_CONFIG_VALUE_0: 'explicit',
    }
    expect(value(await discover(w, [work], { env }))).toEqual({
      target: work,
      repos: [join(work, 'app')],
    })
  })

  it('lists a linked worktree held as an immediate child', async () => {
    const w = world()
    const primary = join(w.root, 'primary')
    initRepo(w, primary)
    w.fixtures.git(primary, 'commit', '-q', '--allow-empty', '-m', 'init')
    const work = join(w.root, 'holder')
    mkdirSync(work)
    w.fixtures.git(primary, 'worktree', 'add', '-q', '-b', 'wktr-spec', join(work, 'wt'))
    expect(value(await discover(w, [work]))).toEqual({
      target: work,
      repos: [join(work, 'wt')],
    })
  })

  it('answers the on-disk spelling for a target typed in another case', async () => {
    const w = world()
    initRepo(w, join(w.root, 'Holder', 'RepoOne'))
    writeFileSync(join(w.root, 'CaseProbe'), '')
    // A case-sensitive filesystem has two directories here, and the target is
    // not on it. Only a case-insensitive one is asked.
    let insensitive = true
    try {
      realpathSync(join(w.root, 'caseprobe'))
    } catch {
      insensitive = false
    }
    if (!insensitive) return
    expect(value(await discover(w, [join(w.root, 'holder')]))).toEqual({
      target: join(w.root, 'Holder'),
      repos: [join(w.root, 'Holder', 'RepoOne')],
    })
  })

  it('keeps a resolved root whole, though its path holds a newline', async () => {
    const w = world()
    const odd = join(w.root, 'a\nb')
    initRepo(w, odd)
    const work = join(w.root, 'holder')
    mkdirSync(work)
    symlinkSync(odd, join(work, 'ok'))
    expect(value(await discover(w, [work]))).toEqual({ target: work, repos: [odd] })
  })

  it('lists a link to a checkout and the checkout itself once', async () => {
    const w = world()
    const work = join(w.root, 'holder')
    initRepo(w, join(work, 'app'))
    symlinkSync('app', join(work, 'link-first'))
    symlinkSync('app', join(work, 'zz-link'))
    expect(value(await discover(w, [work]))).toEqual({ target: work, repos: [join(work, 'app')] })
  })
})

describe('an error is a failure, never an empty list', () => {
  it.each([
    ['a missing path', 'no-such-path-here'],
    ['a regular file', 'regular-file'],
    ['a name with a quote', 'we"ird-name'],
  ])('refuses %s, naming the path as given', async (_name, name) => {
    const w = world()
    writeFileSync(join(w.root, 'regular-file'), '')
    const given = join(w.root, name)
    expect(failure(await discover(w, [given]))).toBe(`not a directory: ${given}`)
  })

  it('names a relative path as given', async () => {
    const w = world()
    expect(failure(await discover(w, ['missing'], { cwd: w.root }))).toBe(
      'not a directory: missing',
    )
  })

  it('refuses an option it does not know', async () => {
    const w = world()
    expect(failure(await discover(w, ['--nope']))).toMatch(/--nope/)
  })

  it.skipIf(!notRoot)('refuses a target it cannot read', async () => {
    const w = world()
    const locked = join(w.root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(failure(await discover(w, [locked]))).toBe(
        `could not read ${locked}: permission denied`,
      )
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it.skipIf(!notRoot).each([0o444, 0o111])(
    'refuses a target with mode %o as one it cannot read',
    async (mode) => {
      const w = world()
      const locked = join(w.root, 'half')
      mkdirSync(locked)
      chmodSync(locked, mode)
      try {
        expect(failure(await discover(w, [locked]))).toBe(
          `could not read ${locked}: permission denied`,
        )
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )

  it('lists a child as git spells it, though the system resolves it to another spelling', async () => {
    const w = world()
    const target = join(w.root, 'holder')
    mkdirSync(join(target, 'kid'), { recursive: true })
    const spelled = join(w.root, 'spelled')
    symlinkSync(join(target, 'kid'), spelled)
    const { runner } = standIn((args) =>
      args.includes('--show-toplevel') && args[1] === join(target, 'kid')
        ? reply({ stdout: `${spelled}\n` })
        : reply({ status: 128, stderr: 'fatal: not a git repository\n' }),
    )
    expect(value(await discover(w, [target], { deps: { git: runner } }))).toEqual({
      target,
      repos: [spelled],
    })
  })

  it.skipIf(!notRoot)('refuses a child it cannot enter, with the cause', async () => {
    const w = world()
    const work = join(w.root, 'workspace')
    initRepo(w, join(work, 'app'))
    mkdirSync(join(work, 'locked'))
    chmodSync(join(work, 'locked'), 0o000)
    try {
      expect(failure(await discover(w, [work]))).toBe(
        `could not enter ${join(work, 'locked')}: ` +
          `EACCES: permission denied, access '${join(work, 'locked')}'`,
      )
    } finally {
      chmodSync(join(work, 'locked'), 0o755)
    }
  })

  it('refuses a target whose directory cannot be listed', async () => {
    const w = world()
    mkdirSync(join(w.root, 'plain'))
    const list = () => {
      throw new Error('EIO: i/o error')
    }
    expect(failure(await discover(w, [join(w.root, 'plain')], { deps: { list } }))).toBe(
      `could not list ${join(w.root, 'plain')}: EIO: i/o error`,
    )
  })

  it.each([
    ['embedded', 'a\nb'],
    ['trailing', 'repo\n'],
  ])('refuses a %s newline in a child name, and lists nothing', async (_name, name) => {
    const w = world()
    const work = join(w.root, 'workspace')
    initRepo(w, join(work, name))
    expect(failure(await discover(w, [work]))).toBe(
      `could not list ${work}/${name}: ` +
        'a path containing a newline cannot be listed one per line',
    )
  })

  it('refuses a child name that holds the mark for a byte that is not UTF-8', async () => {
    const w = world()
    const work = join(w.root, 'workspace')
    initRepo(w, join(work, 'bad\uFFFDname'))
    expect(failure(await discover(w, [work]))).toBe(
      `could not list ${work}/bad\uFFFDname: the name is not valid UTF-8`,
    )
  })

  it('reports the first error in the byte order of the names', async () => {
    const w = world()
    const work = join(w.root, 'workspace')
    initRepo(w, join(work, 'b\nb'))
    initRepo(w, join(work, 'a\na'))
    // The listing comes in the reverse of the byte order.
    const list = () => ['b\nb', 'a\na']
    expect(failure(await discover(w, [work], { deps: { list } }))).toContain(`${work}/a\na`)
  })

  describe('a checkout whose git state is broken', () => {
    const holder = (w: World) => {
      const work = join(w.root, 'workspace')
      initRepo(w, join(work, 'ok'))
      initRepo(w, join(work, 'broken'))
      return work
    }

    it('refuses a child checkout that has no HEAD, naming that checkout and git exit status', async () => {
      const w = world()
      const work = holder(w)
      rmSync(join(work, 'broken', '.git', 'HEAD'))
      const message = failure(await discover(w, [work]))
      expect(message).toMatch(
        new RegExp(`^git failed in ${work}/broken \\(exit 128\\): fatal: not a git repository`),
      )
    })

    it('refuses a child whose .git is a dangling symlink', async () => {
      const w = world()
      const work = holder(w)
      mkdirSync(join(work, 'dangling'))
      symlinkSync('/no-such-git-dir', join(work, 'dangling', '.git'))
      expect(failure(await discover(w, [work]))).toMatch(
        new RegExp(`^git failed in ${work}/dangling \\(exit 128\\)`),
      )
    })

    it('refuses a target below a broken checkout, naming the checkout', async () => {
      const w = world()
      const work = holder(w)
      mkdirSync(join(work, 'broken', 'src'))
      rmSync(join(work, 'broken', '.git', 'HEAD'))
      expect(failure(await discover(w, [join(work, 'broken', 'src')]))).toMatch(
        new RegExp(`^git failed in ${work}/broken \\(exit 128\\)`),
      )
    })

    it.skipIf(!notRoot)('refuses a checkout whose .git cannot be traversed', async () => {
      const w = world()
      const work = holder(w)
      chmodSync(join(work, 'broken', '.git'), 0o000)
      try {
        expect(failure(await discover(w, [work]))).toMatch(
          new RegExp(`^git failed in ${work}/broken \\(exit 128\\)`),
        )
      } finally {
        chmodSync(join(work, 'broken', '.git'), 0o755)
      }
    })

    it('refuses a git directory handed in as the target', async () => {
      const w = world()
      const work = holder(w)
      expect(failure(await discover(w, [join(work, 'ok', '.git')]))).toMatch(
        new RegExp(`^git failed in ${work}/ok/\\.git \\(exit 128\\)`),
      )
    })

    it('refuses a worktree whose primary checkout was removed', async () => {
      const w = world()
      const primary = join(w.root, 'primary')
      initRepo(w, primary)
      w.fixtures.git(primary, 'commit', '-q', '--allow-empty', '-m', 'init')
      const work = join(w.root, 'holder')
      mkdirSync(work)
      w.fixtures.git(primary, 'worktree', 'add', '-q', '-b', 'wktr-spec', join(work, 'wt'))
      rmSync(join(primary, '.git'), { recursive: true, force: true })
      expect(failure(await discover(w, [work]))).toMatch(
        new RegExp(`^git failed in ${work}/wt \\(exit 128\\)`),
      )
    })
  })
})

describe('git itself failing', () => {
  const plain = (w: World) => {
    mkdirSync(join(w.root, 'plain', 'kid'), { recursive: true })
    return join(w.root, 'plain')
  }

  it('refuses to run when git cannot start, before it looks at the path', async () => {
    const w = world()
    const runner: Runner = async () =>
      reply({ status: 127, startFailure: { code: 'ENOENT', message: 'spawn git ENOENT' } })
    expect(failure(await discover(w, ['/no/such/path'], { deps: { git: runner } }))).toBe(
      'git is required but was not found on PATH',
    )
  })

  it('refuses to run without git on PATH', async () => {
    const w = world()
    const bin = w.sandbox.pathWithout('git')
    expect(failure(await discover(w, [plain(w)], { env: { PATH: bin } }))).toBe(
      'git is required but was not found on PATH',
    )
  })

  it('refuses a dubious-ownership failure instead of reporting no repositories', async () => {
    const w = world()
    const target = plain(w)
    const { runner } = standIn(() =>
      reply({
        status: 128,
        stderr: `fatal: detected dubious ownership in repository at ${target}\n`,
      }),
    )
    expect(failure(await discover(w, [target], { deps: { git: runner } }))).toBe(
      `git failed in ${target} (exit 128): fatal: detected dubious ownership in repository at ${target}`,
    )
  })

  it('names the exit status when git fails with nothing on stderr', async () => {
    const w = world()
    const target = plain(w)
    const { runner } = standIn(() => reply({ status: 128 }))
    expect(failure(await discover(w, [target], { deps: { git: runner } }))).toBe(
      `git failed in ${target} (exit 128): `,
    )
  })

  it('names the signal when a signal ended git', async () => {
    const w = world()
    const target = plain(w)
    const { runner } = standIn(() => reply({ status: null, signal: 'SIGSEGV' }))
    expect(failure(await discover(w, [target], { deps: { git: runner } }))).toBe(
      `git failed in ${target} (exit SIGSEGV): `,
    )
  })

  it('names why git never started, when it fails after the first call', async () => {
    const w = world()
    const target = plain(w)
    const { runner } = standIn(() =>
      reply({ status: 126, startFailure: { code: 'EACCES', message: 'spawn git EACCES' } }),
    )
    expect(failure(await discover(w, [target], { deps: { git: runner } }))).toBe(
      `git failed in ${target} (exit 126): spawn git EACCES`,
    )
  })

  it.each([['not a git repository'], ['Not a git repository']])(
    'reads "%s" as the ordinary answer for a plain directory',
    async (words) => {
      const w = world()
      const target = plain(w)
      const { runner } = standIn(() =>
        reply({
          status: 128,
          stderr: `fatal: ${words} (or any of the parent directories): .git\n`,
        }),
      )
      expect(value(await discover(w, [target], { deps: { git: runner } }))).toEqual({
        target,
        repos: [],
      })
    },
  )

  it('reads a refusal of a bare repository under safe.bareRepository=explicit as a skip', async () => {
    const w = world()
    const target = plain(w)
    const { runner } = standIn(() =>
      reply({
        status: 128,
        stderr: "fatal: cannot use bare repository (safe.bareRepository is 'explicit')\n",
      }),
    )
    expect(value(await discover(w, [target], { deps: { git: runner } }))).toEqual({
      target,
      repos: [],
    })
  })

  it('skips a bare repository, which git refuses for want of a work tree', async () => {
    const w = world()
    const bare = join(w.root, 'plain', 'bare')
    initRepo(w, bare, '--bare')
    expect(value(await discover(w, [join(w.root, 'plain')]))).toEqual({
      target: join(w.root, 'plain'),
      repos: [],
    })
  })

  it('treats a git that cannot answer whether a path is bare as not bare, and refuses it', async () => {
    const w = world()
    const target = plain(w)
    const { runner } = standIn((args) =>
      args.includes('--is-bare-repository')
        ? reply({ status: 128, stderr: 'fatal: no\n' })
        : reply({ status: 128, stderr: 'fatal: this operation must be run in a work tree\n' }),
    )
    expect(failure(await discover(w, [target], { deps: { git: runner } }))).toBe(
      `git failed in ${target} (exit 128): fatal: this operation must be run in a work tree`,
    )
  })

  it('does not hide a failure of a kind it does not know, even from a child', async () => {
    const w = world()
    const target = plain(w)
    const { runner } = standIn((args) =>
      args[1] === target
        ? reply({ status: 128, stderr: 'fatal: not a git repository\n' })
        : reply({ status: 1, stderr: 'boom\n' }),
    )
    expect(failure(await discover(w, [target], { deps: { git: runner } }))).toBe(
      `git failed in ${target}/kid (exit 1): boom`,
    )
  })

  it('rethrows what it does not know, as a defect', async () => {
    const w = world()
    const runner: Runner = async (_command, args = []) => {
      if (args[0] === '--version') return reply()
      throw new Error('a defect, not a refusal')
    }
    await expect(discover(w, [plain(w)], { deps: { git: runner } })).rejects.toThrow(
      'a defect, not a refusal',
    )
  })

  it('skips a child whose git root is not the child itself', async () => {
    const w = world()
    const work = join(w.root, 'workspace')
    mkdirSync(join(work, 'sub'), { recursive: true })
    const { runner } = standIn((args) =>
      args[1] === work
        ? reply({ status: 128, stderr: 'fatal: not a git repository\n' })
        : reply({ stdout: `${w.root}\n` }),
    )
    expect(value(await discover(w, [work], { deps: { git: runner } }))).toEqual({
      target: work,
      repos: [],
    })
  })

  it('skips a child whose git root cannot be read', async () => {
    const w = world()
    const work = join(w.root, 'workspace')
    mkdirSync(join(work, 'sub'), { recursive: true })
    const { runner } = standIn((args) =>
      args[1] === work
        ? reply({ status: 128, stderr: 'fatal: not a git repository\n' })
        : reply({ stdout: `${w.root}/gone\n` }),
    )
    expect(value(await discover(w, [work], { deps: { git: runner } }))).toEqual({
      target: work,
      repos: [],
    })
  })
})

describe('the walk for a .git stops at a filesystem boundary', () => {
  // A mount cannot be made in a test. So the device lookup is a parameter,
  // and git is a stand-in that answers as real git does across a mount: it
  // finds no repository, though a healthy one sits on the far side.
  const notARepository = () => reply({ status: 128, stderr: 'fatal: not a git repository\n' })

  const mounted = (w: World) => {
    const home = join(w.root, 'home')
    initRepo(w, home)
    const mount = join(home, 'mnt')
    mkdirSync(join(mount, 'plain'), { recursive: true })
    mkdirSync(join(mount, 'bad', 'ok'), { recursive: true })
    mkdirSync(join(mount, 'bad', 'broken', 'src'), { recursive: true })
    initRepo(w, join(mount, 'bad', 'broken'))
    rmSync(join(mount, 'bad', 'broken', '.git', 'HEAD'))
    // Everything under the mount is on device 2. The rest is on device 1.
    const deviceOf = (path: string): number => (path.startsWith(mount) ? 2 : 1)
    return { mount, deviceOf }
  }

  it('does not blame a healthy checkout on the far side of the mount', async () => {
    const w = world()
    const { mount, deviceOf } = mounted(w)
    const { runner } = standIn(notARepository)
    expect(
      value(await discover(w, [join(mount, 'plain')], { deps: { git: runner, deviceOf } })),
    ).toEqual({ target: join(mount, 'plain'), repos: [] })
  })

  it('still catches a broken checkout on the near side of the mount', async () => {
    const w = world()
    const { mount, deviceOf } = mounted(w)
    const { runner } = standIn(notARepository)
    expect(
      failure(await discover(w, [join(mount, 'bad')], { deps: { git: runner, deviceOf } })),
    ).toBe(`git failed in ${join(mount, 'bad', 'broken')} (exit 128): fatal: not a git repository`)
  })

  it('still catches a target below a broken checkout on the mounted volume', async () => {
    const w = world()
    const { mount, deviceOf } = mounted(w)
    const { runner } = standIn(notARepository)
    expect(
      failure(
        await discover(w, [join(mount, 'bad', 'broken', 'src')], {
          deps: { git: runner, deviceOf },
        }),
      ),
    ).toContain(`git failed in ${join(mount, 'bad', 'broken')}`)
  })

  it('goes on climbing when a device cannot be named, so a broken checkout is not skipped', async () => {
    const w = world()
    const { mount } = mounted(w)
    const { runner } = standIn(notARepository)
    const unknown = () => null
    expect(
      failure(
        await discover(w, [join(mount, 'plain')], { deps: { git: runner, deviceOf: unknown } }),
      ),
    ).toContain(`git failed in ${join(w.root, 'home')} (exit 128)`)
  })

  it('goes on climbing when only the device of the start is unknown', async () => {
    const w = world()
    const home = join(w.root, 'home')
    initRepo(w, home)
    mkdirSync(join(home, 'plain'))
    const { runner } = standIn(notARepository)
    const deviceOf = (path: string): number | null => (path === join(home, 'plain') ? null : 1)
    expect(
      failure(await discover(w, [join(home, 'plain')], { deps: { git: runner, deviceOf } })),
    ).toContain(`git failed in ${home} (exit 128)`)
  })

  it('goes on climbing when only the device of a parent is unknown', async () => {
    const w = world()
    const home = join(w.root, 'home')
    initRepo(w, home)
    mkdirSync(join(home, 'plain'))
    const { runner } = standIn(notARepository)
    const deviceOf = (path: string): number | null =>
      path === home ? null : path === join(home, 'plain') ? 2 : 1
    expect(
      failure(await discover(w, [join(home, 'plain')], { deps: { git: runner, deviceOf } })),
    ).toContain(`git failed in ${home} (exit 128)`)
  })

  it('answers no repository when the walk reaches the top without finding a .git', async () => {
    const w = world()
    mkdirSync(join(w.root, 'plain'))
    const { runner } = standIn(notARepository)
    const sameDevice = () => 1
    expect(
      value(
        await discover(w, [join(w.root, 'plain')], { deps: { git: runner, deviceOf: sameDevice } }),
      ),
    ).toEqual({ target: join(w.root, 'plain'), repos: [] })
  })
})

describe('the real seams', () => {
  it('names the device of a path, and null for a path that is not there', () => {
    const w = world()
    expect(typeof nodeDeps.deviceOf(w.root)).toBe('number')
    expect(nodeDeps.deviceOf(join(w.root, 'missing'))).toBeNull()
  })

  it('lists the names in a directory', () => {
    const w = world()
    mkdirSync(join(w.root, 'a'))
    writeFileSync(join(w.root, 'b'), '')
    expect(nodeDeps.list(w.root).sort()).toEqual(['a', 'b'])
  })

  it('runs git through the process runner', () => {
    expect(nodeDeps.git).toBe(run)
  })
})

describe('the registered handler', () => {
  it('runs with the real seams and the working directory of the process', async () => {
    const w = world()
    const target = join(w.root, 'plain')
    mkdirSync(target)
    expect(value(await discoverReposCommand(context(w, [target])))).toEqual({
      target,
      repos: [],
    })
  })
})

describe('the process', () => {
  const spawnCli = (w: World, args: readonly string[], cwd: string) =>
    run(process.execPath, [ENTRY, 'discover-repos', ...args], { cwd, env: w.sandbox.env })

  it('answers the list on stdout, resolving a relative path against its working directory', async () => {
    const w = world()
    const work = workspace(w)
    const result = await spawnCli(w, ['app'], work)
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      target: join(work, 'app'),
      repos: [join(work, 'app')],
    })
  })

  it('defaults to its working directory', async () => {
    const w = world()
    const work = workspace(w)
    const result = await spawnCli(w, [], join(work, 'app', 'src'))
    expect(JSON.parse(result.stdout)).toEqual({
      target: join(work, 'app', 'src'),
      repos: [join(work, 'app')],
    })
  })

  it('exits 1 with the error as JSON for a path that is not a directory', async () => {
    const w = world()
    const result = await spawnCli(w, ['missing'], w.root)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: 'not a directory: missing' })
    expect(result.stderr).toBe('not a directory: missing\n')
  })
})
