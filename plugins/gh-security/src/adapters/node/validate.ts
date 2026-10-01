// `validate` for the node adapter, ported from `verb_validate` in node.sh
// (#222). The bash there is the specification.
//
// The verb answers three questions (issues #19 and #83):
//
//   1. Constraint: does each copy on `line` satisfy `range`?
//   2. Completeness: does any copy still match a `vulnerable` range?
//   3. Collateral: did a copy on another major line move after `baseline`?
//
// The verb refuses its options before it reads the lockfile, in the order of
// node.sh. `--sibling-alerts` reclassifies a move as `benign_dedup` only for
// the one shape of #105. A sibling range that cannot be read makes each move
// `fatal`, and is no refusal. The verb only reads, and it does not run
// `detect`. The verdict is `ok` in the answer: node.sh writes the answer and
// exits 1 when `ok` is false.
//
// This file ships. It imports nothing outside the plugin.

import { type Envelope, failed } from '../../lib/envelope.ts'
import { evalToken, expandToken, rangeAlternatives } from '../../semver/ranges.ts'
import { coreAt, parseVersion, semverMax } from '../../semver/versions.ts'
import type { ResolvedVersionsAnswer, Tree, ValidateAnswer, ValidateOptions } from '../adapter.ts'
import { attempt } from './attempt.ts'
import type { NodeDetection } from './detect.ts'
import { resolvedVersions } from './lockfiles.ts'
import { isRecord } from './manifest.ts'
import { byText } from './parents.ts'

type Copy = ResolvedVersionsAnswer['versions'][number]

type Sibling = { readonly major: number | null; readonly vulnerable_ranges: readonly string[] }

type Move = NonNullable<ValidateAnswer['other_line_moves']>[number]

/**
 * jq's `satisfies`, with the two places where jq stops. jq evaluates each
 * alternative and each comparator, so a comparator that it cannot read
 * stops it, even after another one matches. An alternative with no
 * comparator also stops it. `satisfies` in `src/semver/ranges.ts` answers in
 * both cases, so a constraint like `>=0 ||` would pass there.
 */
const satisfiesAll = (version: string, range: string): boolean =>
  rangeAlternatives(range)
    .map((tokens) => {
      if (tokens.length === 0) {
        throw new Error(`validate: the range '${range}' has an alternative with no comparator`)
      }
      return tokens
        .flatMap(expandToken)
        .map((token) => evalToken(token, version))
        .every(Boolean)
    })
    .some(Boolean)

// `token_ok` of node.sh: a comparator with a known operator and a version
// that parses. A wildcard is not accepted here, as it is in `range_facts`.
const STRICT_TOKEN = /^[v=]*[0-9]+(\.[0-9]+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

const tokenOk = (token: string): boolean =>
  STRICT_TOKEN.test(token.replace(/^(>=|<=|>|<|=)/, '').replace(/^[~^]/, ''))

/** `range_ok` of node.sh: the strict parse of an advisory range. */
const rangeOk = (range: string): boolean => {
  const alternatives = rangeAlternatives(range)
  return (
    alternatives.length > 0 &&
    alternatives.every((tokens) => tokens.length > 0) &&
    alternatives.every((tokens) => tokens.every(tokenOk))
  )
}

/** `major_of` of node.sh: the first core number, or 0. It throws for an empty version. */
const majorOf = (version: string): number => coreAt(parseVersion(version).core, 0)

/** Unique, and sorted as jq's `unique` sorts. */
const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort(byText)

// jq reads a byte order mark at the start of its input. `JSON.parse` does not.
const BYTE_ORDER_MARK = /^﻿/

/**
 * The one JSON document in `text`, or `undefined`. jq slurps the text, and
 * the verb refuses any count of documents but one. `JSON.parse` refuses
 * every text that is not one document. jq also reads `nan` and a number too
 * large for a double, and `JSON.parse` does not. There the verb refuses
 * where bash answers: a declared divergence, in the safe direction.
 */
const documentOf = (text: string): unknown => {
  try {
    return JSON.parse(text.replace(BYTE_ORDER_MARK, '')) as unknown
  } catch {
    return undefined
  }
}

/**
 * The versions of a baseline that keeps the `resolved_versions` contract for
 * `pkg`, or null. An absent key reads as `undefined`, which fails each test
 * here, so jq's `has` needs no test of its own.
 */
const baselineVersions = (text: string, pkg: string): readonly string[] | null => {
  const baseline = documentOf(text)
  if (!isRecord(baseline) || baseline.package !== pkg || !Array.isArray(baseline.versions)) {
    return null
  }
  const versions = baseline.versions.map((entry: unknown) =>
    isRecord(entry) ? entry.version : undefined,
  )
  return versions.every((version) => typeof version === 'string') ? (versions as string[]) : null
}

/**
 * A whole number of zero or more, or null. jq accepts `-0` and `2.0` too,
 * and so does this test. An absent major is `undefined`, which fails.
 */
const isMajor = (value: unknown): boolean =>
  value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)

/** The sibling alerts of `text`, when it is one array of `{major, vulnerable_ranges}`, or null. */
const siblingsOf = (text: string): readonly Sibling[] | null => {
  const siblings = documentOf(text)
  if (!Array.isArray(siblings)) return null
  const usable = siblings.every(
    (entry: unknown) =>
      isRecord(entry) &&
      isMajor(entry.major) &&
      Array.isArray(entry.vulnerable_ranges) &&
      entry.vulnerable_ranges.every((range: unknown) => typeof range === 'string'),
  )
  return usable ? (siblings as Sibling[]) : null
}

const LINE_NEEDS_VULNERABLE =
  "validate: --line requires at least one --vulnerable range. Pass every distinct vulnerable_range from the group's alerts; without them the completeness check has nothing to check and would pass a partial fix (issue #19)."

const BASELINE_NEEDS_LINE =
  'validate: --baseline requires --line. A cross-line move is defined against the line this group owns; with no line to exclude, every move looks like collateral (issue #83).'

const SIBLINGS_NEED_BASELINE =
  'validate: --sibling-alerts requires --baseline. Sibling-alert knowledge only reclassifies moves the baseline comparison found; with no baseline there are no moves to classify (issue #105).'

const UNUSABLE_SIBLINGS =
  "validate: --sibling-alerts is not a usable sibling-alert list. Pass one JSON array of {major, vulnerable_ranges[]} objects, major a number or null for a line with no usable major, from the group's sibling_alerts field. A list nobody could read must be an error, never a silent reclassification either way (issue #105)."

const unusableBaseline = (pkg: string): string =>
  `validate: --baseline is not a usable pre-fix baseline for '${pkg}'. Pass the phase 3 'resolved_versions ${pkg}' output verbatim: a JSON object whose .package is '${pkg}' and whose .versions is an array of objects each carrying a string .version. A baseline that is truncated, or captured for another package, would report no cross-line moves at all (issue #83).`

const unreadableRange = (range: string): string =>
  `validate: --vulnerable range '${range}' is not a parseable version range. Copy the alert's vulnerable_range verbatim; an unreadable range would silently mark every resolved copy as not vulnerable.`

/**
 * The first refusal of the arguments, or null. node.sh refuses an empty flag
 * value while it reads the flags (`${2:?}`), and then the rest in this order.
 */
const argumentRefusal = (pkg: string, range: string, options: ValidateOptions): string | null => {
  const { line, vulnerable, baseline, siblingAlerts } = options
  if (line === '') return '--line requires a major'
  if (baseline === '') return '--baseline requires the pre-fix resolved_versions JSON'
  if (siblingAlerts === '') return '--sibling-alerts requires a JSON array of sibling-alert objects'
  if (vulnerable.includes('')) return '--vulnerable requires a range'
  if (pkg === '') return 'validate requires a package name'
  if (range === '') return 'validate requires a range'
  if (line !== null && !/^[0-9]+$/.test(line)) {
    return `validate: --line must be a major number, got '${line}'`
  }
  if (line !== null && vulnerable.length === 0) return LINE_NEEDS_VULNERABLE
  if (baseline !== null && line === null) return BASELINE_NEEDS_LINE
  if (siblingAlerts !== null && baseline === null) return SIBLINGS_NEED_BASELINE
  return null
}

/** What the checks read, after each refusal has passed. */
type Inputs = {
  readonly range: string
  /** The text of `--line`, which the answer echoes. */
  readonly lineText: string | null
  readonly line: number | null
  /** The vulnerable ranges: each line of each flag, unique and sorted. */
  readonly vulnerable: readonly string[]
  readonly baseline: readonly string[] | null
  readonly siblings: readonly Sibling[] | null
  /** A sibling range does not parse. Each move is then `fatal`. */
  readonly siblingsUnreadable: boolean
}

/** The inputs of the checks, or the refusal of node.sh for a baseline, a range or a sibling list. */
const inputsOf = (
  pkg: string,
  range: string,
  options: ValidateOptions,
): { readonly inputs: Inputs } | { readonly refusal: string } => {
  const baseline = options.baseline === null ? null : baselineVersions(options.baseline, pkg)
  if (options.baseline !== null && baseline === null) return { refusal: unusableBaseline(pkg) }
  // node.sh joins the flags with newlines, then splits the text at them.
  const vulnerable = uniqueSorted(
    options.vulnerable.flatMap((text) => text.split('\n')).filter((text) => text !== ''),
  )
  const badRange = vulnerable.find((text) => !rangeOk(text))
  if (badRange !== undefined) return { refusal: unreadableRange(badRange) }
  const siblings = options.siblingAlerts === null ? null : siblingsOf(options.siblingAlerts)
  if (options.siblingAlerts !== null && siblings === null) return { refusal: UNUSABLE_SIBLINGS }
  return {
    inputs: {
      range,
      lineText: options.line,
      line: options.line === null ? null : Number(options.line),
      vulnerable,
      baseline,
      siblings,
      // node.sh writes the first unreadable sibling range with `jq -r`, and
      // tests the text for length. So when that first range is empty, it
      // finds no unreadable range, and the move can be benign. That breaks
      // its own rule that an unreadable range never allows benign. Here an
      // empty range is unreadable, as `range_ok` says: a declared divergence
      // (#222), in the safe direction.
      siblingsUnreadable: (siblings ?? []).some(({ vulnerable_ranges }) =>
        vulnerable_ranges.some((text) => !rangeOk(text)),
      ),
    },
  }
}

/**
 * The class of one move (#105). `benign_dedup` only when each test holds:
 * every sibling range parses, sibling alerts were given, the line moved and
 * did not vanish, one version is left, that version was in the baseline and
 * is its semver max, no sibling alert is on this major, and no sibling range
 * matches a version on either side. The first test that fails makes it
 * `fatal`. A vanished line has no version left, and `semverMax` answers a
 * version of the baseline. So the test of the max also does two tests of
 * node.sh: `status` and "in the baseline".
 */
const classOf = (
  { siblings, siblingsUnreadable }: Inputs,
  move: Omit<Move, 'class'>,
): Move['class'] => {
  if (siblingsUnreadable || siblings === null) return 'fatal'
  const [landed, ...more] = move.after
  if (more.length > 0 || landed !== semverMax(move.before)) return 'fatal'
  if (siblings.some(({ major }) => major === move.major)) return 'fatal'
  const hit = [...move.before, ...move.after].some((version) =>
    siblings.some(({ vulnerable_ranges }) =>
      vulnerable_ranges.some((range) => satisfiesAll(version, range)),
    ),
  )
  return hit ? 'fatal' : 'benign_dedup'
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

/**
 * Each major line of the baseline, other than `line`, whose set of versions
 * changed, in the order of its major. A major that the baseline does not
 * hold is no move: the install added that copy.
 */
const movesOf = (
  inputs: Inputs,
  baseline: readonly string[],
  copies: readonly Copy[],
): readonly Move[] => {
  const byMajor = new Map<number, string[]>()
  for (const version of baseline) {
    const major = majorOf(version)
    if (major !== inputs.line) byMajor.set(major, [...(byMajor.get(major) ?? []), version])
  }
  return [...byMajor.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([major, versions]): Move[] => {
      const before = uniqueSorted(versions)
      const after = uniqueSorted(
        copies.filter(({ version }) => majorOf(version) === major).map(({ version }) => version),
      )
      if (sameList(before, after)) return []
      const move = {
        major,
        before,
        after,
        status: after.length === 0 ? ('vanished' as const) : ('moved' as const),
      }
      return [{ ...move, class: classOf(inputs, move) }]
    })
}

/** The answer, from the copies that `resolved_versions` found. It throws where jq stops. */
const answerOf = (inputs: Inputs, resolved: ResolvedVersionsAnswer): ValidateAnswer => {
  const { line, lineText, range, vulnerable, baseline } = inputs
  const copies = resolved.versions.map(({ version, path }) => ({ version, path }))
  const inline = copies.filter(({ version }) => line === null || majorOf(version) === line)
  const violations = inline.filter(({ version }) => !satisfiesAll(version, range))
  const alerted = copies.flatMap(({ version, path }) => {
    const hits = vulnerable.filter((text) => satisfiesAll(version, text))
    if (hits.length === 0) return []
    const below = line !== null && majorOf(version) < line
    return [{ below, copy: { version, path, vulnerable_ranges: hits } }]
  })
  const unresolved = alerted.filter(({ below }) => !below).map(({ copy }) => copy)
  const moves = baseline === null ? null : movesOf(inputs, baseline, copies)
  const linePresent = line === null || inline.length > 0
  return {
    ok:
      violations.length === 0 &&
      unresolved.length === 0 &&
      linePresent &&
      (moves === null || moves.every((move) => move.class !== 'fatal')),
    package: resolved.package,
    range,
    line: lineText,
    line_present: linePresent,
    checked: inline.length,
    resolved_count: resolved.count,
    violations,
    unresolved_alerts: unresolved,
    requires_major_bump: alerted.filter(({ below }) => below).map(({ copy }) => copy),
    other_line_moves: moves,
    resolved_versions: uniqueSorted(copies.map(({ version }) => version)),
  }
}

/** `verb_validate`. */
export const validate = (
  tree: Tree<NodeDetection>,
  pkg: string,
  range: string,
  options: ValidateOptions,
): Envelope<ValidateAnswer> => {
  const refusal = argumentRefusal(pkg, range, options)
  if (refusal !== null) return failed(refusal)
  const read = inputsOf(pkg, range, options)
  if ('refusal' in read) return failed(read.refusal)
  const resolved = resolvedVersions(tree, pkg)
  if (resolved.outcome !== 'ok') return resolved
  if (!resolved.value.present) {
    return failed(
      `validate: '${pkg}' resolves to no versions in the lockfile. Nothing to validate.`,
    )
  }
  return attempt(() => answerOf(read.inputs, resolved.value))
}
