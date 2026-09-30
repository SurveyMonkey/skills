// The npm `package-lock.json` reader (#220, #221). Each expected value is
// written by hand from the fixture it names. The parity runs hold the
// agreement with node.sh. This file holds the behavior. It also holds `parents`, which no
// bash verb returns.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { copies, parents, resolutionMap, resolvedVersions } from '#gh-security/lockfiles/npm.ts'
import { aliasTarget, LockfileError } from '#gh-security/lockfiles/shared.ts'
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

  it('reads only the entries installed under node_modules', () => {
    expect(resolvedVersions(lockfile('npm-scoped-parents'), 'tool').copies).toEqual([])
  })
})

describe('resolutionMap', () => {
  it('answers undefined, not an inherited member, for a name it does not hold', () => {
    const { resolutions } = resolutionMap(lockfile('npm-alias'))
    const lookup = (name: string) => resolutions[name]
    expect(lookup('constructor')).toBeUndefined()
    expect(lookup('toString')).toBeUndefined()
  })

  it('lists the versions of one package in text order', () => {
    const text = JSON.stringify({
      packages: {
        'node_modules/a': { version: '9.0.0' },
        'node_modules/b/node_modules/a': { version: '10.0.0' },
        'node_modules/c/node_modules/a': { version: '1.0.0' },
      },
    })
    expect(resolutionMap(text).resolutions).toEqual({ a: ['1.0.0', '10.0.0', '9.0.0'] })
  })

  it('keeps an empty name field as the name', () => {
    const text = JSON.stringify({ packages: { 'node_modules/a': { name: '', version: '1.0.0' } } })
    expect(resolutionMap(text).resolutions).toEqual({ '': ['1.0.0'] })
  })

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

  it('lets a later block replace an earlier declaration of one name', () => {
    const text = JSON.stringify({
      packages: {
        'node_modules/a': {
          version: '1.0.0',
          dependencies: { x: 'npm:foo@1.0.0' },
          peerDependencies: { x: '^1.0.0' },
        },
      },
    })
    expect(parents(text, 'foo')).toEqual([])
    expect(parents(text, 'x')).toEqual([{ name: 'a', version: '1.0.0' }])
  })

  it('reads no declaration whose specifier is not a string', () => {
    const text = JSON.stringify({ packages: { 'node_modules/a': { dependencies: { x: 1 } } } })
    expect(parents(text, 'x')).toEqual([])
  })

  it('sorts parents as text by name and then version', () => {
    const declares = { dependencies: { x: '*' } }
    const text = JSON.stringify({
      packages: {
        'node_modules/z': { version: '1.0.0', ...declares },
        'node_modules/a': { version: '7.4.9', ...declares },
        'node_modules/b/node_modules/a': { version: '10.0.3', ...declares },
      },
    })
    expect(parents(text, 'x')).toEqual([
      { name: 'a', version: '10.0.3' },
      { name: 'a', version: '7.4.9' },
      { name: 'z', version: '1.0.0' },
    ])
  })

  it('never names the root', () => {
    expect(parents(lockfile('npm-stale-nested'), 'nx')).toEqual([])
  })

  it('names a parent that declares the package as optional', () => {
    expect(parents(lockfile('npm-v3'), 'sha.js')).toEqual([
      { name: 'express', version: '4.18.2' },
      { name: 'serve-static', version: '1.15.0' },
    ])
  })
})

describe('malformed input', () => {
  it('refuses text that is not JSON with a LockfileError that keeps the cause', () => {
    const attempt = () => resolutionMap('{"packages":')
    expect(attempt).toThrow(LockfileError)
    expect(attempt).toThrow(/^package-lock\.json is not valid JSON: /)
    expect(attempt).toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }))
  })

  it('reads text that starts with a byte order mark, as jq does', () => {
    const text = `\uFEFF${JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0' } } })}`
    expect(resolutionMap(text).resolutions).toEqual({ a: ['1.0.0'] })
  })

  it('refuses a packages value that is an array, with the lockfileVersion 1 message', () => {
    expect(() => resolutionMap('{"packages":[]}')).toThrow(
      new LockfileError(
        'package-lock.json has no .packages object (lockfileVersion 1 is unsupported)',
      ),
    )
  })

  // 2 of 4 is exactly half, which the guard allows.
  it('allows a lockfile it reads exactly half of', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '2.0.0' },
        'node_modules/c': { version: 'v3' },
        'node_modules/d': { version: 'v4' },
      },
    })
    expect(resolutionMap(text)).toEqual({
      coverage: { entries: 4, expected: 4, read: 2 },
      resolutions: { a: ['1.0.0'], b: ['2.0.0'] },
    })
  })

  it('refuses a lockfile it reads less than half of', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: 'v2' },
        'node_modules/c': { version: 'v3' },
      },
    })
    expect(() => resolutionMap(text)).toThrow(
      new LockfileError(
        "Read 1 of 3 lockfile entries for pm 'npm'. The parser understands too little of this lockfile to describe the tree; refusing to report a mostly-unparsed lockfile as a clean result.",
      ),
    )
  })
})

describe('aliasTarget', () => {
  it.each([
    ['npm:lodash@^4.18.0', 'lodash'],
    ['npm:@scope/pkg@1.0.0', '@scope/pkg'],
    ['npm:lodash', 'lodash'],
    ['npm:@scope/pkg', '@scope/pkg'],
    ['^4.0.0', null],
  ])('reads %s as %s', (specifier, expected) => {
    expect(aliasTarget(specifier)).toBe(expected)
  })
})

describe('copies', () => {
  // `express` reaches the hoisted copy. `test-exclude` has a nested copy.
  it('resolves each declaration through the walk up node_modules', () => {
    expect(copies(lockfile('npm-v3'), 'lodash')).toEqual([
      { parent: 'express', parent_version: '4.18.2', range: '^4.17.20', resolved: '4.17.21' },
      { parent: 'test-exclude', parent_version: '6.0.0', range: '^3.0.0', resolved: '3.10.1' },
    ])
  })

  it('reads the range of an alias declaration, and resolves it by its install key', () => {
    expect(copies(lockfile('npm-alias'), 'lodash')).toEqual([
      { parent: 'alias-parent', parent_version: '1.0.0', range: '^4.18.0', resolved: '4.18.1' },
      { parent: 'dupe-parent', parent_version: '1.0.0', range: '^4.17.21', resolved: '4.17.21' },
    ])
  })

  // #121: a scoped segment is two path segments, and a workspace key walks to the root.
  it('walks up past a scoped parent and from a workspace key', () => {
    expect(copies(lockfile('npm-scoped-parents'), 'brace-expansion')).toEqual([
      { parent: 'minimatch', parent_version: '10.0.3', range: '^5.0.5', resolved: '5.0.6' },
      { parent: 'minimatch', parent_version: '10.2.5', range: '^5.0.5', resolved: '5.0.6' },
      { parent: 'minimatch', parent_version: '7.4.9', range: '^2.0.2', resolved: '2.1.1' },
      { parent: 'packages/tool', parent_version: '1.0.0', range: '^2.0.2', resolved: '2.1.1' },
    ])
  })

  it.each([
    [
      'a candidate with no version',
      { 'node_modules/a': { version: '1.0.0', dependencies: { x: '^1' } }, 'node_modules/x': {} },
      null,
    ],
    [
      'no candidate at all',
      { 'node_modules/a': { version: '1.0.0', dependencies: { x: '^1' } } },
      null,
    ],
    [
      'a key that the walk cannot shorten',
      {
        'node_modules/a/': { version: '1.0.0', dependencies: { x: '^1' } },
        'node_modules/x': { version: '1.0.0' },
      },
      null,
    ],
  ])('resolves nothing for %s', (_shape, packages, resolved) => {
    const [row] = copies(JSON.stringify({ packages }), 'x')
    expect(row?.resolved).toBe(resolved)
  })

  it('reads no declaration that is not a string, of another package, or of the root', () => {
    const text = JSON.stringify({
      packages: {
        '': { dependencies: { x: '^1' } },
        'node_modules/a': { dependencies: { x: 1, y: 'npm:x' } },
      },
    })
    expect(copies(text, 'x')).toEqual([])
  })

  it('gives a null parent version to a copy that records none', () => {
    const text = JSON.stringify({
      packages: { 'node_modules/a': { peerDependencies: { x: '^1' } } },
    })
    expect(copies(text, 'x')).toEqual([
      { parent: 'a', parent_version: null, range: '^1', resolved: null },
    ])
  })
})
