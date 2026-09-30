// STUB for the parity capture. The port replaces this body.
import type { CommandHandler } from '../cli/command.ts'
import { type Envelope, type JsonObject, notImplemented } from '../lib/envelope.ts'

export interface LockTiming {
  readonly attempts: number
  readonly waitMs: number
}

export const LOCK_TIMING: LockTiming = { attempts: 50, waitMs: 100 }

export const ensureWorktreeExclude = async (
  _repoRoot: string,
  _env: Readonly<Record<string, string | undefined>>,
  _timing: LockTiming,
): Promise<Envelope<JsonObject>> => notImplemented('ensure-worktree-exclude')

export const ensureWorktreeExcludeCommand: CommandHandler = () =>
  notImplemented('ensure-worktree-exclude')
