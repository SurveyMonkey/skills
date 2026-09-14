// Range evaluation, the port of `SEMVER_JQ`'s range half (node.sh lines
// 83-289) and of what `range_facts` (node.sh line 3429) answers with. The
// seam is the exported function; each is called directly, the way the future
// `range_facts` verb (#221) will call `rangeFacts`.
//
// Expected values are copied from the shellspec tables named above each
// block, or hand-written from the definition being ported and from
// semver.org. None is recomputed the way the module computes it, and parity
// against `node.sh` is not asserted here: the parity runner lands in #219,
// which this issue's plan comment carries that criterion to (ruling B).
import { describe, expect, it } from 'vitest'

import {
  caretUpper,
  evalToken,
  expandToken,
  rangeAlternatives,
  rangeFacts,
  rangeFloorMajor,
  rangeParseable,
  rangePinned,
  rangeTokens,
  satisfies,
  tildeUpper,
  tokenParseable,
  wildcardExpand,
} from '../../plugins/gh-security/src/semver/ranges.ts'

describe('rangeFacts', () => {
  // Every row of the `floor, distance, and pin shape` block in
  // spec/node_semver_spec.sh, which projects exactly these four fields.
  it.each([
    // range, version, satisfied, pinned, floor_major, majors_ahead
    ['^9', '11.1.1', false, false, 9, 2],
    ['^9', '9.5.0', true, false, 9, 0],
    ['^11', '11.1.1', true, false, 11, 0],
    ['~6.14.0', '6.14.3', true, true, 6, 0],
    ['~6.14.0', '7.0.0', false, true, 6, 1],
    ['1.0.0', '2.0.0', false, true, 1, 1],
    ['>=1.0.0 <2.0.0', '3.0.0', false, true, 1, 2],
    ['>=1.0.0', '3.0.0', true, false, 1, 2],
    ['^5.28.0 || ^6.19.0', '6.19.8', true, false, 5, 1],
    ['^9', '7.0.0', false, false, 9, 0], // below the floor
    ['1.x', '1.9.9', true, false, 1, 0], // x-range is ^1
    ['1.x', '2.0.0', false, false, 1, 1],
    ['1.2.x', '1.2.9', true, true, 1, 0], // bounded to a minor
  ])('reads %s against %s', (range, version, satisfied, pinned, floorMajor, majorsAhead) => {
    expect(rangeFacts(range, version)).toEqual({
      range,
      version,
      parseable: true,
      satisfied,
      pinned,
      floor_major: floorMajor,
      majors_ahead: majorsAhead,
    })
  })

  // The whole shape, asserted as one object rather than a projection, because
  // the contract is that every key is always present: a caller that has to
  // tell "no floor" from "field missing" cannot do it if the field can also
  // be absent (node.sh, the `range_facts` header comment).
  //
  // A wildcard has no floor to measure from, and reporting 0 would be a lie
  // the scorer could not tell apart from "declared exactly this major"
  // (spec/node_semver_spec.sh, 'reports no floor for a range with no lower
  // bound'). `pinned` is false by the rule `range_pinned` states: a pin is a
  // tilde, an exact version, a minor-bounded x-range or an explicit upper
  // bound, and `*` is none of them.
  it('reports no floor for a range with no lower bound', () => {
    expect(rangeFacts('*', '11.1.1')).toEqual({
      range: '*',
      version: '11.1.1',
      parseable: true,
      satisfied: true,
      pinned: false,
      floor_major: null,
      majors_ahead: null,
    })
  })

  // Every row of the `specifiers that are not version ranges` block. Reading
  // these as `satisfied: false` told the scorer a dependent had been left
  // behind by the fix, which is a fact nobody established.
  it.each([
    ['latest'],
    ['workspace:^'],
    ['git+https://github.com/example/pkg.git'],
    ['npm:other-pkg@^1.0.0'],
    ['file:../local'],
  ])('reports %s as unreadable rather than unsatisfied', (range) => {
    expect(rangeFacts(range, '11.2.0')).toEqual({
      range,
      version: '11.2.0',
      parseable: false,
      satisfied: null,
      pinned: null,
      floor_major: null,
      majors_ahead: null,
    })
  })
})

describe('satisfies', () => {
  // The rows behind `node.sh validate (range satisfaction)` in
  // spec/node_semver_spec.sh. That block exercises `satisfies` through
  // validate against the yarn-berry fixture, whose resolved versions its own
  // comment names: undici at 5.28.4 and 6.19.8, lodash at 4.17.21. Each
  // verdict below is the one the block asserts for that version.
  it.each([
    // 'accepts only the in-range version for a major-bounded range'
    ['5.28.4', '>=6.19.0 <7', false],
    ['6.19.8', '>=6.19.0 <7', true],
    // 'passes when the range covers every resolved version'
    ['5.28.4', '>=5.0.0', true],
    ['6.19.8', '>=5.0.0', true],
    // 'expands a caret to a major bound'
    ['5.28.4', '^6.19.0', false],
    ['6.19.8', '^6.19.0', true],
    // 'expands a tilde to a minor bound' and 'rejects a tilde bound the
    // version falls outside'
    ['4.17.21', '~4.17.0', true],
    ['4.17.21', '~4.16.0', false],
    // 'ORs || alternatives rather than merging them into one conjunction'. A
    // bug here collapsed alternatives into one impossible conjunction, which
    // made every || range unsatisfiable.
    ['5.28.4', '^5.28.0 || ^6.19.0', true],
    ['6.19.8', '^5.28.0 || ^6.19.0', true],
    // 'ANDs comma-separated comparators'
    ['4.17.21', '>=4.17.0, <5', true],
    // 'accepts an exact pin'
    ['4.17.21', '4.17.21', true],
  ])('reads %s against %s as %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  // The GitHub advisory spelling the `satisfies` comment names, with a space
  // after each operator. The space has to go before tokenizing, or "< 7.29.0"
  // splits into a bare "<" and a bare "7.29.0" and is read as "less than
  // nothing, and exactly 7.29.0", which is both wrong and fatal.
  it.each([
    ['7.28.0', '>= 7.0.0, < 7.29.0', true],
    ['7.29.0', '>= 7.0.0, < 7.29.0', false],
    ['6.9.0', '>= 7.0.0, < 7.29.0', false],
  ])('reads the advisory spelling %s against %s as %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  // The divergence from npm's semver that node.sh lines 3405-3426 document
  // and keep deliberately: npm admits a prerelease into a range only when a
  // comparator in the same conjunction carries a prerelease on the identical
  // core, so `1.x` does not admit `2.0.0-alpha` for npm, while this evaluator
  // reports true because `2.0.0-alpha` sorts below `2.0.0` and so falls
  // inside `>=1.0.0 <2.0.0`. The second row is the same divergence as
  // spec/node_apply_constraint_spec.sh reaches it, where a `10.3.0-beta.1`
  // copy is admitted by a plain `^10.0.0` that node-semver would exclude.
  it.each([
    ['2.0.0-alpha', '1.x', true],
    ['10.3.0-beta.1', '^10.0.0', true],
  ])('admits the prerelease %s into %s, unlike npm', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  // A specifier that is not a range answers false, which is why `parseable`
  // is the first field of `range_facts` to read.
  it.each([['latest'], ['workspace:^'], ['']])(
    'answers false for %s, which it cannot tokenize',
    (range) => {
      expect(satisfies('1.0.0', range)).toBe(false)
    },
  )
})

describe('caretUpper', () => {
  // The bound a caret expands to, hand-written from the definition: the
  // first non-zero core component is the one that moves, so a 0.x line is
  // bounded at its minor and a 0.0.x line at its patch.
  it.each([
    ['9', '10.0.0'],
    ['1.2.3', '2.0.0'],
    ['0.5.3', '0.6.0'],
    ['0.0.3', '0.0.4'],
    ['0.0.0', '0.0.1'],
  ])('bounds ^%s at %s', (version, expected) => {
    expect(caretUpper(version)).toBe(expected)
  })
})

describe('tildeUpper', () => {
  // A tilde bounds the minor line, whatever the version spells out.
  it.each([
    ['6.14.0', '6.15.0'],
    ['1.2', '1.3.0'],
    ['1', '1.1.0'],
    ['0.0.3', '0.1.0'],
  ])('bounds ~%s at %s', (version, expected) => {
    expect(tildeUpper(version)).toBe(expected)
  })
})

describe('wildcardExpand', () => {
  // From the definition's own comment: `*` (or a bare `x`) admits every
  // version, prerelease included, so it expands to a floor nothing can fall
  // below; an x-range bounds a line exactly the way the caret and tilde
  // forms do, `1.x` being `^1` and `1.2.x` being `~1.2`; anything else is
  // null, which is how the callers tell a wildcard from a comparator.
  it.each([
    ['*', ['>=0.0.0-0']],
    ['x', ['>=0.0.0-0']],
    ['X', ['>=0.0.0-0']],
    ['1.x', ['>=1.0.0', '<2.0.0']],
    ['1.X', ['>=1.0.0', '<2.0.0']],
    ['1.*', ['>=1.0.0', '<2.0.0']],
    ['v1.x', ['>=1.0.0', '<2.0.0']],
    ['1.2.x', ['>=1.2.0', '<1.3.0']],
    ['1.2.*', ['>=1.2.0', '<1.3.0']],
    ['1.2.3', null],
    ['^1.2.3', null],
    ['1.x.3', null],
    ['x.1', null],
    ['1.2.3.x', null],
    ['latest', null],
  ])('expands %s to %j', (token, expected) => {
    expect(wildcardExpand(token)).toEqual(expected)
  })
})

describe('expandToken', () => {
  // A caret or tilde becomes the comparator pair it stands for; a wildcard
  // becomes the pair `wildcardExpand` gives; anything else is left alone for
  // `evalToken` to read.
  it.each([
    ['^9', ['>=9', '<10.0.0']],
    ['^6.19.0', ['>=6.19.0', '<7.0.0']],
    ['~6.14.0', ['>=6.14.0', '<6.15.0']],
    ['1.x', ['>=1.0.0', '<2.0.0']],
    ['>=1.0.0', ['>=1.0.0']],
    ['4.17.21', ['4.17.21']],
  ])('expands %s to %j', (token, expected) => {
    expect(expandToken(token)).toEqual(expected)
  })
})

describe('evalToken', () => {
  // One row per operator spelling, in both verdicts, because the prefix test
  // is ordered: `>=` has to be read before `>` or the `=` becomes part of the
  // version. A token with no operator is an exact match.
  it.each([
    ['>=1.0.0', '1.0.0', true],
    ['>=1.0.0', '0.9.9', false],
    ['<=1.0.0', '1.0.0', true],
    ['<=1.0.0', '1.0.1', false],
    ['>1.0.0', '1.0.1', true],
    ['>1.0.0', '1.0.0', false],
    ['<2.0.0', '1.9.9', true],
    ['<2.0.0', '2.0.0', false],
    ['=1.0.0', '1.0.0', true],
    ['=1.0.0', '1.0.1', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.0', '1.0.1', false],
  ])('reads %s against %s as %s', (token, version, expected) => {
    expect(evalToken(token, version)).toBe(expected)
  })
})

describe('rangeTokens', () => {
  // Alternatives are flattened here rather than evaluated separately: the
  // floor of a union is the lowest floor in it, and a range carrying a pin in
  // any alternative is reported as pinned (the `range_tokens` comment).
  it.each([
    ['>=1.0.0 <2.0.0', ['>=1.0.0', '<2.0.0']],
    ['>= 7.0.0, < 7.29.0', ['>=7.0.0', '<7.29.0']],
    ['^5.28.0 || ^6.19.0', ['^5.28.0', '^6.19.0']],
    ['^9', ['^9']],
    ['', []],
  ])('tokenizes %s as %j', (range, expected) => {
    expect(rangeTokens(range)).toEqual(expected)
  })
})

describe('rangeAlternatives', () => {
  // The same tokenizing, but keeping the `||` groups apart, which is what
  // `rangeParseable` needs in order to refuse an empty alternative.
  it.each([
    ['^5.28.0 || ^6.19.0', [['^5.28.0'], ['^6.19.0']]],
    ['>=1.0.0 <2.0.0', [['>=1.0.0', '<2.0.0']]],
    ['|| ^1', [[], ['^1']]],
    ['', []],
  ])('groups %s as %j', (range, expected) => {
    expect(rangeAlternatives(range)).toEqual(expected)
  })
})

describe('rangePinned', () => {
  // A tilde, an exact version, an x-range bounded to one minor line, or an
  // explicit upper bound. A caret is not a pin: it admits the whole major
  // line, which is the ordinary declaration, and `1.x` says the same thing.
  it.each([
    ['~6.14.0', true],
    ['1.0.0', true],
    ['=1.0.0', true],
    ['>=1.0.0 <2.0.0', true],
    ['1.2.x', true],
    ['1.2.*', true],
    ['^9', false],
    ['1.x', false],
    ['*', false],
    ['>=1.0.0', false],
    ['', false],
  ])('reads %s as pinned=%s', (range, expected) => {
    expect(rangePinned(range)).toBe(expected)
  })
})

describe('tokenParseable', () => {
  // Deliberately looser than validate's `--vulnerable` parse check: an
  // advisory range is copied verbatim from the API and a wildcard there means
  // the tokenizer misread it, while a manifest legitimately declares `*`.
  it.each([
    ['^1.2.3', true],
    ['~1.2', true],
    ['>=1.0.0', true],
    ['<=1.0.0', true],
    ['>1', true],
    ['=1.0.0', true],
    ['1.0.0-alpha', true],
    ['1.0.0+build.1', true],
    ['v1.0.0', true],
    ['*', true],
    ['1.x', true],
    ['latest', false],
    ['workspace:^', false],
    ['file:../local', false],
    ['npm:other-pkg@^1.0.0', false],
    ['git+https://github.com/example/pkg.git', false],
    ['', false],
  ])('reads %s as parseable=%s', (token, expected) => {
    expect(tokenParseable(token)).toBe(expected)
  })
})

describe('rangeParseable', () => {
  // "Can this range be read at all?" Unreadable is a third answer, returned
  // rather than guessed, because `satisfies` answers false for a token it
  // cannot parse and that read as "this dependent was left behind".
  it.each([
    ['^9', true],
    ['>=1.0.0 <2.0.0', true],
    ['^5.28.0 || ^6.19.0', true],
    ['*', true],
    ['latest', false],
    ['^1 || latest', false],
    ['|| ^1', false], // an empty alternative is not a readable range
    ['', false],
  ])('reads %s as parseable=%s', (range, expected) => {
    expect(rangeParseable(range)).toBe(expected)
  })
})

describe('rangeFloorMajor', () => {
  // The major of the lowest version the range admits. Upper-bound
  // comparators are excluded: `<10` says nothing about where a range starts.
  it.each([
    ['^9', 9],
    ['^11', 11],
    ['~6.14.0', 6],
    ['1.0.0', 1],
    ['1.x', 1],
    ['>=1.0.0 <2.0.0', 1],
    ['^5.28.0 || ^6.19.0', 5],
    ['*', null],
    ['<10', null],
    ['', null],
  ])('reads the floor of %s as %s', (range, expected) => {
    expect(rangeFloorMajor(range)).toBe(expected)
  })

  // Every range spec/node_apply_constraint_spec.sh feeds `apply_constraint`.
  // The verb picks the parent copies whose resolution of the child sits on
  // the range's line, so the floor major is the semver question underneath
  // each of its cases; the floors below are read off the ranges themselves.
  it.each([
    ['>=5.0.9 <6', 5],
    ['>=1.1.12 <2', 1],
    ['>=9.0.0 <10', 9],
    ['>=6.19.0 <7', 6],
    ['>=4.17.21 <5', 4],
    ['>=5.1.6 <6', 5],
    ['>=3.4.13 <4', 3],
    ['>=0.0.9 <0.1', 0],
    ['>=10.0.5 <11', 10],
    ['>=22.7.7 <23', 22],
  ])('reads the floor of the apply_constraint range %s as %i', (range, expected) => {
    expect(rangeFloorMajor(range)).toBe(expected)
  })
})
