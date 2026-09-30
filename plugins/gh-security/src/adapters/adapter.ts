// The adapter contract of ADR 001, as ADR 012 amends it: one in-process
// interface for the nine read verbs of #221. Each verb is a function, and
// each answer is an envelope from `lib/envelope.ts`. The four outcomes are
// the four exit codes of ADR 001.
//
// `detect` runs once for each call site. The caller gives its answer to the
// other verbs in a `Tree`. No verb runs `detect` again.
//
// The answer types are the JSON that `node.sh` writes for each verb, with
// the same keys. A promised field is present and typed, or the verb fails.
//
// This file ships. It imports nothing outside the plugin.

import type { Envelope } from '../lib/envelope.ts'

/** The environment that `detect` reads. Only `PATH` has an effect. */
export type Environment = Readonly<Record<string, string | undefined>>

/** A tree that `detect` examined: its root, and the answer that `detect` gave. */
export type Tree<Detection> = {
  readonly root: string
  readonly detection: Detection
}

/** One installed copy of a package. */
export type ResolvedVersion = {
  readonly version: string
  /** Where the lockfile records the copy: its key or its locator. */
  readonly path: string
}

/** The `resolved_versions` answer. */
export type ResolvedVersionsAnswer = {
  readonly pm: string
  readonly package: string
  /** False only for a lockfile that holds entries, but no copy of this package. */
  readonly present: boolean
  readonly count: number
  readonly versions: readonly ResolvedVersion[]
  /** Not zero: a lockfile with no entries is a failure (ADR 001). */
  readonly lockfile_entries: number
}

/** The `resolution_map` answer. */
export type ResolutionMapAnswer = {
  readonly pm: string
  readonly lockfile_entries: number
  readonly entries_read: number
  readonly entries_expected: number
  /** Not zero means that some packages are not in the map (#48). */
  readonly unreadable_entries: number
  readonly package_count: number
  /** Each package, with its unique versions in lexical order. */
  readonly resolutions: Readonly<Record<string, readonly string[]>>
}

/** The `compare_versions` answer. The first two keys echo the arguments. */
export type CompareVersionsAnswer = {
  readonly a: string
  readonly b: string
  /** -1 when `a` is lower, 1 when `a` is higher, 0 when they are equal. */
  readonly result: -1 | 0 | 1
  readonly delta: 'major' | 'minor' | 'patch' | 'prerelease' | 'none'
  readonly major_distance: number
}

/**
 * The `range_facts` answer. Every key is always present. When `parseable`
 * is false, the last four are null (ADR 001).
 */
export type RangeFactsAnswer = {
  readonly range: string
  readonly version: string
  readonly parseable: boolean
  readonly satisfied: boolean | null
  readonly pinned: boolean | null
  readonly floor_major: number | null
  readonly majors_ahead: number | null
}

/**
 * The read verbs of one ecosystem. `Detection` is what that ecosystem's
 * `detect` finds.
 *
 * Four verbs have no answer type yet: `parents`, `why`, `declaredRanges` and
 * `listPins`. They answer `not-implemented` (ADR 001, exit 2) until the
 * second layer of #221 gives each its answer type and its body.
 */
export interface Adapter<Detection extends { readonly pm: string }> {
  /** The package manager of the tree at `root`. It reads `PATH` from `env`, and never from the process. */
  readonly detect: (root: string, env: Environment) => Envelope<Detection>
  /** Each installed copy of `pkg`, found by the name it resolves to or by its install key. */
  readonly resolvedVersions: (
    tree: Tree<Detection>,
    pkg: string,
  ) => Envelope<ResolvedVersionsAnswer>
  /** Each package in the lockfile, with its versions and the coverage of the parse. */
  readonly resolutionMap: (tree: Tree<Detection>) => Envelope<ResolutionMapAnswer>
  /** The copies that declare `pkg`. */
  readonly parents: (tree: Tree<Detection>, pkg: string) => Envelope<never>
  /**
   * Why `pkg` is in the tree. `raw` is the output of the package manager's
   * own `why` command. When it is absent, the verb runs that command (#221,
   * round 3 ruling 2).
   */
  readonly why: (tree: Tree<Detection>, pkg: string, raw?: string) => Promise<Envelope<never>>
  /** The ranges that the dependents of `pkg` declare, on one major `line` or on all when null. */
  readonly declaredRanges: (
    tree: Tree<Detection>,
    pkg: string,
    line: number | null,
  ) => Envelope<never>
  /** Each constraint that the manifest declares. */
  readonly listPins: (tree: Tree<Detection>) => Envelope<never>
  /** How `a` and `b` compare, in this ecosystem's version rules. */
  readonly compareVersions: (a: string, b: string) => Envelope<CompareVersionsAnswer>
  /** What `range` says about `version`, in this ecosystem's range rules. */
  readonly rangeFacts: (range: string, version: string) => Envelope<RangeFactsAnswer>
}
