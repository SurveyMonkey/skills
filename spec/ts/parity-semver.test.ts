// The first parity run (RFC 002, "Parity is the migration strategy"): the two
// semver verbs `node.sh` already answers, against the TypeScript module that
// replaces them (#218), over the rows the existing vitest tables carry.
//
// This discharges the criterion #218 handed here (this issue's plan comment,
// ruling B): those tables assert behavior, and nothing until now asserted
// that the bash and the TypeScript agree. The rule the port is ordered by is
// that a bash script is deleted only after its replacement is parity-green on
// every fixture that covered it, so the runner is the gate on every later
// port issue rather than a one-off for these two verbs.
//
// The rows below are duplicated from `spec/ts/semver-versions.test.ts` and
// `spec/ts/semver-ranges.test.ts`, which hold them inline in `it.each` tables
// rather than exporting them; each block names the table it came from. Those
// files are not edited: their assertions are about behavior, this file's are
// about agreement, and a table shared between them would make one of the two
// answer for the other.
//
// Which rows are here: every row of those two files that names an argument
// pair one of the two verbs takes, meaning a version pair for
// `compare_versions` and a range with a version for `range_facts`. The
// single-argument tables (`caretUpper`, `tildeUpper`, `wildcardExpand`,
// `expandToken`, `rangeTokens`, `rangeAlternatives`, `rangePinned`,
// `tokenParseable`, `rangeParseable`, `rangeFloorMajor`, `parseVersion`,
// `semverMax`, `coreAt`) are internal definitions of `SEMVER_JQ` with no verb
// of their own, so the only parity reachable for them is through these two.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { rangeFacts } from '../../plugins/gh-security/src/semver/ranges.ts'
import { versionFacts } from '../../plugins/gh-security/src/semver/versions.ts'
import { checkParity, type ParitySubject } from './support/parity.ts'

const ADAPTER = join(
  import.meta.dirname,
  '..',
  '..',
  'plugins',
  'gh-security',
  'scripts',
  'ecosystems',
  'node.sh',
)

// `node.sh compare_versions` answers `{a, b, result, delta, major_distance}`
// (node.sh line 33), so the TypeScript side carries the echoed arguments the
// verb adds around `versionFacts`. Dropping them here would make the runner
// report a difference on every row, which is the mismatch report proving
// nothing rather than the agreement proving something.
const compareVersions: ParitySubject<readonly [string, string]> = {
  bash: ([a, b]) => ({ command: ADAPTER, args: ['compare_versions', a, b] }),
  typescript: ([a, b]) => ({ a, b, ...versionFacts(a, b) }),
}

// `range_facts` echoes its arguments inside the answer itself, so `rangeFacts`
// is the whole shape with nothing added.
const rangeFactsSubject: ParitySubject<readonly [string, string]> = {
  bash: ([range, version]) => ({ command: ADAPTER, args: ['range_facts', range, version] }),
  typescript: ([range, version]) => rangeFacts(range, version),
}

const matched = { matched: true }

describe('compare_versions', () => {
  // The `compareVersions` ordering table of spec/ts/semver-versions.test.ts,
  // whose expected column is the precedence chain at semver.org section 11.
  it.each([
    ['4.17.15', '4.18.2'],
    ['9.0.0', '10.0.0'],
    ['1.2.3', '1.10.0'],
    ['2.0.0', '1.9.9'],
    ['1.0.0', '1.0.0'],
    ['1.0.0+build.1', '1.0.0'],
    ['v2.0.0', '2.0.0'],
    ['1.0.0-alpha', '1.0.0'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
    ['1.0.0-alpha.beta', '1.0.0-beta'],
    ['1.0.0-beta.2', '1.0.0-beta.11'],
    ['1.0.0-beta.11', '1.0.0-rc.1'],
    ['1.0.0-rc.1', '1.0.0-beta.11'],
  ])('agrees on %s against %s', (a, b) => {
    expect(checkParity(compareVersions, [a, b])).toEqual(matched)
  })

  // The `spellings the ordering chain does not spell out` table of the same
  // file: mirrored pairs and the components nobody wrote.
  it.each([
    ['1.0.0-alpha', '1.0.0-alpha'],
    ['1.0.0-alpha.1', '1.0.0-alpha'],
    ['1.0.0-alpha.beta', '1.0.0-alpha.1'],
    ['1', '1.0.0'],
    ['1.1', '1.0.0'],
    ['1.2.3-', '1.2.3'],
  ])('agrees on %s against %s', (a, b) => {
    expect(checkParity(compareVersions, [a, b])).toEqual(matched)
  })

  // The `semverDelta` table. `compare_versions` answers the classification in
  // the same call, so these rows exercise the delta half of the verb.
  it.each([
    ['1.0.0', '2.0.0'],
    ['1.0.0', '1.1.0'],
    ['1.0.0', '1.0.1'],
    ['0.5.3', '0.5.4'],
    ['0.5.3', '0.6.0'],
    ['1.0.0', '1.0.0'],
    ['1.0.0-alpha', '1.0.0'],
    ['4.0.18', '4.1.0'],
  ])('agrees on the delta from %s to %s', (from, to) => {
    expect(checkParity(compareVersions, [from, to])).toEqual(matched)
  })

  // The `majorDistance` table, the third field of the same answer.
  it.each([
    ['9.0.1', '11.1.1'],
    ['9.0.1', '10.0.0'],
    ['1.0.0', '1.9.9'],
    ['11.1.1', '9.0.1'],
    ['0.5.3', '0.6.0'],
  ])('agrees on the major distance from %s to %s', (from, to) => {
    expect(checkParity(compareVersions, [from, to])).toEqual(matched)
  })

  // The `versionFacts` table, which asserts the whole answer shape.
  it.each([
    ['9.0.1', '11.1.1'],
    ['2.0.0', '1.9.9'],
    ['1.0.0', '1.0.0'],
    ['1.0.0-alpha', '1.0.0'],
    ['4.0.18', '4.1.0'],
  ])('agrees on the whole answer for %s against %s', (a, b) => {
    expect(checkParity(compareVersions, [a, b])).toEqual(matched)
  })
})

describe('range_facts', () => {
  // The `rangeFacts` table of spec/ts/semver-ranges.test.ts, which is the
  // `floor, distance, and pin shape` block of spec/node_semver_spec.sh.
  it.each([
    ['^9', '11.1.1'],
    ['^9', '9.5.0'],
    ['^11', '11.1.1'],
    ['~6.14.0', '6.14.3'],
    ['~6.14.0', '7.0.0'],
    ['1.0.0', '2.0.0'],
    ['>=1.0.0 <2.0.0', '3.0.0'],
    ['>=1.0.0', '3.0.0'],
    ['^5.28.0 || ^6.19.0', '6.19.8'],
    ['^9', '7.0.0'],
    ['1.x', '1.9.9'],
    ['1.x', '2.0.0'],
    ['1.2.x', '1.2.9'],
    // The range with no lower bound, its own example in that file.
    ['*', '11.1.1'],
  ])('agrees on %s against %s', (range, version) => {
    expect(checkParity(rangeFactsSubject, [range, version])).toEqual(matched)
  })

  // The `specifiers that are not version ranges` table. Parity matters most
  // here: `parseable: false` with every other field null is the answer that
  // keeps a specifier nobody can read out of the scorer's evidence, and an
  // implementation that guessed instead would differ in exactly one field.
  it.each([
    ['latest', '11.2.0'],
    ['workspace:^', '11.2.0'],
    ['git+https://github.com/example/pkg.git', '11.2.0'],
    ['npm:other-pkg@^1.0.0', '11.2.0'],
    ['file:../local', '11.2.0'],
  ])('agrees on %s against %s', (range, version) => {
    expect(checkParity(rangeFactsSubject, [range, version])).toEqual(matched)
  })

  // The `satisfies` tables of the same file, read through the verb that
  // exposes `satisfies`: the yarn-berry rows, the advisory spelling with a
  // space after each operator, and the two prerelease rows where this
  // evaluator diverges from npm deliberately (node.sh lines 3417-3428). The
  // divergence is the reason these rows are here: a port that quietly adopted
  // npm's exclusion rule would pass its own table and fail this one.
  it.each([
    ['>=6.19.0 <7', '5.28.4'],
    ['>=6.19.0 <7', '6.19.8'],
    ['>=5.0.0', '5.28.4'],
    ['>=5.0.0', '6.19.8'],
    ['^6.19.0', '5.28.4'],
    ['^6.19.0', '6.19.8'],
    ['~4.17.0', '4.17.21'],
    ['~4.16.0', '4.17.21'],
    ['^5.28.0 || ^6.19.0', '5.28.4'],
    ['>=4.17.0, <5', '4.17.21'],
    ['4.17.21', '4.17.21'],
    ['>= 7.0.0, < 7.29.0', '7.28.0'],
    ['>= 7.0.0, < 7.29.0', '7.29.0'],
    ['>= 7.0.0, < 7.29.0', '6.9.0'],
    ['1.x', '2.0.0-alpha'],
    ['^10.2.5', '10.3.0-beta.1'],
  ])('agrees on %s against %s', (range, version) => {
    expect(checkParity(rangeFactsSubject, [range, version])).toEqual(matched)
  })

  // The `evalToken` table, whose first column is a one-comparator range and
  // whose second is a version, so the verb takes the pair unchanged. The
  // operator spellings are what these rows are about: the prefix test is
  // ordered, and `>=` read as `>` would differ on the equal row alone.
  it.each([
    ['>=1.0.0', '1.0.0'],
    ['>=1.0.0', '0.9.9'],
    ['<=1.0.0', '1.0.0'],
    ['<=1.0.0', '1.0.1'],
    ['>1.0.0', '1.0.1'],
    ['>1.0.0', '1.0.0'],
    ['<2.0.0', '1.9.9'],
    ['<2.0.0', '2.0.0'],
    ['=1.0.0', '1.0.0'],
    ['=1.0.0', '1.0.1'],
    ['1.0.0', '1.0.0'],
    ['1.0.0', '1.0.1'],
  ])('agrees on %s against %s', (range, version) => {
    expect(checkParity(rangeFactsSubject, [range, version])).toEqual(matched)
  })
})
