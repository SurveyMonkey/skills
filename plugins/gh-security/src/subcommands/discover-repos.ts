// STUB for the parity capture. The next commit replaces it.
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { notImplemented } from '../lib/envelope.ts'
import { type Runner, run } from '../lib/process.ts'

export interface DiscoverDeps {
  readonly git: Runner
  readonly deviceOf: (path: string) => number | null
}

export const discoverRepos = async (
  _context: CommandContext,
  _deps: DiscoverDeps,
  _cwd: string,
): Promise<CommandResult> => notImplemented('discover-repos')

export const discoverReposCommand: CommandHandler = () => notImplemented('discover-repos')

export const nodeDeps: DiscoverDeps = { git: run, deviceOf: () => null }
