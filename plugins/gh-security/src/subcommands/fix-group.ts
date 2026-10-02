// `gh-security fix-group <phase>`: the driver for one dependency-fix group.
// This is the port of `scripts/common/fix-group.sh` (#232), one phase at a
// time. These five phases are ported:
//
//   fix-group setup    --group-json <file> --repo-root <path>
//                      --default-branch <name>
//                      [--env-prefix "<string>"] [--scorer <path>]
//   fix-group classify --work <dir>
//   fix-group baseline --work <dir>
//   fix-group apply    --work <dir>
//   fix-group score    --work <dir>
//
// `cleanup` stays in the bash, and #234 ports it (round 5 ruling 5 on #232).
// Until then the agent calls `fix-group.sh` for all six steps.
//
// The steps share one state file at `<work>/state.json`, through
// `src/state.ts`. `setup` writes it, and each later phase reads it first.
// The state file is the only thing that goes from one step to the next.
//
// Contract, for these five phases:
//   exit 0  {"status":"ok","step":"setup|classify|baseline|apply", ...}
//           an intermediate step completed.
//           {"status":"no_op", ...}  terminal: nothing to fix (`apply`).
//           {"status":"ready_for_pr", ...}  terminal: hand to phase 6. Only
//           `score` gives it. It has the package, the action, the risk
//           report, the written entries, the observations and the validate
//           report.
//   exit 2  {"status":"needs_judgment","decision_point":"...",
//            "evidence":{...}}  only from `apply`: a branch that the tree
//           cannot decide. It fails closed, and never guesses. stderr has
//           `fix-group: needs judgment at <decision_point>`. The decision
//           points are `install_failure` (its evidence has `phase:
//           "install"`), `validate_failed_after_ladder` and
//           `install_budget_exhausted`.
//   exit 3  {"status":"failure","phase":"worktree|classify|baseline|apply|
//            validate","detail":"..."}  a terminal failure. The agent
//           copies it to its result block. stderr has `fix-group: <phase>
//           failure: <detail>`. `score` gives only `validate`. The causes
//           are a verb that fails after the fix, a promised field that is
//           absent, a version that cannot be compared, and a why capture
//           that cannot be written. They are also a scorer that fails or has
//           no usable report, and a stored or scored value of the wrong
//           type (see the differences below).
//   exit 1  {"error":"..."}  a usage error, or an internal error. A state
//           file that cannot be read is one.
//
// What each phase does:
//   setup     checks the group, then refuses a work directory that is
//             already there (a crashed run). It fetches the default branch
//             and the fix branch. It deletes a local branch of the fix name
//             only when the branch is this flow's own leftover. Its tip must
//             be `origin/<default>`, or `origin/<branch>`, or one drift
//             commit over the drift paths alone. Else the phase fails and
//             keeps the branch. Then it adds the worktree `<work>/fix` on a
//             new branch from `origin/<default>`, and writes the state.
//   classify  runs `why`. A package that only peer resolutions reach stops
//             here (#103). Then it runs `declared_ranges --line`, and lists
//             the eligible parents by name: read, unreadable and without a
//             range (#76, #83, #85).
//   baseline  reads `resolved_versions`. It runs the control install, with
//             one retry for a registry timeout. It commits the drift on the
//             lockfile and its install files with the drift subject. Any
//             other change is a failure. Then it reads `resolved_versions`
//             again.
//   apply     checks the state before its first write: `classify` and
//             `baseline` ran, and each alert has a range. It writes the
//             range `>=<fixed> <next major>`, then runs `apply_constraint`,
//             one fix install, and `validate --line`. A fatal move on
//             another line stops it (#83). While validate fails, it goes up
//             the ladder: a line with no copy stops it, then step 1 adds
//             the parents that npm violation paths name, then step 2 writes
//             the bare override, then the stale-lockfile stop, then a
//             judgment. The state counts the fix installs of the run, and
//             the fourth is the last (`FIX_INSTALL_BUDGET`). When validate
//             passes, an empty diff is a no-op or a lockfile refresh, as
//             the drift commit decides (#146). Else the widest shape of
//             `written[]` labels the fix. `fix-group-ladder.ts` has each
//             decision as a pure function.
//
//   score     refuses a run that has no action, and a run that `apply` ended
//             as a no-op. It reads `resolved_versions`, `why` and
//             `declared_ranges --line` again, after the fix. The state keeps
//             the first as `post_fix` and the last as `declared_post`. The
//             `why` answer goes to
//             `<work>/why-<package_path>.json`. `--before` is the lowest
//             version on the line in the baseline, or in the pre-drift
//             snapshot for a lockfile refresh. It is not given when that
//             snapshot has `present` other than the text `true`. It is not
//             given when it has no version on the line (#76). `--after` is the
//             lowest version on the line after the fix, and it is never
//             empty. The scorer runs in the worktree with `--package`,
//             `--after`, `--adapter`, `--why-json`, `--override-scope`, an
//             optional `--before`, and one `--declared-range` for each
//             range, or `none`. The state keeps its `risk` report. Then the
//             stored `apply_result`, `validate`, parent list, `drift_commit`
//             and `observations_first` are read. One that is absent or null
//             stops the phase with exit 1, after the scorer has run.
//
// Each git call and each package-manager call runs under `--env-prefix`, the
// opaque prefix that `setup` records (env-prefix.md). The prefix sets no
// directory: git gets `-C <dir>` after the prefix, and a verb gives its
// child a `cwd`.
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
//   - `detect` reads the PATH of this command, not the PATH under the
//     prefix. The bash ran `node.sh` under the prefix. The package manager
//     can be on the PATH only under the prefix. Then `detect` can choose
//     `corepack <pm>` or the yarn release of the repository. The bash
//     chose `<pm>`.
//   - An install that the verb itself refuses, as the worktree guard does,
//     is a failed control install, and its output is the message of the
//     verb.
//   - `--scorer` stays, for `score` (round 5 ruling 4 on #232). Without it,
//     the state names the bash scorer in this plugin,
//     `scripts/common/score-merge-risk.sh`. `score` runs it as a child
//     process, under the prefix, with the worktree as its directory. Until
//     #233 ports it, a TypeScript command calls a bash script here.
//   - The scorer calls the adapter again, as a bash script. `score` gives it
//     `--adapter` with the path of `scripts/ecosystems/node.sh` in this
//     plugin. The state has the name of the adapter and not a path. The
//     registry has no other adapter, so the node script is the one that
//     exists. A second adapter needs a map from its name to its script.
//   - `score` runs `why` through the package manager under the prefix, and
//     the other verbs in process, as the other phases do. The scorer starts
//     the bash adapter itself. That child inherits the environment that the
//     prefix sets, and has no prefix of its own.
//   - A scorer that does not start fails the phase with the text of node's
//     error. The bash gave the text of the shell.
//   - A bad command line is exit 1 with `{"error": ...}` in node's words. The
//     bash printed the shell's text for an absent value, and no JSON.
//   - `setup` refuses a group that is JSON but not an object, with its own
//     message. The bash also gave exit 1, with another message: a list has
//     none of the keys, and a string or a number has no `major_line`.
//   - `setup` takes a JSON number for `major_line` as node reads it. So
//     `4.0` is the line `4`, and `1e1` is the line `10`. The bash read the
//     text of the number (`4.0`, `1E+1`) and refused it.
//   - A `declared_ranges` answer whose parent lists are not lists of names
//     is a `classify` failure. In the bash, jq stopped on it, and the run
//     ended with exit 1.
//   - A failed `mkdir` or a failed write of the state quotes node's error.
//   - `baseline` reads `install_signals` before it writes `baseline` and
//     `drift_commit`. So a state whose list cannot be read gets neither key.
//     The bash wrote both, and then stopped with exit 1.
//   - `install_signals` must be absent, null, or a list of strings. The bash
//     also read `false` as the empty list, and a list of other values went
//     into the union. Here each of these is exit 1.
//   - A later phase refuses a state whose `major_line` is not digits, or
//     whose `env_prefix` is not text, with exit 1. The bash gave the text of
//     each one to the adapter or to the prefix, and did not check it.
//   - A key path in the text of a state failure has no dot at the start:
//     `'group.alerts'`, where the bash wrote `'.group.alerts'`.
//   - `apply` reads `group.sibling_alerts` before its first write. A null
//     value is exit 1 with nothing written. The bash read it at each
//     validate, after the first fix install.
//   - Two details of `apply` use a colon where the bash text had a dash:
//     the alerts with no range, and a `drift_commit` that is not a boolean.
//     In the second, `reporting a real fix` is also `that reports a real
//     fix`, and `leaving the alerts open` is also `leaves the alerts open`.
//   - `drift_commit` must be a JSON boolean. The text `true` or `false` is
//     exit 3 here, and the bash took it. Empty text is exit 3 here, and
//     exit 1 in the bash.
//   - `fix_installs` is read from its JSON value, so `3.0` is the count 3.
//     The bash, with jq 1.7 or later, read the text `3.0` and refused it.
//     jq 1.6 gave the text `3`.
//   - `eligible_parents` must be a list of names, and a stored
//     `observations_first` must be a list. Each other value is exit 1 before
//     the first `apply_constraint`. The bash gave jq the value, and went on.
//   - Each `vulnerable_range` goes to validate as one value. The bash split
//     a range with a newline into one flag for each line.
//   - A `written[]` entry that cannot be read is an `apply` failure at any
//     place in the list. Such an entry is not an object, or has a `path`
//     that is neither a list nor null. The bash stopped on an entry that is
//     not an object or null. It could pass a bad `path` when an earlier
//     entry was a bare key. It read a null entry as a scoped entry.
//   - An `other_line_moves` entry that is not an object is fatal, and the
//     detail quotes it. The bash stopped on each other entry that is not
//     null, and quoted no entry. It read a null entry as no move.
//   - An `other_line_moves` that is neither a list nor null is one fatal
//     move, quoted whole. The bash walked the values of an object, with the
//     rule for an entry. It read a text, a number or a boolean as no move.
//   - The stale-lockfile stop reads `keys` only as a list. jq `length`
//     also gave 0 for `{}`, `""` and `0`. So for these the bash stopped
//     (exit 3), and the port gives `validate_failed_after_ladder` (exit 2).
//   - A no-op whose `resolved_versions` holds an object or a list is a
//     `validate` failure, as when jq `join` stopped in the bash.
//   - An alert that is not an object has no range: `<unnumbered>`. The bash
//     read a null alert the same way. On a text, a number, a boolean or a
//     list, it stopped in jq, and the detail named no alert.
//   - The major of `highest_fixed_version` is read in base 10. The bash read
//     a zero at the start as octal.
//   - `score` reads `action`, `override_scope` and `bare_override` as text.
//     The bash gave the text of a number or a boolean (`5`, `true`) to the
//     report, and for `override_scope` also to the scorer. It also gave the
//     text of a list or an object. Each other value is exit 1 here. A key
//     with no text, or `null`, is exit 1 in both.
//   - `score` writes the why capture through a temporary file, and renames
//     it. The bash wrote the file in place.
//   - The why capture is the answer as one line of JSON. The bash wrote the
//     text of the adapter, which has indents. The scorer reads both alike.
//   - `ranges` of the post-fix `declared_ranges` must be null or a list of
//     text. The bash read a text, a number, `true` and `false` as an empty
//     list. It read each value of an object, and `null` or a number in a
//     list as the text of the value. It read a list in a list as the lines
//     of its indented JSON. Here each of these is a `validate` failure. A
//     range with a newline is one flag for each line, in both.
//   - `parents_read` must be null, `false` or a list when `ranges` is empty.
//     The bash gave `length` of a text (its characters), of a number (its
//     absolute value) and of an object (its keys), and stopped on `true`.
//     Here each of these is a `validate` failure.
//   - The report of the scorer must hold one JSON object that has `band`.
//     The bash also passed two JSON values in a row, and then stopped at the
//     write of the state with exit 1. Here that is a `validate` failure. A
//     number in the report is written as node reads it, so `1.0` is `1`.
//   - `factors` of the report must be null or a list of objects and nulls.
//     The bash read a text, a number, `true` and `false` as no factors. It
//     read each value of an object as a factor. It stopped in jq, with exit
//     5 and no JSON, on a list that holds a text, a number, a boolean or a
//     list. Here each of these is a `validate` failure.
//   - The stored `apply_result` and `validate` must be objects. The bash
//     stopped in jq, with exit 5 and no JSON, on any other value. A
//     `benign_moves` entry that is not an object is not kept here. The bash
//     stopped in jq on a number, a text, a boolean or a list. It read the
//     values of an `other_line_moves` object, and this gives no entry. `apply`
//     stops on each of these shapes, so only an edited state has one.
//   - `score` reads `install_signals` as `baseline` does. The bash passed a
//     text, or a list of other values, to the report.
//   - A state with neither `applied_parents` nor `eligible_parents` gives the
//     key `'applied_parents // eligible_parents'`, with no dot at the start.
//   - A SIGINT or a SIGTERM during `setup` does not remove the worktree. The
//     worktree is the workspace of the run, as in the bash, which has no
//     trap. `cleanup` removes it. The guard for a crashed run stops the next
//     `setup`. Ruling 15 on #225 is for a worktree that a command removes
//     before it ends.
//
// This file ships. It imports nothing outside the plugin.

import { selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseArguments } from '../lib/args.ts'
import { failed } from '../lib/envelope.ts'
import { run } from '../lib/process.ts'
import { apply } from './fix-group-apply.ts'
import { baseline } from './fix-group-baseline.ts'
import { classify } from './fix-group-classify.ts'
import { type FixGroupDeps, loadPhase } from './fix-group-common.ts'
import { score } from './fix-group-score.ts'
import { setup } from './fix-group-setup.ts'

export type { FixGroupDeps } from './fix-group-common.ts'

const USAGE = 'usage: gh-security fix-group <setup|classify|baseline|apply|score> [options]'

/** The phases after `setup`. Each reads the state that `--work` names. */
const PHASES = { classify, baseline, apply, score } as const

/** The handler. The runner and the registry are parameters. */
export const fixGroup = async (
  context: CommandContext,
  deps: FixGroupDeps,
): Promise<CommandResult> => {
  const [phase, ...args] = context.args
  if (phase === undefined) return failed(USAGE)
  if (phase === 'setup') return setup(args, context.env, deps)
  if (!Object.hasOwn(PHASES, phase)) {
    return failed(
      `fix-group: '${phase}' is not a phase of this command. It ports setup, classify, ` +
        'baseline, apply and score; cleanup still runs in fix-group.sh.',
    )
  }
  const parsed = parseArguments(args, { work: { type: 'string', default: '' } })
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.work === '') return failed(`${phase}: --work is required`)
  const loaded = loadPhase(parsed.value.work, context.env, deps)
  if (loaded.outcome !== 'ok') return loaded
  return PHASES[phase as keyof typeof PHASES](loaded.value, parsed.value.work)
}

export const fixGroupCommand: CommandHandler = (context) =>
  fixGroup(context, { spawn: run, route: selectAdapter })
