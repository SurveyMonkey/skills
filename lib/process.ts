// This file runs one child process with no shell, with a time limit that
// really works. It has the same API as the target stack's `lib/process.ts`.
// A process seam exists only at an ecosystem boundary (ADR 001 as amended
// by ADR 012): the package manager, `git`, `gh` and `detect-capacity.sh`.
// `lib/gh.ts` runs `gh` through this file.
//
// **Failure to start is not failure to succeed.** A child that is not on
// PATH gets status 127. Any other child that cannot run gets status 126.
// These are the statuses a shell uses for the two cases.
// {@link RunResult.startFailure} carries the same fact as data, so a caller
// can branch on it without a parse of prose.
//
// **No shell, ever.** Every argument gets to the child as written. A branch
// name or a package name with shell metacharacters is one argument, and no
// shell reads it again.
//
// **Asynchronous.** `harness/parity.ts` is synchronous, so it keeps a local
// runner.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `child_process`. It stays inside the erasable subset.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { type StreamFailure, streamFailures } from './streams.ts'

/** Why a child never ran at all. */
export interface StartFailure {
  /** node's own error code. Two kinds of code can get to this field:
   *
   *   - a libuv errno, for a child that node tried to start. `ENOENT` means
   *     the command is not on PATH, or the `cwd` is not there. `EACCES`
   *     means the file is there but is not executable.
   *   - a node `ERR_*` code, now `ERR_INVALID_ARG_VALUE`. node refused the
   *     argv before a child existed: a NUL byte in the command, an
   *     argument, `cwd`, or the environment.
   *   - a libuv errno that `spawn` throws at once, such as `E2BIG` for an
   *     argv that is too long. This is also a defect in the argv.
   *
   *  "Not ENOENT" does not mean "on PATH and still would not run". For the
   *  second and third kinds, the defect is in the argv. Branch on `ENOENT`
   *  for a command that is not there.
   */
  readonly code: string
  /** node's message. It names the command and the code. */
  readonly message: string
}

export interface RunOptions {
  /** Where the child runs. A directory that is not there is a
   *  {@link StartFailure}, not a throw. */
  readonly cwd?: string
  /** The child's whole environment. When absent, the child gets this
   *  process's environment. This value replaces that environment; it does
   *  not add to it. */
  readonly env?: NodeJS.ProcessEnv
  /** Written to the child, then closed. When absent, the child still gets
   *  a pipe, and it closes at once. A child that reads stdin then sees EOF,
   *  and does not wait for a writer that never comes. */
  readonly stdin?: string | Uint8Array
  /** The time limit, in milliseconds. When it fires, this kills the
   *  child's whole process group (see {@link killGroup}), and
   *  {@link RunResult.timedOut} reports it. When absent, the wait has no
   *  limit.
   *
   *  This file does not check this value. `setTimeout` reads `NaN` and a
   *  negative number as 0, and a number above 2^31-1 as 1 ms. The child
   *  then dies on the next tick, and the result reports `timedOut: true`.
   *  A caller that calculates a limit must validate it, because
   *  {@link run} never throws. */
  readonly timeoutMs?: number
}

export interface RunResult {
  /** The child's exit status, or `null` when a signal ended it. On a
   *  {@link startFailure}, this is the shell's status: 127 for a command
   *  that is not found, 126 for one that cannot run. */
  readonly status: number | null
  /** The signal that ended the child, or `null`. `SIGKILL` with
   *  {@link timedOut} set means that the time limit fired. */
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** Both streams, in the order that their chunks came in. This is the
   *  order of two pipes, not the child's own write order. A caller that
   *  needs the two streams apart has them in `stdout` and `stderr`. */
  readonly combined: string
  /** Whether the time limit fired. */
  readonly timedOut: boolean
  /** How long the child really took. A watch that returns early did not
   *  wait the full limit, and a caller that decides whether to wait again
   *  must know that. */
  readonly elapsedMs: number
  /** Set only when the child never ran. `null` means the child ran,
   *  whatever its exit status. */
  readonly startFailure: StartFailure | null
  /** Every error from the child's three pipes that is not a broken pipe,
   *  in the order they came. An empty list is the usual case.
   *
   *  A broken pipe means that the reader left, not that a write failed.
   *  Any other error means that a write or a read did not complete, so the
   *  output may be short. {@link status} can still be 0: a child that got
   *  half its stdin can exit 0 on what it got.
   *
   *  This is a field, not a throw, because the runner never rejects. It is
   *  not a listener that swallows the error, because a listener silences
   *  node's own crash for every error on that stream. `lib/gh.ts` makes a
   *  list that is not empty into a `GhError`. */
  readonly streamErrors: readonly StreamFailure[]
}

/** The shape of {@link run}, for a caller that takes it as an injected
 *  seam (`lib/gh.ts` `GhClientOptions.run`). It is a type, not a class:
 *  `tsc` sees a type that crosses the `src/lib` symlink under two
 *  identities, and only a structural type is the same under both. */
export type Runner = (
  command: string,
  args?: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>

/**
 * Kill the whole process group of `pid`.
 *
 * This is why {@link run} starts a bounded child detached. A child can start
 * children of its own, for example `gh pr checks --watch`. A kill of only
 * the one child would leave its children on the network after the caller
 * stops. A detached child is a session leader, so the group signal cannot
 * get to this process or to the session that started it.
 *
 * The signal throws for a group that is already gone, or on a platform with
 * no process groups. This function catches that and reports nothing. The
 * caller signals the child directly next in all cases, and a dead group is
 * the result it wanted.
 */
export const killGroup = (pid: number): void => {
  try {
    // The negative pid names the group. SIGKILL, not SIGTERM: the time
    // limit has expired, and a child that ignores SIGTERM is the child this
    // code is for.
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group can be gone, or this process can have no group to signal,
    // or no permission to signal it (EPERM). Then only the one child dies.
    // The direct kill in `run` always follows. A refused kill there becomes
    // a {@link RunResult.streamErrors} entry, not silence.
  }
}

/** ENOENT maps to the shell's 127 ("command not found"). All other reasons
 *  that a child could not run map to 126 ("cannot execute"). */
const startStatus = (failure: StartFailure): number => (failure.code === 'ENOENT' ? 127 : 126)

/** A child that never ran, as an answer, not a throw. Nothing started, so
 *  there is no output, no signal, and no time limit that fired. */
const refusedToStart = (failure: StartFailure, startedAt: number): RunResult => ({
  status: startStatus(failure),
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: Math.round(performance.now() - startedAt),
  startFailure: failure,
  streamErrors: [],
})

/**
 * Run `command` and report all that the child did.
 *
 * This never rejects, not even for an argv that node refuses. A child that
 * fails, is killed, or never starts is still an answer here. `lib/gh.ts` is
 * where a failure becomes a thrown error, at the one seam whose caller
 * expects one.
 */
export const run: Runner = (command, args = [], options = {}) =>
  new Promise<RunResult>((resolve) => {
    // `performance.now()`, not `Date.now()`: a wall clock can step during a
    // long watch, and then gives a wrong or negative time. It is a node
    // global, so this file imports nothing more.
    const startedAt = performance.now()
    // `spawn` reports most failures on the `error` event below. But it
    // checks argv synchronously, and throws for a NUL byte in the command or
    // in an argument (`ERR_INVALID_ARG_VALUE`). It also throws some libuv
    // errors at once, such as `E2BIG` for an argv that is too long. A throw
    // in this executor is a rejection, which {@link run} promises never to
    // give. So it becomes the answer for a child that could not run.
    let child: ChildProcessWithoutNullStreams | null = null
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        // Only a bounded child is detached. An unbounded child stays in this
        // process's group, so a Ctrl-C in the terminal gets to it.
        detached: options.timeoutMs !== undefined,
        // No `stdio` key. node's default already pipes all three streams.
        // With the key, the types select the overload whose `stdout` and
        // `stderr` can be null, which puts a `?.` (a branch no test can
        // fail) on every read below.
        shell: false,
      })
    } catch (error) {
      // A type assertion, not a default. Each synchronous throw from `spawn`
      // has a code: `ERR_*` from the argv check, or a libuv errno such as
      // `E2BIG`. The code is never `ENOENT`, so `startStatus` gives 126.
      const rejected = error as NodeJS.ErrnoException & { code: string }
      resolve(refusedToStart({ code: rejected.code, message: rejected.message }, startedAt))
    }
    if (child === null) return

    const out: Buffer[] = []
    const err: Buffer[] = []
    const both: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk)
      both.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk)
      both.push(chunk)
    })

    // One listener for all three pipes, with no branch. A child that exits
    // before it reads its input makes the stdin write fail with EPIPE. With
    // no listener, that is an uncaught exception, and it crashes this whole
    // process after the child's status is already known. stdout and stderr
    // need the listener too, for the same reason.
    //
    // The listener does not swallow the other codes. An ENOSPC or an EIO
    // goes into the result, because a child that got half its stdin can
    // still exit 0. {@link streamFailures} is the one place for that rule.
    const streamErrors: StreamFailure[] = []
    const noteStreamError = (error: NodeJS.ErrnoException): void => {
      streamErrors.push(...streamFailures(error))
    }
    child.stdin.on('error', noteStreamError)
    child.stdout.on('error', noteStreamError)
    child.stderr.on('error', noteStreamError)
    child.stdin.end(options.stdin)

    let timedOut = false
    // The pid is `undefined` exactly when the spawn failed at once. node
    // reports that synchronously for ENOENT and EACCES. There is then no
    // child to bound, and the `error` event below comes next.
    const pid = child.pid
    const timer =
      options.timeoutMs === undefined || pid === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            killGroup(pid)
            // This kill always runs, not only when the group kill failed. A
            // kill of a child that is already dead does nothing in node: it
            // returns false and throws nothing. A condition here would be a
            // branch that no test can reach on a live child.
            child.kill('SIGKILL')
          }, options.timeoutMs)

    let startFailure: StartFailure | null = null
    // node emits `error` on a child for four reasons: a spawn that failed, a
    // kill that failed, a message send that failed, and an abort. Only the
    // first is a failure to start. The time limit's own `child.kill` above
    // can cause the second (EPERM). To record that as a `startFailure`
    // would report "cannot run" for a child that ran to its end.
    //
    // node emits `spawn` only for a child that really started. The reporter
    // changes at that point, so the two cases are apart with no branch and
    // no flag.
    let report = (error: NodeJS.ErrnoException): void => {
      // A type assertion, not a `?? error.name` fallback. Every failure
      // that node reports for a child that could not start comes from libuv
      // with an errno code (ENOENT and EACCES, both tested). No test can
      // reach a fallback, and the assertion adds no branch.
      const failed = error as NodeJS.ErrnoException & { code: string }
      startFailure = { code: failed.code, message: failed.message }
    }
    child.on('error', (error) => {
      report(error)
    })
    child.once('spawn', () => {
      report = noteStreamError
    })

    // `close`, not `exit`. `close` fires only after the child has ended and
    // its stdio has closed, so the last chunk of output is already here. A
    // spawn that fails also emits `error` and then `close`. So this is the
    // one place that the promise settles, and no guard against a second
    // settle is necessary.
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const failure: StartFailure | null = startFailure
      resolve({
        // On a failed spawn, `code` is the negative errno. No caller must
        // see that value, so the shell's status replaces it.
        status: failure === null ? code : startStatus(failure),
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        combined: Buffer.concat(both).toString('utf8'),
        timedOut,
        elapsedMs: Math.round(performance.now() - startedAt),
        startFailure: failure,
        streamErrors,
      })
    })
  })
