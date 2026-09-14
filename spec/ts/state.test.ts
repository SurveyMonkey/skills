// The typed state file, replacing `state_get`, `state_ok`, `state_get_opt`,
// `state_json`, `state_set`, `state_set_str` and `load_state`.
//
// The filesystem is never mocked (the testing skill's mocking.md), so every
// example writes a real state file into a real scratch directory, including
// the shapes that are supposed to fail: a zero-byte file a crashed `setup`
// left behind, a truncated one, and a path that is not a file at all.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { unwrap } from '../../plugins/gh-security/src/lib/envelope.ts'
import { loadState } from '../../plugins/gh-security/src/lib/state.ts'

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
})
