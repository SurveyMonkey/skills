// What a command is, and the real io the entry point hands it (#224).
//
// A command is an exported, typed handler. It gives back a `CommandResult`, or
// a promise of one (issue #216's decision comment). The registry is a map from
// a name to a loader for one of those plus the line `--help` prints for it.
// The io is a parameter for the same reason the `gh` client's `run` is one: it
// is the boundary, so an example substitutes it rather than reading the real
// process streams.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs`.

import { readFileSync } from 'node:fs'

import type { Envelope, JsonValue } from '../lib/envelope.ts'

/** The process streams a command may reach, as three functions. */
export interface Io {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** The whole of stdin, read at once. Only a command that takes input calls it. */
  readonly readStdin: () => string
}

/** Everything a handler is given. Parsed arguments, the environment, the io. */
export interface CommandContext {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly io: Io
  /**
   * The registry's own command names. Carried on the context rather than
   * imported by a handler, so that a handler which validates a command line
   * against the registry (`allow-own-commands`) does not import the registry
   * that imports it.
   */
  readonly commandNames: readonly string[]
}

/**
 * An envelope, a failed report, or silence. Silence is exit 0 with nothing
 * written, which the PreToolUse hook contract needs: no decision means the normal permission
 * prompt stands, and a hook that printed something to say so would be
 * putting text into the transcript for every Bash command a session runs.
 */
export type CommandResult = Envelope<JsonValue> | FailedReport | undefined

/**
 * A `failed` outcome that also carries the report the command built. The
 * ADR 001 `failed` outcome has a message and no payload. A command that
 * reports and fails (`pr-status`) needs a caller to read its report on
 * stdout, with exit 1. `run.ts` writes the report to stdout and the
 * message to stderr.
 */
export interface FailedReport {
  readonly outcome: 'failed'
  readonly error: string
  readonly report: JsonValue
}

export const failedReport = (error: string, report: JsonValue): FailedReport => ({
  outcome: 'failed',
  error,
  report,
})

/**
 * A handler answers at once, or with a promise. A command that runs `gh` or
 * `git` must wait for the child, so it returns a promise. A handler that
 * needs no child stays synchronous.
 */
export type CommandHandler = (context: CommandContext) => CommandResult | Promise<CommandResult>

export interface CommandEntry {
  /** One line, printed beside the name by `--help`. */
  readonly description: string
  /**
   * The handler, reached by a dynamic import. A command nobody asked for is
   * never loaded, which matters most for `allow-own-commands`: it runs on
   * every Bash call in a session (#273).
   */
  readonly load: () => Promise<CommandHandler>
}

/** Standard input, as the descriptor number a hook's JSON arrives on. */
export const STDIN_FD = 0

/**
 * Read a descriptor to the end, synchronously. The descriptor is a parameter
 * so the read itself is exercised against a real file rather than against
 * the suite's own stdin.
 */
export const readAll = (fd: number): string => readFileSync(fd, 'utf8')

export const writeStdout = (text: string): void => {
  process.stdout.write(text)
}

export const writeStderr = (text: string): void => {
  process.stderr.write(text)
}

/**
 * The real io: the process's own streams. `bind` rather than a wrapping
 * arrow function, because the only thing being fixed is the descriptor and a
 * wrapper would be a function body no example can run: reading descriptor 0
 * inside the suite is reading the test runner's own stdin.
 */
export const nodeIo: Io = {
  stdout: writeStdout,
  stderr: writeStderr,
  readStdin: readAll.bind(null, STDIN_FD),
}
