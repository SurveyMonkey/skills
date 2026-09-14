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
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `url`.

import { fileURLToPath } from 'node:url'

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
 * This plugin's own entry point, resolved from where this module is
 * installed rather than from anything a caller supplies.
 *
 * Ruling A on #224 anchors the comparison on `CLAUDE_PLUGIN_ROOT`, and the
 * requirement it was written for is that the root never comes from the
 * command being judged. The installed location satisfies that requirement
 * and depends on nothing undocumented: the hooks reference documents
 * `${CLAUDE_PLUGIN_ROOT}` only as a placeholder expanded inside a hook's
 * `command` string, and never states that the variable reaches the hook
 * process's environment. Reading it there would make this hook silently
 * inert wherever it is absent, which is the failure that is hardest to
 * notice: a hook that never decides looks exactly like a hook that is
 * working.
 *
 * This module sits at `<plugin root>/src/commands/`, so the root is two
 * directories up and the entry point is {@link ENTRY_PATH} below it.
 */
export const ENTRY = fileURLToPath(new URL(`../..${ENTRY_PATH}`, import.meta.url))

/**
 * Any character an argument may not contain, as the complement of the set it
 * may. The set is stated as what is allowed rather than as a list of
 * metacharacters to reject, because a reject-list is only ever as complete
 * as the person who wrote it: letters, digits, and the nine punctuation
 * characters a version, a path, a package name, a flag or a `key=value` pair
 * needs (`. _ : / @ = + , -`). Every shell metacharacter is outside it, the
 * space included, so a token carrying one is rejected rather than re-split.
 *
 * Written as a negated class tested for absence rather than as an anchored
 * positive match, because the two are the same rule read in opposite
 * directions and only one of them states it: a negated class says outright
 * that any character not listed is refused, while an anchored `/^...+$/` says
 * it only by implication and has to be re-derived every time a reader asks
 * whether some particular character gets through. The spec checks the answer
 * one metacharacter at a time rather than taking either spelling's word for
 * it.
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
 * The decision, as a pure function of the hook input, the entry point being
 * defended and the registered command names.
 *
 * `entry` is an absolute path the caller resolved from its own installed
 * location ({@link ENTRY}), never a root read out of the command being
 * judged: a command that chose what it is compared against would be no
 * comparison at all.
 */
export const allowOwnCommands = (
  input: unknown,
  entry: string,
  commandNames: readonly string[],
): AllowDecision | undefined => {
  const command = bashCommandOf(input)
  if (command === undefined) return undefined
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
    ENTRY,
    context.commandNames,
  )
  return decision === undefined ? undefined : ok(decision)
}
