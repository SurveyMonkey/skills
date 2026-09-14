// The subcommand registry: a name, the line `--help` prints for it, and the
// exported handler that is the command (issue #216's decision comment). A
// command is added here and nowhere else, and adding one adds no code to the
// entry point.
//
// This file ships. It imports nothing outside the plugin.

import { allowOwnCommandsCommand } from '../commands/allow-own-commands.ts'
import { version } from '../commands/version.ts'
import type { CommandEntry } from './command.ts'

export const COMMANDS: Readonly<Record<string, CommandEntry>> = {
  'allow-own-commands': {
    description:
      "Answer the PreToolUse allow decision for this plugin's own CLI (reads hook JSON on stdin)",
    handler: allowOwnCommandsCommand,
  },
  version: {
    description: 'Print the installed plugin version',
    handler: version,
  },
}

/** The registered names, in the order `--help` lists them. */
export const commandNames: readonly string[] = Object.keys(COMMANDS)
