// plugins/gh-security/hooks/hooks.json. A path that is wrong in it fails
// nowhere else: Claude Code runs the command, node or the shell exits non-zero,
// and the hook is a silent no-op for every Bash call in a session. So each
// command is run here from the file itself, with the placeholder expanded the
// way Claude Code expands it, and the allow hook is run end to end.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GH_SECURITY_ENTRY, GH_SECURITY_ROOT, PLUGIN_ROOT_PLACEHOLDER } from '#harness/paths.ts'

type HookCommand = { readonly type: string; readonly command: string }
type HooksFile = {
  readonly hooks: Record<string, readonly { readonly hooks: readonly HookCommand[] }[]>
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
