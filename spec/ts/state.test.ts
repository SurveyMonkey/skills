// The typed state file, replacing `state_get`, `state_ok`, `state_get_opt`,
// `state_json`, `state_set`, `state_set_str` and `load_state`.
//
// The filesystem is never mocked (the testing skill's mocking.md), so every
// example writes a real state file into a real scratch directory, including
// the shapes that are supposed to fail: a zero-byte file a crashed `setup`
// left behind, a truncated one, and a path that is not a file at all.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { unwrap } from '../../plugins/gh-security/src/lib/envelope.ts'
import {
  createState,
  loadState,
  readOptionalString,
  readOptionalValue,
  readString,
  readValue,
  statePath,
  writeKey,
} from '../../plugins/gh-security/src/lib/state.ts'

const scratches: string[] = []
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gh-security-state-')))
  scratches.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true })
})

describe('loadState', () => {
  it('loads a state file that is a JSON object', () => {
    const work = scratch()
    writeFileSync(join(work, 'state.json'), '{"package":"lodash","major_line":"4"}')
    const state = unwrap(loadState(work))
    expect(state.path).toBe(join(work, 'state.json'))
    expect(state.data).toEqual({ package: 'lodash', major_line: '4' })
  })

  it.each([
    ['a file that is not there', undefined],
    ['a zero-byte file a crashed setup left behind', ''],
    ['a truncated file', '{"package":"loda'],
    ['a JSON array', '[]'],
    ['a JSON null', 'null'],
    ['a bare string', '"lodash"'],
  ])('refuses %s', (_shape, contents) => {
    const work = scratch()
    if (contents !== undefined) writeFileSync(join(work, 'state.json'), contents)
    const envelope = loadState(work)
    expect(envelope.outcome).toBe('error')
    // The failure names the file, because the answer to every one of these
    // is to inspect that path by hand rather than to rerun over it.
    expect(envelope.outcome === 'error' && envelope.error).toContain(join(work, 'state.json'))
  })

  it('refuses a state path that is a directory', () => {
    const work = scratch()
    mkdirSync(join(work, 'state.json'))
    expect(loadState(work).outcome).toBe('error')
  })

  // The OS error is quoted, not swallowed. "Run 'setup' first" is the right
  // remedy for a file that was never written and the wrong one for a file
  // that is there and unreadable, so the reason has to travel with the
  // message: a reader told only to rerun setup never learns which it was.
  it.each([
    ['a file that is not there', undefined, 'ENOENT'],
    ['a state path that is a directory', 'directory', 'EISDIR'],
  ])('names the underlying error for %s', (_shape, shape, code) => {
    const work = scratch()
    if (shape === 'directory') mkdirSync(join(work, 'state.json'))
    const envelope = loadState(work)
    expect(envelope.outcome === 'error' && envelope.error).toContain(code)
  })
})

describe('createState and writeKey', () => {
  it('writes a state file a later load reads back', () => {
    const work = scratch()
    const created = unwrap(createState(work, { package: 'lodash', major_line: '4' }))
    expect(created.path).toBe(statePath(work))
    expect(unwrap(loadState(work)).data).toEqual({ package: 'lodash', major_line: '4' })
  })

  // One key per call: a step writes what it learned and nothing else, so a
  // key an earlier step never wrote stays absent rather than arriving as a
  // stale value from a rewritten whole.
  it('sets one key, leaving every other key as it was', () => {
    const work = scratch()
    const state = unwrap(createState(work, { package: 'lodash', major_line: '4' }))
    const updated = unwrap(writeKey(state, 'relationship', 'transitive'))
    expect(updated.data).toEqual({
      package: 'lodash',
      major_line: '4',
      relationship: 'transitive',
    })
    expect(unwrap(loadState(work)).data).toEqual(updated.data)
  })

  it('writes a nested value whole', () => {
    const work = scratch()
    const state = unwrap(createState(work, {}))
    const updated = unwrap(writeKey(state, 'group', { alerts: [{ number: 1 }] }))
    expect(readOptionalValue(updated, 'group.alerts')).toEqual([{ number: 1 }])
  })

  it('is a failure when the state file cannot be written', () => {
    const envelope = createState('/gh-security-no-such-directory', { package: 'lodash' })
    expect(envelope.outcome).toBe('error')
    expect(envelope.outcome === 'error' && envelope.error).toContain('cannot write the state file')
  })
})

describe('readValue', () => {
  const loaded = (data: object) => {
    const work = scratch()
    writeFileSync(join(work, 'state.json'), JSON.stringify(data))
    return unwrap(loadState(work))
  }

  it('reads a top-level key and a dotted path', () => {
    const state = loaded({ package: 'lodash', group: { highest_fixed_version: '4.17.21' } })
    expect(unwrap(readValue(state, 'package'))).toBe('lodash')
    expect(unwrap(readValue(state, 'group.highest_fixed_version'))).toBe('4.17.21')
  })

  // Absence is not a value. Returning null at success is what let a run
  // interrupted before it wrote its apply result report itself ready for a
  // pull request naming no edit at all.
  it.each([
    ['an absent key', { package: 'lodash' }, 'apply_result'],
    ['an explicit null', { apply_result: null }, 'apply_result'],
    ['a path through a missing parent', { package: 'lodash' }, 'group.alerts'],
    ['a path through a non-object', { group: 'none' }, 'group.alerts'],
  ])('is a failure for %s', (_shape, data, path) => {
    const envelope = readValue(loaded(data), path)
    expect(envelope.outcome).toBe('error')
    expect(envelope.outcome === 'error' && envelope.error).toContain(`'${path}'`)
  })

  // A falsy value is a value. `false` and `0` are answers a step legitimately
  // writes, and reading them as absence is the same collapse by another route.
  it.each([
    ['drift_commit', false],
    ['fix_installs', 0],
  ] as const)('reads %s carrying %j as a value', (key, value) => {
    expect(unwrap(readValue(loaded({ [key]: value }), key))).toBe(value)
  })
})

describe('readString', () => {
  const loaded = (data: object) => {
    const work = scratch()
    writeFileSync(join(work, 'state.json'), JSON.stringify(data))
    return unwrap(loadState(work))
  }

  it('reads a non-empty string', () => {
    expect(unwrap(readString(loaded({ worktree: '/w/fix' }), 'worktree'))).toBe('/w/fix')
  })

  // The empty string is never a usable path: `git -C ""` operates on the
  // current directory, which is how a repo-targeted write lands in the
  // user's own checkout (#18). Every one of these keys is a path or a ref.
  it.each([
    ['the empty string', ''],
    ['a number', 4],
    ['a boolean', true],
    ['an object', { path: '/w/fix' }],
  ])('refuses %s', (_shape, value) => {
    const envelope = readString(loaded({ worktree: value }), 'worktree')
    expect(envelope.outcome).toBe('error')
  })

  it('is a failure for an absent key', () => {
    expect(readString(loaded({}), 'worktree').outcome).toBe('error')
  })
})

describe('the optional readers', () => {
  const loaded = (data: object) => {
    const work = scratch()
    writeFileSync(join(work, 'state.json'), JSON.stringify(data))
    return unwrap(loadState(work))
  }

  // `env_prefix` is the key this exists for: absent means bare, which is the
  // ordinary single-login case and not an error.
  it.each([
    ['an absent key', {}, null],
    ['an explicit null', { env_prefix: null }, null],
    ['the empty string', { env_prefix: '' }, null],
    ['a non-string', { env_prefix: 7 }, null],
    ['a prefix', { env_prefix: 'run-in exec /src/app' }, 'run-in exec /src/app'],
  ])('readOptionalString reads %s as %j', (_shape, data, expected) => {
    expect(readOptionalString(loaded(data), 'env_prefix')).toBe(expected)
  })

  it.each([
    ['an absent key', {}, null],
    ['an explicit null', { observations_first: null }, null],
    ['a value', { observations_first: [{ kind: 'peer' }] }, [{ kind: 'peer' }]],
  ])('readOptionalValue reads %s as %j', (_shape, data, expected) => {
    expect(readOptionalValue(loaded(data), 'observations_first')).toEqual(expected)
  })
})
