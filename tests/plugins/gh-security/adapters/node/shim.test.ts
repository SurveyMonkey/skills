// `shim` of the node adapter (#222). The seam is `node.shim`. Each expected
// value is written by hand from `verb_shim` in node.sh and from the fixture
// that it names. The parity run holds the agreement with node.sh.
//
// The PATH is the parameter that `shim` takes. Each example gives a
// directory with an empty file for each tool on PATH, as detect.test.ts does.
// `shim` only looks for the name, and never runs it. One example runs a shim
// with `/bin/sh`. It shows that the shim gives its arguments to its runner.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { Environment, Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { type GitShape, useFixture } from '#harness/fixtures.ts'
import { createSandbox } from '#harness/sandbox.ts'

const HINT =
  'Create the fix worktree with git worktree add and run the command as: cd <worktree> && <command>.'

/** A PATH of one directory, with an empty file for each tool named. */
const pathWith = (...tools: string[]): Environment => {
  const bin = createSandbox().join('bin')
  mkdirSync(bin)
  for (const tool of tools) writeFileSync(join(bin, tool), '', { mode: 0o755 })
  return { PATH: bin }
}

/** A scratch copy of a fixture with the `.git` that `shape` names. */
const copyOf = (name: string, gitShape: GitShape = 'linked-worktree'): string => {
  const fixture = useFixture(name, { gitShape })
  onTestFinished(fixture.cleanup)
  return fixture.path
}

const treeAt = (root: string, env: Environment): Tree<NodeDetection> => {
  const detection = node.detect(root, env)
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

/** The shim of one copy, with one PATH for `detect` and `shim` both. */
const shimIn = (root: string, dir: string, env: Environment, runner?: string) =>
  node.shim(treeAt(root, env), dir, { env, ...(runner === undefined ? {} : { runner }) })

/** The text and the mode of a file. */
const fileAt = (path: string) => ({
  text: readFileSync(path, 'utf8'),
  mode: statSync(path).mode & 0o777,
})

describe('a manager on PATH', () => {
  it.each([
    ['npm-v3', 'npm'],
    ['pnpm-v9', 'pnpm'],
    ['yarn-berry', 'yarn'],
    ['yarn-vendored', 'yarn'],
  ])('writes nothing for %s when %s is on PATH', (fixture, pm) => {
    const root = copyOf(fixture)
    expect(shimIn(root, 'shim-bin', pathWith(pm, 'node'))).toEqual({
      outcome: 'ok',
      value: { created: false, pm, reason: `${pm} is already on PATH` },
    })
    expect(existsSync(join(root, 'shim-bin'))).toBe(false)
  })

  it('reads an empty runner as no runner, as node.sh does', () => {
    const root = copyOf('npm-v3')
    expect(shimIn(root, 'shim-bin', pathWith('npm'), '')).toMatchObject({
      value: { created: false },
    })
  })
})

describe('a shim that the verb writes', () => {
  it('starts the vendored yarn release by its absolute path', () => {
    const root = copyOf('yarn-vendored')
    expect(shimIn(root, 'shim-bin', pathWith('node'))).toEqual({
      outcome: 'ok',
      value: {
        created: true,
        pm: 'yarn',
        shim: 'shim-bin/yarn',
        path_prefix: 'shim-bin',
        runner: `node ${root}/.yarn/releases/yarn-4.13.0.cjs`,
      },
    })
    expect(fileAt(join(root, 'shim-bin', 'yarn'))).toEqual({
      text: `#!/bin/sh\nexec node ${root}/.yarn/releases/yarn-4.13.0.cjs "$@"\n`,
      mode: 0o755,
    })
  })

  it('starts corepack when the manager is not on PATH and the manifest names it', () => {
    const root = copyOf('pnpm-v9')
    expect(shimIn(root, 'shim-bin', pathWith('corepack'))).toMatchObject({
      value: { created: true, pm: 'pnpm', runner: 'corepack pnpm' },
    })
    expect(fileAt(join(root, 'shim-bin', 'pnpm')).text).toBe('#!/bin/sh\nexec corepack pnpm "$@"\n')
  })

  // node.sh writes this shim too. Its runner is the bare name. The shim
  // directory comes first on PATH, so the shim starts itself.
  it('starts the bare name when nothing else can run the manager, as node.sh does', () => {
    const root = copyOf('npm-v3')
    expect(shimIn(root, 'shim-bin', pathWith())).toMatchObject({
      value: { created: true, pm: 'npm', runner: 'npm' },
    })
  })

  it('starts the runner that the caller names, with the manager on PATH', () => {
    const root = copyOf('yarn-vendored')
    expect(shimIn(root, 'shim-bin', pathWith('yarn'), 'corepack yarn')).toMatchObject({
      value: { created: true, runner: 'corepack yarn' },
    })
  })

  it('makes a vendored runner that the caller names absolute', () => {
    const root = copyOf('yarn-vendored')
    expect(shimIn(root, 'shim-bin', pathWith('yarn'), 'node .yarn/x.cjs')).toMatchObject({
      value: { created: true, runner: `node ${root}/.yarn/x.cjs` },
    })
  })

  it('keeps a runner that only starts like a vendored one', () => {
    const root = copyOf('yarn-vendored')
    expect(shimIn(root, 'shim-bin', pathWith(), 'node ./.yarn/x.cjs')).toMatchObject({
      value: { runner: 'node ./.yarn/x.cjs' },
    })
  })

  it('makes each directory of a nested path, and names the path as given', () => {
    const root = copyOf('npm-v3')
    expect(shimIn(root, 'a/b/', pathWith())).toMatchObject({
      value: { shim: 'a/b//npm', path_prefix: 'a/b/' },
    })
    expect(existsSync(join(root, 'a', 'b', 'npm'))).toBe(true)
  })

  it('writes into an absolute directory outside the root', () => {
    const root = copyOf('npm-v3')
    const outside = createSandbox().join('out')
    expect(shimIn(root, outside, pathWith())).toMatchObject({
      value: { shim: `${outside}/npm`, path_prefix: outside },
    })
    expect(fileAt(join(outside, 'npm')).mode).toBe(0o755)
  })

  it('writes over a shim that is there, and gives it mode 0755', () => {
    const root = copyOf('npm-v3')
    mkdirSync(join(root, 'shim-bin'))
    writeFileSync(join(root, 'shim-bin', 'npm'), 'old', { mode: 0o600 })
    chmodSync(join(root, 'shim-bin', 'npm'), 0o600)
    shimIn(root, 'shim-bin', pathWith(), 'corepack npm')
    expect(fileAt(join(root, 'shim-bin', 'npm'))).toEqual({
      text: '#!/bin/sh\nexec corepack npm "$@"\n',
      mode: 0o755,
    })
  })

  it('writes a shim that starts its runner with the arguments it gets', () => {
    const root = copyOf('npm-v3')
    shimIn(root, 'shim-bin', pathWith(), 'echo')
    expect(
      execFileSync('/bin/sh', [join(root, 'shim-bin', 'npm'), 'a b', 'c'], { encoding: 'utf8' }),
    ).toBe('a b c\n')
  })
})

describe('the refusals', () => {
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
  ] as const)('refuses %s before it writes, and writes nothing', (_name, shape, reason) => {
    const root = copyOf('yarn-vendored', shape)
    const before = readdirSync(root).sort()
    expect(shimIn(root, 'shim-bin', pathWith(), 'corepack yarn')).toEqual({
      outcome: 'failed',
      error: `refusing to run 'shim' here: ${reason(root)}. ${HINT}`,
    })
    expect(readdirSync(root).sort()).toEqual(before)
  })

  it('refuses in a primary checkout before it reads the directory name', () => {
    const root = copyOf('npm-v3', 'primary-checkout')
    const envelope = shimIn(root, '', pathWith())
    expect(envelope.outcome === 'failed' && envelope.error).toContain('primary checkout')
  })

  it('refuses an empty directory name', () => {
    expect(shimIn(copyOf('npm-v3'), '', pathWith())).toEqual({
      outcome: 'failed',
      error: 'shim requires a target directory',
    })
  })

  it('refuses a directory that is a file', () => {
    expect(shimIn(copyOf('npm-v3'), 'package.json', pathWith())).toEqual({
      outcome: 'failed',
      error: 'cannot create shim directory: package.json',
    })
  })

  it('refuses a shim file that is a directory', () => {
    const root = copyOf('npm-v3')
    mkdirSync(join(root, 'shim-bin', 'npm'), { recursive: true })
    expect(shimIn(root, 'shim-bin', pathWith())).toEqual({
      outcome: 'failed',
      error: 'cannot write shim: shim-bin/npm',
    })
  })
})
