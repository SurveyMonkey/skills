// `compare_versions` and `range_facts` of the node adapter (#221). The seam
// is the `node` adapter. Each expected value is written by hand from the
// semver rules (semver.org) and from the usage lines of node.sh. The parity
// run holds the agreement with node.sh, and the semver unit tests hold the
// rules themselves.
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'

describe('compare_versions', () => {
  it.each([
    ['4.17.15', '4.18.2', -1, 'minor', 0],
    ['10.0.0', '9.0.0', 1, 'major', 1],
    ['1.0.0+build.1', '1.0.0', 0, 'none', 0],
  ])('answers %s against %s, and echoes both', (a, b, result, delta, distance) => {
    expect(node.compareVersions(a, b)).toEqual({
      outcome: 'ok',
      value: { a, b, result, delta, major_distance: distance },
    })
  })

  it.each([
    ['', '1.0.0'],
    ['1.0.0', ''],
  ])('refuses the empty argument in %j %j', (a, b) => {
    expect(node.compareVersions(a, b)).toEqual({
      outcome: 'failed',
      error: 'compare_versions requires two versions',
    })
  })

  it('fails for a version with nothing in it to compare', () => {
    expect(node.compareVersions('v', '1.0.0')).toEqual({
      outcome: 'failed',
      error: '"v" is not a version this adapter can read.',
    })
  })
})

describe('range_facts', () => {
  it('answers how far past the floor of a caret range a version sits', () => {
    expect(node.rangeFacts('^9.0.0', '10.1.0')).toEqual({
      outcome: 'ok',
      value: {
        range: '^9.0.0',
        version: '10.1.0',
        parseable: true,
        satisfied: false,
        pinned: false,
        floor_major: 9,
        majors_ahead: 1,
      },
    })
  })

  it('answers every key as null for a range it cannot read', () => {
    expect(node.rangeFacts('workspace:^', '1.0.0')).toEqual({
      outcome: 'ok',
      value: {
        range: 'workspace:^',
        version: '1.0.0',
        parseable: false,
        satisfied: null,
        pinned: null,
        floor_major: null,
        majors_ahead: null,
      },
    })
  })

  it.each([
    ['', '1.0.0'],
    ['^1.0.0', ''],
  ])('refuses the empty argument in %j %j', (range, version) => {
    expect(node.rangeFacts(range, version)).toEqual({
      outcome: 'failed',
      error: 'range_facts requires a range and a version',
    })
  })

  it('fails for a version with nothing in it to compare', () => {
    expect(node.rangeFacts('^1.0.0', 'v')).toEqual({
      outcome: 'failed',
      error: '"v" is not a version this adapter can read.',
    })
  })
})
