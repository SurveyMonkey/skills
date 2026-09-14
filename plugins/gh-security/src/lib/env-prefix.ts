import type { RunRequest } from './process-runner.ts'

export type EnvPrefix = readonly string[]

export const NO_ENV_PREFIX: EnvPrefix = []

export const parseEnvPrefix = (_raw: string | null | undefined): EnvPrefix => {
  throw new Error('parseEnvPrefix is not implemented yet')
}

export const withEnvPrefix = (_prefix: EnvPrefix, _request: RunRequest): RunRequest => {
  throw new Error('withEnvPrefix is not implemented yet')
}
