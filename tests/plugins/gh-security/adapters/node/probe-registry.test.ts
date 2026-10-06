// `probeRegistry` of the node adapter (#228, round 6 ruling 8). The seam is
// `node.probeRegistry`. node.sh has no such verb, so there is no parity run.
// The expected values are written by hand from `resolve-alerts` SKILL.md
// phase 5 and from the contract comment on #228.
//
// No example reaches a registry (`mocking.md`, "Not the package managers").
// The runner is the parameter that the verb takes, so an example gives it
// through that parameter ("The injected collaborator"). The recorder below
// stands in for `lib/process.ts`, with the real `RunResult` shape. What it
// answers on stdout and stderr are specimens from real runs of pnpm 10.34.5,
// npm 11.19.0 and Yarn 4.9.2 (`spec/fixtures/registry-probe/`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Environment, Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { type Runner, type RunOptions, type RunResult, run } from '#gh-security/lib/process.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createSandbox } from '#harness/sandbox.ts'

const LOCKFILES = {
  pnpm: ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
  npm: ['package-lock.json', '{"lockfileVersion": 3, "packages": {}}\n'],
  yarn: ['yarn.lock', '__metadata:\n  version: 8\n'],
} as const

/** A scratch tree with `manifest` as its `package.json` and the lockfile of `pm`. */
const treeOf = (
  pm: keyof typeof LOCKFILES,
  manifest: unknown,
  env: Environment = {},
): Tree<NodeDetection> => {
  const root = createSandbox().join('repo')
  mkdirSync(root)
  const [name, text] = LOCKFILES[pm]
  writeFileSync(join(root, name), text)
  if (manifest !== undefined) {
    writeFileSync(
      join(root, 'package.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    )
  }
  const detection = node.detect(root, env)
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

type Call = {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunOptions | undefined
}

/** A runner that records each call and answers `result`. */
const recorder = (result: Partial<RunResult> = {}) => {
  const calls: Call[] = []
  const runner: Runner = async (command, args = [], options) => {
    calls.push({ command, args, options })
    return {
      status: 0,
      signal: null,
      stdout: '7.0.0\n',
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

const specimen = (name: string): string =>
  readFileSync(join(FIXTURES_ROOT, 'registry-probe', name), 'utf8')

const SCOPED = { name: 'app', dependencies: { '@example-org/ui': '^2.1.0' } }

describe('probeRegistry: the probe command', () => {
  it('views the version of a scoped dependency of the manifest, from the root of the tree', async () => {
    const tree = treeOf('pnpm', SCOPED)
    const { calls, runner } = recorder()
    const answer = await node.probeRegistry(tree, 'lodash', { run: runner, env: { HOME: '/h' } })
    expect(answer).toEqual({
      outcome: 'ok',
      value: {
        package: '@example-org/ui',
        command: 'pnpm view @example-org/ui version',
        ok: true,
        started: true,
        http_status: null,
        output: '7.0.0\n',
      },
    })
    expect(calls).toEqual([
      {
        command: 'pnpm',
        args: ['view', '@example-org/ui', 'version'],
        options: {
          cwd: tree.root,
          env: { HOME: '/h', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
          timeoutMs: 60_000,
        },
      },
    ])
  })
})

describe('probeRegistry: the command of each package manager', () => {
  it.each([
    ['pnpm', 'pnpm', ['view', '@example-org/ui', 'version']],
    ['npm', 'npm', ['view', '@example-org/ui', 'version']],
    ['yarn', 'yarn', ['npm', 'info', '@example-org/ui', '--fields', 'version']],
  ] as const)('runs the %s probe', async (pm, command, args) => {
    const tree = treeOf(pm, SCOPED)
    const { calls, runner } = recorder()
    const answer = await node.probeRegistry(tree, null, { run: runner, env: {} })
    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([{ command, args }])
    expect(answer.outcome === 'ok' && answer.value.command).toBe([command, ...args].join(' '))
  })

  it('splits a pm_exec of two words, as install splits install_cmd', async () => {
    const sandbox = createSandbox()
    const bin = sandbox.join('bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'node'), '')
    const root = sandbox.join('repo')
    mkdirSync(join(root, '.yarn', 'releases'), { recursive: true })
    writeFileSync(join(root, '.yarn', 'releases', 'yarn-4.9.2.cjs'), '')
    writeFileSync(join(root, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.9.2.cjs\n')
    writeFileSync(join(root, 'yarn.lock'), LOCKFILES.yarn[1])
    writeFileSync(join(root, 'package.json'), JSON.stringify(SCOPED))
    const detection = node.detect(root, { PATH: bin })
    if (detection.outcome !== 'ok') throw new Error(detection.error)
    expect(detection.value.pm_exec).toBe('node .yarn/releases/yarn-4.9.2.cjs')
    const { calls, runner } = recorder()
    await node.probeRegistry({ root, detection: detection.value }, null, { run: runner, env: {} })
    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      {
        command: 'node',
        args: [
          '.yarn/releases/yarn-4.9.2.cjs',
          'npm',
          'info',
          '@example-org/ui',
          '--fields',
          'version',
        ],
      },
    ])
  })
})

describe('probeRegistry: the package', () => {
  const probedWith = async (manifest: unknown, fallback: string | null = 'lodash') => {
    const { runner } = recorder()
    const answer = await node.probeRegistry(treeOf('npm', manifest), fallback, {
      run: runner,
      env: {},
    })
    return answer.outcome === 'ok' ? answer.value.package : answer
  }

  it.each([
    ['no dependencies at all', { name: 'app' }],
    ['only unscoped dependencies', { dependencies: { lodash: '^4.17.21', react: '18.2.0' } }],
    ['a scoped workspace dependency', { dependencies: { '@example-org/ui': 'workspace:*' } }],
    ['a scoped file dependency', { dependencies: { '@example-org/ui': 'file:../ui' } }],
    ['a scoped link dependency', { dependencies: { '@example-org/ui': 'link:../ui' } }],
    ['a scoped portal dependency', { dependencies: { '@example-org/ui': 'portal:../ui' } }],
    ['a scoped alias', { dependencies: { '@example-org/ui': 'npm:@other-org/ui@^1' } }],
    ['a scoped catalog dependency', { dependencies: { '@example-org/ui': 'catalog:' } }],
    ['a scoped git dependency', { dependencies: { '@example-org/ui': 'github:octo/ui' } }],
    ['a scoped git shorthand', { dependencies: { '@example-org/ui': 'octo/ui#v1' } }],
    ['a scoped path', { dependencies: { '@example-org/ui': './packages/ui' } }],
    ['a scoped tarball url', { dependencies: { '@example-org/ui': 'https://example.com/ui.tgz' } }],
    ['a scoped dependency whose spec is not text', { dependencies: { '@example-org/ui': 2 } }],
    ['a scoped peer dependency only', { peerDependencies: { '@example-org/ui': '^2' } }],
    ['a name with an @ and no scope', { dependencies: { '@example-org': '^2' } }],
  ])('probes the fallback for a manifest with %s', async (_name, manifest) => {
    expect(await probedWith(manifest)).toBe('lodash')
  })

  it.each([
    ['a range', '^2.1.0'],
    ['an exact version', '2.1.0'],
    ['a tag', 'latest'],
    ['an empty spec', ''],
    ['a range with a space', '>=2.0.0 <3'],
  ])('probes a scoped dependency whose spec is %s', async (_name, spec) => {
    expect(await probedWith({ dependencies: { '@example-org/ui': spec } })).toBe('@example-org/ui')
  })

  it('takes the first scoped registry dependency, in the order of the manifest', async () => {
    const manifest = {
      dependencies: {
        lodash: '^4',
        '@example-org/local': 'workspace:*',
        '@example-org/ui': '^2',
        '@example-org/api': '^1',
      },
    }
    expect(await probedWith(manifest)).toBe('@example-org/ui')
  })

  it('reads dependencies, then devDependencies, then optionalDependencies', async () => {
    const all = {
      optionalDependencies: { '@example-org/optional': '^1' },
      devDependencies: { '@example-org/dev': '^1' },
      dependencies: { '@example-org/prod': '^1' },
    }
    expect(await probedWith(all)).toBe('@example-org/prod')
    expect(await probedWith({ ...all, dependencies: {} })).toBe('@example-org/dev')
    expect(await probedWith({ optionalDependencies: all.optionalDependencies })).toBe(
      '@example-org/optional',
    )
  })

  it('prefers the scoped dependency of the manifest to the fallback', async () => {
    expect(await probedWith(SCOPED, 'lodash')).toBe('@example-org/ui')
  })

  it('fails, and runs nothing, when there is no scoped dependency and no fallback', async () => {
    const { calls, runner } = recorder()
    const answer = await node.probeRegistry(treeOf('npm', { name: 'app' }), null, {
      run: runner,
      env: {},
    })
    expect(answer).toEqual({
      outcome: 'failed',
      error:
        'probeRegistry: package.json has no scoped registry dependency, and the caller gave no fallback package',
    })
    expect(calls).toEqual([])
  })

  it('fails on a manifest that is not there', async () => {
    const tree = treeOf('npm', undefined)
    const answer = await node.probeRegistry(tree, 'lodash', { run: recorder().runner, env: {} })
    expect(answer.outcome).toBe('failed')
    expect(answer.outcome === 'failed' && answer.error).toMatch(
      new RegExp(`^probeRegistry: cannot read ${join(tree.root, 'package.json')}: ENOENT`),
    )
  })

  it('fails on a manifest that is not JSON, and does not fall back', async () => {
    const tree = treeOf('npm', '{"dependencies": ')
    const answer = await node.probeRegistry(tree, 'lodash', { run: recorder().runner, env: {} })
    expect(answer.outcome === 'failed' && answer.error).toMatch(
      new RegExp(`^probeRegistry: cannot read ${join(tree.root, 'package.json')}: `),
    )
  })

  it.each([
    ['a list', '[]'],
    ['no document', ' \n'],
    ['null', 'null'],
  ])('fails on a manifest that is %s', async (_name, text) => {
    const tree = treeOf('npm', text)
    const answer = await node.probeRegistry(tree, 'lodash', { run: recorder().runner, env: {} })
    expect(answer).toEqual({
      outcome: 'failed',
      error: `probeRegistry: ${join(tree.root, 'package.json')} is not a JSON object`,
    })
  })

  it.each([
    ['dependencies', 'a list', []],
    ['devDependencies', 'null', null],
    ['optionalDependencies', 'text', '^1'],
  ])('fails on %s that is %s, and does not read past it', async (field, _name, value) => {
    const tree = treeOf('npm', { [field]: value })
    const answer = await node.probeRegistry(tree, 'lodash', { run: recorder().runner, env: {} })
    expect(answer).toEqual({
      outcome: 'failed',
      error: `probeRegistry: ${field} in ${join(tree.root, 'package.json')} is not an object`,
    })
  })
})

describe('probeRegistry: the answer of one attempt', () => {
  const attempt = async (result: Partial<RunResult>, pm: 'pnpm' | 'yarn' = 'pnpm') => {
    const { runner } = recorder(result)
    const answer = await node.probeRegistry(treeOf(pm, SCOPED), null, { run: runner, env: {} })
    if (answer.outcome !== 'ok') throw new Error(answer.error)
    const { ok, started, http_status, output } = answer.value
    return { ok, started, http_status, output }
  }

  it.each([
    ['npm-401.txt', 'stderr', 401],
    ['npm-403.txt', 'stderr', 403],
    ['npm-404.txt', 'stderr', 404],
    ['npm-econnrefused.txt', 'stderr', null],
    ['yarn-401.txt', 'stdout', 401],
    ['yarn-403.txt', 'stdout', 403],
    ['yarn-404.txt', 'stdout', 404],
    ['yarn-socket-closed.txt', 'stdout', null],
  ] as const)('reads %s on %s as the status %s', async (name, stream, status) => {
    const text = specimen(name)
    const pm = name.startsWith('yarn') ? 'yarn' : 'pnpm'
    expect(await attempt({ status: 1, stdout: '', [stream]: text }, pm)).toEqual({
      ok: false,
      started: true,
      http_status: status,
      output: text,
    })
  })

  it('gives stderr, then stdout, in the output', async () => {
    expect((await attempt({ status: 1, stdout: 'out\n', stderr: 'err\n' })).output).toBe(
      'err\nout\n',
    )
  })

  it('does not read a status from a line number of a stack frame', async () => {
    const text = 'Error: socket hang up\n    at index.js:401:14\n    at net.js:404:3\n'
    expect((await attempt({ status: 1, stdout: '', stderr: text })).http_status).toBeNull()
  })

  it('is not ok on exit 0 with nothing on stdout', async () => {
    expect(await attempt({ status: 0, stdout: ' \n' })).toEqual({
      ok: false,
      started: true,
      http_status: null,
      output: ' \n',
    })
  })

  it('is not ok on exit 0 with a failed pipe, and names the pipe', async () => {
    const answer = await attempt({
      status: 0,
      streamErrors: [{ code: 'EIO', message: 'read EIO' }],
    })
    expect(answer).toEqual({
      ok: false,
      started: true,
      http_status: null,
      output: 'a pipe failed: EIO, read EIO\n7.0.0\n',
    })
  })

  it('is not ok when the time limit stops the probe, and says so', async () => {
    const answer = await attempt({ status: null, signal: 'SIGKILL', timedOut: true, stdout: '' })
    expect(answer).toEqual({
      ok: false,
      started: true,
      http_status: null,
      output: 'the probe stopped at its limit of 60000 ms\n',
    })
  })

  it('reports a probe that did not start, with the words of node', async () => {
    const message = 'spawn pnpm ENOENT'
    expect(
      await attempt({ status: 127, stdout: '', startFailure: { code: 'ENOENT', message } }),
    ).toEqual({ ok: false, started: false, http_status: null, output: message })
  })

  it('reports a package manager that is not on PATH, through the real runner', async () => {
    const tree = treeOf('pnpm', SCOPED)
    const answer = await node.probeRegistry(tree, null, { run, env: { PATH: '' } })
    expect(
      answer.outcome === 'ok' && { ok: answer.value.ok, started: answer.value.started },
    ).toEqual({ ok: false, started: false })
  })
})
