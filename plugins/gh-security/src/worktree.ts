// The worktree guard: refuse to act anywhere but inside a linked git worktree.
// This is the port of `scripts/common/require-linked-worktree.sh`, as a
// function. Its callers, the write verbs of the adapter (#222), call it in
// process. It has no subcommand (ruling 3 on #226).
//
// Cwd-sensitive work must land in the fix worktree and nowhere else. A lost
// cwd is real. No Bash call inherits the cwd of the previous one. A live run
// once bumped a package in a real repository that way (issue #18).
//
// The guard finds the top of the enclosing repository by a walk up to the
// first `.git`, then it classifies that `.git`. It reads files, and runs no
// `git`. So it works when git is missing, and it needs no repository built
// per example. These are the gitdir pointers that git writes:
//
//   .git is a directory                            primary checkout, refuse
//   gitdir: /abs/main/.git/worktrees/wt            linked worktree, proceed
//   gitdir: /abs/bare.git/worktrees/wt             worktree of a bare clone, proceed
//   gitdir: ../.git/modules/sub                    submodule, refuse
//   gitdir: ../../.git/modules/pkgs/deep           submodule, refuse
//   gitdir: ../../main/.git/worktrees/wt/modules/sub
//                                                  submodule inside a worktree, refuse
//   no .git above the directory                    not a repository, refuse
//
// A submodule pointer is relative. A repository under a directory named
// `modules` is an ordinary repository. So the `/worktrees/` and `/modules/`
// markers are matched with their `/` separators. The marker that comes LAST
// decides: a submodule inside a linked worktree carries both, and it is a
// submodule. The `.git/modules/`
// probe covers a submodule whose path starts with `worktrees/`, where the last
// marker is wrong. Inside a linked worktree, such a submodule has the gitdir
// `<common>/worktrees/wt/modules/worktrees/foo`, with no `.git/modules/`. So a
// third probe reads the text after the last `/.git/`. A `/modules/` after a
// `/worktrees/` there is a submodule inside a worktree (#226, round 3 ruling
// 14). A common dir under a `worktrees/` directory is before that `/.git/`,
// so it is no marker. A bare common dir has no `/.git/`. So the guard refuses
// its worktree under a `worktrees/<x>/modules/` path, in the safe direction.
// The probes do not find a submodule whose superproject git dir has no
// `/.git/` in its path (`--separate-git-dir`). When the probes see an unclear
// pointer, the guard refuses.
//
// This file ships. It imports nothing outside the plugin, and nothing from node
// beyond `fs` and `path`.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { type Envelope, failed, ok } from './lib/envelope.ts'

/** The prefix of a refusal, when the caller names no context. */
export const DEFAULT_CONTEXT = 'refusing to run here'

const POINTER_PREFIX = 'gitdir: '

/** The first directory at or above `directory` that holds a `.git`, or `null`. */
const enclosingTop = (directory: string): string | null => {
  let current = directory
  while (!existsSync(join(current, '.git'))) {
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return current
}

/**
 * The gitdir in the first line of a `.git` file, or `''` when there is none.
 * A file that cannot be read has none.
 */
const gitdirOf = (dotGit: string): string => {
  let firstLine: string
  try {
    firstLine = readFileSync(dotGit, 'utf8').split('\n', 1).join('')
  } catch {
    return ''
  }
  return firstLine.startsWith(POINTER_PREFIX) ? firstLine.slice(POINTER_PREFIX.length) : ''
}

/** What a gitdir is: a linked worktree, a submodule, or neither. */
type Kind = 'worktree' | 'submodule' | 'other'

/**
 * A `/modules/` after a `worktrees/` directory: a submodule inside a worktree.
 * The `s` flag lets `.` match a line separator, as the `*` of the bash glob
 * does. git keeps such a character in the name of a worktree.
 */
const NESTED_SUBMODULE = /(^|\/)worktrees\/.*\/modules\//s

const classify = (gitdir: string): Kind => {
  // A trailing `/`, so that the last segment can be tested as a marker too. A
  // worktree or a submodule with the name `modules` is then no marker.
  const probe = `${gitdir}/`
  const isSubmodule = probe.includes('.git/modules/')
  if (!probe.includes('/worktrees/')) return isSubmodule ? 'submodule' : 'other'
  // The text after the last `/worktrees/`. A `/modules/` in it is a submodule
  // inside this worktree.
  const afterWorktrees = probe.slice(probe.lastIndexOf('/worktrees/') + '/worktrees/'.length)
  // The text from the `.git/` of the last `/.git/`, or all of it when there
  // is none. The `(^|\/)` of the pattern reads both.
  const afterGitDir = probe.slice(probe.lastIndexOf('/.git/') + 1)
  return afterWorktrees.includes('/modules/') || isSubmodule || NESTED_SUBMODULE.test(afterGitDir)
    ? 'submodule'
    : 'worktree'
}

/** The one reason the guard refuses at `top`, or `null` when `top` is a linked worktree. */
const refusalFor = (directory: string, top: string): string | null => {
  const dotGit = join(top, '.git')
  if (statSync(dotGit).isDirectory()) {
    return top === directory
      ? `this is a primary checkout (${dotGit} is a directory)`
      : `this is a subdirectory of the primary checkout at ${top}`
  }
  const gitdir = gitdirOf(dotGit)
  if (gitdir === '') return `${dotGit} is not a readable git worktree pointer`
  const kind = classify(gitdir)
  if (kind === 'submodule') return `this is a git submodule (its gitdir is ${gitdir})`
  if (kind === 'other') return `${top} is not a linked worktree (its gitdir is ${gitdir})`
  return null
}

const refuse = (context: string, reason: string): Envelope<string> =>
  failed(
    `${context}: ${reason}. Create the fix worktree with git worktree add and run the command as: cd <worktree> && <command>.`,
  )

/**
 * The top of the linked worktree that holds `directory`, or a `failed`
 * envelope that says why the guard refuses. `context` names the work that is
 * refused, and starts the message.
 */
export const requireLinkedWorktree = (
  directory: string,
  context: string = DEFAULT_CONTEXT,
): Envelope<string> => {
  // The walk up needs an absolute path: `dirname('.')` is `.`, so the walk of
  // a relative path never leaves the cwd.
  const start = resolve(directory)
  const top = enclosingTop(start)
  if (top === null) return refuse(context, `no git repository at or above ${start}`)
  const refusal = refusalFor(start, top)
  return refusal === null ? ok(top) : refuse(context, refusal)
}
