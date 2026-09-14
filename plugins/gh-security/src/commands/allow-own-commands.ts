// The PreToolUse allow decision for this plugin's own CLI
// ([#16](https://github.com/SurveyMonkey/skills/issues/16), landing as a
// subcommand under #224's ruling A). Skill `allowed-tools` pre-approval does
// not reach plugin skills yet, so without this hook every invocation of this
// plugin's own entry point prompts.
//
// **The decision is an allow, never a deny.** An allow does not override a
// user's own deny or ask rule, and this hook adds no way to block anything:
// a command it does not recognise gets no decision at all, which leaves the
// normal permission flow exactly as it was.
//
// **Validation is of the whole command, never a substring.** The hazard #16
// names is `gh-security.ts ...; rm -rf ~`, which contains a legitimate
// invocation and must not be allowed. So the command is split into tokens
// and every token is checked: the runtime is `node` and nothing else, the
// second token equals this plugin's entry point exactly, the third is a
// registered subcommand, and every remaining token is drawn from one
// explicit character set that contains no shell metacharacter. Anything else
// returns nothing.
//
// This file ships. It imports nothing outside the plugin, and stays inside
// the erasable subset.

import type { CommandContext, CommandResult } from '../cli/command.ts'
import { ok } from '../lib/envelope.ts'

/** The hook output a `PreToolUse` hook writes to allow a tool call. */
export type AllowDecision = {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse'
    readonly permissionDecision: 'allow'
    readonly permissionDecisionReason: string
  }
}

/** The entry point's path below the plugin root, which is what a command must name. */
export const ENTRY_PATH = '/bin/gh-security.ts'

/**
 * Any character an argument may not contain, as the complement of the set it
 * may. The set is stated as what is allowed rather than as a list of
 * metacharacters to reject, because a reject-list is only ever as complete
 * as the person who wrote it: letters, digits, and the eleven punctuation
 * characters a version, a path, a package name, a flag or a `key=value` pair
 * needs. Every shell metacharacter is outside it, the space included, so a
 * token carrying one is rejected rather than re-split.
 *
 * Written as a negated class tested for absence rather than as an anchored
 * positive match, because `$` in a JavaScript regular expression also
 * matches before a trailing newline: `/^[a-z]+$/.test('rm\n')` is true, and
 * a newline is the one metacharacter this hook can least afford to admit.
 */
export const UNSAFE_ARGUMENT = /[^A-Za-z0-9._:/@=+,-]/

const isSafeArgument = (argument: string): boolean => !UNSAFE_ARGUMENT.test(argument)

/** The Bash command a hook input carries, or nothing when it carries none. */
const bashCommandOf = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null) return undefined
  const { tool_name: toolName, tool_input: toolInput } = input as {
    tool_name?: unknown
    tool_input?: unknown
  }
  if (toolName !== 'Bash') return undefined
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const { command } = toolInput as { command?: unknown }
  return typeof command === 'string' ? command : undefined
}

const reason = (entry: string, command: string): string =>
  `${entry} ${command} is gh-security's own CLI entry point, invoked with a registered ` +
  'subcommand and arguments carrying no shell metacharacters.'

/**
 * The decision, as a pure function of the hook input, the plugin root and the
 * registered command names.
 *
 * `pluginRoot` comes from the hook's environment (`CLAUDE_PLUGIN_ROOT`) and
 * never from the command being judged: a root read out of the command text
 * would let the command choose what it is compared against, which is no
 * comparison at all.
 */
export const allowOwnCommands = (
  input: unknown,
  pluginRoot: string | undefined,
  commandNames: readonly string[],
): AllowDecision | undefined => {
  if (pluginRoot === undefined || pluginRoot === '') return undefined
  const command = bashCommandOf(input)
  if (command === undefined) return undefined
  // A trailing slash on the root is the one spelling difference that says
  // nothing about the command, so it is normalised away before comparison.
  const entry = `${pluginRoot.replace(/\/+$/, '')}${ENTRY_PATH}`
  const [runtime, named, subcommand, ...args] = command.trim().split(/ +/)
  if (runtime !== 'node') return undefined
  if (named !== entry) return undefined
  if (subcommand === undefined || !commandNames.includes(subcommand)) return undefined
  if (!args.every(isSafeArgument)) return undefined
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason(entry, subcommand),
    },
  }
}

/** The hook input, or nothing when stdin did not carry JSON at all. */
const parseHookInput = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The subcommand: read the hook input from stdin, and answer with the
 * decision or with silence. Silence is exit 0 with nothing written, which is
 * what leaves the normal permission prompt standing.
 */
export const allowOwnCommandsCommand = (context: CommandContext): CommandResult => {
  const decision = allowOwnCommands(
    parseHookInput(context.io.readStdin()),
    context.env.CLAUDE_PLUGIN_ROOT,
    context.commandNames,
  )
  return decision === undefined ? undefined : ok(decision)
}
