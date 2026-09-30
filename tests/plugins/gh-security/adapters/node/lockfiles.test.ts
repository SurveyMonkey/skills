// `resolved_versions` and `resolution_map` of the node adapter (#221). The
// seam is the `node` adapter. Each expected value is written by hand from
// the fixture that it names. The parity run holds the agreement with
// node.sh, and the lockfile unit tests hold the parsers.
//
// The tree that each example gives is the answer of `node.detect` on that
// fixture, as a caller builds it.
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'

/** One empty PATH entry, the tree root, which holds no tool. The runner does not matter here. */
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

describe('resolved_versions', () => {
  it('answers every copy of a package, with the fields the verb adds', () => {
    expect(node.resolvedVersions(tree('npm-alias'), 'lodash')).toEqual({
      outcome: 'ok',
      value: {
        pm: 'npm',
        package: 'lodash',
        present: true,
        count: 3,
        versions: [
          { version: '4.17.21', path: 'node_modules/dupe-parent/node_modules/lodash' },
          { version: '4.17.21', path: 'node_modules/lodash' },
          { version: '4.18.1', path: 'node_modules/lodash-alias' },
        ],
        lockfile_entries: 6,
      },
    })
  })

  // ADR 001, "One documented exception": the install key of an alias finds
  // its copy, because an override names that key.
  it.each([
    [
      'npm-alias',
      'lodash-alias',
      'npm',
      { version: '4.18.1', path: 'node_modules/lodash-alias' },
      6,
    ],
    [
      'yarn-alias',
      'aliased',
      'yarn',
      { version: '4.17.21', path: 'aliased@npm:lodash@4.17.21' },
      3,
    ],
  ])('answers for the alias key in %s', (fixture, pkg, pm, copy, entries) => {
    expect(node.resolvedVersions(tree(fixture), pkg)).toEqual({
      outcome: 'ok',
      value: {
        pm,
        package: pkg,
        present: true,
        count: 1,
        versions: [copy],
        lockfile_entries: entries,
      },
    })
  })

  it('answers present: false for a package that a populated lockfile does not hold', () => {
    expect(node.resolvedVersions(tree('npm-alias'), 'left-pad')).toEqual({
      outcome: 'ok',
      value: {
        pm: 'npm',
        package: 'left-pad',
        present: false,
        count: 0,
        versions: [],
        lockfile_entries: 6,
      },
    })
  })

  it('refuses an empty package name', () => {
    expect(node.resolvedVersions(tree('npm-alias'), '')).toEqual({
      outcome: 'failed',
      error: 'resolved_versions requires a package name',
    })
  })
})

describe('resolution_map', () => {
  it('answers each package with its versions and the coverage of the parse', () => {
    expect(node.resolutionMap(tree('pnpm-v9'))).toEqual({
      outcome: 'ok',
      value: {
        pm: 'pnpm',
        lockfile_entries: 5,
        entries_read: 5,
        entries_expected: 5,
        unreadable_entries: 0,
        package_count: 5,
        resolutions: {
          '@babel/core': ['7.24.0'],
          express: ['4.18.2'],
          lodash: ['4.17.21'],
          'react-dom': ['18.2.0'],
          'sha.js': ['2.4.11'],
        },
      },
    })
  })

  it('keys an alias by the package it resolves to', () => {
    const map = node.resolutionMap(tree('yarn-alias'))
    expect(map.outcome === 'ok' && map.value.resolutions).toEqual({
      lodash: ['4.17.21'],
      '@scope/real': ['2.3.4'],
    })
  })

  it.each([
    ['npm-partial-read', { entries: 4, read: 3, expected: 4, unreadable: 1, packages: 3 }],
    ['yarn-partial-read', { entries: 5, read: 4, expected: 5, unreadable: 1, packages: 3 }],
  ])('states the entries that %s could not read', (fixture, counts) => {
    const map = node.resolutionMap(tree(fixture))
    expect(
      map.outcome === 'ok' && {
        entries: map.value.lockfile_entries,
        read: map.value.entries_read,
        expected: map.value.entries_expected,
        unreadable: map.value.unreadable_entries,
        packages: map.value.package_count,
      },
    ).toEqual(counts)
  })
})

describe('the refusals of both verbs', () => {
  const zero = (pm: string) =>
    `Parsed 0 entries from the lockfile for pm '${pm}'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result.`

  // ADR 001, "Empty results are never implicitly successful".
  it.each([
    ['empty-npm', zero('npm')],
    ['pnpm-no-overrides', zero('pnpm')],
    ['empty-yarn', zero('yarn')],
    [
      'yarn-unknown-protocol',
      "Read 1 of 4 lockfile entries for pm 'yarn'. The parser understands too little of this lockfile to describe the tree; refusing to report a mostly-unparsed lockfile as a clean result.",
    ],
    ['npm-v1', 'package-lock.json has no .packages object (lockfileVersion 1 is unsupported)'],
  ])('fails for %s', (fixture, error) => {
    const read = tree(fixture)
    expect([node.resolutionMap(read), node.resolvedVersions(read, 'lodash')]).toEqual([
      { outcome: 'failed', error },
      { outcome: 'failed', error },
    ])
  })

  it('fails for a lockfile that is gone after detect, and names it', () => {
    const root = copyOf('npm-v3')
    const read = treeAt(root)
    rmSync(join(root, 'package-lock.json'))
    const error = `ENOENT: no such file or directory, open '${join(root, 'package-lock.json')}'`
    expect([node.resolutionMap(read), node.resolvedVersions(read, 'lodash')]).toEqual([
      { outcome: 'failed', error },
      { outcome: 'failed', error },
    ])
  })
})

// The issue's Scope: detection runs once for each call site. After detect,
// this tree gains a pnpm lockfile, which a second detect would pick over the
// npm one. Each verb still reads the npm lockfile that its tree names.
describe('a verb that is given a tree', () => {
  it('reads the lockfile of the detection it is given, and does not detect again', () => {
    const root = copyOf('npm-v3')
    const read = treeAt(root)
    copyFileSync(join(FIXTURES_ROOT, 'pnpm-v9', 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'))
    const map = node.resolutionMap(read)
    const versions = node.resolvedVersions(read, 'lodash')
    expect({
      again: node.detect(root, NO_PATH).outcome === 'ok' && treeAt(root).detection.pm,
      map: map.outcome === 'ok' && [map.value.pm, map.value.lockfile_entries],
      versions: versions.outcome === 'ok' && [versions.value.pm, versions.value.lockfile_entries],
    }).toEqual({ again: 'pnpm', map: ['npm', 7], versions: ['npm', 7] })
  })
})
