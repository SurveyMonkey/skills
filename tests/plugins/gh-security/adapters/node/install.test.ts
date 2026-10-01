// `install` of the node adapter (#222). The seam is `node.install`. Each
// expected value is written by hand from `verb_install` in node.sh and from
// the fixture that it names. The parity run holds the agreement with
// node.sh.
//
// No example runs an install (`mocking.md`, "Not the package managers").
// The runner is the parameter that `install` takes, so an example gives it
// through that parameter ("The injected collaborator"). The recorder below
// stands in for `lib/process.ts`, with the real `RunResult` shape. It writes
// a file in its cwd, as an install writes `node_modules/`. So a refusal can
// show that nothing was written. Two examples use the real runner. One
// starts a command that is not on PATH, and one starts `node`.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { Environment, Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import type { Runner, RunOptions, RunResult } from '#gh-security/lib/process.ts'
import { run } from '#gh-security/lib/process.ts'
import { type GitShape, useFixture } from '#harness/fixtures.ts'
import { createSandbox } from '#harness/sandbox.ts'

const HINT =
  'Create the fix worktree with git worktree add and run the command as: cd <worktree> && <command>.'

/** A scratch copy of a fixture with the `.git` that `shape` names. */
const copyOf = (name: string, gitShape: GitShape): string => {
  const fixture = useFixture(name, { gitShape })
  onTestFinished(fixture.cleanup)
  return fixture.path
}

const treeAt = (root: string, env: Environment = {}): Tree<NodeDetection> => {
  const detection = node.detect(root, env)
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

type Call = {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunOptions | undefined
}

/** The file that the recorder writes in its cwd, as an install writes `node_modules/`. */
const INSTALLED = '.installed'

/** A runner that records each call, writes {@link INSTALLED} in its cwd, and answers `result`. */
const recorder = (result: Partial<RunResult> = {}) => {
  const calls: Call[] = []
  const runner: Runner = async (command, args = [], options) => {
    calls.push({ command, args, options })
    if (options?.cwd !== undefined) writeFileSync(join(options.cwd, INSTALLED), '')
    return {
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      combined: '',
      timedOut: false,
      elapsedMs: 1,
      startFailure: null,
      streamErrors: [],
      ...result,
    }
  }
  return { calls, runner }
}

describe('the guard, before anything runs', () => {
  it.each([
    [
      'a primary checkout',
      'primary-checkout',
      (root: string) => `this is a primary checkout (${root}/.git is a directory)`,
    ],
    [
      'a directory in no repository',
      'none',
      (root: string) => `no git repository at or above ${root}`,
    ],
  ] as const)('refuses %s, runs nothing, and writes nothing', async (_name, shape, reason) => {
    const root = copyOf('npm-v3', shape)
    const before = readdirSync(root).sort()
    const { calls, runner } = recorder()
    expect(await node.install(treeAt(root), { run: runner, env: {} })).toEqual({
      outcome: 'failed',
      error: `refusing to run 'install' here: ${reason(root)}. ${HINT}`,
    })
    expect({ calls, entries: readdirSync(root).sort() }).toEqual({ calls: [], entries: before })
  })
})

describe('the command', () => {
  it('runs install_cmd in the root, with the environment it is given and no corepack prompt', async () => {
    const root = copyOf('npm-v3', 'linked-worktree')
    const { calls, runner } = recorder({ stdout: 'added 1 package\n', stderr: 'npm warn x\n' })
    const envelope = await node.install(treeAt(root), {
      run: runner,
      env: { PATH: '/bin', HOME: '/h' },
    })
    expect({ envelope, calls }).toEqual({
      envelope: {
        outcome: 'ok',
        value: {
          command: 'npm install',
          ok: true,
          status: 0,
          signal: null,
          stdout: 'added 1 package\n',
          stderr: 'Running: npm install\nnpm warn x\n',
        },
      },
      calls: [
        {
          command: 'npm',
          args: ['install'],
          options: {
            cwd: root,
            env: { PATH: '/bin', HOME: '/h', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
          },
        },
      ],
    })
    expect(existsSync(join(root, INSTALLED))).toBe(true)
  })

  it('splits a runner of more than one word at white space', async () => {
    const root = copyOf('npm-v3', 'linked-worktree')
    const tree = treeAt(root)
    const { calls, runner } = recorder()
    await node.install(
      { root, detection: { ...tree.detection, install_cmd: ' corepack \tnpm  install' } },
      { run: runner, env: {} },
    )
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ['corepack', 'npm', 'install'],
    ])
  })

  it('answers ok false, with the status, when the command fails', async () => {
    const root = copyOf('npm-v3', 'linked-worktree')
    const { runner } = recorder({ status: 1, stderr: 'npm error code ERESOLVE\n' })
    const envelope = await node.install(treeAt(root), { run: runner, env: {} })
    expect(envelope.outcome === 'ok' && envelope.value).toMatchObject({
      ok: false,
      status: 1,
      stderr: 'Running: npm install\nnpm error code ERESOLVE\n',
    })
  })

  it('answers ok false, with a null status and the signal, when a signal stops the command', async () => {
    const root = copyOf('npm-v3', 'linked-worktree')
    const { runner } = recorder({ status: null, signal: 'SIGKILL' })
    const envelope = await node.install(treeAt(root), { run: runner, env: {} })
    expect(envelope.outcome === 'ok' && envelope.value).toMatchObject({
      ok: false,
      status: null,
      signal: 'SIGKILL',
    })
  })
})

describe('the real runner', () => {
  it('answers status 127, and names the command, when the manager is not on PATH', async () => {
    const root = copyOf('npm-v3', 'linked-worktree')
    const empty = createSandbox().join('bin')
    mkdirSync(empty)
    const envelope = await node.install(treeAt(root, { PATH: empty }), {
      run,
      env: { PATH: empty },
    })
    expect(envelope).toEqual({
      outcome: 'ok',
      value: {
        command: 'npm install',
        ok: false,
        status: 127,
        signal: null,
        stdout: '',
        stderr: 'Running: npm install\nspawn npm ENOENT\n',
      },
    })
  })

  it('passes the output and the status of the command through', async () => {
    const root = copyOf('npm-v3', 'linked-worktree')
    const tree = treeAt(root)
    const script = join(root, 'fake-install.mjs')
    writeFileSync(
      script,
      "process.stdout.write('out');process.stderr.write('err '+process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT);process.exit(3)\n",
    )
    const envelope = await node.install(
      { root, detection: { ...tree.detection, install_cmd: 'node fake-install.mjs' } },
      { run, env: { PATH: dirname(process.execPath) } },
    )
    expect(envelope).toEqual({
      outcome: 'ok',
      value: {
        command: 'node fake-install.mjs',
        ok: false,
        status: 3,
        signal: null,
        stdout: 'out',
        stderr: 'Running: node fake-install.mjs\nerr 0',
      },
    })
  })
})
