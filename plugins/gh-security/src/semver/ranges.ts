// Range evaluation for the node adapter, ported from the `SEMVER_JQ` heredoc
// in `scripts/ecosystems/node.sh` (lines 83-289) and from what the
// `range_facts` verb (node.sh line 3429) answers with, under RFC 002.
//
// The jq semantics are kept, with two declared parity exceptions. The known
// divergence from npm's semver on prereleases stays. It is documented on
// `rangeFacts` below, and it is deliberate.
//
// Parity exception #304 item 2: a token with a comparator and then a `^` or
// `~`, such as `<^5.0.0`, is unreadable here. jq reads it as a version with
// major 0. See `tokenParseable`.
//
// Parity exception #353: `satisfies` reads three forms as npm does, and jq
// does not. A partial version with no operator, such as `22` or `22.7`, is
// the line it names. A tilde before a partial version is the same line. A
// hyphen range `A - B` is `>=A <=B`, and a partial or x-range end reads as
// its line. The upper bound of a line ends in `-0`, as npm's does. The
// upper bound of `22.x` and `^22` has no `-0` here, unlike npm (the
// prerelease divergence). So here `22` does not admit `23.0.0-0`, but `22.x`
// and `^22` do. See `partialLine` and `foldHyphens`.
//
// This file ships. It imports nothing outside the plugin and stays inside the
// erasable subset (no `enum`, no parameter properties, no namespaces),
// because node strips the types rather than compiling them (ADR 012).

import { compareVersions, coreAt, parseVersion } from './versions.ts'

/** Everything the `range_facts` verb answers about a range and a version. */
export type RangeFacts = {
  readonly range: string
  readonly version: string
  readonly parseable: boolean
  readonly satisfied: boolean | null
  readonly pinned: boolean | null
  readonly floor_major: number | null
  readonly majors_ahead: number | null
}

// `[[:space:]]` as Oniguruma reads it in jq: the Unicode White_Space set, which
// is more than ASCII (#303). It is spelled out rather than written `\s`,
// because `\s` in JavaScript also matches U+FEFF, which jq does not, and it
// lacks U+0085, which jq does match. The set came from
// `jq -nc '[range(0;65536) | select([.] | implode | test("^[[:space:]]$"))]'`
// on jq 1.8.1. The comma joins it wherever a range is tokenized, because a
// GitHub advisory separates comparators with one (">= 7.0.0, < 7.29.0").
const SPACE =
  ' \\t\\n\\v\\f\\r\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const OPERATOR_SPACE = new RegExp(`([<>=~^]+)[${SPACE}]+`, 'g')
const TOKEN_SEPARATOR = new RegExp(`[${SPACE},]+`)
const FLAT_TOKEN_SEPARATOR = new RegExp(`[${SPACE},|]+`)

// jq's `split/1` on an empty string is `[]`, not `[""]`, and the difference
// decides whether an empty range has zero alternatives (unreadable) or one
// empty alternative.
const splitLiteral = (value: string, separator: string): string[] =>
  value === '' ? [] : value.split(separator)

// The space after an operator has to go before tokenizing: the separator is
// whitespace, so "< 6.28.0" would otherwise split into a bare "<" and a bare
// "6.28.0" and be read as "less than nothing, and exactly 6.28.0", which is
// both wrong and, with an empty version to parse, fatal.
const tightenOperators = (range: string): string => range.replace(OPERATOR_SPACE, '$1')

const nonEmpty = (values: string[]): string[] => values.filter((value) => value.length > 0)

/**
 * The exclusive upper bound a caret expands to: the first non-zero core
 * component is the one that moves, so `^0.5.3` bounds the 0.5 line and
 * `^0.0.3` bounds a single patch.
 */
export const caretUpper = (version: string): string => {
  const core = parseVersion(version).core
  const major = coreAt(core, 0)
  const minor = coreAt(core, 1)
  if (major > 0) return `${major + 1}.0.0`
  if (minor > 0) return `0.${minor + 1}.0`
  return `0.0.${coreAt(core, 2) + 1}`
}

/** The exclusive upper bound a tilde expands to: the next minor line. */
export const tildeUpper = (version: string): string => {
  const core = parseVersion(version).core
  return `${coreAt(core, 0)}.${coreAt(core, 1) + 1}.0`
}

/**
 * A wildcard token as the comparator pair it stands for, or `null` when the
 * token is not a wildcard, which is how every caller tells the two apart.
 *
 * `*` (or a bare `x`) admits every version, so it expands to a floor nothing
 * can fall below, prerelease included. An x-range bounds a line exactly the
 * way the caret and tilde forms do: `1.x` is `^1`, `1.2.x` is `~1.2`.
 */
export const wildcardExpand = (token: string): string[] | null => {
  if (/^[*xX]$/.test(token)) return ['>=0.0.0-0']
  const parts = splitLiteral(token.replace(/^[v=]+/, ''), '.')
  const [major, minor, patch] = parts
  if (parts.length === 2 && major !== undefined && /^[0-9]+$/.test(major) && isWild(minor)) {
    return [`>=${major}.0.0`, `<${Number(major) + 1}.0.0`]
  }
  if (
    parts.length === 3 &&
    major !== undefined &&
    minor !== undefined &&
    /^[0-9]+$/.test(major) &&
    /^[0-9]+$/.test(minor) &&
    isWild(patch)
  ) {
    return [`>=${major}.${minor}.0`, `<${major}.${Number(minor) + 1}.0`]
  }
  return null
}

const isWild = (part: string | undefined): boolean => part !== undefined && /^[xX*]$/.test(part)

// A version with one or two numeric parts, after any `v` or `=`.
const PARTIAL = /^[v=]*([0-9]+)(?:\.([0-9]+))?$/

/** The comparator pair of the line of a major, or of a major and a minor. */
const lineOf = (major: string | undefined, minor: string | undefined): [string, string] => {
  const one = Number(major)
  if (minor === undefined) return [`>=${one}.0.0`, `<${one + 1}.0.0-0`]
  const two = Number(minor)
  return [`>=${one}.${two}.0`, `<${one}.${two + 1}.0-0`]
}

/**
 * A partial version as the comparator pair of the line it names, as npm reads
 * it (#353): `22` is `>=22.0.0 <23.0.0-0`, and `22.7` is
 * `>=22.7.0 <22.8.0-0`. It is null for any other text.
 */
const partialLine = (text: string): string[] | null => {
  const match = PARTIAL.exec(text)
  return match === null ? null : lineOf(match[1], match[2])
}

/** A token as the comparators it stands for. */
export const expandToken = (token: string): string[] => {
  const wildcard = wildcardExpand(token)
  if (wildcard !== null) return wildcard
  const line = partialLine(token.startsWith('~') ? token.slice(1) : token)
  if (line !== null) return line
  const rest = token.slice(1)
  if (token.startsWith('^')) return [`>=${rest}`, `<${caretUpper(rest)}`]
  if (token.startsWith('~')) return [`>=${rest}`, `<${tildeUpper(rest)}`]
  return [token]
}

// The prefixes, longest first: `>=` has to be read before `>`, or the `=`
// becomes part of the version. A token with no operator is an exact match.
// `expandToken` gives such a token for a full version, and for a token that
// it cannot read.
const OPERATORS = ['>=', '<=', '>', '<', '='] as const

/** Whether one comparator token admits a version. */
export const evalToken = (token: string, version: string): boolean => {
  const operator = OPERATORS.find((candidate) => token.startsWith(candidate))
  const bound = operator === undefined ? token : token.slice(operator.length)
  const result = compareVersions(version, bound)
  if (operator === '>=') return result >= 0
  if (operator === '<=') return result <= 0
  if (operator === '>') return result > 0
  if (operator === '<') return result < 0
  return result === 0
}

// One end of a hyphen range, as npm's `XRANGEPLAIN` reads it: up to three
// parts, each a number or `x`, `X` or `*`, and a prerelease or build only
// after three parts. The whole alternative must be `A - B`, as npm's
// `HYPHENRANGE` is anchored at both ends.
const HYPHEN_PART = '(?:[0-9]+|[xX*])'
const HYPHEN_END = `[v=]*${HYPHEN_PART}(?:\\.${HYPHEN_PART}(?:\\.${HYPHEN_PART}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)?)?`
const HYPHEN_RANGE = new RegExp(`^(${HYPHEN_END}) - (${HYPHEN_END})$`)

/**
 * One end of a hyphen range as its comparator. A full lower end is `>=A`, and
 * a full upper end is `<=B`. A partial end, or an end with an x part, reads
 * as the line of the parts before the first x part. An end that starts with
 * an x part has no bound.
 */
const hyphenBound = (end: string, upper: boolean): string[] => {
  const version = end.replace(/^[v=]+/, '')
  const parts = version.replace(/[-+].*$/, '').split('.')
  const wild = parts.findIndex(isWild)
  const kept = wild < 0 ? parts : parts.slice(0, wild)
  if (kept.length === 0) return []
  if (kept.length === 3) return [`${upper ? '<=' : '>='}${version}`]
  return [lineOf(kept[0], kept[1])[upper ? 1 : 0]]
}

/**
 * The tokens of one alternative. An alternative that is all one hyphen range
 * `A - B` gives the comparators npm reads it as (#353). Any other alternative
 * stays as it is. A `-` in it then reads as the exact version 0.0.0, and npm
 * refuses that range.
 */
const foldHyphens = (tokens: string[]): string[] =>
  HYPHEN_RANGE.exec(tokens.join(' '))
    ?.slice(1)
    .flatMap((end, index) => hyphenBound(end, index === 1)) ?? tokens

/**
 * Whether a version is admitted by a range.
 *
 * Alternatives separated by `||` are OR'd; comparators within one are AND'd.
 * This covers every range the adapter emits (`>=X <Y`), the common forms
 * already present in real manifests, and GitHub advisory syntax
 * (`>= 7.0.0, < 7.29.0`).
 *
 * It stops where jq stops (#303). jq reads each alternative and each
 * comparator, with no early exit. So a comparator with no version, such as a
 * bare `>=`, `^`, `=` or `v`, stops it, also after a match. An alternative
 * with no comparator also stops it, for example `>=0 ||`, and so does a range
 * of white space only. This function throws in those cases. An empty range
 * has no alternative, and the answer is false. The node verbs `validate` and
 * `apply_constraint` use this function, and `rangeFacts` calls it only for a
 * range that `rangeParseable` accepted.
 */
export const satisfies = (version: string, range: string): boolean =>
  rangeAlternatives(range)
    .map((tokens) => {
      if (tokens.length === 0) {
        throw new Error(`the range '${range}' has an alternative with no comparator`)
      }
      return foldHyphens(tokens)
        .flatMap(expandToken)
        .map((token) => evalToken(token, version))
        .every(Boolean)
    })
    .some(Boolean)

/**
 * Every comparator token in a range, with the `||` groups flattened, for the
 * merge-risk scorer (issue #21).
 *
 * Flattened rather than evaluated separately because of what the callers ask:
 * the floor of a union is the lowest floor in it, and a range carrying a pin
 * in any alternative is a pinned range. Whether the version is actually
 * admitted is {@link satisfies}, which does respect alternatives.
 */
export const rangeTokens = (range: string): string[] =>
  nonEmpty(tightenOperators(range).split(FLAT_TOKEN_SEPARATOR))

/**
 * Whether a range pins. A tilde, an exact version, an x-range bounded to one
 * minor line, or an explicit upper bound. A caret is not a pin: it admits the
 * whole major line, which is the ordinary declaration, and `1.x` says the
 * same thing.
 */
export const rangePinned = (range: string): boolean =>
  rangeTokens(range).some(
    (token) =>
      token.startsWith('~') ||
      token.startsWith('<') ||
      /^=?[0-9]+\.[0-9]+\.[0-9]+/.test(token) ||
      /^=?[0-9]+\.[0-9]+\.[xX*]$/.test(token),
  )

/** Every comparator token in a range, keeping the `||` groups apart. */
export const rangeAlternatives = (range: string): string[][] =>
  splitLiteral(tightenOperators(range), '||').map((alternative) =>
    nonEmpty(alternative.split(TOKEN_SEPARATOR)),
  )

/**
 * Whether one token is a version comparator at all.
 *
 * Deliberately separate from validate's `--vulnerable` parse check, which is
 * stricter on purpose: an advisory range is copied verbatim from the API and
 * a wildcard there means the tokenizer misread it, while a manifest
 * legitimately declares `*`.
 *
 * One operator at most: a comparator, or a `^` or `~`. jq strips a
 * comparator and then a `^` or `~`, so it reads `<^5.0.0` as parseable. Its
 * evaluator then reads that token as `<0.0.0`. Here the token is unreadable
 * (#304 item 2, a declared parity exception). This changes no token that jq
 * reads right.
 */
export const tokenParseable = (token: string): boolean => {
  if (wildcardExpand(token) !== null) return true
  const bare = token.replace(/^(>=|<=|>|<|=|~|\^)/, '')
  return /^[v=]*[0-9]+(\.[0-9]+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(bare)
}

/**
 * Can this range be read at all?
 *
 * {@link satisfies} reads a token it cannot parse as a version of zero, and
 * throws on an alternative with no comparator. So a specifier like
 * `workspace:^`, `latest`, or a git URL would otherwise come back as a
 * confident "this version is not admitted" and be reported as a dependent
 * left behind. Unreadable is a third answer, and the callers return it rather
 * than guessing (review follow-up on issue #21).
 */
export const rangeParseable = (range: string): boolean => {
  const alternatives = rangeAlternatives(range)
  return (
    alternatives.length > 0 &&
    alternatives.every((alternative) => alternative.length > 0) &&
    alternatives.every((alternative) => alternative.every(tokenParseable))
  )
}

/**
 * The major of the lowest version the range admits, or `null` when it has no
 * lower bound. Upper-bound comparators are excluded: `<10` says nothing about
 * where the range starts.
 */
export const rangeFloorMajor = (range: string): number | null => {
  const majors = rangeTokens(range)
    .filter((token) => !token.startsWith('<'))
    .map((token) => token.replace(/^[><=~^v]+/, ''))
    .filter((token) => /^[0-9]/.test(token))
    .map((token) => coreAt(parseVersion(token).core, 0))
  return majors.length === 0 ? null : Math.min(...majors)
}

/**
 * What a dependent's declared range says about this version.
 *
 * The scorer needs to know how far outside a declared range a fix lands, and
 * whether the range it crossed was a pin. `parseable` is the first field to
 * read: a manifest may declare `workspace:^`, `latest`, or a git URL, none of
 * which is a version range, and reporting those as `satisfied: false` told
 * the scorer a dependent had been left behind by the fix, which is a
 * fabricated fact. When `parseable` is false every other answer is null,
 * because there is nothing to answer from. Every key is always present: a
 * caller that has to distinguish "no floor" from "field missing" cannot do it
 * if the field can also be absent.
 *
 * Known divergence: prereleases. npm's semver admits a prerelease version
 * into a range only when some comparator in the same conjunction carries a
 * prerelease on the identical [major, minor, patch] tuple, so `1.x` does not
 * admit `2.0.0-alpha` for npm while this evaluator reports `satisfied: true`
 * (it compares `2.0.0-alpha` as sorting below `2.0.0` and inside
 * `>=1.0.0 <2.0.0`). The divergence is deliberate rather than pending: the
 * exclusion rule would live in the shared {@link satisfies}, which `validate`
 * also uses against advisory ranges, where applying it would stop a
 * prerelease copy matching `< 2.0.0` and report a vulnerable copy as clean.
 * That is the unsafe direction, and the completeness check (issue #19) exists
 * precisely to prevent it. The scoring side reaches this only when a
 * `first_patched_version` is itself a prerelease, where the effect is at most
 * an understated F7, never a missed vulnerable copy.
 */
export const rangeFacts = (range: string, version: string): RangeFacts => {
  const parseable = rangeParseable(range)
  const floorMajor = rangeFloorMajor(range)
  const major = coreAt(parseVersion(version).core, 0)
  return {
    range,
    version,
    parseable,
    satisfied: parseable ? satisfies(version, range) : null,
    pinned: parseable ? rangePinned(range) : null,
    floor_major: parseable ? floorMajor : null,
    majors_ahead:
      !parseable || floorMajor === null ? null : major > floorMajor ? major - floorMajor : 0,
  }
}
