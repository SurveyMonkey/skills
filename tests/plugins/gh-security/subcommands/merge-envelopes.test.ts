// `gh-security merge-envelopes`. The seam is the exported handler, with the
// current directory as a parameter. The input is real files.
//
// The expected order is not written by hand. It is the parity capture
// `spec/fixtures/merge-envelopes/capture.json`: the output of the jq program
// of the deleted `combine_results`
// (`fdb1544^:plugins/gh-security/scripts/common/discover-alerts.sh:563-576`)
// on `app.json`, `api.json` and `web.json`. That capture has a tie at each
// sort key, a full tie, and code point order in `package` and `major_line`.
// The other expected values are written by hand from the contract in the
// header of the command, and the names in them are fictitious.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { failed } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { mergeEnvelopes, mergeEnvelopesCommand } from '#gh-security/subcommands/merge-envelopes.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')
const DIR = join(FIXTURES_ROOT, 'merge-envelopes')
const FILES = ['app.json', 'api.json', 'web.json']

const context = (args: readonly string[]): CommandContext => ({
  args,
  env: {},
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const merge = (args: readonly string[], cwd = DIR): CommandResult =>
  mergeEnvelopes(context(args), cwd)

const value = (result: CommandResult): Record<string, unknown> => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value as Record<string, unknown>
}

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Record<string, unknown>

const CAPTURE = fixture('capture.json')

/** A scratch directory with one file for each entry. */
const filesOf = (entries: Record<string, string>): string => {
  const sandbox = createSandbox()
  const dir = join(sandbox.path, 'in')
  mkdirSync(dir)
  for (const [name, text] of Object.entries(entries)) writeFileSync(join(dir, name), text)
  return dir
}

/** A kept checkout with one actionable group, which an example then breaks. */
const KEPT = {
  checkout: '/work/app',
  nwo: 'octo/app',
  default_branch: 'main',
  branch_style: 'slash',
  actionable: [
    {
      package: 'lodash',
      major_line: '4',
      max_severity: 'high',
      max_epss_percentile: 0.5,
      repo: 'octo/app',
    },
  ],
  skipped: [],
  classify_errors: [],
}

describe('the re-rank (pin: states the cross-checkout re-rank in the order the deleted script used)', () => {
  it('sorts actionable as the jq of combine_results does, with ties at every key', () => {
    expect(value(merge(FILES)).actionable).toEqual(CAPTURE.actionable)
  })

  it('gives the same order whatever the order of the files', () => {
    expect(value(merge(['web.json', 'app.json', 'api.json'])).actionable).toEqual(
      CAPTURE.actionable,
    )
  })

  it('keeps the order of the files for a full tie, as a stable sort does', () => {
    // The two cookie groups have the same five keys. Only alert_count differs.
    const cookies = (value(merge(FILES)).actionable as Record<string, unknown>[])
      .filter((group) => group.package === 'cookie')
      .map((group) => group.alert_count)
    expect(cookies).toEqual([1, 2])
  })
})

describe('the concatenation', () => {
  it('gives every skipped group, in the order of the files, as combine_results does', () => {
    expect(value(merge(FILES)).skipped).toEqual(CAPTURE.skipped)
  })

  it('gives each kept checkout and each excluded checkout, in the order of the files', () => {
    const answer = value(merge(['api.json', 'excluded.json', 'web.json']))
    expect({ checkouts: answer.checkouts, excluded: answer.excluded }).toEqual({
      checkouts: [
        {
          checkout: '/work/api',
          nwo: 'octo/api',
          default_branch: 'trunk',
          branch_style: 'flat',
          classify_errors: [
            {
              adapter: 'node',
              package: 'ms',
              error: 'resolved_versions failed',
              base_ref: 'origin/trunk',
            },
          ],
        },
        {
          checkout: '/work/web',
          nwo: 'octo/web',
          default_branch: 'main',
          branch_style: 'slash',
          classify_errors: [],
        },
      ],
      excluded: [
        {
          checkout: '/work/old',
          reason: 'branch namespace probe failed twice',
          stderr: 'fatal: could not read from remote repository.\n',
        },
      ],
    })
  })

  it('answers with no group when every checkout is excluded', () => {
    expect(value(merge(['excluded.json']))).toEqual({
      checkouts: [],
      excluded: [
        {
          checkout: '/work/old',
          reason: 'branch namespace probe failed twice',
          stderr: 'fatal: could not read from remote repository.\n',
        },
      ],
      actionable: [],
      skipped: [],
    })
  })

  // pin: never offers a requires-major-bump group as a rankable row in phase 3
  it('never moves a requires_major_bump group into the rows to approve', () => {
    const answer = value(merge(FILES))
    const names = (key: string) =>
      (answer[key] as Record<string, unknown>[]).map((group) => group.package)
    expect({
      actionable: names('actionable').includes('path-to-regexp'),
      skipped: (answer.skipped as Record<string, unknown>[]).find(
        (group) => group.package === 'path-to-regexp',
      )?.reason,
    }).toEqual({ actionable: false, skipped: 'requires major version bump' })
  })
})

describe('the refusals', () => {
  it('refuses a call with no file', () => {
    expect(merge([])).toEqual(failed('usage: gh-security merge-envelopes <envelope.json>...'))
  })

  it('refuses an option', () => {
    expect(merge(['--repo', 'octo/app', 'app.json'])?.outcome).toBe('failed')
  })

  it('refuses a file that cannot be read, and names it', () => {
    const result = merge(['missing.json'])
    expect(result?.outcome === 'failed' && result.error).toMatch(
      /^cannot read missing\.json: ENOENT/,
    )
  })

  it('reads a file from the current directory', () => {
    const dir = filesOf({ 'one.json': JSON.stringify(KEPT) })
    expect(value(merge(['one.json'], dir)).actionable).toEqual(KEPT.actionable)
  })

  it('refuses a file that is not JSON', () => {
    const dir = filesOf({ 'bad.json': '{"checkout": ' })
    expect(merge(['bad.json'], dir)).toEqual(failed('bad.json is not JSON'))
  })

  const broken: [string, unknown, string][] = [
    ['a list', [KEPT], 'not an object'],
    ['null', null, 'not an object'],
    ['no checkout', { ...KEPT, checkout: undefined }, 'checkout is not text'],
    ['a null nwo', { ...KEPT, nwo: null }, 'nwo is not text'],
    ['a null default branch', { ...KEPT, default_branch: null }, 'default_branch is not text'],
    [
      'another branch style',
      { ...KEPT, branch_style: 'dash' },
      'branch_style is not slash or flat',
    ],
    ['no actionable', { ...KEPT, actionable: undefined }, 'actionable is not a list of objects'],
    ['a scalar group', { ...KEPT, actionable: ['lodash'] }, 'actionable is not a list of objects'],
    ['no skipped', { ...KEPT, skipped: null }, 'skipped is not a list of objects'],
    [
      'no classify_errors',
      { ...KEPT, classify_errors: undefined },
      'classify_errors is not a list of objects',
    ],
    [
      'an excluded flag that is not true',
      { checkout: '/w', excluded: false, reason: 'r', stderr: '' },
      'excluded is not true',
    ],
    [
      'an exclusion with no reason',
      { checkout: '/w', excluded: true, stderr: '' },
      'reason is not text',
    ],
    [
      'an exclusion with no stderr',
      { checkout: '/w', excluded: true, reason: 'r' },
      'stderr is not text',
    ],
    [
      'an exclusion with no checkout',
      { excluded: true, reason: 'r', stderr: '' },
      'checkout is not text',
    ],
  ]
  it.each(broken)('refuses %s', (_name, answer, problem) => {
    const dir = filesOf({ 'x.json': JSON.stringify(answer) })
    expect(merge(['x.json'], dir)).toEqual(
      failed(`x.json is not an answer of prepare-checkout: ${problem}`),
    )
  })

  it.each([
    ['null', null],
    ['text', '0.5'],
    ['no value', undefined],
  ])('refuses a max_epss_percentile that is %s, as jq -(x) does', (_name, epss) => {
    const group = { ...KEPT.actionable[0], max_epss_percentile: epss }
    const dir = filesOf({ 'x.json': JSON.stringify({ ...KEPT, actionable: [group] }) })
    expect(merge(['x.json'], dir)).toEqual(
      failed(
        `max_epss_percentile is not a number in x.json: ${JSON.stringify(epss ?? null)} cannot be negated`,
      ),
    )
  })

  it('refuses the whole merge when one file of several is bad', () => {
    const dir = filesOf({ 'good.json': JSON.stringify(KEPT), 'bad.json': '[]' })
    expect(merge(['good.json', 'bad.json'], dir)).toEqual(
      failed('bad.json is not an answer of prepare-checkout: not an object'),
    )
  })
})

describe('the registered handler', () => {
  it('reads the files from the current directory of the process', () => {
    const result = mergeEnvelopesCommand(context(FILES.map((name) => join(DIR, name))))
    expect(value(result as CommandResult).actionable).toEqual(CAPTURE.actionable)
  })
})

describe('the process', () => {
  const spawnCli = (args: readonly string[]) =>
    run(process.execPath, [ENTRY, 'merge-envelopes', ...args], {
      cwd: DIR,
      env: createSandbox().env,
    })

  it('writes the merge on stdout with exit 0', async () => {
    const result = await spawnCli(FILES)
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as { actionable: unknown }).actionable).toEqual(
      CAPTURE.actionable,
    )
  })

  it('exits 1 with the error as JSON on stdout and as prose on stderr', async () => {
    const result = await spawnCli([])
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: '{"error":"usage: gh-security merge-envelopes <envelope.json>..."}\n',
      stderr: 'usage: gh-security merge-envelopes <envelope.json>...\n',
    })
  })
})
