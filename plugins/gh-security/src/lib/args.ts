// Argument parsing for the CLI entry point (#224). Written once here rather
// than in `bin/gh-security.ts`, because the entry point stays thin enough
// that a spawned process has only its own behavior left to cover (issue
// #216's decision comment) and because a parse is a function with a return
// value, which is testable without a process.
//
// This file ships. It imports nothing outside the plugin, and stays inside
// the erasable subset (no `enum`, no parameter properties, no namespaces).

/**
 * The flags that ask for the command list. A bare invocation asks for the
 * same thing: a CLI that did nothing at all when run with no arguments would
 * leave a reader with no way to find out what it does.
 */
export const HELP_FLAGS: readonly string[] = ['--help', '-h']

/**
 * What the entry point was asked to do. A discriminated union rather than a
 * record with an optional command: "no command was named" and "this command
 * was named" are different requests, and the compiler is what keeps the
 * second from being read as the first with an empty string.
 */
export type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'command'; readonly command: string; readonly args: readonly string[] }

/**
 * Parse `process.argv.slice(2)`. Only the first token is inspected: a
 * command's own flags belong to that command, so `--help` after a command
 * name is passed through as one of its arguments rather than intercepted
 * here.
 */
export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const [command, ...args] = argv
  if (command === undefined || HELP_FLAGS.includes(command)) return { kind: 'help' }
  return { kind: 'command', command, args }
}
