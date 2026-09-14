import type { EnvPrefix } from './env-prefix.ts'
import type { Envelope } from './envelope.ts'
import type { RunResult, Spawn } from './process-runner.ts'

export interface GitOptions {
  readonly spawn?: Spawn
  readonly envPrefix?: EnvPrefix
}

export const git = (
  _dir: string,
  _args: readonly string[],
  _options?: GitOptions,
): Envelope<RunResult> => {
  throw new Error('git is not implemented yet')
}
