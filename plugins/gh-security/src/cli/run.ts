// The CLI: parse, dispatch, render, exit. Nothing else happens here, because
// a command is an exported handler and the entry point is a thin registry
// over those handlers (issue #216's decision comment). Everything below is
// what a spawned process has left to cover.
//
// This file ships. It imports nothing outside the plugin.

import { parseArgs } from '../lib/args.ts'
import { EXIT_CODES, type ExitCode, exitCodeFor, failure, renderEnvelope } from '../lib/envelope.ts'
import type { CommandResult, Io } from './command.ts'
import { COMMANDS, commandNames } from './registry.ts'

export const USAGE = 'usage: gh-security <command> [args]'

/** The command list, one line each, as `--help` and a bare invocation print it. */
export const helpText = (): string => {
  const entries = Object.entries(COMMANDS)
  const width = Math.max(...entries.map(([name]) => name.length))
  const lines = entries.map(([name, entry]) => `  ${name.padEnd(width)}  ${entry.description}`)
  return [USAGE, '', 'Commands:', ...lines].join('\n')
}

/** What the process writes and exits with. */
interface Rendered {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: ExitCode
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
 * Run one invocation and answer with the process exit code. ADR 001's four
 * exit codes come from the envelope the handler returned, through
 * `exitCodeFor`, so a verb that is not implemented stays exit 2 and an
 * unsupported toolchain stays exit 3 rather than collapsing into a generic
 * failure.
 */
export const runCli = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: Io,
): ExitCode => {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'help') {
    return emit(io, { stdout: helpText(), stderr: '', exitCode: EXIT_CODES.ok })
  }
  const entry = COMMANDS[parsed.command]
  if (entry === undefined) {
    const envelope = failure(
      `unknown command "${parsed.command}". Run gh-security --help for the list of commands.`,
    )
    // A dispatch failure is not a command's result, so the JSON goes to
    // stderr and stdout stays empty: a caller reading stdout as this CLI's
    // contract must never read "there is no such command" as a payload.
    return emit(io, {
      stdout: '',
      stderr: renderEnvelope(envelope).stdout,
      exitCode: exitCodeFor(envelope),
    })
  }
  const result: CommandResult = entry.handler({
    args: parsed.args,
    env,
    io,
    commandNames,
  })
  if (result === undefined) return EXIT_CODES.ok
  return emit(io, renderEnvelope(result))
}
