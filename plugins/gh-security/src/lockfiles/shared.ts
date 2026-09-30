// The answer shapes the three lockfile readers share, the parse guard that
// all of them apply (`guard_parse` in node.sh), and the small text rules that
// more than one reader uses.
//
// This file ships. It imports nothing outside the plugin.

/** The package manager a reader names in a refusal. */
export type Pm = 'npm' | 'pnpm' | 'yarn'

/** How much of the lockfile a reader could read. */
export type Coverage = {
  /** Every entry the lockfile holds: `lockfile_entries`. */
  readonly entries: number
  /** The entries the reader must read: `entries_expected`. */
  readonly expected: number
  /** The entries the reader read, out of those it must read: `entries_read`. */
  readonly read: number
}

/** One installed copy of a package. */
export type ResolvedCopy = {
  readonly version: string
  /** Where the lockfile records the copy: its key or its locator. */
  readonly path: string
}

export type ResolvedVersions = {
  readonly coverage: Coverage
  /** Unique. Sorted as text by version joined to path, not in semver order. */
  readonly copies: readonly ResolvedCopy[]
}

/** One package at one version, before the map groups them. */
export type Resolution = {
  readonly package: string
  readonly version: string
}

export type ResolutionMap = {
  readonly coverage: Coverage
  /** Each package, with its unique versions in lexical order. */
  readonly resolutions: Readonly<Record<string, readonly string[]>>
}

/** A package that declares the one asked about. */
export type Parent = {
  readonly name: string
  /** The registry version of this copy, or `null` for a local, git or URL target. */
  readonly version: string | null
}

/** The lockfile is one this module refuses to describe. */
export class LockfileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LockfileError'
  }
}

/**
 * Refuse a lockfile the reader understands too little of, with the words of
 * `guard_parse`. Zero entries is a parser that matched nothing. A read share
 * below half is a parser that describes a tree it mostly cannot see.
 */
export const guarded = (pm: Pm, coverage: Coverage): Coverage => {
  if (coverage.entries === 0) {
    throw new LockfileError(
      `Parsed 0 entries from the lockfile for pm '${pm}'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result.`,
    )
  }
  if (coverage.expected > 0 && coverage.read * 2 < coverage.expected) {
    throw new LockfileError(
      `Read ${coverage.read} of ${coverage.expected} lockfile entries for pm '${pm}'. The parser understands too little of this lockfile to describe the tree; refusing to report a mostly-unparsed lockfile as a clean result.`,
    )
  }
  return coverage
}

// Code unit order, which is the order of jq's `sort` for these names.
const byText = (a: string, b: string): number => Number(a > b) - Number(a < b)

/** `unique_by(.version + .path)`: one copy per key, sorted by that key. */
export const uniqueCopies = (copies: readonly ResolvedCopy[]): ResolvedCopy[] =>
  [...new Map(copies.map((copy) => [copy.version + copy.path, copy]))]
    .sort(([a], [b]) => byText(a, b))
    .map(([, copy]) => copy)

/** Group the pairs by package, each with its unique versions in lexical order. */
export const groupResolutions = (
  pairs: readonly Resolution[],
): Readonly<Record<string, readonly string[]>> => {
  const grouped = new Map<string, Set<string>>()
  for (const pair of pairs) {
    grouped.set(pair.package, (grouped.get(pair.package) ?? new Set()).add(pair.version))
  }
  return Object.fromEntries(
    [...grouped].map(([name, versions]) => [name, [...versions].sort(byText)]),
  )
}

/** One entry per parent copy. Sorted as text by name and version, not in semver order. */
export const uniqueParents = (found: readonly Parent[]): readonly Parent[] =>
  [...new Map(found.map((parent) => [JSON.stringify([parent.name, parent.version]), parent]))]
    .sort(([a], [b]) => byText(a, b))
    .map(([, parent]) => parent)

/**
 * The package an `npm:` alias names (`NPM_ALIAS_TARGET`), or `null` for a
 * specifier that is not an alias. `npm:lodash@^4.18.0` names `lodash`. With
 * no `@` after the first character, the whole rest is the name.
 */
export const aliasTarget = (specifier: string): string | null => {
  if (!specifier.startsWith('npm:')) return null
  const rest = specifier.slice(4)
  const at = rest.lastIndexOf('@')
  return at <= 0 ? rest : rest.slice(0, at)
}

/** The text before the first `separator`, or all of it when there is none. */
export const before = (text: string, separator: string): string =>
  text.slice(0, (text + separator).indexOf(separator))
