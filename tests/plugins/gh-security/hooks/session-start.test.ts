// The SessionStart hook entry file, `hooks/session-start.ts`. One example
// spawns it as Claude Code does, with a real process and a PATH built from
// symlinks, so the contract is checked on real bytes. The remaining examples
// import the file in this process, so that its own branches are measured.
// Every expected value is written by hand from `.claude/rules/path-hooks.md`.
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '#gh-security/lib/process-runner.ts'
import { GH_SECURITY_ROOT } from '#harness/paths.ts'

const ENTRY = join(GH_SECURITY_ROOT, 'hooks', 'session-start.ts')
const TOOLS = ['git', 'gh', 'bash', 'jq'] as const

const problem = (text: string): string =>
  `\u001b[33m\u001b[1mgh-security:\u001b[22m ⚠️ ${text}\u001b[0m`

/** The first real file for `tool` on this machine's PATH. */
const locate = (tool: string): string => {
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((directory) => directory !== '')
    .map((directory) => join(directory, tool))
    .find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error(`${tool} is needed on PATH to run this suite`)
  return found
}

const directories: string[] = []
const pathWith = (tools: readonly string[]): string => {
  const directory = mkdtempSync(join(tmpdir(), 'gh-security-hook-'))
  directories.push(directory)
  for (const tool of tools) symlinkSync(locate(tool), join(directory, tool))
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('#gh-security/cli/run.ts')
})

describe('the hook as a process', () => {
  const hook = (PATH: string) => run({ command: process.execPath, args: [ENTRY], env: { PATH } })

  it('writes nothing and exits 0 when every tool is present', () => {
    expect(hook(pathWith(TOOLS))).toEqual({
      command: process.execPath,
      args: [ENTRY],
      status: 0,
      stdout: '',
      stderr: '',
    })
  })

  it('writes one JSON object that names jq when jq is hidden, and exits 0', () => {
    const result = hook(pathWith(['git', 'gh', 'bash']))
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(result.stdout.endsWith('}\n')).toBe(true)
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: `\n${problem('jq is missing')}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Missing: jq. The gh-security plugin cannot run.',
      },
    })
  })
})

describe('the hook in this process', () => {
  const capture = () => {
    const out: string[] = []
    const err: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk))
      return true
    })
    return { out, err }
  }

  const load = async (settings: { version?: string; path?: string }) => {
    const version = process.version
    const path = process.env.PATH
    if (settings.version !== undefined) {
      Object.defineProperty(process, 'version', { value: settings.version, configurable: true })
    }
    if (settings.path !== undefined) process.env.PATH = settings.path
    process.exitCode = 7
    try {
      await import(`${ENTRY}?${Math.random()}`)
      return process.exitCode
    } finally {
      Object.defineProperty(process, 'version', { value: version, configurable: true })
      process.env.PATH = path
      process.exitCode = 0
    }
  }

  it.each([
    ['below the floor', 'v22.17.0'],
    ['not a release', 'garbage'],
  ])(
    'writes one plain systemMessage line and exits 0 when the version is %s',
    async (_c, version) => {
      const { out, err } = capture()
      const exitCode = await load({ version })
      expect({ exitCode, err }).toEqual({ exitCode: 0, err: [] })
      expect(out).toEqual([
        `${JSON.stringify({
          systemMessage: `\ngh-security: ⚠️ node "${version}" is below the floor: 22.18.0 or newer.`,
        })}\n`,
      ])
    },
  )

  it('runs the check when the version meets the floor', async () => {
    const { out, err } = capture()
    const exitCode = await load({ path: pathWith(['git', 'gh', 'bash']) })
    expect({ exitCode, err }).toEqual({ exitCode: 0, err: [] })
    expect(JSON.parse(out.join('')).systemMessage).toBe(`\n${problem('jq is missing')}`)
  })

  it('passes on the exit code that the CLI returns', async () => {
    vi.doMock('#gh-security/cli/run.ts', () => ({ runCli: () => Promise.resolve(3) }))
    const { out, err } = capture()
    const exitCode = await load({})
    expect({ exitCode, out, err }).toEqual({ exitCode: 3, out: [], err: [] })
  })

  it.each([
    [
      'an error with a stack',
      Object.assign(new Error('boom'), { stack: 'STACK boom' }),
      'STACK boom\n',
    ],
    ['an error with no stack', Object.assign(new Error('boom'), { stack: undefined }), 'boom\n'],
    ['a value that is not an error', 'plain text', 'plain text\n'],
  ])('writes %s to stderr, nothing to stdout, and exits 0', async (_c, thrown, written) => {
    vi.doMock('#gh-security/cli/run.ts', () => ({
      runCli: () => Promise.reject(thrown),
    }))
    const { out, err } = capture()
    const exitCode = await load({})
    expect({ exitCode, out, err }).toEqual({ exitCode: 0, out: [], err: [written] })
  })
})
