// `gh-security audit-pins judge`. The seam is the exported handler, with the
// runner, the registry and the `gh` client factory as parameters. These are
// the `judge` examples of `spec/audit_driver_judge_spec.sh`, and the branches
// that only the port has.
//
// `judge` runs no git and no install, so each example writes the state file
// that the earlier steps would leave, with the findings it is about. `gh` is
// the one mocked boundary: `createGhMock` serves the advisory pages. The
// ranges are judged by the real node adapter. Where an example needs a
// `range_facts` that the real adapter never gives, the adapter is the real
// one with that verb replaced, through the registry parameter (`mocking.md`,
// "The injected collaborator"). The expected values are written by hand from
// the contract in the header of `audit-pins.ts`. The parity runs over real
// repositories are in `parity-audit-pins.test.ts`.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, failed, type JsonObject, type JsonValue } from '#gh-security/lib/envelope.ts'
import type { Runner } from '#gh-security/lib/process.ts'
import { run } from '#gh-security/lib/process.ts'
import { auditPins } from '#gh-security/subcommands/audit-pins.ts'
import {
  jqJoin,
  jqLength,
  jqValues,
  linesOf,
  orEmpty,
} from '#gh-security/subcommands/audit-pins-common.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'
import { createSandbox } from '#harness/sandbox.ts'

interface Answer {
  readonly status: number
  readonly json: JsonValue
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) throw new Error('audit-pins answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  if ('report' in result) return { status: result.exitCode ?? 1, json: result.report }
  return { status: exitCodeFor(result), json: { error: result.error } }
}

type Route = typeof selectAdapter

interface Desk {
  readonly work: string
  readonly state: string
  readonly cache: string
}

/** A work directory and a worktree directory. `judge` reads only the state. */
const desk = (): Desk => {
  const sandbox = createSandbox()
  const work = sandbox.join('work')
  mkdirSync(join(work, 'audit'), { recursive: true })
  return { work, state: join(work, 'state.json'), cache: join(work, 'advisories') }
}

const PIN_LODASH = {
  key: 'lodash',
  path: ['lodash'],
  package: 'lodash',
  scope: 'bare',
  value: '^4.17.21',
}
const PIN_GLOB = {
  key: 'glob',
  path: ['glob', 'minimatch'],
  package: 'minimatch',
  scope: 'scoped',
  value: '^9.0.0',
}

/** A tested finding on lodash with delta `["4.17.19"]` and nothing else moved. */
const tested = (fields: JsonObject = {}): JsonObject => ({
  ...PIN_LODASH,
  status: 'tested',
  tested: true,
  left_tree: false,
  detail: "tested; the advisory judgment is phase 5's",
  collateral_not_checked_reason: null,
  resolved_with_pin: ['4.17.21'],
  resolved_without_pin: ['4.17.19', '4.17.21'],
  attributable_versions: ['4.17.19'],
  sibling_pins: [],
  collateral_changes: [],
  collateral_verdict: null,
  sampled_families: [],
  whole_tree_view: true,
  advisory_verdict: null,
  advisory_count: null,
  matched_ranges: [],
  ...fields,
})

/** The state that `list`, `baseline` and `test-pin` leave, with these findings. */
const stateWith = (d: Desk, findings: JsonValue, extra: JsonObject = {}): JsonObject => ({
  work: d.work,
  worktree: join(d.work, 'audit'),
  adapter: 'node',
  ecosystem: 'npm',
  env_prefix: '',
  override_file: 'package.json',
  override_location: 'overrides',
  override_root: ['overrides'],
  pm: 'npm',
  pins_count: 2,
  test_order: [PIN_LODASH, PIN_GLOB],
  findings,
  baseline_done: true,
  baseline_inconclusive: [],
  lockfile: 'package-lock.json',
  map_available: true,
  baseline_unreadable_entries: 0,
  ...extra,
})

const write = (d: Desk, state: JsonObject): void => writeFileSync(d.state, JSON.stringify(state))

const readState = (d: Desk): Record<string, JsonValue> =>
  JSON.parse(readFileSync(d.state, 'utf8')) as Record<string, JsonValue>

const adv = (id: string, name: string, range: string | null): Record<string, unknown> => ({
  ghsa_id: id,
  cve_id: null,
  severity: 'high',
  type: 'reviewed',
  withdrawn_at: null,
  published_at: '2021-02-15T00:00:00Z',
  summary: `summary of ${id}`,
  html_url: `https://github.com/advisories/${id}`,
  vulnerabilities: [
    {
      package: { ecosystem: 'npm', name },
      vulnerable_version_range: range,
      first_patched_version: null,
    },
  ],
})

const LODASH_OLD = adv('GHSA-aaaa-1111-bbbb', 'lodash', '< 4.17.12')
const LODASH_MID = adv('GHSA-cccc-2222-dddd', 'lodash', '>= 4.17.0, < 4.17.20')

interface Run {
  readonly replies?: GhReplies
  readonly route?: Route
  readonly spawn?: Runner
  readonly args?: readonly string[]
  /** What each client factory call was given. */
  readonly made?: unknown[]
}

const judge = async (d: Desk, options: Run = {}): Promise<Answer> =>
  answerOf(
    await auditPins(
      {
        args: options.args ?? ['judge', '--work', d.work],
        env: {},
        io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
        commandNames: [],
      },
      {
        spawn: options.spawn ?? run,
        route: options.route ?? selectAdapter,
        makeClient: (clientOptions) => {
          options.made?.push(clientOptions)
          return createGhMock(options.replies ?? {})
        },
      },
    ),
  )

/** Judge one state, with these advisories. */
const judged = async (d: Desk, findings: JsonValue, advisories: unknown[] = [], extra = {}) => {
  write(d, stateWith(d, findings, extra))
  return judge(d, { replies: { listAdvisories: advisories as Record<string, unknown>[] } })
}

const findingsOf = (answer: Answer): Record<string, JsonValue>[] =>
  (answer.json as { findings: Record<string, JsonValue>[] }).findings

const project = (answer: Answer, ...keys: string[]) =>
  findingsOf(answer).map((finding) => Object.fromEntries(keys.map((key) => [key, finding[key]])))

/** A cached answer as `check-advisories` gives it, with these fields. */
const cached = (d: Desk, slug: string, fields: Record<string, unknown>): void => {
  mkdirSync(d.cache, { recursive: true })
  writeFileSync(
    join(d.cache, `${slug}.json`),
    JSON.stringify({
      package: 'lodash',
      ecosystem: 'npm',
      advisory_count: 1,
      withdrawn_excluded: 0,
      vulnerable_ranges: ['< 4.0.0'],
      advisories: [],
      version: '4.17.19',
      matched_ranges: [],
      unevaluated_ranges: [],
      adapter_errors: [],
      verdict: 'safe',
      ...fields,
    }),
  )
}

/** A failure of phase advisories, as `{status, phase, detail}`. */
const advisoriesFailure = (detail: string): Answer => ({
  status: 3,
  json: { status: 'failure', phase: 'advisories', detail },
})

describe('judge (phase 5)', () => {
  describe('the advisory verdict table', () => {
    it.each([
      ['safe', [adv('GHSA-x', 'lodash', '< 4.0.0')], 'removable', '4.17.19: safe', []],
      [
        'vulnerable',
        [LODASH_MID],
        'still-required',
        '4.17.19: vulnerable (>= 4.17.0, < 4.17.20)',
        ['>= 4.17.0, < 4.17.20'],
      ],
      [
        'unknown',
        [adv('GHSA-x', 'lodash', 'not a range')],
        'inconclusive',
        '4.17.19: unknown [unreadable range: not a range]',
        [],
      ],
      ['no-advisories', [], 'inconclusive', '4.17.19: no-advisories', []],
    ])(
      'routes a %s verdict, and carries it through verbatim',
      async (verdict, pages, status, detail, matched) => {
        const d = desk()
        const answer = await judged(d, [tested()], pages)
        expect(project(answer, 'status', 'advisory_verdict', 'detail', 'matched_ranges')).toEqual([
          { status, advisory_verdict: verdict, detail, matched_ranges: matched },
        ])
      },
    )
  })

  it('answers with the keys of each status, the untested pins, and writes the state', async () => {
    const d = desk()
    const answer = await judged(d, [tested()], [LODASH_OLD])
    const { findings: _, ...rest } = answer.json as Record<string, JsonValue>
    expect({ exit: answer.status, ...rest }).toEqual({
      exit: 0,
      status: 'ok',
      step: 'judge',
      untested: [{ key: 'glob', path: ['glob', 'minimatch'], package: 'minimatch' }],
      removable: ['lodash'],
      removable_individually: [],
      still_required: [],
      inconclusive: [],
    })
    const state = readState(d)
    expect({ judge_done: state.judge_done, findings: state.findings }).toEqual({
      judge_done: true,
      findings: findingsOf(answer),
    })
  })

  it('keeps the advisory answer of each version beside the finding', async () => {
    const d = desk()
    const answer = await judged(d, [tested()], [LODASH_MID])
    expect(findingsOf(answer)[0]?.advisory_versions).toEqual([
      {
        version: '4.17.19',
        verdict: 'vulnerable',
        advisory_count: 1,
        matched_ranges: ['>= 4.17.0, < 4.17.20'],
        unevaluated_ranges: [],
      },
    ])
  })

  it('keeps the pin still-required when one delta version of several matches', async () => {
    const d = desk()
    const answer = await judged(
      d,
      [tested({ attributable_versions: ['4.17.19', '4.17.25'] })],
      [LODASH_MID],
    )
    expect(project(answer, 'status', 'advisory_verdict', 'matched_ranges', 'detail')).toEqual([
      {
        status: 'still-required',
        advisory_verdict: 'vulnerable',
        matched_ranges: ['>= 4.17.0, < 4.17.20'],
        detail: '4.17.19: vulnerable (>= 4.17.0, < 4.17.20), 4.17.25: safe',
      },
    ])
  })

  it('reports the least sure answer of several versions as the own verdict', async () => {
    const d = desk()
    cached(d, 'lodash@1.0.0', { verdict: 'no-advisories', advisory_count: 0 })
    cached(d, 'lodash@2.0.0', { verdict: 'unknown', unevaluated_ranges: ['x'] })
    cached(d, 'lodash@3.0.0', { verdict: 'safe', advisory_count: 5 })
    const answer = await judged(d, [tested({ attributable_versions: ['1.0.0', '2.0.0', '3.0.0'] })])
    expect(project(answer, 'status', 'advisory_verdict', 'advisory_count')).toEqual([
      { status: 'inconclusive', advisory_verdict: 'unknown', advisory_count: 0 },
    ])
  })

  it('reports vulnerable as the own verdict over an unknown version', async () => {
    const d = desk()
    cached(d, 'lodash@1.0.0', { verdict: 'unknown', unevaluated_ranges: ['x'] })
    cached(d, 'lodash@2.0.0', { verdict: 'vulnerable', matched_ranges: ['< 3'] })
    const answer = await judged(d, [tested({ attributable_versions: ['1.0.0', '2.0.0'] })])
    expect(project(answer, 'status', 'advisory_verdict', 'matched_ranges')).toEqual([
      { status: 'still-required', advisory_verdict: 'vulnerable', matched_ranges: ['< 3'] },
    ])
  })

  it('reports no-advisories as the own verdict when no version is unknown', async () => {
    const d = desk()
    cached(d, 'lodash@1.0.0', { verdict: 'safe' })
    cached(d, 'lodash@2.0.0', { verdict: 'no-advisories' })
    const answer = await judged(d, [tested({ attributable_versions: ['1.0.0', '2.0.0'] })])
    expect(project(answer, 'status', 'advisory_verdict')).toEqual([
      { status: 'inconclusive', advisory_verdict: 'no-advisories' },
    ])
  })

  it('carries the first advisory_count verbatim, never the largest of them', async () => {
    const d = desk()
    cached(d, 'lodash@1.0.0', { advisory_count: 2 })
    cached(d, 'lodash@2.0.0', { advisory_count: 9 })
    const answer = await judged(d, [tested({ attributable_versions: ['1.0.0', '2.0.0'] })])
    expect(project(answer, 'advisory_count')).toEqual([{ advisory_count: 2 }])
  })

  it('takes each version text as lines, and asks nothing for an empty one', async () => {
    const d = desk()
    const answer = await judged(d, [tested({ attributable_versions: [''] })])
    expect(project(answer, 'status', 'advisory_verdict', 'advisory_count', 'detail')).toEqual([
      { status: 'removable', advisory_verdict: 'safe', advisory_count: null, detail: '' },
    ])
    expect(existsSync(d.cache)).toBe(false)
  })

  it('reports an empty delta removable, in the terms the definition sets, and asks nothing', async () => {
    const d = desk()
    const answer = await judged(d, [tested({ attributable_versions: [] })])
    expect(existsSync(d.cache)).toBe(false)
    expect(project(answer, 'status', 'advisory_verdict', 'detail')).toEqual([
      {
        status: 'removable',
        advisory_verdict: null,
        detail:
          'nothing new resolved: removing the entry changes nothing observable in this manifest as it stands, which is what a sibling pin on the same package, or an ordinary dependency range, holding the tree looks like. No version was judged against the advisory database, because none appeared',
      },
    ])
  })

  it.each([true, 'true'])(
    'reports a package that left the tree (left_tree %j) removable with no version judged',
    async (left) => {
      const d = desk()
      const answer = await judged(d, [tested({ left_tree: left })])
      expect(project(answer, 'status', 'advisory_count', 'detail')).toEqual([
        {
          status: 'removable',
          advisory_count: null,
          detail:
            'the package is no longer resolved at all: this pin was the only thing holding it in the tree, so there is no newly resolved version to judge',
        },
      ])
    },
  )

  it('asks under the text of the package as jq -r gives it', async () => {
    const d = desk()
    cached(d, '7@4.17.19', { verdict: 'vulnerable', matched_ranges: ['*'] })
    const answer = await judged(d, [tested({ package: 7 })])
    expect(project(answer, 'status', 'matched_ranges')).toEqual([
      { status: 'still-required', matched_ranges: ['*'] },
    ])
  })

  it('carries a finding that is not tested through unchanged', async () => {
    const d = desk()
    const kept = { ...PIN_GLOB, status: 'still-required', tested: true, detail: 'x' }
    const answer = await judged(d, [tested({ attributable_versions: [] }), kept])
    expect(findingsOf(answer)[1]).toEqual(kept)
  })

  describe('the advisory query', () => {
    it('asks check-advisories about the package and the ecosystem of the state, under its prefix', async () => {
      const d = desk()
      write(d, stateWith(d, [tested()], { env_prefix: 'env AUDIT=1' }))
      const calls: (readonly string[])[] = []
      const queries: unknown[] = []
      const spawn: Runner = async (command, args = []) => {
        calls.push([command, ...args])
        return run('true')
      }
      const answer = await auditPins(
        {
          args: ['judge', '--work', d.work],
          env: {},
          io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
          commandNames: [],
        },
        {
          spawn,
          route: selectAdapter,
          makeClient: (options) => {
            // The client runs gh through the prefixed runner it was given.
            void options.run?.('gh', ['api', 'probe'])
            const mock = createGhMock({ listAdvisories: [LODASH_OLD] })
            return {
              ...mock,
              listAdvisories: (query) => {
                queries.push(query)
                return mock.listAdvisories(query)
              },
            }
          },
        },
      )
      expect(answerOf(answer).status).toBe(0)
      expect(calls).toEqual([['env', 'AUDIT=1', 'gh', 'api', 'probe']])
      expect(queries).toEqual([{ package: 'lodash', ecosystem: 'npm' }])
    })

    it('fails phase advisories on a failed query, which is never read as no advisories', async () => {
      const d = desk()
      write(d, stateWith(d, [tested()]))
      const answer = await judge(d, {
        replies: { listAdvisories: ghFails('gh: Not Found (HTTP 404)') },
      })
      expect(answer).toEqual(
        advisoriesFailure(
          'check-advisories exited 1 for lodash 4.17.19, so there is no verdict for it. A failed query is never read as an absence of advisories. Quoting it: {"error":"Failed to fetch advisories for lodash (npm): gh: Not Found (HTTP 404)"}',
        ),
      )
      expect(readState(d).findings).toEqual([tested()])
    })

    it('fails phase advisories on unknown with a non-empty adapter_errors[]', async () => {
      const d = desk()
      write(d, stateWith(d, [tested()]))
      const route = ((ecosystem: string) => {
        const real = selectAdapter(ecosystem)
        return real.supported
          ? { ...real, adapter: { ...node, rangeFacts: () => failed('range_facts: broken') } }
          : real
      }) as Route
      const answer = await judge(d, { route, replies: { listAdvisories: [LODASH_OLD] } })
      expect(answer).toEqual(
        advisoriesFailure(
          'check-advisories answered \'unknown\' for lodash 4.17.19 with a non-empty adapter_errors[], which describes the tooling and not the package: [{"range":"< 4.17.12","status":1,"error":"range_facts: broken"}]. Every pin after this one would inherit the same broken adapter.',
        ),
      )
      expect(readdirSync(d.cache).sort()).toEqual([])
    })

    it('caches a fresh answer under its slug, and leaves no temporary file', async () => {
      const d = desk()
      await judged(d, [tested()], [LODASH_OLD])
      expect(readdirSync(d.cache).sort()).toEqual(['lodash@4.17.19.json'])
      const entry = JSON.parse(readFileSync(join(d.cache, 'lodash@4.17.19.json'), 'utf8'))
      expect({
        verdict: entry.verdict,
        version: entry.version,
        count: entry.advisory_count,
      }).toEqual({
        verdict: 'safe',
        version: '4.17.19',
        count: 1,
      })
    })

    it('reads the cache in place of a query, under a slug with no slash', async () => {
      const d = desk()
      cached(d, '@scope-pkg@1.0.0', { verdict: 'vulnerable', matched_ranges: ['< 2'] })
      write(d, stateWith(d, [tested({ package: '@scope/pkg', attributable_versions: ['1.0.0'] })]))
      const answer = await judge(d, { replies: { listAdvisories: ghFails('must not be asked') } })
      expect(project(answer, 'status', 'matched_ranges')).toEqual([
        { status: 'still-required', matched_ranges: ['< 2'] },
      ])
    })

    const SOURCE = (d: Desk) =>
      `the cached advisory answer at ${join(d.cache, 'lodash@4.17.19.json')}`

    it.each([
      ['a torn file', '{"verdict":"safe","advisory_c'],
      ['an empty file', ''],
      ['a list', '[]'],
      ['two objects', '{} {}'],
    ])('fails the phase on %s in the cache, as not a JSON object', async (_name, text) => {
      const d = desk()
      mkdirSync(d.cache)
      writeFileSync(join(d.cache, 'lodash@4.17.19.json'), text)
      expect(await judged(d, [tested()])).toEqual(
        advisoriesFailure(
          `${SOURCE(d)} for lodash 4.17.19 is not a JSON object. A script that cannot answer exits non-zero; answering with nothing lets every check below be skipped rather than failed.`,
        ),
      )
    })

    it('reads a cache file it cannot open as empty, as $(cat) does', async () => {
      const d = desk()
      cached(d, 'lodash@4.17.19', {})
      chmodSync(join(d.cache, 'lodash@4.17.19.json'), 0o000)
      expect(((await judged(d, [tested()])).json as { detail: string }).detail).toContain(
        'is not a JSON object',
      )
    })

    it.each([
      'verdict',
      'advisory_count',
      'matched_ranges',
      'unevaluated_ranges',
      'adapter_errors',
    ])('fails the phase on a cached answer with no %s', async (field) => {
      const d = desk()
      cached(d, 'lodash@4.17.19', { [field]: undefined })
      expect(await judged(d, [tested()])).toEqual(
        advisoriesFailure(
          `${SOURCE(d)} for lodash 4.17.19 carries no '${field}'. The output contract promises all five fields this driver reads; read straight, an absent one arrives as the string "null" and takes a branch of its own instead of failing \u2014 and for 'adapter_errors' that branch is the test standing between a broken adapter and an audit of inconclusive verdicts with nothing naming the cause.`,
        ),
      )
    })

    it.each([
      ['probably-fine', 'probably-fine'],
      [null, 'null'],
      [1, '1'],
    ])('refuses the verdict %j rather than defaulting it to safe', async (verdict, text) => {
      const d = desk()
      cached(d, 'lodash@4.17.19', { verdict })
      expect(await judged(d, [tested()])).toEqual(
        advisoriesFailure(
          `${SOURCE(d)} answered verdict '${text}' for lodash 4.17.19, which is not one of safe, vulnerable, unknown or no-advisories. Anything else falls through every verdict test into the last arm, and the last arm cannot be allowed to be a default.`,
        ),
      )
    })

    it('fails the phase when matched_ranges of a cached answer cannot be read', async () => {
      const d = desk()
      cached(d, 'lodash@4.17.19', { matched_ranges: null })
      expect(await judged(d, [tested()])).toEqual(
        advisoriesFailure(
          'the matched ranges for lodash could not be read back out of the per-version answers: [{"version":"4.17.19","verdict":"safe","advisory_count":1,"matched_ranges":null,"unevaluated_ranges":[]}]',
        ),
      )
    })

    it('reads the ranges of a cached answer as jq does, and the detail is empty where jq stops', async () => {
      const d = desk()
      cached(d, 'lodash@1.0.0', { matched_ranges: { a: '< 2', b: 3 } })
      cached(d, 'lodash@2.0.0', { unevaluated_ranges: 'x' })
      const answer = await judged(d, [tested({ attributable_versions: ['1.0.0'] })])
      expect(project(answer, 'matched_ranges', 'detail')).toEqual([
        { matched_ranges: [3, '< 2'], detail: '1.0.0: safe (< 2; 3)' },
      ])
      const second = await judged(d, [tested({ attributable_versions: ['2.0.0'] })])
      expect(project(second, 'detail')).toEqual([{ detail: '' }])
    })

    it('stops with exit 1 when the cache directory cannot be made', async () => {
      const d = desk()
      writeFileSync(d.cache, 'a file')
      expect(await judged(d, [tested()], [LODASH_OLD])).toEqual({
        status: 1,
        json: { error: `cannot create ${d.cache}` },
      })
    })

    it('stops with exit 1 when the temporary cache file cannot be written', async () => {
      const d = desk()
      mkdirSync(join(d.cache, 'lodash@4.17.19.json.tmp'), { recursive: true })
      expect(await judged(d, [tested()], [LODASH_OLD])).toEqual({
        status: 1,
        json: { error: `cannot write ${join(d.cache, 'lodash@4.17.19.json')}.tmp` },
      })
    })

    it('stops with exit 1 when a cache entry is a directory, as the rename fails', async () => {
      const d = desk()
      mkdirSync(join(d.cache, 'lodash@4.17.19.json', 'x'), { recursive: true })
      expect(await judged(d, [tested()], [LODASH_OLD])).toEqual({
        status: 1,
        json: { error: `cannot replace ${join(d.cache, 'lodash@4.17.19.json')}` },
      })
    })
  })

  describe('the collateral verdict', () => {
    const READABLE = {
      package: 'readable-stream',
      baseline: ['3.6.2'],
      without_pin: ['2.3.8', '3.6.2'],
      newly_admitted: ['2.3.8'],
      judged: true,
      represented_by: null,
      family: null,
    }
    const READABLE_OLD = adv('GHSA-rrrr-3333-ssss', 'readable-stream', '< 3')
    const LODASH_SAFE = adv('GHSA-x', 'lodash', '< 4.0.0')

    it('judges each collateral version under that entry own package name', async () => {
      const d = desk()
      await judged(d, [tested({ collateral_changes: [READABLE] })], [LODASH_SAFE])
      expect(readdirSync(d.cache).sort()).toEqual([
        'lodash@4.17.19.json',
        'readable-stream@2.3.8.json',
      ])
    })

    it('turns a vulnerable collateral into still-required, and never folds it into the own fields', async () => {
      const d = desk()
      const answer = await judged(
        d,
        [tested({ collateral_changes: [READABLE] })],
        [LODASH_SAFE, READABLE_OLD],
      )
      expect(
        project(
          answer,
          'status',
          'advisory_verdict',
          'matched_ranges',
          'collateral_verdict',
          'detail',
          'collateral_verdicts',
        ),
      ).toEqual([
        {
          status: 'still-required',
          advisory_verdict: 'safe',
          matched_ranges: [],
          collateral_verdict: 'vulnerable',
          detail:
            'this pin is not required for lodash; it is required because removing it newly admits readable-stream 2.3.8 elsewhere in the tree, which a published advisory range admits',
          collateral_verdicts: [
            {
              package: 'readable-stream',
              version: '2.3.8',
              verdict: 'vulnerable',
              matched_ranges: ['< 3'],
            },
          ],
        },
      ])
    })

    it('turns a collateral that is not safe into an inconclusive pin, naming it', async () => {
      const d = desk()
      const answer = await judged(d, [tested({ collateral_changes: [READABLE] })], [LODASH_SAFE])
      expect(project(answer, 'status', 'advisory_verdict', 'collateral_verdict', 'detail')).toEqual(
        [
          {
            status: 'inconclusive',
            advisory_verdict: 'safe',
            collateral_verdict: 'inconclusive',
            detail:
              '4.17.19: safe; a package whose resolution moved with this removal could not be cleared: readable-stream 2.3.8: no-advisories',
          },
        ],
      )
    })

    const MS = {
      ...READABLE,
      package: 'ms',
      baseline: ['2.1.3'],
      without_pin: ['2.0.0', '2.1.3'],
      newly_admitted: ['2.0.0'],
    }

    it('names only the vulnerable collateral versions in the detail of a still-required pin', async () => {
      const d = desk()
      cached(d, 'lodash@4.17.19', { verdict: 'safe' })
      cached(d, 'readable-stream@2.3.8', { verdict: 'vulnerable', matched_ranges: ['< 3'] })
      cached(d, 'ms@2.0.0', { verdict: 'safe' })
      const answer = await judged(d, [tested({ collateral_changes: [READABLE, MS] })])
      expect(project(answer, 'status', 'detail')).toEqual([
        {
          status: 'still-required',
          detail:
            'this pin is not required for lodash; it is required because removing it newly admits readable-stream 2.3.8 elsewhere in the tree, which a published advisory range admits',
        },
      ])
    })

    it('names only the collateral versions that are not safe in the detail of an inconclusive pin', async () => {
      const d = desk()
      cached(d, 'lodash@4.17.19', { verdict: 'safe' })
      cached(d, 'readable-stream@2.3.8', { verdict: 'no-advisories' })
      cached(d, 'ms@2.0.0', { verdict: 'safe' })
      const answer = await judged(d, [tested({ collateral_changes: [READABLE, MS] })])
      expect(project(answer, 'status', 'detail')).toEqual([
        {
          status: 'inconclusive',
          detail:
            '4.17.19: safe; a package whose resolution moved with this removal could not be cleared: readable-stream 2.3.8: no-advisories',
        },
      ])
    })

    it('keeps a still-required pin still-required when a collateral is inconclusive', async () => {
      const d = desk()
      const answer = await judged(d, [tested({ collateral_changes: [READABLE] })], [LODASH_MID])
      expect(project(answer, 'status', 'collateral_verdict')).toEqual([
        { status: 'still-required', collateral_verdict: 'inconclusive' },
      ])
    })

    it.each([
      [[], 'none'],
      [null, 'none'],
    ])('reports none when nothing else moved (collateral %j)', async (changes, verdict) => {
      const d = desk()
      const answer = await judged(d, [tested({ collateral_changes: changes })], [LODASH_SAFE])
      expect(project(answer, 'collateral_verdict', 'detail')).toEqual([
        { collateral_verdict: verdict, detail: '4.17.19: safe' },
      ])
    })

    it('reports safe when the judged entries admitted no new version', async () => {
      const d = desk()
      const answer = await judged(
        d,
        [
          tested({
            collateral_changes: [{ ...READABLE, newly_admitted: [] }],
            sampled_families: [{}],
          }),
        ],
        [LODASH_SAFE],
      )
      expect(project(answer, 'status', 'collateral_verdict', 'collateral_verdicts')).toEqual([
        { status: 'removable', collateral_verdict: 'safe', collateral_verdicts: [] },
      ])
    })

    it.each([
      [
        'not-checked',
        'resolution_map refused this lockfile: parsed 0 entries',
        'resolution_map refused this lockfile: parsed 0 entries',
      ],
      ['"not-checked"', 7, '7'],
      [
        'not-checked',
        null,
        "no whole-tree view was available, so no other package's resolution was re-checked",
      ],
    ])(
      'keeps not-checked (%j), and reads the recorded reason into the detail',
      async (verdict, reason, text) => {
        const d = desk()
        const answer = await judged(
          d,
          [
            tested({
              collateral_changes: null,
              collateral_verdict: verdict,
              collateral_not_checked_reason: reason,
            }),
          ],
          [LODASH_SAFE],
        )
        expect(project(answer, 'status', 'collateral_verdict', 'detail')).toEqual([
          {
            status: 'removable',
            collateral_verdict: 'not-checked',
            detail: `4.17.19: safe. the verdict covers lodash only: ${text}`,
          },
        ])
      },
    )

    const FAMILY = {
      key: '@esbuild/',
      size: 2,
      members: ['@esbuild/darwin-arm64', '@esbuild/linux-x64'],
      sample: '@esbuild/darwin-arm64',
      shared_version: '0.23.1',
    }
    const MEMBERS = [
      {
        package: '@esbuild/darwin-arm64',
        baseline: ['0.21.0'],
        without_pin: ['0.23.1'],
        newly_admitted: ['0.23.1'],
        judged: true,
        represented_by: null,
        family: FAMILY,
      },
      {
        package: '@esbuild/linux-x64',
        baseline: ['0.21.0'],
        without_pin: ['0.23.1'],
        newly_admitted: ['0.23.1'],
        judged: false,
        represented_by: '@esbuild/darwin-arm64',
        family: FAMILY,
      },
    ]
    const ESBUILD = adv('GHSA-gggg-6666-hhhh', '@esbuild/darwin-arm64', '< 0.1.0')

    it.each([
      [[FAMILY], 'sampled-family'],
      ['ab', 'sampled-family'],
      [-2, 'sampled-family'],
      [[], 'safe'],
      [null, 'safe'],
    ])(
      'reports %j families as %s, and queries only the sampled member',
      async (families, verdict) => {
        const d = desk()
        const answer = await judged(
          d,
          [tested({ collateral_changes: MEMBERS, sampled_families: families })],
          [LODASH_SAFE, ESBUILD],
        )
        expect(project(answer, 'collateral_verdict')).toEqual([{ collateral_verdict: verdict }])
        expect(readdirSync(d.cache).sort()).toEqual([
          '@esbuild-darwin-arm64@0.23.1.json',
          'lodash@4.17.19.json',
        ])
      },
    )

    it('fails the phase when the families cannot be counted', async () => {
      const d = desk()
      expect(
        await judged(
          d,
          [tested({ collateral_changes: MEMBERS, sampled_families: true })],
          [LODASH_SAFE, ESBUILD],
        ),
      ).toEqual(
        advisoriesFailure(
          'the collateral verdict for lodash could not be collapsed out of [{"package":"@esbuild/darwin-arm64","version":"0.23.1","verdict":"safe","matched_ranges":[]}]',
        ),
      )
    })

    it('refuses a collateral list where nothing at all was judged', async () => {
      const d = desk()
      const answer = await judged(
        d,
        [tested({ collateral_changes: [{ ...READABLE, judged: false }] })],
        [LODASH_SAFE],
      )
      expect(answer).toEqual(
        advisoriesFailure(
          "the collateral list for lodash carries 1 entr(ies) and not one of them is marked judged, so nothing in the tree was checked. An empty verdict list would collapse to 'safe' here, which is the strongest claim available about packages nobody looked at.",
        ),
      )
    })
  })

  describe('the sibling rule', () => {
    const empty = { attributable_versions: [] }
    it('downgrades two removable pins on one package to removable-individually', async () => {
      const d = desk()
      const answer = await judged(d, [
        tested({ ...empty, key: 'eslint', path: ['eslint', 'lodash'] }),
        tested({ ...empty, key: 'glob', path: ['glob', 'lodash'] }),
        tested({ ...empty, key: 'other', path: ['other'], package: 'other' }),
      ])
      expect(project(answer, 'status', 'sibling_pins')).toEqual([
        { status: 'removable-individually', sibling_pins: ['glob'] },
        { status: 'removable-individually', sibling_pins: ['eslint'] },
        { status: 'removable', sibling_pins: [] },
      ])
    })

    it('names a sibling only when its key and its path both differ, and counts only removable pins', async () => {
      const d = desk()
      const answer = await judged(d, [
        tested({ ...empty, key: 'a', path: ['a', 'lodash'] }),
        tested({ ...empty, key: 'a', path: ['b', 'lodash'] }),
        tested({ ...empty, key: 'c', path: ['a', 'lodash'] }),
        { key: 'd', path: ['d'], package: 'lodash', status: 'still-required' },
        { key: 'e', path: ['e'], package: 'lodash', status: 'removable-individually' },
      ])
      expect(project(answer, 'status', 'sibling_pins')).toEqual([
        { status: 'removable-individually', sibling_pins: ['d', 'e'] },
        { status: 'removable-individually', sibling_pins: ['c', 'd', 'e'] },
        { status: 'removable-individually', sibling_pins: ['a', 'd', 'e'] },
        { status: 'still-required', sibling_pins: undefined },
        { status: 'removable-individually', sibling_pins: undefined },
      ])
    })

    it('counts a removable finding from an earlier judgment, and judges a pin tested again', async () => {
      const d = desk()
      const answer = await judged(d, [
        { ...PIN_GLOB, package: 'lodash', status: 'removable', sibling_pins: [] },
        tested(empty),
      ])
      expect(project(answer, 'key', 'status')).toEqual([
        { key: 'glob', status: 'removable-individually' },
        { key: 'lodash', status: 'removable-individually' },
      ])
    })

    it('stops with exit 1, and writes nothing, when a removable pin names no text package', async () => {
      const d = desk()
      const answer = await judged(d, [tested({ ...empty, package: null })])
      expect(answer).toEqual({
        status: 1,
        json: {
          error:
            'judge: the sibling rule could not be applied to the judged findings, so removable-individually was never assigned. Nothing was written.',
        },
      })
      expect(readState(d).findings).toEqual([tested({ ...empty, package: null })])
    })
  })

  describe('a finding with no optional fields', () => {
    const without = (finding: JsonObject, ...keys: string[]): JsonObject =>
      Object.fromEntries(Object.entries(finding).filter(([key]) => !keys.includes(key)))

    it('reads each absent field as null, as jq does', async () => {
      const d = desk()
      const answer = await judged(
        d,
        [
          without(
            tested({ collateral_verdict: 'not-checked' }),
            'collateral_not_checked_reason',
            'package',
          ),
          without(tested({ key: 'b', path: ['b'] }), 'collateral_verdict', 'sampled_families'),
          { status: 'still-required' },
        ],
        [adv('GHSA-x', 'lodash', '< 4.0.0')],
      )
      expect(project(answer, 'key', 'status', 'collateral_verdict', 'detail')).toEqual([
        {
          key: 'lodash',
          status: 'inconclusive',
          collateral_verdict: 'not-checked',
          detail:
            "4.17.19: no-advisories. the verdict covers null only: no whole-tree view was available, so no other package's resolution was re-checked",
        },
        { key: 'b', status: 'removable', collateral_verdict: 'none', detail: '4.17.19: safe' },
        {
          key: undefined,
          status: 'still-required',
          collateral_verdict: undefined,
          detail: undefined,
        },
      ])
      const json = answer.json as JsonObject
      expect({ still: json.still_required, untested: json.untested }).toEqual({
        still: [null],
        untested: [{ key: 'glob', path: ['glob', 'minimatch'], package: 'minimatch' }],
      })
    })

    it('compares an absent key or path as null in the sibling rule', async () => {
      const d = desk()
      const answer = await judged(d, [
        without(tested({ attributable_versions: [] }), 'key', 'path'),
        tested({ attributable_versions: [], key: 'x', path: ['x'] }),
        { package: 'lodash', status: 'inconclusive' },
      ])
      expect(project(answer, 'status', 'sibling_pins')).toEqual([
        { status: 'removable-individually', sibling_pins: ['x'] },
        { status: 'removable-individually', sibling_pins: [null, null] },
        { status: 'inconclusive', sibling_pins: undefined },
      ])
    })

    it('asks with no prefix when the state has none', async () => {
      const d = desk()
      const state = stateWith(d, [tested()])
      delete state.env_prefix
      write(d, state)
      const calls: (readonly string[])[] = []
      const spawn: Runner = async (command, args = []) => {
        calls.push([command, ...args])
        return run('true')
      }
      const answer = answerOf(
        await auditPins(
          {
            args: ['judge', '--work', d.work],
            env: {},
            io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
            commandNames: [],
          },
          {
            spawn,
            route: selectAdapter,
            makeClient: (options) => {
              void options.run?.('gh', ['api', 'probe'])
              return createGhMock({ listAdvisories: [LODASH_OLD] })
            },
          },
        ),
      )
      expect(answer.status).toBe(0)
      expect(calls).toEqual([['gh', 'api', 'probe']])
    })
  })

  describe('the guards and the state', () => {
    it('requires --work', async () => {
      const d = desk()
      expect(await judge(d, { args: ['judge'] })).toEqual({
        status: 1,
        json: { error: 'judge: --work is required' },
      })
    })

    it("refuses an option it does not know, in node's words", async () => {
      const d = desk()
      expect(await judge(d, { args: ['judge', '--work', d.work, '--bogus'] })).toEqual({
        status: 1,
        json: { error: "Unknown option '--bogus'" },
      })
    })

    it.each([false, 'true', null])(
      'refuses judge before baseline (baseline_done %j)',
      async (done) => {
        const d = desk()
        write(d, stateWith(d, [tested()], { baseline_done: done }))
        expect(await judge(d)).toEqual({
          status: 1,
          json: {
            error:
              "judge: run 'baseline' first. With no with-all-pins baseline there is nothing any finding was measured against.",
          },
        })
      },
    )

    it('refuses judge when testable pins survived the baseline and none was tested', async () => {
      const d = desk()
      write(d, stateWith(d, [{ ...PIN_LODASH, status: 'inconclusive', tested: 'true' }]))
      expect(await judge(d)).toEqual({
        status: 1,
        json: {
          error:
            "judge: run 'test-pin' first. 2 pin(s) survived the baseline and none has been tested, so every finding on file is one the baseline refused \u2014 and judging that set reports an audit that examined nothing as one that kept every pin it has.",
        },
      })
    })

    it('reports rather than deadlocking when the baseline refused every pin', async () => {
      const d = desk()
      const refused = [
        { ...PIN_LODASH, status: 'inconclusive', tested: false },
        { ...PIN_GLOB, status: 'inconclusive', tested: false },
      ]
      write(
        d,
        stateWith(d, refused, {
          baseline_inconclusive: [{ package: 'lodash' }, { package: 'minimatch' }],
        }),
      )
      const answer = await judge(d)
      expect({ status: answer.status, untested: (answer.json as JsonObject).untested }).toEqual({
        status: 0,
        untested: [],
      })
    })

    it.each([
      ['a refused list that is text', { baseline_inconclusive: 'x' }],
      ['a refused entry that is text', { baseline_inconclusive: ['x'] }],
      ['a test_order that is text', { test_order: 'x' }],
      ['a test_order entry that is text', { test_order: ['x'] }],
    ])('stops with exit 1 on %s, as jq does', async (_name, extra) => {
      const d = desk()
      write(d, stateWith(d, [tested()], extra))
      expect((await judge(d)).json).toEqual({
        error: `judge: phase 2's test_order and the baseline's inconclusive list could not be read out of ${d.state}`,
      })
    })

    const owes = (count: number) =>
      `judge: run 'test-pin' first. ${count} pin(s) survived the baseline and none has been tested, so every finding on file is one the baseline refused \u2014 and judging that set reports an audit that examined nothing as one that kept every pin it has.`

    it.each([
      [
        'a null refused entry that matches a null package',
        { baseline_inconclusive: [null], test_order: [{}, PIN_LODASH] },
        1,
      ],
      ['a test_order object', { test_order: { a: PIN_LODASH, b: PIN_GLOB } }, 2],
      [
        'a package that is a list, found where its entries are in a row',
        {
          baseline_inconclusive: [{ package: 'a' }, { package: 'b' }],
          test_order: [
            { package: ['a', 'b'] },
            { package: ['b', 'a'] },
            { package: [] },
            { package: ['b', 'c'] },
          ],
        },
        3,
      ],
    ])('counts the pins still owed from %s as jq does', async (_name, extra, owed) => {
      const d = desk()
      write(d, stateWith(d, [{ ...PIN_LODASH, status: 'inconclusive', tested: false }], extra))
      expect((await judge(d)).json).toEqual({ error: owes(owed) })
    })

    it('reads absent lists as empty, so nothing is owed', async () => {
      const d = desk()
      write(
        d,
        stateWith(d, [{ ...PIN_LODASH, status: 'inconclusive', tested: false }], {
          baseline_inconclusive: false,
          test_order: {},
        }),
      )
      expect(await judge(d)).toEqual({
        status: 0,
        json: {
          status: 'ok',
          step: 'judge',
          findings: [{ ...PIN_LODASH, status: 'inconclusive', tested: false }],
          untested: [],
          removable: [],
          removable_individually: [],
          still_required: [],
          inconclusive: ['lodash'],
        },
      })
    })

    it('lists only the pins no finding covers, by their whole path', async () => {
      const d = desk()
      const answer = await judged(d, [
        tested({ attributable_versions: [], path: ['glob', 'minimatch'] }),
      ])
      expect((answer.json as JsonObject).untested).toEqual([
        { key: 'lodash', path: ['lodash'], package: 'lodash' },
      ])
    })

    it('reads a test_order entry with no fields as nulls, and a null entry as a pin of no path', async () => {
      const d = desk()
      const answer = await judged(d, [tested({ attributable_versions: [] })], [], {
        test_order: [{}, null],
      })
      expect((answer.json as JsonObject).untested).toEqual([
        { key: null, path: null, package: null },
        { key: null, path: null, package: null },
      ])
    })

    it.each([
      ['null', null],
      ['false', false],
    ])(
      'writes the judgment, then stops with exit 1, when test_order is %s',
      async (_name, order) => {
        const d = desk()
        const answer = await judged(d, [tested({ attributable_versions: [] })], [], {
          test_order: order,
        })
        expect(answer).toEqual({
          status: 1,
          json: { error: `judge: the untested-pin list could not be computed from ${d.state}` },
        })
        const state = readState(d)
        expect({
          done: state.judge_done,
          status: (state.findings as JsonObject[])[0]?.status,
        }).toEqual({
          done: true,
          status: 'removable',
        })
      },
    )

    it.each([
      ['a text', '4.17.19'],
      ['an object', { 0: '4.17.19' }],
      ['null', null],
      ['a list of non-texts', [{ version: '4.17.19' }]],
    ])('refuses attributable_versions that is %s, and asks nothing', async (_name, versions) => {
      const d = desk()
      const answer = await judged(d, [tested({ attributable_versions: versions })])
      expect((answer.json as JsonObject).phase).toBe('advisories')
      expect((answer.json as { detail: string }).detail).toMatch(
        /^the findings phase 4 recorded is in the state file but is not the shape the step that wrote it promised \(expected: type == "array"\n/,
      )
      expect(readState(d).findings).toEqual([tested({ attributable_versions: versions })])
    })
  })
})

describe('the jq readers', () => {
  it.each([
    [null, 0],
    [-3, 3],
    [1.5, 1.5],
    ['a\u{1F600}', 2],
    [[1, 2], 2],
    [{ a: 1 }, 1],
  ])('gives jq length of %j as %j', (value, length) => {
    expect(jqLength(value)).toBe(length)
  })

  it('stops on the length of a boolean, as jq does', () => {
    expect(() => jqLength(true)).toThrow('boolean has no length')
  })

  it('joins as jq 1.8 does, and stops on a list inside', () => {
    expect(jqJoin([null, 'a', 1, true], ';')).toBe(';a;1;true')
    expect(() => jqJoin([[1]], ';')).toThrow('cannot join a array')
  })

  it('iterates a list or the values of an object, and stops on anything else', () => {
    expect(jqValues({ b: 1, a: 2 })).toEqual([1, 2])
    expect(() => jqValues('x')).toThrow('Cannot iterate over string')
  })

  it('cuts each value at its line breaks, and skips empty lines', () => {
    expect(linesOf(['a\nb', '', 3, null])).toEqual(['a', 'b', '3', 'null'])
  })

  // The lines of `jq -r '.[]'` on `[{"a":1,"b":[1,{}]},[],true]`, from jq 1.8.
  it('writes a list or an object over lines with an indent of two, as jq -r does', () => {
    expect(linesOf([{ a: 1, b: [1, {}] }, [], true])).toEqual([
      '{',
      '  "a": 1,',
      '  "b": [',
      '    1,',
      '    {}',
      '  ]',
      '}',
      '[]',
      'true',
    ])
  })

  it('gives empty text where the program stops', () => {
    expect(
      orEmpty(() => {
        throw new Error('x')
      }),
    ).toBe('')
  })
})
