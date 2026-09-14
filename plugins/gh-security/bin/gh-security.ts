// The one entry point (#224). Four statements: the runtime floor, then the
// CLI.
//
// **The floor check is first, and it is the only static import.** ADR 012
// enforces the floor where it is crossed rather than documenting it, which
// only works if nothing else has loaded yet: `import` declarations are
// hoisted and evaluated before any statement in this file runs, so a second
// static import would load its whole module graph before the check could
// refuse the runtime. `src/lib/node-floor.ts` imports nothing itself, and
// the rest of the CLI is reached through `await import` below, after the
// check has passed. `spec/ts/cli.test.ts` asserts that placement.
//
// This file ships. It imports nothing outside the plugin.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { nodeIo } = await import('../src/cli/command.ts')
const { runCli } = await import('../src/cli/run.ts')

process.exitCode = runCli(process.argv.slice(2), process.env, nodeIo)
