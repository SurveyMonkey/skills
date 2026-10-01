// STUB for the parity capture. The next commit replaces it.
import type { selectAdapter as select } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { notImplemented } from '../lib/envelope.ts'
import type { GhClient, GhClientOptions } from '../lib/gh.ts'
import type { Runner } from '../lib/process.ts'

export type ClientFactory = (options: GhClientOptions) => GhClient

export const discoverAlerts = async (
  _context: CommandContext,
  _makeClient: ClientFactory,
  _spawn: Runner,
  _route: typeof select,
): Promise<CommandResult> => notImplemented('discover-alerts')

export const discoverAlertsCommand: CommandHandler = () => notImplemented('discover-alerts')
