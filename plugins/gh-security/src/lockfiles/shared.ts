// The answer shapes the three lockfile readers share, and the parse guard
// that every one of them applies (`guard_parse` in node.sh).
//
// This file ships. It imports nothing outside the plugin.

/** How much of the lockfile a reader could read. */
export type Coverage = {
  /** Every entry the lockfile holds: `lockfile_entries`. */
  readonly entries: number
  /** The entries the reader must read: `entries_expected`. */
  readonly expected: number
  /** The entries the reader did read, kept or deliberately excluded: `entries_read`. */
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
  /** Unique, and sorted by version and then path. */
  readonly copies: readonly ResolvedCopy[]
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
  constructor(message: string) {
    super(message)
    this.name = 'LockfileError'
  }
}
