// The registry's one structural promise: a command nobody asked for is never
// loaded (#273). Every loader is covered by run.test.ts, but a registry that
// imported every handler statically and wrapped it in `async () => handler`
// would pass all of those examples, so this pins the source shape the same
// way the entry point's floor-check placement is pinned.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '#gh-security/cli/registry.ts'
import { checkAdvisoriesCommand } from '#gh-security/subcommands/check-advisories.ts'
import { detectScopeCommand } from '#gh-security/subcommands/detect-scope.ts'
import { discoverReposCommand } from '#gh-security/subcommands/discover-repos.ts'
import { pluginFile } from '#harness/paths.ts'

const GH_SECURITY_ROOT = pluginFile('gh-security')

const source = readFileSync(join(GH_SECURITY_ROOT, 'src', 'cli', 'registry.ts'), 'utf8')

describe('the registry', () => {
  it('imports and re-exports no handler statically, only types', () => {
    const statements = source
      .split('\n')
      .filter((line) => /^(import|export)\s.*\bfrom\s/.test(line))
    expect(statements.filter((line) => !/^(import|export) type\s/.test(line))).toEqual([])
  })

  it('reaches each handler through a dynamic import of its own subcommand module', () => {
    expect(source.match(/import\('\.\.\/subcommands\/[a-z-]+\.ts'\)/g)).toEqual([
      "import('../subcommands/allow-own-commands.ts')",
      "import('../subcommands/check-advisories.ts')",
      "import('../subcommands/detect-scope.ts')",
      "import('../subcommands/discover-repos.ts')",
      "import('../subcommands/ensure-worktree-exclude.ts')",
      "import('../subcommands/pr-status.ts')",
      "import('../subcommands/session-start.ts')",
      "import('../subcommands/version.ts')",
    ])
  })
})

describe('the discovery entries', () => {
  // The loader of each entry is the one line that reaches the handler.
  it.each([
    ['check-advisories', checkAdvisoriesCommand],
    ['detect-scope', detectScopeCommand],
    ['discover-repos', discoverReposCommand],
  ])('loads the handler of %s', async (name, handler) => {
    expect(await COMMANDS[name]?.load()).toBe(handler)
  })

  it.each([
    [
      'check-advisories',
      'check-advisories [--env-prefix <prefix>] [--ecosystem <eco>] [--version <v>] <package>',
    ],
    ['detect-scope', 'detect-scope [--env-prefix <prefix>] [<path>]'],
    ['discover-repos', 'discover-repos [<path>]'],
  ])('describes %s with its usage', (name, usage) => {
    expect(COMMANDS[name]?.description).toContain(usage)
  })
})
