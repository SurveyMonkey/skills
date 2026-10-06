// The adapter contract of ADR 001, as ADR 012 amends it: one in-process
// interface for the verbs of each ecosystem. Each verb is a function, and
// each answer is an envelope from `lib/envelope.ts`. The four outcomes are
// the four exit codes of ADR 001.
//
// #221 added the nine read verbs. #222 adds `validate`, which also only
// reads, and the three verbs that write: `install`, `shim` and
// `applyConstraint`. Each write verb refuses to run outside a linked
// worktree (ADR 001, "Invocation"). `requireLinkedWorktree`
// (`src/worktree.ts`) is its first statement, as in node.sh.
//
// `detect` runs once for each call site. The caller gives its answer to the
// other verbs in a `Tree`. No verb runs `detect` again.
//
// The answer types are the JSON that `node.sh` writes for each verb, with
// the same keys. A promised field is present and typed, or the verb fails.
// `parents` is not a verb of `node.sh`. It is new in #221, from the parent
// readers inside `node.sh`. `probeRegistry` is not a verb of `node.sh`
// either. It is new in #228, from phase 5 of `resolve-alerts` SKILL.md
// (round 6 ruling 8). It only reads, so it has no worktree guard.
//
// This file ships. It imports nothing outside the plugin.

import type { Envelope } from '../lib/envelope.ts'
import type { Runner } from '../lib/process.ts'

/**
 * The environment that `detect` and `shim` read. `why` and `install` give it
 * to the package manager that they start. The node `detect` and `shim` read
 * only `PATH`.
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
  /**
   * Null when the reader finds no version for this copy. The pnpm reader
   * also gives null for a version that does not start with a digit, such as
   * a `file:` or a git target. `apply_constraint` reads the manifest version
   * of such a copy from its `packages:` entry instead (#313).
   */
  readonly version: string | null
}

/** The `parents` answer. No verb of node.sh writes it. */
export type ParentsAnswer = {
  readonly pm: string
  readonly package: string
  /**
   * Each copy once, sorted as the JSON text of `[name, version]`. For usual
   * names, that is by name and then version. The root is never a parent.
   */
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
   * peer (#103). Always false outside a pnpm lockfile at lockfileVersion 9.
   */
  readonly peer_only: boolean
  /**
   * The parents whose snapshot key has the package as a peer. The required
   * peers are first, and each group is sorted as text. Empty outside a pnpm
   * lockfile at lockfileVersion 9.
   */
  readonly peer_parents: readonly string[]
  /** The parents in `peer_parents` that reach the package only as an optional peer. */
  readonly optional_peer_parents: readonly string[]
  /** The output of the package manager's own `why` command, with no newline at the end. */
  readonly raw: string
}

/**
 * Where `why` gets its `raw` text. `raw` is the output that the package
 * manager's own `why` command wrote. Without it, the verb runs that command
 * in the tree with `run`. `env` is the whole environment of that command.
 * The two forms do not mix.
 */
export type WhySource =
  | { readonly raw: string; readonly run?: never; readonly env?: never }
  | { readonly raw?: never; readonly run: Runner; readonly env: Environment }

/**
 * The `declared_ranges` answer. `parents_read`, `parents_without_range`,
 * `parents_unreadable` and `parents_malformed` name each parent once.
 * `parents_other_lines` has one entry for each lockfile row on another line,
 * so an entry can repeat. A parent can be in `parents_read` and in
 * `parents_other_lines` both.
 */
export type DeclaredRangesAnswer = {
  readonly pm: string
  readonly package: string
  /** The major line that the answer is limited to, or null for all lines. */
  readonly line: number | null
  /**
   * Unique and sorted as text. A range that holds a newline gives one entry
   * for each line. So `root_range`, when not null, is one of them only when
   * it has no newline.
   */
  readonly ranges: readonly string[]
  /** The range that the root manifest declares, or null. */
  readonly root_range: string | null
  readonly parents_read: readonly string[]
  /** Read, but they declare the package in no block. */
  readonly parents_without_range: readonly string[]
  /** No declaration could be read. The root copy is never in this list. */
  readonly parents_unreadable: readonly string[]
  /**
   * The subset of `parents_unreadable` whose manifest is on disk, but cannot
   * be read, does not parse, or has a dependency block that jq cannot read.
   */
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
  /**
   * The parents, then the target with its selector. For npm, every key from
   * the top of the block down to the leaf.
   */
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

/** A copy that still matches one or more advisory ranges. */
type AlertedCopy = ResolvedVersion & {
  /** The `--vulnerable` ranges that the copy satisfies, unique and sorted as text. */
  readonly vulnerable_ranges: readonly string[]
}

/** A major line outside `line` whose set of versions changed after the baseline (#83). */
type LineMove = {
  readonly major: number
  /** Unique and sorted as text. */
  readonly before: readonly string[]
  /** Unique and sorted as text. Empty when the line vanished. */
  readonly after: readonly string[]
  readonly status: 'moved' | 'vanished'
  /**
   * `benign_dedup` only for the one safe shape of #105. The line keeps one
   * version, and that version was the semver max of its baseline. Sibling
   * alerts were given, each of their ranges parses, and none of them is on
   * the line. No sibling range matches a version before or after. Else
   * `fatal`.
   */
  readonly class: 'fatal' | 'benign_dedup'
}

/**
 * A copy at a path that the fix changed, whose parent declares a range that
 * the copy breaks (#170). The copy is on another major, or below the floor
 * of the range, or the range does not parse. The path is new, or the
 * baseline had another version there.
 */
type RangeBreak = {
  /** The lockfile key of the parent that declares the package. */
  readonly parent: string
  /** The range that the parent declares. */
  readonly range: string
  /** The lockfile key of the copy that the parent resolves. */
  readonly path: string
  readonly version: string
}

/** The `validate` answer. */
export type ValidateAnswer = {
  /**
   * The verdict. False when a check fails, or when `line` holds no copy. A
   * caller reads it.
   */
  readonly ok: boolean
  readonly package: string
  readonly range: string
  /** The `line` option, as its text, or null. */
  readonly line: string | null
  /** False only for a `line` that holds no copy. */
  readonly line_present: boolean
  /** The copies on `line`, or all copies when there is no `line`. */
  readonly checked: number
  readonly resolved_count: number
  /** The checked copies that do not satisfy `range`. */
  readonly violations: readonly ResolvedVersion[]
  /** The copies on or above `line` that still match a vulnerable range. */
  readonly unresolved_alerts: readonly AlertedCopy[]
  /** The copies below `line` that still match a vulnerable range. */
  readonly requires_major_bump: readonly AlertedCopy[]
  /** Null when no baseline was given, and an array when one was. */
  readonly other_line_moves: readonly LineMove[] | null
  /**
   * Null when no baseline was given, or when the lockfile records no
   * declared range and path for each copy (pnpm, Yarn). Else an array
   * (#170). A null does not tell these two cases apart.
   */
  readonly parent_range_breaks: readonly RangeBreak[] | null
  /** The versions of all copies, unique and sorted as text. */
  readonly resolved_versions: readonly string[]
}

/**
 * The options of `validate`, one for each flag of `verb_validate`. The caller
 * gives each. A flag that is absent is null, or an empty list for
 * `vulnerable`.
 */
export type ValidateOptions = {
  /**
   * `--line`: the major line of the group, as the text of the flag, or null
   * for all lines. The answer echoes this text.
   */
  readonly line: string | null
  /** Each `--vulnerable` range, in the order of the flags. */
  readonly vulnerable: readonly string[]
  /** `--baseline`: the JSON text of the `resolved_versions` answer before the fix. */
  readonly baseline: string | null
  /** `--sibling-alerts`: the JSON text of one array of `{major, vulnerable_ranges}`. */
  readonly siblingAlerts: string | null
}

/**
 * How `install` runs `install_cmd`. `env` is the environment of that command.
 * The verb also sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` in it.
 */
export type InstallSource = { readonly run: Runner; readonly env: Environment }

/**
 * How `probeRegistry` runs its probe. `env` is the environment of that
 * command. A caller with an `env_prefix` wraps `run` in it.
 */
export type ProbeSource = { readonly run: Runner; readonly env: Environment }

/** The `probeRegistry` answer: one attempt of the probe. */
export type RegistryProbeAnswer = {
  /** The package that the probe asked for. */
  readonly package: string
  /** The probe command, with its words joined by one space. */
  readonly command: string
  /** True only when the command exits 0, with text on stdout. */
  readonly ok: boolean
  /** False when the command did not start. */
  readonly started: boolean
  /** The HTTP status that the output of the package manager names, or null. */
  readonly http_status: 401 | 403 | 404 | null
  /** What the probe wrote: stderr, then stdout. Or why it did not start. */
  readonly output: string
}

/** The `install` answer: what node.sh writes, and the status that it exits with. */
export type InstallAnswer = {
  /** The `install_cmd` of the detection. */
  readonly command: string
  /** True only when the command exits 0. A caller reads it. */
  readonly ok: boolean
  /**
   * The exit status of the command. 127 for a command that is not found, and
   * 126 for any other start failure. Null when a signal stops it.
   */
  readonly status: number | null
  /** The signal that stopped the command, or null. */
  readonly signal: string | null
  readonly stdout: string
  /**
   * `Running: <command>` and a newline, then what the command wrote to
   * stderr. For a command that did not start, the start failure follows.
   */
  readonly stderr: string
}

/** The options of `shim`. */
export type ShimOptions = {
  /** The environment that gives `PATH`. */
  readonly env: Environment
  /** The runner that the shim starts, in place of the one that `detect` found. */
  readonly runner?: string
}

/** The `shim` answer. */
export type ShimAnswer =
  | {
      readonly created: false
      readonly pm: string
      readonly reason: string
      readonly shim?: never
      readonly path_prefix?: never
      readonly runner?: never
    }
  | {
      readonly created: true
      readonly pm: string
      /** The shim file: the directory as given, a `/`, and the name of the manager. */
      readonly shim: string
      /** The directory as given. A caller puts it first on `PATH`. */
      readonly path_prefix: string
      /** The command that the shim starts. */
      readonly runner: string
      readonly reason?: never
    }

/** What `applyConstraint` writes: one constraint on one package. */
export type ConstraintRequest = {
  readonly pkg: string
  readonly range: string
  /** The parents that scope the constraint. Empty for a direct constraint. */
  readonly parents: readonly string[]
  /** `--tighten-bare`: also tighten a bare override that governs the package. */
  readonly tightenBare: boolean
}

/** One entry that `applyConstraint` wrote (ADR 001, `written[]`). */
type WrittenEntry = {
  /** Null for an entry that no parent scopes. */
  readonly parent: string | null
  /** Where the entry is, one key at a time. */
  readonly path: readonly string[]
  readonly value: PinValue
  /** True for a value that was there before, and that the write kept. */
  readonly preserved?: true
}

/** One entry that `applyConstraint` removed, because a new key replaces it. */
type SupersededKey = {
  readonly parent: string
  readonly path: readonly string[]
  readonly value: PinValue
}

/** An override entry that `applyConstraint` saw and did not change. */
type ConstraintObservation =
  | {
      readonly type: 'unscoped_override'
      readonly key: string
      readonly range: string
      readonly targets_this_package: boolean
    }
  | {
      readonly type: 'manifest_pnpm_overrides_ignored'
      readonly keys: readonly string[]
      readonly pnpm_major: number | null
    }
  | { readonly type: 'pnpm_major_unknown' }

/**
 * The npm lockfile entries that `applyConstraint` removed (#124). A
 * `reason` is present only when an override was written and the pass could
 * not run. A pass that did not run removed no entry.
 */
type LockfileInvalidated =
  | { readonly performed: true; readonly keys: readonly string[]; readonly reason?: never }
  | {
      readonly performed: false
      readonly keys: readonly []
      readonly reason?: 'unreadable_range_floor' | 'no_packages_object'
    }

/** The `apply_constraint` answer. */
export type ApplyConstraintAnswer = {
  readonly pm: string
  readonly package: string
  readonly range: string
  readonly override_location: string
  readonly override_file: string
  readonly mode: 'tighten-bare' | 'direct' | 'scoped'
  readonly parents: readonly string[]
  readonly written: readonly WrittenEntry[]
  readonly superseded_keys: readonly SupersededKey[]
  readonly alias_lookup: {
    /** `unsupported` for pnpm, whose lockfile does not keep the declared key. */
    readonly source: 'lockfile' | 'unsupported'
    readonly parents_unresolved: readonly string[]
  }
  readonly lockfile_invalidated: LockfileInvalidated
  readonly observations: readonly ConstraintObservation[]
}

/**
 * The verbs of one ecosystem. `Detection` is what that ecosystem's `detect`
 * finds.
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
  /**
   * Whether the copies of `pkg` satisfy `range` and clear the alerts, and
   * which copies outside `line` moved. It only reads. The verdict is `ok` in
   * the answer: node.sh writes the answer and exits 1 when `ok` is false.
   */
  readonly validate: (
    tree: Tree<Detection>,
    pkg: string,
    range: string,
    options: ValidateOptions,
  ) => Envelope<ValidateAnswer>
  /** Run `install_cmd` in the tree. A write verb. */
  readonly install: (
    tree: Tree<Detection>,
    source: InstallSource,
  ) => Promise<Envelope<InstallAnswer>>
  /**
   * Write an executable file `<dir>/<pm>` that starts the runner of the tree,
   * or the runner that the options name. With no runner in the options, it
   * writes nothing when the package manager is on `PATH`. A write verb. A
   * relative `dir` is relative to the root of the tree.
   */
  readonly shim: (tree: Tree<Detection>, dir: string, options: ShimOptions) => Envelope<ShimAnswer>
  /** Write one constraint into the override file of the tree. A write verb. */
  readonly applyConstraint: (
    tree: Tree<Detection>,
    request: ConstraintRequest,
  ) => Envelope<ApplyConstraintAnswer>
  /**
   * Ask the registry of the tree for one package, once, from the root of the
   * tree. The verb picks the package by the rules of the ecosystem, and uses
   * `fallback` when the tree gives none (#228). It only reads.
   */
  readonly probeRegistry: (
    tree: Tree<Detection>,
    fallback: string | null,
    source: ProbeSource,
  ) => Promise<Envelope<RegistryProbeAnswer>>
}
