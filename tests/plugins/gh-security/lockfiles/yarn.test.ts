// The Yarn Berry `yarn.lock` reader (#220). Each expected value is written by
// hand from the fixture it names. The parity run holds the agreement with
// node.sh, so this file holds the behavior, and `parents`, which has no bash
// verb yet.
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
})
