// A stub for the parity capture of `fix-group` (#232). The port replaces it.

import type { selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandResult } from '../cli/command.ts'
import { failed } from '../lib/envelope.ts'
import type { Runner } from '../lib/process.ts'

/** What the handler is given beside its context. */
export interface FixGroupDeps {
  readonly spawn: Runner
  readonly route: typeof selectAdapter
}

export const fixGroup = async (
  _context: CommandContext,
  _deps: FixGroupDeps,
): Promise<CommandResult> => failed('fix-group is not ported yet')
