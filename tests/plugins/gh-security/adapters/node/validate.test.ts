// `validate` of the node adapter (#222). The seam is `node.validate`. Each
// expected value is written by hand from the fixture that it names. The
// sources are `verb_validate` in node.sh and the examples of
// spec/node_validate_spec.sh. The parity run holds the agreement with
// node.sh.
//
// Each refusal message is the text that node.sh writes. A test of a verdict
// asserts `ok` beside the field that decides it. The testing skill says why
// ("Assert the verdict, not the parse").
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { Tree, ValidateOptions } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { satisfiesAll } from '#gh-security/adapters/node/validate.ts'
import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'

const treeAt = (root: string): Tree<NodeDetection> => {
  const detection = node.detect(root, {})
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

const treeOf = (name: string): Tree<NodeDetection> => treeAt(join(FIXTURES_ROOT, name))

const options = (given: Partial<ValidateOptions> = {}): ValidateOptions => ({
  line: null,
  vulnerable: [],
  baseline: null,
  siblingAlerts: null,
  ...given,
})

/** The answer of `validate`, or a throw that names the failure. */
const answer = (name: string, pkg: string, range: string, given: Partial<ValidateOptions> = {}) => {
  const envelope = node.validate(treeOf(name), pkg, range, options(given))
  if (envelope.outcome !== 'ok') throw new Error(`validate failed: ${envelope.error}`)
  return envelope.value
}

const refusal = (name: string, pkg: string, range: string, given: Partial<ValidateOptions>) =>
  node.validate(treeOf(name), pkg, range, options(given))

const MULTI = 'yarn-multi-major'

const copy = (version: string) => ({ version, path: `undici@npm:${version}` })

describe('the refusals of the arguments, in the order of node.sh', () => {
  it.each([
    ['an empty line', { line: '' }, '--line requires a major'],
    [
      'an empty baseline',
      { line: '7', vulnerable: ['< 1.0.0'], baseline: '' },
      '--baseline requires the pre-fix resolved_versions JSON',
    ],
    [
      'an empty sibling list',
      { siblingAlerts: '' },
      '--sibling-alerts requires a JSON array of sibling-alert objects',
    ],
    ['an empty alert range', { vulnerable: ['< 1.0.0', ''] }, '--vulnerable requires a range'],
    [
      'a line that is not a number',
      { line: 'six', vulnerable: ['< 1.0.0'] },
      "validate: --line must be a major number, got 'six'",
    ],
    [
      'a negative line',
      { line: '-1', vulnerable: ['< 1.0.0'] },
      "validate: --line must be a major number, got '-1'",
    ],
    [
      'a line with a newline after it',
      { line: '7\n', vulnerable: ['< 1.0.0'] },
      "validate: --line must be a major number, got '7\n'",
    ],
    [
      'a line with no alert ranges',
      { line: '7' },
      "validate: --line requires at least one --vulnerable range. Pass every distinct vulnerable_range from the group's alerts; without them the completeness check has nothing to check and would pass a partial fix (issue #19).",
    ],
    [
      'a baseline with no line',
      { baseline: '{"package":"undici","versions":[]}' },
      'validate: --baseline requires --line. A cross-line move is defined against the line this group owns; with no line to exclude, every move looks like collateral (issue #83).',
    ],
    [
      'sibling alerts with no baseline',
      { line: '7', vulnerable: ['< 1.0.0'], siblingAlerts: '[]' },
      'validate: --sibling-alerts requires --baseline. Sibling-alert knowledge only reclassifies moves the baseline comparison found; with no baseline there are no moves to classify (issue #105).',
    ],
  ])('refuses %s', (_name, given, error) => {
    expect(refusal(MULTI, 'undici', '>=7.0.0 <8', given)).toEqual({ outcome: 'failed', error })
  })

  it.each([
    ['', '>=7.0.0', 'validate requires a package name'],
    ['undici', '', 'validate requires a range'],
  ])('refuses the package %j with the range %j', (pkg, range, error) => {
    expect(refusal(MULTI, pkg, range, {})).toEqual({ outcome: 'failed', error })
  })

  it('refuses an empty flag value before an empty package name, as node.sh reads flags first', () => {
    expect(refusal(MULTI, '', '', { line: '' })).toEqual({
      outcome: 'failed',
      error: '--line requires a major',
    })
  })
})

const UNUSABLE_BASELINE =
  "validate: --baseline is not a usable pre-fix baseline for 'undici'. Pass the phase 3 'resolved_versions undici' output verbatim: a JSON object whose .package is 'undici' and whose .versions is an array of objects each carrying a string .version. A baseline that is truncated, or captured for another package, would report no cross-line moves at all (issue #83)."

const lineSeven = (baseline: string) => ({ line: '7', vulnerable: ['< 1.0.0'], baseline })

describe('the baseline', () => {
  it.each([
    ['not JSON', 'nope'],
    ['two documents', '{"package":"undici","versions":[]} {"package":"undici","versions":[]}'],
    ['not an object', '[]'],
    ['for another package', '{"package":"lodash","versions":[]}'],
    ['with no package', '{"versions":[]}'],
    ['with no versions', '{"package":"undici"}'],
    ['with versions that are not a list', '{"package":"undici","versions":{}}'],
    ['with an entry that is not an object', '{"package":"undici","versions":["7.27.2"]}'],
    ['with an entry that is null', '{"package":"undici","versions":[null]}'],
    ['with an entry with no version', '{"package":"undici","versions":[{"path":"x"}]}'],
    ['with a version that is not text', '{"package":"undici","versions":[{"version":7}]}'],
    ['with NaN, which jq reads and JSON does not', '{"package":"undici","versions":[],"x":NaN}'],
  ])('refuses a baseline %s', (_name, baseline) => {
    expect(refusal(MULTI, 'undici', '>=7.0.0 <8', lineSeven(baseline))).toEqual({
      outcome: 'failed',
      error: UNUSABLE_BASELINE,
    })
  })

  it('reads a baseline that starts with a byte order mark, as jq does', () => {
    const value = answer(
      MULTI,
      'undici',
      '>=7.0.0 <8',
      lineSeven('﻿{"package":"undici","versions":[]}'),
    )
    expect({ ok: value.ok, other_line_moves: value.other_line_moves }).toEqual({
      ok: true,
      other_line_moves: [],
    })
  })

  it('fails on a baseline version with nothing in it, where jq stops', () => {
    const envelope = refusal(
      MULTI,
      'undici',
      '>=7.0.0 <8',
      lineSeven('{"package":"undici","versions":[{"version":""}]}'),
    )
    expect(envelope).toEqual({
      outcome: 'failed',
      error: '"" is not a version this adapter can read.',
    })
  })
})

describe('the alert ranges', () => {
  // Two bad inputs in one call. Each expected refusal is the one that node.sh
  // writes for the same flags.
  it.each([
    ['a baseline before an alert range', { baseline: 'nope' }, 'validate: --baseline is not'],
    [
      'an alert range before a sibling list',
      { baseline: '{"package":"undici","versions":[]}', siblingAlerts: 'nope' },
      "validate: --vulnerable range 'foo' is not",
    ],
  ])('refuses %s', (_name, given, start) => {
    const envelope = refusal(MULTI, 'undici', '>=7.0.0 <8', {
      line: '7',
      vulnerable: ['foo'],
      ...given,
    })
    expect(envelope.outcome === 'failed' && envelope.error.startsWith(start)).toBe(true)
  })

  it('names the first unreadable range in sorted order', () => {
    expect(refusal(MULTI, 'undici', '>=5.0.0', { vulnerable: ['< 1.0.0', 'foo', 'bar'] })).toEqual({
      outcome: 'failed',
      error:
        "validate: --vulnerable range 'bar' is not a parseable version range. Copy the alert's vulnerable_range verbatim; an unreadable range would silently mark every resolved copy as not vulnerable.",
    })
  })

  it.each(['*', '>= ', '1.x', '<1.0.0 ||', 'latest'])('refuses the range %j', (range) => {
    const envelope = refusal(MULTI, 'undici', '>=5.0.0', { vulnerable: [range] })
    expect(envelope.outcome === 'failed' && envelope.error).toContain(`range '${range}' is not`)
  })

  it.each([
    '< 1.0.0',
    '>= 7.0.0, < 7.27.0',
    '>=6.0.0 <6.24.0',
    '>= 2.0.0, < 3.0.0 || >= 8.0.0, < 9.0.0',
    '= 4.0.0',
    '>= 1.0.0-beta.1, < 1.0.0',
    '^1.2.3',
    '~v1.2.3+build.5',
  ])('accepts the range %j', (range) => {
    expect(answer(MULTI, 'undici', '>=5.0.0', { vulnerable: [range] }).unresolved_alerts).toEqual(
      [],
    )
  })

  it('splits a flag at each newline, drops the empty lines, and sorts the ranges once each', () => {
    const value = answer(MULTI, 'undici', '>=7.0.0 <8', {
      line: '7',
      vulnerable: ['>= 7.0.0, < 7.29.0\n< 1.0.0', '\n', '< 7.28.0', '>= 7.0.0, < 7.29.0'],
    })
    expect({ ok: value.ok, unresolved_alerts: value.unresolved_alerts }).toEqual({
      ok: false,
      unresolved_alerts: [
        { ...copy('7.27.2'), vulnerable_ranges: ['< 7.28.0', '>= 7.0.0, < 7.29.0'] },
      ],
    })
  })

  // #304 item 2. node.sh strips a comparator and then a `^` or `~`, so its
  // token check passes `<^7.0.0`. jq then reads it as `<0.0.0`, which
  // matches nothing: `validate --line 6 --vulnerable '<^7.0.0' undici
  // '>=6.0.0 <7'` on yarn-multi-major answers `ok: true`, and `'<7.0.0'`
  // answers `ok: false` with 6.24.1 unresolved (node.sh, probed). The port
  // refuses a comparator with a `^` or `~` after it.
  it.each(['<^7.0.0', '>=^5.0.0', '<~6', '>=~1.2.3', '=^1.0.0', '< 1.0.0 || <^7.0.0'])(
    'refuses the range %j, a comparator and then a caret or a tilde (#304)',
    (range) => {
      expect(refusal(MULTI, 'undici', '>=6.0.0 <7', { line: '6', vulnerable: [range] })).toEqual({
        outcome: 'failed',
        error: `validate: --vulnerable range '${range}' is not a parseable version range. Copy the alert's vulnerable_range verbatim; an unreadable range would silently mark every resolved copy as not vulnerable.`,
      })
    },
  )

  // #304 item 3. node.sh tests the raw text of the flags, so a flag that
  // holds only newlines passes its line guard, and the completeness check
  // then has no range. The port tests the ranges after the split.
  it.each([[['\n']], [['\n\n']], [['\n', '\n']]])(
    'refuses a line whose alert flags %j hold only newlines (#304)',
    (vulnerable) => {
      expect(refusal(MULTI, 'undici', '>=7.0.0 <8', { line: '7', vulnerable })).toEqual({
        outcome: 'failed',
        error:
          "validate: --line requires at least one --vulnerable range. Pass every distinct vulnerable_range from the group's alerts; without them the completeness check has nothing to check and would pass a partial fix (issue #19).",
      })
    },
  )

  it('answers with no line and a flag that holds only a newline, as with no flag', () => {
    const value = answer(MULTI, 'undici', '>=5.0.0', { vulnerable: ['\n'] })
    expect({ ok: value.ok, unresolved_alerts: value.unresolved_alerts }).toEqual({
      ok: true,
      unresolved_alerts: [],
    })
  })
})

const UNUSABLE_SIBLINGS =
  "validate: --sibling-alerts is not a usable sibling-alert list. Pass one JSON array of {major, vulnerable_ranges[]} objects, major a number or null for a line with no usable major, from the group's sibling_alerts field. A list nobody could read must be an error, never a silent reclassification either way (issue #105)."

const DEDUP = 'pnpm-benign-dedup'

const DEDUP_BASELINE =
  '{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.1","path":"picomatch@2.3.1"},{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'

const baselineOf = (...versions: string[]) =>
  JSON.stringify({ package: 'picomatch', versions: versions.map((version) => ({ version })) })

/** The move classes of the dedup tree, against `baseline`, with `siblingAlerts`. */
const dedupMoves = (siblingAlerts: string | null, baseline = DEDUP_BASELINE) => {
  const value = answer(DEDUP, 'picomatch', '>=4.0.3 <5', {
    line: '4',
    vulnerable: ['< 4.0.3'],
    baseline,
    siblingAlerts,
  })
  return { ok: value.ok, moves: value.other_line_moves }
}

const MOVED_2X = { major: 2, before: ['2.3.1', '2.3.2'], after: ['2.3.2'], status: 'moved' }

describe('the sibling alerts', () => {
  it.each([
    ['not JSON', 'nope'],
    ['not a list', '{"major":2,"vulnerable_ranges":[]}'],
    ['two documents', '[] []'],
    ['an entry that is not an object', '[2]'],
    ['an entry that is null', '[null]'],
    ['an entry with no major', '[{"vulnerable_ranges":[]}]'],
    ['a major that is text', '[{"major":"2","vulnerable_ranges":[]}]'],
    ['a major with a fraction', '[{"major":2.5,"vulnerable_ranges":[]}]'],
    ['a negative major', '[{"major":-1,"vulnerable_ranges":[]}]'],
    ['a major too large for a double', '[{"major":1e400,"vulnerable_ranges":[]}]'],
    ['an entry with no ranges', '[{"major":2}]'],
    ['ranges that are not a list', '[{"major":2,"vulnerable_ranges":"< 2.3.3"}]'],
    ['a range that is not text', '[{"major":2,"vulnerable_ranges":[233]}]'],
  ])('refuses a list with %s', (_name, siblings) => {
    expect(
      refusal(DEDUP, 'picomatch', '>=4.0.3 <5', {
        line: '4',
        vulnerable: ['< 4.0.3'],
        baseline: DEDUP_BASELINE,
        siblingAlerts: siblings,
      }),
    ).toEqual({ outcome: 'failed', error: UNUSABLE_SIBLINGS })
  })

  it('classifies the field-case dedup as benign and passes', () => {
    expect(dedupMoves('[]')).toEqual({ ok: true, moves: [{ ...MOVED_2X, class: 'benign_dedup' }] })
  })

  it('keeps the move fatal when the flag is absent', () => {
    expect(dedupMoves(null)).toEqual({ ok: false, moves: [{ ...MOVED_2X, class: 'fatal' }] })
  })

  it.each([
    ['a sibling alert on the moved major', '[{"major":2,"vulnerable_ranges":[]}]', 'fatal'],
    ['a sibling major written as 2.0', '[{"major":2.0,"vulnerable_ranges":[]}]', 'fatal'],
    [
      'a range that matches the landed version',
      '[{"major":3,"vulnerable_ranges":["< 2.3.3"]}]',
      'fatal',
    ],
    [
      'a range that matches only the version that left',
      '[{"major":3,"vulnerable_ranges":["<= 2.3.1"]}]',
      'fatal',
    ],
    ['an unreadable sibling range', '[{"major":3,"vulnerable_ranges":["foo"]}]', 'fatal'],
    // node.sh answers benign_dedup here: a declared divergence (validate.ts).
    [
      'an empty sibling range, which has no alternative',
      '[{"major":3,"vulnerable_ranges":[""]}]',
      'fatal',
    ],
    [
      'a null major with a range that misses',
      '[{"major":null,"vulnerable_ranges":["<= 1.3.0"]}]',
      'benign_dedup',
    ],
    ['a major of -0, which is 0', '[{"major":-0,"vulnerable_ranges":[]}]', 'benign_dedup'],
    [
      'a major and a range that both miss',
      '[{"major":3,"vulnerable_ranges":["< 2.0.0"]}]',
      'benign_dedup',
    ],
  ])('classifies the dedup with %s', (_name, siblings, moveClass) => {
    expect(dedupMoves(siblings)).toEqual({
      ok: moveClass === 'benign_dedup',
      moves: [{ ...MOVED_2X, class: moveClass }],
    })
  })

  it.each([
    ['is not the max of its baseline', baselineOf('2.3.2', '2.3.3', '4.0.1'), ['2.3.2', '2.3.3']],
    ['was not in the baseline', baselineOf('2.3.1', '4.0.1'), ['2.3.1']],
    [
      'is the max as text and not as a version',
      baselineOf('2.3.2', '2.3.10', '4.0.1'),
      ['2.3.10', '2.3.2'],
    ],
  ])('keeps the move fatal when the landed version %s', (_name, baseline, before) => {
    expect(dedupMoves('[]', baseline)).toEqual({
      ok: false,
      moves: [{ major: 2, before, after: ['2.3.2'], status: 'moved', class: 'fatal' }],
    })
  })

  it('keeps a move fatal when two versions are left on the line', () => {
    const value = answer('pnpm-benign-dedup-two-survivors', 'picomatch', '>=4.0.3 <5', {
      line: '4',
      vulnerable: ['< 4.0.3'],
      baseline: baselineOf('2.3.9', '4.0.1'),
      siblingAlerts: '[]',
    })
    expect({ ok: value.ok, moves: value.other_line_moves }).toEqual({
      ok: false,
      moves: [
        {
          major: 2,
          before: ['2.3.9'],
          after: ['2.3.10', '2.3.9'],
          status: 'moved',
          class: 'fatal',
        },
      ],
    })
  })

  // The first version left is the max of the baseline. So only the count of
  // the versions left makes this move fatal.
  it('keeps a move fatal when two versions are left, and the first is the baseline max', () => {
    const value = answer('pnpm-benign-dedup-two-survivors', 'picomatch', '>=4.0.3 <5', {
      line: '4',
      vulnerable: ['< 4.0.3'],
      baseline: baselineOf('2.3.10', '4.0.1'),
      siblingAlerts: '[]',
    })
    expect({ ok: value.ok, classes: value.other_line_moves?.map((move) => move.class) }).toEqual({
      ok: false,
      classes: ['fatal'],
    })
  })

  it('passes a clean tree with an unreadable sibling range', () => {
    expect(
      dedupMoves('[{"major":2,"vulnerable_ranges":["foo"]}]', baselineOf('2.3.2', '4.0.1')),
    ).toEqual({ ok: true, moves: [] })
  })
})

const CROSS_BASELINE = JSON.stringify({
  package: 'brace-expansion',
  versions: [{ version: '1.1.11' }, { version: '2.0.2' }, { version: '5.0.5' }],
})

describe('the moves on other lines', () => {
  it('lists each vanished line in the order of its major, and fails', () => {
    const value = answer('pnpm-cross-line-collapsed', 'brace-expansion', '>=5.0.9 <6', {
      line: '5',
      vulnerable: ['< 5.0.9'],
      baseline: CROSS_BASELINE,
      siblingAlerts: '[]',
    })
    expect({ ok: value.ok, moves: value.other_line_moves }).toEqual({
      ok: false,
      moves: [
        { major: 1, before: ['1.1.11'], after: [], status: 'vanished', class: 'fatal' },
        { major: 2, before: ['2.0.2'], after: [], status: 'vanished', class: 'fatal' },
      ],
    })
  })

  it('sorts the moves by major, whatever the order of the baseline', () => {
    const value = answer('pnpm-cross-line-collapsed', 'brace-expansion', '>=5.0.9 <6', {
      line: '5',
      vulnerable: ['< 5.0.9'],
      baseline: JSON.stringify({
        package: 'brace-expansion',
        versions: [{ version: '2.0.2' }, { version: '5.0.5' }, { version: '1.1.11' }],
      }),
    })
    expect(value.other_line_moves?.map(({ major }) => major)).toEqual([1, 2])
  })

  it('reports no move for an unchanged tree, and no move for a major only the tree holds', () => {
    const value = answer('pnpm-cross-line-qualified', 'brace-expansion', '>=5.0.9 <6', {
      line: '5',
      vulnerable: ['< 5.0.9'],
      baseline: JSON.stringify({ package: 'brace-expansion', versions: [{ version: '2.0.2' }] }),
    })
    expect({ ok: value.ok, moves: value.other_line_moves }).toEqual({ ok: true, moves: [] })
  })

  it('answers null for the moves when no baseline is given', () => {
    expect(
      answer('pnpm-cross-line-collapsed', 'brace-expansion', '>=5.0.9 <6', {
        line: '5',
        vulnerable: ['< 5.0.9'],
      }).other_line_moves,
    ).toBeNull()
  })
})

describe('the verdicts of the constraint and completeness checks', () => {
  it('fails an unscoped major-bounded range against a multi-major package', () => {
    expect(answer(MULTI, 'undici', '>=7.27.0 <8')).toEqual({
      ok: false,
      package: 'undici',
      range: '>=7.27.0 <8',
      line: null,
      line_present: true,
      checked: 3,
      resolved_count: 3,
      violations: [copy('5.29.0'), copy('6.24.1')],
      unresolved_alerts: [],
      requires_major_bump: [],
      other_line_moves: null,
      resolved_versions: ['5.29.0', '6.24.1', '7.27.2'],
    })
  })

  it('checks only the targeted line, and echoes the text of the line', () => {
    expect(answer(MULTI, 'undici', '>=7.0.0 <8', { line: '07', vulnerable: ['< 1.0.0'] })).toEqual({
      ok: true,
      package: 'undici',
      range: '>=7.0.0 <8',
      line: '07',
      line_present: true,
      checked: 1,
      resolved_count: 3,
      violations: [],
      unresolved_alerts: [],
      requires_major_bump: [],
      other_line_moves: null,
      resolved_versions: ['5.29.0', '6.24.1', '7.27.2'],
    })
  })

  it('refuses to pass a line with no resolved copy', () => {
    const value = answer(MULTI, 'undici', '>=9.0.0 <10', { line: '9', vulnerable: ['< 1.0.0'] })
    expect({ ok: value.ok, line_present: value.line_present, checked: value.checked }).toEqual({
      ok: false,
      line_present: false,
      checked: 0,
    })
  })

  it('fails a satisfied constraint when a copy on the line still matches an alert', () => {
    const value = answer(MULTI, 'undici', '>=6.24.0 <7', { line: '6', vulnerable: ['< 6.28.0'] })
    expect({
      ok: value.ok,
      violations: value.violations,
      unresolved: value.unresolved_alerts,
      bump: value.requires_major_bump,
    }).toEqual({
      ok: false,
      violations: [],
      unresolved: [{ ...copy('6.24.1'), vulnerable_ranges: ['< 6.28.0'] }],
      bump: [{ ...copy('5.29.0'), vulnerable_ranges: ['< 6.28.0'] }],
    })
  })

  it('fails on an alerted copy above the line, which no major bump clears', () => {
    const value = answer(MULTI, 'undici', '>=6.0.0 <7', {
      line: '6',
      vulnerable: ['>= 7.0.0, < 7.28.0'],
    })
    expect({
      ok: value.ok,
      unresolved: value.unresolved_alerts,
      bump: value.requires_major_bump,
    }).toEqual({
      ok: false,
      unresolved: [{ ...copy('7.27.2'), vulnerable_ranges: ['>= 7.0.0, < 7.28.0'] }],
      bump: [],
    })
  })

  it('passes with a copy below the line that needs a major bump', () => {
    const value = answer(MULTI, 'undici', '>=6.24.0 <7', { line: '6', vulnerable: ['< 6.24.0'] })
    expect({ ok: value.ok, bump: value.requires_major_bump }).toEqual({
      ok: true,
      bump: [{ ...copy('5.29.0'), vulnerable_ranges: ['< 6.24.0'] }],
    })
  })

  it('counts every alerted copy as unresolved when no line is given', () => {
    const value = answer(MULTI, 'undici', '>=5.0.0', { vulnerable: ['< 6.28.0'] })
    expect({
      ok: value.ok,
      unresolved: value.unresolved_alerts.map(({ version }) => version),
    }).toEqual({
      ok: false,
      unresolved: ['5.29.0', '6.24.1'],
    })
  })

  it('counts a copy installed under an npm: alias key', () => {
    const value = answer('npm-alias', 'lodash', '>=4.18.2 <5', {
      line: '4',
      vulnerable: ['>= 4.18.0, < 4.18.2'],
    })
    expect({ ok: value.ok, unresolved: value.unresolved_alerts }).toEqual({
      ok: false,
      unresolved: [
        {
          version: '4.18.1',
          path: 'node_modules/lodash-alias',
          vulnerable_ranges: ['>= 4.18.0, < 4.18.2'],
        },
      ],
    })
  })

  it('flags a copy whose locator carries binding parameters', () => {
    const value = answer('yarn-binding-params', 'privreg', '>=2.5.3 <3', {
      line: '2',
      vulnerable: ['>= 2.5.0, < 2.5.3'],
    })
    expect({
      ok: value.ok,
      unresolved: value.unresolved_alerts.map(({ version }) => version),
    }).toEqual({
      ok: false,
      unresolved: ['2.5.0'],
    })
  })
})

// The acceptance of #222. The verb validates a package that the lockfile
// holds, and refuses a package that it does not hold. So `present: false`
// never reads as a pass, and never reaches `removable` through `validate`.
describe('a package that the lockfile does not hold', () => {
  it('validates a package that only nested patch locators reach', () => {
    const value = answer('yarn-patch-nested', 'typescript', '>=5.1.6 <6', {
      line: '5',
      vulnerable: ['< 5.1.6'],
    })
    expect({ ok: value.ok, checked: value.checked, resolved: value.resolved_versions }).toEqual({
      ok: true,
      checked: 1,
      resolved: ['5.1.6'],
    })
  })

  it('refuses a package with no copy, and does not pass', () => {
    expect(refusal(MULTI, 'not-in-this-lockfile', '>=1.0.0', {})).toEqual({
      outcome: 'failed',
      error:
        "validate: 'not-in-this-lockfile' resolves to no versions in the lockfile. Nothing to validate.",
    })
  })

  it('gives the refusal of resolved_versions for a lockfile with no entries', () => {
    // node.sh writes this text for the fixture.
    expect(refusal('empty-npm', 'lodash', '>=1.0.0', {})).toEqual({
      outcome: 'failed',
      error:
        "Parsed 0 entries from the lockfile for pm 'npm'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result.",
    })
  })
})

describe('a constraint where jq stops', () => {
  it.each([
    [' ', "the range ' ' has an alternative with no comparator"],
    ['>=1 ||', "the range '>=1 ||' has an alternative with no comparator"],
    ['>=0 || >=', '"" is not a version this adapter can read.'],
    ['>=0 <99 ^', '"" is not a version this adapter can read.'],
    ['<0.0.1 >=', '"" is not a version this adapter can read.'],
  ])('fails for %j, which matches or not before it stops', (range, error) => {
    expect(refusal(MULTI, 'undici', range, {})).toEqual({ outcome: 'failed', error })
  })

  it('answers when no copy is on the line, because jq then never reads the range', () => {
    const value = answer(MULTI, 'undici', '>=1 ||', { line: '9', vulnerable: ['< 1.0.0'] })
    expect({ ok: value.ok, checked: value.checked }).toEqual({ ok: false, checked: 0 })
  })
})

describe('the override-placed shape of npm', () => {
  it('fails closed on the copy that a nested override left behind', () => {
    const fixture = useFixture('npm-override-placed-parent')
    onTestFinished(fixture.cleanup)
    const lockPath = join(fixture.path, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages: Record<string, unknown>
    }
    lock.packages['node_modules/nx/node_modules/brace-expansion'] = { version: '5.0.9' }
    writeFileSync(lockPath, JSON.stringify(lock))
    const envelope = node.validate(
      treeAt(fixture.path),
      'brace-expansion',
      '>=5.0.9 <6',
      options({ line: '5', vulnerable: ['< 5.0.9'] }),
    )
    expect(
      envelope.outcome === 'ok' && {
        ok: envelope.value.ok,
        unresolved: envelope.value.unresolved_alerts.map(({ version, path }) => ({
          version,
          path,
        })),
      },
    ).toEqual({
      ok: false,
      unresolved: [{ version: '5.0.5', path: 'node_modules/brace-expansion' }],
    })
  })
})

// `apply_constraint` reads ranges with this function too (#222, layer 2).
// Each row is the jq answer of `satisfies`, run on the same input.
describe('satisfiesAll, the jq rule for a range', () => {
  it.each([
    ['1.2.3', '>=1.0.0 <2', true],
    ['2.0.0', '>=1.0.0 <2', false],
    ['1.0.0', '>=2 || >=0.5', true],
    ['1.0.0', '< 1.0.0', false],
  ])('answers %s in %s as %s', (version, range, expected) => {
    expect(satisfiesAll(version, range)).toBe(expected)
  })

  it.each([
    ['an empty alternative', '>=0 ||'],
    ['an operator with no version', '>='],
    ['a bad comparator after a match', '>=0.5 || >='],
  ])('stops where jq stops: %s', (_shape, range) => {
    expect(() => satisfiesAll('1.0.0', range)).toThrow()
  })
})
