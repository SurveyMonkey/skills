// `parents` of the node adapter (#221). No verb of node.sh writes it, so
// these examples prove it (#221, round 3 sweep). The seam is the `node`
// adapter. Each expected value is written by hand from the lockfile of the
// fixture that it names. The lockfile unit tests hold the readers.
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'

/** One empty PATH entry, the tree root, which holds no tool. `parents` starts no process. */
const NO_PATH = { PATH: '' }

const treeAt = (root: string): Tree<NodeDetection> => {
  const detection = node.detect(root, NO_PATH)
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

describe('parents', () => {
  it.each([
    [
      'npm',
      'npm-v3',
      'lodash',
      [
        { name: 'express', version: '4.18.2' },
        { name: 'test-exclude', version: '6.0.0' },
      ],
    ],
    ['pnpm', 'pnpm-v9', 'lodash', [{ name: 'express', version: '4.18.2' }]],
    ['yarn', 'yarn-berry', 'lodash', [{ name: 'express', version: '4.18.2' }]],
  ])('answers each copy that declares the package in a %s tree', (pm, fixture, pkg, found) => {
    expect(node.parents(tree(fixture), pkg)).toEqual({
      outcome: 'ok',
      value: { pm, package: pkg, parents: found },
    })
  })

  // #50: bash names this parent `debug@git+ssh://git`.
  it('names a pnpm git parent by the name before its first @', () => {
    expect(node.parents(tree('pnpm-git-parent'), 'ms')).toEqual({
      outcome: 'ok',
      value: { pm: 'pnpm', package: 'ms', parents: [{ name: 'debug', version: null }] },
    })
  })

  // ADR 001, "One documented exception": a parent that declares an alias of
  // the package is a parent of it.
  it.each([
    [
      'npm-alias',
      [
        { name: 'alias-parent', version: '1.0.0' },
        { name: 'dupe-parent', version: '1.0.0' },
      ],
    ],
    ['yarn-berry-alias-parent', [{ name: 'express', version: '4.18.2' }]],
  ])('names an alias parent in %s', (fixture, found) => {
    const answer = node.parents(tree(fixture), 'lodash')
    expect(answer.outcome === 'ok' && answer.value.parents).toEqual(found)
  })

  it('answers no parents for a package that only the root declares', () => {
    const answer = node.parents(tree('npm-v3'), 'express')
    expect(answer.outcome === 'ok' && answer.value.parents).toEqual([])
  })

  it('fails with no package name', () => {
    expect(node.parents(tree('npm-v3'), '')).toEqual({
      outcome: 'failed',
      error: 'parents requires a package name',
    })
  })

  // bash answers no parents here (the parity file declares it). A reader
  // that cannot read the lockfile does not answer "none".
  it('fails for a lockfile that the reader refuses', () => {
    expect(node.parents(tree('npm-v1'), 'lodash')).toEqual({
      outcome: 'failed',
      error: 'package-lock.json has no .packages object (lockfileVersion 1 is unsupported)',
    })
  })

  it('fails when the lockfile is gone', () => {
    const root = copyOf('npm-v3')
    const detected = treeAt(root)
    rmSync(join(root, 'package-lock.json'))
    const answer = node.parents(detected, 'lodash')
    expect(answer.outcome === 'failed' && answer.error).toMatch(/^ENOENT: /)
  })

  // The tree has both lockfiles, and `detect` names pnpm. The verb reads the
  // npm lockfile that the given detection names.
  it('reads the lockfile of the detection that it is given, and does not detect again', () => {
    const root = copyOf('npm-v3')
    const npmTree = treeAt(root)
    copyFileSync(join(FIXTURES_ROOT, 'pnpm-v9', 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'))
    expect(treeAt(root).detection.pm).toBe('pnpm')
    const answer = node.parents(npmTree, 'lodash')
    expect(answer.outcome === 'ok' && answer.value).toEqual({
      pm: 'npm',
      package: 'lodash',
      parents: [
        { name: 'express', version: '4.18.2' },
        { name: 'test-exclude', version: '6.0.0' },
      ],
    })
  })
})
