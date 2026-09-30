// Tests for `lib/dependencies.ts`. The function takes the table and the
// lookup as arguments, so each answer here comes from a fixed set, with no
// PATH and no process. Every expected value is written by hand.
import { describe, expect, it } from 'vitest'

import { absentDependencies, type Dependency } from '#lib/dependencies.ts'

const TABLE: readonly Dependency[] = [
  { tool: 'git', label: 'git' },
  { tool: 'gh', label: 'the GitHub CLI (gh)' },
  { tool: 'jq', label: 'jq' },
]

describe('absentDependencies', () => {
  it('answers an empty list when every tool is present', () => {
    expect(absentDependencies(TABLE, () => true)).toEqual([])
  })

  it('answers every row when no tool is present', () => {
    expect(absentDependencies(TABLE, () => false)).toEqual(TABLE)
  })

  it('answers the absent rows in table order and asks the lookup by tool name', () => {
    const asked: string[] = []
    const present = (tool: string): boolean => {
      asked.push(tool)
      return tool === 'gh'
    }
    expect(absentDependencies(TABLE, present)).toEqual([
      { tool: 'git', label: 'git' },
      { tool: 'jq', label: 'jq' },
    ])
    expect(asked).toEqual(['git', 'gh', 'jq'])
  })

  it('answers an empty list for an empty table', () => {
    expect(absentDependencies([], () => false)).toEqual([])
  })
})
