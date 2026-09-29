// The subcommand registry: a name, the line `--help` prints for it, and a
// loader for the exported handler that is the command (issue #216's decision
// comment). A command is added here and nowhere else, and adding one adds no
// code to the entry point.
//
// Each loader is a dynamic import, so one invocation loads only the command
// it runs (#273). A static import here would load every command on every
// call, and `allow-own-commands` is called on every Bash call in a session.
//
// This file ships. It imports nothing outside the plugin.

import type { CommandEntry } from './command.ts'

export const COMMANDS: Readonly<Record<string, CommandEntry>> = {
  'allow-own-commands': {
    description:
      "Answer the PreToolUse allow decision for this plugin's own CLI (reads hook JSON on stdin)",
    load: async () =>
      (await import('../subcommands/allow-own-commands.ts')).allowOwnCommandsCommand,
  },
  version: {
    description: 'Print the installed plugin version',
    load: async () => (await import('../subcommands/version.ts')).version,
  },
}

/** The registered names, in the order `--help` lists them. */
export const commandNames: readonly string[] = Object.keys(COMMANDS)
