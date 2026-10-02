// `gh-security fix-group <phase>`: the driver for one dependency-fix group.
// This is the port of `scripts/common/fix-group.sh` (#232), one phase at a
// time. This layer ports the first three phases:
//
//   fix-group setup    --group-json <file> --repo-root <path>
//                      --default-branch <name>
//                      [--env-prefix "<string>"] [--scorer <path>]
//   fix-group classify --work <dir>
//   fix-group baseline --work <dir>
//
// `apply` and `score` come in later layers of #232. `cleanup` stays in the
// bash, and #234 ports it (round 5 ruling 5). Until then the agent calls
// `fix-group.sh` for all six steps.
//
// The steps share one state file at `<work>/state.json`, through
// `src/state.ts`. `setup` writes it, and each later phase reads it first.
// The state file is the only thing that goes from one step to the next.
//
// Contract, for these three phases:
//   exit 0  {"status":"ok","step":"setup|classify|baseline", ...}
//           an intermediate step completed.
//   exit 3  {"status":"failure","phase":"worktree|classify|baseline",
//            "detail":"..."}  a terminal failure. The agent copies it to
//           its result block. stderr has `fix-group: <phase> failure:
//           <detail>`.
//   exit 1  {"error":"..."}  a usage error, or an internal error. A state
//           file that cannot be read is one.
// Exit 2 (`needs_judgment`) is for `apply`. None of these three phases
// gives it.
//
// What each phase does:
//   setup     checks the group, then refuses a work directory that is
//             already there (a crashed run). It fetches the default branch
//             and the fix branch. A local branch of the fix name is deleted
//             only when it is this flow's own leftover: its tip is
//             `origin/<default>`, or `origin/<branch>`, or one drift commit
//             over the drift paths alone. Else the phase fails and keeps the
//             branch. Then it adds the worktree `<work>/fix` on a new branch
//             from `origin/<default>`, and writes the state.
//   classify  runs `why`. A package that only peer resolutions reach stops
//             here (#103). Then `declared_ranges --line`, and the eligible
//             parents: read, unreadable and without a range, by name (#76,
//             #83, #85).
//   baseline  reads `resolved_versions`, runs the control install (one
//             retry for a registry timeout), commits the drift on the
//             lockfile and its install files with the drift subject, fails
//             on any other change, and reads `resolved_versions` again.
//
// Each git call and each package-manager call runs under `--env-prefix`, the
// opaque prefix that `setup` records (env-prefix.md). The prefix comes after
// the directory: git takes `-C`, and a verb gives its child a `cwd`.
//
// Differences from `fix-group.sh`:
//   - There is no `--adapter <path>`. The route is the `ecosystem` of the
//     group, through `src/adapters/registry.ts`, as in `classify-lines`. So
//     a group must carry `ecosystem`, and an ecosystem with no adapter is
//     exit 1. The state records the name of the adapter in `adapter`, and
//     the route in `ecosystem`. A state that this command writes is not for
//     `fix-group.sh`, and the reverse: do not mix the two in one run.
//   - The adapter verbs run in process. So the prefix wraps the package
//     manager that a verb starts (`why`, `install`), and not an adapter
//     process. `detect` runs again before each verb, as each `node.sh` call
//     did, and its failure is the failure of that verb.
//   - An install that the verb itself refuses, as the worktree guard does,
//     is a failed control install, and its output is the message of the
//     verb.
//   - `--scorer` stays, for `score` (ruling 4). Without it, the state names
//     the bash scorer in this plugin, `scripts/common/score-merge-risk.sh`.
//   - A bad command line is exit 1 with `{"error": ...}` in node's words. The
//     bash printed the shell's text for a missing value, and no JSON.
//   - A group that is JSON but not an object is refused with its own
//     message. A `declared_ranges` answer whose parent lists are not lists
//     of names is a `classify` failure. In the bash, jq stopped on each of
//     these, and the run ended with exit 1.
//   - A failed `mkdir` or a failed write of the state quotes node's error.
//   - `baseline` reads `install_signals` before it writes `baseline` and
//     `drift_commit`. So a state whose list cannot be read gets neither key.
//     The bash wrote both, and then stopped with exit 1.
//   - A SIGINT or a SIGTERM during `setup` does not remove the worktree. The
//     worktree is the workspace of the run, as in the bash, which has no
//     trap. `cleanup` removes it, and the guard for a crashed run stops the
//     next `setup` (ruling 15 on #225 is for a worktree that a command
//     removes before it ends).
//
// This file ships. It imports nothing outside the plugin.

import { selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseArguments } from '../lib/args.ts'
import { failed } from '../lib/envelope.ts'
import { run } from '../lib/process.ts'
import { baseline } from './fix-group-baseline.ts'
import { classify } from './fix-group-classify.ts'
import { type FixGroupDeps, loadPhase } from './fix-group-common.ts'
import { setup } from './fix-group-setup.ts'

export type { FixGroupDeps } from './fix-group-common.ts'

const USAGE = 'usage: gh-security fix-group <setup|classify|baseline> [options]'

/** The handler. The runner and the registry are parameters. */
export const fixGroup = async (
  context: CommandContext,
  deps: FixGroupDeps,
): Promise<CommandResult> => {
  const [phase, ...args] = context.args
  if (phase === undefined) return failed(USAGE)
  if (phase === 'setup') return setup(args, context.env, deps)
  if (phase !== 'classify' && phase !== 'baseline') {
    return failed(
      `fix-group: '${phase}' is not a phase of this command. It ports setup, classify and ` +
        'baseline; apply, score and cleanup still run in fix-group.sh.',
    )
  }
  const parsed = parseArguments(args, { work: { type: 'string', default: '' } })
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.work === '') return failed(`${phase}: --work is required`)
  const loaded = loadPhase(parsed.value.work, context.env, deps)
  if (loaded.outcome !== 'ok') return loaded
  return phase === 'classify' ? classify(loaded.value) : baseline(loaded.value)
}

export const fixGroupCommand: CommandHandler = (context) =>
  fixGroup(context, { spawn: run, route: selectAdapter })
