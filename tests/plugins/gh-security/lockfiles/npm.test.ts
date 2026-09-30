// The npm `package-lock.json` reader (#220). Each expected value is written by
// hand from the fixture it names. The parity run holds the agreement with
// node.sh, so this file holds the behavior, and `parents`, which has no bash
// verb yet.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parents, resolutionMap, resolvedVersions } from '#gh-security/lockfiles/npm.ts'
import { LockfileError } from '#gh-security/lockfiles/shared.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'

const lockfile = (fixture: string): string =>
  readFileSync(join(FIXTURES_ROOT, fixture, 'package-lock.json'), 'utf8')

describe('resolvedVersions', () => {
  it('finds a hoisted copy, a nested copy and an alias copy of one package', () => {
    expect(resolvedVersions(lockfile('npm-alias'), 'lodash')).toEqual({
      coverage: { entries: 6, expected: 6, read: 6 },
      copies: [
        { version: '4.17.21', path: 'node_modules/dupe-parent/node_modules/lodash' },
        { version: '4.17.21', path: 'node_modules/lodash' },
        { version: '4.18.1', path: 'node_modules/lodash-alias' },
      ],
    })
  })

  it('answers for the alias key too', () => {
    expect(resolvedVersions(lockfile('npm-alias'), 'lodash-alias').copies).toEqual([
      { version: '4.18.1', path: 'node_modules/lodash-alias' },
    ])
  })

  it('finds each copy at every depth of nesting', () => {
    expect(resolvedVersions(lockfile('npm-stale-nested'), 'axios').copies).toEqual([
      { version: '0.21.4', path: 'node_modules/localtunnel/node_modules/axios' },
      { version: '1.16.0', path: 'node_modules/nx/node_modules/axios' },
      { version: '1.18.1', path: 'node_modules/axios' },
    ])
  })

  it('answers no copies for a package the lockfile does not hold', () => {
    expect(resolvedVersions(lockfile('npm-alias'), 'left-pad').copies).toEqual([])
  })

  it('keeps a version that is not a registry version', () => {
    expect(resolvedVersions(lockfile('npm-partial-read'), 'victim').copies).toEqual([
      { version: 'v1.2.3', path: 'node_modules/victim' },
    ])
  })
})

describe('resolutionMap', () => {
  it('keeps workspace links out of the map and out of the expected count', () => {
    expect(resolutionMap(lockfile('npm-workspaces'))).toEqual({
      coverage: { entries: 16, expected: 4, read: 4 },
      resolutions: {
        express: ['4.18.2'],
        lodash: ['4.17.21'],
        'sha.js': ['2.4.11'],
        undici: ['6.19.8'],
      },
    })
  })

  it('keys an alias copy under the package it aliases', () => {
    expect(resolutionMap(lockfile('npm-alias')).resolutions).toEqual({
      'alias-parent': ['1.0.0'],
      'dupe-parent': ['1.0.0'],
      express: ['4.21.2'],
      lodash: ['4.17.21', '4.18.1'],
    })
  })

  it('counts an entry it cannot read, and leaves it out of the map', () => {
    expect(resolutionMap(lockfile('npm-partial-read'))).toEqual({
      coverage: { entries: 4, expected: 4, read: 3 },
      resolutions: { express: ['4.18.2'], lodash: ['4.17.21'], 'sha.js': ['2.4.11'] },
    })
  })
})

describe('refusals', () => {
  it.each([
    ['resolvedVersions', (text: string) => resolvedVersions(text, 'axios')],
    ['resolutionMap', (text: string) => resolutionMap(text)],
    ['parents', (text: string) => parents(text, 'axios')],
  ])('%s refuses a lockfileVersion 1 lockfile', (_name, read) => {
    expect(() => read(lockfile('npm-v1'))).toThrow(
      new LockfileError(
        'package-lock.json has no .packages object (lockfileVersion 1 is unsupported)',
      ),
    )
  })

  it.each([
    ['resolvedVersions', (text: string) => resolvedVersions(text, 'lodash')],
    ['resolutionMap', (text: string) => resolutionMap(text)],
  ])('%s refuses a lockfile with no entries', (_name, read) => {
    expect(() => read(lockfile('empty-npm'))).toThrow(
      new LockfileError(
        "Parsed 0 entries from the lockfile for pm 'npm'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result.",
      ),
    )
  })

  it('throws a LockfileError, not a plain Error', () => {
    expect(() => resolutionMap(lockfile('empty-npm'))).toThrow(LockfileError)
  })
})

describe('parents', () => {
  it('names a parent that declares the package, and one that declares it through an alias', () => {
    expect(parents(lockfile('npm-alias'), 'lodash')).toEqual([
      { name: 'alias-parent', version: '1.0.0' },
      { name: 'dupe-parent', version: '1.0.0' },
    ])
  })

  it('names the parent of an alias key', () => {
    expect(parents(lockfile('npm-alias'), 'lodash-alias')).toEqual([
      { name: 'alias-parent', version: '1.0.0' },
    ])
  })

  it('names a parent that declares the package as a peer', () => {
    expect(parents(lockfile('npm-alias'), 'express')).toEqual([
      { name: 'dupe-parent', version: '1.0.0' },
    ])
  })

  it('names each copy of a parent, a nested one and a workspace', () => {
    expect(parents(lockfile('npm-scoped-parents'), 'brace-expansion')).toEqual([
      { name: 'minimatch', version: '10.0.3' },
      { name: 'minimatch', version: '10.2.5' },
      { name: 'minimatch', version: '7.4.9' },
      { name: 'packages/tool', version: '1.0.0' },
    ])
  })

  it('never names the root', () => {
    expect(parents(lockfile('npm-stale-nested'), 'nx')).toEqual([])
  })
})
