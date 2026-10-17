// What `test-pin` reads from the two whole-tree maps
// (`audit-pins-collateral.ts`): the disagreement of the two verbs, and the
// collateral list with the platform-binary family rule. These are the
// examples of `spec/audit_driver_spec.sh` ("the two verbs must agree" and
// "the platform-binary family sample"), on the exported functions. The
// expected values are written by hand from `audit-driver.md`.
import { describe, expect, it } from 'vitest'

import {
  collateralOf,
  disagreementOf,
  familyKey,
  minus,
  platformTail,
} from '#gh-security/subcommands/audit-pins-collateral.ts'

describe('disagreementOf', () => {
  it('answers null when both name the same versions, at however many paths', () => {
    expect(disagreementOf({ lodash: ['4.17.21'] }, 'lodash', ['4.17.21'])).toBeNull()
  })

  it.each([
    ['an alias key: no entry in the map, versions in the list', {}, ['4.18.2'], 'alias-key'],
    [
      'a shared install key: the map holds a part of the list',
      { lodash: ['4.17.21'] },
      ['1.13.6', '4.17.21'],
      'shared-install-key',
    ],
    [
      'a list with nothing the map has',
      { lodash: ['4.17.21'] },
      ['4.17.20'],
      'parser-disagreement',
    ],
    [
      'a map with versions beside an empty list',
      { lodash: ['4.17.21'] },
      [],
      'parser-disagreement',
    ],
  ])('names %s', (_name, now, resolved, shape) => {
    const found = disagreementOf(now, 'lodash', resolved)
    expect({ shape: found?.shape, map: found?.map, resolved: found?.resolved_versions }).toEqual({
      shape,
      map: Object.hasOwn(now, 'lodash') ? ['4.17.21'] : [],
      resolved,
    })
  })

  it('names the package in the words of a shared install key', () => {
    expect(disagreementOf({ lodash: ['1'] }, 'lodash', ['1', '2'])?.detail).toContain(
      'the name lodash is carried by two different packages in this tree',
    )
  })
})

describe('minus', () => {
  it('keeps each entry of the first list that the second does not have, in order', () => {
    expect(minus(['3', '1', '2', '1'], ['2'])).toEqual(['3', '1', '1'])
  })
})

describe('familyKey and platformTail', () => {
  it.each([
    ['@esbuild/linux-x64', '@esbuild/'],
    ['lightningcss-darwin-arm64', 'lightningcss-'],
    ['express', 'express'],
  ])('gives %s the key %s', (name, key) => {
    expect(familyKey(name)).toBe(key)
  })

  it.each([
    ['@esbuild/darwin-arm64', '@esbuild/', true],
    ['@rolldown/binding-linux-x64-gnu', '@rolldown/', true],
    ['@swc/core-linux-x64-musl', '@swc/', true],
    ['@types/node', '@types/', false],
    ['eslint-config', 'eslint-', false],
    ['foo-linux', 'foo-', false],
    ['@esbuild/linux-x64-extra', '@esbuild/', false],
    ['express', 'express', false],
  ])('reads %s past %s as a platform triple: %s', (name, key, expected) => {
    expect(platformTail(name, key)).toBe(expected)
  })
})

const ESBUILD = ['@esbuild/darwin-arm64', '@esbuild/linux-x64', '@esbuild/win32-x64']

const map = (entries: Record<string, string[]>) => ({
  lodash: ['4.17.21'],
  minimatch: ['9.0.5'],
  ...entries,
})

const at = (names: readonly string[], version: string) =>
  Object.fromEntries(names.map((name) => [name, [version]]))

const judged = (base: Record<string, string[]>, now: Record<string, string[]>) =>
  collateralOf(base, now, 'lodash')
    .changes.filter((change) => change.judged === true)
    .map((change) => change.package)

describe('collateralOf', () => {
  it('lists each other package that moved, with what it newly admits', () => {
    const moved = collateralOf(
      map({ express: ['4.18.2'], qs: ['6.1.0'] }),
      map({ lodash: ['4.17.20'], express: ['4.18.2', '4.19.2'], 'body-parser': ['1.20.0'] }),
      'lodash',
    )
    expect(moved).toEqual({
      changes: [
        {
          package: 'body-parser',
          baseline: [],
          without_pin: ['1.20.0'],
          newly_admitted: ['1.20.0'],
          judged: true,
          represented_by: null,
          family: null,
        },
        {
          package: 'express',
          baseline: ['4.18.2'],
          without_pin: ['4.18.2', '4.19.2'],
          newly_admitted: ['4.19.2'],
          judged: true,
          represented_by: null,
          family: null,
        },
        {
          package: 'qs',
          baseline: ['6.1.0'],
          without_pin: [],
          newly_admitted: [],
          judged: true,
          represented_by: null,
          family: null,
        },
      ],
      families: [],
    })
  })

  it('samples one member when every condition holds', () => {
    const moved = collateralOf(map(at(ESBUILD, '0.21.0')), map(at(ESBUILD, '0.23.1')), 'lodash')
    const family = {
      key: '@esbuild/',
      size: 3,
      members: ESBUILD,
      sample: '@esbuild/darwin-arm64',
      shared_version: '0.23.1',
    }
    expect(moved.families).toEqual([family])
    expect(
      moved.changes.map(({ package: name, judged, represented_by, family: f }) => ({
        name,
        judged,
        represented_by,
        f,
      })),
    ).toEqual([
      { name: '@esbuild/darwin-arm64', judged: true, represented_by: null, f: family },
      {
        name: '@esbuild/linux-x64',
        judged: false,
        represented_by: '@esbuild/darwin-arm64',
        f: family,
      },
      {
        name: '@esbuild/win32-x64',
        judged: false,
        represented_by: '@esbuild/darwin-arm64',
        f: family,
      },
    ])
  })

  it('gives each sampled family once, sorted by its key', () => {
    const swc = ['@swc/core-darwin-arm64', '@swc/core-linux-x64-gnu']
    const moved = collateralOf(
      map({ ...at(swc, '1.0.0'), ...at(ESBUILD, '0.21.0') }),
      map({ ...at(swc, '1.1.0'), ...at(ESBUILD, '0.23.1') }),
      'lodash',
    )
    expect(moved.families.map((family) => family.key)).toEqual(['@esbuild/', '@swc/'])
  })

  it('checks every member when the family does not share one new version', () => {
    expect(
      judged(
        map(at(ESBUILD, '0.21.0')),
        map({ ...at(ESBUILD, '0.23.1'), '@esbuild/win32-x64': ['0.23.2'] }),
      ),
    ).toEqual(ESBUILD)
  })

  it('checks every member when they did not share one baseline either', () => {
    expect(
      judged(
        map({ ...at(ESBUILD, '0.21.0'), '@esbuild/win32-x64': ['0.20.0'] }),
        map(at(ESBUILD, '0.23.1')),
      ),
    ).toEqual(ESBUILD)
  })

  it('checks every member when a member in the tree did not move', () => {
    const still = { '@esbuild/linux-arm64': ['0.21.0'] }
    expect(
      judged(
        map({ ...at(ESBUILD, '0.21.0'), ...still }),
        map({ ...at(ESBUILD, '0.23.1'), ...still }),
      ),
    ).toEqual(ESBUILD)
  })

  it('checks every member of a two-member scope with no platform triple', () => {
    const types = ['@types/node', '@types/react']
    expect(judged(map(at(types, '20.1.0')), map(at(types, '20.4.0')))).toEqual(types)
  })

  it('never samples a lone package', () => {
    expect(
      collateralOf(
        map({ '@esbuild/linux-x64': ['0.21.0'] }),
        map({ '@esbuild/linux-x64': ['0.23.1'] }),
        'lodash',
      ).families,
    ).toEqual([])
  })

  it('reads a key named after a member of Object.prototype as a package', () => {
    expect(judged(map({ constructor: ['1.0.0'] }), map({}))).toEqual(['constructor'])
  })
})
