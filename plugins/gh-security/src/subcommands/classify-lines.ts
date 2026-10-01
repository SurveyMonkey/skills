// STUB for the parity capture. The next commit replaces it.
import type { selectAdapter as select } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { notImplemented } from '../lib/envelope.ts'
import type { Runner } from '../lib/process.ts'

export const classifyLines = async (
  _context: CommandContext,
  _spawn: Runner,
  _route: typeof select,
  _cwd: string,
): Promise<CommandResult> => notImplemented('classify-lines')

export const classifyLinesCommand: CommandHandler = () => notImplemented('classify-lines')
