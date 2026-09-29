// The git helpers, built on the process runner. Two things live here:
//
//   * the path-containment helpers copied today between `fix-group.sh` and
//     `reap-agent-artifacts.sh`, which both run `rm -rf` on the same
//     directory from opposite sides;
//   * the git queries those scripts share, each of which distinguishes an
//     answer from a failure rather than folding the two together.
//
// git is a process seam (ADR 001 as amended by ADR 012), so every query goes
// through the runner and every one of them carries `-C`: nothing here ever
// depends on the current directory.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs` and `path`.

import { realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { type EnvPrefix, NO_ENV_PREFIX, withEnvPrefix } from './env-prefix.ts'
import { type Envelope, failure, ok } from './envelope.ts'
import { describeRun, type RunResult, run, type Spawn } from './process-runner.ts'

export interface GitOptions {
  readonly spawn?: Spawn
  readonly envPrefix?: EnvPrefix
}

/** Where this plugin's agent worktrees live, under a repository's own root. */
export const AGENT_WORKTREE_SEGMENT = join('.claude', 'worktrees')

// ---------------------------------------------------------------------------
// Path containment, for the operations that delete
// ---------------------------------------------------------------------------

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The physical path, resolved as far as it exists.
 *
 * A path under test may already be gone, which is the idempotent success case
 * for a reap, so the walk goes up to the deepest ancestor that does exist,
 * resolves that physically, and re-appends the rest. Resolving only the
 * immediate parent would fail the containment guard on a second run that
 * finds `.claude/worktrees/` itself already gone.
 *
 * Resolution can only ever make containment stricter. A component that cannot
 * be entered, or a link pointing out of the tree, resolves to something the
 * prefix test then rejects; there is no arrangement of links that resolves a
 * path INTO the worktree root it did not already name.
 */
export const resolveExistingAncestor = (target: string): string => {
  const segments = resolve(target).split(sep)
  // Splitting an absolute path leaves an empty first segment, so the root is
  // the empty join and is spelled here rather than branched on at each use.
  const headAt = (depth: number): string => segments.slice(0, depth).join(sep) || sep
  // The root is segment 0 and always exists, so the walk terminates by
  // running out of segments rather than by a test no machine can take.
  let index = segments.length
  while (index > 1 && !isDirectory(headAt(index))) index -= 1
  return join(realpathSync(headAt(index)), ...segments.slice(index))
}

/**
 * Whether any segment of the path is `..`.
 *
 * Wider than the two shell patterns it replaces, which between them could
 * not see a leading `..` segment.
 */
export const containsDotDot = (path: string): boolean => path.split(/[\\/]/).includes('..')

/**
 * Whether a path names something strictly under this repository's agent
 * worktree root. Both arguments are physical paths, resolved by the caller
 * through {@link resolveExistingAncestor}, so a symlink cannot smuggle a
 * path past the prefix test.
 *
 * The root itself is never accepted, only a directory under it: that is what
 * the trailing wildcard of the shell pattern this replaces bought, and it is
 * what keeps a caller from deleting every agent's worktree at once.
 */
export const withinAgentWorktrees = (repoRoot: string, candidate: string): boolean => {
  if (containsDotDot(repoRoot) || containsDotDot(candidate)) return false
  const root = join(repoRoot, AGENT_WORKTREE_SEGMENT) + sep
  return candidate.startsWith(root) && candidate.length > root.length
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Run git against a directory, answering with the result whatever its exit
 * status: the caller decides what a non-zero status means.
 *
 * The empty-directory guard is the first thing it does, and it refuses rather
 * than running: `git -C ""` is neither an error nor a no-op, git silently
 * operates on the CURRENT directory, so one empty path puts a repo-targeted
 * write in the user's own checkout (issue #18). In bash that guard could only
 * be defence in depth, because its `die` inside a command substitution ended
 * the subshell and the caller carried on; returning a failure the caller
 * cannot discard is what the port makes of it.
 */
export const gitRun = (
  dir: string,
  args: readonly string[],
  options: GitOptions = {},
): Envelope<RunResult> => {
  if (dir === '') {
    return failure(
      `refusing to run 'git ${args.join(' ')}' with an empty directory: ` +
        "git -C '' operates on the current directory, which is how a " +
        "repo-targeted write lands in the user's checkout (#18).",
    )
  }
  const request = withEnvPrefix(options.envPrefix ?? NO_ENV_PREFIX, {
    command: 'git',
    args: ['-C', dir, ...args],
  })
  return ok(run(request, options.spawn))
}

/**
 * Run git and read a non-zero status as a failure. This is what every caller
 * wants except the ones that have to tell "git said no" from "git failed",
 * which reach for {@link gitRun} instead.
 */
export const git = (
  dir: string,
  args: readonly string[],
  options: GitOptions = {},
): Envelope<RunResult> => {
  const ran = gitRun(dir, args, options)
  if (ran.outcome !== 'ok') return ran
  return ran.value.status === 0 ? ran : failure(describeRun(ran.value))
}

/**
 * One line of output, refusing an empty answer. A git command that exits 0
 * having printed nothing has answered nothing, and reading that as a value is
 * the found-nothing-is-a-pass shape this plugin refuses everywhere.
 */
const oneLine = (envelope: Envelope<RunResult>, what: string): Envelope<string> => {
  if (envelope.outcome !== 'ok') return envelope
  const line = envelope.value.stdout.trim()
  return line === '' ? failure(`git ${what} answered nothing`) : ok(line)
}

/** Whether the directory is inside a git repository at all. */
export const isGitRepository = (dir: string, options: GitOptions = {}): boolean =>
  git(dir, ['rev-parse', '--git-dir'], options).outcome === 'ok'

/** The repository top for a directory. */
export const topLevel = (dir: string, options: GitOptions = {}): Envelope<string> =>
  oneLine(git(dir, ['rev-parse', '--show-toplevel'], options), 'rev-parse --show-toplevel')

/**
 * The common git directory, absolute. git answers relatively for a primary
 * checkout (`.git`) and absolutely for a linked worktree, and the scripts
 * that read it re-anchor the relative answer themselves; doing it here means
 * one place rather than two.
 */
export const gitCommonDir = (dir: string, options: GitOptions = {}): Envelope<string> => {
  const answer = oneLine(
    git(dir, ['rev-parse', '--git-common-dir'], options),
    'rev-parse --git-common-dir',
  )
  return answer.outcome === 'ok' ? ok(resolve(dir, answer.value)) : answer
}

/**
 * The tip a ref names, or `null` when there is no such ref.
 *
 * `rev-parse --verify --quiet` answers a missing ref with empty stdout, exit
 * 1 and no stderr; a real failure writes stderr. The two are distinguishable
 * only by that stderr, and folding them together reports a branch as absent
 * on a transient failure, which is how a stale-branch guard passes on a
 * repository it never managed to read.
 */
export const readRef = (
  dir: string,
  ref: string,
  options: GitOptions = {},
): Envelope<string | null> => {
  const ran = gitRun(dir, ['rev-parse', '--verify', '--quiet', ref], options)
  if (ran.outcome !== 'ok') return ran
  const result = ran.value
  if (result.status === 0) return oneLine(ok(result), `rev-parse --verify ${ref}`)
  return result.stderr.trim() === '' ? ok(null) : failure(describeRun(result))
}

/** Every worktree registered against this repository, main checkout included. */
export const listWorktrees = (
  dir: string,
  options: GitOptions = {},
): Envelope<readonly string[]> => {
  const envelope = git(dir, ['worktree', 'list', '--porcelain'], options)
  if (envelope.outcome !== 'ok') return envelope
  const paths = envelope.value.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
  // `worktree list` always reports at least the checkout it was asked about,
  // so an empty list is a parse that found nothing rather than a repository
  // with no worktrees.
  return paths.length === 0 ? failure('git worktree list answered nothing') : ok(paths)
}

/**
 * Whether a path is a live worktree registration. A checked-out worktree is
 * what `worktree remove` has to take off; a plain leftover directory is not,
 * and the difference decides whether a delete is safe.
 */
export const isWorktreeRegistered = (
  dir: string,
  worktree: string,
  options: GitOptions = {},
): Envelope<boolean> => {
  const listed = listWorktrees(dir, options)
  return listed.outcome === 'ok' ? ok(listed.value.includes(worktree)) : listed
}

/**
 * The branch name, or a failure saying why git would refuse it. A name git
 * would reject is a caller bug, not something to discover halfway through a
 * delete.
 *
 * The leading-dash test is separate because `check-ref-format` accepts
 * `refs/heads/-D` happily, and that name reaches `git branch -D <name>` as an
 * option rather than as a ref.
 */
export const validateBranchName = (
  name: string,
  dir: string,
  options: GitOptions = {},
): Envelope<string> => {
  if (name.startsWith('-')) {
    return failure(`branch name must not begin with a dash: ${name}`)
  }
  const envelope = git(dir, ['check-ref-format', `refs/heads/${name}`], options)
  return envelope.outcome === 'ok' ? ok(name) : failure(`not a valid branch name: ${name}`)
}
