// `entryOf` of the pnpm-workspace.yaml reader (#222, layer 2). The writer of
// `apply_constraint` reads each line of the block with it, as
// `workspace_overrides_write` reads each line with `parse_entry`. The reader
// itself is covered through `list_pins`. Each row is the awk answer of
// `parse_entry` on the same line.
import { describe, expect, it } from 'vitest'

import { entryOf } from '#gh-security/adapters/node/workspace-overrides.ts'

describe('entryOf', () => {
  it.each([
    ["  ws: '1'", { key: 'ws', value: '1' }],
    ['  "ws": ">=1"', { key: 'ws', value: '>=1' }],
    ["  'a''b': x", { key: "a'b", value: 'x' }],
    ['  # note: x', { key: '# note', value: 'x' }],
    ["  ws: '1'\r", { key: 'ws', value: '1' }],
  ])('reads %j', (line, expected) => {
    expect(entryOf(line)).toEqual(expected)
  })

  it.each([
    ['  # a comment', 'not a key: value entry'],
    ["  ws: '1' # keep", 'inline comment'],
    ['  ws:', 'no scalar value'],
    ["  'ws: 1", 'never closes'],
  ])('refuses %j', (line, words) => {
    expect(() => entryOf(line)).toThrow(words)
  })
})
