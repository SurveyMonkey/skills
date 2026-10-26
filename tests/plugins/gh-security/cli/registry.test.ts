// The registry's one structural promise: a command nobody asked for is never
// loaded (#273). Every loader is covered by run.test.ts, but a registry that
// imported every handler statically and wrapped it in `async () => handler`
// would pass all of those examples, so this pins the source shape the same
// way the entry point's floor-check placement is pinned.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '#gh-security/cli/registry.ts'
import { auditPinsCommand } from '#gh-security/subcommands/audit-pins.ts'
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
import { reapBatchCommand } from '#gh-security/subcommands/reap-batch.ts'
import { removeRunCommand } from '#gh-security/subcommands/remove-run.ts'
import { renderPrCommand } from '#gh-security/subcommands/render-pr.ts'
import { renderPrStatusCommand } from '#gh-security/subcommands/render-pr-status.ts'
import { scoreMergeRiskCommand } from '#gh-security/subcommands/score-merge-risk.ts'
import { summarizeRunCommand } from '#gh-security/subcommands/summarize-run.ts'
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
      "import('../subcommands/audit-pins.ts')",
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
      "import('../subcommands/reap-batch.ts')",
      "import('../subcommands/remove-run.ts')",
      "import('../subcommands/render-pr.ts')",
      "import('../subcommands/render-pr-status.ts')",
      "import('../subcommands/score-merge-risk.ts')",
      "import('../subcommands/session-start.ts')",
      "import('../subcommands/summarize-run.ts')",
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
    ['reap-batch', reapBatchCommand],
    ['remove-run', removeRunCommand],
    ['render-pr-status', renderPrStatusCommand],
    ['summarize-run', summarizeRunCommand],
  ])('loads the handler of %s', async (name, handler) => {
    expect(await COMMANDS[name]?.load()).toBe(handler)
  })

  it.each([
    [
      'build-dispatches',
      'build-dispatches --envelope <merged.json> --cap <n> [--env-prefixes <prefixes.json>] <repo>:<branch_name>... [--out <file>]',
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
    ['merge-envelopes', 'merge-envelopes <envelope.json>... [--out <file>]'],
    [
      'preflight-repo',
      'preflight-repo [--env-prefix <prefix>] [--fallback-package <pkg>] <root> [--out <file>]',
    ],
    ['prepare-checkout', 'prepare-checkout [--env-prefix <prefix>] <root> [--out <file>]'],
    ['reap-batch', 'reap-batch <results.json> [--out <file>]'],
    ['remove-run', 'remove-run <dir>'],
    [
      'summarize-run',
      'summarize-run --workflow <workflow.json> --reports <reports.json> --discovery <merged.json> [--preflight <preflights.json>] [--args <args.json>]',
    ],
  ])('describes %s with its usage', (name, usage) => {
    expect(COMMANDS[name]?.description).toContain(usage)
  })
})

describe('the render-pr entry', () => {
  it('loads the handler of render-pr', async () => {
    expect(await COMMANDS['render-pr']?.load()).toBe(renderPrCommand)
  })

  it.each([
    'render-pr commit-msg --state <file> --group-json <file> --repo <nwo> [--out <file>] |',
    'render-pr body --state <file> --group-json <file> --repo <nwo> [--collateral-note <file>] [--global-override-note <file>] [--out <file>] |',
    'render-pr labels --repo <nwo> --band <low|medium|high> [--label <name>]... [--env-prefix <prefix>] |',
    'render-pr create --repo <nwo> --head <branch> --title <text> --body-file <file> --band <low|medium|high> [--label <name>]... [--env-prefix <prefix>]',
  ])('describes the usage %s', (usage) => {
    expect(COMMANDS['render-pr']?.description).toContain(usage)
  })
})

describe('the merge-risk entry', () => {
  it('loads the handler of score-merge-risk', async () => {
    expect(await COMMANDS['score-merge-risk']?.load()).toBe(scoreMergeRiskCommand)
  })

  it('describes score-merge-risk with its usage', () => {
    expect(COMMANDS['score-merge-risk']?.description).toContain(
      'score-merge-risk --package <pkg> --after <version> --why-json <file|-> --override-scope <none|scoped|bare-tightened|bare-added> --declared-range <range|none> [--declared-range <range>]... [--before <version>]',
    )
  })
})

describe('the fix driver entry', () => {
  it('loads the handler of fix-group', async () => {
    expect(await COMMANDS['fix-group']?.load()).toBe(fixGroupCommand)
  })

  it.each([
    'fix-group setup --group-json <file> --repo-root <path> --default-branch <name> [--env-prefix <prefix>] |',
    'fix-group classify --work <dir>',
    'fix-group baseline --work <dir>',
    'fix-group apply --work <dir>',
    'fix-group score --work <dir>',
    'fix-group cleanup --work <dir> [--pushed]',
  ])('describes the usage %s', (usage) => {
    expect(COMMANDS['fix-group']?.description).toContain(usage)
  })
})

describe('the pin-audit driver entry', () => {
  it('loads the handler of audit-pins', async () => {
    expect(await COMMANDS['audit-pins']?.load()).toBe(auditPinsCommand)
  })

  it.each([
    'audit-pins list --work <dir> --worktree <dir> [--ecosystem <eco>] [--env-prefix <prefix>] |',
    'audit-pins baseline --work <dir> |',
    'audit-pins test-pin --work <dir> (--key <key> | --path <json array>) |',
    'audit-pins judge --work <dir> |',
    'audit-pins together --work <dir>',
  ])('describes the usage %s', (usage) => {
    expect(COMMANDS['audit-pins']?.description).toContain(usage)
  })
})

describe('the calls that take --out (#346)', () => {
  // Each command whose answer a later command reads, and no other. A
  // command missing here would leave the model to copy its answer by hand.
  it('opts in exactly the commands and the render-pr verbs whose answer a later command reads', () => {
    const scopes = Object.fromEntries(
      Object.entries(COMMANDS)
        .filter(([, entry]) => entry.out !== undefined)
        .map(([name, entry]) => [name, entry.out]),
    )
    expect(scopes).toEqual({
      'build-dispatches': 'every call',
      'merge-envelopes': 'every call',
      'pr-status': 'every call',
      'preflight-repo': 'every call',
      'prepare-checkout': 'every call',
      'reap-batch': 'every call',
      'render-pr': ['commit-msg', 'body'],
      'summarize-run': 'every call',
    })
  })
})
