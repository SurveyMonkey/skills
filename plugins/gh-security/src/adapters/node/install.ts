// `install` for the node adapter, ported from `verb_install` in node.sh
// (#222). It is a write verb, so the worktree guard is its first statement
// (ADR 001, "Invocation").
//
// The verb runs the `install_cmd` of the detection in the tree. It uses the
// runner and the environment that it is given (#221, round 3 ruling 9). The
// command splits at white space, as the shell splits an unquoted word. The
// shell also expands a glob in it, and this does not. node.sh exports
// `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` to each child, and this verb sets it
// too. A fix run is not an interactive session.
//
// The answer is what node.sh writes, and the status that it exits with. A
// status that is not 0 is no failure of the verb. Then `ok` is false, and
// the caller reads it. The verb does not run `detect`.
//
// This file ships. It imports nothing outside the plugin.

import { type Envelope, ok } from '../../lib/envelope.ts'
import { requireLinkedWorktree } from '../../worktree.ts'
import type { InstallAnswer, InstallSource, Tree } from '../adapter.ts'
import type { NodeDetection } from './detect.ts'

/** `verb_install`. */
export const install = async (
  { root, detection }: Tree<NodeDetection>,
  { run, env }: InstallSource,
): Promise<Envelope<InstallAnswer>> => {
  const guard = requireLinkedWorktree(root, "refusing to run 'install' here")
  if (guard.outcome !== 'ok') return guard
  const command = detection.install_cmd
  const [program, ...args] = command.split(/[ \t\n]+/).filter((word) => word !== '') as [
    string,
    ...string[],
  ]
  const result = await run(program, args, {
    cwd: root,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  })
  // A command that does not start writes nothing. The shell then names the
  // command on stderr, and the start failure names it here.
  const stderr = result.startFailure === null ? result.stderr : `${result.startFailure.message}\n`
  return ok({
    command,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: `Running: ${command}\n${stderr}`,
  })
}
