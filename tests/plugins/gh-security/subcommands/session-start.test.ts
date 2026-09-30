// `gh-security session-start`. The seam is the exported check: it takes the
// table and the edges (environment, version, file test, clock), so each case
// runs with no real PATH. The command itself is run once against a real
// directory of stub tools. Every expected string is written by hand from the
// output contract in `.claude/rules/path-hooks.md`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '#gh-security/cli/command.ts'
import { DEPENDENCIES } from '#gh-security/dependency-table.ts'
import {
  DEADLINE_MS,
  type Edges,
  isExecutableFile,
  sessionStartCommand,
  sessionStartOutput,
} from '#gh-security/subcommands/session-start.ts'
import { pluginFile } from '#harness/paths.ts'

const GH_SECURITY_ROOT = pluginFile('gh-security')

const TABLE = [
  { tool: 'git', label: 'git' },
  { tool: 'jq', label: 'jq' },
] as const

/** A problem line as the CLI receives it: yellow, with the prefix in bold. */
const problem = (text: string): string =>
  `\u001b[33m\u001b[1mgh-security:\u001b[22m ⚠️ ${text}\u001b[0m`

const edges = (overrides: Partial<Edges> = {}): Edges => ({
  env: { PATH: '/bin' },
  version: 'v22.18.0',
  executable: () => true,
  now: () => 0,
  ...overrides,
})

const only =
  (...found: string[]) =>
  (path: string) =>
    found.includes(path)

describe('the dependency table', () => {
  it('lists node, git, gh, bash and jq, in that order, with the text a user reads', () => {
    expect(DEPENDENCIES).toEqual([
      { tool: 'node', label: 'node 22.18.0 or newer' },
      { tool: 'git', label: 'git' },
      { tool: 'gh', label: 'the GitHub CLI (gh)' },
      { tool: 'bash', label: 'bash' },
      { tool: 'jq', label: 'jq' },
    ])
  })
})

describe('sessionStartOutput', () => {
  it('writes nothing when every tool is present', () => {
    expect(sessionStartOutput(DEPENDENCIES, edges(), DEADLINE_MS)).toBe('')
  })

  it.each([
    ['git', 'git'],
    ['gh', 'the GitHub CLI (gh)'],
    ['bash', 'bash'],
    ['jq', 'jq'],
  ])('writes one line that names %s when only it is missing', (tool, label) => {
    const output = sessionStartOutput(
      DEPENDENCIES,
      edges({ executable: (path) => path !== `/bin/${tool}` }),
      DEADLINE_MS,
    )
    expect(output.endsWith('\n')).toBe(true)
    expect(JSON.parse(output)).toEqual({
      systemMessage: `\n${problem(`${label} is missing`)}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Missing: ${label}. The gh-security plugin cannot run.`,
      },
    })
  })

  it('writes one line for each missing tool, in table order', () => {
    const output = sessionStartOutput(
      DEPENDENCIES,
      edges({ executable: only('/bin/gh', '/bin/bash') }),
      DEADLINE_MS,
    )
    expect(JSON.parse(output)).toEqual({
      systemMessage: `\n${problem('git is missing')}\n${problem('jq is missing')}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Missing: git; jq. The gh-security plugin cannot run.',
      },
    })
  })

  it('finds a tool in a later PATH directory, and asks each directory in order', () => {
    const asked: string[] = []
    const output = sessionStartOutput(
      TABLE,
      edges({
        env: { PATH: '/one:/two' },
        executable: (path) => {
          asked.push(path)
          return path === '/two/git' || path === '/two/jq'
        },
      }),
      DEADLINE_MS,
    )
    expect(output).toBe('')
    expect(asked).toEqual(['/one/git', '/two/git', '/one/jq', '/two/jq'])
  })

  it('skips an empty PATH entry, which would name the current directory', () => {
    const asked: string[] = []
    const output = sessionStartOutput(
      [{ tool: 'jq', label: 'jq' }],
      edges({
        env: { PATH: ':/bin' },
        executable: (path) => {
          asked.push(path)
          return path === 'jq'
        },
      }),
      DEADLINE_MS,
    )
    expect(asked).toEqual(['/bin/jq'])
    expect(JSON.parse(output).systemMessage).toBe(`\n${problem('jq is missing')}`)
  })

  it.each([
    ['unset', {}],
    ['empty', { PATH: '' }],
  ])('reports every PATH tool as missing when PATH is %s', (_case, env) => {
    const output = sessionStartOutput(TABLE, edges({ env }), DEADLINE_MS)
    expect(JSON.parse(output).systemMessage).toBe(
      `\n${problem('git is missing')}\n${problem('jq is missing')}`,
    )
  })

  it.each([
    ['below the floor', 'v22.17.9'],
    ['not a release', 'garbage'],
  ])('reports node as missing when the version is %s', (_case, version) => {
    const output = sessionStartOutput(DEPENDENCIES, edges({ version }), DEADLINE_MS)
    expect(JSON.parse(output)).toEqual({
      systemMessage: `\n${problem('node 22.18.0 or newer is missing')}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Missing: node 22.18.0 or newer. The gh-security plugin cannot run.',
      },
    })
  })

  it('does not look node up on PATH', () => {
    const asked: string[] = []
    sessionStartOutput(
      [{ tool: 'node', label: 'node' }],
      edges({
        executable: (path) => {
          asked.push(path)
          return false
        },
      }),
      DEADLINE_MS,
    )
    expect(asked).toEqual([])
  })

  describe('the deadline', () => {
    const clocked = (paths: string, present: readonly string[], step: number) => {
      let time = 0
      const asked: string[] = []
      return {
        asked,
        edges: edges({
          env: { PATH: paths },
          now: () => time,
          executable: (path) => {
            asked.push(path)
            time += step
            return present.includes(path)
          },
        }),
      }
    }

    it('stops the scan once the deadline is reached, and says so with no additionalContext', () => {
      const run = clocked('/a:/b', ['/a/git'], 100)
      const output = sessionStartOutput(TABLE, run.edges, 100)
      expect(output).toBe(
        `{"systemMessage":"\\n${problem('the tool check ran out of time').replaceAll('\u001b', '\\u001b')}"}\n`,
      )
      expect(run.asked).toEqual(['/a/git'])
    })

    it('keeps the scan going one step before the deadline', () => {
      const run = clocked('/a', [], 100)
      const output = sessionStartOutput(TABLE, run.edges, 101)
      expect(run.asked).toEqual(['/a/git', '/a/jq'])
      expect(JSON.parse(output).systemMessage).toBe(
        `\n${problem('git is missing')}\n${problem('jq is missing')}`,
      )
    })

    it('lists a tool that is missing before the deadline, then the timeout line', () => {
      const run = clocked('/a:/b', [], 100)
      const output = sessionStartOutput(TABLE, run.edges, 150)
      expect(JSON.parse(output)).toEqual({
        systemMessage: `\n${problem('git is missing')}\n${problem('the tool check ran out of time')}`,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'Missing: git. The gh-security plugin cannot run.',
        },
      })
    })

    it('measures the deadline from the start of the check, not from clock zero', () => {
      let time = 5_000
      const asked: string[] = []
      const output = sessionStartOutput(
        [{ tool: 'jq', label: 'jq' }],
        edges({
          env: { PATH: '/a:/b' },
          now: () => time,
          executable: (path) => {
            asked.push(path)
            time += 10
            return false
          },
        }),
        100,
      )
      expect(asked).toEqual(['/a/jq', '/b/jq'])
      expect(JSON.parse(output).systemMessage).toBe(`\n${problem('jq is missing')}`)
    })

    it('uses a deadline of half the hook timeout or less', () => {
      const file = JSON.parse(
        readFileSync(join(GH_SECURITY_ROOT, 'hooks', 'hooks.json'), 'utf8'),
      ) as { hooks: { SessionStart: { hooks: { timeout: number }[] }[] } }
      const timeout = file.hooks.SessionStart[0]?.hooks[0]?.timeout ?? 0
      expect(timeout).toBe(3)
      expect(DEADLINE_MS).toBe(1500)
      expect(DEADLINE_MS).toBeLessThanOrEqual((timeout * 1000) / 2)
    })
  })
})

describe('with real files', () => {
  const directories: string[] = []
  const scratch = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'gh-security-session-'))
    directories.push(directory)
    return directory
  }
  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
  })

  it('isExecutableFile accepts an executable file only', () => {
    const directory = scratch()
    const run = join(directory, 'run')
    const plain = join(directory, 'plain')
    writeFileSync(run, '#!/bin/sh\n')
    chmodSync(run, 0o755)
    writeFileSync(plain, 'text\n')
    chmodSync(plain, 0o644)
    mkdirSync(join(directory, 'folder'))
    expect([
      isExecutableFile(run),
      isExecutableFile(plain),
      isExecutableFile(join(directory, 'folder')),
      isExecutableFile(join(directory, 'absent')),
    ]).toEqual([true, false, false, false])
  })

  const contextFor = (PATH: string, written: string[]): CommandContext => ({
    args: [],
    env: { PATH },
    io: {
      stdout: (text) => {
        written.push(text)
      },
      stderr: () => {
        throw new Error('stderr must stay empty')
      },
      readStdin: () => '',
    },
    commandNames: [],
  })

  const stubs = (names: readonly string[]): string => {
    const directory = scratch()
    for (const name of names) {
      writeFileSync(join(directory, name), '#!/bin/sh\n')
      chmodSync(join(directory, name), 0o755)
    }
    return directory
  }

  it('the command writes nothing and answers silence when every tool is present', () => {
    const written: string[] = []
    const directory = stubs(['git', 'gh', 'bash', 'jq'])
    expect(sessionStartCommand(contextFor(directory, written))).toBeUndefined()
    expect(written).toEqual([])
  })

  it('the command reads the real clock against the deadline', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(DEADLINE_MS)
    const written: string[] = []
    const directory = stubs(['git', 'gh', 'bash', 'jq'])
    expect(sessionStartCommand(contextFor(directory, written))).toBeUndefined()
    expect(written).toEqual([
      `{"systemMessage":"\\n${problem('the tool check ran out of time').replaceAll('\u001b', '\\u001b')}"}\n`,
    ])
  })

  it('the command writes one JSON object to stdout when jq is missing', () => {
    const written: string[] = []
    const directory = stubs(['git', 'gh', 'bash'])
    expect(sessionStartCommand(contextFor(directory, written))).toBeUndefined()
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0] ?? '')).toEqual({
      systemMessage: `\n${problem('jq is missing')}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Missing: jq. The gh-security plugin cannot run.',
      },
    })
  })
})
