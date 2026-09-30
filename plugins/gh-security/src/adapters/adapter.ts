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
// `parents` is not a verb of `node.sh`. It is new in #221, from the parent
// readers inside `node.sh`.
//
// This file ships. It imports nothing outside the plugin.

import type { Envelope } from '../lib/envelope.ts'
import type { Runner } from '../lib/process.ts'

/**
 * The environment that `detect` reads, and that `why` gives to the package
 * manager that it starts. The node `detect` reads only `PATH`.
 */
export type Environment = Readonly<Record<string, string | undefined>>

/** A tree that `detect` examined: its root, and the answer that `detect` gave. */
export type Tree<Detection> = {
  /** An absolute path. */
  readonly root: string
  readonly detection: Detection
}

/** One installed copy of a package. */
type ResolvedVersion = {
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

/** A copy that declares a package, and the version that the lockfile records for it. */
type ParentCopy = {
  readonly name: string
  /** Null when the lockfile records no version for this copy, as for a git target. */
  readonly version: string | null
}

/** The `parents` answer. No verb of node.sh writes it. */
export type ParentsAnswer = {
  readonly pm: string
  readonly package: string
  /** Sorted as text by name and then version. The root is never a parent. */
  readonly parents: readonly ParentCopy[]
}

/** The `why` answer. */
export type WhyAnswer = {
  readonly pm: string
  readonly package: string
  /** `direct` when the root manifest declares the package in any of its four blocks. */
  readonly relationship: 'direct' | 'transitive'
  /** The root declares the package in `devDependencies` and not in `dependencies`. */
  readonly dev_only: boolean
  /** The names of the parents, unique and sorted as text. */
  readonly parents: readonly string[]
  readonly parent_count: number
  /**
   * True when no override can move the package: pnpm resolves it only as a
   * peer (#103). Always false outside a pnpm lockfileVersion 9 lockfile.
   */
  readonly peer_only: boolean
  /** The parents whose snapshot key has the package as a peer: required peers first. */
  readonly peer_parents: readonly string[]
  /** The parents in `peer_parents` that reach the package only as an optional peer. */
  readonly optional_peer_parents: readonly string[]
  /** The output of the package manager's own `why` command, with no trailing newline. */
  readonly raw: string
}

/**
 * Where `why` gets its `raw` text. `raw` is the output that the package
 * manager's own `why` command wrote. Without it, the verb runs that command
 * in the tree with `run`, in the environment `env`.
 */
export type WhySource =
  | { readonly raw: string }
  | { readonly run: Runner; readonly env: Environment }

/** The `declared_ranges` answer. Each list of parents names each parent once. */
export type DeclaredRangesAnswer = {
  readonly pm: string
  readonly package: string
  /** The major line that the answer is limited to, or null for all lines. */
  readonly line: number | null
  /** Unique and sorted as text. The root range is one of them. */
  readonly ranges: readonly string[]
  /** The range that the root manifest declares, or null. */
  readonly root_range: string | null
  readonly parents_read: readonly string[]
  /** Read, but they declare the package in no block. */
  readonly parents_without_range: readonly string[]
  /** No declaration could be read. The root copy is never in this list. */
  readonly parents_unreadable: readonly string[]
  /** The subset of `parents_unreadable` whose manifest is on disk but does not parse. */
  readonly parents_malformed: readonly string[]
  /** On a different line than `line`: `name` or `name@version`, and `__root__` for the root. */
  readonly parents_other_lines: readonly string[]
}

/** A value in an override block: any JSON value. */
export type PinValue =
  | string
  | number
  | boolean
  | null
  | readonly PinValue[]
  | { readonly [key: string]: PinValue }

/** One constraint in an override block (ADR 001, `list_pins`). */
export type Pin = {
  /** The key in the block. For npm, the first key of the path. */
  readonly key: string
  /** The parents and then the target, each without splits inside. For npm, every key down to the leaf. */
  readonly path: readonly string[]
  /** The target without its version selector. */
  readonly package: string
  /** The version selector after the last `@` of the target, or null. */
  readonly selector: string | null
  readonly parents: readonly string[]
  readonly scope: 'bare' | 'scoped'
  readonly value: PinValue
  /** Only `range` is a version pin. */
  readonly kind: 'range' | 'alias' | 'protocol' | 'reference' | 'unparseable'
  /** The value, when `kind` is `range`. Else null. */
  readonly range: string | null
  /** The package that an `npm:` value names, when `kind` is `alias`. Else null. */
  readonly alias_package: string | null
  /** The version after the last `@` of an `npm:` value, or null. */
  readonly alias_range: string | null
}

/** The `list_pins` answer. */
export type ListPinsAnswer = {
  readonly pm: string
  readonly override_location: string
  readonly override_file: string
  /** False when the file has no override block. An empty block is present. */
  readonly block_present: boolean
  readonly count: number
  readonly bare_count: number
  /**
   * The keys that `pnpm.overrides` of package.json holds when the override
   * file is `pnpm-workspace.yaml`. pnpm 11 ignores them. Else empty.
   */
  readonly manifest_pnpm_overrides: readonly string[]
  readonly pins: readonly Pin[]
}

/**
 * The read verbs of one ecosystem. `Detection` is what that ecosystem's
 * `detect` finds.
 */
export interface Adapter<Detection extends { readonly pm: string }> {
  /**
   * The package manager of the tree at `root`, an absolute path. It reads
   * `PATH` from `env`, and never from the process.
   */
  readonly detect: (root: string, env: Environment) => Envelope<Detection>
  /** Each installed copy of `pkg`, found by the name it resolves to or by its install key. */
  readonly resolvedVersions: (
    tree: Tree<Detection>,
    pkg: string,
  ) => Envelope<ResolvedVersionsAnswer>
  /** Each package in the lockfile, with its versions and the coverage of the parse. */
  readonly resolutionMap: (tree: Tree<Detection>) => Envelope<ResolutionMapAnswer>
  /** The copies that declare `pkg`. */
  readonly parents: (tree: Tree<Detection>, pkg: string) => Envelope<ParentsAnswer>
  /**
   * Why `pkg` is in the tree. The verb reads the lockfile, and gets `raw`
   * from `source` (#221, round 3 ruling 2).
   */
  readonly why: (
    tree: Tree<Detection>,
    pkg: string,
    source: WhySource,
  ) => Promise<Envelope<WhyAnswer>>
  /** The ranges that the dependents of `pkg` declare, on one major `line` or on all when null. */
  readonly declaredRanges: (
    tree: Tree<Detection>,
    pkg: string,
    line: number | null,
  ) => Envelope<DeclaredRangesAnswer>
  /**
   * Each constraint in the override file that `detect` names. When that file
   * is `pnpm-workspace.yaml`, also the keys that the `pnpm.overrides` of
   * package.json still holds.
   */
  readonly listPins: (tree: Tree<Detection>) => Envelope<ListPinsAnswer>
  /** How `a` and `b` compare, in this ecosystem's version rules. */
  readonly compareVersions: (a: string, b: string) => Envelope<CompareVersionsAnswer>
  /** What `range` says about `version`, in this ecosystem's range rules. */
  readonly rangeFacts: (range: string, version: string) => Envelope<RangeFactsAnswer>
}
