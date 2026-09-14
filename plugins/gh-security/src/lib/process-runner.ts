// The process runner. A process seam exists only at an ecosystem boundary
// (ADR 001 as amended by ADR 012): the package manager, `git`, `gh` and
// `detect-capacity.sh`. Everything else is a function call, so this module is
// the only place in the port that starts a process, and the `gh` client and
// the git helpers are both built on it.
//
// **The spawn is a parameter.** `run` takes one and defaults to `nodeSpawn`,
// which is the boundary itself. That parameter is the documented seam an
// example substitutes through (the testing skill's mocking.md), and it is why
// the `gh` client can be exercised against real `gh` output shapes without a
// network, while the git helpers are exercised against real repositories
// through the default.
//
// **Synchronous, deliberately.** The scripts this replaces are sequential:
// every one of them runs a command, reads its output, and decides what to run
// next from it, and the fix driver is stepped precisely so that a phase
// finishes before the next begins. `spawnSync` keeps that ordering in the
// shape of the code rather than in a chain of awaits, keeps a stack trace
// attached to the call that started the process, and lets a verb be an
// ordinary function that a caller does not have to be async to use. Nothing
// here runs two commands at once; concurrency in this plugin is many agents,
// each in its own process, which `detect-capacity.sh` sizes.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `child_process` and `os`.

import { spawnSync } from 'node:child_process'
import { constants } from 'node:os'

import { type Envelope, failure, ok } from './envelope.ts'

export interface RunRequest {
  readonly command: string
  readonly args: readonly string[]
  /** Where the command runs. Absent means the current directory. */
  readonly cwd?: string
  /** Written to the child's stdin and closed. */
  readonly input?: string
  /** Added to the inherited environment, never replacing it. */
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

/**
 * The status a command that never started is reported under. 127 is what a
 * shell reports for a command it could not find, and it is the status
 * `discover-repos.sh` already names for a missing `git`.
 */
export const SPAWN_FAILED = 127

/** A shell reports a signal death as 128 plus the signal number. */
export const SIGNAL_EXIT_BASE = 128

/**
 * 64 MiB. Node's own default is 1 MiB, which a `gh api --paginate --slurp`
 * over a busy repository's Dependabot alerts passes without difficulty; the
 * failure that produces is an `ENOBUFS` mid-collection, and a short answer
 * read as a complete one is the defect class this whole port exists to close.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** The boundary: a real child process. */
export const nodeSpawn: Spawn = (request) => {
  const result = spawnSync(request.command, [...request.args], {
    cwd: request.cwd,
    input: request.input,
    env: { ...process.env, ...request.env },
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    // No shell. Every argument reaches the command as written, so a package
    // name or a branch name carrying shell metacharacters is an argument
    // rather than a word the shell gets to re-read.
    shell: false,
  })
  const base = { command: request.command, args: request.args }
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error !== undefined) {
    // The command never ran: it is not on PATH, the cwd does not exist, or
    // the output passed MAX_OUTPUT_BYTES. Node's message is the one carried
    // through verbatim ("spawnSync git ENOENT"), because a tidied one is a
    // spelling no caller has ever had to classify.
    return { ...base, status: SPAWN_FAILED, stdout, stderr: result.error.message }
  }
  if (result.status !== null) {
    return { ...base, status: result.status, stdout, stderr }
  }
  // `spawnSync` leaves `status` null exactly when the child was killed by a
  // signal, and sets `signal` in the same breath, so there is no third state
  // here to branch on.
  const signal = result.signal as NodeJS.Signals
  return { ...base, status: SIGNAL_EXIT_BASE + constants.signals[signal], stdout, stderr }
}

/** Run a command, defaulting to a real process. */
export const run = (request: RunRequest, spawn: Spawn = nodeSpawn): RunResult => spawn(request)

/**
 * What went wrong, in one line, for the `error` field of an envelope. The
 * output is quoted because a command's own diagnosis is what a reader needs;
 * a command that failed silently says so rather than leaving an empty quote
 * that reads as no failure at all.
 */
export const describeRun = (result: RunResult): string => {
  const detail = result.stderr.trim() || result.stdout.trim() || 'no output'
  const invocation = [result.command, ...result.args].join(' ')
  return `${invocation} failed (exit ${result.status}): ${detail}`
}

/**
 * Run a command and read a non-zero status as a failure. This is the shape
 * every caller in this plugin wants: the scripts' own `|| die "...: $out"`
 * pairs, with the status check impossible to forget.
 */
export const runOk = (request: RunRequest, spawn: Spawn = nodeSpawn): Envelope<RunResult> => {
  const result = run(request, spawn)
  return result.status === 0 ? ok(result) : failure(describeRun(result))
}
