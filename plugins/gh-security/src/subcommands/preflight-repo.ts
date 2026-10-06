// `gh-security preflight-repo [--env-prefix <prefix>] [--fallback-package
// <pkg>] <root>`: prepare one repository for dispatch. This is the contract
// of #193 and #228, built here and not ported. It does phase 5 of the
// `resolve-alerts` skill, once for each repository in the approved batch.
//
// The steps, in this order:
//   1. The worktree exclude, with the function of `ensure-worktree-exclude`.
//      A failure here is not fatal: the command reports it in
//      `exclude_error` and goes on. The worst case is worktree directories
//      in `git status`.
//   2. `detect` of the adapter, in the root.
//   3. `probeRegistry` of the adapter, from the root. The verb picks the
//      package and the command (round 6 ruling 8). A first attempt that is
//      not `ok` gets one retry, because a registry can fail once.
//   4. The cause of a second failure, from what the verb read:
//        auth        HTTP 401 or 403. The registry token is dead.
//        not-found   HTTP 404. The registry has no such package: a routing
//                    or scope question, not an auth one.
//        start       the package manager did not start.
//        network     anything else, such as a time limit, DNS or a reset.
//
// `--env-prefix` is the opaque command prefix that the environment needs
// (`env-prefix.md`). It wraps the probe, and comes after its directory. The
// exclude runs bare, as phase 5 runs it. `detect` runs in process and reads
// the PATH of this command, not the PATH under the prefix. This is the same
// declared difference as in the header of `fix-group.ts`.
//
// `--fallback-package` is the package to probe when the manifest has no
// scoped registry dependency: the top-ranked package of the repository. It
// is a flag and not stdin. The allow hook gives no decision for a pipe or a
// redirection (`cli.md`), and a package name is one word in its set.
//
// Output, exit 0: `{ok, pm, pm_exec, probe_package, cause, stderr,
// exclude_error}`.
//   a probe answers      ok true, cause null, stderr null.
//   detect fails         ok false, pm, pm_exec and probe_package null, cause
//                        `detect`, stderr the error of `detect`.
//   two failed attempts  ok false, cause as above, stderr the `output` of the
//                        second attempt.
// `exclude_error` is null, or the error of step 1.
//
// The command fails, with exit 1, for a bad command line, a root that is not
// a directory, and a failed `probeRegistry`: no package to probe, or a
// manifest that cannot be read. The dispatcher excludes the repository on a
// non-zero exit, and also on an answer with `ok` false (exit 0).
//
// Additions to the contract on #228, in the contract comment there:
// `exclude_error`, and the causes `detect` and `start`.
//
// This file ships. It imports nothing outside the plugin.

import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Adapter, RegistryProbeAnswer } from '../adapters/adapter.ts'
import type { NodeDetection } from '../adapters/node/detect.ts'
import { node } from '../adapters/node.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { failed, ok } from '../lib/envelope.ts'
import { type Runner, run } from '../lib/process.ts'
import { ensureWorktreeExclude, LOCK_TIMING } from './ensure-worktree-exclude.ts'

const USAGE =
  'usage: gh-security preflight-repo [--env-prefix <prefix>] [--fallback-package <pkg>] <root>'

/** The cause of a probe that failed twice. */
const causeOf = (attempt: RegistryProbeAnswer): 'auth' | 'not-found' | 'start' | 'network' => {
  if (attempt.http_status === 401 || attempt.http_status === 403) return 'auth'
  if (attempt.http_status === 404) return 'not-found'
  return attempt.started ? 'network' : 'start'
}

/** The handler. The adapter, the runner and the current directory are parameters. */
export const preflightRepo = async (
  context: CommandContext,
  adapter: Adapter<NodeDetection>,
  spawn: Runner,
  cwd: string,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, {
    'env-prefix': { type: 'string', default: '' },
    'fallback-package': { type: 'string', default: '' },
  })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals } = parsed.value
  if (positionals.length !== 1) return failed(USAGE)
  const given = positionals[0] as string
  const root = resolve(cwd, given)
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return failed(`preflight-repo: not a directory: ${given}`)
  }

  // 1. The worktree exclude. Not fatal.
  const exclude = await ensureWorktreeExclude(root, context.env, LOCK_TIMING)
  const excludeError = exclude.outcome === 'ok' ? null : exclude.error

  // 2. detect, in the root.
  const detection = adapter.detect(root, context.env)
  if (detection.outcome !== 'ok') {
    return ok({
      ok: false,
      pm: null,
      pm_exec: null,
      probe_package: null,
      cause: 'detect',
      stderr: detection.error,
      exclude_error: excludeError,
    })
  }
  const tree = { root, detection: detection.value }

  // 3. The probe, under the prefix, with one retry.
  const prefix = parseEnvPrefix(options['env-prefix'])
  const source = {
    run: ((command, args = [], runOptions) => {
      const line = withEnvPrefix(prefix, { command, args })
      return spawn(line.command, line.args, runOptions)
    }) satisfies Runner,
    env: context.env,
  }
  const fallback = options['fallback-package'] === '' ? null : options['fallback-package']
  let attempt = await adapter.probeRegistry(tree, fallback, source)
  if (attempt.outcome === 'ok' && !attempt.value.ok) {
    attempt = await adapter.probeRegistry(tree, fallback, source)
  }
  if (attempt.outcome !== 'ok') return failed(`preflight-repo: ${attempt.error}`)
  const answer = attempt.value

  // 4. The cause.
  return ok({
    ok: answer.ok,
    pm: detection.value.pm,
    pm_exec: detection.value.pm_exec,
    probe_package: answer.package,
    cause: answer.ok ? null : causeOf(answer),
    stderr: answer.ok ? null : answer.output,
    exclude_error: excludeError,
  })
}

export const preflightRepoCommand: CommandHandler = (context) =>
  preflightRepo(context, node, run, process.cwd())
