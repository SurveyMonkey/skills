// The stdout and stderr rules that every command needs, in one place. This
// file has the same API as the target stack's `lib/streams.ts`.
//
// node already does two of the three duties, so this file does not build
// them again. `tests/lib/streams.test.ts` pins each one against a real child:
//
//   - *UTF-8*. node writes a string as UTF-8, whatever the locale says. The
//     one real duty is on the way in, which is what {@link readStdinText}
//     does.
//   - *A closed descriptor*. node opens /dev/null over a stdio descriptor
//     that was closed before launch. `process.stdout` is then always a real
//     stream, and node discards the writes.
//
// The third duty is real here:
//
//   - *EPIPE*. When the reader closes the pipe (`cmd | head`), the write
//     fails as an `error` event on the stream, not as an exception at the
//     call. With no listener, node crashes with an internal stack trace.
//     {@link createWriter} makes the writer go quiet, and the run finishes
//     normally.
//
// **Only EPIPE is swallowed.** A listener silences node's default crash for
// every error code on that stream. So this file throws an `ENOSPC` or an
// `EIO` again, and does not lose it with the broken pipe.
//
// This file ships. It imports nothing at all, and stays inside the erasable
// subset.

/** One stream error to report: node's code and node's message. */
export interface StreamFailure {
  /** node's own code, or the error's name for an error that has no code.
   *  Only a broken pipe (`EPIPE`) is never in this account. */
  readonly code: string
  readonly message: string
}

/**
 * A stream `error` event as zero or one failure to report.
 *
 * This is the one place that decides the rule "only EPIPE is swallowed".
 * The writer below and the three child pipes in `process.ts` both use it.
 * It is a pure function, and it returns the full account, not a verdict. So
 * `process.ts` can attach it to each pipe with no branch of its own, which
 * would be a branch no real child can reach.
 */
export const streamFailures = (error: NodeJS.ErrnoException): readonly StreamFailure[] =>
  error.code === 'EPIPE' ? [] : [{ code: error.code ?? error.name, message: error.message }]

/**
 * The part of a writable stream that this file uses.
 *
 * The type is structural, so `process.stdout` satisfies it, and a test
 * satisfies it with a plain object. It is an interface, not a class: `tsc`
 * sees a type that crosses the `src/lib` symlink under two identities, and
 * only a structural type is the same under both.
 */
export interface OutputStream {
  write(text: string): boolean
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/** One guarded stream. */
export interface Writer {
  /** Write, unless this writer is quiet. */
  write(text: string): void
  /** Go quiet for good, on purpose. */
  silence(): void
  /** Whether this writer still writes. A caller can then stop building
   *  lines that no reader gets. */
  readonly silenced: boolean
}

/**
 * A writer over `stream` that goes quiet on a broken pipe.
 *
 * The EPIPE guard goes on once, here, not at each write, because the
 * failure is an event, not a return value. Every other error code is thrown
 * again, so node reports it as the uncaught exception it would be with no
 * listener.
 */
export const createWriter = (stream: OutputStream): Writer => {
  let silenced = false
  stream.on('error', (error) => {
    // {@link streamFailures} is the rule. An empty account is a broken pipe.
    if (streamFailures(error).length === 0) {
      silenced = true
      return
    }
    throw error
  })
  return {
    write: (text) => {
      if (silenced) return
      stream.write(text)
    },
    silence: () => {
      silenced = true
    },
    get silenced() {
      return silenced
    },
  }
}

/** The pair a command writes through. */
export interface Output {
  readonly out: Writer
  readonly err: Writer
  /** Both, for the end of a run. */
  silence(): void
}

/**
 * stdout and stderr as two writers with separate guards.
 *
 * They are separate on purpose. A reader that closed the pipe took stdout
 * with it. A real failure after that must still get to the terminal on
 * stderr.
 *
 * The streams are arguments, not defaults that read `process.stdout`. So a
 * command holds no reference to its own process, and this file's suite
 * needs no process at all.
 */
export const createOutput = (out: OutputStream, err: OutputStream): Output => {
  const stdout = createWriter(out)
  const stderr = createWriter(err)
  return {
    out: stdout,
    err: stderr,
    silence: () => {
      stdout.silence()
      stderr.silence()
    },
  }
}

/**
 * All of `stream`, decoded as UTF-8 with replacement.
 *
 * Replacement, not strict decoding: a stray byte costs one character, not
 * the whole input. The parameter is the stream, not `process.stdin`, for
 * the same reason that {@link createOutput} takes its streams.
 */
export const readStdinText = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
