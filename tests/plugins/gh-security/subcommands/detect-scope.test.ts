// `gh-security detect-scope`. The seam is the exported handler, with the `gh`
// client factory, the process runner and the working directory as
// parameters. `git` is never mocked (`mocking.md`): the examples with a real
// answer run real git on repositories built by `harness/git.ts`, with a
// literal `origin` URL. `gh` is the one mock boundary. A recording runner
// stands in only where the example is about the argv that reaches a child,
// which is the `--env-prefix` wrap. The expected values are written by hand
// from the contract in the header of the command, and the repository name is
// fictitious. The bash script is compared in `parity-detect-scope.test.ts`.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { createGhClient } from '#gh-security/lib/gh.ts'
import { type Runner, type RunResult, run } from '#gh-security/lib/process.ts'
import {
  type ClientFactory,
  detectScope,
  detectScopeCommand,
  parseRemote,
} from '#gh-security/subcommands/detect-scope.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

describe('the nwo of a remote', () => {
  // One row for each branch of the parse. The triple is `[owner, repo, host]`.
  it.each([
    [
      'https://github.com/example-org/example-repo.git',
      ['example-org', 'example-repo', 'github.com'],
    ],
    ['https://github.com/example-org/example-repo', ['example-org', 'example-repo', 'github.com']],
    ['git@github.com:octo/app.git', ['octo', 'app', 'github.com']],
    ['ssh://git@github.com/octo/app.git', ['octo', 'app', 'github.com']],
    ['ssh://git@github.com:2222/octo/app.git', ['octo', 'app', 'github.com']],
    ['https://user:pass@github.com/octo/app.git', ['octo', 'app', 'github.com']],
    ['gh-alias:octo/app.git', ['octo', 'app', 'gh-alias']],
    ['https://github.com/Owner/My.Repo.git', ['Owner', 'My.Repo', 'github.com']],
    ['https://github.com/octo/app/', ['octo', 'app', 'github.com']],
    ['https://github.com/octo/app.git/', ['octo', 'app', 'github.com']],
    ['https://github.com/octo/app/.git', ['octo', 'app', 'github.com']],
    ['https://github.example.com/octo/app', ['octo', 'app', 'github.example.com']],
    ['github.com:octo/app', ['octo', 'app', 'github.com']],
    // The colon in the path is not a host separator once the host has a slash,
    // but a colon after a plain host is.
    ['host:a:b/c', ['a:b', 'c', 'host']],
    // The last `@` ends the credentials.
    ['https://a@b@github.com/octo/app', ['octo', 'app', 'github.com']],
  ])('reads %s as %j', (remote, pair) => {
    expect(parseRemote(remote)).toEqual({ owner: pair[0], repo: pair[1], host: pair[2] })
  })

  it.each([
    // No host.
    ['a path', '/example/src/other-repo'],
    ['a file URL', 'file:///example/src/other-repo'],
    ['a relative path', '../sibling'],
    ['a path with a colon in a directory name', '/tmp/we:ird/a/b'],
    ['a path whose directory name is host and owner', '/tmp/we:ird/app'],
    ['credentials that end in an at sign', 'a@b@:octo/app'],
    ['a port and no host', 'ssh://:2222/octo/app'],
    ['a scheme with no path', 'https://github.com'],
    ['a scheme with an empty path', 'https://github.com/'],
    ['an empty remote', ''],
    ['one slash', '/'],
    // The wrong number of segments.
    ['three segments', 'https://gitlab.example.com/a/b/c.git'],
    ['one segment', 'git@github.com:owner'],
    ['no segment', 'git@github.com:'],
    // A part that is empty.
    ['an empty repository', 'https://github.com/octo/'],
    ['an empty owner', 'https://github.com//app'],
    ['an empty host', 'https:///octo/app'],
    ['an empty host in the scp form', ':octo/app'],
    ['a host that is only credentials', 'user@:octo/app'],
  ])('reads %s as no nwo: %j', (_name, remote) => {
    expect(parseRemote(remote)).toBeNull()
  })
})

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

/** A repository with `origin` set to a literal URL, and the `origin/HEAD` symref set. */
const repoWith = (w: World, remote?: string, symref = 'main'): string => {
  const dir = join(w.root, 'plain-directory-name')
  mkdirSync(dir)
  w.fixtures.git(dir, 'init', '-q')
  if (remote !== undefined) {
    w.fixtures.git(dir, 'remote', 'add', 'origin', remote)
    w.fixtures.git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${symref}`)
  }
  return dir
}

const context = (w: World, args: readonly string[]): CommandContext => ({
  args,
  env: w.sandbox.env,
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const factoryOf =
  (replies: GhReplies): ClientFactory =>
  () =>
    createGhMock(replies)

/** The answer of the command on the real git, with `gh` answering from `replies`. */
const detect = (
  w: World,
  args: readonly string[],
  replies: GhReplies = {},
  cwd = '/nowhere',
): Promise<CommandResult> => detectScope(context(w, args), factoryOf(replies), run, cwd)

const value = (result: CommandResult): Record<string, unknown> => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value as Record<string, unknown>
}

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

describe('the answer for a repository with a GitHub remote', () => {
  it('has every field: the remote, the nwo and the branch that GitHub names', async () => {
    const w = world()
    const dir = repoWith(w, 'git@github.com:octo/app.git')
    expect(value(await detect(w, [dir], { viewDefaultBranch: { name: 'main' } }))).toEqual({
      scope: 'repo',
      owner: 'octo',
      repo: 'app',
      nwo: 'octo/app',
      path: dir,
      git_remote: 'git@github.com:octo/app.git',
      default_branch: 'main',
    })
  })

  // The case of #167. The checkout was cloned when the branch was `main`.
  // GitHub now names `develop`, and `git fetch` never refreshed the symref.
  it('answers the branch that GitHub names, and not a stale origin/HEAD symref', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git', 'main')
    const answer = value(await detect(w, [dir], { viewDefaultBranch: { name: 'develop' } }))
    expect(answer.default_branch).toBe('develop')
  })

  it('asks GitHub about the nwo that the remote gave', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/Owner/My.Repo.git')
    const asked: string[] = []
    const factory: ClientFactory = () => ({
      ...createGhMock(),
      viewDefaultBranch: async (repo) => {
        asked.push(repo.repository)
        return { name: 'main' }
      },
    })
    await detectScope(context(w, [dir]), factory, run, '/nowhere')
    expect(asked).toEqual(['Owner/My.Repo'])
  })

  it.each([
    'https://github.com/octo/app.git',
    'git@github.com:octo/app.git',
    'ssh://git@github.com/octo/app.git',
    'ssh://git@github.com:2222/octo/app.git',
    'https://user:pass@github.com/octo/app.git',
    'github.com:octo/app',
    'https://GitHub.com/octo/app',
  ])('asks GitHub for the remote %s', async (remote) => {
    const w = world()
    const dir = repoWith(w, remote)
    const asked: string[] = []
    const factory: ClientFactory = () => ({
      ...createGhMock(),
      viewDefaultBranch: async (repo) => {
        asked.push(repo.repository)
        return { name: 'develop' }
      },
    })
    const answer = value(await detectScope(context(w, [dir]), factory, run, '/nowhere'))
    expect(asked).toEqual(['octo/app'])
    expect(answer).toMatchObject({ nwo: 'octo/app', default_branch: 'develop' })
  })

  // No reply is registered for `gh`, so a call to it throws: a pass proves
  // that the command asked GitHub nothing, and read the symref (ruling 11).
  it.each([
    'https://gitlab.example.com/octo/app.git',
    'git@gitlab.example.com:octo/app.git',
    'ssh://git@gitlab.example.com:2222/octo/app.git',
    'https://github.example.com/octo/app',
    'https://notgithub.com/octo/app',
    'https://github.com.example.org/octo/app',
    'gh-alias:octo/app',
  ])('reads the symref, and asks GitHub nothing, for the remote %s', async (remote) => {
    const w = world()
    const dir = repoWith(w, remote, 'trunk')
    expect(value(await detect(w, [dir]))).toMatchObject({
      scope: 'repo',
      nwo: 'octo/app',
      git_remote: remote,
      default_branch: 'trunk',
    })
  })

  it('answers a null default branch for a repository that GitHub says has none', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    const answer = value(await detect(w, [dir], { viewDefaultBranch: { name: null } }))
    expect(answer.default_branch).toBeNull()
  })

  it('reads GitHub when the checkout records no origin/HEAD at all', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    w.fixtures.git(dir, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD')
    const answer = value(await detect(w, [dir], { viewDefaultBranch: { name: 'develop' } }))
    expect(answer.default_branch).toBe('develop')
  })

  // The remedy of #167 names a failed read as an error. A fall back to the
  // symref would hide the stale branch again, in the one case that matters.
  it('fails when the read from GitHub fails, and never falls back to the symref', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git', 'main')
    const result = await detect(w, [dir], { viewDefaultBranch: ghFails('gh: HTTP 502', 1) })
    expect(result).toEqual({
      outcome: 'failed',
      error: 'could not read the default branch of octo/app from GitHub: gh: HTTP 502',
    })
  })

  it('rethrows what is not a failure of gh, as a defect', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    await expect(
      detect(w, [dir], { viewDefaultBranch: new Error('a defect, not a gh failure') }),
    ).rejects.toThrow('a defect, not a gh failure')
  })
})

describe('the answer for a remote that gives no nwo', () => {
  // No reply is registered for `gh`, so a call to it throws: a pass proves
  // that none was made.
  it('reads the origin/HEAD symref and asks GitHub nothing', async () => {
    const w = world()
    const dir = repoWith(w, '/example/src/other-repo', 'trunk')
    expect(value(await detect(w, [dir]))).toEqual({
      scope: 'repo',
      owner: null,
      repo: null,
      nwo: null,
      path: dir,
      git_remote: '/example/src/other-repo',
      default_branch: 'trunk',
    })
  })

  it('keeps a symref that has no origin prefix as it is', async () => {
    const w = world()
    const dir = repoWith(w, '../sibling')
    w.fixtures.git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/odd')
    expect(value(await detect(w, [dir])).default_branch).toBe('refs/heads/odd')
  })

  it('falls back to remote show when origin/HEAD was never recorded', async () => {
    const w = world()
    const work = w.fixtures.createAt(w.root, 'checkout')
    w.fixtures.forgetOriginHead(work)
    expect(value(await detect(w, [work])).default_branch).toBe('main')
  })

  it('answers null when the fallback cannot answer either', async () => {
    const w = world()
    const work = w.fixtures.createAt(w.root, 'checkout')
    w.fixtures.forgetOriginHead(work)
    w.fixtures.git(work, 'remote', 'set-url', 'origin', join(w.root, 'absent.git'))
    expect(value(await detect(w, [work])).default_branch).toBeNull()
  })

  it('answers null, and not the text (unknown), for a remote with no HEAD', async () => {
    const w = world()
    const work = w.fixtures.createAt(w.root, 'checkout')
    w.fixtures.forgetOriginHead(work)
    const origin = w.fixtures.git(work, 'remote', 'get-url', 'origin')
    w.fixtures.git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/no-such-branch')
    expect(value(await detect(w, [work])).default_branch).toBeNull()
  })

  it('answers null for a repository with no remote, and runs no remote show', async () => {
    const w = world()
    const calls: string[][] = []
    const runner: Runner = async (command, args = [], options) => {
      calls.push([...args])
      return run(command, args, options)
    }
    const dir = repoWith(w)
    const answer = await detectScope(context(w, [dir]), factoryOf({}), runner, '/nowhere')
    expect(calls.some((args) => args.includes('show'))).toBe(false)
    expect(value(answer)).toEqual({
      scope: 'repo',
      owner: null,
      repo: null,
      nwo: null,
      path: join(w.root, 'plain-directory-name'),
      git_remote: null,
      default_branch: null,
    })
  })

  it('never writes: the symref stays absent after the remote show fallback', async () => {
    const w = world()
    const work = w.fixtures.createAt(w.root, 'checkout')
    w.fixtures.forgetOriginHead(work)
    const before = readFileSync(join(work, '.git', 'config'), 'utf8')
    await detect(w, [work])
    expect(
      w.fixtures.tryGit(work, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').status,
    ).toBe(1)
    expect(readFileSync(join(work, '.git', 'config'), 'utf8')).toBe(before)
  })

  it('reads the English words of git, whatever language the caller has', async () => {
    const w = world()
    const dir = repoWith(w, '../sibling')
    w.fixtures.git(dir, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD')
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const runner: Runner = async (command, args = [], options) => {
      if (args.includes('show')) seen.push(options?.env)
      return run(command, args, options)
    }
    await detectScope(context(w, [dir]), factoryOf({}), runner, '/nowhere')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ ...w.sandbox.env, LC_ALL: 'C' })
  })
})

describe('the scope', () => {
  it('answers repo scope from inside a subdirectory of the checkout', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    mkdirSync(join(dir, 'src', 'components'), { recursive: true })
    const answer = value(
      await detect(w, [join(dir, 'src', 'components')], { viewDefaultBranch: { name: 'main' } }),
    )
    expect(answer).toMatchObject({ scope: 'repo', nwo: 'octo/app' })
  })

  it('answers repo scope from inside a linked worktree', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    w.fixtures.git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    w.fixtures.git(dir, 'worktree', 'add', '-q', join(w.root, 'linked'), '-b', 'topic')
    const answer = value(
      await detect(w, [join(w.root, 'linked')], { viewDefaultBranch: { name: 'main' } }),
    )
    expect(answer).toMatchObject({ scope: 'repo', nwo: 'octo/app' })
  })

  it.each([
    ['a directory in no repository', 'plain'],
    ['a path that does not exist', 'missing'],
  ])('answers a null scope for %s, echoing the path, and asks nothing', async (_name, name) => {
    const w = world()
    mkdirSync(join(w.root, 'plain'))
    const target = join(w.root, name)
    expect(value(await detect(w, [target]))).toEqual({
      scope: null,
      owner: null,
      repo: null,
      nwo: null,
      path: target,
      git_remote: null,
      default_branch: null,
    })
  })

  it('answers a null scope for a bare repository, which has no work tree', async () => {
    const w = world()
    const bare = join(w.root, 'origin.git')
    w.fixtures.git(w.root, 'init', '-q', '--bare', bare)
    expect(value(await detect(w, [bare])).scope).toBeNull()
  })

  it('resolves a relative path against the working directory it is given', async () => {
    const w = world()
    repoWith(w, 'https://github.com/octo/app.git')
    const answer = value(
      await detect(w, ['plain-directory-name'], { viewDefaultBranch: { name: 'main' } }, w.root),
    )
    expect(answer).toMatchObject({ nwo: 'octo/app', path: `${w.root}/plain-directory-name` })
  })

  it.each([
    ['no argument', []],
    ['an empty argument', ['']],
  ])('defaults to the working directory for %s', async (_name, args) => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    const answer = value(await detect(w, args, { viewDefaultBranch: { name: 'main' } }, dir))
    expect(answer).toMatchObject({ nwo: 'octo/app', path: dir })
  })

  it('reads an argument after -- as a path', async () => {
    const w = world()
    const answer = value(await detect(w, ['--', '-odd'], {}, w.root))
    expect(answer).toMatchObject({ scope: null, path: `${w.root}/-odd` })
  })

  it('refuses an option it does not know', async () => {
    const w = world()
    expect(await detect(w, ['--nope'])).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('--nope'),
    })
  })
})

describe('--env-prefix', () => {
  interface Call {
    readonly command: string
    readonly args: readonly string[]
    readonly env: NodeJS.ProcessEnv | undefined
  }

  /**
   * A runner that records each call and answers as a GitHub checkout would:
   * it is in a repository, and its remote has no symref and is on GitHub.
   */
  const recording = () => {
    const calls: Call[] = []
    const runner: Runner = async (command, args = [], options) => {
      calls.push({ command, args, env: options?.env })
      const words = args.join(' ')
      if (words.includes('remote get-url')) {
        return reply({ stdout: 'https://github.com/octo/app.git\n' })
      }
      if (words.includes('repo view')) {
        return reply({ stdout: '{"defaultBranchRef":{"name":"main"}}' })
      }
      return reply()
    }
    return { runner, calls }
  }

  const real: ClientFactory = createGhClient

  it('runs gh and every git call bare when no prefix is given', async () => {
    const w = world()
    const { runner, calls } = recording()
    await detectScope(context(w, ['/work']), real, runner, '/nowhere')
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ['git', '-C'],
      ['git', '-C'],
      ['gh', 'repo'],
    ])
  })

  it('puts the prefix before gh, with the repository named and nothing else added', async () => {
    const w = world()
    const { runner, calls } = recording()
    await detectScope(context(w, ['--env-prefix', 'env', '/work']), real, runner, '/nowhere')
    const gh = calls.find((call) => call.args.includes('repo'))
    expect(gh?.command).toBe('env')
    expect(gh?.args).toEqual(['gh', 'repo', 'view', 'octo/app', '--json', 'defaultBranchRef'])
  })

  it('puts the prefix before every git call, after splitting a prefix of several words', async () => {
    const w = world()
    const { runner, calls } = recording()
    await detectScope(
      context(w, ['--env-prefix', 'wrapper exec /work', '/work']),
      real,
      runner,
      '/nowhere',
    )
    const gits = calls.filter((call) => call.args.includes('git'))
    expect(gits.map((call) => call.command)).toEqual(['wrapper', 'wrapper'])
    expect(gits.map((call) => call.args)).toEqual([
      ['exec', '/work', 'git', '-C', '/work', 'rev-parse', '--show-toplevel'],
      ['exec', '/work', 'git', '-C', '/work', 'remote', 'get-url', 'origin'],
    ])
    expect(calls.at(-1)?.command).toBe('wrapper')
  })

  it('runs the remote show fallback under the prefix', async () => {
    const w = world()
    const calls: Call[] = []
    const runner: Runner = async (command, args = [], options) => {
      calls.push({ command, args, env: options?.env })
      return args.includes('remote') && args.includes('get-url')
        ? reply({ stdout: '/example/other\n' })
        : reply({ status: args.includes('symbolic-ref') ? 1 : 0 })
    }
    await detectScope(context(w, ['--env-prefix', 'env', '/work']), real, runner, '/nowhere')
    const show = calls.find((call) => call.args.includes('show'))
    expect(show?.command).toBe('env')
    expect(show?.args).toEqual(['git', '-C', '/work', 'remote', 'show', 'origin'])
  })

  it('reads a prefix of the word null as no prefix', async () => {
    const w = world()
    const { runner, calls } = recording()
    await detectScope(context(w, ['--env-prefix', 'null', '/work']), real, runner, '/nowhere')
    expect(calls.every((call) => call.command === 'git' || call.command === 'gh')).toBe(true)
  })

  it('gives gh the environment of the command, and git the same', async () => {
    const w = world()
    const { runner, calls } = recording()
    const run_ = context(w, ['/work'])
    await detectScope(run_, real, runner, '/nowhere')
    for (const call of calls) expect(call.env).toBe(run_.env)
  })
})

describe('the registered handler', () => {
  it('runs with the real client, the real runner and the working directory of the process', async () => {
    const w = world()
    mkdirSync(join(w.root, 'plain'))
    const target = join(w.root, 'plain')
    expect(value(await detectScopeCommand(context(w, [target])))).toMatchObject({
      scope: null,
      path: target,
    })
  })
})

describe('the process', () => {
  it('answers on stdout, resolving a relative path against its working directory', async () => {
    const w = world()
    mkdirSync(join(w.root, 'plain'))
    const result = await run(process.execPath, [ENTRY, 'detect-scope', 'plain'], {
      cwd: w.root,
      env: w.sandbox.env,
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      scope: null,
      owner: null,
      repo: null,
      nwo: null,
      path: `${w.root}/plain`,
      git_remote: null,
      default_branch: null,
    })
  })

  it('exits 1 with the error as JSON when gh cannot read the repository', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    writeFileSync(join(w.root, 'marker'), '')
    // A PATH with no `gh` on it: the client cannot start gh at all.
    w.sandbox.env.PATH = w.sandbox.pathWithout('gh')
    const result = await run(process.execPath, [ENTRY, 'detect-scope', dir], {
      env: w.sandbox.env,
    })
    expect(result.status).toBe(1)
    const said =
      'could not read the default branch of octo/app from GitHub: cannot run gh: spawn gh ENOENT'
    expect(JSON.parse(result.stdout)).toEqual({ error: said })
    expect(result.stderr).toBe(`${said}\n`)
  })
})
