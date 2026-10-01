// `gh-security discover-repos [<path>]`: list the repository checkouts that a
// target directory holds. This is the port of `scripts/common/discover-repos.sh`
// and of the contract in ADR 011: scope is the checkouts on disk.
//
// Output: `{target, repos}`. `target` is the resolved path. Scope comes from
// the target, so no caller classifies it:
//
//   - The target is inside a git repository: `repos` is that checkout's root.
//   - It is not: `repos` is every immediate subdirectory that is the root of a
//     checkout, non-recursively, sorted by the resolved path and without
//     duplicates. Two links to one checkout are one entry.
//
// **Nothing is ever cloned.** This command never reaches the network.
//
// **An empty list is an answer.** A target that is not a directory, a target
// or a child that cannot be entered, and every git failure other than "not a
// git repository" are errors. An unreadable workspace must never read as a
// tidy empty one. Each git failure names git's exit status, because git can
// fail with nothing on stderr.
//
// **"Not a git repository" is believed only when no `.git` exists at or above
// the path on the path's own filesystem.** A target below a broken checkout
// gets the same words as a plain directory. The walk stops where git's own
// search stops, at a mount point. A dangling `.git` symlink counts as present.
//
// The git environment is stripped, because `GIT_DIR` and its kin let the
// answer come from the environment and not from the target. `LC_ALL=C` keeps
// git's messages in English, which the classification matches on.
//
// **Identity is compared by device and inode, and every emitted path is
// git's own.** On a case-insensitive filesystem, the spelling that the caller
// typed and the spelling on disk are two names for one directory. A symlinked
// child is followed, so its resolved root is listed. A link into a
// subdirectory is not a root, and is skipped.
//
// Skipped without comment: a directory that is not a checkout root, a
// dot-directory, and a bare repository (git refuses `--show-toplevel` in one,
// by the work-tree refusal or by `safe.bareRepository=explicit`).
//
// Differences from the script, all of them refusals or repairs:
//   - A child whose name has a newline is an error, as in the script. A
//     resolved root with a newline is kept whole here. The script splits it
//     into two entries.
//   - A child whose name has U+FFFD is an error. Node writes that mark for a
//     byte that is not UTF-8, and a path with the mark is not the path on disk.
//   - A leading dash is an option, as in every command here. Write `--` first
//     for a path that starts with one.
//   - A failure is `{"error": ...}` on stdout and prose on stderr, with
//     exit 1, as `cli.md` says for every command. The script wrote the JSON on
//     stderr and left stdout empty.
//   - No `jq` is needed.
//
// This file ships. It imports nothing outside the plugin.

import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { failed, ok } from '../lib/envelope.ts'
import { type Runner, type RunResult, run } from '../lib/process.ts'

/**
 * What the command reaches outside itself. `git` is the process runner.
 * `deviceOf` names the filesystem of a path, or null when it cannot say. A
 * mount point is a change of device, and a test cannot mount a volume. `list`
 * reads the names in a directory.
 */
export interface DiscoverDeps {
  readonly git: Runner
  readonly deviceOf: (path: string) => number | null
  readonly list: (path: string) => string[]
}

/** The real seams. */
export const nodeDeps: DiscoverDeps = {
  git: run,
  deviceOf: (path) => {
    try {
      return statSync(path).dev
    } catch {
      return null
    }
  },
  list: (path) => readdirSync(path),
}

/** Each of these lets the environment answer instead of the target. */
const GIT_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]

/** An error of the command. It ends the run with this message. */
class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(message)
}

/** The same order as the script's `sort`: the bytes of the text. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

/** Text with its trailing newlines removed, as `$( )` removes them. */
const chomp = (text: string): string => text.replace(/\n+$/, '')

/** Whether any entry, including a dangling symlink, is at the path. */
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Whether the path is a directory, after links. A path that cannot be read is not one. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The device and inode of a path, after links, or null when it cannot be read. */
const identity = (path: string): string | null => {
  try {
    const { dev, ino } = statSync(path, { bigint: true })
    return `${dev}:${ino}`
  } catch {
    return null
  }
}

/** The resolved path of a directory that this process can enter, as `cd -P` and `pwd -P` give it. */
const enter = (path: string): string => {
  try {
    accessSync(path, constants.X_OK)
    return realpathSync.native(path)
  } catch (error) {
    return refuse(`could not enter ${path}: ${(error as Error).message}`)
  }
}

interface Context {
  readonly deps: DiscoverDeps
  readonly env: NodeJS.ProcessEnv
}

const git = (context: Context, args: readonly string[]): Promise<RunResult> =>
  context.deps.git('git', args, { env: context.env })

/** What git said about a failure: its words, or the reason it never started. */
const saidBy = (result: RunResult): string =>
  result.startFailure === null ? chomp(result.stderr) : result.startFailure.message

/**
 * The nearest `.git` at or above a path, or null. The walk never leaves the
 * path's own filesystem. A device that cannot be named counts as the same
 * one, which keeps the walk going: to stop early is the silent-skip
 * direction.
 */
const dotgitAbove = (context: Context, start: string): string | null => {
  const startDevice = context.deps.deviceOf(start)
  let walk = start
  for (;;) {
    if (present(`${walk}/.git`)) return walk
    if (walk === '/') return null
    const cut = walk.lastIndexOf('/')
    const parent = cut <= 0 ? '/' : walk.slice(0, cut)
    const parentDevice = context.deps.deviceOf(parent)
    if (startDevice !== null && parentDevice !== null && startDevice !== parentDevice) return null
    walk = parent
  }
}

/**
 * The checkout root of a path, or null for the two shapes that git may
 * answer "no" about: a directory in no repository, and a bare repository.
 * Every other failure is a refusal.
 */
const toplevel = async (context: Context, path: string): Promise<string | null> => {
  const result = await git(context, ['-C', path, 'rev-parse', '--show-toplevel'])
  if (result.status === 0) return chomp(result.stdout)
  const message = saidBy(result)
  const failure = (where: string): never =>
    refuse(`git failed in ${where} (exit ${result.status ?? result.signal}): ${message}`)
  if (/[Nn]ot a git repository/.test(message)) {
    // The same words come for a checkout whose `.git` git could not read.
    const broken = dotgitAbove(context, path)
    return broken === null ? null : failure(broken)
  }
  if (message.includes('must be run in a work tree')) {
    // A bare repository and a git directory handed in as the path say the
    // same thing, so bare-ness is asked for. A git directory whose work tree
    // is elsewhere is the caller pointing at the wrong path.
    const bare = await git(context, ['-C', path, 'rev-parse', '--is-bare-repository'])
    return chomp(bare.stdout) === 'true' ? null : failure(path)
  }
  // `safe.bareRepository=explicit` refuses a bare repository before it can be
  // asked anything, so git has already named the shape.
  if (message.includes('cannot use bare repository')) return null
  return failure(path)
}

/** The checkout roots of the immediate children, sorted, without duplicates. */
const childRoots = async (context: Context, target: string): Promise<string[]> => {
  let names: string[]
  try {
    names = context.deps.list(target)
  } catch (error) {
    return refuse(`could not list ${target}: ${(error as Error).message}`)
  }
  const roots = new Set<string>()
  // The order of the script's glob, so the first error is the same one.
  for (const name of names.filter((entry) => !entry.startsWith('.')).sort(byBytes)) {
    const child = `${target}/${name}`
    if (!isDirectory(child)) continue
    if (name.includes('\n')) {
      refuse(`could not list ${child}: a path containing a newline cannot be listed one per line`)
    }
    if (name.includes('�')) {
      refuse(`could not list ${child}: the name is not valid UTF-8`)
    }
    const resolved = enter(child)
    const root = await toplevel(context, child)
    if (root === null) continue
    // A directory that sits inside some enclosing repository answers that
    // repository's root, and is not this entry.
    const rootIdentity = identity(root)
    if (rootIdentity !== null && rootIdentity === identity(resolved)) roots.add(root)
  }
  return [...roots].sort(byBytes)
}

/** The handler. The seams and the working directory are parameters. */
export const discoverRepos = async (
  commandContext: CommandContext,
  deps: DiscoverDeps,
  cwd: string,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(commandContext.args, {})
  if (parsed.outcome !== 'ok') return parsed
  const env: NodeJS.ProcessEnv = { ...commandContext.env, LC_ALL: 'C' }
  for (const name of GIT_OVERRIDES) delete env[name]
  const context: Context = { deps, env }
  try {
    // A missing git is named as such, before anything else is asked of it.
    const probe = await git(context, ['--version'])
    if (probe.startFailure !== null) refuse('git is required but was not found on PATH')

    const given = parsed.value.positionals[0] || cwd
    const wanted = given.startsWith('/') ? given : `${cwd}/${given}`
    // A missing path and a regular file are the same answer: no directory is
    // here. The path is as the caller gave it, which is what they correct.
    if (!isDirectory(wanted)) refuse(`not a directory: ${given}`)
    try {
      accessSync(wanted, constants.R_OK | constants.X_OK)
    } catch {
      refuse(`could not read ${wanted}: permission denied`)
    }
    // Resolved by the system, which reports the spelling on disk.
    const target = enter(wanted)
    const root = await toplevel(context, target)
    const repos = root === null ? await childRoots(context, target) : [root]
    return ok({ target, repos })
  } catch (error) {
    if (error instanceof Refusal) return failed(error.message)
    throw error
  }
}

export const discoverReposCommand: CommandHandler = (context) =>
  discoverRepos(context, nodeDeps, process.cwd())
