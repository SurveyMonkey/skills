// The PreToolUse allow decision (#16, landing under #224's ruling A). The
// seam is the exported handler, called directly with the parsed hook input,
// the plugin root and the registered names; the rows below are one per
// rejection class #16 and #224 name, plus the shapes that are allowed.
//
// Every expected value is hand-written from that contract. The plugin root
// and the repository names in the arguments are fictitious.
import { describe, expect, it } from 'vitest'

import type { CommandContext } from '../../plugins/gh-security/src/cli/command.ts'
import {
  allowOwnCommands,
  allowOwnCommandsCommand,
  ENTRY_PATH,
  UNSAFE_ARGUMENT,
} from '../../plugins/gh-security/src/commands/allow-own-commands.ts'

const ROOT = '/plugins/gh-security'
const ENTRY = `${ROOT}${ENTRY_PATH}`
const NAMES = ['allow-own-commands', 'version']

const hookInput = (command: string): unknown => ({
  session_id: 'abc',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command, description: 'run it' },
})

const decide = (command: string) => allowOwnCommands(hookInput(command), ROOT, NAMES)

describe('allowOwnCommands', () => {
  it('states the entry point path a command must name', () => {
    expect(ENTRY_PATH).toBe('/bin/gh-security.ts')
  })

  it.each([
    ['the bare invocation', `node ${ENTRY} version`],
    ['an invocation with arguments', `node ${ENTRY} version --repo octo/app --limit=5`],
    ['an argument carrying every allowed punctuation', `node ${ENTRY} version a-b_c.d:e/f@g=h+i,j`],
    ['repeated spaces between tokens', `node  ${ENTRY}   version`],
    ['surrounding whitespace', `  node ${ENTRY} version  `],
  ])('allows %s', (_case, command) => {
    expect(decide(command)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining(`${ENTRY} version`),
      },
    })
  })

  it('normalises a trailing slash on the plugin root', () => {
    expect(
      allowOwnCommands(hookInput(`node ${ENTRY} version`), `${ROOT}/`, NAMES),
    ).not.toBeUndefined()
  })

  // One row per rejection class. Each is a command that contains a
  // legitimate invocation, or looks like one, and must still get no
  // decision: an allow here would pre-approve the rest of the line.
  it.each([
    ['chaining with a semicolon', `node ${ENTRY} version; rm -rf ~`],
    ['chaining with &&', `node ${ENTRY} version && rm -rf /`],
    ['chaining with ||', `node ${ENTRY} version || curl http://example.invalid`],
    ['command substitution', `node ${ENTRY} version $(whoami)`],
    ['backtick substitution', `node ${ENTRY} version \`whoami\``],
    ['redirection', `node ${ENTRY} version > /tmp/out`],
    ['a pipe', `node ${ENTRY} version | sh`],
    ['backgrounding', `node ${ENTRY} version &`],
    ['a subshell', `(node ${ENTRY} version)`],
    ['a leading cd', `cd /tmp && node ${ENTRY} version`],
    ['a leading environment assignment', `PATH=/evil node ${ENTRY} version`],
    ['an embedded newline', `node ${ENTRY} version\nrm -rf ~`],
    ['a quoted argument', `node ${ENTRY} version "a b"`],
    ['a glob', `node ${ENTRY} version *`],
    ['a tilde', `node ${ENTRY} version ~/secrets`],
    ['an unknown subcommand', `node ${ENTRY} drop-everything`],
    ['no subcommand at all', `node ${ENTRY}`],
    ['the entry point inside a longer command', `echo node ${ENTRY} version`],
    ['a different runtime', `bash ${ENTRY} version`],
    ['a different plugin root', `node /elsewhere${ENTRY_PATH} version`],
    ['a traversal back out of the plugin root', `node ${ROOT}/bin/../../evil${ENTRY_PATH} version`],
    ['an empty command', ''],
  ])('gives no decision for %s', (_case, command) => {
    expect(decide(command)).toBeUndefined()
  })

  it.each([
    [
      'a tool other than Bash',
      { tool_name: 'Write', tool_input: { command: `node ${ENTRY} version` } },
    ],
    ['an input with no tool_input', { tool_name: 'Bash' }],
    ['a tool_input that is not an object', { tool_name: 'Bash', tool_input: 'node' }],
    ['a command that is not a string', { tool_name: 'Bash', tool_input: { command: 13 } }],
    ['an input that is not an object', 'node'],
    ['a null input', null],
  ])('gives no decision for %s', (_case, input) => {
    expect(allowOwnCommands(input, ROOT, NAMES)).toBeUndefined()
  })

  it.each([
    ['the plugin root is absent from the environment', undefined],
    ['the plugin root is empty', ''],
  ])('gives no decision when %s', (_case, root) => {
    // The root anchors the comparison, so without one there is nothing to
    // compare against and the normal permission prompt stands.
    expect(allowOwnCommands(hookInput(`node ${ENTRY} version`), root, NAMES)).toBeUndefined()
  })

  it('rejects every shell metacharacter as an argument character', () => {
    const metacharacters = [...';&|<>()$`\\"\'*?[]{}!#~ \t\n']
    expect(metacharacters.filter((character) => !UNSAFE_ARGUMENT.test(character))).toEqual([])
  })
})

const contextFor = (stdin: string, env: Record<string, string | undefined>): CommandContext => ({
  args: [],
  env,
  io: {
    stdout: () => {
      throw new Error('the allow hook writes through its return value, never through io.stdout')
    },
    stderr: () => {
      throw new Error('the allow hook writes through its return value, never through io.stderr')
    },
    readStdin: () => stdin,
  },
  commandNames: NAMES,
})

describe('the allow-own-commands subcommand', () => {
  it('answers with the decision as the envelope value', () => {
    const result = allowOwnCommandsCommand(
      contextFor(JSON.stringify(hookInput(`node ${ENTRY} version`)), { CLAUDE_PLUGIN_ROOT: ROOT }),
    )
    expect(result).toEqual({
      outcome: 'ok',
      value: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: expect.any(String),
        },
      },
    })
  })

  it('takes the plugin root from the environment, never from the command', () => {
    // The command names a root it would like to be compared against. The
    // environment names none, so there is no decision.
    expect(
      allowOwnCommandsCommand(contextFor(JSON.stringify(hookInput(`node ${ENTRY} version`)), {})),
    ).toBeUndefined()
  })

  it.each([
    ['stdin that is not JSON', 'not json'],
    ['empty stdin', ''],
  ])('gives no decision for %s', (_case, stdin) => {
    expect(allowOwnCommandsCommand(contextFor(stdin, { CLAUDE_PLUGIN_ROOT: ROOT }))).toBeUndefined()
  })
})
