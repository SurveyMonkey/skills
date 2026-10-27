// The CLI: parse, dispatch, render, exit. Nothing else happens here, because
// a command is an exported handler and the entry point is a thin registry
// over those handlers (issue #216's decision comment). Everything below is
// what a spawned process has left to cover. `--out <file>` is applied here,
// for each command whose registry entry opts in (`out-file.ts`).
//
// This file ships. It imports nothing outside the plugin.

import {
  EXIT_CODES,
  type ExitCode,
  exitCodeFor,
  failed,
  type Rendered,
  renderJson,
  thrownText,
} from '../lib/envelope.ts'
import { confinementProblem } from '../run-paths.ts'
import type { CommandResult, FailedReport, Io } from './command.ts'
import { takeOut, writeOut } from './out-file.ts'
import { COMMANDS, commandNames } from './registry.ts'

export const USAGE = 'usage: gh-security <command> [args]'

/** The command list, one line each, as `--help` and a bare invocation print it. */
export const helpText = (): string => {
  const entries = Object.entries(COMMANDS)
  const width = Math.max(...entries.map(([name]) => name.length))
  const lines = entries.map(([name, entry]) => `  ${name.padEnd(width)}  ${entry.description}`)
  return [USAGE, '', 'Commands:', ...lines].join('\n')
}

/**
 * The flags that ask for the command list. A bare invocation asks for the
 * same thing: a CLI that did nothing when run with no arguments would leave
 * a reader with no way to find out what it does.
 */
const HELP_FLAGS: readonly string[] = ['--help', '-h']

/**
 * Split `process.argv.slice(2)`. Only the first token is inspected: a
 * command's own flags belong to that command, so `--help` after a command
 * name is passed through as one of its arguments.
 */
const splitArgv = (
  argv: readonly string[],
):
  | { readonly kind: 'help' }
  | { readonly kind: 'command'; readonly command: string; readonly args: readonly string[] } => {
  const [command, ...args] = argv
  if (command === undefined || HELP_FLAGS.includes(command)) return { kind: 'help' }
  return { kind: 'command', command, args }
}

/**
 * Write whichever halves have something to say, each with the trailing
 * newline the renderer deliberately leaves off, and answer with the exit
 * code. An empty half is not written at all: a stray newline on stdout is a
 * body a caller reading this CLI's JSON contract has to parse.
 */
const emit = (io: Io, rendered: Rendered): ExitCode => {
  if (rendered.stdout !== '') io.stdout(`${rendered.stdout}\n`)
  if (rendered.stderr !== '') io.stderr(`${rendered.stderr}\n`)
  return rendered.exitCode
}

/**
 * A failure that carries a report writes the report to stdout and the
 * message to stderr, with the exit status of the report (1 unless the
 * command gave another). A caller reads the same JSON on stdout
 * whether the command passed or failed. Any other result renders as the
 * envelope says.
 */
const render = (result: Exclude<CommandResult, undefined>): Rendered =>
  'report' in result ? renderReport(result) : renderJson(result)

const renderReport = (result: FailedReport): Rendered => ({
  stdout: JSON.stringify(result.report),
  stderr: result.error,
  exitCode: result.exitCode ?? EXIT_CODES.failed,
})

/**
 * The result of a command, or the `failed` envelope when the load or the
 * handler throws (issue #302). A throw is a defect in the command. Without
 * this guard, node ends with a stack trace and an empty stdout, and a caller
 * that reads stdout as the contract reads nothing. The line has the form of
 * `failedOnThrow` in `lib/envelope.ts`, `<command>: <message>`. Here it also
 * goes to stdout as the envelope, so the caller reads one shape.
 */
const settle = async (
  command: string,
  attemptCommand: () => Promise<CommandResult> | CommandResult,
): Promise<CommandResult> => {
  try {
    return await attemptCommand()
  } catch (error) {
    return failed(`${command}: ${thrownText(error)}`)
  }
}

/**
 * Run one invocation and answer with the process exit code. ADR 001's four
 * exit codes come from the envelope the handler returned, through
 * `exitCodeFor`, so a verb that is not implemented stays exit 2 and an
 * unsupported toolchain stays exit 3 rather than collapsing into a generic
 * failure. A failed report is the one exception: it exits with the status
 * that it carries.
 */
export const runCli = async (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: Io,
): Promise<ExitCode> => {
  const parsed = splitArgv(argv)
  if (parsed.kind === 'help') {
    return emit(io, { stdout: helpText(), stderr: '', exitCode: EXIT_CODES.ok })
  }
  // An own key only: `toString` or `constructor` would otherwise resolve to
  // an Object.prototype member and crash here instead of being refused.
  const entry = Object.hasOwn(COMMANDS, parsed.command) ? COMMANDS[parsed.command] : undefined
  if (entry === undefined) {
    const envelope = failed(
      `unknown command "${parsed.command}". Run gh-security --help for the list of commands.`,
    )
    // A dispatch failure is not a command's result, so the JSON goes to
    // stderr and stdout stays empty: a caller reading stdout as this CLI's
    // contract must never read "there is no such command" as a payload.
    return emit(io, {
      stdout: '',
      stderr: renderJson(envelope).stdout,
      exitCode: exitCodeFor(envelope),
    })
  }
  const refuse = (message: string): ExitCode =>
    emit(io, renderJson(failed(`${parsed.command}: ${message}`)))
  const split = takeOut(parsed.args, entry.out)
  if (split.outcome !== 'ok') return refuse(split.error)
  const { out, args } = split.value
  if (out !== null) {
    // `reap.ts` loads only for a call with `--out`. Each Bash call of a
    // session loads this file for the allow hook, which needs no `reap.ts`.
    const { resolvePhysical } = await import('../reap.ts')
    const problem = confinementProblem('--out', out, resolvePhysical)
    if (problem !== null) return refuse(problem)
  }
  // With `--out`, the text that a command writes itself waits here. It goes
  // to stdout only after the file is written (`out-file.ts`).
  let text = ''
  const commandIo: Io =
    out === null
      ? io
      : {
          ...io,
          stdout: (chunk) => {
            text += chunk
          },
        }
  const result = await settle(parsed.command, async () => {
    const handler = await entry.load()
    return handler({ args, env, io: commandIo, commandNames })
  })
  const rendered = result === undefined ? undefined : render(result)
  if (out !== null) {
    const problem = writeOut(out, rendered === undefined ? text : `${text}${rendered.stdout}\n`)
    if (problem !== null) return refuse(problem)
    if (text !== '') io.stdout(text)
  }
  return rendered === undefined ? EXIT_CODES.ok : emit(io, rendered)
}
