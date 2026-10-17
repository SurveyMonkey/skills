// `gh-security audit-pins <phase>`: the driver for the pin audit of one
// repository. This is the port of `scripts/common/audit-pins-driver.sh`
// (#235). It has the five phases:
//
//   audit-pins list     --work <dir> --worktree <dir> [--ecosystem <eco>]
//                       [--env-prefix "<string>"]
//   audit-pins baseline --work <dir>
//   audit-pins test-pin --work <dir> (--key <key> | --path <json array>)
//   audit-pins judge    --work <dir>
//   audit-pins together --work <dir>
//
// The agent calls `audit-pins-driver.sh` for all five steps until #237
// moves it here.
//
// The steps share one state file at `<work>/state.json`, through
// `src/state.ts`. `list` writes it, and each later phase reads it first.
//
// Contract:
//   exit 0  {"status":"ok","step":"list|baseline|test-pin|judge", ...}  a
//           step completed. A pin whose install failed is a finding, not a
//           failure.
//           {"status":"no_pins", ...}  terminal: `list` found no pins.
//           {"status":"no_candidates", ...}  terminal: nothing came back
//           removable.
//           {"status":"partial_map", ...}  terminal: the baseline map is
//           partial.
//           {"status":"combined_failed", ...}  terminal: no attempt was
//           clean.
//           {"status":"ready_for_pr", ...}  terminal: hand to phase 8. The
//           removals stay in the tree.
//   exit 3  {"status":"failure","phase":"list|install|restore|advisories|
//           compose","detail":"..."}  a terminal failure. The agent copies
//           it to its result block. stderr has `audit-pins: <phase> failure:
//           <detail>`. A restore that cannot be checked ends the run
//           (`restore`). `compose` comes only from `together`.
//   exit 1  {"error":"..."}  a usage error, or an internal error. A state
//           file that cannot be read is one.
// Exit 2 is reserved, as in the bash: no phase has a decision for the
// agent.
//
// What each phase does:
//   list      runs `list_pins` on the worktree. A count must be a whole
//             number that the list agrees with. Each pin of kind `range` is
//             testable, and each other kind is a finding with its words. The
//             testable pins are ordered bare first. Then it writes the
//             state.
//   baseline  asks `detect` for the name of the lockfile, runs one install,
//             reads the whole-tree map, and reads `resolved_versions` of each
//             package that a testable pin names. A package with `present:
//             false` gives an inconclusive finding for each of its pins, and
//             `test-pin` refuses them.
//   test-pin  removes the one entry at the pin's path. It checks with
//             `list_pins` that the entry is gone and that the count fell by
//             one. Then it installs, reads `resolved_versions` and the map,
//             and records the finding: the versions that this pin kept out,
//             and the other packages that moved, with the platform-binary
//             family rule (audit-driver.md). Last, it returns the manifest,
//             the workspace file and the lockfile to HEAD, and checks them.
//   judge     asks `check-advisories` in process (ADR 012) about each
//             version that a tested pin let in, and each version of another
//             package that moved with it. It gives each tested finding its
//             verdict, then applies the sibling rule. Each answer is cached
//             in `<work>/advisories/`, and a cached answer gets the same
//             checks as a fresh one.
//   together  installs the set of removable pins as one (attempt 1). When
//             the set lets in a version that is not safe, it restores the
//             tree and tries the set without the removable-individually pins
//             (attempt 2). It restores a tracked `.yarn/cache` first.
//
// Each git call and each package-manager call runs under `--env-prefix`, the
// opaque prefix that `list` records (env-prefix.md). The prefix sets no
// directory: git gets `-C <dir>` after the prefix, and a verb gives its
// child a `cwd`.
//
// Differences from `audit-pins-driver.sh`:
//   - There is no `--adapter`, `--scripts-dir` or `--advisories`. The route
//     is `--ecosystem` (default `npm`), through `src/adapters/registry.ts`,
//     as in `check-advisories`. The state records the name of the adapter
//     in `adapter` and the route in `ecosystem`, and has no `advisories` or
//     `scripts_dir`. A state that this command writes is not for the bash,
//     and the reverse: do not mix the two in one run.
//   - The adapter verbs run in process. So the prefix wraps the package
//     manager that `install` starts, and not an adapter process. `detect`
//     runs again before each verb, as each `node.sh` call did, and its
//     failure is the failure of that verb.
//   - An install that the verb itself refuses, as the worktree guard does,
//     is a failed install, and its output is the message of the verb.
//   - A bad command line is exit 1 with `{"error": ...}` in node's words. A
//     phase with no `--work` is exit 1 with `<phase>: --work is required`.
//     The bash wrote the text of the shell and no JSON for both.
//   - The state reader of `src/state.ts` gives its own words. An absent
//     state file quotes node's error. A file that does not parse and a file
//     that is not an object have one text each. A key path in a failure has
//     no dot at its start: `'worktree'`, where the bash wrote `'.worktree'`.
//   - A failed `mkdir` or a failed write of the state quotes node's error.
//   - A later phase refuses an `env_prefix` that is not text, with exit 1.
//   - A stored flag is read as a JSON value: `baseline_done` and
//     `map_available` must be `true`, `pins_count` a number, and
//     `baseline_unreadable_entries` a number to count as read. The bash read
//     their text, so the text `"true"` or `"0"` also passed there.
//   - `test_order` must be a list of pins, each with a text `key`, a list of
//     texts as its `path`, and a package name. The bash checked only that it
//     is a list. A list of other values gave no package to `baseline`, and
//     no snapshot to `test-pin` later.
//   - A promised field of an adapter answer must have its JSON type: `count`
//     and `unreadable_entries` are whole numbers, and `present` is a boolean.
//     The bash read the text of each, so a text such as `"3"` passed there.
//   - The map of `resolution_map` must hold a list of texts for each package,
//     in `baseline` and in `test-pin`. The bash checked only that
//     `resolutions` is an object in `baseline`, and nothing in `test-pin`.
//     An entry of another type stopped its jq later, or passed. A baseline
//     map that is not usable in a whole-tree `test-pin` is the bash's
//     "could not be assembled" failure. When the `resolutions` of the map
//     after the removal are not usable, `test-pin` restores the tree, then
//     stops.
//   - A pin that `list_pins` gives that is not an object stops `list` with
//     the answer as one line of JSON. The bash quoted the text of `node.sh`.
//     A null pin also stops `list`. The bash read it as a pin of no kind,
//     and went on.
//   - `list_pins` after a removal must give its pins as a list. An answer
//     with another `pins` lists the pin still. The bash read the values of
//     an object.
//   - The removal from `package.json` reads and writes the file with node.
//     A failure quotes node's error after `Quoting the error:`, where the
//     bash quoted jq after `Quoting jq:`. The file is written as jq writes
//     it, with the declared differences of `jq-json.ts`: a whole-number key
//     moves first, and a number is written as JavaScript writes it. The
//     bash kept the mode of a new file from the umask, and the port keeps
//     the mode of the file (`replace-file.ts`).
//   - The bash checked with jq that `package.json` parses after the removal.
//     The port writes the file from a parsed value, so it always parses, and
//     there is no such check.
//   - `judge_done` is read as a JSON value: it must be `true`, as
//     `baseline_done` must.
//   - The advisory query is the `check-advisories` command in process, not
//     `check-advisories.sh`, and the texts name it so. A failed query quotes
//     its error as `{"error": ...}`. The prefix wraps `gh`, as
//     `check-advisories --env-prefix` does. The bash wrapped the script, and
//     ran it in the worktree.
//   - A cached advisory answer is read as one JSON text. A file of two
//     objects is not an object. The bash read each of them.
//   - An advisory cache entry that is a directory stops with exit 1, as the
//     rename fails. The bash moved the answer into the directory.
//   - In `together`, a candidate path that is not a list of keys restores
//     the tree and stops, phase `compose`. The bash gave a null path to jq
//     as the path of the whole override block, and removed the block.
//   - In `together`, the removal from `package.json` quotes node after
//     `Quoting the error:`, as in `test-pin`.
//   - In `together`, the baseline map and the map of an attempt must hold a
//     list of texts for each package, as in `test-pin`.
//   - Some texts of the bash have an em dash. The port gives them as they
//     are.
//
// Copied from the bash as they are (round 7 ruling 5):
//   - The deleter of `pnpm-workspace.yaml` (`audit-pins-removal.ts`), with
//     #327 open.
//   - A pin's `path` is used as a path of keys in `package.json`. For a
//     scoped entry of Yarn `resolutions` or of `pnpm.overrides`, such as
//     `express/sha.js` or `vite@7>rollup`, the path has one key for each
//     parent, and the manifest has one key for the entry. So the removal
//     finds nothing, and the check after it stops the phase. Two Yarn rows
//     of the capture show it.
//   - Some failures after the removal stop the phase before the restore,
//     and the tree keeps the removal and the install. They are: a promised
//     field of an adapter answer, `unreadable_entries` of the map, the
//     `resolved_versions` answer, the shape of `baseline_packages`,
//     `baseline_map` or the findings on file, a missing snapshot, the "could
//     not be assembled" failure, and a failed write of the state. In
//     `together`, after the removal of a set: a promised field of
//     `list_pins` or of the map, `pins_count`, a `list_pins` answer that jq
//     cannot read, the baseline map, a map that cannot be diffed, and each
//     failure of the advisory query. The tree keeps the removal there, and
//     after the install, the install. A state
//     with no text `lockfile` stops each restore with exit 1, before git
//     runs. Where a check of the port is stricter than the bash (see the
//     differences above), its stop is also before the restore.
//
// This file ships. It imports nothing outside the plugin.

import { selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { failed } from '../lib/envelope.ts'
import { createGhClient } from '../lib/gh.ts'
import { run } from '../lib/process.ts'
import { baseline } from './audit-pins-baseline.ts'
import type { AuditPinsDeps } from './audit-pins-common.ts'
import { judge } from './audit-pins-judge.ts'
import { list } from './audit-pins-list.ts'
import { testPin } from './audit-pins-test-pin.ts'
import { together } from './audit-pins-together.ts'

export type { AuditPinsDeps } from './audit-pins-common.ts'

const USAGE = 'usage: gh-security audit-pins <list|baseline|test-pin|judge|together> [options]'

const PHASES = { list, baseline, 'test-pin': testPin, judge, together } as const

/** The handler. The runner and the registry are parameters. */
export const auditPins = (context: CommandContext, deps: AuditPinsDeps): Promise<CommandResult> => {
  const [phase, ...args] = context.args
  if (phase === undefined) return Promise.resolve(failed(USAGE))
  if (!Object.hasOwn(PHASES, phase)) {
    return Promise.resolve(
      failed(
        `audit-pins: '${phase}' is not a phase of this command. The phases are list, baseline, ` +
          'test-pin, judge and together.',
      ),
    )
  }
  return PHASES[phase as keyof typeof PHASES](args, context.env, deps)
}

export const auditPinsCommand: CommandHandler = (context) =>
  auditPins(context, { spawn: run, route: selectAdapter, makeClient: createGhClient })
