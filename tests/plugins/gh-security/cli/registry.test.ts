// The registry's one structural promise: a command nobody asked for is never
// loaded (#273). Every loader is covered by run.test.ts, but a registry that
// imported every handler statically and wrapped it in `async () => handler`
// would pass all of those examples, so this pins the source shape the same
// way the entry point's floor-check placement is pinned.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '#gh-security/cli/registry.ts'
import { buildDispatchesCommand } from '#gh-security/subcommands/build-dispatches.ts'
import { checkAdvisoriesCommand } from '#gh-security/subcommands/check-advisories.ts'
import { classifyLinesCommand } from '#gh-security/subcommands/classify-lines.ts'
import { detectScopeCommand } from '#gh-security/subcommands/detect-scope.ts'
import { discoverAlertsCommand } from '#gh-security/subcommands/discover-alerts.ts'
import { discoverReposCommand } from '#gh-security/subcommands/discover-repos.ts'
import { fixGroupCommand } from '#gh-security/subcommands/fix-group.ts'
import { mergeEnvelopesCommand } from '#gh-security/subcommands/merge-envelopes.ts'
import { preflightRepoCommand } from '#gh-security/subcommands/preflight-repo.ts'
import { prepareCheckoutCommand } from '#gh-security/subcommands/prepare-checkout.ts'
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
      "import('../subcommands/build-dispatches.ts')",
      "import('../subcommands/check-advisories.ts')",
      "import('../subcommands/classify-lines.ts')",
      "import('../subcommands/detect-scope.ts')",
      "import('../subcommands/discover-alerts.ts')",
      "import('../subcommands/discover-repos.ts')",
      "import('../subcommands/ensure-worktree-exclude.ts')",
      "import('../subcommands/fix-group.ts')",
      "import('../subcommands/merge-envelopes.ts')",
      "import('../subcommands/pr-status.ts')",
      "import('../subcommands/preflight-repo.ts')",
      "import('../subcommands/prepare-checkout.ts')",
      "import('../subcommands/session-start.ts')",
      "import('../subcommands/version.ts')",
    ])
  })
})

describe('the discovery entries', () => {
  // The loader of each entry is the one line that reaches the handler.
  it.each([
    ['build-dispatches', buildDispatchesCommand],
    ['check-advisories', checkAdvisoriesCommand],
    ['classify-lines', classifyLinesCommand],
    ['detect-scope', detectScopeCommand],
    ['discover-alerts', discoverAlertsCommand],
    ['discover-repos', discoverReposCommand],
    ['merge-envelopes', mergeEnvelopesCommand],
    ['preflight-repo', preflightRepoCommand],
    ['prepare-checkout', prepareCheckoutCommand],
  ])('loads the handler of %s', async (name, handler) => {
    expect(await COMMANDS[name]?.load()).toBe(handler)
  })

  it.each([
    [
      'build-dispatches',
      'build-dispatches --envelope <merged.json> --cap <n> [--env-prefixes <prefixes.json>] <repo>:<branch_name>...',
    ],
    [
      'check-advisories',
      'check-advisories [--env-prefix <prefix>] [--ecosystem <eco>] [--version <v>] <package>',
    ],
    [
      'classify-lines',
      'classify-lines [--env-prefix <prefix>] --repo-root <path> [--base-ref origin/<branch>] [--branch-style slash|flat]',
    ],
    ['detect-scope', 'detect-scope [--env-prefix <prefix>] [<path>]'],
    [
      'discover-alerts',
      'discover-alerts [--env-prefix <prefix>] [--branch-style slash|flat] [--stdin] <owner/repo>',
    ],
    ['discover-repos', 'discover-repos [<path>]'],
    ['merge-envelopes', 'merge-envelopes <envelope.json>...'],
    ['preflight-repo', 'preflight-repo [--env-prefix <prefix>] [--fallback-package <pkg>] <root>'],
    ['prepare-checkout', 'prepare-checkout [--env-prefix <prefix>] <root>'],
  ])('describes %s with its usage', (name, usage) => {
    expect(COMMANDS[name]?.description).toContain(usage)
  })
})

describe('the fix driver entry', () => {
  it('loads the handler of fix-group', async () => {
    expect(await COMMANDS['fix-group']?.load()).toBe(fixGroupCommand)
  })

  it.each([
    'fix-group setup --group-json <file> --repo-root <path> --default-branch <name> [--env-prefix <prefix>] [--scorer <path>]',
    'fix-group classify --work <dir>',
    'fix-group baseline --work <dir>',
    'fix-group apply --work <dir>',
    'fix-group score --work <dir>',
  ])('describes the usage %s', (usage) => {
    expect(COMMANDS['fix-group']?.description).toContain(usage)
  })
})
