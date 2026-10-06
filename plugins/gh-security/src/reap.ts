// The reap: remove the worktree and the work directory of one fix group, and
// delete its local branch when the delete is safe. This is the one
// implementation of three bash ones (#234): `fix-group.sh cleanup`,
// `reap-agent-artifacts.sh`, and the reap step of `post-agent.sh`, which
// calls the second. `fix-group cleanup` uses it now. The `reap-batch` command
// of #229 is its second caller. The two scripts stay bash until #231 and #236
// remove them.
//
// The module is here, beside `state.ts` and `worktree.ts`, because it is not
// a command. A command is a file under `subcommands/`, and two commands use
// this one. It reads no state file. The caller gives each path and the
// branch, so a caller that has no state file can also use it.
//
// **Containment** (`contain`, `gh-security-guide/fix-driver.md`). The reap runs
// `rm -rf` on the work directory and `git worktree remove` on the worktree, so
// each path must pass these checks first:
//   - The repository root is a git repository. The branch name does not start
//     with a dash, and git accepts it as a branch name.
//   - The path, as given, has no `..` segment.
//   - Both sides are resolved physically, links included, so a link cannot
//     carry a path past the check.
//   - The resolved path is under `<repo_root>/.claude/worktrees/`, and is not
//     that directory itself.
//   - When the caller gives the work path that `setup` recorded, the two are
//     the same path. Only `fix-group cleanup` has one.
// These checks do not prove that a state file is not forged. They refuse a
// path outside the worktree root, a path through `..` or a link, and a work
// directory that moved after `setup`. Each removal uses the resolved path that
// was checked, never the path as given.
//
// **The order** is the worktree, then the work directory, then the branch:
//   1. A worktree with a `.git` comes off with `git worktree remove --force` on
//      its own path. A registration whose directory is gone loses the one
//      entry under `<git-common-dir>/worktrees/` whose `gitdir` file names this
//      path, found by its text. A plain directory is `not-a-worktree`, and
//      step 2 removes it.
//   2. The work directory goes, but not while step 1 failed: a directory
//      deleted under a live registration blocks a later `worktree add` on the
//      path, and a `branch -D` of the branch (`git.md`).
//   3. The branch is deleted only by the rule of ADR 003 (below). Each removal
//      has its status checked, and a failure goes into `errors`.
//
// **The branch rule** (ADR 003, the #84 amendment). The local tip is deleted
// only when nothing on it can be lost:
//   - `pushed`: the tip equals `origin/<branch>`. The caller says that the
//     push was confirmed: an open pull request, or a push that succeeded.
//   - `defaultBranch`: the tip equals `origin/<default_branch>`.
//   - `leftover`: the caller proves the tip is its own leftover. The fix
//     driver uses this for its drift commit (`agents/fix-dependency.md`).
// Any other tip stays, and `left_behind` names it. A ref that cannot be read
// is never read as absent: the branch stays, and `errors` names the read.
//
// **ADR 003 limits.** There is no `git worktree prune`, and no walk over the
// worktrees of other agents: each git call names this path or this branch.
// The one administrative write is the single entry that names this path.
//
// **A killed process.** SIGKILL cannot be caught, so a process that a SIGKILL
// stops leaves its worktree. The reap finds it by its own derived path only:
// `fix-group setup` makes the path from the package and the line, and a
// caller that knows the group gives that same path here. The reap does not
// search for it. The `classify-lines --base-ref` worktree is in a temporary
// directory with a random name, so no path finds it after a SIGKILL. Its
// registration stays until `git gc` expires it (`gc.worktreePruneExpire`).
// `src/signals.ts` covers SIGINT and SIGTERM for both commands.
//
// **The report** has the shape of `reap-agent-artifacts.sh`: the paths, the
// action of each artifact, the branch and its reason, `left_behind` and
// `errors`. A list of errors that is not empty is the failure outcome: each
// caller exits non-zero on it.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs` and `path`.

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { type Envelope, failed, ok, thrownText } from './lib/envelope.ts'
import type { RunResult } from './lib/process.ts'

/** Run git in one directory. The caller adds its prefix. */
export type Git = (dir: string, args: readonly string[]) => Promise<RunResult>

/** What the caller asks the reap to remove. */
export interface ReapTarget {
  readonly repoRoot: string
  /** The work directory, `<repo_root>/.claude/worktrees/<leaf>`. */
  readonly work: string
  /** The git worktree in it, `<work>/fix`. */
  readonly worktree: string
  readonly branch: string
  /** The work path that `setup` recorded, when the caller has one. */
  readonly recordedWork?: string
}

/** The target after `contain`: each path resolved and checked. */
export interface Contained {
  readonly repoRoot: string
  readonly work: string
  readonly worktree: string
  readonly branch: string
}

/** When the local branch may be deleted. The header has the rule. */
export interface BranchPolicy {
  readonly pushed: boolean
  readonly defaultBranch: string | null
  readonly leftover?: (git: Git, target: Contained) => Promise<boolean>
}

export type WorktreeAction =
  | 'absent'
  | 'removed'
  | 'failed'
  | 'stale-registration-removed'
  | 'stale-registration'
  | 'not-a-worktree'

export type WorkDirAction = 'absent' | 'removed' | 'failed' | 'skipped' | 'not-a-directory'

export type BranchAction = 'absent' | 'deleted' | 'left'

export type BranchReason =
  | 'no-local-branch'
  | 'tip-on-origin'
  | 'tip-on-default'
  | 'own-leftover'
  | 'tip-read-failed'
  | 'no-remote-tracking-ref'
  | 'tip-not-on-origin'
  | 'push-not-confirmed'
  | 'delete-failed'

export interface Reaped {
  readonly repo_root: string
  readonly branch: string
  readonly work: string
  readonly worktree: { readonly path: string; readonly action: WorktreeAction }
  readonly work_dir: { readonly path: string; readonly action: WorkDirAction }
  readonly branch_ref: {
    readonly action: BranchAction
    readonly reason: BranchReason
    readonly local_tip: string | null
    readonly origin_tip: string | null
  }
  readonly left_behind: string[]
  readonly errors: string[]
}

/** A directory, after links. A path that cannot be read is not one. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The path with its links resolved, as `resolve_path` of the bash gave it.
 * The part that exists is resolved, and the part that does not is kept as
 * text. The walk up ends at `/`, which is a directory, so it always ends.
 */
export const resolvePhysical = (path: string): string => {
  let existing = resolve(path)
  let rest = ''
  while (!isDirectory(existing)) {
    rest = `/${basename(existing)}${rest}`
    existing = dirname(existing)
  }
  return realpathSync.native(existing) + rest
}

const hasDotDot = (path: string): boolean => path.split('/').includes('..')

/** Under `<root>/.claude/worktrees/`, and not that directory itself. */
const isContained = (root: string, path: string): boolean => {
  const prefix = `${root}/.claude/worktrees/`
  return path.startsWith(prefix) && path.length > prefix.length
}

/** Text of a child on one line, as each error is one entry. */
const oneLine = (text: string): string => text.replace(/\s+$/, '').replace(/\n/g, ' ')

/** What a child wrote, or why it did not start. */
const outputOf = (result: RunResult): string =>
  oneLine(result.startFailure === null ? result.combined : result.startFailure.message)

/** Check a target before anything is removed. The header has each check. */
export const contain = async (target: ReapTarget, git: Git): Promise<Envelope<Contained>> => {
  const { repoRoot, branch } = target
  if (!isDirectory(repoRoot)) return failed(`repo_root does not exist: ${repoRoot}`)
  if ((await git(repoRoot, ['rev-parse', '--git-dir'])).status !== 0) {
    return failed(`not a git repository: ${repoRoot}`)
  }
  // `check-ref-format` accepts `refs/heads/-D`, and `branch -D -D` reads it
  // as an option. So a dash at the start is its own check.
  if (branch.startsWith('-')) return failed(`branch name must not begin with a dash: ${branch}`)
  if ((await git(repoRoot, ['check-ref-format', `refs/heads/${branch}`])).status !== 0) {
    return failed(`not a valid branch name: ${branch}`)
  }
  const root = resolvePhysical(repoRoot)
  const tree = `${root}/.claude/worktrees/`
  if (hasDotDot(target.work)) {
    return failed(`the work path must not contain a .. segment: ${target.work}`)
  }
  const work = resolvePhysical(target.work)
  if (!isContained(root, work)) {
    return failed(`the work path is not under ${tree}: ${work}. Nothing was removed.`)
  }
  if (target.recordedWork !== undefined) {
    const recorded = resolvePhysical(target.recordedWork)
    if (recorded !== work) {
      return failed(
        `--work names ${work}, but setup recorded this run's workspace as ${recorded}. ` +
          'A removal is only ever issued against the path this run created; nothing was removed.',
      )
    }
  }
  if (hasDotDot(target.worktree)) {
    return failed(`the worktree path must not contain a .. segment: ${target.worktree}`)
  }
  const worktree = resolvePhysical(target.worktree)
  if (!isContained(root, worktree)) {
    return failed(`the worktree path resolves outside ${tree}: ${worktree}. Nothing was removed.`)
  }
  return ok({ repoRoot: root, work, worktree, branch })
}

/** The one admin entry whose `gitdir` file names the worktree, or null. */
const adminEntry = async (git: Git, target: Contained): Promise<string | null> => {
  const common = await git(target.repoRoot, ['rev-parse', '--git-common-dir'])
  if (common.status !== 0) return null
  const entries = resolve(target.repoRoot, common.stdout.trim(), 'worktrees')
  // A registration lives in this directory, so it is there. An entry with
  // no `gitdir` file names no worktree.
  for (const name of readdirSync(entries).sort()) {
    const entry = join(entries, name)
    let recorded: string
    try {
      recorded = readFileSync(join(entry, 'gitdir'), 'utf8').split('\n', 1).join('')
    } catch {
      continue
    }
    if (recorded === `${target.worktree}/.git`) return entry
  }
  return null
}

interface Step<A> {
  readonly action: A
  readonly error: string | null
}

/** Step 1: the worktree. */
const removeWorktree = async (git: Git, target: Contained): Promise<Step<WorktreeAction>> => {
  const { repoRoot, worktree } = target
  if (existsSync(join(worktree, '.git'))) {
    const removed = await git(repoRoot, ['worktree', 'remove', '--force', worktree])
    return removed.status === 0
      ? { action: 'removed', error: null }
      : {
          action: 'failed',
          error: `git worktree remove --force ${worktree} failed: ${outputOf(removed)}`,
        }
  }
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (listed.status !== 0) {
    return { action: 'failed', error: `git worktree list failed: ${outputOf(listed)}` }
  }
  if (!listed.stdout.split('\n').includes(`worktree ${worktree}`)) {
    return { action: isDirectory(worktree) ? 'not-a-worktree' : 'absent', error: null }
  }
  const entry = await adminEntry(git, target)
  if (entry === null) {
    return {
      action: 'stale-registration',
      error: `a registration for ${worktree} survives and no admin entry names it`,
    }
  }
  try {
    rmSync(entry, { recursive: true, force: true })
  } catch (error) {
    return {
      action: 'stale-registration',
      error: `could not remove the admin entry ${entry}: ${oneLine(thrownText(error))}`,
    }
  }
  return { action: 'stale-registration-removed', error: null }
}

/** Step 2: the work directory. `blocked` is a failed step 1. */
const removeWork = (work: string, blocked: boolean): Step<WorkDirAction> => {
  if (blocked) return { action: 'skipped', error: null }
  if (isDirectory(work)) {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch (error) {
      return { action: 'failed', error: `${work} was not removed: ${oneLine(thrownText(error))}` }
    }
    return { action: 'removed', error: null }
  }
  // No step of the flow makes a file here, so it is reported and kept.
  return existsSync(work)
    ? { action: 'not-a-directory', error: `the work path exists and is not a directory: ${work}` }
    : { action: 'absent', error: null }
}

/** A ref: its commit, null when it is not there, or the failure of the read. */
const readRef = async (
  git: Git,
  repoRoot: string,
  ref: string,
): Promise<{ readonly tip: string | null; readonly error: string | null }> => {
  const read = await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref])
  if (read.status === 0) return { tip: read.stdout.trim(), error: null }
  // `--quiet` answers a missing ref with exit 1 and no stderr. Any text on
  // stderr, or a git that did not start, is a failed read.
  const text = outputOf(read)
  return text === ''
    ? { tip: null, error: null }
    : { tip: null, error: `git rev-parse ${ref} failed: ${text}` }
}

/** Step 3: the branch. */
const decideBranch = async (
  git: Git,
  target: Contained,
  policy: BranchPolicy,
): Promise<{ readonly ref: Reaped['branch_ref']; readonly errors: string[] }> => {
  const { repoRoot, branch } = target
  const local = await readRef(git, repoRoot, `refs/heads/${branch}`)
  const origin = await readRef(git, repoRoot, `refs/remotes/origin/${branch}`)
  const dflt =
    policy.defaultBranch === null
      ? { tip: null, error: null }
      : await readRef(git, repoRoot, `refs/remotes/origin/${policy.defaultBranch}`)
  const tips = { local_tip: local.tip, origin_tip: origin.tip }
  const readErrors = [local.error, origin.error, dflt.error].filter((e): e is string => e !== null)
  if (readErrors.length > 0) {
    return { ref: { action: 'left', reason: 'tip-read-failed', ...tips }, errors: readErrors }
  }
  if (local.tip === null) {
    return { ref: { action: 'absent', reason: 'no-local-branch', ...tips }, errors: [] }
  }
  const safe: BranchReason | null =
    policy.pushed && origin.tip === local.tip
      ? 'tip-on-origin'
      : dflt.tip === local.tip
        ? 'tip-on-default'
        : policy.leftover !== undefined && (await policy.leftover(git, target))
          ? 'own-leftover'
          : null
  if (safe === null) {
    const reason: BranchReason =
      origin.tip === null
        ? 'no-remote-tracking-ref'
        : origin.tip === local.tip
          ? 'push-not-confirmed'
          : 'tip-not-on-origin'
    return { ref: { action: 'left', reason, ...tips }, errors: [] }
  }
  const deleted = await git(repoRoot, ['branch', '-D', branch])
  if (deleted.status !== 0) {
    return {
      ref: { action: 'left', reason: 'delete-failed', ...tips },
      errors: [`git branch -D ${branch} failed: ${outputOf(deleted)}`],
    }
  }
  return { ref: { action: 'deleted', reason: safe, ...tips }, errors: [] }
}

/** Remove what one fix group left. `target` comes from {@link contain}. */
export const reap = async (target: Contained, policy: BranchPolicy, git: Git): Promise<Reaped> => {
  const worktree = await removeWorktree(git, target)
  const blocked = worktree.action === 'failed' || worktree.action === 'stale-registration'
  const work = removeWork(target.work, blocked)
  const branch = await decideBranch(git, target, policy)
  const errors = [worktree.error, work.error, ...branch.errors].filter(
    (error): error is string => error !== null,
  )
  const leftBehind = [
    blocked ? target.worktree : null,
    work.action === 'removed' || work.action === 'absent' ? null : target.work,
    branch.ref.action === 'left' ? target.branch : null,
  ].filter((entry): entry is string => entry !== null)
  return {
    repo_root: target.repoRoot,
    branch: target.branch,
    work: target.work,
    worktree: { path: target.worktree, action: worktree.action },
    work_dir: { path: target.work, action: work.action },
    branch_ref: branch.ref,
    left_behind: leftBehind,
    errors,
  }
}
