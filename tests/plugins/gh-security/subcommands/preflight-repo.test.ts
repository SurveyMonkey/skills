// `gh-security preflight-repo`. The seam is the exported handler. The
// adapter, the runner and the current directory are its parameters. There is
// no bash script to compare with: this is a contract of #193, built here. I
// wrote each expected value by hand from `resolve-alerts` SKILL.md phase 5
// and the contract comment on #228.
//
// git is real (`harness/git.ts`), so the worktree exclude runs for real. The
// package manager is the boundary (`mocking.md`, "Not the package managers"):
// the runner is a parameter, and the recorder below answers with specimens
// from real runs (`spec/fixtures/registry-probe/`). The adapter is the real
// node adapter, except in the examples that make `detect` fail, which give
// a tree that the real `detect` refuses.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import type { CommandContext } from '#gh-security/cli/command.ts'
import { commandNames } from '#gh-security/cli/registry.ts'
import { type Runner, type RunOptions, type RunResult, run } from '#gh-security/lib/process.ts'
import { allowOwnCommands } from '#gh-security/subcommands/allow-own-commands.ts'
import { preflightRepo, preflightRepoCommand } from '#gh-security/subcommands/preflight-repo.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

const SCOPED = { name: 'app', dependencies: { '@example-org/ui': '^2.1.0', lodash: '^4' } }

/** A real git repository with a pnpm tree in it. */
const world = (manifest: unknown = SCOPED, lockfile = 'pnpm-lock.yaml') => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const scene = join(realpathSync(sandbox.path), 'scene')
  mkdirSync(scene)
  const root = fixtures.createAt(scene, 'app')
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(root, lockfile), "lockfileVersion: '9.0'\n")
  return { sandbox, scene, root, exclude: join(root, '.git', 'info', 'exclude') }
}

type Call = {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunOptions | undefined
}

const result = (over: Partial<RunResult>): RunResult => ({
  status: 0,
  signal: null,
  stdout: '2.1.4\n',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: 1,
  startFailure: null,
  streamErrors: [],
  ...over,
})

/** A runner that records each call and gives the next answer of `answers`, then the last. */
const recorder = (...answers: Partial<RunResult>[]) => {
  const calls: Call[] = []
  const runner: Runner = async (command, args = [], options) => {
    calls.push({ command, args, options })
    return result(answers[Math.min(calls.length, answers.length) - 1] ?? {})
  }
  return { calls, runner }
}

const context = (args: readonly string[], env: CommandContext['env'] = {}): CommandContext => ({
  args,
  env,
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const specimen = (name: string): string =>
  readFileSync(join(FIXTURES_ROOT, 'registry-probe', name), 'utf8')

describe('preflight-repo: a registry that answers', () => {
  it('excludes the worktrees, detects the tree and probes its scoped dependency', async () => {
    const w = world()
    const { calls, runner } = recorder()
    const answer = await preflightRepo(context([w.root], w.sandbox.env), node, runner, w.scene)
    expect(answer).toEqual({
      outcome: 'ok',
      value: {
        ok: true,
        pm: 'pnpm',
        pm_exec: 'pnpm',
        probe_package: '@example-org/ui',
        cause: null,
        stderr: null,
        exclude_error: null,
      },
    })
    expect(readFileSync(w.exclude, 'utf8').split('\n')).toContain('.claude/worktrees/')
    expect(
      calls.map(({ command, args, options }) => ({ command, args, cwd: options?.cwd })),
    ).toEqual([{ command: 'pnpm', args: ['view', '@example-org/ui', 'version'], cwd: w.root }])
  })
})

describe('preflight-repo: the worktree exclude (pin: still writes the worktree exclude once per repo, before any dispatch for it)', () => {
  it('writes the line once, however many times it runs', async () => {
    const w = world()
    for (let i = 0; i < 2; i += 1) {
      const answer = await preflightRepo(
        context([w.root], w.sandbox.env),
        node,
        recorder().runner,
        w.scene,
      )
      expect(answer?.outcome === 'ok' && answer.value).toMatchObject({
        ok: true,
        exclude_error: null,
      })
    }
    expect(
      readFileSync(w.exclude, 'utf8')
        .split('\n')
        .filter((line) => line === '.claude/worktrees/'),
    ).toHaveLength(1)
  })

  it('reports a failed exclude, and still probes the registry', async () => {
    const sandbox = createSandbox()
    const root = join(realpathSync(sandbox.path), 'plain')
    mkdirSync(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify(SCOPED))
    writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    const { calls, runner } = recorder()
    const answer = await preflightRepo(context([root], sandbox.env), node, runner, root)
    expect(answer).toEqual({
      outcome: 'ok',
      value: {
        ok: true,
        pm: 'pnpm',
        pm_exec: 'pnpm',
        probe_package: '@example-org/ui',
        cause: null,
        stderr: null,
        exclude_error: `not a git repository: ${root}`,
      },
    })
    expect(calls).toHaveLength(1)
  })
})

describe('preflight-repo: detect (pin: excludes a repo whose adapter detect fails in phase 5)', () => {
  it.each([
    [
      'no lockfile',
      'package.json',
      (root: string) =>
        `No supported lockfile found in ${root}. Expected pnpm-lock.yaml, yarn.lock, or package-lock.json.`,
    ],
    [
      'a bun lockfile',
      'bun.lockb',
      () =>
        'bun is not a supported package manager. See .github/CONTRIBUTING.md to request support.',
    ],
    [
      'a Yarn Classic lockfile',
      'yarn.lock',
      () =>
        'Yarn Classic (v1) is not supported; only Yarn Berry (v2+). See .github/CONTRIBUTING.md to request support.',
    ],
  ])('answers cause detect for %s, and probes nothing', async (_name, lockfile, error) => {
    const w = world(SCOPED, lockfile)
    const { calls, runner } = recorder()
    const answer = await preflightRepo(context([w.root], w.sandbox.env), node, runner, w.scene)
    expect(answer).toEqual({
      outcome: 'ok',
      value: {
        ok: false,
        pm: null,
        pm_exec: null,
        probe_package: null,
        cause: 'detect',
        stderr: error(w.root),
        exclude_error: null,
      },
    })
    expect(calls).toEqual([])
  })
})

describe('preflight-repo: the retry (pin: still gives the registry preflight one retry before it means anything)', () => {
  const preflight = async (...answers: Partial<RunResult>[]) => {
    const w = world()
    const { calls, runner } = recorder(...answers)
    const answer = await preflightRepo(context([w.root], w.sandbox.env), node, runner, w.scene)
    return { answer: answer?.outcome === 'ok' ? answer.value : answer, calls: calls.length }
  }

  it('probes once when the first attempt answers (pin: runs a registry preflight probe once per repo before phase 6 dispatch)', async () => {
    expect(await preflight({})).toMatchObject({ answer: { ok: true }, calls: 1 })
  })

  it('tries again after a failed attempt, and keeps the repository when the retry answers', async () => {
    expect(
      await preflight({ status: 1, stdout: '', stderr: specimen('npm-econnrefused.txt') }, {}),
    ).toEqual({
      answer: {
        ok: true,
        pm: 'pnpm',
        pm_exec: 'pnpm',
        probe_package: '@example-org/ui',
        cause: null,
        stderr: null,
        exclude_error: null,
      },
      calls: 2,
    })
  })

  it('fails after two attempts, with the output of the second', async () => {
    const answer = await preflight(
      { status: 1, stdout: '', stderr: specimen('npm-econnrefused.txt') },
      { status: 1, stdout: '', stderr: specimen('npm-401.txt') },
    )
    expect(answer).toEqual({
      answer: {
        ok: false,
        pm: 'pnpm',
        pm_exec: 'pnpm',
        probe_package: '@example-org/ui',
        cause: 'auth',
        stderr: specimen('npm-401.txt'),
        exclude_error: null,
      },
      calls: 2,
    })
  })

  it.each([
    ['npm-401.txt', 'stderr', 'auth'],
    ['npm-403.txt', 'stderr', 'auth'],
    ['npm-404.txt', 'stderr', 'not-found'],
    ['npm-econnrefused.txt', 'stderr', 'network'],
    ['yarn-401.txt', 'stdout', 'auth'],
    ['yarn-403.txt', 'stdout', 'auth'],
    ['yarn-404.txt', 'stdout', 'not-found'],
    ['yarn-socket-closed.txt', 'stdout', 'network'],
  ] as const)('gives the cause of %s on %s as %s', async (name, stream, cause) => {
    const failure = { status: 1, stdout: '', [stream]: specimen(name) }
    const { answer } = await preflight(failure, failure)
    expect(answer).toMatchObject({ ok: false, cause, stderr: specimen(name) })
  })

  it('gives the cause network for a probe that the time limit stopped', async () => {
    const stopped = { status: null, signal: 'SIGKILL' as const, timedOut: true, stdout: '' }
    expect((await preflight(stopped, stopped)).answer).toMatchObject({
      ok: false,
      cause: 'network',
      stderr: 'the probe stopped at its limit of 60000 ms\n',
    })
  })

  it('gives the cause start for a package manager that did not start', async () => {
    const lost = {
      status: 127,
      stdout: '',
      startFailure: { code: 'ENOENT', message: 'spawn pnpm ENOENT' },
    }
    expect((await preflight(lost, lost)).answer).toMatchObject({
      ok: false,
      cause: 'start',
      stderr: 'spawn pnpm ENOENT',
    })
  })
})

describe('preflight-repo: the prefix (pin: composes the probe as cd repo_root, then env_prefix, in every snippet)', () => {
  it.each([
    ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n", ['pnpm', 'view', '@example-org/ui', 'version']],
    [
      'package-lock.json',
      '{"lockfileVersion": 3, "packages": {}}\n',
      ['npm', 'view', '@example-org/ui', 'version'],
    ],
    [
      'yarn.lock',
      '__metadata:\n  version: 8\n',
      ['yarn', 'npm', 'info', '@example-org/ui', '--fields', 'version'],
    ],
  ])('runs the probe of %s from the root, under the prefix', async (lockfile, text, probe) => {
    const w = world(SCOPED, 'none')
    writeFileSync(join(w.root, lockfile), text)
    const { calls, runner } = recorder()
    await preflightRepo(
      context(['--env-prefix', 'env-run --profile work', w.root], w.sandbox.env),
      node,
      runner,
      w.scene,
    )
    expect(
      calls.map(({ command, args, options }) => ({ command, args, cwd: options?.cwd })),
    ).toEqual([{ command: 'env-run', args: ['--profile', 'work', ...probe], cwd: w.root }])
  })

  it('runs the retry under the prefix too', async () => {
    const w = world()
    const { calls, runner } = recorder(
      { status: 1, stdout: '', stderr: specimen('npm-401.txt') },
      {},
    )
    await preflightRepo(
      context(['--env-prefix', 'env-run --profile work', w.root], w.sandbox.env),
      node,
      runner,
      w.scene,
    )
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ['env-run', '--profile', 'work', 'pnpm', 'view', '@example-org/ui', 'version'],
      ['env-run', '--profile', 'work', 'pnpm', 'view', '@example-org/ui', 'version'],
    ])
  })

  it('runs the probe bare when there is no prefix', async () => {
    const w = world()
    const { calls, runner } = recorder()
    await preflightRepo(context([w.root], w.sandbox.env), node, runner, w.scene)
    expect(calls.map(({ command }) => command)).toEqual(['pnpm'])
  })

  it('gives the probe the environment of the command', async () => {
    const w = world()
    const { calls, runner } = recorder()
    await preflightRepo(context([w.root], { ...w.sandbox.env, MARK: 'm' }), node, runner, w.scene)
    expect(calls[0]?.options?.env?.MARK).toBe('m')
  })
})

describe('preflight-repo: the probe package', () => {
  it('probes the fallback package when the manifest has no scoped registry dependency', async () => {
    const w = world({ name: 'app', dependencies: { lodash: '^4' } })
    const { calls, runner } = recorder()
    const answer = await preflightRepo(
      context(['--fallback-package', 'lodash', w.root], w.sandbox.env),
      node,
      runner,
      w.scene,
    )
    expect(answer).toMatchObject({ outcome: 'ok', value: { ok: true, probe_package: 'lodash' } })
    expect(calls[0]?.args).toEqual(['view', 'lodash', 'version'])
  })

  it('fails, and probes nothing, when there is no package to probe', async () => {
    const w = world({ name: 'app' })
    const { calls, runner } = recorder()
    expect(await preflightRepo(context([w.root], w.sandbox.env), node, runner, w.scene)).toEqual({
      outcome: 'failed',
      error:
        'preflight-repo: probeRegistry: package.json has no scoped registry dependency, and the caller gave no fallback package',
    })
    expect(calls).toEqual([])
  })
})

describe('preflight-repo: the command line', () => {
  it.each([
    ['no root', []],
    ['two roots', ['a', 'b']],
  ])('refuses %s', async (_name, args) => {
    expect(await preflightRepo(context(args), node, recorder().runner, '/')).toEqual({
      outcome: 'failed',
      error:
        'usage: gh-security preflight-repo [--env-prefix <prefix>] [--fallback-package <pkg>] <root>',
    })
  })

  it('refuses an option that it does not know', async () => {
    const answer = await preflightRepo(
      context(['--adapter', 'x', '/']),
      node,
      recorder().runner,
      '/',
    )
    expect(answer?.outcome).toBe('failed')
  })

  it('refuses a root that is not a directory, before any step', async () => {
    const w = world()
    const { calls, runner } = recorder()
    const file = join(w.root, 'package.json')
    expect(await preflightRepo(context([file], w.sandbox.env), node, runner, w.scene)).toEqual({
      outcome: 'failed',
      error: `preflight-repo: not a directory: ${file}`,
    })
    expect(calls).toEqual([])
  })

  it('resolves a relative root against the current directory', async () => {
    const w = world()
    const { calls, runner } = recorder()
    await preflightRepo(context(['app'], w.sandbox.env), node, runner, w.scene)
    expect(calls[0]?.options?.cwd).toBe(w.root)
  })
})

describe('the allow hook', () => {
  it.each([
    'preflight-repo /work/app',
    'preflight-repo --fallback-package @example-org/ui /work/app',
  ])('approves the phase 5 command %s', (command) => {
    const input = { tool_name: 'Bash', tool_input: { command: `node ${ENTRY} ${command}` } }
    expect(allowOwnCommands(input, ENTRY, commandNames)?.hookSpecificOutput).toMatchObject({
      permissionDecision: 'allow',
    })
  })
})

describe('the registered handler', () => {
  it('refuses a root that is not a directory', async () => {
    expect(await preflightRepoCommand(context(['/nowhere/at/all']))).toEqual({
      outcome: 'failed',
      error: 'preflight-repo: not a directory: /nowhere/at/all',
    })
  })
})

describe('the process', () => {
  it('answers a detect failure on stdout with exit 0, and probes nothing', async () => {
    const w = world(SCOPED, 'bun.lockb')
    const result = await run(process.execPath, [ENTRY, 'preflight-repo', w.root], {
      env: w.sandbox.env,
    })
    expect({ status: result.status, answer: JSON.parse(result.stdout) }).toEqual({
      status: 0,
      answer: {
        ok: false,
        pm: null,
        pm_exec: null,
        probe_package: null,
        cause: 'detect',
        stderr:
          'bun is not a supported package manager. See .github/CONTRIBUTING.md to request support.',
        exclude_error: null,
      },
    })
  })

  it('exits 1 with the error as JSON on stdout and as prose on stderr', async () => {
    const result = await run(process.execPath, [ENTRY, 'preflight-repo'], {
      env: createSandbox().env,
    })
    const usage =
      'usage: gh-security preflight-repo [--env-prefix <prefix>] [--fallback-package <pkg>] <root>'
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: `${JSON.stringify({ error: usage })}\n`,
      stderr: `${usage}\n`,
    })
  })
})
