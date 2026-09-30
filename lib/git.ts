// This file holds the git calls the ported scripts make more than once, and
// the two calls that need care. This file is not a git SDK. RFC 001 decision
// 3 gives the reason. It names "typed functions written before anything
// calls them" as the argument against a full SDK.
//
// Each export below names the Python call site that is its first user. A
// command that needs a git subcommand no other command uses calls
// {@link gitOut} with that subcommand. It does not add a new function here.
//
// git is never mocked (ADR 001, RFC 001 "The testing seam"). This file's own
// test suite runs real git against repositories it makes in scratch
// directories.
//
// This file is part of what ships to users. It imports nothing outside the
// root `lib` directory, and it stays inside the erasable subset (ADR 001).

// **The Python code this file ports was deleted at #127.**
// `plugins/gh/scripts/*.py`, its `lib/`, and `plugins/gh/hooks/hook-io.py`
// are gone from the tree. The file and line references below point to what
// they held at commit `cd0d515`. Each reference stays because it shows where
// a rule came from. The deletion did not change anything in this file.
import { type RunResult, run } from './process.ts'

export interface GitOptions {
  /** The repository to run the git command in. This is the port of both
   *  `git -C <dir> ...` and the `chdir` call. `gh-sync-repo.py:195` makes
   *  that call before its own git calls. */
  readonly cwd?: string
  /** The whole environment for the child process, for a caller that must
   *  pin one. The test suite passes an environment of its own. This keeps
   *  a developer's own git configuration out of a fixture. */
  readonly env?: NodeJS.ProcessEnv
  /** A time limit, in milliseconds. A caller that runs git over the
   *  network sets one, because the whole check has a deadline. */
  readonly timeoutMs?: number
}

/**
 * Runs git, and returns everything the child process did.
 *
 * The first user is `gh-sync-repo.py:65` to `86`. Its preflight check is the
 * one caller that needs more than "git said no". Every other part of the
 * port should use {@link gitOut} or {@link gitOk} instead.
 *
 * The preflight check must report three separate facts, each in its own
 * sentence. The first is "git is not on PATH". Its code is `ENOENT`, on the
 * {@link RunResult.startFailure} field. The second is "git is on PATH and
 * still did not run". The third is "this is not a git repository". There the
 * child process ran, then exited with a non-zero status.
 *
 * The second fact, "git is on PATH and still did not run", applies only to a
 * libuv error number. A code that starts with `ERR_` means node refused the
 * argument list this process built. Git was never asked to run in that case.
 * The wrong sentence there would send the reader to check an install. The
 * real fault is in this code's own call, not git. {@link StartFailure.code}
 * lists both sets of codes.
 */
export const runGit = (args: readonly string[], options: GitOptions = {}): Promise<RunResult> =>
  run('git', args, { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs })

/**
 * Returns git's output on stdout, with trailing newlines removed. Returns
 * `null` when git failed.
 *
 * This is the port of `git_out` (`gh-sync-repo.py:88`). It is the workhorse
 * function: fifteen call sites there use it, plus `hook-io.py:159` and
 * `lib/discover.py:50`.
 *
 * `null` and `""` are different answers on purpose, and both occur.
 * `show-ref --verify --quiet` succeeds with no output at all, so only `null`
 * can mean "the ref is not there". `git status --porcelain` answers `""`
 * when the whole tree is clean. `null` there means the probe could not run
 * at all (`gh-sync-repo.py:231`). If code reads the second case as the
 * first, a corrupt index can pass a cleanliness check.
 *
 * Only trailing newlines are stripped. Leading space is never stripped.
 * `status --porcelain` encodes the staged and unstaged columns in the first
 * two characters. " M file" and "?? file" differ only in a leading blank,
 * and a full trim would remove it.
 *
 * git's stderr is dropped here, the way the Python drops it. Every caller
 * below already reports "git said no" in its own words. The one caller that
 * needs git's own message uses {@link runGit} instead.
 *
 * `null` here does not separate several different cases. A time limit may
 * have fired. git may not be on PATH. git may be on PATH and still not run.
 * A pipe may have failed part way through ({@link RunResult.streamErrors}).
 *
 * Most of these cases arrive here as `null`. The exception is a pipe that
 * failed after an otherwise successful run. There, `null` becomes the short
 * text that came through before the failure.
 *
 * `lib/gh.ts` can tell these cases apart, because it takes its runner as a
 * parameter. This file calls {@link run} directly, so a branch here could
 * only be reached by a real pipe that fails. The coverage rule refuses a
 * branch that no test can reach, rather than excuse it. A caller that needs
 * the distinction uses {@link runGit}, which returns the whole result.
 */
export const gitOut = async (
  args: readonly string[],
  options: GitOptions = {},
): Promise<string | null> => {
  const result = await runGit(args, options)
  if (result.status !== 0) return null
  return result.stdout.replace(/\n+$/, '')
}

/** Whether git succeeded. This is the port of `git_ok` (`gh-sync-repo.py:95`).
 *  That script uses it to attempt every write: checkout, merge --ff-only,
 *  branch -D, and worktree remove. */
export const gitOk = async (args: readonly string[], options: GitOptions = {}): Promise<boolean> =>
  (await runGit(args, options)).status === 0

/** Returns git's stdout as a list of its non-empty lines. Returns `null`
 *  when git failed. This is the port of `git_lines` (`gh-sync-repo.py:98`).
 *  It has two callers: the merged branch list and the local branch list.
 *  Both callers must tell "no branches" apart from "the list could not be
 *  read". */
export const gitLines = async (
  args: readonly string[],
  options: GitOptions = {},
): Promise<string[] | null> => {
  const out = await gitOut(args, options)
  if (out === null) return null
  return out.split('\n').filter((line) => line !== '')
}

/**
 * These are the options every question below takes. Each one names one
 * repository, and the environment to ask it in.
 *
 * {@link GitOptions} leaves both `cwd` and `env` optional. Here, and in the
 * default `gitOut` uses, the whole object is required. Each question below
 * asks about ONE repository. Neither `cwd` alone nor `env` alone says which
 * one.
 *
 * `cwd` is the obvious half. A call that names no directory would ask about
 * wherever the process happens to sit.
 *
 * `env` is the half that actually matters, and it is required, not
 * optional. `GIT_DIR` outranks both `cwd` and `git -C` for everything the
 * git directory holds. With `GIT_DIR` set, {@link currentBranch} reads the
 * named repository's HEAD. {@link defaultBranch} reads its `origin/HEAD`.
 * {@link hasRef} reads its refs. Each does this whatever directory the call
 * gave.
 *
 * {@link toplevel} is the one exception, and it deserves a closer look.
 * `GIT_DIR` with no `GIT_WORK_TREE` set makes the current directory the top
 * of the work tree. So `rev-parse --show-toplevel` still answers about
 * `cwd`. `GIT_WORK_TREE` is the variable that changes this, and git
 * exports it into a hook's children too.
 *
 * git exports `GIT_DIR` and `GIT_INDEX_FILE` into every child of a hook. A
 * pre-commit hook is one place this test suite runs (`lefthook.yml`). An
 * optional `env` here would be a rule stated in a comment, but never
 * checked. The caller that most needs to pin `env` is the one most likely
 * to leave it out.
 *
 * **This requirement names the environment; it does not scrub it.** `env:
 * process.env` satisfies this type. Inside the hook described above, it
 * still carries `GIT_DIR` at full strength. Nothing in this file strips
 * anything from the environment.
 *
 * Nothing here can. This file calls {@link run} directly, so it has no
 * seam for that. A caller who chose an environment is entitled to the one
 * it chose.
 *
 * What the required field does is put the environment at the call site.
 * There a reader sees which environment is in use, and a reviewer can ask
 * whether it is the right one. Read this as "say which environment", never
 * as "git is safe from `GIT_DIR`".
 *
 * The port's own answer, for a caller with nothing to pin, is
 * `process.env`. Every ported call site inherits it today (`grep GIT_DIR
 * plugins/gh/` finds nothing). If a caller passed `{}` instead, it would
 * drop `HOME` and `PATH` too. Global config discovery and credential
 * helpers would then behave differently. This default is named here so
 * that later layers do not each invent a different one.
 *
 * The four helpers above keep `env` optional on purpose. They are the
 * general escape hatch, and the preflight check that reports on git
 * itself. For those, the ambient environment is sometimes the very thing
 * that callers ask about (`gh-sync-repo.py:65` to `86`). To silently
 * rewrite an environment that a caller chose would be its own defect.
 */
export interface RepoOptions extends GitOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/**
 * Reads an empty answer as no answer at all. Three questions below can
 * never have the empty string as a real answer. This helper folds their
 * empty case into `null`.
 *
 * A checkout root, and the branch HEAD is on, are each a name, or
 * nothing. So is the ref `origin/HEAD` points at. So `""` there means git
 * said nothing, not that git gave an answer.
 *
 * The Python code read all three that way. `lib/discover.py` used `return
 * top or None`. `gh-sync-repo.py:210`, `:241`, and `:349` used `not top`,
 * `not ref`, and `or "HEAD"`. Every caller of these three questions
 * repeated that same fold by hand.
 *
 * {@link gitOut}, {@link gitOk}, {@link gitLines}, {@link hasRef}, and
 * {@link runGit} do NOT use this fold. The difference between `null` and
 * `""` matters there. `git status --porcelain` answers `""` for a clean
 * tree, but `null` means the probe could not run at all. `show-ref
 * --verify --quiet` succeeds with no output at all, which is a third case
 * these functions must tell apart.
 */
const answered = (out: string | null): string | null => (out === '' ? null : out)

/**
 * Returns the checkout root that contains `options.cwd`, or `null` when
 * there is none.
 *
 * This is the port of `toplevel` (`lib/discover.py:50`). `gh-sync-repo.py:203`,
 * `gh-shepherd-status.py:144`, and `gh-shepherd-pr.py:1014` ask the same
 * question. A missing git gives the same answer as a directory outside any
 * checkout: no root. The callers do not care about that distinction. If
 * this function raised an error here, it would turn a degraded environment
 * into a crash.
 *
 * The Python code reads an empty answer as no root too, and so does this
 * function, through {@link answered}. An earlier comment here said that
 * case could not happen. It reasoned that git 2.54 refuses `rev-parse
 * --show-toplevel` in a bare repository with status 128. It does not
 * answer empty.
 *
 * That claim is true of real git. It is false of the git a caller put on
 * PATH. That is the only git this function has. CI on #159 reached that
 * case, and each caller folded the empty answer by hand.
 *
 * The path git prints has its symlinks resolved. That is why `discover.py`
 * compares it against `os.path.realpath`. To resolve the caller's own path
 * is the caller's job, not this function's.
 */
export const toplevel = async (options: RepoOptions): Promise<string | null> =>
  answered(await gitOut(['rev-parse', '--show-toplevel'], options))

/**
 * Returns the branch HEAD is on. Returns `"HEAD"` when HEAD is detached.
 * Returns `null` when git could not answer.
 *
 * This is the port of `gh-sync-repo.py:349` and `hook-io.py:210`. Both read
 * `"HEAD"` as "there is no branch to talk about." It is git's own word for
 * that case. So this function passes it through.
 *
 * It does not fold `"HEAD"` into `null`, because `null` means something
 * else here. An empty answer IS folded, through {@link answered}. When
 * git names no branch at all, that is not the same as when git names one.
 */
export const currentBranch = async (options: RepoOptions): Promise<string | null> =>
  answered(await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], options))

const ORIGIN_HEAD = 'refs/remotes/origin/HEAD'
const ORIGIN_PREFIX = 'refs/remotes/origin/'

/**
 * Returns the default branch, as the cached `origin/HEAD` records it, or
 * `null`.
 *
 * This is the port of half of `default_branch` (`hook-io.py:184`). It is
 * also half of `resolve_default_branch` (`gh-sync-repo.py:239`). Only the
 * half both callers share is here: it reads the ref, with no network round
 * trip and no write. A ref read as the empty string counts as no ref,
 * through {@link answered}. A default branch of `""` is the one answer
 * neither caller can use, so both fall back to `null`.
 *
 * The rest is left to the callers on purpose, because they disagree about
 * it. `gh-sync-repo.py` repairs a missing `origin/HEAD` with `git remote
 * set-head --auto`. That is a write, and it skips the write under
 * `--dry-run`. It then falls back to gh, and to
 * `refs/remotes/origin/{main,master}`.
 *
 * `hook-io.py` must never write, so it falls back to
 * `refs/heads/{main,master}` instead. A single "default branch" function
 * here would have to take both fallbacks as arguments. That would just be
 * the caller's own code with an extra layer in front of it.
 */
export const defaultBranch = async (options: RepoOptions): Promise<string | null> => {
  const ref = answered(await gitOut(['symbolic-ref', '--quiet', ORIGIN_HEAD], options))
  if (ref === null) return null
  // `hook-io.py:196` passes through a ref that does not carry the prefix.
  // It does not change the ref by mistake. This function does the same.
  return ref.startsWith(ORIGIN_PREFIX) ? ref.slice(ORIGIN_PREFIX.length) : ref
}

/**
 * Whether `ref` exists. Name it in full: `refs/heads/main`, or
 * `refs/remotes/origin/main`.
 *
 * This is the port of the `show-ref --verify --quiet` calls at
 * `hook-io.py:199`, `gh-sync-repo.py:369`, and `gh-sync-repo.py:262`. Use
 * full ref names, not short forms. `--verify` needs a full name, and the
 * three call sites ask about two different namespaces.
 */
export const hasRef = (ref: string, options: RepoOptions): Promise<boolean> =>
  gitOk(['show-ref', '--verify', '--quiet', ref], options)
