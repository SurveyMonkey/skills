// plugins/gh-security/hooks/hooks.json. A path that is wrong in it fails
// nowhere else: Claude Code runs the command, node or the shell exits non-zero,
// and the hook is a silent no-op for every Bash call in a session. So each
// command is run here from the file itself, with the placeholder expanded the
// way Claude Code expands it, and the allow hook is run end to end.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GH_SECURITY_ENTRY, GH_SECURITY_ROOT, PLUGIN_ROOT_PLACEHOLDER } from '#harness/paths.ts'

type HookCommand = { readonly type: string; readonly command: string; readonly timeout?: number }
type HooksFile = {
  readonly hooks: Record<
    string,
    readonly { readonly matcher?: string; readonly hooks: readonly HookCommand[] }[]
  >
}

const file = JSON.parse(
  readFileSync(join(GH_SECURITY_ROOT, 'hooks', 'hooks.json'), 'utf8'),
) as HooksFile
const commands = Object.values(file.hooks).flatMap((groups) =>
  groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
)
const expand = (command: string): string =>
  command.split(PLUGIN_ROOT_PLACEHOLDER).join(GH_SECURITY_ROOT)

describe('hooks.json', () => {
  it('carries a command at all', () => {
    expect(commands.length).toBeGreaterThan(0)
  })

  // Per command, so one command that names a file some other way (a
  // misspelled placeholder, a relative path) cannot hide behind another
  // command's valid path.
  it.each(commands)('%s names an existing plugin file through the placeholder', (command) => {
    expect(command).toContain(PLUGIN_ROOT_PLACEHOLDER)
    const named = [...expand(command).matchAll(/[^\s"]*plugins\/gh-security\/[^\s"]+/g)].map(
      (match) => match[0],
    )
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((path) => !existsSync(path))).toEqual([])
  })

  it('runs the allow hook, which allows a call to this plugin entry point', () => {
    const allow = commands.find((command) => command.includes('allow-own-commands'))
    expect(allow).toBeDefined()
    const input = JSON.stringify({
      session_id: 'abc',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `node "${GH_SECURITY_ENTRY}" version` },
    })
    const output = execFileSync('sh', ['-c', expand(allow ?? '')], { input, encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining('version'),
      },
    })
  })
})

describe('the SessionStart entry', () => {
  const groups = file.hooks.SessionStart ?? []
  const command = groups[0]?.hooks[0]?.command ?? ''
  const directories: string[] = []
  const pathWith = (make: (directory: string) => void): string => {
    const directory = mkdtempSync(join(tmpdir(), 'gh-security-hooks-'))
    directories.push(directory)
    make(directory)
    return directory
  }
  const toolPath = (tool: string): string => {
    const found = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((directory) => directory !== '')
      .map((directory) => join(directory, tool))
      .find((candidate) => existsSync(candidate))
    if (found === undefined) throw new Error(`${tool} is needed on PATH to run this suite`)
    return found
  }
  const sh = (PATH: string) =>
    execFileSync('/bin/sh', ['-c', expand(command)], { env: { PATH }, encoding: 'utf8' })

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
  })

  it('has one group with the matcher and the 3 second timeout', () => {
    expect(groups).toHaveLength(1)
    expect(groups[0]?.matcher).toBe('startup|resume|clear|compact')
    expect(groups[0]?.hooks).toEqual([{ type: 'command', command, timeout: 3 }])
  })

  it('writes the systemMessage JSON and exits 0 when node is not on PATH', () => {
    expect(sh('')).toBe('{"systemMessage":"\\ngh-security: ⚠️ node not found on PATH"}\n')
    expect(JSON.parse(sh(''))).toEqual({ systemMessage: '\ngh-security: ⚠️ node not found on PATH' })
  })

  it('writes nothing to stderr when node is not on PATH', () => {
    const result = spawnSync('/bin/sh', ['-c', expand(command)], {
      env: { PATH: '' },
      encoding: 'utf8',
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('writes nothing when node and every other tool are on PATH', () => {
    const PATH = pathWith((directory) => {
      symlinkSync(process.execPath, join(directory, 'node'))
      for (const tool of ['git', 'gh', 'bash', 'jq'])
        symlinkSync(toolPath(tool), join(directory, tool))
    })
    expect(sh(PATH)).toBe('')
  })

  it('exits 0 when the hook file makes node exit non-zero', () => {
    const PATH = pathWith((directory) => {
      writeFileSync(join(directory, 'node'), '#!/bin/sh\nexit 5\n')
      chmodSync(join(directory, 'node'), 0o755)
    })
    expect(sh(PATH)).toBe('')
  })
})
