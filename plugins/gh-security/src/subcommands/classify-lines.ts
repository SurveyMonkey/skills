// `gh-security classify-lines [--env-prefix <prefix>] --repo-root <path>
// [--base-ref origin/<branch>] [--branch-style slash|flat] < discovery.json`:
// compare the major line of each actionable group with what the lockfile of
// the repository resolves. This is the port of `scripts/common/classify-lines.sh`,
// with the batch route of `select-adapter.sh --from-discovery` as its first
// step.
//
// Input: the JSON that `discover-alerts` writes, `{actionable, skipped, ...}`.
// Output: the same object. Each actionable group gets its route and two
// notes, and the groups that no fix in the repository can reach move into
// `skipped`. A top-level `classify_errors[]` names each adapter read that
// failed. Each other top-level key passes through as it is.
//
// **The route.** Each actionable group gets `adapter`, the name of its
// adapter, and `supported`, from the registry, by the group's own
// `ecosystem`. A group with no adapter moves into `skipped` with the reason
// `ecosystem not supported yet`. This step is the batch mode of
// `select-adapter.sh`. It is a step here, and not a command, because this
// command is its only caller, and one process does both.
//
// **The notes of each group.**
//   resolved_majors  the unique majors of the resolved copies of the package,
//                    as text, by the same trim rule as the line of
//                    `discover-alerts`. It is a set, not a version order.
//   line_status
//     resolved              a copy has the major `major_line`.
//     requires_major_bump   the package is present, no copy is on the line,
//                           and `compare_versions` puts every copy below
//                           `<line>.0.0`. Also (#168): the own-range check
//                           (below) finds a copy below the line that an
//                           alert range covers, with no sibling alert on
//                           the major of that copy.
//     line_absent           present, no copy on the line, at least one copy
//                           at or above it, and no copy that the own-range
//                           check finds.
//     cross_line_collision  resolved, but the lines of the package share a
//                           parent in a shape that no override key can
//                           separate (below). `collision_parents` names them.
//     unknown               a `detect` read failed, a `resolved_versions`
//                           or `compare_versions` read failed or broke its
//                           contract, `present` is false, `major_line` is
//                           `none`, or the group has no `package`.
//
// **The own-range check** (ruling 3 on #168) runs only for a group with copies
// on both sides of its line. It reads `vulnerable_range` of each alert
// of the group. For each copy below the line, it asks the adapter's
// `range_facts` if the range covers that copy. An alert with no range adds
// nothing. A covered copy needs a patch on its own major. A sibling alert on
// that major has one, and the group of that line owns the copy. With no such
// sibling, the only fix moves the copy to another major. `validate` then
// fails on the line that vanished. So the group needs a major bump. A broken
// read (`alerts`, a range, `range_facts` or `sibling_alerts`) makes the group
// `unknown`, and `classify_errors[]` names it.
//
// The sibling test is wide. A sibling alert can be for another advisory,
// whose patch does not fix the alert of this group. A sibling alert carries
// no advisory id, so the check cannot see this. The group then stays
// `line_absent`. Its fix moves the copy to another major, and `validate`
// fails on it. So the error is a wasted dispatch, never a pass.
//
// `requires_major_bump` groups move into `skipped` with the reason
// `requires major version bump` (#101), and `cross_line_collision` groups with
// `shared parent across major lines` (#132). Every other group stays
// actionable, `unknown` too: a dispatched unknown fails closed at `validate`,
// and to hold back a group that a fix can reach is the wrong direction.
//
// **The collision check** runs only for a resolved group whose package has
// more than one major. It reads the override syntax from `detect`, and the
// eligible parents and `parents_other_lines` of each major from
// `declared_ranges`. A group moves only when the lines share an eligible
// parent name, AND no key can say the difference:
//   - under Yarn `resolutions`, any shared name;
//   - under npm and pnpm, a shared name that one copy holds on every line.
//     That entry is in the `parents_other_lines` of every major.
// A broken `detect` or `declared_ranges` read in this check keeps the group
// `resolved` and actionable, and adds an entry to `classify_errors[]`.
//
// **Contract discipline** (ADR 001). A broken read is never an empty answer.
// A read is broken when it fails, or when a promised field is not there or
// is of the wrong type. `present: true` with no versions is also broken. A
// broken `resolved_versions` or `compare_versions` read, or a failed `detect`
// read, makes the group `unknown`. `classify_errors[]` names the adapter, the
// package and the error. Under `--base-ref`, each entry also has `base_ref`.
//
// The command itself fails, with exit 1, for bad input and for a `--base-ref`
// step that fails. Bad input is a bad option, a `--repo-root` that is not a
// directory, or stdin that is not the promised object. Actionable groups of
// more than one repository are also bad input, because one `--repo-root`
// names one lockfile. The `--base-ref` steps are the checks of the
// repository, the fetch, the temporary directory and `worktree add`.
//
// **Each adapter verb runs in process, once for each key**, where the script
// started one adapter process for each read: `detect` once for each adapter,
// `resolved_versions` once for each adapter and package, and
// `declared_ranges` once for each adapter, package and major. Only
// `compare_versions` runs for each copy, as in the script.
//
// **`--base-ref origin/<branch>`** names the tree that the verbs read (#158).
// Without it, they read the checkout at `--repo-root` as it is. With it, the
// command does these steps:
//   1. It fetches that branch with an explicit refspec.
//   2. It adds a detached worktree at the fetched ref, in a temporary
//      directory.
//   3. It reads that tree.
//   4. It removes the worktree when the handler returns or throws.
// From the start of step 2 to the end of step 4, a SIGINT or SIGTERM does not
// stop the process at once. The process does step 4 as above, and then exits
// with 130 or 143. It writes no answer on stdout. So the worktree goes, as
// the script's EXIT trap removed it. A signal before the end of step 3 does
// not stop step 3. Other signals, such as SIGHUP, stop the process at once,
// and the worktree stays. The script's trap also ran for those. The shared
// helper `src/signals.ts` holds the two signals.
// `--repo-root` must be the top level of a repository. When the removal
// fails, the worktree and its directory stay. A deleted directory with its
// entry still in the repository blocks later worktrees (`git.md`). A line on
// stderr then says how to remove the worktree. It never runs
// `git worktree prune`.
//
// `--branch-style flat` renames each `branch_name` of both lists from
// `fix/dependabot-` to `fix-dependabot-`. Any other name stays as it is.
// `discover-alerts --branch-style flat` gives the flat names at the source,
// so a caller with that flag has no need of this one (#54).
//
// `--env-prefix` is the opaque command prefix that the environment needs
// (issue #193). It wraps the runner for `git`, so each git call runs as
// `<prefix> git ...`. The verbs start no process. Nothing here names a tool,
// or looks for one.
//
// Differences from the pipeline `select-adapter.sh --from-discovery |
// classify-lines.sh`:
//   - A routed group has no `adapter_path`, because the route is in process.
//     The route removes an `adapter_path` from each actionable group of the
//     input. A group in the input `skipped` keeps its `adapter_path`.
//     `classify_errors[].adapter` is the name of the adapter, where the
//     script gave the path.
//   - `classify_errors[].error` is the message of the failed verb. The script
//     quoted the first line that its child wrote on stderr, which is empty
//     for a broken answer on exit 0. Here a broken answer says what broke.
//   - The input must be an object whose `actionable` and `skipped` are lists
//     of objects, and a `package` must be text when it is there. The script
//     reads some other shapes, and gives answers with no use. Empty stdin is
//     refused. The pipeline answers it with nothing and exit 0.
//   - The input is checked before any git call. The script added the
//     worktree first, and then found that a group list was bad.
//   - `declared_ranges` must give lists of text. On another value, the
//     script can stop with no `{"error": ...}`.
//   - In process, `resolved_versions` reads the answer of `detect`. So a
//     `detect` that fails also fails `resolved_versions`, and the group is
//     `unknown`. In the script, `detect` ran only in the collision check.
//   - A package name with a tab, a line break or a backslash is read as it
//     is. The script escaped it for one read and not for the other.
//   - A failure is `{"error": ...}` on stdout and prose on stderr, as
//     `cli.md` says. The script wrote the JSON on stderr.
//   - The own-range check is new (#168, a declared parity exception). The
//     script gives `line_absent` to each group with a copy at or above its
//     line, and has no such check.
//
// This file ships. It imports nothing outside the plugin.

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Adapter, Tree } from '../adapters/adapter.ts'
import type { NodeDetection } from '../adapters/node/detect.ts'
import {
  type selectAdapter as select,
  selectAdapter,
  UNSUPPORTED_REASON,
} from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { majorOf, orElse, tostring, uniqueJq } from '../jq.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { type Envelope, failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import { type Runner, run } from '../lib/process.ts'
import { holdSignals, type Signals } from '../signals.ts'

const USAGE =
  'usage: gh-security classify-lines [--env-prefix <prefix>] --repo-root <path> ' +
  '[--base-ref origin/<branch>] [--branch-style slash|flat] < discovery.json'

const ORIGIN = 'origin/'

/** A JSON object, and not `null`, a list or a scalar. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Text without the newlines at its end, as `$( )` removes them. */
const chomp = (text: string): string => text.replace(/\n+$/, '')

/** The first line of a child's stderr, as `head -n 1` gives it. */
const firstLine = (text: string): string => text.split('\n')[0] as string

/** A group, its route, and the text that the script read from it. */
interface Routed {
  readonly group: JsonObject
  readonly name: string
  readonly adapter: Adapter<NodeDetection>
  readonly pkg: string
  readonly line: string
}

/** One `resolved_versions` read, as the script caches it. */
type Resolved =
  | {
      readonly ok: true
      readonly present: boolean
      readonly versions: readonly string[]
      readonly majors: readonly string[]
    }
  | { readonly ok: false }

/** The `line_status` of a group (the header). */
type LineStatus =
  | 'resolved'
  | 'requires_major_bump'
  | 'line_absent'
  | 'cross_line_collision'
  | 'unknown'

/** One `declared_ranges` row of the collision check. */
interface Row {
  readonly line: string
  readonly eligible: readonly string[]
  readonly other: readonly string[]
}

/** A list of text, as the collision check reads `declared_ranges`. */
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/** The name of a `parents_other_lines` entry: the text before its last `@`, when that is not the first. */
const nameOf = (entry: string): string => {
  const at = entry.lastIndexOf('@')
  return at > 0 ? entry.slice(0, at) : entry
}

/** Why the input cannot be read, or the parts of it this command reads. */
const readInput = (
  text: string,
):
  | { readonly error: string }
  | {
      readonly input: Record<string, unknown>
      readonly actionable: readonly Record<string, unknown>[]
      readonly skipped: readonly Record<string, unknown>[]
    } => {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return { error: 'classify-lines expects discovery JSON on stdin' }
  }
  if (!isRecord(input)) return { error: 'classify-lines expects a discovery JSON object on stdin' }
  const actionable = orElse(input.actionable, [])
  const skipped = orElse(input.skipped, [])
  if (!Array.isArray(actionable) || !actionable.every(isRecord)) {
    return { error: 'Failed to read actionable groups: actionable is not a list of objects' }
  }
  if (!Array.isArray(skipped) || !skipped.every(isRecord)) {
    return { error: 'Failed to read skipped groups: skipped is not a list of objects' }
  }
  for (const group of actionable) {
    const pkg = orElse(group.package, '')
    if (typeof pkg !== 'string') {
      return {
        error: `Failed to read actionable groups: a package is not text: ${JSON.stringify(pkg)}`,
      }
    }
  }
  return { input, actionable, skipped }
}

export type { Signals } from '../signals.ts'

/**
 * The handler. The runner, the registry, the current directory and the
 * signals of the process are parameters.
 */
export const classifyLines = async (
  context: CommandContext,
  spawn: Runner,
  route: typeof select,
  cwd: string,
  signals: Signals = process,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, {
    'env-prefix': { type: 'string', default: '' },
    'repo-root': { type: 'string', default: '' },
    'base-ref': { type: 'string', default: '' },
    'branch-style': { type: 'string', default: 'slash', choices: ['slash', 'flat'] },
  })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals } = parsed.value
  const given = options['repo-root']
  if (given === '' || positionals.length !== 0) return failed(USAGE)
  const root = resolve(cwd, given)
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return failed(`--repo-root is not a directory: ${given}`)
  }
  const baseRef = options['base-ref']
  // The prefix is required: the fetch takes the branch from it, and a local
  // branch name here would read a ref that the fetch never moved.
  if (baseRef !== '' && !(baseRef.startsWith(ORIGIN) && baseRef.length > ORIGIN.length)) {
    return failed(`--base-ref must name a remote-tracking ref as origin/<branch>: ${baseRef}`)
  }

  const read = readInput(context.io.readStdin())
  if ('error' in read) return failed(read.error)

  // The route: the batch mode of select-adapter.sh.
  const routed: Routed[] = []
  const unsupported: JsonObject[] = []
  for (const group of read.actionable) {
    const { adapter_path: _path, ...rest } = group
    const found = typeof group.ecosystem === 'string' ? route(group.ecosystem) : null
    if (found === null || !found.supported) {
      unsupported.push({
        ...(rest as JsonObject),
        adapter: null,
        supported: false,
        reason: UNSUPPORTED_REASON,
      })
      continue
    }
    routed.push({
      group: { ...(rest as JsonObject), adapter: found.name, supported: true },
      name: found.name,
      adapter: found.adapter,
      pkg: orElse(group.package, '') as string,
      line: chomp(tostring(orElse(group.major_line, 'none'))),
    })
  }

  const repos = uniqueJq(
    routed.map(({ group }) => orElse(group.repo, null)).filter((repo) => repo !== null),
  )
  if (repos.length > 1) {
    return failed(
      `classify-lines: actionable groups span more than one repo (${repos.map(tostring).join(', ')}); ` +
        "pass one repo's groups per invocation",
    )
  }

  const prefix = parseEnvPrefix(options['env-prefix'])
  const git = (args: readonly string[]) => {
    const line = withEnvPrefix(prefix, { command: 'git', args: ['-C', root, ...args] })
    return spawn(line.command, line.args, { env: context.env })
  }

  if (baseRef === '') {
    return ok(classify(read, routed, unsupported, root, baseRef, options['branch-style'], context))
  }
  const top = await git(['rev-parse', '--show-toplevel'])
  const topLevel = top.status === 0 ? chomp(top.stdout) : ''
  if (topLevel === '') {
    return failed(`--base-ref requires --repo-root to be a git repository: ${given}`)
  }
  // Both sides with their links resolved, so `/tmp` and `/private/tmp`
  // are one path. A linked worktree is its own top level. A top level
  // that cannot be resolved is not this directory, as `pwd -P` of the
  // script gave no text for it.
  if (realpathSync(root) !== realOrEmpty(topLevel)) {
    return failed(
      `--base-ref requires --repo-root to be the repository top level, not a subdirectory: ${given} (top level: ${topLevel})`,
    )
  }
  const branch = baseRef.slice(ORIGIN.length)
  // The refspec is explicit and forced. With a narrow
  // `remote.origin.fetch`, a bare `fetch origin <branch>` moves only
  // FETCH_HEAD, and an old remote-tracking ref then passes the check below.
  const fetched = await git([
    'fetch',
    '-q',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ])
  if (fetched.status !== 0) {
    return failed(`git fetch for --base-ref ${baseRef} failed: ${firstLine(fetched.stderr)}`)
  }
  if ((await git(['rev-parse', '--verify', '-q', `refs/remotes/${baseRef}`])).status !== 0) {
    return failed(`--base-ref not found after fetch: ${baseRef}`)
  }
  let baseDir: string
  try {
    // `mktemp -d` reads TMPDIR, and an empty TMPDIR is no TMPDIR.
    baseDir = mkdtempSync(join(context.env.TMPDIR || tmpdir(), 'classify-lines-'))
  } catch {
    return failed(
      '--base-ref could not create a temporary directory for the detached worktree (mktemp -d failed)',
    )
  }
  const tree = join(baseDir, 'tree')
  // From `worktree add` to the removal, a signal only records itself. The
  // removal runs when the body returns or throws, and the process then
  // exits with the status of the signal.
  return holdSignals(
    signals,
    async () => {
      const added = await git([
        'worktree',
        'add',
        '-q',
        '--detach',
        tree,
        `refs/remotes/${baseRef}`,
      ])
      if (added.status !== 0) {
        return failed(`git worktree add for ${baseRef} failed: ${firstLine(added.stderr)}`)
      }
      return ok(
        classify(read, routed, unsupported, tree, baseRef, options['branch-style'], context),
      )
    },
    async () => {
      // `worktree remove` drops this command's own entry and no other. A
      // directory whose removal failed stays, with its entry.
      if ((await git(['worktree', 'remove', '--force', tree])).status === 0) {
        removeDirectory(baseDir, context)
      } else if (existsSync(tree)) {
        context.io.stderr(
          `classify-lines: could not remove base-ref worktree ${tree}; remove it with: git -C ${given} worktree remove --force ${tree}\n`,
        )
      } else {
        removeDirectory(baseDir, context)
      }
    },
  )
}

/** The real path, or no text when the path cannot be resolved. */
const realOrEmpty = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return ''
  }
}

/**
 * Remove the empty temporary directory. A failure here does not change the
 * answer, as the script's `rm -rf ... || true` did not. A line on stderr
 * names it, where the script let `rm` say it.
 */
const removeDirectory = (path: string, context: CommandContext): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    // The worktree is already gone. Only an empty directory stays.
    context.io.stderr(
      `classify-lines: could not remove temporary directory ${path}: ${(error as Error).message}\n`,
    )
  }
}

/** What a `resolved_versions` answer must be (ADR 001), checked at run time. */
const resolvedOf = (value: unknown): Resolved | null => {
  if (!isRecord(value) || typeof value.present !== 'boolean' || !Array.isArray(value.versions)) {
    return null
  }
  const entries: unknown[] = value.versions
  if (!entries.every((entry) => isRecord(entry) && 'version' in entry)) return null
  // Zero resolved versions is an error, never a pass (core.md).
  if (value.present && entries.length === 0) return null
  const versions = entries.map((entry) => tostring((entry as { version: unknown }).version))
  const majors = uniqueJq(versions.flatMap((version) => majorOf(version) ?? []))
  return { ok: true, present: value.present, versions, majors }
}

/**
 * The status of a `line_absent` group that has copies below its line (#168).
 * It is `requires_major_bump` when an alert range of the group covers a copy
 * below the line, and no sibling alert has the major of that copy. Else it
 * stays `line_absent`. A read that breaks gives the error, and the caller
 * makes the group `unknown`.
 */
const ownRangeStatus = (
  adapter: Adapter<NodeDetection>,
  group: JsonObject,
  below: readonly string[],
): 'line_absent' | 'requires_major_bump' | { readonly error: string } => {
  const skipped = '; own-range check skipped'
  const alerts = orElse(group.alerts, [])
  if (!Array.isArray(alerts) || !alerts.every(isRecord)) {
    return { error: `alerts is not a list of objects${skipped}` }
  }
  const ranges: string[] = []
  for (const alert of alerts) {
    const range = orElse(alert.vulnerable_range, null)
    if (range === null) continue
    if (typeof range !== 'string') {
      return { error: `an alert vulnerable_range is not text: ${JSON.stringify(range)}${skipped}` }
    }
    ranges.push(range)
  }
  const covered: string[] = []
  for (const version of below) {
    for (const range of ranges) {
      const answer = adapter.rangeFacts(range, version)
      if (answer.outcome !== 'ok') return { error: answer.error }
      const facts: Record<string, unknown> = isRecord(answer.value) ? answer.value : {}
      if (facts.parseable !== true || typeof facts.satisfied !== 'boolean') {
        return {
          error: `range_facts could not read '${range}' for ${version}: ${JSON.stringify(answer.value)}${skipped}`,
        }
      }
      if (facts.satisfied) covered.push(version)
    }
  }
  if (covered.length === 0) return 'line_absent'
  const siblings = group.sibling_alerts
  const usable =
    Array.isArray(siblings) &&
    siblings.every(
      (sibling) =>
        isRecord(sibling) &&
        (sibling.major === null || (Number.isInteger(sibling.major) && Number(sibling.major) >= 0)),
    )
  if (!usable) return { error: `sibling_alerts is not a list of {major} objects${skipped}` }
  // A sibling alert has a patch on its own major. A copy on such a major
  // belongs to that line, and the group of that line can fix it.
  const patched: readonly unknown[] = (siblings as { major: number | null }[]).flatMap(
    ({ major }) => (major === null ? [] : [String(major)]),
  )
  return covered.some((version) => !patched.includes(majorOf(version)))
    ? 'requires_major_bump'
    : 'line_absent'
}

/** The classification, with every adapter read in process. */
const classify = (
  read: {
    readonly input: Record<string, unknown>
    readonly skipped: readonly Record<string, unknown>[]
  },
  routed: readonly Routed[],
  unsupported: readonly JsonObject[],
  root: string,
  baseRef: string,
  style: 'slash' | 'flat',
  context: CommandContext,
): JsonObject => {
  const errors: JsonObject[] = []
  const note = (name: string, pkg: string, error: string): void => {
    errors.push({
      adapter: name,
      package: pkg,
      error,
      ...(baseRef === '' ? {} : { base_ref: baseRef }),
    })
  }

  const detections = new Map<string, Envelope<NodeDetection>>()
  const detected = (name: string, adapter: Adapter<NodeDetection>): Envelope<NodeDetection> => {
    const cached = detections.get(name)
    if (cached !== undefined) return cached
    const answer = adapter.detect(root, context.env)
    detections.set(name, answer)
    return answer
  }
  const treeOf = (detection: NodeDetection): Tree<NodeDetection> => ({ root, detection })

  // One resolved_versions read for each adapter and package, in the sorted
  // order of the script's cache, so its errors come first and in that order.
  const resolved = new Map<string, Resolved>()
  const key = (...parts: readonly string[]): string => JSON.stringify(parts)
  const pairs = uniqueJq(routed.filter(({ pkg }) => pkg !== '').map(({ name, pkg }) => [name, pkg]))
  for (const [name, pkg] of pairs as [string, string][]) {
    const adapter = (routed.find((entry) => entry.name === name) as Routed).adapter
    const detection = detected(name, adapter)
    const answer =
      detection.outcome === 'ok'
        ? adapter.resolvedVersions(treeOf(detection.value), pkg)
        : detection
    const entry = answer.outcome === 'ok' ? resolvedOf(answer.value) : null
    if (entry === null) {
      note(
        name,
        pkg,
        answer.outcome === 'ok'
          ? `resolved_versions broke its contract (ADR 001): ${JSON.stringify(answer.value).slice(0, 200)}`
          : answer.error,
      )
    }
    resolved.set(key(name, pkg), entry ?? { ok: false })
  }

  const ranges = new Map<string, Row | string>()
  /** One declared_ranges row for each adapter, package and major, or the error of its read. */
  const rowOf = (
    name: string,
    adapter: Adapter<NodeDetection>,
    detection: NodeDetection,
    pkg: string,
    major: string,
  ): Row | string => {
    const cached = ranges.get(key(name, pkg, major))
    if (cached !== undefined) return cached
    const answer = adapter.declaredRanges(treeOf(detection), pkg, Number(major))
    let row: Row | string =
      `declared_ranges --line ${major} failed or broke its contract; collision check skipped`
    if (answer.outcome !== 'ok') row = answer.error
    else {
      const value: unknown = answer.value
      const fields = [
        'parents_read',
        'parents_without_range',
        'parents_unreadable',
        'parents_other_lines',
      ]
      if (isRecord(value) && fields.every((field) => isTextList(value[field]))) {
        const lists = value as Record<string, string[]>
        row = {
          line: major,
          eligible: uniqueJq([
            ...(lists.parents_read as string[]),
            ...(lists.parents_without_range as string[]),
            ...(lists.parents_unreadable as string[]),
          ]),
          other: uniqueJq(lists.parents_other_lines as string[]),
        }
      }
    }
    ranges.set(key(name, pkg, major), row)
    return row
  }

  /** The verdict of the collision check: the parents to name, or null. */
  const collisionOf = (rows: readonly Row[], line: string, location: string): string[] | null => {
    const mine = rows.find((row) => row.line === line) as Row
    const overlap = mine.eligible.filter((parent) =>
      rows.some((row) => row.line !== line && row.eligible.includes(parent)),
    )
    if (overlap.length === 0) return null
    if (location === 'resolutions') return overlap
    // An entry in the parents_other_lines of every major is one copy that
    // resolves the package on more than one major.
    const shared = rows.reduce<readonly string[]>(
      (common, row) => row.other.filter((entry) => common.includes(entry)),
      (rows[0] as Row).other,
    )
    const named = uniqueJq(shared.map(nameOf).filter((parent) => overlap.includes(parent)))
    return named.length > 0 ? named : null
  }

  const annotated = routed.map(({ group, name, adapter, pkg, line }) => {
    const entry = resolved.get(key(name, pkg)) ?? { ok: false }
    const majors = entry.ok ? entry.majors : []
    let status: LineStatus = 'unknown'
    if (line !== 'none' && entry.ok && entry.present) {
      if (majors.includes(line)) status = 'resolved'
      else {
        status = 'requires_major_bump'
        const below: string[] = []
        for (const version of chomp(entry.versions.join('\n')).split('\n')) {
          const answer = adapter.compareVersions(version, `${line}.0.0`)
          const result: unknown =
            answer.outcome === 'ok' && isRecord(answer.value) ? answer.value.result : undefined
          // A JSON number is finite. A NaN or an infinity from the adapter is
          // a broken answer, and JSON text cannot show it, so the error names it.
          if (typeof result === 'number' && Number.isFinite(result)) {
            if (result < 0) below.push(version)
            else if (status !== 'unknown') status = 'line_absent'
            continue
          }
          status = 'unknown'
          note(
            name,
            pkg,
            answer.outcome === 'ok'
              ? `compare_versions broke its contract (ADR 001): ${typeof result === 'number' ? `result ${result}` : JSON.stringify(answer.value)}`
              : answer.error,
          )
        }
        if (status === 'line_absent' && below.length > 0) {
          const verdict = ownRangeStatus(adapter, group, below)
          if (typeof verdict === 'string') status = verdict
          else {
            status = 'unknown'
            note(name, pkg, verdict.error)
          }
        }
      }
    }

    let parents: string[] | null = null
    if (status === 'resolved' && majors.length > 1) {
      // A resolved group came through a detect that answered.
      const detection = (detected(name, adapter) as { value: NodeDetection }).value
      const location: unknown = detection.override_location
      if (typeof location !== 'string' || location === '') {
        note(name, pkg, 'detect failed or broke its contract; collision check skipped')
      } else {
        const rows: Row[] = []
        for (const major of majors) {
          const row = rowOf(name, adapter, detection, pkg, major)
          if (typeof row === 'string') {
            note(name, pkg, row)
            break
          }
          rows.push(row)
        }
        if (rows.length === majors.length) parents = collisionOf(rows, line, location)
        if (parents !== null) status = 'cross_line_collision'
      }
    }
    return {
      ...group,
      resolved_majors: [...majors],
      line_status: status,
      ...(parents === null ? {} : { collision_parents: parents }),
    } as JsonObject
  })

  const flat = (entry: JsonObject): JsonObject =>
    style === 'flat' && typeof entry.branch_name === 'string'
      ? { ...entry, branch_name: entry.branch_name.replace(/^fix\/dependabot-/, 'fix-dependabot-') }
      : entry
  const {
    actionable: _actionable,
    skipped: _skipped,
    classify_errors: _errors,
    ...rest
  } = read.input as JsonObject
  return {
    ...rest,
    actionable: annotated
      .filter(
        ({ line_status }) =>
          line_status !== 'requires_major_bump' && line_status !== 'cross_line_collision',
      )
      .map(flat),
    skipped: [
      ...(read.skipped as JsonObject[]),
      ...unsupported,
      ...annotated
        .filter(({ line_status }) => line_status === 'requires_major_bump')
        .map((entry) => ({ ...entry, reason: 'requires major version bump' })),
      ...annotated
        .filter(({ line_status }) => line_status === 'cross_line_collision')
        .map((entry) => ({ ...entry, reason: 'shared parent across major lines' })),
    ].map(flat),
    classify_errors: errors as JsonValue[],
  }
}

export const classifyLinesCommand: CommandHandler = (context) =>
  classifyLines(context, run, selectAdapter, process.cwd())
