// `gh-security ensure-worktree-exclude <repo_root>`: keep the agents' worktree
// directory out of `git status`, once per repository, before any agent starts.
// This is the port of `scripts/common/ensure-worktree-exclude.sh`.
//
// Output: `{repo_root, exclude_path, line, action}`. `action` is
// `already-present` or `added`.
//
// Two agents that work on one repository start within milliseconds of each
// other. A read-then-append from both could write the line twice, or write a
// part of it (issue #35). `.git/info/exclude` has no lock of its own. So the
// orchestrator calls this command before it starts any agent for a repository.
// Several runs at once are also safe. The read, the change and the write run
// under a `mkdir` lock, and one rename publishes the file. So no run leaves a
// torn file, and the line is there once.
//
// The path comes from `git rev-parse --git-common-dir`, and not from
// `<repo_root>/.git`. `.git/info/exclude` covers the whole repository, and the
// gitdir of a linked worktree is not the shared git directory.
//
// This file ships. It imports nothing outside the plugin, and nothing from node
// beyond `fs`, `path` and `crypto`.

// The file is read and written as `latin1`. This maps each byte to one
// character and back, so a byte that is not UTF-8 in a user's rule survives.

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { CommandContext, CommandHandler } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { type Envelope, failed, type JsonObject, ok } from '../lib/envelope.ts'
import { gitOut } from '../lib/git.ts'

/** The line that goes in `.git/info/exclude`. */
export const LINE = '.claude/worktrees/'

const USAGE = 'usage: gh-security ensure-worktree-exclude <repo_root>'

/** How long the command waits for the lock. */
export interface LockTiming {
  /** How many times it tries to make the lock. */
  readonly attempts: number
  /** The wait between two tries, in milliseconds. */
  readonly waitMs: number
}

/** 50 tries, 100 ms apart: 5 seconds in all. */
export const LOCK_TIMING: LockTiming = { attempts: 50, waitMs: 100 }

/** A lock older than this was left by a process that died. */
const STALE_LOCK_MS = 60_000

/** The mode that git gives a new exclude file. */
const NEW_FILE_MODE = 0o644

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The stats of a path, or `null` when the path cannot be read. */
const statOrNull = (path: string): Stats | null => {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** Whether the exclude file at `path` has the line as a whole line. */
const hasLine = (path: string): boolean => {
  try {
    return readFileSync(path, 'latin1').split('\n').includes(LINE)
  } catch {
    return false
  }
}

/**
 * Remove a path. A failure is ignored. A lock that stays goes stale, and the
 * caller already has its own failure to report.
 */
const removeQuietly = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // The next run removes a stale lock, or reports that it cannot get the lock.
  }
}

/** Make the lock directory. `false` when it is held, or cannot be made. */
const tryLock = (lock: string): boolean => {
  try {
    mkdirSync(lock)
    return true
  } catch {
    return false
  }
}

/**
 * Wait for the lock, and take it. A lock that a killed process left is
 * removed first: nothing here holds the lock for anywhere near a minute.
 * Without this, each later run would wait out all its tries and fail, until
 * someone removed the lock by hand.
 */
const acquire = async (lock: string, timing: LockTiming): Promise<boolean> => {
  for (let attempt = 0; attempt < timing.attempts; attempt += 1) {
    const held = statOrNull(lock)
    if (held !== null && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
      removeQuietly(lock)
    }
    if (tryLock(lock)) return true
    await wait(timing.waitMs)
  }
  return false
}

/** The text and the mode of the exclude file, in the shape of a file that is not there yet. */
interface Existing {
  readonly text: string
  readonly mode: number
}

/**
 * The exclude file as it is now. A path that is not a file counts as a file
 * that is not there: the publish step then fails on it with its own message.
 * A file that is there and cannot be read is a failure, because a rewrite
 * would lose the rules in it.
 */
const readExisting = (exclude: string): Envelope<Existing> => {
  const stats = statOrNull(exclude)
  if (stats === null || !stats.isFile()) return ok({ text: '', mode: NEW_FILE_MODE })
  try {
    return ok({ text: readFileSync(exclude, 'latin1'), mode: stats.mode & 0o777 })
  } catch {
    return failed(`cannot read ${exclude}`)
  }
}

/** The text with the line added. A last line without a newline gets one first, or it would absorb the line. */
const withLine = (text: string): string =>
  `${text === '' || text.endsWith('\n') ? text : `${text}\n`}${LINE}\n`

/**
 * Write the new exclude file beside the old one, and rename it over. The
 * rename is one step, so a reader sees the old file or the new file. The
 * temporary file is removed when a step fails.
 */
const publish = (infoDir: string, exclude: string, existing: Existing): boolean => {
  const temporary = join(infoDir, `.exclude.${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(temporary, withLine(existing.text), { flag: 'wx', encoding: 'latin1' })
    // After the write, because the mode of a new file follows the umask.
    chmodSync(temporary, existing.mode)
    renameSync(temporary, exclude)
    return true
  } catch {
    removeQuietly(temporary)
    return false
  }
}

/**
 * Add `LINE` to the shared exclude file of the repository at `repoRoot`.
 * Every failure is a `failed` envelope with a message. A caller reads one
 * shape whatever went wrong.
 */
export const ensureWorktreeExclude = async (
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  timing: LockTiming,
): Promise<Envelope<JsonObject>> => {
  if (statOrNull(repoRoot)?.isDirectory() !== true) {
    return failed(`repo_root does not exist: ${repoRoot}`)
  }
  const commonDir = await gitOut(['rev-parse', '--git-common-dir'], { cwd: repoRoot, env })
  if (commonDir === null) return failed(`not a git repository: ${repoRoot}`)
  const gitDir = commonDir.startsWith('/') ? commonDir : `${repoRoot}/${commonDir}`
  const infoDir = `${gitDir}/info`
  const exclude = `${infoDir}/exclude`
  const lock = `${infoDir}/.exclude.gh-security.lock`
  const report = (action: string): Envelope<JsonObject> =>
    ok({ repo_root: repoRoot, exclude_path: exclude, line: LINE, action })

  if (hasLine(exclude)) return report('already-present')
  try {
    mkdirSync(infoDir, { recursive: true })
  } catch {
    return failed(`cannot create ${infoDir}`)
  }
  if (!(await acquire(lock, timing))) return failed(`could not acquire ${lock}`)
  try {
    // Another holder may have written it while this run waited.
    if (hasLine(exclude)) return report('already-present')
    const existing = readExisting(exclude)
    if (existing.outcome !== 'ok') return existing
    return publish(infoDir, exclude, existing.value)
      ? report('added')
      : failed(`cannot publish ${exclude}`)
  } finally {
    removeQuietly(lock)
  }
}

export const ensureWorktreeExcludeCommand: CommandHandler = async (context: CommandContext) => {
  const parsed = parseCommandLine(context.args, {})
  if (parsed.outcome !== 'ok') return parsed
  const [repoRoot, ...extra] = parsed.value.positionals
  if (repoRoot === undefined || repoRoot === '' || extra.length > 0) return failed(USAGE)
  return ensureWorktreeExclude(repoRoot, context.env, LOCK_TIMING)
}
