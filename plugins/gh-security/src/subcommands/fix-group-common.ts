// What the phases of `fix-group` share: the outcome of a failed phase, the
// git and package-manager runners under the prefix, the adapter route, and
// the rules for the drift commit. The contract is in the header of
// `fix-group.ts`.
//
// This file ships. It imports nothing outside the plugin.

import type { Adapter, Environment, Tree } from '../adapters/adapter.ts'
import type { NodeDetection } from '../adapters/node/detect.ts'
import type { selectAdapter } from '../adapters/registry.ts'
import { type FailedReport, failedReport } from '../cli/command.ts'
import { type EnvPrefix, parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { type Envelope, failed, ok } from '../lib/envelope.ts'
import type { Runner, RunResult } from '../lib/process.ts'
import { type DriverState, loadDriverState } from '../state.ts'

/** What the handler is given beside its context. */
export interface FixGroupDeps {
  /** Starts each child: git, and the package manager that a verb runs. */
  readonly spawn: Runner
  /** The adapter registry. A test gives a stand-in adapter through it. */
  readonly route: typeof selectAdapter
}

/**
 * The subject of the drift commit. Here, the stale-branch guard of `setup`
 * and the commit of `baseline` read it. The `cleanup` of the bash has its
 * own copy until #234.
 */
export const DRIFT_SUBJECT = 'chore(deps): refresh lockfile (control install, no manifest change)'

/** The phase names of an exit 3 that `setup`, `classify` and `baseline` give. */
export type FailedPhase = 'worktree' | 'classify' | 'baseline'

/**
 * Exit 3: a terminal failure of one phase, `fail_phase` in the bash. The
 * report goes to stdout, and the same detail goes to stderr.
 */
export const failPhase = (phase: FailedPhase, detail: string): FailedReport =>
  failedReport(`fix-group: ${phase} failure: ${detail}`, { status: 'failure', phase, detail }, 3)

/** Text without the newlines at its end, as `$( )` removes them. */
export const chomp = (text: string): string => text.replace(/\n+$/, '')

/**
 * What a child wrote to stdout and stderr, as `$(cmd 2>&1)` captures it. A
 * child that did not start wrote nothing, so the start failure is the text,
 * as the shell names the command on stderr.
 */
export const outputOf = (result: RunResult): string =>
  chomp(result.startFailure === null ? result.combined : result.startFailure.message)

/** Run git in one directory, under the prefix. */
export type Git = (dir: string, args: readonly string[]) => Promise<RunResult>

/**
 * The runners of one phase. The prefix wraps each child, and sets no
 * directory: git gets `-C <dir>` after the prefix, and a verb gives its own
 * `cwd`.
 */
export const runners = (
  spawn: Runner,
  prefix: EnvPrefix,
  env: Environment,
): { readonly git: Git; readonly pm: Runner } => ({
  git: (dir, args) => {
    const line = withEnvPrefix(prefix, { command: 'git', args: ['-C', dir, ...args] })
    return spawn(line.command, line.args, { env: env as NodeJS.ProcessEnv })
  },
  pm: (command, args = [], options = {}) => {
    const line = withEnvPrefix(prefix, { command, args })
    return spawn(line.command, line.args, options)
  },
})

/** A phase after `setup`: its state, its adapter and its runners. */
export interface Loaded {
  readonly driver: DriverState
  readonly adapter: Adapter<NodeDetection>
  readonly git: Git
  readonly pm: Runner
  readonly env: Environment
  /** `detect` on the worktree, again for each verb, as each `node.sh` call did. */
  readonly tree: () => Envelope<Tree<NodeDetection>>
}

/** Load the state of `--work`, and route its ecosystem to an adapter. */
export const loadPhase = (work: string, env: Environment, deps: FixGroupDeps): Envelope<Loaded> => {
  const loaded = loadDriverState(work)
  if (loaded.outcome !== 'ok') return loaded
  const driver = loaded.value
  const route = deps.route(driver.ecosystem)
  if (!route.supported) {
    return failed(
      `the state file at ${driver.state.path} names the ecosystem '${driver.ecosystem}', ` +
        `which has no adapter: ${route.reason}`,
    )
  }
  const adapter = route.adapter
  const { git, pm } = runners(deps.spawn, parseEnvPrefix(driver.envPrefix), env)
  const tree = (): Envelope<Tree<NodeDetection>> => {
    const detection = adapter.detect(driver.worktree, env)
    return detection.outcome === 'ok'
      ? ok({ root: driver.worktree, detection: detection.value })
      : detection
  }
  return ok({ driver, adapter, git, pm, env, tree })
}

/** An answer of the adapter, as a record that a field can be read from. */
const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * A field that the adapter contract promises, or the failure of the phase.
 * The port of `adapter_field`. A typed answer has the field, but the check
 * stays: an answer that broke its type fails closed here, and never takes
 * a branch of its own (core.md).
 */
export const promisedField = (
  phase: FailedPhase,
  answer: unknown,
  source: string,
  key: string,
): { readonly value: unknown } | FailedReport => {
  const record = recordOf(answer)
  if (record === null) {
    return failPhase(
      phase,
      `${source} emitted no JSON object on stdout. It is part of the adapter contract ` +
        '(docs/adr/001-ecosystem-adapter-contract.md); an adapter that cannot answer must exit ' +
        'non-zero, not answer with nothing and let a downstream check be skipped rather than failed.',
    )
  }
  if (!Object.hasOwn(record, key)) {
    return failPhase(
      phase,
      `${source} emitted no '${key}' field. It is part of the adapter contract ` +
        '(docs/adr/001-ecosystem-adapter-contract.md); read straight, an absent field arrives as ' +
        'the string "null" and takes a branch of its own instead of failing.',
    )
  }
  return { value: record[key] }
}

/**
 * A path that the drift commit can carry: the lockfile, the PnP files that
 * an install writes again, and the zero-install cache of Yarn Berry. Never
 * `package.json`: the control install had no edit to make to it.
 */
export const driftPathAllowed = (path: string): boolean =>
  DRIFT_FILES.includes(path) || path.startsWith('.yarn/cache/')

const DRIFT_FILES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.pnp.cjs',
  '.pnp.loader.mjs',
]

/**
 * One path for each line of `git status --porcelain`. A rename gives its
 * destination. A path that git quotes stays quoted, so `driftPathAllowed`
 * refuses it, and it goes into the report of the residual.
 */
export const porcelainPaths = (porcelain: string): string[] =>
  porcelain
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const path = line.slice(3)
      const arrow = path.lastIndexOf(' -> ')
      return arrow === -1 ? path : path.slice(arrow + ' -> '.length)
    })
