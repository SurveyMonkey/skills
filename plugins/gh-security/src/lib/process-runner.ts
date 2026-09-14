export interface RunRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly input?: string
  readonly env?: Readonly<Record<string, string>>
}

export interface RunResult {
  readonly command: string
  readonly args: readonly string[]
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export type Spawn = (request: RunRequest) => RunResult

export const run = (_request: RunRequest, _spawn?: Spawn): RunResult => {
  throw new Error('run is not implemented yet')
}
