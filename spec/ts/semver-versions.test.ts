// Version comparison, the port of `SEMVER_JQ`'s version half (node.sh lines
// 83-289) onto TypeScript (RFC 002, ADR 012). The seam is the exported
// function: every row below calls it directly, the way the future
// `compare_versions` verb (#221) will.
//
// Parity against `node.sh` is not asserted here. The parity runner lands with
// the test harness in #219, and this issue's plan comment carries that
// criterion there (#218 ruling B). What is asserted here is the behavior the
// existing tables already fix, copied row for row.
import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  coreAt,
  majorDistance,
  parseVersion,
  SemverParseError,
  semverDelta,
  semverMax,
  versionFacts,
} from '../../plugins/gh-security/src/semver/versions.ts'

describe('compareVersions', () => {
  // Every row of the `ordering` block in spec/node_semver_spec.sh, whose
  // expected column is the precedence chain published at semver.org section
  // 11. The chain is the reason that block exists: jq's `tonumber?` emits
  // *empty* rather than null for a non-numeric identifier, which dropped the
  // identifier from the comparison and reversed rc.1 against beta.11.
  it.each([
    ['4.17.15', '4.18.2', -1], // numeric core
    ['9.0.0', '10.0.0', -1], // 9 below 10, not lexically above
    ['1.2.3', '1.10.0', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.0.0', '1.0.0', 0],
    ['1.0.0+build.1', '1.0.0', 0], // build metadata ignored
    ['v2.0.0', '2.0.0', 0], // leading v tolerated
    ['1.0.0-alpha', '1.0.0', -1], // prerelease below its release
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], // prefix below longer prerelease
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1], // numeric ident below alphanumeric
    ['1.0.0-alpha.beta', '1.0.0-beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1], // identifiers compare numerically
    ['1.0.0-beta.11', '1.0.0-rc.1', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1], // rc outranks beta
  ])('orders %s against %s as %i', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected)
  })
})

// Rows the shellspec block does not carry, each reached the same two ways the
// block's own last row is: by mirroring a chain pair, because precedence is
// antisymmetric (semver.org section 11, which the `rc.1` row already relies
// on), or by applying the rule that a core component nobody wrote reads as 0
// (`$c[i] // 0` at every site in the heredoc that reads one).
describe('compareVersions, spellings the ordering chain does not spell out', () => {
  it.each([
    ['1.0.0-alpha', '1.0.0-alpha', 0], // identical prereleases have equal precedence
    ['1.0.0-alpha.1', '1.0.0-alpha', 1], // the mirror of the prefix row
    ['1.0.0-alpha.beta', '1.0.0-alpha.1', 1], // the mirror of the numeric-ident row
    ['1', '1.0.0', 0], // a missing minor and patch read as 0
    ['1.1', '1.0.0', 1],
  ])('orders %s against %s as %i', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected)
  })
})

describe('semverDelta', () => {
  // Every row of the `delta classification` block in spec/node_semver_spec.sh.
  // The classification is what a fix PR reports as the size of the move, and
  // it saturates at "major" by design: the distance below is what tells a
  // one-major bump apart from a jump across several lines.
  it.each([
    ['1.0.0', '2.0.0', 'major'],
    ['1.0.0', '1.1.0', 'minor'],
    ['1.0.0', '1.0.1', 'patch'],
    ['0.5.3', '0.5.4', 'patch'],
    ['0.5.3', '0.6.0', 'minor'],
    ['1.0.0', '1.0.0', 'none'],
    ['1.0.0-alpha', '1.0.0', 'prerelease'],
    ['4.0.18', '4.1.0', 'minor'],
  ])('classifies %s -> %s as %s', (from, to, expected) => {
    expect(semverDelta(from, to)).toBe(expected)
  })
})

describe('majorDistance', () => {
  // Every row of the `major distance` block in spec/node_semver_spec.sh.
  it.each([
    ['9.0.1', '11.1.1', 2],
    ['9.0.1', '10.0.0', 1],
    ['1.0.0', '1.9.9', 0],
    ['11.1.1', '9.0.1', 2], // a downgrade is the same distance
    ['0.5.3', '0.6.0', 0],
  ])('measures %s -> %s as %i major line(s)', (from, to, expected) => {
    expect(majorDistance(from, to)).toBe(expected)
  })
})

describe('parseVersion', () => {
  // The lenient reads `semver_parse` performs, each expected value written by
  // hand from what that definition does to the string: whitespace and a
  // leading `v` or `=` are stripped, build metadata is dropped before
  // anything is compared (semver.org section 10 excludes it from precedence),
  // a missing minor or patch is left missing rather than padded, a core
  // component that is not a number reads as 0, and the prerelease is
  // everything after the first hyphen, so a hyphen inside an identifier
  // survives (semver.org section 9 admits it).
  it.each([
    ['1.0.0', [1, 0, 0], []],
    ['  1.0.0  ', [1, 0, 0], []],
    ['v2.0.0', [2, 0, 0], []],
    ['=1.2.3', [1, 2, 3], []],
    ['1.0.0+build.1', [1, 0, 0], []],
    ['1', [1], []],
    ['1.0.0-alpha.1', [1, 0, 0], ['alpha', '1']],
    ['1.0.0-a-b.2', [1, 0, 0], ['a-b', '2']],
    // The specimen spec/node_apply_constraint_spec.sh writes into a lockfile
    // for its "not plain semver" case.
    ['10.x-bogus', [10, 0], ['bogus']],
  ])('reads %s', (version, core, pre) => {
    expect(parseVersion(version)).toEqual({ core, pre })
  })

  // jq aborts the whole program here (a `split` of a null), which the
  // heredoc's own comment names. The answer that would replace the abort is a
  // confident 0.0.0 for a version nobody supplied, which is the
  // silent-success shape this plugin refuses everywhere else.
  it.each([[''], ['   '], ['v'], ['=']])('refuses %s, which has no version in it', (version) => {
    expect(() => parseVersion(version)).toThrow(SemverParseError)
  })

  it('quotes the unreadable version in the message', () => {
    expect(() => parseVersion('')).toThrow(/""/)
  })
})

describe('semverMax', () => {
  // The comment on `semver_max` states the case it exists for: "2.3.10" sorts
  // below "2.3.2" as a string and above it as a version. The three-version
  // row is the resolved set spec/fixtures/pnpm-cross-line documents in its
  // own header ("1.1.11", "2.0.2", "5.0.5").
  it.each([
    [['2.3.2', '2.3.10'], '2.3.10'],
    [['2.3.10', '2.3.2'], '2.3.10'],
    [['1.1.11', '2.0.2', '5.0.5'], '5.0.5'],
    [['1.0.0'], '1.0.0'],
    [['1.0.0-alpha', '1.0.0'], '1.0.0'],
    [[], null],
  ])('ranks %j as %s', (versions, expected) => {
    expect(semverMax(versions)).toBe(expected)
  })
})

describe('versionFacts', () => {
  // The `compare_versions` answer shape, documented at node.sh line 33 as
  // {result, delta, major_distance}. Each row's three values are the same
  // ones the three tables above carry for that pair.
  it.each([
    ['9.0.1', '11.1.1', { result: -1, delta: 'major', major_distance: 2 }],
    ['2.0.0', '1.9.9', { result: 1, delta: 'major', major_distance: 1 }],
    ['1.0.0', '1.0.0', { result: 0, delta: 'none', major_distance: 0 }],
    ['1.0.0-alpha', '1.0.0', { result: -1, delta: 'prerelease', major_distance: 0 }],
    ['4.0.18', '4.1.0', { result: -1, delta: 'minor', major_distance: 0 }],
  ])('answers for %s against %s', (a, b, expected) => {
    expect(versionFacts(a, b)).toEqual(expected)
  })
})

describe('coreAt', () => {
  // The `$c[i] // 0` idiom, as its own function because the range side reads
  // core components the same way. A component the version did not write is 0,
  // which is the rule that makes `1` and `1.0.0` the same version.
  it.each([
    [[1, 2, 3], 0, 1],
    [[1, 2, 3], 2, 3],
    [[1], 1, 0],
    [[], 0, 0],
  ])('reads %j at %i as %i', (core, index, expected) => {
    expect(coreAt(core, index)).toBe(expected)
  })
})
