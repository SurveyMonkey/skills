// The CLI entry point (#224, ADR 012). The seam a spawn covers is only what
// the entry itself adds: the Node-floor preamble's placement, the `--help`
// listing, the unknown-command envelope, the stdout and stderr split, and
// the allow hook reading its input on stdin. Everything a command decides is
// covered through that command's export (the testing skill's "Seams", and
// issue #216's decision comment, which this entry point is thin for).
//
// The spawn goes through `run` from `lib/process.ts`, a real child: the
// child process IS the thing under test here, so a substituted spawn would
// assert nothing.
//
// Every expected value below is hand-written from the contract on #224,
// never read back out of the code under test.
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '#gh-security/lib/process.ts'
import { pluginFile } from '#harness/paths.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

const entry = (args: readonly string[], request: { input?: string } = {}) =>
  run(process.execPath, [ENTRY, ...args], { stdin: request.input })

const hookInput = (command: string): string =>
  JSON.stringify({
    session_id: 'abc',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'run it' },
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gh-security --help', () => {
  it.each([[['--help']], [['-h']], [[]]])(
    'lists every registered command on stdout for %j and exits 0',
    async (args) => {
      const result = await entry(args)
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
      expect(result.stdout).toContain('usage: gh-security <command> [args]')
      expect(result.stdout).toContain('allow-own-commands')
      expect(result.stdout).toContain('version')
    },
  )
})

describe('an unknown command', () => {
  it('writes the error envelope to stderr, nothing to stdout, and exits 1', async () => {
    const result = await entry(['drop-everything'])
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 1, stdout: '' })
    expect(JSON.parse(result.stderr)).toEqual({
      error: 'unknown command "drop-everything". Run gh-security --help for the list of commands.',
    })
  })
})

describe("a command's result", () => {
  it('is JSON on stdout with stderr left empty, and ADR 001 exit 0', async () => {
    const result = await entry(['version'])
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({ version: expect.any(String) })
  })
})

describe('a command that throws', () => {
  // #302 item 1. `classify-lines` reads stdin with `readFileSync`, and a
  // directory on fd 0 makes that read throw EISDIR. No command throws on any
  // argument, so the input is the stdin. `run` cannot hand the child a
  // directory, so this spawns the child itself.
  it('writes the failed envelope to stdout, the message to stderr, and exits 1', () => {
    const directory = openSync(tmpdir(), 'r')
    try {
      const result = spawnSync(
        process.execPath,
        [ENTRY, 'classify-lines', '--repo-root', tmpdir()],
        { stdio: [directory, 'pipe', 'pipe'], encoding: 'utf8' },
      )
      expect({ status: result.status, stdout: JSON.parse(result.stdout) }).toEqual({
        status: 1,
        stdout: { error: expect.stringMatching(/^classify-lines: EISDIR/) },
      })
      expect(result.stderr).toMatch(/^classify-lines: EISDIR/)
      expect(result.stderr).not.toContain('    at ')
    } finally {
      closeSync(directory)
    }
  })
})

describe('the allow hook, driven the way Claude Code drives it', () => {
  it('answers an invocation of this entry point with an allow decision', async () => {
    const result = await entry(['allow-own-commands'], {
      input: hookInput(`node ${ENTRY} version`),
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.any(String),
      },
    })
  })

  it('writes nothing at all for a command it does not recognise', async () => {
    // Exit 0 with empty output is "no decision": the normal permission
    // prompt stands, which is what the chained `rm` here must still get.
    const result = await entry(['allow-own-commands'], {
      input: hookInput(`node ${ENTRY} version; rm -rf ~`),
    })
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })
})

describe('the Node-floor preamble', () => {
  // Spawning a node older than the floor is not available here, so what this
  // asserts is the placement the floor depends on: the check runs before any
  // other module of this plugin is loaded. `tests/lib/node-floor.test.ts`
  // covers the check itself.
  const source = readFileSync(ENTRY, 'utf8')
  const statements = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))

  it('is the first import and the first statement in the file', () => {
    expect(statements.slice(0, 2)).toEqual([
      "import { assertNodeFloor } from '../src/lib/node-floor.ts'",
      'assertNodeFloor(process.version)',
    ])
  })

  it('is the only static import, so nothing else loads before it runs', () => {
    // `import` declarations are hoisted: a second one would evaluate its
    // whole module graph before the check could refuse the runtime, which is
    // why the rest of the CLI is reached through `await import`.
    expect(source.match(/^import /gm)).toHaveLength(1)
  })
})

describe('the entry point module', () => {
  it('runs the CLI with the process argv and environment, and sets the exit code', async () => {
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const argv = process.argv
    process.argv = [process.execPath, ENTRY, '--help']
    let exitCode: typeof process.exitCode
    try {
      // Imported rather than spawned so the file's own statements are
      // measured: a subprocess is outside this suite's coverage, and the
      // entry point is in the coverage subject list (ADR 012, #211).
      await import('../../../plugins/gh-security/scripts/gh-security.ts')
      exitCode = process.exitCode
    } finally {
      process.argv = argv
      process.exitCode = 0
    }
    expect({ exitCode, listed: written.join('') }).toEqual({
      exitCode: 0,
      listed: expect.stringContaining('allow-own-commands'),
    })
  })
})
