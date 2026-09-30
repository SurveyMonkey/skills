// The pnpm `pnpm-lock.yaml` reader (#220, #221). Each expected value is
// written by hand from the fixture it names. The parity runs hold the
// agreement with node.sh. This file holds the behavior. It also holds
// `parents`, which no bash verb returns.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  copies,
  isV9,
  parents,
  resolutionMap,
  resolvedVersions,
  rootVersion,
  scan,
} from '#gh-security/lockfiles/pnpm.ts'
import { LockfileError } from '#gh-security/lockfiles/shared.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'

const lockfile = (fixture: string): string =>
  readFileSync(join(FIXTURES_ROOT, fixture, 'pnpm-lock.yaml'), 'utf8')

describe('resolvedVersions', () => {
  it('finds a registry copy by its packages key', () => {
    expect(resolvedVersions(lockfile('pnpm-v9'), 'lodash')).toEqual({
      coverage: { entries: 5, expected: 5, read: 5 },
      copies: [{ version: '4.17.21', path: 'lodash@4.17.21' }],
    })
  })

  it('reads a quoted scoped key', () => {
    expect(resolvedVersions(lockfile('pnpm-v9'), '@babel/core').copies).toEqual([
      { version: '7.24.0', path: '@babel/core@7.24.0' },
    ])
  })

  it('leaves the peer suffix out of the version', () => {
    expect(resolvedVersions(lockfile('pnpm-v9'), 'react-dom').copies).toEqual([
      { version: '18.2.0', path: 'react-dom@18.2.0' },
    ])
  })

  it('names one copy for two peer variants of one version', () => {
    const text =
      'packages:\n\n  react-dom@18.2.0(react@17.0.2):\n    resolution: {}\n\n  react-dom@18.2.0(react@18.2.0):\n    resolution: {}\n'
    expect(resolvedVersions(text, 'react-dom')).toEqual({
      coverage: { entries: 2, expected: 2, read: 2 },
      copies: [{ version: '18.2.0', path: 'react-dom@18.2.0' }],
    })
  })

  it('answers no copies for a git target', () => {
    expect(resolvedVersions(lockfile('pnpm-local'), 'ssh-dep').copies).toEqual([])
  })

  it('answers no copies for a package the lockfile does not hold', () => {
    expect(resolvedVersions(lockfile('pnpm-v9'), 'left-pad').copies).toEqual([])
  })
})

describe('resolutionMap', () => {
  it('reads link, file, git and URL targets and keeps them out of the map', () => {
    expect(resolutionMap(lockfile('pnpm-local'))).toEqual({
      coverage: { entries: 6, expected: 6, read: 6 },
      resolutions: { express: ['4.18.2'], lodash: ['4.17.21'] },
    })
  })

  // A pin, not a fix: node.sh keeps the leading `/` in the name of a
  // lockfileVersion 6 key. The parity run holds the module to node.sh.
  it('reads a lockfileVersion 6 key through the split on its last @', () => {
    expect(resolutionMap(lockfile('pnpm-v6'))).toEqual({
      coverage: { entries: 3, expected: 3, read: 3 },
      resolutions: {
        '/@vitejs/plugin-react': ['4.3.4'],
        '/@vitest/mocker': ['3.0.5'],
        '/vite': ['6.4.3'],
      },
    })
  })

  it('keeps a git parent out of the map and its registry child in it', () => {
    expect(resolutionMap(lockfile('pnpm-git-parent'))).toEqual({
      coverage: { entries: 2, expected: 2, read: 2 },
      resolutions: { ms: ['2.1.2'] },
    })
  })
})

describe('refusals', () => {
  it.each([
    ['resolvedVersions', (text: string) => resolvedVersions(text, 'lodash')],
    ['resolutionMap', (text: string) => resolutionMap(text)],
  ])('%s refuses a lockfile with no packages', (_name, read) => {
    expect(() => read(lockfile('pnpm-no-overrides'))).toThrow(
      new LockfileError(
        "Parsed 0 entries from the lockfile for pm 'pnpm'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result.",
      ),
    )
  })
})

describe('parents', () => {
  it('names the parent of a dependencies edge, with its version', () => {
    expect(parents(lockfile('pnpm-v9'), 'lodash')).toEqual([{ name: 'express', version: '4.18.2' }])
  })

  it('names the parent of an optionalDependencies edge', () => {
    expect(parents(lockfile('pnpm-optional-parent'), 'dompurify')).toEqual([
      { name: 'jspdf', version: '4.2.1' },
    ])
  })

  it('names a parent whose key carries a peer suffix, without the suffix', () => {
    expect(parents(lockfile('pnpm-workspace-peer'), 'vite')).toEqual([
      { name: '@vitejs/plugin-react', version: '4.3.4' },
    ])
  })

  // #50: bash names this parent `debug@git+ssh://git`.
  it('names a git parent by the name before its first @', () => {
    expect(parents(lockfile('pnpm-git-parent'), 'ms')).toEqual([{ name: 'debug', version: null }])
  })

  it('reads no parents from a lockfileVersion 6 lockfile, which has no snapshots', () => {
    expect(parents(lockfile('pnpm-v6'), 'vite')).toEqual([])
  })

  it('reads no edge from the peerDependencies of a packages entry', () => {
    expect(parents(lockfile('pnpm-git-parent'), 'supports-color')).toEqual([])
  })

  it('names a parent once when two peer variants of it declare the package', () => {
    expect(parents(lockfile('pnpm-peer-variant'), 'react')).toEqual([
      { name: 'react-redux', version: '8.1.3' },
    ])
  })

  it('reads a quoted scoped child', () => {
    expect(parents(lockfile('pnpm-workspace-peer'), '@babel/core')).toEqual([
      { name: '@vitejs/plugin-react', version: '4.3.4' },
    ])
  })

  it('reads no edge from a line without a colon', () => {
    const text = 'snapshots:\n\n  a@1.0.0:\n    dependencies:\n      lodash\n'
    expect(parents(text, 'lodash')).toEqual([])
  })

  it('reads no edge from a peerDependencies block of a snapshot', () => {
    const text = 'snapshots:\n\n  a@1.0.0:\n    peerDependencies:\n      lodash: 4.17.21\n'
    expect(parents(text, 'lodash')).toEqual([])
  })

  it('reads no snapshot after the section that follows snapshots', () => {
    const text =
      'snapshots:\n\n  a@1.0.0: {}\n\nother:\n  c@1.0.0:\n    dependencies:\n      lodash: 4.17.21\n'
    expect(parents(text, 'lodash')).toEqual([])
  })

  it('reads no edge from a block that follows the edges', () => {
    const text =
      'snapshots:\n\n  a@1.0.0:\n    dependencies:\n      b: 1.0.0\n    transitivePeerDependencies:\n      lodash: x\n'
    expect(parents(text, 'lodash')).toEqual([])
  })

  it('reads no edge under a key that has no edge block', () => {
    const text =
      'snapshots:\n\n  a@1.0.0:\n    dependencies:\n      b: 1.0.0\n  c@1.0.0:\n      lodash: 4.17.21\n'
    expect(parents(text, 'lodash')).toEqual([])
  })

  it('names no parent for a key that has no name', () => {
    const text = "snapshots:\n\n  '(react@1.0.0)':\n    dependencies:\n      lodash: 4.17.21\n"
    expect(parents(text, 'lodash')).toEqual([])
  })
})

describe('key readings', () => {
  const keyed = (key: string): string => `packages:\n\n  ${key}:\n    resolution: {}\n`
  const other = 'ok@1.0.0'

  // Each target has a protocol, so it counts as read and stays out of the map.
  it.each([
    'link:../a',
    'file:../a',
    'workspace:*',
    'portal:../a',
    'catalog:',
    'exec:./a',
    'git:x',
    'git+ssh://x',
    'git+http://x',
    'git+https://x',
    'http://x',
    'https://x',
    'ssh://x',
    'github:x/y',
    'gitlab:x/y',
    'bitbucket:x/y',
  ])('reads a %s target and keeps it out of the map', (target) => {
    const text = `${keyed(`pkg@${target}`)}\n  ${other}:\n    resolution: {}\n`
    expect(resolutionMap(text)).toEqual({
      coverage: { entries: 2, expected: 2, read: 2 },
      resolutions: { ok: ['1.0.0'] },
    })
  })

  it.each(['pkg@xfile:y', '@1.0.0'])('counts the key %s as unread', (key) => {
    const text = `${keyed(key)}\n  ${other}:\n    resolution: {}\n`
    expect(resolutionMap(text).coverage).toEqual({ entries: 2, expected: 2, read: 1 })
  })

  // Exactly half passes the guard.
  it('counts a key it cannot read against the guard', () => {
    const text = `${keyed('pkg@unknown:x')}\n  ${other}:\n    resolution: {}\n`
    expect(resolutionMap(text).coverage).toEqual({ entries: 2, expected: 2, read: 1 })
  })

  it('refuses a lockfile it reads less than half of', () => {
    const text = `${keyed('a@unknown:x')}\n  b@unknown:y:\n    resolution: {}\n\n  ${other}:\n`
    expect(() => resolutionMap(text)).toThrow(
      new LockfileError(
        "Read 1 of 3 lockfile entries for pm 'pnpm'. The parser understands too little of this lockfile to describe the tree; refusing to report a mostly-unparsed lockfile as a clean result.",
      ),
    )
  })
})

describe('scan', () => {
  it('finds each peer instantiation and each edge to a package that only peers reach', () => {
    expect(scan(lockfile('pnpm-peer-only'), 'vite')).toEqual({
      importers: [],
      suffixes: [
        { name: '@vitejs/plugin-react', version: '4.3.4' },
        { name: '@vitest/mocker', version: '3.0.5' },
      ],
      edges: [
        {
          parent: { name: '@vitejs/plugin-react', version: '4.3.4' },
          parentVersion: '4.3.4',
          version: '6.4.3',
          kind: 'dependencies',
          suffixed: true,
        },
        {
          parent: { name: '@vitest/mocker', version: '3.0.5' },
          parentVersion: '3.0.5',
          version: '6.4.3',
          kind: 'optionalDependencies',
          suffixed: true,
        },
      ],
    })
  })

  // `next` has `@babel/core` as a peer, and `@vitejs/plugin-react` declares it.
  it('marks an edge from a key without the peer suffix as not suffixed', () => {
    expect(scan(lockfile('pnpm-peer-only'), '@babel/core')).toEqual({
      importers: [],
      suffixes: [{ name: 'next', version: '15.1.6' }],
      edges: [
        {
          parent: { name: '@vitejs/plugin-react', version: '4.3.4' },
          parentVersion: '4.3.4',
          version: '7.29.7',
          kind: 'dependencies',
          suffixed: false,
        },
      ],
    })
  })

  it('finds the importer that declares a package, with its block', () => {
    expect(scan(lockfile('pnpm-peer-only'), 'next').importers).toEqual([
      { path: '.', kind: 'dependencies' },
    ])
    expect(scan(lockfile('pnpm-workspace-peer'), 'vite').importers).toEqual([
      { path: 'packages/app', kind: 'dependencies' },
    ])
  })

  it('reads a git parent by the name before its first @, with no version (#50)', () => {
    expect(scan(lockfile('pnpm-git-parent'), 'ms').edges).toEqual([
      {
        parent: { name: 'debug', version: null },
        parentVersion:
          'git+ssh://git@git.example.com/example/debug.git#da66c86c5fd71ef570f36b5b1edfa4472149f1bc',
        version: '2.1.2',
        kind: 'dependencies',
        suffixed: false,
      },
    ])
  })

  it('reads a URL edge as no registry version', () => {
    expect(scan(lockfile('pnpm-peer-variant'), 'minimist').edges).toEqual([
      {
        parent: { name: 'optimist', version: '0.5.2' },
        parentVersion: '0.5.2',
        version: null,
        kind: 'dependencies',
        suffixed: false,
      },
      {
        parent: { name: 'optimist', version: '0.6.1' },
        parentVersion: '0.6.1',
        version: '0.0.10',
        kind: 'dependencies',
        suffixed: false,
      },
    ])
  })

  it.each([
    ['a devDependencies block', '    devDependencies:\n      lodash: 1.0.0\n', ['devDependencies']],
    [
      'an optionalDependencies block',
      '    optionalDependencies:\n      lodash: 1.0.0\n',
      ['optionalDependencies'],
    ],
    ['a block that is not a dependency block', '    other:\n      lodash: 1.0.0\n', []],
    [
      'a block after the dependencies',
      '    dependencies:\n      a: 1\n    other:\n      lodash: 1.0.0\n',
      [],
    ],
    ['a line with no colon', '    dependencies:\n      lodash\n', []],
    ['a line under a key with no block', '      lodash: 1.0.0\n', []],
  ])('reads the importer rows of %s', (_shape, block, kinds) => {
    const text = `importers:\n\n  .:\n${block}\npackages:\n`
    expect(scan(text, 'lodash').importers.map(({ kind }) => kind)).toEqual(kinds)
  })

  it('reads no dependency line of an importer that has no block yet', () => {
    const text = 'importers:\n  a:\n    dependencies:\n      x: 1.0.0\n  b:\n      lodash: 1.0.0\n'
    expect(scan(text, 'lodash').importers).toEqual([])
  })

  it('reads no importer line that only starts with the name', () => {
    const text = 'importers:\n  .:\n    dependencies:\n      lodash-es: 1.0.0\n'
    expect(scan(text, 'lodash').importers).toEqual([])
  })

  it('reads no importer after the section that follows importers', () => {
    const text = 'importers:\n  .: {}\nother:\n  x:\n    dependencies:\n      lodash: 1.0.0\n'
    expect(scan(text, 'lodash')).toEqual({ importers: [], suffixes: [], edges: [] })
  })

  it('reads a peer suffix without an edge, and no suffix for a key with no name', () => {
    const text = "snapshots:\n\n  a@1.0.0(lodash@4.17.21): {}\n  '(lodash@4.17.21)': {}\n"
    expect(scan(text, 'lodash').suffixes).toEqual([{ name: 'a', version: '1.0.0' }])
  })

  // The suffix names the package, and an `@` follows the name.
  it('reads no peer suffix of a package whose name only starts with the name', () => {
    const text = 'snapshots:\n\n  a@1.0.0(lodash-es@4.17.21): {}\n'
    expect(scan(text, 'lodash').suffixes).toEqual([])
  })

  it('takes the version of an edge without quotes, space or peer suffix', () => {
    const text =
      "snapshots:\n\n  a@1.0.0:\n    dependencies:\n      'lodash':  '4.17.21(b@1.0.0)'  \n"
    expect(scan(text, 'lodash').edges.map(({ version }) => version)).toEqual(['4.17.21'])
  })
})

describe('copies', () => {
  it('gives one row for each edge, with the version each parent copy resolves', () => {
    expect(copies(lockfile('pnpm-peer-only'), 'vite')).toEqual([
      { parent: '@vitejs/plugin-react', parent_version: '4.3.4', range: null, resolved: '6.4.3' },
      { parent: '@vitest/mocker', parent_version: '3.0.5', range: null, resolved: '6.4.3' },
    ])
  })

  // `pnpm_copy_rows` keeps the text after the `@` of the key, and makes only
  // an empty text null. A `file:` copy has a version that is no registry version.
  it('keeps a parent version that is not a registry version, and no version as null', () => {
    const text = [
      "lockfileVersion: '9.0'",
      'snapshots:',
      '  local-lib@file:vendor/local-lib:',
      '    dependencies:',
      '      lodash: 3.10.1',
      '  local-lib@file:vendor/other-lib:',
      '    dependencies:',
      '      lodash: 3.10.1',
      '  bare:',
      '    dependencies:',
      '      lodash: 3.10.1',
    ].join('\n')
    expect(copies(text, 'lodash').map(({ parent_version }) => parent_version)).toEqual([
      'file:vendor/local-lib',
      'file:vendor/other-lib',
      null,
    ])
  })
})

describe('rootVersion', () => {
  it('reads the version that the root importer resolves, without the peer suffix', () => {
    expect(rootVersion(lockfile('pnpm-peer-only'), '@vitejs/plugin-react')).toBe('4.3.4')
    expect(rootVersion(lockfile('pnpm-peer-only'), 'next')).toBe('15.1.6')
  })

  it('reads nothing for a package that only a workspace importer declares', () => {
    expect(rootVersion(lockfile('pnpm-workspace-peer'), 'vite')).toBeNull()
  })

  it.each([
    [
      'a devDependencies block',
      '    devDependencies:\n      lodash:\n        version: 4.17.21\n',
      '4.17.21',
    ],
    [
      'a block that is not a dependency block',
      '    other:\n      lodash:\n        version: 4.17.21\n',
      null,
    ],
    [
      'a declaration of another package',
      '    dependencies:\n      a:\n        version: 1.0.0\n',
      null,
    ],
    [
      'a line of the declaration before its version',
      "    dependencies:\n      'lodash':\n        specifier: ^4\n        version: '4.17.21'\n",
      '4.17.21',
    ],
    // A new block ends the declaration before it, as `isdep = 0` in node.sh.
    [
      'a version line of the next block, after a declaration with no version',
      '    dependencies:\n      lodash:\n        specifier: ^4\n    devDependencies:\n        version: 3.0.0\n',
      null,
    ],
  ])('reads %s', (_shape, block, version) => {
    const text = `importers:\n\n  .:\n${block}\npackages:\n`
    expect(rootVersion(text, 'lodash')).toBe(version)
  })

  // `dependenciesMeta:` is not a dependency block, so it ends the one before it.
  it('reads no version from a block after the dependency blocks', () => {
    const text =
      'importers:\n  .:\n    dependencies:\n      a:\n        version: 1.0.0\n    dependenciesMeta:\n      lodash:\n        version: 2.0.0\n'
    expect(rootVersion(text, 'lodash')).toBeNull()
  })

  it('reads the version of the declaration of the package, not of the one before it', () => {
    const text =
      'importers:\n  .:\n    dependencies:\n      a:\n        version: 1.0.0\n      lodash:\n        version: 2.0.0(b@1.0.0)\n'
    expect(rootVersion(text, 'lodash')).toBe('2.0.0')
  })

  it('reads no version from an importer that is not the root', () => {
    const text =
      'importers:\n  packages/a:\n    dependencies:\n      lodash:\n        version: 1.0.0\n'
    expect(rootVersion(text, 'lodash')).toBeNull()
  })

  it('reads no version after the section that follows importers', () => {
    const text =
      'importers:\n  .: {}\nother:\n  .:\n    dependencies:\n      lodash:\n        version: 1.0.0\n'
    expect(rootVersion(text, 'lodash')).toBeNull()
  })
})

describe('isV9', () => {
  it.each([
    ['pnpm-v9', true],
    ['pnpm-v6', false],
  ])('reads the lockfile version of %s', (fixture, v9) => {
    expect(isV9(lockfile(fixture))).toBe(v9)
  })

  it.each([
    ['lockfileVersion: 9\n', true],
    ['lockfileVersion: "9.0"\n', true],
    ["lockfileVersion: '90.0'\n", false],
    ['lockfileVersion:\n', false],
    ["lockfileVersion: '6.0'\nlockfileVersion: '9.0'\n", false],
    ['settings: {}\n', false],
  ])('reads %j', (text, v9) => {
    expect(isV9(text)).toBe(v9)
  })
})
