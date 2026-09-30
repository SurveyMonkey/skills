// The entry point of the SessionStart hook. `hooks.json` runs it with node.
// It holds no check logic: the `session-start` subcommand is the hook.
//
// **The floor guard is the only static import.** Node evaluates every
// `import` before the first statement. A second static import would load
// its module graph on the runtime that this guard must refuse. This file
// calls `meetsNodeFloor`, not `assertNodeFloor`, because an error on stderr
// would go into the session. The command string in `hooks.json` covers a
// machine that has no node.
//
// **Below the floor, this file writes one `systemMessage` line.** A
// SessionStart hook runs once, so it may say so. The line has no colour, and
// this file imports nothing more than the floor guard to write it, because
// the old runtime may not load one.
//
// **Nothing here may stop a session.** An error inside the `try` block goes
// to stderr as a stack, and the exit status stays 0. A failed `await import`
// is outside the `try` block and exits non-zero. The `exit 0` in
// `hooks.json` absorbs that status.
//
// This file ships. It imports nothing outside the plugin.

import { belowFloorMessage, meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { nodeIo } = await import('../src/cli/command.ts')
  const { runCli } = await import('../src/cli/run.ts')
  try {
    process.exitCode = await runCli(['session-start'], process.env, nodeIo)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`)
    process.exitCode = 0
  }
} else {
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `\ngh-security: ⚠️ ${belowFloorMessage(process.version)}` })}\n`,
  )
  process.exitCode = 0
}
