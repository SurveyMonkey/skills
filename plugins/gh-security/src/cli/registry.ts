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
  'detect-scope': {
    description:
      'Decide whether a path is in a repository, and say which: detect-scope [--env-prefix <prefix>] [<path>]',
    load: async () => (await import('../subcommands/detect-scope.ts')).detectScopeCommand,
  },
  'discover-repos': {
    description: 'List the repository checkouts a directory holds: discover-repos [<path>]',
    load: async () => (await import('../subcommands/discover-repos.ts')).discoverReposCommand,
  },
  'ensure-worktree-exclude': {
    description:
      "Add the agents' worktree directory to .git/info/exclude: ensure-worktree-exclude <repo_root>",
    load: async () =>
      (await import('../subcommands/ensure-worktree-exclude.ts')).ensureWorktreeExcludeCommand,
  },
  'pr-status': {
    description: 'Read the state of pull requests: pr-status [--env-prefix <prefix>] <pr-url>...',
    load: async () => (await import('../subcommands/pr-status.ts')).prStatusCommand,
  },
  'session-start': {
    description: 'Check that the tools this plugin needs are present (SessionStart hook)',
    load: async () => (await import('../subcommands/session-start.ts')).sessionStartCommand,
  },
  version: {
    description: 'Print the installed plugin version',
    load: async () => (await import('../subcommands/version.ts')).version,
  },
}

/** The registered names, in the order `--help` lists them. */
export const commandNames: readonly string[] = Object.keys(COMMANDS)
