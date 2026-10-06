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
  'build-dispatches': {
    description:
      'Build the Workflow args for the approved groups: build-dispatches --envelope <merged.json> --cap <n> [--env-prefixes <prefixes.json>] <repo>:<branch_name>...',
    load: async () => (await import('../subcommands/build-dispatches.ts')).buildDispatchesCommand,
  },
  'check-advisories': {
    description:
      'List every published advisory range of a package: check-advisories [--env-prefix <prefix>] [--ecosystem <eco>] [--version <v>] <package>',
    load: async () => (await import('../subcommands/check-advisories.ts')).checkAdvisoriesCommand,
  },
  'classify-lines': {
    description:
      'Classify the major line of each alert group against the lockfile (reads discovery JSON on stdin): classify-lines [--env-prefix <prefix>] --repo-root <path> [--base-ref origin/<branch>] [--branch-style slash|flat]',
    load: async () => (await import('../subcommands/classify-lines.ts')).classifyLinesCommand,
  },
  'detect-scope': {
    description:
      'Decide whether a path is in a repository, and say which: detect-scope [--env-prefix <prefix>] [<path>]',
    load: async () => (await import('../subcommands/detect-scope.ts')).detectScopeCommand,
  },
  'discover-alerts': {
    description:
      'Group the open Dependabot alerts of one repository by package major line: discover-alerts [--env-prefix <prefix>] [--branch-style slash|flat] [--stdin] <owner/repo>',
    load: async () => (await import('../subcommands/discover-alerts.ts')).discoverAlertsCommand,
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
  'fix-group': {
    description:
      'Run one phase of the fix driver for one alert group: fix-group setup --group-json <file> --repo-root <path> --default-branch <name> [--env-prefix <prefix>] | fix-group classify --work <dir> | fix-group baseline --work <dir> | fix-group apply --work <dir> | fix-group score --work <dir>',
    load: async () => (await import('../subcommands/fix-group.ts')).fixGroupCommand,
  },
  'merge-envelopes': {
    description:
      'Merge the prepare-checkout answers of one or more checkouts, and rank all their groups: merge-envelopes <envelope.json>...',
    load: async () => (await import('../subcommands/merge-envelopes.ts')).mergeEnvelopesCommand,
  },
  'pr-status': {
    description: 'Read the state of pull requests: pr-status [--env-prefix <prefix>] <pr-url>...',
    load: async () => (await import('../subcommands/pr-status.ts')).prStatusCommand,
  },
  'preflight-repo': {
    description:
      'Prepare one repository for dispatch: exclude the worktrees, detect the tree, probe its registry: preflight-repo [--env-prefix <prefix>] [--fallback-package <pkg>] <root>',
    load: async () => (await import('../subcommands/preflight-repo.ts')).preflightRepoCommand,
  },
  'prepare-checkout': {
    description:
      'Resolve one checkout, then discover and classify its alert groups: prepare-checkout [--env-prefix <prefix>] <root>',
    load: async () => (await import('../subcommands/prepare-checkout.ts')).prepareCheckoutCommand,
  },
  'render-pr': {
    description:
      'Render the commit message, PR body, labels and PR of one fix group: render-pr commit-msg --state <file> --group-json <file> --repo <nwo> | render-pr body --state <file> --group-json <file> --repo <nwo> [--collateral-note <file>] [--global-override-note <file>] | render-pr labels --repo <nwo> --band <low|medium|high> [--label <name>]... [--env-prefix <prefix>] | render-pr create --repo <nwo> --head <branch> --title <text> --body-file <file> --band <low|medium|high> [--label <name>]... [--env-prefix <prefix>]',
    load: async () => (await import('../subcommands/render-pr.ts')).renderPrCommand,
  },
  'render-pr-status': {
    description:
      'Write the phase 8 table from the pr-status answers of each repository: render-pr-status --bands <bands.json> <report.json>...',
    load: async () => (await import('../subcommands/render-pr-status.ts')).renderPrStatusCommand,
  },
  'score-merge-risk': {
    description:
      'Rate the merge risk of one dependency fix, from the root of its tree: score-merge-risk --package <pkg> --after <version> --why-json <file|-> --override-scope <none|scoped|bare-tightened|bare-added> --declared-range <range|none> [--declared-range <range>]... [--before <version>]',
    load: async () => (await import('../subcommands/score-merge-risk.ts')).scoreMergeRiskCommand,
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
