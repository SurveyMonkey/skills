// Version comparison for the node adapter, ported from the `SEMVER_JQ`
// heredoc in `scripts/ecosystems/node.sh` (lines 83-289) under RFC 002.
//
// The jq semantics are kept exactly, including the ones that differ from
// node-semver: a version string is read leniently (leading `v` or `=`,
// surrounding whitespace, build metadata, a missing patch or minor), a core
// component that is not a number reads as 0, and a non-numeric prerelease
// identifier compares as a string against another non-numeric one while
// sorting above any numeric one. The bash implementation is authoritative
// until it is retired, so a disagreement here is a defect here.
//
// This file ships. It imports nothing outside the plugin and stays inside the
// erasable subset (no `enum`, no parameter properties, no namespaces),
// because node strips the types rather than compiling them (ADR 012).

/** A version read into the two halves that order it. */
export type ParsedVersion = {
  /** The dot-separated numeric core, as written: not padded to three. */
  readonly core: readonly number[]
  /** The dot-separated prerelease identifiers, or `[]` for a release. */
  readonly pre: readonly string[]
}

/** The classification `semver_delta` answers with. */
export type VersionDelta = 'major' | 'minor' | 'patch' | 'prerelease' | 'none'

/** `-1` when the left version sorts lower, `1` when higher, `0` when equal. */
export type Ordering = -1 | 0 | 1

/** Thrown for a version string there is nothing to compare in. */
export class SemverParseError extends Error {
  constructor(message: string) {
    super(message)
    // Set explicitly rather than inherited: `Error` names itself after its
    // own constructor, so without this the error is reported as a plain
    // `Error` and says nothing about where it came from.
    this.name = 'SemverParseError'
  }
}

// jq's `split/1` on an empty string is `[]`, not `[""]`, and that difference
// is load-bearing below: it is what makes an empty version a hard error
// rather than a silent 0.0.0.
const splitLiteral = (value: string, separator: string): string[] =>
  value === '' ? [] : value.split(separator)

// `[[:space:]]` as Oniguruma reads it, spelled out rather than written `\s`,
// which in JavaScript also matches a pile of Unicode separators the jq
// original never did.
const SPACE = ' \\t\\n\\v\\f\\r'
const LEADING_SPACE = new RegExp(`^[${SPACE}]+`)
const TRAILING_SPACE = new RegExp(`[${SPACE}]+$`)

/**
 * Read a version string into its core and prerelease halves, the way
 * `semver_parse` does.
 *
 * An empty version is a hard error. jq aborts the whole program there (the
 * `split` of a null), and the answer that would replace the abort is a
 * confident `0.0.0` for a version nobody supplied, which is the
 * silent-success shape this plugin refuses everywhere else.
 */
export const parseVersion = (version: string): ParsedVersion => {
  const trimmed = version
    .replace(LEADING_SPACE, '')
    .replace(TRAILING_SPACE, '')
    .replace(/^[v=]+/, '')
  // Build metadata is dropped before anything else, so `1.0.0+build.1` and
  // `1.0.0` compare equal (semver.org section 10).
  const withoutBuild = splitLiteral(trimmed, '+')[0] ?? ''
  const parts = splitLiteral(withoutBuild, '-')
  const core = parts[0]
  if (core === undefined) {
    throw new SemverParseError(`"${version}" is not a version this adapter can read.`)
  }
  return {
    // `tonumber? // 0`: a component that is not a number reads as 0 rather
    // than removing itself from the comparison.
    core: splitLiteral(core, '.').map((part) => {
      const parsed = Number(part)
      return Number.isFinite(parsed) ? parsed : 0
    }),
    // The prerelease is everything after the first hyphen, rejoined, so an
    // identifier containing a hyphen survives it. `splitLiteral`, not `.split`
    // directly: an empty prerelease segment (a version ending in a bare `-`)
    // has to read as [] the same way the empty-string case above does, or
    // "1.2.3-" stops comparing equal to "1.2.3" the way jq's `semver_cmp`
    // does.
    pre: parts.length > 1 ? splitLiteral(parts.slice(1).join('-'), '.') : [],
  }
}

const cmpNum = (a: number, b: number): Ordering => (a < b ? -1 : a > b ? 1 : 0)

/**
 * One core component, or 0 where the version did not write it: `1` and
 * `1.0.0` are the same version, and jq spelled that `$c[i] // 0` at every
 * site that reads one. Exported because the range side reads core components
 * the same way.
 */
export const coreAt = (core: readonly number[], index: number): number => core[index] ?? 0

// Only the first three components order a version; anything beyond them is
// not semver, and jq never looked past them either.
const cmpCore = (a: readonly number[], b: readonly number[]): Ordering => {
  for (let i = 0; i < 3; i += 1) {
    const result = cmpNum(coreAt(a, i), coreAt(b, i))
    if (result !== 0) return result
  }
  return 0
}

// jq's `tonumber` over the alphabet a prerelease identifier can use
// ([0-9A-Za-z-], with `.` reserved as the separator): an optional sign,
// digits, and an optional exponent. The one spelling in that alphabet where
// this and `tonumber` part company is `Infinity`, which jq reads as a number
// and no published version carries as an identifier.
const NUMERIC_IDENTIFIER = /^[+-]?\d+(?:[eE][+-]?\d+)?$/

const asNumericIdentifier = (value: string): number | null =>
  NUMERIC_IDENTIFIER.test(value) ? Number(value) : null

// semver.org section 11: numeric identifiers compare numerically, and a
// numeric identifier always has lower precedence than an alphanumeric one.
// The `null` guards are the reason the ordering chain is a fixture at all:
// jq's `tonumber?` emits *empty* rather than null for a non-numeric
// identifier, which dropped the identifier from the comparison entirely and
// reversed `rc.1` against `beta.11`.
const cmpId = (x: string, y: string): Ordering => {
  const nx = asNumericIdentifier(x)
  const ny = asNumericIdentifier(y)
  if (nx !== null && ny !== null) return cmpNum(nx, ny)
  if (nx !== null) return -1
  if (ny !== null) return 1
  return x < y ? -1 : x > y ? 1 : 0
}

const cmpPre = (a: readonly string[], b: readonly string[]): Ordering => {
  // A release outranks any prerelease of the same core (semver.org 11).
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i]
    const right = b[i]
    // A shorter identifier list sorts below the longer one it prefixes.
    if (left === undefined) return -1
    if (right === undefined) return 1
    const result = cmpId(left, right)
    if (result !== 0) return result
  }
  return 0
}

/** Order two versions, the way `semver_cmp` does. */
export const compareVersions = (a: string, b: string): Ordering => {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const core = cmpCore(pa.core, pb.core)
  return core !== 0 ? core : cmpPre(pa.pre, pb.pre)
}

/** How far apart the major lines of two versions are, always non-negative. */
export const majorDistance = (a: string, b: string): number => {
  const ma = coreAt(parseVersion(a).core, 0)
  const mb = coreAt(parseVersion(b).core, 0)
  return ma > mb ? ma - mb : mb - ma
}

/**
 * Classify the move from `a` to `b`, the way `semver_delta` does.
 *
 * It saturates at `major`: two lines apart and one line apart are both
 * `major`, and {@link majorDistance} is what tells them apart (issue #21).
 */
export const semverDelta = (a: string, b: string): VersionDelta => {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (cmpCore(pa.core, pb.core) !== 0) {
    if (coreAt(pa.core, 0) !== coreAt(pb.core, 0)) return 'major'
    if (coreAt(pa.core, 1) !== coreAt(pb.core, 1)) return 'minor'
    return 'patch'
  }
  return cmpPre(pa.pre, pb.pre) !== 0 ? 'prerelease' : 'none'
}

/**
 * The semver-largest of a list of versions, or `null` for an empty list.
 *
 * Ranking goes through {@link compareVersions}, never lexicographic
 * ordering: `2.3.10` sorts below `2.3.2` as a string and above it as a
 * version, and the callers use the answer to decide whether a dedup landed
 * on a baseline max.
 */
export const semverMax = (versions: readonly string[]): string | null =>
  versions.reduce<string | null>(
    (best, version) => (best === null || compareVersions(version, best) > 0 ? version : best),
    null,
  )

/** The answer shape the `compare_versions` verb reports (node.sh line 33). */
export type VersionFacts = {
  readonly result: Ordering
  readonly delta: VersionDelta
  readonly major_distance: number
}

/**
 * Everything the `compare_versions` verb answers about a pair of versions.
 * The verb wrapping this adds the echoed inputs and nothing else (#221).
 */
export const versionFacts = (a: string, b: string): VersionFacts => ({
  result: compareVersions(a, b),
  delta: semverDelta(a, b),
  major_distance: majorDistance(a, b),
})
