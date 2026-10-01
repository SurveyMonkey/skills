// STUB for the parity capture. The next commit replaces it.
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { notImplemented } from '../lib/envelope.ts'
import type { GhClient, GhClientOptions } from '../lib/gh.ts'
import type { Runner } from '../lib/process.ts'

export type ClientFactory = (options: GhClientOptions) => GhClient

export const detectScope = async (
  _context: CommandContext,
  _makeClient: ClientFactory,
  _spawn: Runner,
  _cwd: string,
): Promise<CommandResult> => notImplemented('detect-scope')

export const detectScopeCommand: CommandHandler = () => notImplemented('detect-scope')
