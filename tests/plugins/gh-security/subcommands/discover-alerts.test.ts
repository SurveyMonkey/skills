// `gh-security discover-alerts`. The seam is the exported handler, with the
// `gh` client factory, the process runner and the registry as parameters.
// `gh` is the one mock boundary (`mocking.md`). Most examples use a stand-in
// client: the harness mock gives one reply for each endpoint, and the open
// pull request check asks once for each branch, so the stand-in looks up each
// `head:` search in a map. Version order comes from the real node adapter,
// except where a stand-in registry breaks `compare_versions` on purpose. The
// expected values are written by hand from the contract in the header of the
// command. The bash script is compared in `parity-discover-alerts.test.ts`.
import { describe, expect, it } from 'vitest'

import type { Adapter } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { failed, ok } from '#gh-security/lib/envelope.ts'
import { createGhClient, type GhClient, GhError } from '#gh-security/lib/gh.ts'
import { type Runner, type RunResult, run } from '#gh-security/lib/process.ts'
import {
  compareVersionText,
  discoverAlerts,
  discoverAlertsCommand,
} from '#gh-security/subcommands/discover-alerts.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

const USAGE =
  'usage: gh-security discover-alerts [--env-prefix <prefix>] [--branch-style slash|flat] ' +
  '[--stdin] <owner/repo>'

type Alert = Record<string, unknown>

/** One alert, in the shape that the alerts endpoint gives. */
const alert = (
  number: number,
  name: unknown,
  patched: unknown,
  fields: { severity?: unknown; epss?: unknown; range?: string; ecosystem?: unknown } = {},
): Alert => ({
  number,
  dependency: {
    package: { ecosystem: fields.ecosystem === undefined ? 'npm' : fields.ecosystem, name },
    manifest_path: 'package.json',
    relationship: 'transitive',
  },
  security_advisory: {
    ghsa_id: `GHSA-${String(name)}-${number}`,
    cve_id: `CVE-2000-000${number}`,
    severity: fields.severity ?? 'high',
    summary: 's',
    epss: { percentile: 'epss' in fields ? fields.epss : 0.1 },
  },
  security_vulnerability: {
    vulnerable_version_range: fields.range ?? '< 99.0.0',
    first_patched_version: patched === null ? null : { identifier: patched },
  },
})

/** Three packages: undici on two lines, lodash on one, and left-pad with no fix. */
const ALERTS: Alert[] = [
  alert(1, 'undici', '7.29.0', { epss: 0.9, range: '< 7.29.0' }),
  alert(2, 'undici', '6.28.0', { severity: 'medium', epss: 0.2, range: '< 6.28.0' }),
  alert(3, 'undici', '6.24.0', { epss: 0.5, range: '< 6.24.0' }),
  alert(4, 'left-pad', null, { severity: 'critical', epss: 0.7, range: '<= 1.3.0' }),
  alert(5, 'lodash', '4.17.21', { severity: 'medium', epss: 0.3, range: '< 4.17.21' }),
]

interface StandIn {
  readonly alerts?: readonly unknown[] | GhError | Error
  /** The open pull request URL for each `head:` search that finds one. */
  readonly prs?: Readonly<Record<string, string>>
  /** More open pull requests that each search finds, after the first. */
  readonly later?: readonly string[]
  /** When set, every `head:` search fails with it, or each head that it names. */
  readonly search?: GhError | Error
  readonly failing?: readonly string[]
}

/**
 * The stand-in for `gh`, and the searches that it was asked, as
 * `<repository> head:<branch>`. The log is read for its shape only: which
 * heads were asked, never how many times, or in which order (`mocking.md`).
 */
const standIn = (spec: StandIn) => {
  const asked: string[] = []
  const client: GhClient = {
    viewPullRequest: () => Promise.reject(new Error('not asked')),
    viewDefaultBranch: () => Promise.reject(new Error('not asked')),
    listAdvisories: () => Promise.reject(new Error('not asked')),
    createLabel: () => Promise.reject(new Error('not asked')),
    createPullRequest: () => Promise.reject(new Error('not asked')),
    listDependabotAlerts: async () => {
      const alerts = spec.alerts ?? ALERTS
      if (alerts instanceof Error) throw alerts
      return alerts as Alert[]
    },
    searchOpenPullRequests: async ({ repository, head }) => {
      asked.push(`${repository} head:${head}`)
      if (spec.search !== undefined && (spec.failing ?? [head]).includes(head)) throw spec.search
      const url = spec.prs?.[head]
      return url === undefined
        ? []
        : [{ url }, ...(spec.later ?? []).map((later) => ({ url: later }))]
    },
  }
  return { client, asked }
}

const context = (args: readonly string[], stdin = ''): CommandContext => ({
  args,
  env: { PATH: '/bin' },
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => stdin },
  commandNames: [],
})

const noProcess: Runner = () => Promise.reject(new Error('the stand-in client starts no process'))

const discover = (
  args: readonly string[],
  spec: StandIn = {},
  options: { stdin?: string; route?: typeof selectAdapter } = {},
) => {
  const { client, asked } = standIn(spec)
  const result = discoverAlerts(
    context(args, options.stdin),
    () => client,
    noProcess,
    options.route ?? selectAdapter,
  )
  return { result, asked }
}

type Group = Record<string, unknown>

const answer = async (
  args: readonly string[],
  spec: StandIn = {},
  options: { stdin?: string; route?: typeof selectAdapter } = {},
): Promise<{ actionable: Group[]; skipped: Group[] }> => {
  const result = await discover(args, spec, options).result
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value as { actionable: Group[]; skipped: Group[] }
}

const refusal = async (
  args: readonly string[],
  spec: StandIn = {},
  options: { stdin?: string; route?: typeof selectAdapter } = {},
): Promise<CommandResult> => discover(args, spec, options).result

/** `branch_name`, then `reason` when there is one, for each group of a list. */
const named = (groups: readonly Group[]): string[] =>
  groups.map((group) =>
    group.reason === undefined
      ? String(group.branch_name)
      : `${group.branch_name}: ${group.reason}`,
  )

describe('the groups', () => {
  it('has every field of a group, read from its alerts', async () => {
    const { actionable } = await answer(['octo/app'])
    expect(actionable[0]).toEqual({
      package: 'undici',
      ecosystem: 'npm',
      major_line: '7',
      max_severity: 'high',
      max_epss_percentile: 0.9,
      alert_count: 1,
      alerts: [
        {
          number: 1,
          cve: 'CVE-2000-0001',
          ghsa: 'GHSA-undici-1',
          severity: 'high',
          summary: 's',
          vulnerable_range: '< 7.29.0',
          fixed_in: '7.29.0',
          epss_percentile: 0.9,
          relationship: 'transitive',
          manifest: 'package.json',
        },
      ],
      sibling_alerts: [{ major: 6, vulnerable_ranges: ['< 6.24.0', '< 6.28.0'] }],
      highest_fixed_version: '7.29.0',
      branch_name: 'fix/dependabot-undici-7x',
      repo: 'octo/app',
    })
  })

  it('makes one group for each package major line, and ranks them', async () => {
    const { actionable, skipped } = await answer(['octo/app'])
    expect(named(actionable)).toEqual([
      'fix/dependabot-undici-7x',
      'fix/dependabot-undici-6x',
      'fix/dependabot-lodash-4x',
    ])
    expect(named(skipped)).toEqual(['fix/dependabot-left-pad-unfixed: no fix available'])
  })

  it('keeps the alerts of each line apart, in the order they came', async () => {
    const { actionable } = await answer(['octo/app'])
    const six = actionable[1] as Group
    expect(six).toMatchObject({
      major_line: '6',
      alert_count: 2,
      max_severity: 'high',
      max_epss_percentile: 0.5,
      highest_fixed_version: '6.28.0',
      sibling_alerts: [{ major: 7, vulnerable_ranges: ['< 7.29.0'] }],
    })
    expect((six.alerts as Group[]).map((entry) => entry.number)).toEqual([2, 3])
  })

  it('gives a sibling with no fix the major null, and [] for a package with one line', async () => {
    const { actionable, skipped } = await answer(['octo/app'], {
      alerts: [
        alert(1, 'undici', '7.29.0'),
        alert(2, 'undici', null, { range: '<= 5.28.0' }),
        alert(3, 'undici', 'See vendor advisory', { range: '<= 5.28.0' }),
        alert(4, 'lodash', '4.17.21'),
      ],
    })
    expect(actionable.map((group) => [group.package, group.sibling_alerts])).toEqual([
      ['lodash', []],
      ['undici', [{ major: null, vulnerable_ranges: ['<= 5.28.0'] }]],
    ])
    expect(skipped.map((group) => [group.alert_count, group.sibling_alerts])).toEqual([
      [2, [{ major: 7, vulnerable_ranges: ['< 99.0.0'] }]],
    ])
  })

  it.each([[['--branch-style', 'flat', 'octo/app']], [['--branch-style=flat', 'octo/app']]])(
    'spells every name flat under the flat style (%j)',
    async (args) => {
      const { actionable, skipped } = await answer(args)
      expect(named(actionable)).toEqual([
        'fix-dependabot-undici-7x',
        'fix-dependabot-undici-6x',
        'fix-dependabot-lodash-4x',
      ])
      expect(named(skipped)).toEqual(['fix-dependabot-left-pad-unfixed: no fix available'])
    },
  )

  it('keeps a scoped package name in the branch as it is', async () => {
    const alerts = [alert(1, '@babel/traverse', '7.23.2')]
    expect(named((await answer(['octo/app'], { alerts })).actionable)).toEqual([
      'fix/dependabot-@babel/traverse-7x',
    ])
    expect(
      named((await answer(['--branch-style', 'flat', 'octo/app'], { alerts })).actionable),
    ).toEqual(['fix-dependabot-@babel/traverse-7x'])
  })

  it('ranks by severity, then EPSS, then package, then the line as text', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [
        alert(1, 'b', '1.0.1', { severity: 'low', epss: 0.9 }),
        alert(2, 'a', '9.0.1', { severity: 'low', epss: 0.9 }),
        alert(3, 'a', '10.0.1', { severity: 'low', epss: 0.9 }),
        alert(4, 'c', '1.0.1', { severity: 'moderate', epss: 0.99 }),
        alert(5, 'd', '1.0.1', { severity: 'critical', epss: 0.01 }),
        alert(6, 'e', '1.0.1', { severity: 'medium', epss: 0 }),
        alert(7, 'f', '1.0.1', { severity: 'high', epss: null }),
      ],
    })
    expect(actionable.map((group) => `${group.package}@${group.major_line}`)).toEqual([
      'd@1',
      'f@1',
      'e@1',
      'a@10',
      'a@9',
      'b@1',
      'c@1',
    ])
    expect(actionable[1]?.max_epss_percentile).toBe(0)
  })

  it.each([
    ['rising', [0.2, 0.7]],
    ['falling', [0.7, 0.2]],
  ])('reads the highest EPSS of a group in the order of jq, %s', async (_case, values) => {
    const { actionable } = await answer(['octo/app'], {
      alerts: values.map((epss, index) => alert(index, 'a', `1.0.${index}`, { epss })),
    })
    expect(actionable[0]?.max_epss_percentile).toBe(0.7)
  })

  it('keeps the first severity of the lowest rank, as a stable sort does', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [
        alert(1, 'a', '1.0.1', { severity: 'moderate' }),
        alert(2, 'a', '1.0.2', { severity: 'unknown' }),
      ],
    })
    expect(actionable[0]?.max_severity).toBe('moderate')
  })

  it('makes one group of a line whose alerts come apart in the list', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [
        alert(1, 'undici', '7.1.0'),
        alert(2, 'undici', '6.1.0'),
        alert(3, 'undici', '7.2.0'),
        alert(4, 'lodash', '4.17.21'),
        alert(5, 'undici', '6.2.0'),
      ],
    })
    expect(actionable.map((group) => [group.package, group.major_line, group.alert_count])).toEqual(
      [
        ['lodash', '4', 1],
        ['undici', '6', 2],
        ['undici', '7', 2],
      ],
    )
  })

  it.each([
    ['a v prefix', 'v7.29.0', '7', 'v7.29.0'],
    ['white space', '  7.29.0 ', '7', '  7.29.0 '],
    ['a number', 7, '7', '7'],
    ['a leading zero', '07.1.0', '07', '07.1.0'],
  ])(
    'reads the line of %s, and keeps the identifier as it was',
    async (_case, identifier, line, highest) => {
      const { actionable } = await answer(['octo/app'], { alerts: [alert(1, 'x', identifier)] })
      expect(actionable.map((group) => [group.major_line, group.highest_fixed_version])).toEqual([
        [line, highest],
      ])
    },
  )

  it.each([
    ['prose', 'See vendor advisory'],
    ['empty text', ''],
    ['no patched version', null],
  ])('skips an alert with %s as no fix available', async (_case, identifier) => {
    const { actionable, skipped } = await answer(['octo/app'], {
      alerts: [alert(1, 'x', identifier)],
    })
    expect(actionable).toEqual([])
    expect(skipped.map((group) => [group.major_line, group.reason, group.branch_name])).toEqual([
      ['none', 'no fix available', 'fix/dependabot-x-unfixed'],
    ])
  })

  it('keeps fixed_in none for an alert with no patched version', async () => {
    const { skipped } = await answer(['octo/app'], { alerts: [alert(1, 'x', null)] })
    expect((skipped[0]?.alerts as Group[] | undefined)?.[0]?.fixed_in).toBe('none')
  })

  it('reads missing fields as jq does: null, or the default of the script', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [
        {
          number: 9,
          dependency: { package: { name: 'bare' } },
          security_vulnerability: { first_patched_version: { identifier: '1.0.1' } },
        },
      ],
    })
    expect(actionable[0]).toMatchObject({
      ecosystem: null,
      max_severity: null,
      max_epss_percentile: 0,
      alerts: [
        {
          number: 9,
          cve: null,
          ghsa: null,
          severity: null,
          summary: null,
          vulnerable_range: null,
          fixed_in: '1.0.1',
          epss_percentile: 0,
          relationship: 'unknown',
          manifest: 'unknown',
        },
      ],
    })
  })

  it('reads a false field as jq // does: the default of the script', async () => {
    const { skipped } = await answer(['octo/app'], {
      alerts: [
        {
          number: 9,
          dependency: {
            package: { name: 'bare', ecosystem: 'npm' },
            relationship: false,
            manifest_path: false,
          },
          security_advisory: { severity: 'low', epss: { percentile: false } },
          security_vulnerability: { first_patched_version: { identifier: false } },
        },
      ],
    })
    expect(skipped[0]).toMatchObject({
      major_line: 'none',
      max_epss_percentile: 0,
      alerts: [
        { fixed_in: 'none', epss_percentile: 0, relationship: 'unknown', manifest: 'unknown' },
      ],
    })
  })

  it('takes the ecosystem of a group from its first alert', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [alert(1, 'x', '1.0.1', { ecosystem: 'pip' }), alert(2, 'x', '1.0.2')],
    })
    expect(actionable.map((group) => group.ecosystem)).toEqual(['pip'])
  })

  it('keeps an alert whose package name is empty text, as jq does', async () => {
    const { actionable } = await answer(['octo/app'], { alerts: [alert(1, '', '1.0.1')] })
    expect(actionable.map((group) => [group.package, group.branch_name])).toEqual([
      ['', 'fix/dependabot--1x'],
    ])
  })

  it('drops an alert with no package name', async () => {
    const nameless = alert(1, 'x', '1.0.1')
    ;(nameless.dependency as { package: Alert }).package = { ecosystem: 'npm' }
    expect(await answer(['octo/app'], { alerts: [nameless] })).toEqual({
      actionable: [],
      skipped: [],
    })
  })

  it('answers empty lists for no alerts', async () => {
    expect(await answer(['octo/app'], { alerts: [] })).toEqual({ actionable: [], skipped: [] })
  })

  it('names the branch of a package whose name ends in line breaks without them', async () => {
    const { actionable } = await answer(['octo/app'], { alerts: [alert(1, 'undici\n\n', '7.1.0')] })
    expect(actionable.map((group) => [group.package, group.branch_name])).toEqual([
      ['undici\n\n', 'fix/dependabot-undici-7x'],
    ])
  })

  it.each([
    ['a package name that is not text', [alert(1, 5, '1.0.1')], 'a package name is not text: 5'],
    [
      'an EPSS that is text',
      [alert(1, 'x', '1.0.1', { epss: 'high' })],
      '"high" cannot be negated',
    ],
    [
      'a dependency that is text',
      [{ number: 1, dependency: 'x' }],
      'cannot read the field "package" of "x"',
    ],
    ['a line that ends in a line break', [alert(1, 'x', '7\n.1.0')], '"7\\n" is not a number'],
  ])('fails for %s, as jq stops', async (_case, alerts, said) => {
    expect(await refusal(['octo/app'], { alerts })).toEqual(
      failed(`Failed to group alerts for octo/app: ${said}`),
    )
  })
})

describe('the highest fixed version', () => {
  it('asks the adapter, and keeps the higher of each pair', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [
        alert(1, 'x', '6.3.0'),
        alert(2, 'x', '6.28.0'),
        alert(3, 'x', '6.24.0'),
        alert(4, 'x', '6.28.0'),
      ],
    })
    expect(actionable[0]?.highest_fixed_version).toBe('6.28.0')
  })

  it('reads each line of an identifier as its own candidate, as the script does', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [alert(1, 'x', '6.1.0\n\n6.9.0')],
    })
    expect(actionable[0]?.highest_fixed_version).toBe('6.9.0')
  })

  /** A registry whose node adapter answers `compare_versions` as `compare` says. */
  const comparing =
    (compare: Adapter<NodeDetection>['compareVersions']): typeof selectAdapter =>
    (ecosystem, manifest = null) => {
      const real = selectAdapter(ecosystem, manifest)
      return real.supported ? { ...real, adapter: { ...node, compareVersions: compare } } : real
    }

  const TWO = [alert(1, 'x', '1.0.1'), alert(2, 'x', '1.0.2')]

  it('fails when compare_versions fails, and names the pair', async () => {
    const route = comparing(() => failed('adapter exploded'))
    expect(await refusal(['octo/app'], { alerts: TWO }, { route })).toEqual(
      failed('compare_versions failed for npm (1.0.2 vs 1.0.1): adapter exploded'),
    )
  })

  it.each([
    ['a result of 2', { result: 2 }],
    ['no result', {}],
    ['a result that is text', { result: '1' }],
    ['a value that is null', null],
    ['a value that is text', 'x'],
  ])('fails when compare_versions gives %s', async (_case, value) => {
    const route = comparing(() => ok(value as never))
    expect(await refusal(['octo/app'], { alerts: TWO }, { route })).toEqual(
      failed(
        `compare_versions returned no usable result for npm (1.0.2 vs 1.0.1): ${JSON.stringify(value)}`,
      ),
    )
  })

  it.each([
    [1, '1.0.2'],
    [0, '1.0.1'],
    [-1, '1.0.1'],
  ])('reads a result of %s as the pick of %s', async (result, highest) => {
    const route = comparing(() => ok({ result } as never))
    const { actionable } = await answer(['octo/app'], { alerts: TWO }, { route })
    expect(actionable[0]?.highest_fixed_version).toBe(highest)
  })

  it.each([
    ['pip', ['2.0.1', '2.0.10', '2.0.9'], '2.0.10'],
    ['rubygems', ['7.0.0', '7.0.0.rc1'], '7.0.0.rc1'],
    [null, ['1.9', '1.10'], '1.10'],
    ['pip', ['1.0', '1.00'], '1.00'],
    ['pip', ['2.0.0\n.1'], '2.0.0'],
  ])(
    'sorts the fixes of %s, which has no adapter, as sort -V does',
    async (ecosystem, fixes, highest) => {
      const alerts = fixes.map((fix, index) => alert(index, 'x', fix, { ecosystem }))
      const { actionable } = await answer(['octo/app'], { alerts })
      expect(actionable[0]?.highest_fixed_version).toBe(highest)
    },
  )

  it('skips a group whose highest fix is the text none, as the script does', async () => {
    const { actionable, skipped } = await answer(['octo/app'], {
      alerts: [alert(1, 'x', '1.0.0\nnone', { ecosystem: 'pip' })],
    })
    expect(actionable).toEqual([])
    expect(skipped.map((group) => [group.highest_fixed_version, group.reason])).toEqual([
      ['none', 'no fix available'],
    ])
  })

  it('routes an ecosystem without the line breaks at its end, as $( ) does', async () => {
    const route = comparing(() => failed('adapter exploded'))
    const alerts = TWO.map((each) => ({
      ...each,
      dependency: { ...(each.dependency as Alert), package: { ecosystem: 'npm\n', name: 'x' } },
    }))
    expect(await refusal(['octo/app'], { alerts }, { route })).toEqual(
      failed('compare_versions failed for npm (1.0.2 vs 1.0.1): adapter exploded'),
    )
  })
})

describe('compareVersionText', () => {
  it.each([
    ['2.0.10', '2.0.9', 1],
    ['10', '9', 1],
    ['009', '10', -1],
    ['1.0~rc1', '1.0', -1],
    ['1~', '1', -1],
    ['1.0a', '1.0', 1],
    ['7.0.0.rc1', '7.0.0', 1],
    ['1.a', '1.b', -1],
    ['1.2.tar.gz', '1.10.tar.gz', -1],
    ['1.~x', '1.0', -1],
    ['1-2', '1+2', 1],
    [`1.${String.fromCodePoint(0xe9)}`, '1.e', 1],
    ['abc', 'abd', -1],
    ['a1', '1', 1],
    ['1.2', '1.3', -1],
    ['21', '12', 1],
    // These rows came from a search for each mutant of the sort, and each is
    // checked against GNU sort 9.7 (`sort -V | tail -1`). The sort of macOS
    // puts `1.AAb` above `1.`.
    ['10-9', '11', -1],
    ['11~a', '1b-~', 1],
    ['1A9aAb', '1.~', 1],
    ['1.', '1.AAb', 1],
    ['1-', '1a', 1],
    ['1A', '1a', -1],
    ['1.3a', '1.2b', 1],
    ['1.0', '1.00', -1],
    ['1.2.3', '1.2.3', 0],
    // A dot at the start, checked against GNU sort 9.7: `.` first, then
    // `..`, then each other name with a dot at the start.
    ['.1', '2.0.0', -1],
    ['.', '..', -1],
    ['..', '.a', -1],
    ['.0', '..b', -1],
    ['.a', '.b', -1],
    ['.', '.', 0],
  ])('orders %s against %s as %s', (a, b, order) => {
    // `+ 0` reads -0 as 0.
    expect(Math.sign(compareVersionText(a, b)) + 0).toBe(order)
    expect(Math.sign(compareVersionText(b, a)) + 0).toBe(-order + 0)
  })
})

describe('the open pull request check', () => {
  const PR = 'https://github.com/octo/app/pull/7'

  it.each([
    ['its own branch', 'fix/dependabot-undici-6x', 'open PR exists'],
    [
      'the flat twin, under the slash style',
      'fix-dependabot-undici-6x',
      'open PR exists (flat-scheme branch fix-dependabot-undici-6x)',
    ],
  ])('skips the line whose PR is open on %s', async (_case, head, reason) => {
    const { actionable, skipped } = await answer(['octo/app'], { prs: { [head]: PR } })
    expect(named(actionable)).toEqual(['fix/dependabot-undici-7x', 'fix/dependabot-lodash-4x'])
    expect(
      skipped.filter((group) => group.open_pr_url === PR).map((group) => group.reason),
    ).toEqual([reason])
  })

  it('names the first pull request that the search finds', async () => {
    const { skipped } = await answer(['octo/app'], {
      prs: { 'fix/dependabot-lodash-4x': PR },
      later: ['https://github.com/octo/app/pull/8'],
    })
    expect(
      skipped.filter((group) => group.package === 'lodash').map((group) => group.open_pr_url),
    ).toEqual([PR])
  })

  it('applies a PR on the legacy name to the newest line only', async () => {
    const { actionable, skipped } = await answer(['octo/app'], {
      prs: { 'fix/dependabot-undici': PR },
    })
    expect(named(actionable)).toEqual(['fix/dependabot-undici-6x', 'fix/dependabot-lodash-4x'])
    expect(
      skipped.filter((group) => group.open_pr_url === PR).map((group) => group.major_line),
    ).toEqual(['7'])
    expect(skipped.find((group) => group.open_pr_url === PR)?.reason).toBe(
      'open PR exists (legacy branch fix/dependabot-undici)',
    )
  })

  it('applies a PR on the legacy name to line 10, and not to line 9', async () => {
    const { skipped } = await answer(['octo/app'], {
      alerts: [alert(1, 'x', '9.1.0'), alert(2, 'x', '10.1.0')],
      prs: { 'fix/dependabot-x': PR },
    })
    expect(skipped.map((group) => [group.major_line, group.reason])).toEqual([
      ['10', 'open PR exists (legacy branch fix/dependabot-x)'],
    ])
  })

  it('names a PR on the own flat branch under the flat style as open PR exists', async () => {
    const { skipped } = await answer(['--branch-style', 'flat', 'octo/app'], {
      prs: { 'fix-dependabot-undici-6x': PR },
    })
    expect(
      skipped.filter((group) => group.open_pr_url === PR).map((group) => group.reason),
    ).toEqual(['open PR exists'])
  })

  it('stops at a search that fails, and does not read a later head', async () => {
    const { skipped } = await answer(['octo/app'], {
      alerts: [alert(1, 'x', '1.0.1')],
      search: new GhError('gh pr list failed', 1, { cause: null, detail: 'gh: HTTP 502' }),
      failing: ['fix/dependabot-x-1x'],
      prs: { 'fix-dependabot-x-1x': PR },
    })
    expect(skipped.map((group) => [group.reason, group.error, group.open_pr_url])).toEqual([
      ['PR check failed', 'gh: HTTP 502', undefined],
    ])
  })

  it('names the first head that has a PR: its own, then the flat twin, then the legacy name', async () => {
    const { skipped } = await answer(['octo/app'], {
      prs: {
        'fix-dependabot-undici-7x': 'https://github.com/octo/app/pull/2',
        'fix/dependabot-undici': 'https://github.com/octo/app/pull/3',
        'fix-dependabot-lodash-4x': 'https://github.com/octo/app/pull/4',
        'fix/dependabot-lodash-4x': 'https://github.com/octo/app/pull/5',
      },
    })
    expect(skipped.map((group) => group.open_pr_url)).toEqual([
      undefined,
      'https://github.com/octo/app/pull/2',
      'https://github.com/octo/app/pull/5',
    ])
  })

  it('asks the flat style only for flat names', async () => {
    const { result, asked } = discover(['--branch-style', 'flat', 'octo/app'], {
      prs: { 'fix/dependabot-undici-7x': PR, 'fix/dependabot-lodash': PR },
    })
    const { value } = (await result) as unknown as { value: { actionable: Group[] } }
    expect(value.actionable).toHaveLength(3)
    expect([...new Set(asked)].sort()).toEqual([
      'github.com/octo/app head:fix-dependabot-lodash-4x',
      'github.com/octo/app head:fix-dependabot-undici-6x',
      'github.com/octo/app head:fix-dependabot-undici-7x',
    ])
  })

  it('asks the slash style for the flat twin of each line, and the legacy name of the newest', async () => {
    const { result, asked } = discover(['octo/app'])
    await result
    expect([...new Set(asked)].sort()).toEqual([
      'github.com/octo/app head:fix-dependabot-lodash-4x',
      'github.com/octo/app head:fix-dependabot-undici-6x',
      'github.com/octo/app head:fix-dependabot-undici-7x',
      'github.com/octo/app head:fix/dependabot-lodash',
      'github.com/octo/app head:fix/dependabot-lodash-4x',
      'github.com/octo/app head:fix/dependabot-undici',
      'github.com/octo/app head:fix/dependabot-undici-6x',
      'github.com/octo/app head:fix/dependabot-undici-7x',
    ])
  })

  it('never asks about a line with no fix', async () => {
    const { result, asked } = discover(['octo/app'], { alerts: [alert(1, 'x', null)] })
    await result
    expect(asked).toEqual([])
  })

  it('reads a PR with an empty url as no PR', async () => {
    const { actionable } = await answer(['octo/app'], {
      alerts: [alert(1, 'x', '1.0.1')],
      prs: { 'fix/dependabot-x-1x': '' },
    })
    expect(named(actionable)).toEqual(['fix/dependabot-x-1x'])
  })

  it('skips each line with PR check failed and the words of gh when the search fails', async () => {
    const { actionable, skipped } = await answer(['octo/app'], {
      search: new GhError('gh pr list failed', 1, {
        cause: null,
        detail: 'gh: could not resolve to a Repository',
      }),
    })
    expect(actionable).toEqual([])
    expect(skipped.map((group) => [group.branch_name, group.reason, group.error])).toEqual([
      ['fix/dependabot-left-pad-unfixed', 'no fix available', undefined],
      ['fix/dependabot-undici-7x', 'PR check failed', 'gh: could not resolve to a Repository'],
      ['fix/dependabot-undici-6x', 'PR check failed', 'gh: could not resolve to a Repository'],
      ['fix/dependabot-lodash-4x', 'PR check failed', 'gh: could not resolve to a Repository'],
    ])
  })

  it('lets a search error that is not a GhError through', async () => {
    await expect(refusal(['octo/app'], { search: new Error('a defect') })).rejects.toThrow(
      'a defect',
    )
  })
})

describe('alerts on stdin (#54)', () => {
  const PAGES = JSON.stringify([ALERTS.slice(0, 2), [], ALERTS.slice(2)])

  it.each([
    ['slash', []],
    ['flat', ['--branch-style', 'flat']],
  ])('gives the answer of the fetch for the same alerts, %s style', async (_style, style) => {
    const fetched = await answer([...style, 'octo/app'])
    expect(await answer(['--stdin', ...style, 'octo/app'], {}, { stdin: PAGES })).toEqual(fetched)
    expect(
      await answer(['--stdin', ...style, 'octo/app'], {}, { stdin: JSON.stringify(ALERTS) }),
    ).toEqual(fetched)
  })

  it('reads nested pages, as jq flatten does', async () => {
    const fetched = await answer(['octo/app'])
    const nested = JSON.stringify([[[ALERTS[0]], [ALERTS[1]]], ALERTS.slice(2)])
    expect(await answer(['--stdin', 'octo/app'], {}, { stdin: nested })).toEqual(fetched)
    const deep = JSON.stringify([[[[ALERTS[0]]], ALERTS[1]], ALERTS.slice(2)])
    expect(await answer(['--stdin', 'octo/app'], {}, { stdin: deep })).toEqual(fetched)
  })

  it('never asks the alerts endpoint', async () => {
    const result = await answer(
      ['--stdin', 'octo/app'],
      { alerts: new Error('the alerts endpoint must not be asked') },
      { stdin: PAGES },
    )
    expect(result.actionable).toHaveLength(3)
  })

  it('still asks for the open PRs, and skips a line that has one', async () => {
    const { result, asked } = discover(
      ['--stdin', 'octo/app'],
      { prs: { 'fix/dependabot-lodash-4x': 'https://github.com/octo/app/pull/1' } },
      { stdin: PAGES },
    )
    const value = (await result) as unknown as { value: { skipped: Group[] } }
    expect(asked).toContain('github.com/octo/app head:fix/dependabot-lodash-4x')
    expect(value.value.skipped.map((group) => group.reason)).toContain('open PR exists')
  })

  it('still reports a search that fails, and never reads it as no PR', async () => {
    const search = new GhError('gh pr list failed', 1, { cause: null, detail: 'gh: HTTP 502' })
    const { actionable, skipped } = await answer(
      ['--stdin', 'octo/app'],
      { search },
      { stdin: PAGES },
    )
    expect(actionable).toEqual([])
    expect(skipped.filter((group) => group.reason === 'PR check failed')).toHaveLength(3)
  })

  it('accepts an alert whose repository is the target, in any case', async () => {
    const own = { ...ALERTS[0], repository: { full_name: 'Octo/App' } }
    const { actionable } = await answer(
      ['--stdin', 'octo/app'],
      {},
      {
        stdin: JSON.stringify([[own, { ...ALERTS[4], repository: null }]]),
      },
    )
    expect(named(actionable)).toEqual(['fix/dependabot-undici-7x', 'fix/dependabot-lodash-4x'])
  })

  it.each([
    ['text that is not JSON', 'not json', 'Invalid JSON on stdin for octo/app'],
    ['empty stdin', '', 'Invalid JSON on stdin for octo/app'],
    [
      'an error object',
      '{"message":"Not Found"}',
      'Unexpected alerts on stdin for octo/app: Not Found',
    ],
    ['a number', '5', 'Unexpected alerts on stdin for octo/app: not a JSON array'],
    ['null', 'null', 'Unexpected alerts on stdin for octo/app: not a JSON array'],
    [
      'an object whose message is not text',
      '{"message":5}',
      'Unexpected alerts on stdin for octo/app: not a JSON array',
    ],
    [
      'a null alert',
      JSON.stringify([[ALERTS[0], null]]),
      'Unexpected alerts for octo/app: an alert is not an object: null',
    ],
    [
      'an alert that is text',
      JSON.stringify(['x']),
      'Unexpected alerts for octo/app: an alert is not an object: "x"',
    ],
    [
      'an alert of another repository',
      JSON.stringify([{ ...ALERTS[0], repository: { full_name: 'octo/other' } }]),
      'Unexpected alerts for octo/app: an alert names another repository: {"full_name":"octo/other"}',
    ],
    [
      'an alert whose repository is empty text',
      JSON.stringify([{ ...ALERTS[0], repository: '' }]),
      'Unexpected alerts for octo/app: an alert names another repository: ""',
    ],
    [
      'an alert whose repository is false',
      JSON.stringify([{ ...ALERTS[0], repository: false }]),
      'Unexpected alerts for octo/app: an alert names another repository: false',
    ],
    [
      'an alert whose repository has no name',
      JSON.stringify([{ ...ALERTS[0], repository: 'octo/app' }]),
      'Unexpected alerts for octo/app: an alert names another repository: "octo/app"',
    ],
  ])('refuses %s', async (_case, stdin, said) => {
    expect(await refusal(['--stdin', 'octo/app'], {}, { stdin })).toEqual(failed(said))
  })
})

describe('the refusals', () => {
  it.each([
    ['no target', []],
    ['two targets', ['octo/app', 'octo/other']],
  ])('refuses %s with the usage line', async (_case, args) => {
    expect(await refusal(args)).toEqual(failed(USAGE))
  })

  it.each([['octo'], ['a/b/c'], ['a b/c'], ['/app'], ['octo/'], ['']])(
    'refuses the target %j, which is not <owner>/<repo>',
    async (target) => {
      expect(await refusal([target])).toEqual(
        failed(`discover-alerts needs the repository as <owner>/<repo>: ${target}`),
      )
    },
  )

  it('refuses an unknown option, and the withdrawn --scope', async () => {
    expect((await refusal(['--scope', 'repo', 'octo/app']))?.outcome).toBe('failed')
  })

  it('refuses an unknown branch style', async () => {
    expect(await refusal(['--branch-style', 'diagonal', 'octo/app'])).toEqual(
      failed('--branch-style must be one of slash, flat, not "diagonal"'),
    )
  })

  it('reports a fetch that failed, and never reads it as no alerts', async () => {
    const alerts = new GhError('gh api failed', 1, {
      cause: null,
      detail: 'gh: Not Found (HTTP 404)',
    })
    expect(await refusal(['octo/app'], { alerts })).toEqual(
      failed('Failed to fetch alerts for octo/app: gh: Not Found (HTTP 404)'),
    )
  })

  it('reports an answer that is not the promised shape as unexpected', async () => {
    const alerts = new GhError('not pages', 0, {
      cause: null,
      detail: 'gh answered something else',
    })
    expect(await refusal(['octo/app'], { alerts })).toEqual(
      failed('Unexpected API response for octo/app: gh answered something else'),
    )
  })

  it('reports a read error on exit 0 as a failed fetch, not as an unexpected answer', async () => {
    const runner: Runner = async () =>
      ({
        status: 0,
        signal: null,
        stdout: '[[',
        stderr: '',
        combined: '[[',
        timedOut: false,
        elapsedMs: 0,
        startFailure: null,
        streamErrors: [{ code: 'ECONNRESET', message: 'read ECONNRESET' }],
      }) satisfies RunResult
    expect(
      await discoverAlerts(context(['octo/app']), createGhClient, runner, selectAdapter),
    ).toEqual(
      failed(
        "Failed to fetch alerts for octo/app: gh's output could not be read: ECONNRESET, read ECONNRESET",
      ),
    )
  })

  it('lets a fetch error that is not a GhError through', async () => {
    await expect(refusal(['octo/app'], { alerts: new Error('a defect') })).rejects.toThrow(
      'a defect',
    )
  })
})

describe('--env-prefix', () => {
  /** A runner that records each call, and answers the alerts or an empty search. */
  const recording = () => {
    const calls: { command: string; args: readonly string[] }[] = []
    const envs: unknown[] = []
    const runner: Runner = async (command, args = [], options) => {
      calls.push({ command, args })
      envs.push(options?.env)
      const stdout = args.includes('api') ? JSON.stringify([[ALERTS[4]]]) : '[]'
      return {
        status: 0,
        signal: null,
        stdout,
        stderr: '',
        combined: stdout,
        timedOut: false,
        elapsedMs: 0,
        startFailure: null,
        streamErrors: [],
      } satisfies RunResult
    }
    return { calls, envs, runner }
  }

  it('wraps every gh call, and names the host in each', async () => {
    const { calls, envs, runner } = recording()
    const result = await discoverAlerts(
      context(['--env-prefix', 'envwrap --flag', 'octo/app']),
      createGhClient,
      runner,
      selectAdapter,
    )
    expect(result?.outcome).toBe('ok')
    expect(calls).toEqual([
      {
        command: 'envwrap',
        args: [
          '--flag',
          'gh',
          'api',
          '--hostname',
          'github.com',
          'repos/octo/app/dependabot/alerts?state=open&per_page=100',
          '--paginate',
          '--slurp',
        ],
      },
      ...['fix/dependabot-lodash-4x', 'fix-dependabot-lodash-4x', 'fix/dependabot-lodash'].map(
        (head) => ({
          command: 'envwrap',
          args: [
            '--flag',
            'gh',
            'pr',
            'list',
            '--repo',
            'github.com/octo/app',
            '--search',
            `head:${head}`,
            '--state',
            'open',
            '--json',
            'url',
          ],
        }),
      ),
    ])
    expect(envs).toEqual(calls.map(() => ({ PATH: '/bin' })))
  })

  it('runs gh bare with no prefix', async () => {
    const { calls, runner } = recording()
    await discoverAlerts(context(['octo/app']), createGhClient, runner, selectAdapter)
    expect(new Set(calls.map((call) => call.command))).toEqual(new Set(['gh']))
  })
})

describe('the registered handler', () => {
  it('runs with the real client, the real runner and the real registry', async () => {
    const sandbox = createSandbox()
    const context_: CommandContext = {
      ...context(['octo/app']),
      env: { PATH: sandbox.pathWithout('gh') },
    }
    expect(await discoverAlertsCommand(context_)).toEqual(
      failed('Failed to fetch alerts for octo/app: cannot run gh: spawn gh ENOENT'),
    )
  })
})

describe('the process', () => {
  const spawnCli = (args: readonly string[], stdin?: string) => {
    const sandbox = createSandbox()
    sandbox.env.PATH = sandbox.pathWithout('gh')
    return run(process.execPath, [ENTRY, 'discover-alerts', ...args], {
      env: sandbox.env,
      stdin,
    })
  }

  it('reads the alerts on stdin, and reports a search that cannot run as a skip', async () => {
    const result = await spawnCli(['--stdin', 'octo/app'], JSON.stringify([[ALERTS[4]]]))
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout) as { actionable: Group[]; skipped: Group[] }
    expect(out.actionable).toEqual([])
    expect(out.skipped.map((group) => [group.reason, group.error])).toEqual([
      ['PR check failed', 'cannot run gh: spawn gh ENOENT'],
    ])
  })

  it('exits 1 with the error as JSON on stdout and as prose on stderr', async () => {
    const result = await spawnCli(['--stdin', 'octo/app'], 'not json')
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: 'Invalid JSON on stdin for octo/app' })
    expect(result.stderr).toBe('Invalid JSON on stdin for octo/app\n')
  })
})
