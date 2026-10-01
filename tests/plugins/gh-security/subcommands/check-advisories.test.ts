// `gh-security check-advisories`. The seam is the exported handler, with the
// `gh` client factory, the process runner and the registry as parameters.
// `gh` is the one mock boundary (`mocking.md`). Range semantics come from the
// real node adapter, except in the examples about a verb that fails, where a
// stand-in adapter fails on purpose. The advisories are written by hand from
// the shape that the advisories endpoint gives. The expected values are
// written by hand from the contract in the header of the command. The bash
// script is compared in `parity-check-advisories.test.ts`.
import { describe, expect, it } from 'vitest'

import type { Adapter } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { failed, ok } from '#gh-security/lib/envelope.ts'
import { createGhClient } from '#gh-security/lib/gh.ts'
import { type Runner, type RunResult, run } from '#gh-security/lib/process.ts'
import {
  type ClientFactory,
  checkAdvisories,
  checkAdvisoriesCommand,
} from '#gh-security/subcommands/check-advisories.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

const USAGE =
  'usage: gh-security check-advisories [--env-prefix <prefix>] [--ecosystem <eco>] ' +
  '[--version <v>] <package>'

type Advisory = Record<string, unknown>

const vuln = (name: string, range: string | null, patched: unknown = null, ecosystem = 'npm') => ({
  package: { ecosystem, name },
  vulnerable_version_range: range,
  first_patched_version: patched,
})

const advisory = (id: string, fields: Advisory = {}): Advisory => ({
  ghsa_id: id,
  cve_id: null,
  severity: 'high',
  type: 'reviewed',
  withdrawn_at: null,
  published_at: '2021-02-15T00:00:00Z',
  summary: `summary of ${id}`,
  html_url: `https://github.com/advisories/${id}`,
  vulnerabilities: [],
  ...fields,
})

/** Lodash, as the advisories endpoint gives it: three advisories, a withdrawn one, a sibling. */
const LODASH: Advisory[] = [
  advisory('GHSA-aaaa-1111-bbbb', {
    cve_id: 'CVE-2019-10744',
    severity: 'critical',
    vulnerabilities: [vuln('lodash', '< 4.17.12', '4.17.12')],
  }),
  advisory('GHSA-cccc-2222-dddd', {
    vulnerabilities: [vuln('lodash', '< 4.17.21', '4.17.21'), vuln('lodash-es', '< 4.17.21')],
  }),
  advisory('GHSA-eeee-3333-ffff', {
    severity: 'moderate',
    vulnerabilities: [vuln('lodash', '>= 3.0.0, < 4.17.19', { identifier: '4.17.19' })],
  }),
  advisory('GHSA-gggg-4444-hhhh', {
    severity: 'low',
    withdrawn_at: '2022-01-01T00:00:00Z',
    vulnerabilities: [vuln('lodash', '< 99.0.0')],
  }),
]

const context = (args: readonly string[]): CommandContext => ({
  args,
  env: { PATH: '/bin' },
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const noProcess: Runner = () => Promise.reject(new Error('the mock client starts no process'))

const factoryOf =
  (replies: GhReplies): ClientFactory =>
  () =>
    createGhMock(replies)

/** The command on the mock, the real registry and a runner that must not start. */
const check = (
  args: readonly string[],
  advisories: readonly Advisory[] = LODASH,
  route: typeof selectAdapter = selectAdapter,
): Promise<CommandResult> =>
  checkAdvisories(context(args), factoryOf({ listAdvisories: advisories }), noProcess, route)

const value = (result: CommandResult): Record<string, unknown> => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value as Record<string, unknown>
}

/** A registry whose node adapter answers `range_facts` as `facts` says. */
const withFacts =
  (facts: Adapter<NodeDetection>['rangeFacts']): typeof selectAdapter =>
  (ecosystem, manifest = null) => {
    const real = selectAdapter(ecosystem, manifest)
    return real.supported ? { ...real, adapter: { ...node, rangeFacts: facts } } : real
  }

const facts = (
  range: string,
  version: string,
  fields: Record<string, unknown> = {},
): ReturnType<Adapter<NodeDetection>['rangeFacts']> =>
  ok({
    range,
    version,
    parseable: true,
    satisfied: false,
    pinned: false,
    floor_major: 1,
    majors_ahead: 0,
    ...fields,
  } as never)

describe('the listing', () => {
  it('has every field, read from the advisories', async () => {
    const answer = value(await check(['lodash']))
    expect(answer).toEqual({
      package: 'lodash',
      ecosystem: 'npm',
      advisory_count: 3,
      withdrawn_excluded: 1,
      vulnerable_ranges: ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'],
      advisories: [
        {
          ghsa_id: 'GHSA-aaaa-1111-bbbb',
          cve_id: 'CVE-2019-10744',
          severity: 'critical',
          type: 'reviewed',
          published_at: '2021-02-15T00:00:00Z',
          summary: 'summary of GHSA-aaaa-1111-bbbb',
          url: 'https://github.com/advisories/GHSA-aaaa-1111-bbbb',
          vulnerable_version_range: '< 4.17.12',
          first_patched_version: '4.17.12',
        },
        {
          ghsa_id: 'GHSA-cccc-2222-dddd',
          cve_id: null,
          severity: 'high',
          type: 'reviewed',
          published_at: '2021-02-15T00:00:00Z',
          summary: 'summary of GHSA-cccc-2222-dddd',
          url: 'https://github.com/advisories/GHSA-cccc-2222-dddd',
          vulnerable_version_range: '< 4.17.21',
          first_patched_version: '4.17.21',
        },
        {
          ghsa_id: 'GHSA-eeee-3333-ffff',
          cve_id: null,
          severity: 'moderate',
          type: 'reviewed',
          published_at: '2021-02-15T00:00:00Z',
          summary: 'summary of GHSA-eeee-3333-ffff',
          url: 'https://github.com/advisories/GHSA-eeee-3333-ffff',
          vulnerable_version_range: '>= 3.0.0, < 4.17.19',
          first_patched_version: '4.17.19',
        },
      ],
      version: null,
      matched_ranges: [],
      unevaluated_ranges: [],
      adapter_errors: [],
      verdict: null,
    })
  })

  it('keeps only the entries for the package, matched by name and by ecosystem', async () => {
    const answer = value(
      await check(
        ['lodash'],
        [
          advisory('GHSA-aaaa-1111-bbbb', {
            vulnerabilities: [
              vuln('lodash', '< 1.0.0'),
              vuln('lodash-es', '< 2.0.0'),
              vuln('Lodash', '< 3.0.0'),
              vuln('lodash', '< 4.0.0', null, 'pip'),
            ],
          }),
        ],
      ),
    )
    expect(answer.vulnerable_ranges).toEqual(['< 1.0.0'])
    expect(answer.advisory_count).toBe(1)
  })

  it('counts each matching entry, so one advisory with two entries counts twice', async () => {
    const answer = value(
      await check(
        ['lodash'],
        [
          advisory('GHSA-aaaa-1111-bbbb', {
            vulnerabilities: [vuln('lodash', '< 1'), vuln('lodash', '< 2')],
          }),
        ],
      ),
    )
    expect(answer.advisory_count).toBe(2)
  })

  it('drops an advisory that has no entry for the package, with or without a list', async () => {
    const answer = value(
      await check(
        ['lodash'],
        [
          advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: null }),
          advisory('GHSA-cccc-2222-dddd', { vulnerabilities: undefined }),
          advisory('GHSA-eeee-3333-ffff', {
            vulnerabilities: [{ vulnerable_version_range: '< 1' }, { package: null }],
          }),
        ],
      ),
    )
    expect(answer).toMatchObject({
      advisory_count: 0,
      withdrawn_excluded: 0,
      verdict: 'no-advisories',
    })
  })

  it('counts a withdrawn advisory that is about the package, and no other', async () => {
    const answer = value(
      await check(
        ['lodash'],
        [
          advisory('GHSA-aaaa-1111-bbbb', {
            withdrawn_at: '2022-01-01T00:00:00Z',
            vulnerabilities: [vuln('lodash', '< 1')],
          }),
          advisory('GHSA-cccc-2222-dddd', {
            withdrawn_at: '2022-01-01T00:00:00Z',
            vulnerabilities: [vuln('other', '< 1')],
          }),
        ],
      ),
    )
    expect(answer).toMatchObject({
      withdrawn_excluded: 1,
      advisory_count: 0,
      vulnerable_ranges: [],
    })
  })

  it('reads a missing withdrawn_at as not withdrawn', async () => {
    const withdrawnAt = advisory('GHSA-aaaa-1111-bbbb', {
      vulnerabilities: [vuln('lodash', '< 1')],
    })
    delete withdrawnAt.withdrawn_at
    expect(value(await check(['lodash'], [withdrawnAt])).advisory_count).toBe(1)
  })

  it.each([
    ['a string', '4.17.12', '4.17.12'],
    ['an object with an identifier', { identifier: '4.17.12' }, '4.17.12'],
    ['an object with none', {}, null],
    ['null', null, null],
    ['nothing', undefined, null],
  ])('reads first_patched_version as %s', async (_name, patched, expected) => {
    const answer = value(
      await check(
        ['lodash'],
        [advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [vuln('lodash', '< 1', patched)] })],
      ),
    ) as { advisories: Advisory[] }
    expect(answer.advisories[0]?.first_patched_version).toBe(expected)
  })

  it('reads a missing field of an advisory as null', async () => {
    const bare = { vulnerabilities: [{ package: { name: 'lodash', ecosystem: 'npm' } }] }
    const answer = value(await check(['lodash'], [bare])) as { advisories: Advisory[] }
    expect(answer.advisories).toEqual([
      {
        ghsa_id: null,
        cve_id: null,
        severity: null,
        type: null,
        published_at: null,
        summary: null,
        url: null,
        vulnerable_version_range: null,
        first_patched_version: null,
      },
    ])
    expect(value(await check(['lodash'], [bare])).vulnerable_ranges).toEqual([])
    expect(value(await check(['lodash'], [bare])).verdict).toBeNull()
  })

  it('counts an advisory that has no range, so a version reads safe', async () => {
    const bare = { vulnerabilities: [{ package: { name: 'lodash', ecosystem: 'npm' } }] }
    expect(value(await check(['--version', '1.0.0', 'lodash'], [bare]))).toMatchObject({
      advisory_count: 1,
      vulnerable_ranges: [],
      verdict: 'safe',
    })
  })

  it('reads a range that is null as no range, and keeps the advisory', async () => {
    const nullRange = advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [vuln('lodash', null)] })
    expect(value(await check(['lodash'], [nullRange]))).toMatchObject({
      advisory_count: 1,
      vulnerable_ranges: [],
    })
  })

  // `jq` keeps an empty string, and so does the port: it is a value and not a
  // missing field.
  it('keeps an empty string as a value and not as a missing field', async () => {
    const empty = advisory('GHSA-aaaa-1111-bbbb', {
      cve_id: '',
      severity: '',
      summary: '',
      vulnerabilities: [vuln('lodash', '< 1', '')],
    })
    const answer = value(await check(['lodash'], [empty])) as { advisories: Advisory[] }
    expect(answer.advisories[0]).toMatchObject({
      cve_id: '',
      severity: '',
      summary: '',
      first_patched_version: '',
    })
  })

  // U+FF5E is the bytes EF BD 9E, and U+1F600 is F0 9F 98 80. The default
  // sort compares UTF-16 units, and puts the second one first.
  it('sorts the ranges by the bytes of the text and not by UTF-16 units', async () => {
    const answer = value(
      await check(
        ['lodash'],
        [
          advisory('GHSA-aaaa-1111-bbbb', {
            vulnerabilities: [vuln('lodash', '\u{1F600}'), vuln('lodash', '\uFF5E')],
          }),
        ],
      ),
    )
    expect(answer.vulnerable_ranges).toEqual(['\uFF5E', '\u{1F600}'])
  })

  it('unions the ranges of the advisories, each once, in the byte order of the text', async () => {
    const answer = value(
      await check(
        ['lodash'],
        [
          advisory('GHSA-aaaa-1111-bbbb', {
            vulnerabilities: [vuln('lodash', 'a'), vuln('lodash', '>= 2')],
          }),
          advisory('GHSA-cccc-2222-dddd', {
            vulnerabilities: [vuln('lodash', 'B'), vuln('lodash', 'a')],
          }),
        ],
      ),
    )
    expect(answer.vulnerable_ranges).toEqual(['>= 2', 'B', 'a'])
  })

  it('names the ecosystem it was asked for, and asks for an advisory list of that ecosystem', async () => {
    const asked: { package: string; ecosystem: string }[] = []
    const factory: ClientFactory = () => ({
      ...createGhMock(),
      listAdvisories: async (query) => {
        asked.push(query)
        return []
      },
    })
    const answer = value(
      await checkAdvisories(
        context(['--ecosystem', 'pip', 'lodash']),
        factory,
        noProcess,
        selectAdapter,
      ),
    )
    expect(asked).toEqual([{ package: 'lodash', ecosystem: 'pip' }])
    expect(answer).toMatchObject({ ecosystem: 'pip', verdict: 'no-advisories' })
  })

  it('asks for npm when no ecosystem is given', async () => {
    const asked: string[] = []
    const factory: ClientFactory = () => ({
      ...createGhMock(),
      listAdvisories: async (query) => {
        asked.push(query.ecosystem)
        return []
      },
    })
    await checkAdvisories(context(['lodash']), factory, noProcess, selectAdapter)
    expect(asked).toEqual(['npm'])
  })

  it('lists an ecosystem with no adapter when no version is given', async () => {
    const answer = value(await check(['--ecosystem', 'pip', 'lodash'], []))
    expect(answer).toMatchObject({ ecosystem: 'pip', verdict: 'no-advisories' })
  })
})

describe('the four verdicts', () => {
  const verdict = async (version: string, advisories: readonly Advisory[] = LODASH) =>
    value(await check(['--version', version, 'lodash'], advisories))

  it('is vulnerable when a range admits the version, and names every range that does', async () => {
    expect(await verdict('4.17.11')).toMatchObject({
      verdict: 'vulnerable',
      version: '4.17.11',
      matched_ranges: ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'],
      unevaluated_ranges: [],
    })
  })

  it('is vulnerable for one range alone', async () => {
    expect(await verdict('4.17.20')).toMatchObject({
      verdict: 'vulnerable',
      matched_ranges: ['< 4.17.21'],
    })
  })

  it('is safe when advisories exist, every range was evaluated, and none matched', async () => {
    expect(await verdict('4.17.21')).toMatchObject({
      verdict: 'safe',
      matched_ranges: [],
      unevaluated_ranges: [],
      adapter_errors: [],
    })
  })

  it('is unknown, and never safe, when no range matched and one could not be read', async () => {
    const advisories = [
      advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [vuln('lodash', 'see vendor advisory')] }),
    ]
    expect(await verdict('4.17.21', advisories)).toMatchObject({
      verdict: 'unknown',
      matched_ranges: [],
      unevaluated_ranges: ['see vendor advisory'],
      adapter_errors: [],
    })
  })

  it('is vulnerable, and not unknown, when one range matched and another could not be read', async () => {
    const advisories = [
      advisory('GHSA-aaaa-1111-bbbb', {
        vulnerabilities: [vuln('lodash', 'see vendor advisory'), vuln('lodash', '< 5.0.0')],
      }),
    ]
    expect(await verdict('4.17.21', advisories)).toMatchObject({
      verdict: 'vulnerable',
      matched_ranges: ['< 5.0.0'],
      unevaluated_ranges: ['see vendor advisory'],
    })
  })

  it('is no-advisories, and not safe, when the query returned nothing', async () => {
    expect(await verdict('1.0.0', [])).toMatchObject({
      verdict: 'no-advisories',
      advisory_count: 0,
      vulnerable_ranges: [],
      version: '1.0.0',
    })
  })

  it('is no-advisories when every advisory is withdrawn', async () => {
    const withdrawn = [
      advisory('GHSA-aaaa-1111-bbbb', {
        withdrawn_at: '2022-01-01T00:00:00Z',
        vulnerabilities: [vuln('lodash', '< 5')],
      }),
    ]
    expect(await verdict('1.0.0', withdrawn)).toMatchObject({
      verdict: 'no-advisories',
      withdrawn_excluded: 1,
    })
  })

  it('is null when no version was given', async () => {
    expect(value(await check(['lodash']))).toMatchObject({ verdict: null, version: null })
  })

  it('asks the node adapter for each range, and for nothing else', async () => {
    const asked: [string, string][] = []
    const route = withFacts((range, version) => {
      asked.push([range, version])
      return facts(range, version)
    })
    await check(['--version', '4.17.21', 'lodash'], LODASH, route)
    expect(asked).toEqual([
      ['< 4.17.12', '4.17.21'],
      ['< 4.17.21', '4.17.21'],
      ['>= 3.0.0, < 4.17.19', '4.17.21'],
    ])
  })

  it('asks the adapter nothing when no version was given', async () => {
    const route = withFacts(() => {
      throw new Error('range_facts must not run')
    })
    expect(value(await check(['lodash'], LODASH, route)).verdict).toBeNull()
  })

  const refused = (shown: string) =>
    `range_facts gave parseable true and a satisfied that is not true or false (ADR 001): ${shown}`

  // Ruling 12 on #225. The script read these as no match, and a package could
  // read `safe`. A range that has no truth value was not evaluated.
  it.each([
    ['null', null, 'null'],
    ['the word true', 'true', '"true"'],
    ['the number 1', 1, '1'],
  ])(
    'reads a parseable range with %s as satisfied as unevaluated, never safe',
    async (_name, satisfied, shown) => {
      const route = withFacts((range, version) => facts(range, version, { satisfied }))
      const answer = value(await check(['--version', '1.0.0', 'lodash'], LODASH, route))
      expect(answer).toMatchObject({
        verdict: 'unknown',
        matched_ranges: [],
        unevaluated_ranges: ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'],
      })
      expect(answer.adapter_errors).toEqual(
        ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'].map((range) => ({
          range,
          status: 1,
          error: refused(shown),
        })),
      )
    },
  )

  it('is vulnerable, and not unknown, when one range matched and another has no truth value', async () => {
    const route = withFacts((range, version) =>
      facts(range, version, { satisfied: range === '< 4.17.12' ? true : null }),
    )
    expect(value(await check(['--version', '1.0.0', 'lodash'], LODASH, route))).toMatchObject({
      verdict: 'vulnerable',
      matched_ranges: ['< 4.17.12'],
    })
  })

  it('keeps a false satisfied as an evaluated range with no match', async () => {
    const answer = value(await check(['--version', '9.0.0', 'lodash']))
    expect(answer).toMatchObject({ verdict: 'safe', unevaluated_ranges: [], adapter_errors: [] })
  })

  it('reads a range that is not parseable as unevaluated, whatever it says of satisfied', async () => {
    const route = withFacts((range, version) =>
      facts(range, version, { parseable: false, satisfied: true }),
    )
    expect(value(await check(['--version', '1.0.0', 'lodash'], LODASH, route))).toMatchObject({
      verdict: 'unknown',
      matched_ranges: [],
      unevaluated_ranges: ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'],
    })
  })

  // #302 item 4. A `parseable` that is not true or false is malformed, and
  // goes into `adapter_errors` as a bad `satisfied` does (ruling 12). A
  // `parseable` of false is an honest answer, and adds no entry.
  it.fails.each([
    ['null', null, 'null'],
    ['the word true', 'true', '"true"'],
    ['the number 1', 1, '1'],
  ])(
    'records a parseable of %s in adapter_errors, and never reads the range as safe',
    async (_name, parseable, shown) => {
      const route = withFacts((range, version) => facts(range, version, { parseable }))
      const answer = value(await check(['--version', '1.0.0', 'lodash'], LODASH, route))
      expect(answer).toMatchObject({
        verdict: 'unknown',
        matched_ranges: [],
        unevaluated_ranges: ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'],
      })
      expect(answer.adapter_errors).toEqual(
        ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'].map((range) => ({
          range,
          status: 1,
          error: `range_facts gave a parseable that is not true or false (ADR 001): ${shown}`,
        })),
      )
    },
  )

  it('adds no adapter_errors entry for a parseable of false', async () => {
    const route = withFacts((range, version) => facts(range, version, { parseable: false }))
    expect(
      value(await check(['--version', '1.0.0', 'lodash'], LODASH, route)).adapter_errors,
    ).toEqual([])
  })

  it('reads the word true in a string as not parseable', async () => {
    const route = withFacts((range, version) => facts(range, version, { parseable: 'true' }))
    expect(value(await check(['--version', '1.0.0', 'lodash'], LODASH, route))).toMatchObject({
      verdict: 'unknown',
      matched_ranges: [],
    })
  })
})

describe('a verb that fails', () => {
  const broken = (message: string, outcome: 'failed' | 'unsupported' | 'not-implemented') =>
    withFacts(() =>
      outcome === 'failed'
        ? failed(message)
        : outcome === 'unsupported'
          ? { outcome, error: message, unsupported: 'node' }
          : { outcome, error: message },
    )

  it('keeps what the adapter said, with its exit status, and never calls the version safe', async () => {
    const answer = value(
      await check(
        ['--version', '4.17.21', 'lodash'],
        LODASH,
        broken('jq: command not found', 'failed'),
      ),
    )
    expect(answer).toMatchObject({
      verdict: 'unknown',
      matched_ranges: [],
      unevaluated_ranges: ['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'],
    })
    expect(answer.adapter_errors).toEqual([
      { range: '< 4.17.12', status: 1, error: 'jq: command not found' },
      { range: '< 4.17.21', status: 1, error: 'jq: command not found' },
      { range: '>= 3.0.0, < 4.17.19', status: 1, error: 'jq: command not found' },
    ])
  })

  it.each([
    ['not-implemented', 2],
    ['unsupported', 3],
  ] as const)('carries the exit status of a %s verb: %i', async (outcome, status) => {
    const answer = value(
      await check(['--version', '1.0.0', 'lodash'], LODASH, broken('no', outcome)),
    ) as { adapter_errors: { status: number }[] }
    expect(answer.adapter_errors.map((entry) => entry.status)).toEqual([status, status, status])
  })

  it('joins the lines of the message, cuts it at 300 characters and trims the end', async () => {
    const long = `first line\nsecond line${'x'.repeat(400)}`
    const answer = value(
      await check(['--version', '1.0.0', 'lodash'], LODASH, broken(long, 'failed')),
    ) as { adapter_errors: { error: string }[] }
    expect(answer.adapter_errors[0]?.error).toBe(`first line second line${'x'.repeat(278)}`)
    const threeLines = value(
      await check(['--version', '1.0.0', 'lodash'], LODASH, broken('a\nb\nc', 'failed')),
    ) as { adapter_errors: { error: string }[] }
    expect(threeLines.adapter_errors[0]?.error).toBe('a b c')
    const spaced = value(
      await check(
        ['--version', '1.0.0', 'lodash'],
        LODASH,
        broken('ends with space \n\t ', 'failed'),
      ),
    ) as { adapter_errors: { error: string }[] }
    expect(spaced.adapter_errors[0]?.error).toBe('ends with space')
    const cut = value(
      await check(
        ['--version', '1.0.0', 'lodash'],
        LODASH,
        broken(`${'x'.repeat(299)} tail`, 'failed'),
      ),
    ) as { adapter_errors: { error: string }[] }
    expect(cut.adapter_errors[0]?.error).toBe('x'.repeat(299))
  })

  it('is an error when range_facts omits parseable or satisfied', async () => {
    for (const missing of ['parseable', 'satisfied']) {
      const route = withFacts((range, version) => {
        const answer = facts(range, version)
        if (answer.outcome !== 'ok') return answer
        const { [missing as 'parseable']: _gone, ...rest } = answer.value
        return ok(rest as never)
      })
      expect(await check(['--version', '1.0.0', 'lodash'], LODASH, route)).toEqual({
        outcome: 'failed',
        error:
          "check-advisories: adapter's range_facts omitted parseable/satisfied for '< 4.17.12'; " +
          'the contract requires both (ADR 001).',
      })
    }
  })
})

describe('a refusal', () => {
  it.each([
    ['no package', []],
    ['an empty package', ['']],
    ['an empty ecosystem', ['--ecosystem', '', 'lodash']],
    ['an empty version', ['--version', '', 'lodash']],
    ['only options', ['--ecosystem', 'npm']],
  ])('answers the usage line for %s', async (_name, args) => {
    expect(await check(args)).toEqual({ outcome: 'failed', error: USAGE })
  })

  it('refuses --adapter, which names a path that an in-process adapter does not have', async () => {
    expect(await check(['--adapter', '/x/node.sh', '--version', '1.0.0', 'lodash'])).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('--adapter'),
    })
  })

  it('refuses an option it does not know', async () => {
    expect(await check(['--nope', 'lodash'])).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('--nope'),
    })
  })

  it('refuses a version for an ecosystem with no adapter, as unsupported, and asks GitHub nothing', async () => {
    // No reply is registered for GitHub, so a call to it throws.
    const result = await checkAdvisories(
      context(['--ecosystem', 'pip', '--version', '1.0.0', 'requests']),
      factoryOf({}),
      noProcess,
      selectAdapter,
    )
    expect(result).toEqual({
      outcome: 'unsupported',
      unsupported: 'pip',
      error:
        'check-advisories cannot evaluate ranges for the ecosystem pip: ' +
        'ecosystem not supported yet. See .github/CONTRIBUTING.md to request support.',
    })
  })

  it('reports a failure of gh with the words gh wrote, and not an empty list', async () => {
    const result = await checkAdvisories(
      context(['lodash']),
      factoryOf({ listAdvisories: ghFails('gh: HTTP 503') }),
      noProcess,
      selectAdapter,
    )
    expect(result).toEqual({
      outcome: 'failed',
      error: 'Failed to fetch advisories for lodash (npm): gh: HTTP 503',
    })
  })

  it('rethrows what is not a failure of gh, as a defect', async () => {
    await expect(
      checkAdvisories(
        context(['lodash']),
        factoryOf({ listAdvisories: new Error('a defect, not a gh failure') }),
        noProcess,
        selectAdapter,
      ),
    ).rejects.toThrow('a defect, not a gh failure')
  })

  it.each([
    [
      'a vulnerabilities field that is not a list',
      advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: 'x' }),
      'the vulnerabilities of GHSA-aaaa-1111-bbbb are not a list of objects',
    ],
    [
      'a vulnerabilities list that holds a non-object',
      advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [1] }),
      'the vulnerabilities of GHSA-aaaa-1111-bbbb are not a list of objects',
    ],
    [
      'a vulnerabilities list that holds an object and a non-object',
      advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [vuln('lodash', '< 1'), 1] }),
      'the vulnerabilities of GHSA-aaaa-1111-bbbb are not a list of objects',
    ],
    [
      'a vulnerabilities list that holds a list',
      advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [[]] }),
      'the vulnerabilities of GHSA-aaaa-1111-bbbb are not a list of objects',
    ],
    [
      'a package that is a list',
      advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [{ package: [] }] }),
      'a vulnerability has a package that is not an object',
    ],
    [
      'a package that is not an object',
      advisory('GHSA-aaaa-1111-bbbb', { vulnerabilities: [{ package: 'lodash' }] }),
      'a vulnerability has a package that is not an object',
    ],
    [
      'a range that is not text',
      advisory('GHSA-aaaa-1111-bbbb', {
        vulnerabilities: [{ ...vuln('lodash', null), vulnerable_version_range: 5 }],
      }),
      'a vulnerable_version_range is not text',
    ],
  ])('reports %s as an advisory it cannot read', async (_name, bad, message) => {
    expect(await check(['lodash'], [bad])).toEqual({
      outcome: 'failed',
      error: `Failed to parse advisories for lodash (npm): ${message}`,
    })
  })
})

describe('--env-prefix', () => {
  const recording = (stdout: string) => {
    const calls: {
      command: string
      args: readonly string[]
      env: NodeJS.ProcessEnv | undefined
    }[] = []
    const runner: Runner = async (command, args = [], options) => {
      calls.push({ command, args, env: options?.env })
      const result: RunResult = {
        status: 0,
        signal: null,
        stdout,
        stderr: '',
        combined: stdout,
        timedOut: false,
        elapsedMs: 0,
        startFailure: null,
        streamErrors: [],
      }
      return result
    }
    return { runner, calls }
  }

  const real: ClientFactory = createGhClient
  const GH_ARGV = [
    'api',
    'advisories?affects=lodash&ecosystem=npm&per_page=100',
    '--paginate',
    '--slurp',
  ]

  it('runs gh bare when no prefix is given', async () => {
    const { runner, calls } = recording('[[]]')
    await checkAdvisories(context(['lodash']), real, runner, selectAdapter)
    expect(calls).toEqual([{ command: 'gh', args: GH_ARGV, env: { PATH: '/bin' } }])
  })

  it('puts the prefix before gh, so that the call reaches the runner as the prefix', async () => {
    const { runner, calls } = recording('[[]]')
    await checkAdvisories(context(['--env-prefix', 'env', 'lodash']), real, runner, selectAdapter)
    expect(calls.map((call) => [call.command, call.args])).toEqual([['env', ['gh', ...GH_ARGV]]])
  })

  it('splits a prefix of several words, in order', async () => {
    const { runner, calls } = recording('[[]]')
    await checkAdvisories(
      context(['--env-prefix', 'wrapper exec /work', 'lodash']),
      real,
      runner,
      selectAdapter,
    )
    expect(calls[0]?.command).toBe('wrapper')
    expect(calls[0]?.args.slice(0, 4)).toEqual(['exec', '/work', 'gh', 'api'])
  })

  it('reads a prefix of the word null as no prefix', async () => {
    const { runner, calls } = recording('[[]]')
    await checkAdvisories(context(['--env-prefix', 'null', 'lodash']), real, runner, selectAdapter)
    expect(calls[0]?.command).toBe('gh')
  })

  it('reads the advisories that the wrapped call answered', async () => {
    const { runner } = recording(JSON.stringify([LODASH]))
    const result = await checkAdvisories(
      context(['--env-prefix', 'env', 'lodash']),
      real,
      runner,
      selectAdapter,
    )
    expect(value(result)).toMatchObject({ advisory_count: 3 })
  })
})

describe('the registered handler', () => {
  it('runs with the real client, the real runner and the real registry', async () => {
    const sandbox = createSandbox()
    const context_: CommandContext = {
      ...context(['lodash']),
      env: { PATH: sandbox.pathWithout('gh') },
    }
    expect(await checkAdvisoriesCommand(context_)).toEqual({
      outcome: 'failed',
      error: 'Failed to fetch advisories for lodash (npm): cannot run gh: spawn gh ENOENT',
    })
  })
})

describe('the process', () => {
  const spawnCli = (args: readonly string[]) => {
    const sandbox = createSandbox()
    sandbox.env.PATH = sandbox.pathWithout('gh')
    return run(process.execPath, [ENTRY, 'check-advisories', ...args], { env: sandbox.env })
  }

  it('exits 1 with the error as JSON when gh cannot run', async () => {
    const result = await spawnCli(['lodash'])
    const said = 'Failed to fetch advisories for lodash (npm): cannot run gh: spawn gh ENOENT'
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: said })
    expect(result.stderr).toBe(`${said}\n`)
  })

  it('exits 3 for a version in an ecosystem with no adapter', async () => {
    const result = await spawnCli(['--ecosystem', 'pip', '--version', '1.0.0', 'requests'])
    expect(result.status).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ unsupported: 'pip' })
  })

  it('exits 1 with the usage line when no package is given', async () => {
    const result = await spawnCli([])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: USAGE })
  })
})
