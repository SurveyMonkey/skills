// Range evaluation for the node adapter, ported from the `SEMVER_JQ` heredoc
// in `scripts/ecosystems/node.sh` (lines 83-289) and from what the
// `range_facts` verb (node.sh line 3429) answers with, under RFC 002.
//
// The jq semantics are kept exactly. That includes the known divergence from
// npm's semver, which is documented on `rangeFacts` below and is deliberate
// rather than pending.
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

// `[[:space:]]` as Oniguruma reads it, spelled out rather than written `\s`,
// which in JavaScript also matches Unicode separators the jq original never
// did. The comma joins it wherever a range is tokenized, because a GitHub
// advisory separates comparators with one (">= 7.0.0, < 7.29.0").
const SPACE = ' \\t\\n\\v\\f\\r'
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

/** A token as the comparators it stands for. */
export const expandToken = (token: string): string[] => {
  const wildcard = wildcardExpand(token)
  if (wildcard !== null) return wildcard
  const rest = token.slice(1)
  if (token.startsWith('^')) return [`>=${rest}`, `<${caretUpper(rest)}`]
  if (token.startsWith('~')) return [`>=${rest}`, `<${tildeUpper(rest)}`]
  return [token]
}

// The prefixes, longest first: `>=` has to be read before `>`, or the `=`
// becomes part of the version. A token with no operator is an exact match.
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

/**
 * Whether a version is admitted by a range.
 *
 * Alternatives separated by `||` are OR'd; comparators within one are AND'd.
 * This covers every range the adapter emits (`>=X <Y`), the common forms
 * already present in real manifests, and GitHub advisory syntax
 * (`>= 7.0.0, < 7.29.0`).
 */
export const satisfies = (version: string, range: string): boolean =>
  splitLiteral(tightenOperators(range), '||').some((alternative) =>
    nonEmpty(alternative.split(TOKEN_SEPARATOR))
      .flatMap(expandToken)
      .every((token) => evalToken(token, version)),
  )

/**
 * Every comparator token in a range, with the `||` groups flattened.
 *
 * Flattened rather than evaluated separately because of what the callers ask:
 * the floor of a union is the lowest floor in it, and a range carrying a pin
 * in any alternative is a pinned range. Whether the version is actually
 * admitted is {@link satisfies}, which does respect alternatives.
 */
export const rangeTokens = (range: string): string[] =>
  nonEmpty(tightenOperators(range).split(FLAT_TOKEN_SEPARATOR))

/**
 * Whether a range pins, for the merge-risk scorer (issue #21). A tilde, an
 * exact version, an x-range bounded to one minor line, or an explicit upper
 * bound. A caret is not a pin: it admits the whole major line, which is the
 * ordinary declaration, and `1.x` says the same thing.
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
 */
export const tokenParseable = (token: string): boolean => {
  if (wildcardExpand(token) !== null) return true
  const bare = token.replace(/^(>=|<=|>|<|=)/, '').replace(/^[~^]/, '')
  return /^[v=]*[0-9]+(\.[0-9]+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(bare)
}

/**
 * Can this range be read at all?
 *
 * {@link satisfies} answers false for a token it cannot parse, so a specifier
 * like `workspace:^`, `latest`, or a git URL would otherwise come back as a
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
