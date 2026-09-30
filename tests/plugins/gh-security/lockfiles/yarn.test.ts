// The Yarn Berry `yarn.lock` reader (#220). Each expected value is written by
// hand from the fixture it names. The parity run holds the agreement with
// node.sh. This file holds the behavior. It also holds `parents`, which no
// bash verb returns.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { LockfileError } from '#gh-security/lockfiles/shared.ts'
import { parents, resolutionMap, resolvedVersions } from '#gh-security/lockfiles/yarn.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'

const lockfile = (fixture: string): string =>
  readFileSync(join(FIXTURES_ROOT, fixture, 'yarn.lock'), 'utf8')

describe('resolvedVersions', () => {
  it('finds an alias copy by the package it aliases', () => {
    expect(resolvedVersions(lockfile('yarn-alias'), 'lodash')).toEqual({
      coverage: { entries: 3, expected: 3, read: 3 },
      copies: [{ version: '4.17.21', path: 'aliased@npm:lodash@4.17.21' }],
    })
  })

  it('finds an alias copy by its alias key', () => {
    expect(resolvedVersions(lockfile('yarn-alias'), 'aliased').copies).toEqual([
      { version: '4.17.21', path: 'aliased@npm:lodash@4.17.21' },
    ])
  })

  it('finds a scoped alias target', () => {
    expect(resolvedVersions(lockfile('yarn-alias'), '@scope/real').copies).toEqual([
      { version: '2.3.4', path: 'scoped-alias@npm:@scope/real@2.3.4' },
    ])
  })

  it('reads the version of a patched copy from the locator it wraps', () => {
    expect(resolvedVersions(lockfile('yarn-patch'), 'lodash').copies).toEqual([
      {
        version: '4.17.21',
        path: 'lodash@patch:lodash@npm%3A4.17.21#~/.yarn/patches/lodash-npm-4.17.21-abc.patch::version=4.17.21&hash=abc123',
      },
    ])
  })

  it('leaves binding parameters out of the version', () => {
    expect(resolvedVersions(lockfile('yarn-binding-params'), 'privreg').copies).toEqual([
      {
        version: '2.5.0',
        path: 'privreg@npm:2.5.0::__archiveUrl=https%3A%2F%2Freg.example.com%2Fprivreg%2F-%2Fprivreg-2.5.0.tgz',
      },
    ])
  })

  it('answers no copies for a portal target', () => {
    expect(resolvedVersions(lockfile('yarn-patch'), 'local-tool').copies).toEqual([])
  })

  it('answers no copies for a package the lockfile does not hold', () => {
    expect(resolvedVersions(lockfile('yarn-patch'), 'left-pad').copies).toEqual([])
  })
})

describe('resolutionMap', () => {
  it('keys an alias copy under the package it aliases', () => {
    expect(resolutionMap(lockfile('yarn-alias'))).toEqual({
      coverage: { entries: 3, expected: 3, read: 3 },
      resolutions: { lodash: ['4.17.21'], '@scope/real': ['2.3.4'] },
    })
  })

  it('keeps patched copies and leaves workspace, portal and exec targets out', () => {
    expect(resolutionMap(lockfile('yarn-patch'))).toEqual({
      coverage: { entries: 6, expected: 6, read: 6 },
      resolutions: { express: ['4.21.2'], lodash: ['4.17.21'], typescript: ['5.4.5'] },
    })
  })

  it('unwraps a patch of a patch, one level of encoding at a time', () => {
    expect(resolutionMap(lockfile('yarn-patch-nested')).resolutions).toEqual({
      keep: ['1.0.0'],
      typescript: ['5.1.6'],
    })
  })

  it('answers an empty map for a lockfile of local targets only', () => {
    expect(resolutionMap(lockfile('yarn-all-local'))).toEqual({
      coverage: { entries: 3, expected: 3, read: 3 },
      resolutions: {},
    })
  })

  it('counts a version that is not full semver as unread, and leaves it out', () => {
    expect(resolutionMap(lockfile('yarn-partial-read'))).toEqual({
      coverage: { entries: 5, expected: 5, read: 4 },
      resolutions: { express: ['4.18.2'], lodash: ['4.17.21'], 'sha.js': ['2.4.11'] },
    })
  })
})

describe('refusals', () => {
  it.each([
    ['resolvedVersions', (text: string) => resolvedVersions(text, 'lodash')],
    ['resolutionMap', (text: string) => resolutionMap(text)],
  ])('%s refuses a lockfile with no entries', (_name, read) => {
    expect(() => read(lockfile('empty-yarn'))).toThrow(
      new LockfileError(
        "Parsed 0 entries from the lockfile for pm 'yarn'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result.",
      ),
    )
  })

  it.each([
    ['resolvedVersions', (text: string) => resolvedVersions(text, 'lodash')],
    ['resolutionMap', (text: string) => resolutionMap(text)],
  ])('%s refuses a lockfile it reads less than half of', (_name, read) => {
    expect(() => read(lockfile('yarn-unknown-protocol'))).toThrow(
      new LockfileError(
        "Read 1 of 4 lockfile entries for pm 'yarn'. The parser understands too little of this lockfile to describe the tree; refusing to report a mostly-unparsed lockfile as a clean result.",
      ),
    )
  })
})

describe('parents', () => {
  it('names a parent that declares the package through an alias', () => {
    expect(parents(lockfile('yarn-berry-alias-parent'), 'lodash')).toEqual([
      { name: 'express', version: '4.18.2' },
    ])
  })

  it('names the parent of an alias key', () => {
    expect(parents(lockfile('yarn-berry-alias-parent'), 'lodash-alias')).toEqual([
      { name: 'express', version: '4.18.2' },
    ])
  })

  it('names an optional parent and a peer parent', () => {
    expect(parents(lockfile('yarn-berry-peer-parent'), 'sha.js')).toEqual([
      { name: 'express', version: '4.18.2' },
      { name: 'serve-static', version: '1.15.0' },
    ])
  })

  it('names no parent for a package that no entry declares', () => {
    expect(parents(lockfile('yarn-berry-peer-parent'), 'lodash')).toEqual([])
  })

  it('never names a workspace', () => {
    expect(parents(lockfile('yarn-alias'), 'lodash')).toEqual([])
  })

  const entry = (name: string, declarations: string): string =>
    `"${name}@npm:1.0.0":\n  version: 1.0.0\n  resolution: "${name}@npm:1.0.0"\n${declarations}\n`

  it('reads a quoted scoped declaration', () => {
    const text = entry('a', '  dependencies:\n    "@scope/x": "npm:^1.0.0"\n')
    expect(parents(text, '@scope/x')).toEqual([{ name: 'a', version: '1.0.0' }])
  })

  it('reads no declaration from a block that follows the declarations', () => {
    const text = entry('a', '  dependencies:\n    y: "npm:^1"\n  bin:\n    x: ./x.js\n')
    expect(parents(text, 'x')).toEqual([])
  })

  it('reads no declaration from a line without a colon', () => {
    const text = entry('a', '  dependencies:\n    x\n')
    expect(parents(text, 'x')).toEqual([])
  })

  it('names no parent for an empty locator', () => {
    const text = '"a@npm:1.0.0":\n  resolution: ""\n  dependencies:\n    x: "npm:^1"\n'
    expect(parents(text, 'x')).toEqual([])
  })

  it('reads no declaration from peerDependenciesMeta', () => {
    const text = entry(
      'a',
      '  peerDependencies:\n    y: "*"\n  peerDependenciesMeta:\n    x:\n      optional: true\n',
    )
    expect(parents(text, 'x')).toEqual([])
  })

  it('reads no declaration from an entry that has no resolution', () => {
    const text = `${entry('a', '  dependencies:\n    y: "npm:^1"\n')}"b@npm:^2":\n  dependencies:\n    x: "npm:^1"\n`
    expect(parents(text, 'x')).toEqual([])
  })
})

describe('locator readings', () => {
  const entry = (locator: string): string =>
    `"${locator}":\n  version: 1.0.0\n  resolution: "${locator}"\n`
  const ok = entry('ok@npm:1.0.0')

  it.each([
    'link:../a',
    'file:../a',
    'git://x',
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
    expect(resolutionMap(`${entry(`pkg@${target}`)}\n${ok}`)).toEqual({
      coverage: { entries: 2, expected: 2, read: 2 },
      resolutions: { ok: ['1.0.0'] },
    })
  })

  it.each(['1.0.0-rc.1', '1.0.0+build.5', '1.0.0-rc.1+build.5'])('reads the version %s', (v) => {
    expect(resolutionMap(entry(`pkg@npm:${v}`)).resolutions).toEqual({ pkg: [v] })
  })

  it.each([
    ['a lowercase percent code', 'pkg@patch:pkg@npm%3a1.0.0#x', { pkg: ['1.0.0'] }],
    ['an encoded percent sign', 'pkg@npm%253A1.0.0', { ok: ['1.0.0'] }],
    ['a protocol with a prefix', 'pkg@xfile:y', { ok: ['1.0.0'] }],
  ])('reads %s', (_name, locator, resolutions) => {
    expect(resolutionMap(`${entry(locator)}\n${ok}`).resolutions).toEqual({
      ok: ['1.0.0'],
      ...resolutions,
    })
  })

  it('counts an empty locator as an entry that it cannot read', () => {
    const text = `${ok}\n"a@npm:1.0.0":\n  version: 1.0.0\n  resolution: ""\n`
    expect(resolutionMap(text).coverage).toEqual({ entries: 2, expected: 2, read: 1 })
  })

  it('allows a lockfile it reads exactly half of', () => {
    const text = `${entry('a@npm:1.0.0')}\n${entry('b@npm:2.0.0')}\n${entry('c@npm:x')}\n${entry('d@npm:y')}`
    expect(resolutionMap(text).coverage).toEqual({ entries: 4, expected: 4, read: 2 })
  })
})
