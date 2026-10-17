// `gh-security audit-pins <phase>`: the driver for the pin audit of one
// repository. This is the port of `scripts/common/audit-pins-driver.sh`
// (#235), one phase at a time. This layer ports the first three phases:
//
//   audit-pins list     --work <dir> --worktree <dir> [--ecosystem <eco>]
//                       [--env-prefix "<string>"]
//   audit-pins baseline --work <dir>
//   audit-pins test-pin --work <dir> (--key <key> | --path <json array>)
//
// `judge` and `together` come in the next layer of #235. Until then this
// command refuses them as phases that it does not have, and the agent calls
// `audit-pins-driver.sh` for all five steps until #237 moves it here.
//
// The steps share one state file at `<work>/state.json`, through
// `src/state.ts`. `list` writes it, and each later phase reads it first.
//
// Contract, for these three phases:
//   exit 0  {"status":"ok","step":"list|baseline|test-pin", ...}  a step
//           completed. A pin whose install failed is a finding, not a
//           failure.
//           {"status":"no_pins", ...}  terminal: `list` found no pins.
//   exit 3  {"status":"failure","phase":"list|install|restore","detail":"..."}
//           a terminal failure. The agent copies it to its result block.
//           stderr has `audit-pins: <phase> failure: <detail>`. A restore
//           that cannot be checked ends the run (`restore`).
//   exit 1  {"error":"..."}  a usage error, or an internal error. A state
//           file that cannot be read is one.
// Exit 2 is reserved, as in the bash: these phases have no decision for the
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
//     "could not be assembled" failure.
//   - A pin that `list_pins` gives that is not an object stops `list` with
//     the answer as one line of JSON. The bash quoted the text of `node.sh`.
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
//   - Two texts of the bash have an em dash. The port gives them as they are.
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
//   - A failure of a promised field after the removal, of `resolved_versions`
//     after the install, or of the findings on file, stops the phase before
//     the restore. The tree keeps the removal and the install.
//
// This file ships. It imports nothing outside the plugin.

import { selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { failed } from '../lib/envelope.ts'
import { run } from '../lib/process.ts'
import { baseline } from './audit-pins-baseline.ts'
import type { AuditPinsDeps } from './audit-pins-common.ts'
import { list } from './audit-pins-list.ts'
import { testPin } from './audit-pins-test-pin.ts'

export type { AuditPinsDeps } from './audit-pins-common.ts'

const USAGE = 'usage: gh-security audit-pins <list|baseline|test-pin> [options]'

const PHASES = { list, baseline, 'test-pin': testPin } as const

/** The handler. The runner and the registry are parameters. */
export const auditPins = (context: CommandContext, deps: AuditPinsDeps): Promise<CommandResult> => {
  const [phase, ...args] = context.args
  if (phase === undefined) return Promise.resolve(failed(USAGE))
  if (!Object.hasOwn(PHASES, phase)) {
    return Promise.resolve(
      failed(
        `audit-pins: '${phase}' is not a phase of this command. It ports list, baseline and ` +
          'test-pin; judge and together are still audit-pins-driver.sh.',
      ),
    )
  }
  return PHASES[phase as keyof typeof PHASES](args, context.env, deps)
}

export const auditPinsCommand: CommandHandler = (context) =>
  auditPins(context, { spawn: run, route: selectAdapter })
