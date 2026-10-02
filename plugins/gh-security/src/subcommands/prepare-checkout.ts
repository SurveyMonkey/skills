// `gh-security prepare-checkout [--env-prefix <prefix>] <root>`: resolve one
// checkout, and discover and classify its alert groups. This is the contract
// of #193 and #227, built here and not ported. It does the per-checkout part
// of phases 1 and 2 of the `resolve-alerts` skill. The contract is on #227.
//
// One checkout for each call (#193, Constraints). `classify-lines` fetches,
// and the pull request search uses an API with a rate limit. So one call for
// the whole workspace could hit the ten-minute limit of the Bash tool, and
// each checkout is then its own unit of exclusion.
//
// The steps, in this order. Each step is a ported command, and each runs in
// process. This command never starts itself as a child.
//   1. `detect-scope <root>` gives `nwo` and `default_branch`.
//   2. The namespace probe: `git -C <root> ls-remote --heads origin
//      refs/heads/fix`. A branch named `fix` on the remote stops each `fix/*`
//      push (#123). A hit gives the `flat` branch style, and no output gives
//      `slash`. The full refname matters: git matches the whole ref, so
//      `topic/fix` is not a hit. A failed attempt gets one retry. An attempt
//      fails when git exits non-zero, and also when it exits 0 with output
//      that is not a `refs/heads/fix` line. The empty output of a failed
//      probe is never read as `slash`. The inverse collision, a remote
//      branch `fix/dependabot-<package>-<line>x/<more>`, is not probed. A
//      push that it stops fails that one group.
//   3. `discover-alerts <nwo>`, with `--branch-style flat` after a hit. The
//      style belongs to this checkout, and not to a batch.
//   4. `classify-lines --repo-root <root> --base-ref origin/<default_branch>`
//      on the output of step 3. The base ref is not optional: it reads the
//      tree that the fix agents branch from, and not the working tree of the
//      user (#158). Routing is the first step of `classify-lines`.
//
// `--env-prefix` is the opaque command prefix that the environment needs
// (#193, `env-prefix.md`). It goes to each step, so each child of each step
// runs under it: the `git` and `gh` calls of `detect-scope`, the probe, the
// `gh` calls of `discover-alerts`, and the `git` calls of `classify-lines`.
// Nothing here names a tool, or looks for one.
//
// Output, for a checkout that is kept: `{checkout, nwo, default_branch,
// branch_style, actionable, skipped, classify_errors}`. The three lists are
// those of `classify-lines`. A group that no fix can reach is in `skipped`,
// so it is never a row to approve.
//
// Output, for an excluded checkout: `{checkout, excluded: true, reason,
// stderr}`. An exclusion is an answer and not an error, so the exit is 0.
// The four causes, and the `reason` of each:
//   no usable origin                     `nwo` is null. `stderr` is empty.
//   no resolvable default branch         `default_branch` is null, or the
//                                        GitHub read of `detect-scope`
//                                        failed. `stderr` is empty, or the
//                                        error of `detect-scope`.
//   branch namespace probe failed twice  `stderr` is the stderr of the
//                                        second attempt, as git wrote it.
//   discover-alerts failed, or           a stage of the pipeline failed.
//   classify-lines failed                `stderr` is the error of that stage.
// No reason is a guess at a cause, such as "origin unreachable". A failed
// probe can come from auth, from a wrong prefix, or from a remote that is
// not there, and the stderr says which.
//
// The command fails, with exit 1, for a bad command line, for a `<root>`
// that is not a directory, and for a `<root>` that is in no git repository.
// `discover-repos` gives none of these, so they are not exclusions.
//
// Differences from the contract on #227, each an addition:
//   - `classify_errors` is in the answer of a kept checkout. Without it, a
//     failed adapter read has no record.
//   - `checkout` is in the answer of an excluded checkout, because phase 2
//     reports each excluded checkout by name.
//
// This file ships. It imports nothing outside the plugin.

import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import { type selectAdapter as select, selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { type Envelope, failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import { createGhClient } from '../lib/gh.ts'
import { type Runner, type RunResult, run } from '../lib/process.ts'
import { classifyLines, type Signals } from './classify-lines.ts'
import { type ClientFactory, detectScope } from './detect-scope.ts'
import { discoverAlerts } from './discover-alerts.ts'

const USAGE = 'usage: gh-security prepare-checkout [--env-prefix <prefix>] <root>'

/** The one ref that the probe asks for. */
const FIX_REF = 'refs/heads/fix'

/** A line of `ls-remote` for the probe's ref: an object name, a tab, the ref. */
const HIT = /^[0-9a-f]{40,64}\trefs\/heads\/fix$/

/** The reasons of the four exclusion causes. */
const REASONS = {
  noOrigin: 'no usable origin',
  noDefaultBranch: 'no resolvable default branch',
  probeFailed: 'branch namespace probe failed twice',
  discoverFailed: 'discover-alerts failed',
  classifyFailed: 'classify-lines failed',
} as const

/** The answer for an excluded checkout. */
const excluded = (checkout: string, reason: string, stderr: string): CommandResult =>
  ok({ checkout, excluded: true, reason, stderr })

/**
 * The answer of a stage. Each stage handler answers with an envelope. Its
 * declared type is the wider `CommandResult`, which also allows silence and
 * a failed report, and no stage gives either.
 */
const envelopeOf = (result: CommandResult): Envelope<JsonValue> => result as Envelope<JsonValue>

/** One probe attempt: the style, or the text that says why it failed. */
type Probe = { readonly style: 'slash' | 'flat' } | { readonly stderr: string }

/** Read one attempt of the probe. */
const probeOf = (result: RunResult): Probe => {
  if (result.status !== 0) {
    if (result.stderr !== '') return { stderr: result.stderr }
    const start = result.startFailure
    if (start !== null) return { stderr: start.message }
    // A signal leaves no status (`lib/process.ts`).
    const status = result.status === null ? `on ${result.signal}` : result.status
    return { stderr: `git exited ${status}` }
  }
  // A failed pipe can cut the output short, also on exit 0 (`lib/process.ts`).
  const broke = result.streamErrors[0]
  if (broke !== undefined) {
    return {
      stderr: `the output of git ls-remote could not be read: ${broke.code}, ${broke.message}`,
    }
  }
  const lines = result.stdout.split('\n').filter((line) => line !== '')
  if (lines.length === 0) return { style: 'slash' }
  if (lines.every((line) => HIT.test(line))) return { style: 'flat' }
  return { stderr: `git ls-remote gave output that is not a ${FIX_REF} line: ${result.stdout}` }
}

/**
 * The handler. The `gh` client factory, the runner, the registry, the
 * current directory and the signals are parameters, and each goes to the
 * steps that use it.
 */
export const prepareCheckout = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
  route: typeof select,
  cwd: string,
  signals: Signals = process,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, { 'env-prefix': { type: 'string', default: '' } })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals } = parsed.value
  if (positionals.length !== 1) return failed(USAGE)
  const given = positionals[0] as string
  const root = resolve(cwd, given)
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return failed(`prepare-checkout: not a directory: ${given}`)
  }

  const rawPrefix = options['env-prefix']
  const prefixArgs = rawPrefix === '' ? [] : ['--env-prefix', rawPrefix]
  const stage = (args: readonly string[], input = ''): CommandContext => ({
    ...context,
    args: [...prefixArgs, ...args],
    io: { ...context.io, readStdin: () => input },
  })

  // 1. Identity and default branch.
  const scope = envelopeOf(await detectScope(stage([root]), makeClient, spawn, cwd))
  if (scope.outcome !== 'ok') return excluded(root, REASONS.noDefaultBranch, scope.error)
  const identity = scope.value as JsonObject
  if (identity.scope === null) return failed(`prepare-checkout: not a git checkout: ${given}`)
  const nwo = identity.nwo
  if (typeof nwo !== 'string') return excluded(root, REASONS.noOrigin, '')
  const defaultBranch = identity.default_branch
  if (typeof defaultBranch !== 'string') return excluded(root, REASONS.noDefaultBranch, '')

  // 2. The branch namespace probe, with one retry.
  const prefix = parseEnvPrefix(rawPrefix)
  const probe = async (): Promise<Probe> => {
    const line = withEnvPrefix(prefix, {
      command: 'git',
      args: ['-C', root, 'ls-remote', '--heads', 'origin', FIX_REF],
    })
    return probeOf(await spawn(line.command, line.args, { env: context.env }))
  }
  let found = await probe()
  if ('stderr' in found) found = await probe()
  if ('stderr' in found) return excluded(root, REASONS.probeFailed, found.stderr)
  const style = found.style

  // 3. Discovery, with the style of this checkout.
  const styleArgs = style === 'flat' ? ['--branch-style', 'flat'] : []
  const discovered = envelopeOf(
    await discoverAlerts(stage([...styleArgs, nwo]), makeClient, spawn, route),
  )
  if (discovered.outcome !== 'ok') return excluded(root, REASONS.discoverFailed, discovered.error)

  // 4. Classification, against the tree of the default branch on origin.
  const classified = envelopeOf(
    await classifyLines(
      stage(
        ['--repo-root', root, '--base-ref', `origin/${defaultBranch}`],
        JSON.stringify(discovered.value),
      ),
      spawn,
      route,
      cwd,
      signals,
    ),
  )
  if (classified.outcome !== 'ok') return excluded(root, REASONS.classifyFailed, classified.error)
  const groups = classified.value as JsonObject

  return ok({
    checkout: root,
    nwo,
    default_branch: defaultBranch,
    branch_style: style,
    actionable: groups.actionable as JsonValue,
    skipped: groups.skipped as JsonValue,
    classify_errors: groups.classify_errors as JsonValue,
  })
}

export const prepareCheckoutCommand: CommandHandler = (context) =>
  prepareCheckout(context, createGhClient, run, selectAdapter, process.cwd())
