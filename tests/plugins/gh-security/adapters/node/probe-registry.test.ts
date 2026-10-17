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
import { describe, expect, it, onTestFinished, vi } from 'vitest'

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

describe('probeRegistry: the size of the output', () => {
  const KEEP = 4096
  const attempt = async (result: Partial<RunResult>) => {
    const answer = await node.probeRegistry(treeOf('yarn', SCOPED), null, {
      run: recorder(result).runner,
      env: {},
    })
    if (answer.outcome !== 'ok') throw new Error(answer.error)
    return answer.value
  }

  // A real Yarn 4.9.2 network failure: 60818 bytes on stderr, almost all minified source.
  // Its own error is the short text on stdout, after stderr. The 401 text of
  // another specimen stands in for a status that only the tail carries.
  it('cuts a large output to its first and last 4 KiB, and says how many bytes it cut', async () => {
    const stderr = specimen('yarn-large-stderr.txt')
    const stdout = specimen('yarn-large-stdout.txt')
    const full = Buffer.from(`${stderr}${stdout}`)
    const { output } = await attempt({ status: 1, stderr, stdout })
    const cut = full.length - 2 * KEEP
    // 60818 + 312 bytes, less two ends of 4096.
    expect(cut).toBe(52938)
    expect(output).toContain('\n[the probe output is cut here: 52938 bytes]\n')
    expect(output).toBe(
      `${full.subarray(0, KEEP).toString()}\n[the probe output is cut here: ${cut} bytes]\n${full.subarray(-KEEP).toString()}`,
    )
    expect(output.endsWith(stdout)).toBe(true)
  })

  it('reads the status from the full text, before the cut', async () => {
    const stderr = specimen('yarn-large-stderr.txt')
    const stdout = specimen('yarn-401.txt')
    const { output, http_status } = await attempt({ status: 1, stderr, stdout })
    expect(http_status).toBe(401)
    expect(output.length).toBeLessThan(2 * KEEP + 100)
    expect(output).toContain('YN0041')
  })

  it('reads a status that only the cut part names', async () => {
    const stderr = `${'x'.repeat(2 * KEEP)}\nE404\n${'x'.repeat(2 * KEEP)}\n`
    const { output, http_status } = await attempt({ status: 1, stderr, stdout: '' })
    expect(http_status).toBe(404)
    expect(output).not.toContain('E404')
  })

  // Pinning: green when written. The limit is on bytes, so text of 8192 bytes stays whole.
  it('does not cut an output of exactly 8 KiB', async () => {
    const stderr = `${'e'.repeat(2 * KEEP - 1)}\n`
    expect((await attempt({ status: 1, stderr, stdout: '' })).output).toBe(stderr)
  })

  it('cuts an output of one byte more than 8 KiB', async () => {
    const stderr = `${'e'.repeat(2 * KEEP)}\n`
    expect((await attempt({ status: 1, stderr, stdout: '' })).output).toContain(
      '[the probe output is cut here: 1 bytes]',
    )
  })

  it('counts bytes, not characters, and cuts only the output', async () => {
    const stderr = `${'\u00e9'.repeat(3 * KEEP)}\n`
    const answer = await attempt({ status: 1, stderr, stdout: '' })
    // 12288 characters of 2 bytes, and a newline, less two ends of 4096.
    expect(answer.output).toContain('[the probe output is cut here: 16385 bytes]')
    expect(answer.command).toBe('yarn npm info @example-org/ui --fields version')
  })
})

describe('probeRegistry: a scope that the repository maps comes first', () => {
  const PUBLIC_FIRST = {
    dependencies: { '@types/node': '^22', '@example-org/ui': '^2' },
    devDependencies: { '@example-org/dev': '^1' },
  }
  const NPMRC = '@example-org:registry=https://registry.example.invalid/\n'

  /** The package that a tree with these files probes. */
  const chosen = async (
    manifest: unknown,
    files: Readonly<Record<string, string>>,
    pm: 'npm' | 'yarn' = 'npm',
  ) => {
    const tree = treeOf(pm, manifest)
    for (const [name, text] of Object.entries(files)) writeFileSync(join(tree.root, name), text)
    const answer = await node.probeRegistry(tree, 'lodash', { run: recorder().runner, env: {} })
    return answer.outcome === 'ok' ? answer.value.package : answer
  }

  it('prefers a scope that .npmrc maps to a registry over an earlier public scope', async () => {
    expect(await chosen(PUBLIC_FIRST, { '.npmrc': NPMRC })).toBe('@example-org/ui')
  })

  it('reads an indented .npmrc mapping line', async () => {
    expect(await chosen(PUBLIC_FIRST, { '.npmrc': `  ${NPMRC}` })).toBe('@example-org/ui')
  })

  it.each([
    [
      'a bare key',
      'npmScopes:\n  example-org:\n    npmRegistryServer: "https://r.example.invalid/"\n',
    ],
    [
      'a double-quoted key',
      'npmScopes:\n  "example-org":\n    npmRegistryServer: "https://r.example.invalid/"\n',
    ],
    [
      'a block after other keys',
      'enableTelemetry: false\nnpmScopes:\n  other:\n    npmAlwaysAuth: true\n  example-org:\n    npmAlwaysAuth: true\n',
    ],
    [
      'CRLF line ends and a comment',
      'npmScopes: # the private scopes\r\n  # the registry of the org\r\n# a note\r\n  example-org:\r\n    npmAlwaysAuth: true\r\n',
    ],
    ['a comment after the key', 'npmScopes:\n  example-org: # the org\n    npmAlwaysAuth: true\n'],
    ['a comment after the key and CRLF', 'npmScopes:\r\n  example-org: # the org\r\n'],
    ['a blank line before the key', 'npmScopes:\n\n  example-org:\n'],
    ['a blank CRLF line before the key', 'npmScopes:\r\n\r\n  example-org:\r\n'],
    ['a deeper comment before the key', 'npmScopes:\n    # an aside\n  example-org:\n'],
    ['an indent of four', 'npmScopes:\n    example-org:\n      npmAlwaysAuth: true\n'],
    ['a single-quoted key', "npmScopes:\n  'example-org':\n    npmAlwaysAuth: true\n"],
  ])('prefers a scope that .yarnrc.yml maps in npmScopes, with %s', async (_name, yarnrc) => {
    expect(await chosen(PUBLIC_FIRST, { '.yarnrc.yml': yarnrc }, 'yarn')).toBe('@example-org/ui')
  })

  it('looks across the dependency fields for a mapped scope', async () => {
    const manifest = {
      dependencies: { '@types/node': '^22' },
      devDependencies: { '@example-org/dev': '^1' },
    }
    expect(await chosen(manifest, { '.npmrc': NPMRC })).toBe('@example-org/dev')
  })

  // Pinning: green when written. Each case maps no scope that the manifest uses.
  it.each([
    ['no file', {}],
    [
      'an .npmrc that maps another scope',
      { '.npmrc': '@other:registry=https://r.example.invalid/\n' },
    ],
    ['an .npmrc with a token line only', { '.npmrc': '//r.example.invalid/:_authToken=abc\n' }],
    [
      'an .npmrc with the mapping in a comment',
      {
        '.npmrc':
          '; @example-org:registry=https://r.example.invalid/\n# @example-org:registry=https://r.example.invalid/\n',
      },
    ],
    ['an .npmrc with an empty registry', { '.npmrc': '@example-org:registry=\n' }],
    ['an .npmrc that is a directory', {}],
    [
      'npmScopes with a value on the same line',
      { '.yarnrc.yml': 'npmScopes: oops\n  example-org:\n' },
    ],
    ['npmScopes that holds a list', { '.yarnrc.yml': 'npmScopes:\n  - example-org\n' }],
    [
      'npmScopes with no scope under it',
      { '.yarnrc.yml': 'npmScopes:\nenableTelemetry: false\n  example-org:\n' },
    ],
    [
      'the scope as a key one level down in npmScopes',
      { '.yarnrc.yml': 'npmScopes:\n  other:\n    example-org:\n      npmAlwaysAuth: true\n' },
    ],
    [
      'the scope under a top-level key after npmScopes',
      {
        '.yarnrc.yml':
          'npmScopes:\n  other:\n    npmAlwaysAuth: true\nnpmRegistries:\n  example-org:\n    npmAuthToken: x\n',
      },
    ],
    [
      'the scope key with text after the colon',
      { '.yarnrc.yml': 'npmScopes:\n  example-org:#x\n' },
    ],
    [
      'the scope mapped under another key',
      { '.yarnrc.yml': 'npmRegistries:\n  example-org:\n    npmAuthToken: x\n' },
    ],
  ])('falls back to the first scoped dependency with %s', async (name, files) => {
    const tree = treeOf('yarn', PUBLIC_FIRST)
    if (name === 'an .npmrc that is a directory') mkdirSync(join(tree.root, '.npmrc'))
    for (const [file, text] of Object.entries(files)) writeFileSync(join(tree.root, file), text)
    const answer = await node.probeRegistry(tree, 'lodash', { run: recorder().runner, env: {} })
    expect(answer.outcome === 'ok' && answer.value.package).toBe('@types/node')
  })

  it('does not take a mapped scope whose dependency is not in the registry', async () => {
    const manifest = {
      dependencies: { '@types/node': '^22', '@example-org/local': 'workspace:*' },
    }
    expect(await chosen(manifest, { '.npmrc': NPMRC })).toBe('@types/node')
  })

  it('does not fail on a field after the first, when no scope is mapped', async () => {
    const manifest = { dependencies: { '@types/node': '^22' }, devDependencies: [] }
    expect(await chosen(manifest, {})).toBe('@types/node')
  })

  it('finds a mapped scope in a field after one that is not an object', async () => {
    const manifest = {
      dependencies: { '@types/node': '^22' },
      devDependencies: [],
      optionalDependencies: { '@example-org/opt': '^1' },
    }
    expect(await chosen(manifest, { '.npmrc': NPMRC })).toBe('@example-org/opt')
  })

  it('does not fail on a field after the first, when a scope it does not use is mapped', async () => {
    const manifest = { dependencies: { '@types/node': '^22' }, devDependencies: [] }
    expect(await chosen(manifest, { '.npmrc': NPMRC })).toBe('@types/node')
  })

  it('does not read the .npmrc of the user', async () => {
    const home = createSandbox().join('home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.npmrc'), NPMRC)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const tree = treeOf('npm', PUBLIC_FIRST)
    const answer = await node.probeRegistry(tree, 'lodash', {
      run: recorder().runner,
      env: { HOME: home },
    })
    expect(answer.outcome === 'ok' && answer.value.package).toBe('@types/node')
  })
})
