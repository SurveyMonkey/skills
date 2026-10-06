// SIGINT and SIGTERM, held while a command owns a worktree (ruling 11 on #234,
// and ruling 15 on #225). Two commands make a worktree and use this helper:
// `classify-lines --base-ref` and `fix-group setup`.
//
// While the body runs, SIGINT and SIGTERM do not stop the process. The
// listener only records the first signal. When the body returns or throws,
// the release runs with that signal, or with null. The release removes the
// worktree that the process made. Then, when a signal came, the process exits
// with the status that a shell gives: 128 and the number of the signal (130
// for SIGINT, 143 for SIGTERM). The command writes no answer on stdout,
// because the exit comes before the answer.
//
// The body is not stopped part way. But a git child stays in the process
// group (`src/lib/process.ts`), so a Ctrl-C in the terminal also stops it.
// A `git worktree add` can thus stop part way, with no exit status. So the
// release reads the disk, and does not trust the body to have finished.
//
// Other signals, such as SIGHUP, stop the process at once, and the worktree
// stays. SIGKILL cannot be caught. `src/reap.ts` says how the reap finds a
// worktree that such a process left.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `os`.

import { constants } from 'node:os'

/** The part of `process` that the helper uses. A test gives a stand-in. */
export interface Signals {
  readonly on: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown
  readonly off: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown
  readonly exit: (status: number) => void
}

/** Run `body` with SIGINT and SIGTERM held, then `release`, then exit for a signal. */
export const holdSignals = async <T>(
  signals: Signals,
  body: () => Promise<T>,
  release: (signal: NodeJS.Signals | null) => Promise<void>,
): Promise<T> => {
  // The type comes from the assertion. With a type annotation, tsc reads the
  // `null` and then sees no signal in the `finally`.
  let stopped = null as NodeJS.Signals | null
  const stop = (signal: NodeJS.Signals): void => {
    stopped ??= signal
  }
  signals.on('SIGINT', stop)
  signals.on('SIGTERM', stop)
  try {
    return await body()
  } finally {
    try {
      await release(stopped)
    } finally {
      signals.off('SIGINT', stop)
      signals.off('SIGTERM', stop)
      if (stopped !== null) signals.exit(128 + constants.signals[stopped])
    }
  }
}
