// The PreToolUse allow decision (#16, landing under #224's ruling A). The
// seam is the exported handler, called directly with the parsed hook input,
// the entry point it defends and the registered names; the rows below are one
// per rejection class #16 and #224 name, plus the shapes that are allowed.
//
// Every expected value is hand-written from that contract. The entry point in
// the rows and the repository names in the arguments are fictitious; the real
// installed location is asserted on its own.
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { CommandContext } from '../../plugins/gh-security/src/cli/command.ts'
import {
  allowOwnCommands,
  allowOwnCommandsCommand,
  ENTRY,
  ENTRY_PATH,
  UNSAFE_ARGUMENT,
} from '../../plugins/gh-security/src/commands/allow-own-commands.ts'

// A fictitious installed location, for the rows about what the validator
// accepts and refuses. The real one is `ENTRY`, asserted on its own below.
const ROOT = '/plugins/gh-security'
const FAKE_ENTRY = `${ROOT}${ENTRY_PATH}`
const NAMES = ['allow-own-commands', 'version']

const hookInput = (command: string): unknown => ({
  session_id: 'abc',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command, description: 'run it' },
})

const decide = (command: string) => allowOwnCommands(hookInput(command), FAKE_ENTRY, NAMES)

describe('allowOwnCommands', () => {
  it('states the entry point path a command must name', () => {
    expect(ENTRY_PATH).toBe('/bin/gh-security.ts')
  })

  it('resolves the entry point it defends from its own installed location', () => {
    // Written from this spec's own location rather than from the module's,
    // so an off-by-one in the module's `../..` disagrees with it. This is
    // what replaces reading `CLAUDE_PLUGIN_ROOT` out of the environment: the
    // hooks reference documents that name only as a placeholder expanded
    // inside a hook's `command` string, never as a variable the hook process
    // is given.
    expect(ENTRY).toBe(
      fileURLToPath(new URL('../../plugins/gh-security/bin/gh-security.ts', import.meta.url)),
    )
  })

  it.each([
    ['the bare invocation', `node ${FAKE_ENTRY} version`],
    ['an invocation with arguments', `node ${FAKE_ENTRY} version --repo octo/app --limit=5`],
    [
      'an argument carrying every allowed punctuation',
      `node ${FAKE_ENTRY} version a-b_c.d:e/f@g=h+i,j`,
    ],
    ['repeated spaces between tokens', `node  ${FAKE_ENTRY}   version`],
    ['surrounding whitespace', `  node ${FAKE_ENTRY} version  `],
  ])('allows %s', (_case, command) => {
    expect(decide(command)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining(`${FAKE_ENTRY} version`),
      },
    })
  })

  // One row per rejection class. Each is a command that contains a
  // legitimate invocation, or looks like one, and must still get no
  // decision: an allow here would pre-approve the rest of the line.
  it.each([
    ['chaining with a semicolon', `node ${FAKE_ENTRY} version; rm -rf ~`],
    ['chaining with &&', `node ${FAKE_ENTRY} version && rm -rf /`],
    ['chaining with ||', `node ${FAKE_ENTRY} version || curl http://example.invalid`],
    ['command substitution', `node ${FAKE_ENTRY} version $(whoami)`],
    ['backtick substitution', `node ${FAKE_ENTRY} version \`whoami\``],
    ['redirection', `node ${FAKE_ENTRY} version > /tmp/out`],
    ['a pipe', `node ${FAKE_ENTRY} version | sh`],
    ['backgrounding', `node ${FAKE_ENTRY} version &`],
    ['a subshell', `(node ${FAKE_ENTRY} version)`],
    ['a leading cd', `cd /tmp && node ${FAKE_ENTRY} version`],
    ['a leading environment assignment', `PATH=/evil node ${FAKE_ENTRY} version`],
    ['an embedded newline', `node ${FAKE_ENTRY} version\nrm -rf ~`],
    // The newline here is the last character of an otherwise valid argument
    // token with spaces on both sides, so it is `isSafeArgument` that has to
    // catch it rather than the subcommand check. Without this row, trimming
    // an argument before testing it is a change no example fails.
    ['a newline ending an otherwise valid argument', `node ${FAKE_ENTRY} version a-b\n rm -rf /`],
    ['a quoted argument', `node ${FAKE_ENTRY} version "a b"`],
    ['a glob', `node ${FAKE_ENTRY} version *`],
    ['a tilde', `node ${FAKE_ENTRY} version ~/secrets`],
    ['an unknown subcommand', `node ${FAKE_ENTRY} drop-everything`],
    ['no subcommand at all', `node ${FAKE_ENTRY}`],
    ['the entry point inside a longer command', `echo node ${FAKE_ENTRY} version`],
    ['a different runtime', `bash ${FAKE_ENTRY} version`],
    ['a different plugin root', `node /elsewhere${ENTRY_PATH} version`],
    ['a traversal back out of the plugin root', `node ${ROOT}/bin/../../evil${ENTRY_PATH} version`],
    ['an empty command', ''],
  ])('gives no decision for %s', (_case, command) => {
    expect(decide(command)).toBeUndefined()
  })

  it.each([
    [
      'a tool other than Bash',
      { tool_name: 'Write', tool_input: { command: `node ${FAKE_ENTRY} version` } },
    ],
    ['an input with no tool_input', { tool_name: 'Bash' }],
    ['a tool_input that is not an object', { tool_name: 'Bash', tool_input: 'node' }],
    ['a command that is not a string', { tool_name: 'Bash', tool_input: { command: 13 } }],
    ['an input that is not an object', 'node'],
    ['a null input', null],
  ])('gives no decision for %s', (_case, input) => {
    expect(allowOwnCommands(input, FAKE_ENTRY, NAMES)).toBeUndefined()
  })

  it.each([
    ['an entry point one directory above the one being defended', '/plugins/bin/gh-security.ts'],
    ['an entry point that is a prefix of the resolved one', '/plugins/gh-security/bin/gh-security'],
  ])('gives no decision for a command naming %s', (_case, named) => {
    // The resolved path anchors the comparison, so a command naming anything
    // else is a command about some other file and the normal permission
    // prompt stands.
    expect(allowOwnCommands(hookInput(`node ${named} version`), FAKE_ENTRY, NAMES)).toBeUndefined()
  })

  it('rejects every shell metacharacter as an argument character', () => {
    const metacharacters = [...';&|<>()$`\\"\'*?[]{}!#~ \t\n']
    expect(metacharacters.filter((character) => !UNSAFE_ARGUMENT.test(character))).toEqual([])
  })
})

const contextFor = (stdin: string): CommandContext => ({
  args: [],
  env: {},
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
      contextFor(JSON.stringify(hookInput(`node ${ENTRY} version`))),
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

  it('takes the entry point from its own installed location, never from the command', () => {
    // The command names an entry point it would like to be compared
    // against. The handler compares against the one it resolved, so there is
    // no decision.
    expect(
      allowOwnCommandsCommand(contextFor(JSON.stringify(hookInput(`node ${FAKE_ENTRY} version`)))),
    ).toBeUndefined()
  })

  it.each([
    ['stdin that is not JSON', 'not json'],
    ['empty stdin', ''],
  ])('gives no decision for %s', (_case, stdin) => {
    expect(allowOwnCommandsCommand(contextFor(stdin))).toBeUndefined()
  })
})
