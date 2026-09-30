// The pnpm `pnpm-lock.yaml` reader (#220). Each expected value is written by
// hand from the fixture it names. The parity run holds the agreement with
// node.sh, so this file holds the behavior, and `parents`, which has no bash
// verb yet.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parents, resolutionMap, resolvedVersions } from '#gh-security/lockfiles/pnpm.ts'
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

  // A pin, not a fix: node.sh keeps the leading `/` of a lockfileVersion 6
  // key, and the parity run holds the module to node.sh.
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
})
