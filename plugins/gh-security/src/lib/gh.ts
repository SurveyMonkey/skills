import type { EnvPrefix } from './env-prefix.ts'
import type { Envelope, JsonValue } from './envelope.ts'
import type { Spawn } from './process-runner.ts'

export interface GhClientOptions {
  readonly spawn?: Spawn
  readonly envPrefix?: EnvPrefix
}

export interface PullRequestView {
  readonly number: number
  readonly state: string
  readonly isDraft: boolean
  readonly headRefName: string
  readonly baseRefName: string
  readonly mergeStateStatus: string | null
  readonly statusCheckRollup: readonly JsonValue[]
}

export interface GhClient {
  readonly listDependabotAlerts: (input: { repo: string }) => Envelope<readonly JsonValue[]>
  readonly listAdvisories: (input: {
    package: string
    ecosystem: string
  }) => Envelope<readonly JsonValue[]>
  readonly findOpenPullRequest: (input: { repo: string; head: string }) => Envelope<string | null>
  readonly viewPullRequest: (input: { url: string }) => Envelope<PullRequestView>
  readonly createLabel: (input: {
    repo: string
    name: string
    color: string
    description: string
  }) => Envelope<{ created: boolean }>
  readonly createPullRequest: (input: {
    repo: string
    head: string
    title: string
    bodyFile: string
    labels: readonly string[]
  }) => Envelope<{ url: string }>
}

export const createGhClient = (_options?: GhClientOptions): GhClient => {
  throw new Error('createGhClient is not implemented yet')
}
