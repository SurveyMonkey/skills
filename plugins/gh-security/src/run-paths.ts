// The two directories that a file flag of this CLI may name (ruling 16 on
// #346). A command writes its `--out` file, and `render-pr create` reads its
// `--title-file` and `--body-file`, only under one of them:
//   - a run directory, `<any>/plugins/data/<id>/runs/<run>/`. The
//     `resolve-alerts` skill keeps a run there (`${CLAUDE_PLUGIN_DATA}`), and
//     `remove-run` removes it.
//   - a work directory, `<any>/.claude/worktrees/<leaf>/`. `fix-group setup`
//     makes it as `<repo_root>/.claude/worktrees/fix-dependabot-<pkg>-<n>x`
//     (`fix-group-setup.ts:242`).
// Each name is one segment, and `<id>`, `<run>` and `<leaf>` can be any name.
//
// The rule has two parts:
//   - `isPlainPath`: the text is an absolute path with no `.`, `..` or empty
//     segment, and no `/` at its end. The allow hook reads only this text,
//     and cannot resolve the tree of the user. So a `..`, a relative path or
//     a `/` at the end gets no decision, and the normal prompt shows.
//   - `isUnderRunOrWork`: a parent of the path, and not the path itself, is a
//     run directory or a work directory. The hook applies it to the text.
//     A command applies it to the real path (`confinementProblem`), so a link
//     in a parent that leads outside is refused.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs` and `path`. The allow hook imports it on each Bash call,
// so it stays small.

import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'

/** True when the parents of the path are `plugins/data/<id>/runs`. */
export const isRunDirectory = (path: string): boolean => {
  const runs = dirname(path)
  const data = dirname(dirname(runs))
  return (
    basename(runs) === 'runs' && basename(data) === 'data' && basename(dirname(data)) === 'plugins'
  )
}

/** True when the parents of the path are `.claude/worktrees`. */
export const isWorkDirectory = (path: string): boolean => {
  const worktrees = dirname(path)
  return basename(worktrees) === 'worktrees' && basename(dirname(worktrees)) === '.claude'
}

/** An absolute path with no `.`, `..` or empty segment, and no `/` at its end. */
export const isPlainPath = (path: string): boolean =>
  path.startsWith('/') &&
  path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')

/**
 * True when a parent of the path is a run directory or a work directory. The
 * walk ends at a parent that is its own parent: `/`, or `.` for a relative
 * path.
 */
export const isUnderRunOrWork = (path: string): boolean => {
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
    if (isRunDirectory(parent) || isWorkDirectory(parent)) return true
  }
  return false
}

/** True for a link. A path that cannot be read is not one. */
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The text of a refusal, the same for the commands and in the docs. */
const ROOTS =
  'a run directory (plugins/data/<id>/runs/<run>/) or a work directory (<repo>/.claude/worktrees/<leaf>/)'

/**
 * The refusal of one file flag, or null for a path that it may use. The real
 * path is the real path of the file when it is there. Else it is
 * `resolveParent` of the path: the part that exists resolved, and the rest
 * kept as text (`resolvePhysical` in `reap.ts`). A link at the end that leads
 * nowhere is refused, because a write would follow it.
 */
export const confinementProblem = (
  flag: string,
  given: string,
  resolveParent: (path: string) => string,
): string | null => {
  const refusal = `${flag} ${given} is not under ${ROOTS}`
  if (!isPlainPath(given)) return refusal
  let real: string
  try {
    real = realpathSync(given)
  } catch {
    if (isLink(given)) return `${flag} ${given} is a link that leads nowhere`
    real = resolveParent(given)
  }
  return isUnderRunOrWork(real) ? null : refusal
}
