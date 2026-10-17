// The removal of one pin from the override file (`audit-pins-removal.ts`):
// the one place where the pin audit edits a user's manifest. The seam is the
// two exported functions, over real files in a scratch directory. The
// expected files are written by hand from the rules in the header of that
// file and in `audit-driver.md`. `parity-audit-pins.test.ts` runs both
// deleters against `audit-pins-driver.sh` through `test-pin`.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  removeManifestPaths,
  removeWorkspaceKey,
} from '#gh-security/subcommands/audit-pins-removal.ts'
import { createSandbox } from '#harness/sandbox.ts'

/** A scratch directory that holds one file. */
const dirWith = (name: string, text: string): string => {
  const dir = createSandbox().join('tree')
  mkdirSync(dir)
  writeFileSync(join(dir, name), text)
  return dir
}

const manifest = (dir: string): unknown =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

describe('removeManifestPaths', () => {
  it('removes exactly that entry and nothing else, as jq writes the file', () => {
    const dir = dirWith(
      'package.json',
      '{"name":"app","overrides":{"lodash":"^4.17.21","glob":{"minimatch":"^9.0.0"}}}\n',
    )
    expect(removeManifestPaths(dir, ['overrides'], [['lodash']])).toBeNull()
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(
      '{\n  "name": "app",\n  "overrides": {\n    "glob": {\n      "minimatch": "^9.0.0"\n    }\n  }\n}\n',
    )
  })

  it('takes a nested parent that the removal leaves empty', () => {
    const dir = dirWith(
      'package.json',
      '{"overrides":{"lodash":"^4.17.21","glob":{"minimatch":"^9.0.0"}}}\n',
    )
    expect(removeManifestPaths(dir, ['overrides'], [['glob', 'minimatch']])).toBeNull()
    expect(manifest(dir)).toEqual({ overrides: { lodash: '^4.17.21' } })
  })

  it('keeps a nested parent that still holds an entry', () => {
    const dir = dirWith(
      'package.json',
      '{"overrides":{"rimraf":{".":"^5.0.0","glob":"^10.3.0"}}}\n',
    )
    expect(removeManifestPaths(dir, ['overrides'], [['rimraf', 'glob']])).toBeNull()
    expect(manifest(dir)).toEqual({ overrides: { rimraf: { '.': '^5.0.0' } } })
  })

  it('removes the whole override block when the entry was the last one', () => {
    const dir = dirWith('package.json', '{"name":"app","resolutions":{"lodash":"^4.17.21"}}\n')
    expect(removeManifestPaths(dir, ['resolutions'], [['lodash']])).toBeNull()
    expect(manifest(dir)).toEqual({ name: 'app' })
  })

  it('takes the override block but never the key above it', () => {
    const dir = dirWith(
      'package.json',
      '{"pnpm":{"overrides":{"lodash":"^4.17.21"},"peerDependencyRules":{"allowAny":["react"]}}}\n',
    )
    expect(removeManifestPaths(dir, ['pnpm', 'overrides'], [['lodash']])).toBeNull()
    expect(manifest(dir)).toEqual({ pnpm: { peerDependencyRules: { allowAny: ['react'] } } })
  })

  it('leaves an emptied pnpm key rather than widening the removal to it', () => {
    const dir = dirWith(
      'package.json',
      '{"name":"app","pnpm":{"overrides":{"lodash":"^4.17.21"}}}\n',
    )
    expect(removeManifestPaths(dir, ['pnpm', 'overrides'], [['lodash']])).toBeNull()
    expect(manifest(dir)).toEqual({ name: 'app', pnpm: {} })
  })

  it('removes several paths in one call', () => {
    const dir = dirWith('package.json', '{"overrides":{"a":"1","b":"2","c":"3"}}\n')
    expect(removeManifestPaths(dir, ['overrides'], [['a'], ['c']])).toBeNull()
    expect(manifest(dir)).toEqual({ overrides: { b: '2' } })
  })

  it.each([
    ['a key that is not there', '{"overrides":{"a":"1"}}', ['b', 'c']],
    ['a parent that is not there', '{"overrides":{"a":"1"}}', ['x', 'y', 'z']],
    ['a null on the way', '{"overrides":{"a":null}}', ['a', 'b']],
  ])('changes nothing but the format for %s, as jq does', (_name, text, path) => {
    const dir = dirWith('package.json', `${text}\n`)
    expect(removeManifestPaths(dir, ['overrides'], [path])).toBeNull()
    expect(manifest(dir)).toEqual(JSON.parse(text))
  })

  it('keeps a manifest of only white space empty, as jq writes nothing for it', () => {
    const dir = dirWith('package.json', '  \n')
    expect(removeManifestPaths(dir, ['overrides'], [['a']])).toBeNull()
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('')
  })

  it('answers the error for a manifest that does not parse, and keeps the file', () => {
    const text = '{"overrides":{"lodash":"^4.17.21",}\n'
    const dir = dirWith('package.json', text)
    expect(removeManifestPaths(dir, ['overrides'], [['lodash']])).toMatch(/JSON/)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(text)
  })

  it('answers the error for a value on the way that is not an object', () => {
    const dir = dirWith('package.json', '{"overrides":{"glob":"^9.0.0"}}\n')
    expect(removeManifestPaths(dir, ['overrides'], [['glob', 'minimatch']])).toBe(
      'Cannot delete field "minimatch" of a value that is not an object',
    )
  })

  it('answers the error for an address that is not a list of keys', () => {
    const dir = dirWith('package.json', '{"overrides":{"a":"1"}}\n')
    expect(removeManifestPaths(dir, [1], [['a']])).toBe(
      "the override block's address [1] is not a list of keys",
    )
  })

  it('answers the error for a file that is not there', () => {
    const dir = createSandbox().join('empty')
    mkdirSync(dir)
    expect(removeManifestPaths(dir, ['overrides'], [['a']])).toMatch(/ENOENT/)
  })

  it('answers the error for a file that cannot be replaced', () => {
    const dir = dirWith('package.json', '{"overrides":{"a":"1"}}\n')
    chmodSync(dir, 0o555)
    try {
      expect(removeManifestPaths(dir, ['overrides'], [['a']])).toBe(
        `cannot replace ${join(dir, 'package.json')}`,
      )
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})

const WORKSPACE = `packages:
  - packages/*

overrides:
  undici: '>=6.23.0'
  # a comment in the block

  "form-data": '>=4.0.4'
  'it''s': '1.0.0'
catalog:
  react: ^18
`

const workspace = (dir: string): string => readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')

describe('removeWorkspaceKey', () => {
  it.each([
    ['a plain key', 'undici', "  undici: '>=6.23.0'\n"],
    ['a double-quoted key', 'form-data', `  "form-data": '>=4.0.4'\n`],
    ['a single-quoted key with a doubled quote', "it's", "  'it''s': '1.0.0'\n"],
  ])('removes %s, and leaves each other line byte for byte', (_name, key, line) => {
    const dir = dirWith('pnpm-workspace.yaml', WORKSPACE)
    expect(removeWorkspaceKey(dir, key)).toBe(0)
    expect(workspace(dir)).toBe(WORKSPACE.replace(line, ''))
  })

  it('takes the overrides: line with the last entry', () => {
    const dir = dirWith(
      'pnpm-workspace.yaml',
      "packages:\n  - .\noverrides:\n  undici: '>=6.23.0'\n",
    )
    expect(removeWorkspaceKey(dir, 'undici')).toBe(0)
    expect(workspace(dir)).toBe('packages:\n  - .\n')
  })

  it('writes a newline after the last line, as awk does', () => {
    const dir = dirWith('pnpm-workspace.yaml', "overrides:\n  a: '1'\n  b: '2'")
    expect(removeWorkspaceKey(dir, 'a')).toBe(0)
    expect(workspace(dir)).toBe("overrides:\n  b: '2'\n")
  })

  it('removes the key in each overrides: block, and counts the entries of both', () => {
    const dir = dirWith('pnpm-workspace.yaml', "overrides:\n  a: '1'\nx: 1\noverrides:\n  a: '2'\n")
    expect(removeWorkspaceKey(dir, 'a')).toBe(0)
    expect(workspace(dir)).toBe('overrides:\nx: 1\noverrides:\n')
  })

  it.each([
    ['a block with no such entry', WORKSPACE, 'ws'],
    ['a file with no block', 'packages:\n  - .\n', 'undici'],
    ['an empty file', '', 'undici'],
  ])('answers 2 for %s, and changes nothing', (_name, text, key) => {
    const dir = dirWith('pnpm-workspace.yaml', text)
    expect(removeWorkspaceKey(dir, key)).toBe(2)
    expect(workspace(dir)).toBe(text)
  })

  it('answers 2 for a file that cannot be read, as awk does', () => {
    const dir = createSandbox().join('empty')
    mkdirSync(dir)
    expect(removeWorkspaceKey(dir, 'undici')).toBe(2)
  })

  it.each([
    ['a line that is not a key: value entry', 'overrides:\n  undici\n  ws: 1\n'],
    ['a quoted key that never closes', 'overrides:\n  "undici: 1\n'],
    ['an entry whose key is empty', 'overrides:\n  : 1\n'],
  ])('answers 1 for %s, and changes nothing', (_name, text) => {
    const dir = dirWith('pnpm-workspace.yaml', text)
    expect(removeWorkspaceKey(dir, 'ws')).toBe(1)
    expect(workspace(dir)).toBe(text)
  })

  it('answers 1 for a file that cannot be replaced', () => {
    const dir = dirWith('pnpm-workspace.yaml', "overrides:\n  a: '1'\n  b: '2'\n")
    chmodSync(dir, 0o555)
    try {
      expect(removeWorkspaceKey(dir, 'a')).toBe(1)
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})
