// The CLI's dispatch (#224): parse, look up, render, exit. The seam is the
// exported `runCli`, called with a substituted io, which is the process
// boundary this plugin never reaches past. The registry is the real one: it
// is a collaborator this code owns, not a boundary (the testing skill's
// mocking.md).
//
// Expected values are hand-written from the contract on #224: the usage
// line, one line per command, the error envelope on stderr with stdout left
// empty, and ADR 001's exit codes.
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type CommandContext,
  type CommandEntry,
  failedReport,
  type Io,
} from '#gh-security/cli/command.ts'
import { COMMANDS, commandNames } from '#gh-security/cli/registry.ts'
import { helpText, runCli, USAGE } from '#gh-security/cli/run.ts'

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
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([[['--help']], [['-h']], [[]]])(
    'prints the command list for %j and exits 0',
    async (argv) => {
      const { io, written } = capturing()
      expect(await runCli(argv, {}, io)).toBe(0)
      const { stdout, stderr } = written()
      expect(stdout).toBe(`${helpText()}\n`)
      expect(stderr).toBe('')
    },
  )

  it('inspects only the first token, so a help flag after it is not a help request', async () => {
    // A command's own flags belong to that command. Intercepting a later
    // `--help` would make a per-command usage message unreachable.
    const { io, written } = capturing()
    expect(await runCli(['version', '--help'], {}, io)).toBe(0)
    expect(JSON.parse(written().stdout)).toEqual({ version: expect.any(String) })
  })

  it('hands every token after the command to the command as its arguments', async () => {
    // Substituting the handler is the only way to see the arguments: no
    // registered command reads them yet.
    const seen: CommandContext[] = []
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockResolvedValue((context) => {
      seen.push(context)
      return undefined
    })
    const { io } = capturing()
    expect(await runCli(['version', '--repo', 'octo/app'], {}, io)).toBe(0)
    expect(seen.map((context) => context.args)).toEqual([['--repo', 'octo/app']])
  })

  it('reads a first token that starts with a dash, but is no help flag, as a command name', async () => {
    const { io, written } = capturing()
    expect(await runCli(['--nope'], {}, io)).toBe(1)
    expect(JSON.parse(written().stderr)).toEqual({
      error: 'unknown command "--nope". Run gh-security --help for the list of commands.',
    })
  })

  it('reads a help flag in the first place as a help request, whatever follows', async () => {
    const { io, written } = capturing()
    expect(await runCli(['--help', 'version'], {}, io)).toBe(0)
    expect(written().stdout).toBe(`${helpText()}\n`)
  })

  it('reports an unknown command as an error envelope on stderr, with stdout empty', async () => {
    // stdout is this CLI's JSON contract. A dispatch failure written there
    // would be read by a caller as a command's payload.
    const { io, written } = capturing()
    expect(await runCli(['drop-everything'], {}, io)).toBe(1)
    const { stdout, stderr } = written()
    expect(stdout).toBe('')
    expect(JSON.parse(stderr)).toEqual({
      error: 'unknown command "drop-everything". Run gh-security --help for the list of commands.',
    })
  })

  it.each([['toString'], ['constructor'], ['__proto__'], ['hasOwnProperty']])(
    'refuses %s, an Object.prototype key rather than a registered command',
    async (name) => {
      const { io, written } = capturing()
      expect(await runCli([name], {}, io)).toBe(1)
      const { stdout, stderr } = written()
      expect(stdout).toBe('')
      expect(JSON.parse(stderr)).toEqual({
        error: `unknown command "${name}". Run gh-security --help for the list of commands.`,
      })
    },
  )

  it("renders a command's envelope as JSON on stdout and exits with its code", async () => {
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(0)
    const { stdout, stderr } = written()
    expect(JSON.parse(stdout)).toEqual({ version: expect.any(String) })
    expect({ stderr, newline: stdout.endsWith('\n') }).toEqual({ stderr: '', newline: true })
  })

  it('writes nothing at all for a command that answers with silence', async () => {
    // The allow hook's no-decision answer. Exit 0 with an empty stdout is
    // what leaves the normal permission prompt standing.
    const { io, written } = capturing('not json')
    expect(await runCli(['allow-own-commands'], {}, io)).toBe(0)
    expect(written()).toEqual({ stdout: '', stderr: '' })
  })

  it('waits for a handler that answers with a promise, and renders that answer', async () => {
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockResolvedValue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { outcome: 'ok', value: { waited: true } }
    })
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(0)
    expect(written()).toEqual({ stdout: '{"waited":true}\n', stderr: '' })
  })

  it('waits for a promise that resolves to silence, and writes nothing', async () => {
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockResolvedValue(async () => undefined)
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(0)
    expect(written()).toEqual({ stdout: '', stderr: '' })
  })

  it('writes the report on stdout, and the message on stderr, for a failure that carries a report', async () => {
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockResolvedValue(async () =>
      failedReport('1 of 2 could not be read', { prs: [{ url: 'u', error: 'e' }] }),
    )
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(1)
    expect(written()).toEqual({
      stdout: '{"prs":[{"url":"u","error":"e"}]}\n',
      stderr: '1 of 2 could not be read\n',
    })
  })

  it('still renders a plain failure as the error envelope on stdout and stderr', async () => {
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockResolvedValue(async () => ({
      outcome: 'failed',
      error: 'no',
    }))
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(1)
    expect(written()).toEqual({ stdout: '{"error":"no"}\n', stderr: 'no\n' })
  })

  // #302 item 1. A throw is a defect in the command, and the caller reads
  // stdout as the contract: it gets the ADR 001 failed envelope, exit 1.
  it.fails('renders a handler that throws as the failed envelope, with exit 1', async () => {
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockResolvedValue(async () => {
      throw new Error('boom')
    })
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(1)
    expect(written()).toEqual({
      stdout: '{"error":"version: boom"}\n',
      stderr: 'version: boom\n',
    })
  })

  it.fails('renders a handler that rejects with a non-Error as its text', async () => {
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockResolvedValue(async () =>
      Promise.reject('plain text'),
    )
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(1)
    expect(written()).toEqual({
      stdout: '{"error":"version: plain text"}\n',
      stderr: 'version: plain text\n',
    })
  })

  it.fails('renders a load that throws as the failed envelope too', async () => {
    vi.spyOn(COMMANDS.version as CommandEntry, 'load').mockRejectedValue(new Error('no module'))
    const { io, written } = capturing()
    expect(await runCli(['version'], {}, io)).toBe(1)
    expect(written()).toEqual({
      stdout: '{"error":"version: no module"}\n',
      stderr: 'version: no module\n',
    })
  })

  it('loads pr-status through the registry, and renders its report with exit 1', async () => {
    const { io, written } = capturing()
    expect(await runCli(['pr-status', 'not-a-url'], {}, io)).toBe(1)
    expect(written()).toEqual({
      stdout: '{"prs":[{"url":"not-a-url","error":"not a GitHub pull request URL"}]}\n',
      stderr: '1 of 1 pull request URLs could not be read\n',
    })
  })

  it('loads ensure-worktree-exclude through the registry, and renders its refusal', async () => {
    const gone = join(tmpdir(), 'gh-security-run-test-no-such-directory')
    const { io, written } = capturing()
    expect(await runCli(['ensure-worktree-exclude', gone], {}, io)).toBe(1)
    expect(written()).toEqual({
      stdout: `{"error":"repo_root does not exist: ${gone}"}\n`,
      stderr: `repo_root does not exist: ${gone}\n`,
    })
  })
})
