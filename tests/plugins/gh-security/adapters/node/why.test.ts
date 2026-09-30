// `why` of the node adapter (#221). The seam is the `node` adapter. Each
// expected value is written by hand from the fixture that it names, and was
// checked against `node.sh why` on a scratch copy. The parity run holds the
// agreement on every fixture.
//
// `raw` is the output of the package manager. Examples give it through the
// documented parameter (#221, round 3 ruling 2). Each `raw` text is a real
// recorded run on a scratch copy of the fixture in its name, under
// spec/fixtures/why-raw/: `npm explain` (npm 11), `yarn why` (Yarn 4) and
// `pnpm why` (pnpm 10.33). The pnpm specimen is trimmed of one corepack line
// that names a download.
//
// Where `raw` is absent, the verb starts `why_cmd` through the runner that
// it is given. Those examples start real processes against a fixture copy,
// with the real runner of `lib/process.ts`, and mock nothing.
import { copyFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { run } from '#gh-security/lib/process.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'
import { createSandbox } from '#harness/sandbox.ts'

/** One empty PATH entry, the tree root, which holds no tool. */
const NO_PATH = { PATH: '' }

const treeAt = (root: string, env: { PATH?: string } = NO_PATH): Tree<NodeDetection> => {
  const detection = node.detect(root, env)
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

const tree = (name: string): Tree<NodeDetection> => treeAt(join(FIXTURES_ROOT, name))

/** A scratch copy of a fixture, removed when the example ends. */
const copyOf = (name: string): string => {
  const fixture = useFixture(name)
  onTestFinished(fixture.cleanup)
  return fixture.path
}

/** A recorded `raw` text, as the package manager wrote it. */
const specimen = (name: string): string =>
  readFileSync(join(FIXTURES_ROOT, 'why-raw', `${name}.txt`), 'utf8')

const NO_PEERS = { peer_only: false, peer_parents: [], optional_peer_parents: [] }

describe('why, with the raw text given', () => {
  it('answers a direct dependency of npm, with no trailing newline in raw', async () => {
    const raw = specimen('npm-v3-express')
    expect(raw.endsWith('\n')).toBe(true)
    expect(await node.why(tree('npm-v3'), 'express', { raw })).toEqual({
      outcome: 'ok',
      value: {
        pm: 'npm',
        package: 'express',
        relationship: 'direct',
        dev_only: false,
        parents: [],
        parent_count: 0,
        ...NO_PEERS,
        raw: 'express@4.18.2\nnode_modules/express\n  express@"^4.18.2" from the root project',
      },
    })
  })

  it('answers a yarn package that the root and a parent both declare', async () => {
    const raw = specimen('yarn-berry-lodash')
    expect(await node.why(tree('yarn-berry'), 'lodash', { raw })).toEqual({
      outcome: 'ok',
      value: {
        pm: 'yarn',
        package: 'lodash',
        relationship: 'direct',
        dev_only: false,
        parents: ['express'],
        parent_count: 1,
        ...NO_PEERS,
        raw: raw.trimEnd(),
      },
    })
  })

  it('names a parent once when two of its copies declare the package', async () => {
    const raw = specimen('yarn-cross-line-brace-expansion')
    const answer = await node.why(tree('yarn-cross-line'), 'brace-expansion', { raw })
    expect(
      answer.outcome === 'ok' && {
        relationship: answer.value.relationship,
        parents: answer.value.parents,
        count: answer.value.parent_count,
      },
    ).toEqual({ relationship: 'transitive', parents: ['minimatch'], count: 1 })
  })

  // #103: pnpm resolves vite only as a peer, so no override can move it.
  it('answers peer_only for a pnpm package that only peer suffixes reach', async () => {
    const raw = specimen('pnpm-peer-only-vite')
    expect(await node.why(tree('pnpm-peer-only'), 'vite', { raw })).toEqual({
      outcome: 'ok',
      value: {
        pm: 'pnpm',
        package: 'vite',
        relationship: 'transitive',
        dev_only: false,
        parents: ['@vitejs/plugin-react', '@vitest/mocker'],
        parent_count: 2,
        peer_only: true,
        peer_parents: ['@vitejs/plugin-react', '@vitest/mocker'],
        optional_peer_parents: ['@vitest/mocker'],
        raw: raw.replace(/\n+$/, ''),
      },
    })
  })

  // One row for each conjunct of `peer_only` that fails, and what it keeps.
  it.each([
    [
      'the root declares it',
      'pnpm-peer-direct',
      'vite',
      {
        relationship: 'direct',
        peer_only: false,
        peer_parents: ['@vitejs/plugin-react', '@vitest/mocker'],
        optional_peer_parents: ['@vitest/mocker'],
      },
    ],
    [
      'a workspace importer declares it',
      'pnpm-workspace-peer',
      'vite',
      {
        relationship: 'transitive',
        peer_only: false,
        peer_parents: ['@vitejs/plugin-react'],
        optional_peer_parents: [],
      },
    ],
    [
      'one edge has no peer suffix',
      'pnpm-peer-near-miss',
      'vite',
      {
        relationship: 'transitive',
        peer_only: false,
        peer_parents: ['@vitejs/plugin-react'],
        optional_peer_parents: [],
      },
    ],
    [
      'an optional edge has no peer suffix',
      'pnpm-peer-only',
      'sharp',
      { relationship: 'transitive', peer_only: false, peer_parents: [], optional_peer_parents: [] },
    ],
    [
      'no edge and no suffix reaches it',
      'pnpm-peer-only',
      'not-here',
      { relationship: 'transitive', peer_only: false, peer_parents: [], optional_peer_parents: [] },
    ],
    [
      'only a peer suffix names it, and a plain edge reaches it',
      'pnpm-peer-only',
      '@babel/core',
      {
        relationship: 'transitive',
        peer_only: false,
        peer_parents: ['next'],
        optional_peer_parents: [],
      },
    ],
  ])('answers no peer_only when %s', async (_conjunct, fixture, pkg, facts) => {
    const answer = await node.why(tree(fixture), pkg, { raw: '' })
    expect(
      answer.outcome === 'ok' && {
        relationship: answer.value.relationship,
        peer_only: answer.value.peer_only,
        peer_parents: answer.value.peer_parents,
        optional_peer_parents: answer.value.optional_peer_parents,
      },
    ).toEqual(facts)
  })

  it('answers no peer facts from a lockfile that is not lockfileVersion 9', async () => {
    const root = copyOf('pnpm-peer-only')
    const path = join(root, 'pnpm-lock.yaml')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"),
    )
    const answer = await node.why(treeAt(root), 'vite', { raw: '' })
    expect(
      answer.outcome === 'ok' && {
        parents: answer.value.parents,
        peer_only: answer.value.peer_only,
        peer_parents: answer.value.peer_parents,
      },
    ).toEqual({
      parents: ['@vitejs/plugin-react', '@vitest/mocker'],
      peer_only: false,
      peer_parents: [],
    })
  })

  // The snapshot of `@vitest/mocker` below reaches vite as an optional peer.
  // Each row changes the copy of pnpm-peer-only, as node.sh saw it.
  const MOCKER =
    "  '@vitest/mocker@3.0.5(vite@6.4.3)':\n    dependencies:\n      '@vitest/spy': 3.0.5"
  const PLUGIN = "  '@vitejs/plugin-react@4.3.4(vite@6.4.3)':"

  const peersAfter = async (change: (text: string) => string) => {
    const root = copyOf('pnpm-peer-only')
    const path = join(root, 'pnpm-lock.yaml')
    writeFileSync(path, change(readFileSync(path, 'utf8')))
    const answer = await node.why(treeAt(root), 'vite', { raw: '' })
    if (answer.outcome !== 'ok') throw new Error(answer.error)
    const { peer_only, peer_parents, optional_peer_parents } = answer.value
    return { peer_only, peer_parents, optional_peer_parents }
  }

  it('names no optional peer that a suffixed snapshot also requires', async () => {
    expect(
      await peersAfter((text) => text.replace(MOCKER, `${MOCKER}\n      vite: 6.4.3`)),
    ).toEqual({
      peer_only: true,
      peer_parents: ['@vitejs/plugin-react', '@vitest/mocker'],
      optional_peer_parents: [],
    })
  })

  it('reads a required edge from a snapshot with no peer suffix as no peer edge', async () => {
    const plain = "  '@vitest/mocker@3.0.5':\n    dependencies:\n      vite: 6.4.3\n\n"
    expect(await peersAfter((text) => text.replace(MOCKER, `${plain}${MOCKER}`))).toEqual({
      peer_only: false,
      peer_parents: ['@vitejs/plugin-react', '@vitest/mocker'],
      optional_peer_parents: ['@vitest/mocker'],
    })
  })

  it('puts the required peers first, whatever the order of the file', async () => {
    const moved = (text: string) => {
      const start = text.indexOf(MOCKER)
      const end = text.indexOf('  next@15.1.6(', start)
      const rest = text.slice(0, start) + text.slice(end)
      const at = rest.indexOf(PLUGIN)
      return rest.slice(0, at) + text.slice(start, end) + rest.slice(at)
    }
    expect(await peersAfter(moved)).toEqual({
      peer_only: true,
      peer_parents: ['@vitejs/plugin-react', '@vitest/mocker'],
      optional_peer_parents: ['@vitest/mocker'],
    })
  })

  // `react@18.2.0` is only in the peer suffix of the react-dom snapshot key.
  // It has no edge and no importer. node.sh answers peer_only here.
  it('answers peer_only for a package that only a peer suffix reaches, with no edge', async () => {
    const answer = await node.why(tree('pnpm-v9'), 'react', { raw: '' })
    expect(
      answer.outcome === 'ok' && {
        parents: answer.value.parents,
        peer_only: answer.value.peer_only,
        peer_parents: answer.value.peer_parents,
        optional_peer_parents: answer.value.optional_peer_parents,
      },
    ).toEqual({
      parents: [],
      peer_only: true,
      peer_parents: ['react-dom'],
      optional_peer_parents: [],
    })
  })

  // jq's `// {}` reads false as no block.
  it('reads a block that is false as no block', async () => {
    const root = copyOf('npm-v3')
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as object
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ ...manifest, optionalDependencies: false }),
    )
    const answer = await node.why(treeAt(root), 'lodash', { raw: '' })
    expect(answer.outcome === 'ok' && answer.value.relationship).toBe('direct')
  })

  // jq's `has` reads own keys only. `constructor` is a key of every object prototype.
  it('does not read a key of the object prototype as a declaration', async () => {
    const answer = await node.why(tree('npm-v3'), 'constructor', { raw: '' })
    expect(answer.outcome === 'ok' && answer.value.relationship).toBe('transitive')
  })

  // #50: bash names this parent `debug@git+ssh://git`.
  it('names a pnpm git parent by the name before its first @', async () => {
    const answer = await node.why(tree('pnpm-git-parent'), 'ms', { raw: '' })
    expect(answer.outcome === 'ok' && answer.value.parents).toEqual(['debug'])
  })

  it('names an npm alias parent', async () => {
    const answer = await node.why(tree('npm-alias'), 'lodash', { raw: '' })
    expect(answer.outcome === 'ok' && answer.value.parents).toEqual(['alias-parent', 'dupe-parent'])
  })

  it.each([
    ['only devDependencies declare it', {}, true],
    ['dependencies declare it too', { dependencies: { express: '^4.18.2', vitest: '1' } }, false],
    [
      'only peerDependencies declare it',
      { devDependencies: {}, peerDependencies: { vitest: '1' } },
      false,
    ],
  ])('answers dev_only when %s', async (_shape, change, devOnly) => {
    const root = copyOf('pnpm-v9')
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as object
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, ...change }))
    const answer = await node.why(treeAt(root), 'vitest', { raw: '' })
    expect(answer.outcome === 'ok' && [answer.value.relationship, answer.value.dev_only]).toEqual([
      'direct',
      devOnly,
    ])
  })
})

describe('why, with no raw text', () => {
  // `npm explain` reads node_modules, which the npm-v3 fixture holds. The
  // child gets PATH and a private HOME only. That keeps the npm
  // configuration of the machine out, and the `npm_config_` variables that
  // `pnpm exec` exports, which make npm write warnings.
  it('runs why_cmd in the tree, and answers what the package manager wrote', async () => {
    const sandbox = createSandbox()
    const root = copyOf('npm-v3')
    const detected = treeAt(root, { PATH: process.env.PATH })
    expect(detected.detection.why_cmd).toBe('npm explain')
    const env = { PATH: process.env.PATH, HOME: sandbox.env.HOME }
    const answer = await node.why(detected, 'express', { run, env })
    expect(answer.outcome === 'ok' && answer.value.raw).toBe(
      specimen('npm-v3-express').replace(/\n+$/, ''),
    )
  })

  // The words of why_cmd split at white space, the package comes last, the
  // child runs in the tree with the environment that it is given.
  it('splits why_cmd into words, and gives the child the tree and the environment', async () => {
    const root = copyOf('npm-v3')
    const { detection } = treeAt(root)
    const script = '[process.cwd(),process.env.WHY_PROBE,...process.argv.slice(1)].join()'
    const answer = await node.why(
      { root, detection: { ...detection, why_cmd: ` node\t --print  ${script} explain ` } },
      'express',
      { run, env: { PATH: process.env.PATH, WHY_PROBE: 'given' } },
    )
    expect(answer.outcome === 'ok' && answer.value.raw).toBe(
      `${realpathSync(root)},given,explain,express`,
    )
  })

  // node.sh runs `$why_cmd "$pkg" > file 2>&1 || true`: raw holds both
  // streams, and an exit that is not zero is no failure. The two pipes can
  // come in either order.
  it('answers stdout and stderr both as raw, when the command exits with an error', async () => {
    const root = copyOf('npm-v3')
    const { detection } = treeAt(root)
    // `exitCode`, not `exit()`: node can end before a pipe write is done.
    const script = "process.stdout.write('OUT'),process.stderr.write('ERR'),process.exitCode=3"
    const answer = await node.why(
      { root, detection: { ...detection, why_cmd: `node -e ${script}` } },
      'express',
      { run, env: { PATH: process.env.PATH } },
    )
    expect(['OUTERR', 'ERROUT']).toContain(answer.outcome === 'ok' && answer.value.raw)
  })

  it('answers the start failure as raw when the package manager is not on PATH', async () => {
    const root = copyOf('npm-v3')
    const answer = await node.why(treeAt(root), 'express', { run, env: NO_PATH })
    expect(answer.outcome === 'ok' && answer.value.raw).toBe('spawn npm ENOENT')
  })

  // `raw: undefined` is the runner form too. A caller with a `raw` of type
  // `string | undefined` must still give one of the two forms.
  it('runs why_cmd when raw is undefined', async () => {
    const root = copyOf('npm-v3')
    const answer = await node.why(treeAt(root), 'express', { raw: undefined, run, env: NO_PATH })
    expect(answer.outcome === 'ok' && answer.value.raw).toBe('spawn npm ENOENT')
  })

  it('does not start the package manager when the tree cannot answer', async () => {
    const started: string[] = []
    const answer = await node.why(tree('npm-v1'), 'lodash', {
      // Substituted through the documented parameter: it records a call.
      run: async (command) => {
        started.push(command)
        return run(command)
      },
      env: NO_PATH,
    })
    expect({ outcome: answer.outcome, started }).toEqual({ outcome: 'failed', started: [] })
  })
})

describe('why refusals', () => {
  it('fails with no package name', async () => {
    expect(await node.why(tree('npm-v3'), '', { raw: '' })).toEqual({
      outcome: 'failed',
      error: 'why requires a package name',
    })
  })

  // bash answers no parents here (the parity file declares it).
  it('fails for a lockfile that the reader refuses', async () => {
    expect(await node.why(tree('npm-v1'), 'lodash', { raw: '' })).toEqual({
      outcome: 'failed',
      error: 'package-lock.json has no .packages object (lockfileVersion 1 is unsupported)',
    })
  })

  it.each([
    [
      'a block that is not an object',
      '{"dependencies": "x"}',
      'why: dependencies in package.json is not an object',
    ],
    // jq's `map(has($pkg)) | any` reads all four blocks, so a bad block after
    // a declaration still stops it.
    [
      'a bad block after a block that declares the package',
      '{"dependencies": {"lodash": "^4"}, "peerDependencies": "x"}',
      'why: peerDependencies in package.json is not an object',
    ],
    ['no JSON document', ' \n', 'why: package.json holds no JSON document'],
    [
      'a top level that is a list',
      '[1]',
      'cannot index a value that is not an object with "dependencies"',
    ],
  ])('fails for a manifest with %s', async (_shape, text, error) => {
    const root = copyOf('npm-v3')
    const detected = treeAt(root)
    writeFileSync(join(root, 'package.json'), text)
    expect(await node.why(detected, 'lodash', { raw: '' })).toEqual({ outcome: 'failed', error })
  })

  it('fails for a tree with no manifest', async () => {
    const root = copyOf('npm-v3')
    const detected = treeAt(root)
    rmSync(join(root, 'package.json'))
    const answer = await node.why(detected, 'lodash', { raw: '' })
    expect(answer.outcome === 'failed' && answer.error).toMatch(/^ENOENT: /)
  })

  // The tree has both lockfiles, and `detect` names pnpm. The verb reads the
  // npm lockfile that the given detection names.
  it('reads the lockfile of the detection that it is given, and does not detect again', async () => {
    const root = copyOf('npm-v3')
    const npmTree = treeAt(root)
    copyFileSync(join(FIXTURES_ROOT, 'pnpm-v9', 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'))
    expect(treeAt(root).detection.pm).toBe('pnpm')
    const answer = await node.why(npmTree, 'lodash', { raw: '' })
    expect(answer.outcome === 'ok' && [answer.value.pm, answer.value.parents]).toEqual([
      'npm',
      ['express', 'test-exclude'],
    ])
  })
})
