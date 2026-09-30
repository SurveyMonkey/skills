// STUB for the parity capture. The port replaces this body.
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { notImplemented } from '../lib/envelope.ts'
import type { GhClient, GhClientOptions } from '../lib/gh.ts'
import type { Runner } from '../lib/process.ts'

export type ClientFactory = (options: GhClientOptions) => GhClient

export const prStatus = async (
  _context: CommandContext,
  _makeClient: ClientFactory,
  _spawn: Runner,
): Promise<CommandResult> => notImplemented('pr-status')

export const prStatusCommand: CommandHandler = () => notImplemented('pr-status')
