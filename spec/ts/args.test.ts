// CLI argument parsing (#224). The seam is the exported function, and every
// expected value below is hand-written from the contract on that issue: no
// arguments and either help flag ask for the command list, and everything
// after the command name belongs to the command.
import { describe, expect, it } from 'vitest'

import { HELP_FLAGS, parseArgs } from '../../plugins/gh-security/src/lib/args.ts'

describe('parseArgs', () => {
  it('states the flags that ask for the command list', () => {
    expect(HELP_FLAGS).toEqual(['--help', '-h'])
  })

  it.each([[[]], [['--help']], [['-h']], [['--help', 'version']]])(
    'reads %j as a request for the command list',
    (argv) => {
      expect(parseArgs(argv)).toEqual({ kind: 'help' })
    },
  )

  it('reads the first token as the command and the rest as its arguments', () => {
    expect(parseArgs(['version', '--repo', 'octo/app'])).toEqual({
      kind: 'command',
      command: 'version',
      args: ['--repo', 'octo/app'],
    })
  })

  it("leaves a command's own --help to that command", () => {
    // Intercepting it here would make a per-command usage message
    // unreachable: the entry point would answer for every command before the
    // command saw the flag.
    expect(parseArgs(['version', '--help'])).toEqual({
      kind: 'command',
      command: 'version',
      args: ['--help'],
    })
  })
})
