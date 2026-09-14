// The CLI's dispatch (#224): parse, look up, render, exit. The seam is the
// exported `runCli`, called with a substituted io, which is the process
// boundary this plugin never reaches past. The registry is the real one: it
// is a collaborator this code owns, not a boundary (the testing skill's
// mocking.md).
//
// Expected values are hand-written from the contract on #224: the usage
// line, one line per command, the error envelope on stderr with stdout left
// empty, and ADR 001's exit codes.
import { describe, expect, it } from 'vitest'

import type { Io } from '../../plugins/gh-security/src/cli/command.ts'
import { COMMANDS, commandNames } from '../../plugins/gh-security/src/cli/registry.ts'
import { helpText, runCli, USAGE } from '../../plugins/gh-security/src/cli/run.ts'

const capturing = (stdin = '') => {
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    stdout: (text) => {
      out.push(text)
    },
    stderr: (text) => {
      err.push(text)
    },
    readStdin: () => stdin,
  }
  return { io, written: () => ({ stdout: out.join(''), stderr: err.join('') }) }
}

describe('helpText', () => {
  it('opens with the usage line and lists every registered command once', () => {
    const lines = helpText().split('\n')
    expect(lines[0]).toBe(USAGE)
    expect(lines.slice(3)).toEqual(
      commandNames.map((name) => expect.stringContaining(name) as unknown as string),
    )
    for (const name of commandNames) {
      expect(helpText()).toContain(COMMANDS[name]?.description)
    }
  })
})

describe('runCli', () => {
  it.each([[['--help']], [['-h']], [[]]])('prints the command list for %j and exits 0', (argv) => {
    const { io, written } = capturing()
    expect(runCli(argv, {}, io)).toBe(0)
    const { stdout, stderr } = written()
    expect(stdout).toBe(`${helpText()}\n`)
    expect(stderr).toBe('')
  })

  it('reports an unknown command as an error envelope on stderr, with stdout empty', () => {
    // stdout is this CLI's JSON contract. A dispatch failure written there
    // would be read by a caller as a command's payload.
    const { io, written } = capturing()
    expect(runCli(['drop-everything'], {}, io)).toBe(1)
    const { stdout, stderr } = written()
    expect(stdout).toBe('')
    expect(JSON.parse(stderr)).toEqual({
      error: 'unknown command "drop-everything". Run gh-security --help for the list of commands.',
    })
  })

  it("renders a command's envelope as JSON on stdout and exits with its code", () => {
    const { io, written } = capturing()
    expect(runCli(['version'], {}, io)).toBe(0)
    const { stdout, stderr } = written()
    expect(JSON.parse(stdout)).toEqual({ version: expect.any(String) })
    expect({ stderr, newline: stdout.endsWith('\n') }).toEqual({ stderr: '', newline: true })
  })

  it('writes nothing at all for a command that answers with silence', () => {
    // The allow hook's no-decision answer. Exit 0 with an empty stdout is
    // what leaves the normal permission prompt standing.
    const { io, written } = capturing('not json')
    expect(runCli(['allow-own-commands'], {}, io)).toBe(0)
    expect(written()).toEqual({ stdout: '', stderr: '' })
  })
})
