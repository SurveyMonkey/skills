// The reader of package-lock.json for `apply_constraint` (#222, layer 2).
// Each row is the jq answer of `NPM_PATH_JQ`, `NPM_COPY_ROWS_JQ` or
// `npm_declaration_rows` of node.sh on the same input. The documents here
// are small, to reach the rules for values of each type.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import {
  candidatesOf,
  copyRows,
  declarationRows,
  type NpmLock,
  readNpmLock,
} from '#gh-security/adapters/node/npm-lock.ts'

/** The lockfile of a scratch directory that holds `text`. */
const lockOf = (text: string): NpmLock => {
  const dir = mkdtempSync(join(tmpdir(), 'npm-lock-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package-lock.json'), text)
  return readNpmLock(dir)
}

describe('candidatesOf, the walk up node_modules', () => {
  it.each([
    ['', ['node_modules/x']],
    ['packages/app', ['packages/app/node_modules/x', 'node_modules/x']],
    [
      'node_modules/a/node_modules/@s/b',
      [
        'node_modules/a/node_modules/@s/b/node_modules/x',
        'node_modules/a/node_modules/x',
        'node_modules/x',
      ],
    ],
    ['a/node_modules/', ['a/node_modules//node_modules/x']],
    [
      'packages/app/node_modules/x',
      [
        'packages/app/node_modules/x/node_modules/x',
        'packages/app/node_modules/x',
        'node_modules/x',
      ],
    ],
  ])('walks up from %j', (path, candidates) => {
    expect(candidatesOf(path, 'x')).toEqual(candidates)
  })
})

describe('readNpmLock', () => {
  it('reads a file of only white space as a lockfile with no entries', () => {
    expect(lockOf('\n').entries).toEqual([])
  })

  it('reads an empty packages list as no entries, and stops on a packages text', () => {
    expect(lockOf('{"packages":[]}').entries).toEqual([])
    expect(() => lockOf('{"packages":"x"}')).toThrow()
  })
})

const LOCK = JSON.stringify({
  packages: {
    '': { dependencies: { a: '^1.0.0', b: 5 } },
    'node_modules/a': {
      version: '1.0.0',
      dependencies: { ghost: '^1.0.0', 'tab\tkey': 'x\\y', alias: 'npm:a@^1' },
    },
  },
})

describe('copyRows and declarationRows', () => {
  it('reads the root as __root__, skips a value that is not a text, and resolves nothing to null', () => {
    const lock = lockOf(LOCK)
    expect([...copyRows(lock, 'a'), ...copyRows(lock, 'ghost')]).toEqual([
      { parent: '__root__', parent_version: null, resolved: '1.0.0' },
      { parent: 'a', parent_version: '1.0.0', resolved: null },
      { parent: 'a', parent_version: '1.0.0', resolved: null },
    ])
  })

  // `$pkgs[$c].version // empty` goes on to the next candidate.
  it('reads the version of the first candidate that has one', () => {
    const lock = lockOf(
      JSON.stringify({
        packages: {
          'node_modules/a': { dependencies: { b: '^1' } },
          'node_modules/a/node_modules/b': {},
          'node_modules/b': { version: '2.0.0' },
        },
      }),
    )
    expect(copyRows(lock, 'b')).toEqual([{ parent: 'a', parent_version: null, resolved: '2.0.0' }])
  })

  it('writes each row in the text of @tsv', () => {
    expect(declarationRows(lockOf(LOCK))).toEqual([
      { parent: '__root__', key: 'a', value: '^1.0.0' },
      { parent: 'a', key: 'ghost', value: '^1.0.0' },
      { parent: 'a', key: 'tab\\tkey', value: 'x\\\\y' },
      { parent: 'a', key: 'alias', value: 'npm:a@^1' },
    ])
  })
})
