// The adapter registry. The expected values are written by hand from the
// header of `select-adapter.sh`. The script is compared in
// `parity-select-adapter.test.ts`.
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'

describe('the supported ecosystem', () => {
  it('routes npm to the node adapter itself', () => {
    const route = selectAdapter('npm')
    expect(route).toEqual({
      supported: true,
      ecosystem: 'npm',
      name: 'node',
      adapter: node,
      manifest: null,
    })
    expect(route.adapter).toBe(node)
  })

  it('carries the manifest of the alert through', () => {
    expect(selectAdapter('npm', 'packages/web/package.json').manifest).toBe(
      'packages/web/package.json',
    )
  })
})

describe('an ecosystem with no adapter', () => {
  // GitHub's enum, minus npm.
  it.each([
    'rubygems',
    'pip',
    'maven',
    'nuget',
    'composer',
    'go',
    'rust',
    'erlang',
    'actions',
    'pub',
    'swift',
    'other',
  ])('answers supported false for %s, and not an error', (ecosystem) => {
    expect(selectAdapter(ecosystem)).toEqual({
      supported: false,
      ecosystem,
      name: null,
      adapter: null,
      manifest: null,
      reason: 'ecosystem not supported yet',
    })
  })

  it('carries the manifest of the alert through', () => {
    expect(selectAdapter('pip', 'requirements.txt').manifest).toBe('requirements.txt')
  })

  // Mutant: a plain object for the table. Each name is a member of
  // `Object.prototype`, and a lookup by it would find a function.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'does not find the prototype member %s',
    (ecosystem) => {
      expect(selectAdapter(ecosystem).supported).toBe(false)
    },
  )

  it.each(['NPM', 'Npm', ' npm', 'npm ', ''])('matches the name exactly: %j', (ecosystem) => {
    expect(selectAdapter(ecosystem).supported).toBe(false)
  })
})
