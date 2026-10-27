// `gh-security remove-run <dir>`: remove the run directory of one
// `resolve-alerts` run (#346, ruling 4). The skill keeps the files of a run
// in `${CLAUDE_PLUGIN_DATA}/runs/<UTC stamp>/`, and the plugin removes them
// at the end of the run. A registered command does this, so the allow hook
// passes it and no `rm` prompts.
//
// The command removes a directory only when its real path has the shape
// `<any>/plugins/data/<id>/runs/<run>`. `<id>` and `<run>` are each one
// segment. Claude Code makes the data directory as
// `~/.claude/plugins/data/<id>/` (the plugins reference, "Environment
// variables"). The command does not read the home directory or the id: the
// shape is the check.
//
// Output, exit 0: `{"removed": "<real path>"}`.
//
// The command fails, with exit 1, and removes nothing, for each of these.
// The message names the path:
//   - a bad command line: not exactly one argument, or a flag,
//   - a path that is not absolute,
//   - a path with a `..` segment, also when it resolves to a run,
//   - a path that does not exist,
//   - a path that is a symbolic link,
//   - a path that is not a directory,
//   - a real path without the shape above: the `runs` directory itself, a
//     directory inside a run, or a path that a link in a parent leads
//     outside.
// A failure of the removal itself is `remove-run: <reason>`.
//
// The removal does not follow a link inside the run: it removes the link.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs` and `path`.

import { lstatSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { failed, ok } from '../lib/envelope.ts'
import { isRunDirectory } from '../run-paths.ts'

const USAGE = 'usage: gh-security remove-run <dir>'

/** The handler. */
export const removeRun = (context: CommandContext): CommandResult => {
  const { args } = context
  if (args.length !== 1 || (args[0] as string).startsWith('-')) return failed(USAGE)
  const given = args[0] as string
  const refuse = (why: string, path = given) => failed(`remove-run: ${why}: ${path}`)
  if (!isAbsolute(given)) return refuse('not an absolute path')
  if (given.split('/').includes('..')) return refuse('the path has a .. segment')
  const stat = lstatSync(given, { throwIfNoEntry: false })
  if (stat === undefined) return refuse('no such directory')
  if (stat.isSymbolicLink()) return refuse('a symbolic link, not a run directory')
  if (!stat.isDirectory()) return refuse('not a directory')
  const real = realpathSync(given)
  if (!isRunDirectory(real))
    return refuse('not a run directory, plugins/data/<id>/runs/<run>', real)
  try {
    rmSync(real, { recursive: true })
  } catch (error) {
    return failed(`remove-run: ${(error as Error).message}`)
  }
  return ok({ removed: real })
}

export const removeRunCommand: CommandHandler = removeRun
