// `fix-group baseline`: phase 3, the port of `cmd_baseline` in
// `scripts/common/fix-group.sh`. It reads the lockfile as the default branch
// has it, runs the control install with no change to the manifest, commits
// the drift that the install makes, and then reads the lockfile again. The
// contract is in the header of `fix-group.ts`.
//
// This file ships. It imports nothing outside the plugin.

import type { CommandResult } from '../cli/command.ts'
import { orElse, uniqueJq } from '../jq.ts'
import { failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import { readOptionalStrings, type StateFile, writeKey } from '../state.ts'
import {
  chomp,
  DRIFT_SUBJECT,
  driftPathAllowed,
  failPhase,
  type Loaded,
  outputOf,
  porcelainPaths,
  promisedField,
} from './fix-group-common.ts'

/**
 * The failures that one more install can clear: a connection that timed
 * out, was reset, or could not resolve a name this time. Not `ENOTFOUND`,
 * which is usually a wrong registry host, and not the bare `request to ...
 * failed`, which npm also writes for a certificate or a proxy refusal. The
 * match is for each line, as `grep` matches.
 */
const REGISTRY_TIMEOUT =
  /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network timeout|Timeout awaiting|registry.*timed? ?out/i

/** The line that pnpm 11 writes when it does not read the `pnpm` field (#159). */
const PNPM_FIELD_IGNORED = 'The "pnpm" field in package.json is no longer read by pnpm'

/** What one install, with its one retry, said. */
interface InstallRun {
  readonly ok: boolean
  /** stdout, a newline, then stderr, as the bash captured them. */
  readonly output: string
  readonly retried: boolean
  readonly signals: readonly string[]
}

/** One install. A failure of the verb itself is a failed install with its message. */
const installOnce = async (loaded: Loaded): Promise<{ ok: boolean; output: string }> => {
  const tree = loaded.tree()
  const answer =
    tree.outcome === 'ok'
      ? await loaded.adapter.install(tree.value, { run: loaded.pm, env: loaded.env })
      : tree
  if (answer.outcome !== 'ok') return { ok: false, output: `\n${answer.error}` }
  const { stdout, stderr } = answer.value
  return { ok: answer.value.ok, output: `${chomp(stdout)}\n${chomp(stderr)}` }
}

/**
 * The install, with one retry for a failure that has the shape of a registry
 * timeout, and no retry for any other failure (#122).
 */
const runInstall = async (loaded: Loaded): Promise<InstallRun> => {
  let run = await installOnce(loaded)
  let retried = false
  if (!run.ok && REGISTRY_TIMEOUT.test(run.output)) {
    retried = true
    run = await installOnce(loaded)
  }
  const signals = run.output.includes(PNPM_FIELD_IGNORED) ? ['pnpm_field_no_longer_read'] : []
  return { ...run, retried, signals }
}

/** `resolved_versions` of the package, or the failure of the phase. */
const resolved = (
  loaded: Loaded,
  when: 'before' | 'after',
): { readonly answer: JsonObject } | Exclude<CommandResult, undefined> => {
  const pkg = loaded.driver.package
  const tree = loaded.tree()
  const answer = tree.outcome === 'ok' ? loaded.adapter.resolvedVersions(tree.value, pkg) : tree
  if (answer.outcome !== 'ok') {
    return failPhase(
      'baseline',
      `the lockfile could not be parsed ${when} the control install (resolved_versions ${pkg}): ` +
        `${answer.error}. A failed parse is never an empty result.`,
    )
  }
  // The same check as for the other verbs: an answer with no `present`
  // passes each later check by default.
  const present = promisedField(
    'baseline',
    answer.value,
    `resolved_versions ${pkg} (${when} the control install)`,
    'present',
  )
  if ('outcome' in present) return present
  return { answer: answer.value as unknown as JsonObject }
}

/** Write one key, and answer with the new state or the failure. */
const write = (
  state: StateFile,
  key: string,
  value: JsonObject | boolean | string[],
): { readonly state: StateFile } | Exclude<CommandResult, undefined> => {
  const written = writeKey(state, key, value)
  return written.outcome === 'ok' ? { state: written.value } : failed(written.error)
}

/**
 * Commit what the control install changed on the drift paths, and refuse
 * what it changed anywhere else. The answer is whether a drift commit was
 * made, or the failure of the phase.
 */
const commitDrift = async (
  loaded: Loaded,
): Promise<{ readonly drift: boolean } | Exclude<CommandResult, undefined>> => {
  const worktree = loaded.driver.worktree
  const status = async () => {
    const result = await loaded.git(worktree, ['status', '--porcelain'])
    return result.status === 0
      ? { porcelain: outputOf(result) }
      : failPhase('baseline', `git status --porcelain failed in the worktree: ${outputOf(result)}`)
  }
  const first = await status()
  if (!('porcelain' in first)) return first
  if (first.porcelain === '') return { drift: false }

  let staged = 0
  for (const path of porcelainPaths(first.porcelain)) {
    if (!driftPathAllowed(path)) continue
    const added = await loaded.git(worktree, ['add', '--', path])
    if (added.status !== 0) {
      return failPhase('baseline', `git add ${path} failed: ${outputOf(added)}`)
    }
    staged += 1
  }
  let drift = false
  if (staged > 0) {
    const committed = await loaded.git(worktree, ['commit', '-m', DRIFT_SUBJECT])
    if (committed.status !== 0) {
      return failPhase(
        'baseline',
        "the drift commit failed, quoting the repository's own output (never bypass a hook, " +
          `never edit anything to satisfy one): ${outputOf(committed)}`,
      )
    }
    drift = true
  }
  const second = await status()
  if (!('porcelain' in second)) return second
  if (second.porcelain !== '') {
    return failPhase(
      'baseline',
      'the control install touched paths other than the lockfile and its tracked install ' +
        'artifacts, and what an install writes outside those paths is evidence, never noise to ' +
        `absorb. Residual git status --porcelain: ${second.porcelain}`,
    )
  }
  return { drift }
}

/** The baseline phase, on a loaded state. */
export const baseline = async (loaded: Loaded): Promise<CommandResult> => {
  // The snapshot before the drift: the lockfile as the default branch has
  // it, before any install. A lockfile refresh reads it later.
  const before = resolved(loaded, 'before')
  if (!('answer' in before)) return before
  let state = loaded.driver.state
  const preDrift = write(state, 'pre_drift', before.answer)
  if (!('state' in preDrift)) return preDrift
  state = preDrift.state

  // The control install. Its failure is the phase `baseline`, never
  // `install`: it is ambient, and it stops each group of this repository.
  const install = await runInstall(loaded)
  if (!install.ok) {
    const retried = install.retried
      ? ' (including one sanctioned retry after a registry-timeout-shaped failure)'
      : ''
    return failPhase(
      'baseline',
      `the control install${retried}, with no manifest change, failed. Quoting the package ` +
        `manager: ${install.output}`,
    )
  }

  const drift = await commitDrift(loaded)
  if (!('drift' in drift)) return drift

  // The baseline comes after the control install. Then `other_line_moves`
  // of `validate` measures only what the fix moves (#146).
  const after = resolved(loaded, 'after')
  if (!('answer' in after)) return after
  // The union of each signal that an install of this run wrote, so `apply`
  // and `score` can both report it. It is read before the three writes, so a
  // state whose list cannot be read gets none of them.
  const signals = readOptionalStrings(state, 'install_signals')
  if (signals.outcome !== 'ok') return signals
  for (const [key, value] of [
    ['baseline', after.answer],
    ['drift_commit', drift.drift],
    ['install_signals', uniqueJq([...signals.value, ...install.signals])],
  ] as const) {
    const written = write(state, key, value)
    if (!('state' in written)) return written
    state = written.state
  }

  return ok({
    status: 'ok',
    step: 'baseline',
    drift_commit: drift.drift,
    baseline_present: orElse(after.answer.present, false) as JsonValue,
    pre_drift_present: orElse(before.answer.present, false) as JsonValue,
  })
}
