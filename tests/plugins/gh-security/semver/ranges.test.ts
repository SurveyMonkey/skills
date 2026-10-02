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
} from '#gh-security/semver/ranges.ts'

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

  // The divergence from npm's semver that node.sh lines 3417-3428 document
  // and keep deliberately: npm admits a prerelease into a range only when a
  // comparator in the same conjunction carries a prerelease on the identical
  // core, so `1.x` does not admit `2.0.0-alpha` for npm, while this evaluator
  // reports true because `2.0.0-alpha` sorts below `2.0.0` and so falls
  // inside `>=1.0.0 <2.0.0`. The second row is the same divergence as
  // spec/node_apply_constraint_spec.sh reaches it: its `npm-cross-line`
  // fixture declares `minimatch` at `^10.2.5` (spec/fixtures/npm-cross-line/
  // package.json), and a `10.3.0-beta.1` copy is admitted by that plain
  // caret range, which node-semver would exclude.
  it.each([
    ['2.0.0-alpha', '1.x', true],
    ['10.3.0-beta.1', '^10.2.5', true],
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

  // #304 item 2 on the `range_facts` path. jq strips a comparator and then a
  // `^` or `~`, so it calls these tokens parseable. Its evaluator then reads
  // the bound as a version with major 0: `<^5.0.0` is `<0.0.0`. Probe, jq
  // 1.8.1: `node.sh range_facts '<^5.0.0' 4.0.0` gives parseable true and
  // satisfied false, and `node.sh range_facts '<5.0.0' 4.0.0` gives satisfied
  // true. `=^1.0.0` against 1.0.0, `>=~1.2.3` against 0.0.1 and `<=~2.0.0`
  // against 3.0.0 give false, and `>^1` against 0.0.1 gives true. Each is a
  // misread, so here each token is unreadable. A declared parity exception.
  it.fails.each([['<^5.0.0'], ['=^1.0.0'], ['>=~1.2.3'], ['<=~2.0.0'], ['>^1'], ['<~5.0.0']])(
    'reads %s, a comparator and then a caret or tilde, as unreadable (#304)',
    (token) => {
      expect(tokenParseable(token)).toBe(false)
    },
  )

  // One operator, then `v` or `=`, as the version allows. jq reads each one
  // right, and so does the port. Probe, jq 1.8.1: `node.sh range_facts
  // '^=1.0.0' 1.5.0`, `'~v1.2.3' 1.2.9`, `'>=v1.2.3' 1.2.3`, `'>==1.0.0'
  // 1.0.0` and `'~=1.2.3' 1.2.9` each give parseable true and satisfied true.
  it.each([['^=1.0.0'], ['~v1.2.3'], ['>=v1.2.3'], ['>==1.0.0'], ['~=1.2.3']])(
    'still reads %s as parseable',
    (token) => {
      expect(tokenParseable(token)).toBe(true)
    },
  )
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

// #303 items 1 and 2. Each expected value is the answer of the jq original.
// The probe loads the library from node.sh, and then calls one function:
//
//   SEMVER_JQ=$(awk '/^SEMVER_JQ=/{f=1;next} /^JQLIB/{f=0} f' \
//     plugins/gh-security/scripts/ecosystems/node.sh)
//   jq -nc --arg v 1.0.0 --arg r '>=0 ||' "$SEMVER_JQ"' satisfies($v; $r)'
//   jq -nc --arg r $'>=1 ||　<2' "$SEMVER_JQ"' $r | range_alternatives'
//
// jq 1.8.1 gave these answers. `[[:space:]]` is the Unicode White_Space set:
// 9 to 13, 32, 133, 160, 5760, 8192 to 8202, 8232, 8233, 8239, 8287 and
// 12288. This list came from
// `jq -nc '[range(0;65536) | select([.] | implode | test("^[[:space:]]$"))]'`.
describe('satisfies, where jq stops (#303)', () => {
  // Every row: jq stops with an error, for example "Cannot iterate over null".
  it.each([
    ['an empty alternative after a match', '>=0 ||'],
    ['an empty alternative before a match', '|| >=0'],
    ['an empty alternative between two', '>=0 || || >=0'],
    ['a range of white space only', ' '],
  ])('throws for %s', (_shape, range) => {
    expect(() => satisfies('1.0.0', range)).toThrow(/has an alternative with no comparator/)
  })

  // jq reads each comparator, so the bad one stops it after a match, and also
  // when an earlier comparator of the same alternative is already false.
  // Probe, jq 1.8.1: each of these gives "split input and separator must be
  // strings", with 1.0.0 as the version.
  it.each([
    ['an operator with no version after a match', '>=0.5 || >='],
    ['an operator with no version after a failed comparator', '<0.5 >='],
    ['a caret with no version', '^'],
    ['a tilde with no version', '~'],
    ['an equal sign with no version', '='],
    ['a bare v', 'v'],
  ])('throws for %s', (_shape, range) => {
    expect(() => satisfies('1.0.0', range)).toThrow(/is not a version this adapter can read/)
  })

  // Pin example. It passes when written: `satisfies` already throws here,
  // because the empty version has no core.
  it('throws for an operator with no version', () => {
    expect(() => satisfies('1.0.0', '>=')).toThrow()
  })

  // Pin example. It passes when written: `"" | split("||")` is `[]`, so an
  // empty range has no alternative, and jq answers false.
  it('answers false for an empty range', () => {
    expect(satisfies('1.0.0', '')).toBe(false)
  })
})

describe('the white space of a range (#303)', () => {
  const ASCII_SPACES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]
  const WIDE_SPACES = [
    0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
    0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ]
  // Zero width and format characters that Oniguruma does not count as space.
  // Next to each edge of the set, too. Probe, jq 1.8.1: none of these is
  // `[[:space:]]`.
  const NOT_SPACES = [
    0x86, 0x9f, 0xa1, 0x180e, 0x1681, 0x1fff, 0x200b, 0x200c, 0x202a, 0x205e, 0x2060, 0x3001,
    0xfeff,
  ]
  const at = (code: number) => String.fromCodePoint(code)

  // jq: `>=0.5<C><2` against 3.0.0 is false when C splits the range into
  // `>=0.5` and `<2`.
  it.each(ASCII_SPACES.map((code) => [code.toString(16)]))(
    'splits a range at the ASCII space U+%s',
    (hex) => {
      const space = at(Number.parseInt(hex, 16))
      expect(satisfies('3.0.0', `>=0.5${space}<2`)).toBe(false)
    },
  )

  it.each(WIDE_SPACES.map((code) => [code.toString(16)]))(
    'splits a range at the wide space U+%s',
    (hex) => {
      const space = at(Number.parseInt(hex, 16))
      expect(satisfies('3.0.0', `>=0.5${space}<2`)).toBe(false)
    },
  )

  // jq: the same range is true when C is no space: one token, `>=0.5C<2`,
  // whose version reads as 0.0 after the first dot.
  it.each(NOT_SPACES.map((code) => [code.toString(16)]))('does not split at U+%s', (hex) => {
    const character = at(Number.parseInt(hex, 16))
    expect(satisfies('3.0.0', `>=0.5${character}<2`)).toBe(true)
  })

  // A character that is no space stays in the token after an operator and in
  // the flat split. Probe, jq 1.8.1: `">=\ufeff0.5" | gsub("(?<o>[<>=~^]+)[[:space:]]+"; "\(.o)")`
  // keeps the character, and `[">=1\ufeff<2" | splits("[[:space:],|]+")]` is one token.
  it.each(NOT_SPACES.map((code) => [code.toString(16)]))(
    'keeps U+%s after an operator, and in the flat split',
    (hex) => {
      const character = at(Number.parseInt(hex, 16))
      expect(rangeAlternatives(`>=${character}0.5`)).toEqual([[`>=${character}0.5`]])
      expect(rangeTokens(`>=1${character}<2`)).toEqual([`>=1${character}<2`])
    },
  )

  it('splits the alternatives and the comparators at the wide spaces together', () => {
    expect(rangeAlternatives('>=1 ||　<2\u0085')).toEqual([['>=1'], ['<2']])
  })

  it('drops a wide space after an operator, as jq does', () => {
    expect(rangeAlternatives('>= 1')).toEqual([['>=1']])
    expect(satisfies('0.1.0', '>= 0.5')).toBe(false)
  })

  // jq probe: `jq -nc '">=\u2003 0.5" | gsub("(?<op>[<>=~^]+)[[:space:]]+"; .op)'`
  // gives `>=0.5` for every code point of the set, so each one is dropped
  // after an operator.
  it.each(WIDE_SPACES.map((code) => [code.toString(16)]))(
    'drops the wide space U+%s after an operator',
    (hex) => {
      const space = at(Number.parseInt(hex, 16))
      expect(rangeAlternatives(`>=${space}0.5`)).toEqual([['>=0.5']])
    },
  )

  // jq probe: `jq -nc '[">=1\u2003<2" | splits("[[:space:],|]+")]'` splits at
  // each code point of the set, and `||` and `,` split as well.
  it.each(WIDE_SPACES.map((code) => [code.toString(16)]))(
    'flattens a range at the wide space U+%s',
    (hex) => {
      const space = at(Number.parseInt(hex, 16))
      expect(rangeTokens(`>=1${space}<2`)).toEqual(['>=1', '<2'])
    },
  )

  it('flattens a range with wide spaces into its tokens', () => {
    expect(rangeTokens('>=1 ||　<2\u0085')).toEqual(['>=1', '<2'])
  })
})
