// `gh-security pr-status`. The seam is the exported handler. It takes the `gh`
// client factory and the process runner as parameters, so an example gives a
// client from `harness/gh.ts`, or the real client on a runner that records its
// argv. `gh` is the one mock boundary (`mocking.md`). The expected entries are
// written by hand from the contract in the header of the command, and the
// recorded reply is a real `gh pr view` answer. The bash script is compared
// in `parity-pr-status.test.ts`.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { CommandContext } from '#gh-security/cli/command.ts'
import { createGhClient } from '#gh-security/lib/gh.ts'
import type { Runner, RunResult } from '#gh-security/lib/process.ts'
import { run } from '#gh-security/lib/process.ts'
import {
  type ClientFactory,
  prStatus,
  prStatusCommand,
} from '#gh-security/subcommands/pr-status.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

const USAGE = 'usage: gh-security pr-status [--env-prefix <prefix>] <pr-url>...'

const APP = 'https://github.com/octo/app/pull/12'

const context = (args: readonly string[]): CommandContext => ({
  args,
  env: { PATH: '/bin' },
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const noProcess: Runner = () => Promise.reject(new Error('the mock client starts no process'))

/** A factory whose clients answer from `replies`, keyed by repository and number. */
const mockFactory =
  (replies: Readonly<Record<string, GhReplies['viewPullRequest']>>): ClientFactory =>
  (options) => ({
    viewPullRequest: (pull) =>
      createGhMock({
        viewPullRequest: replies[`${options.repository}#${pull.pullRequest}`],
      }).viewPullRequest(pull),
  })

/** A `gh pr view` answer, with the fields that `pr-status` reads. */
const view = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 12,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'fix/dependabot-lodash',
  baseRefName: 'main',
  mergeStateStatus: 'UNKNOWN',
  statusCheckRollup: [],
  ...overrides,
})

const checkRun = (name: string, conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
})

const statusContext = (name: string, state: string) => ({
  __typename: 'StatusContext',
  context: name,
  state,
})

/** The entry for a reply with no checks, with the given fields changed. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  url: APP,
  number: 12,
  repo: 'octo/app',
  state: 'OPEN',
  is_draft: false,
  head: 'fix/dependabot-lodash',
  base: 'main',
  merge_state: 'UNKNOWN',
  behind: false,
  conflict: false,
  checks: 'none',
  check_counts: { total: 0, passed: 0, failed: 0, pending: 0 },
  failing_checks: [],
  ...overrides,
})

/** The report for one URL, read through the handler. */
const oneReport = async (reply: Record<string, unknown>) => {
  const result = await prStatus(context([APP]), mockFactory({ 'octo/app#12': reply }), noProcess)
  if (result === undefined) throw new Error('pr-status answered with silence')
  if (result.outcome === 'ok') return result.value
  if ('report' in result) return result.report
  throw new Error(`pr-status failed: ${result.error}`)
}

describe('the entry for a pull request', () => {
  it('has every field, read from the reply', async () => {
    expect(await oneReport(view())).toEqual({ prs: [entry()] })
  })

  it('reports the recorded reply of a real pull request', async () => {
    const recorded = JSON.parse(
      readFileSync(`${FIXTURES_ROOT}/pr-view/pr-290.json`, 'utf8'),
    ) as Record<string, unknown>
    const url = 'https://github.com/SurveyMonkey/skills/pull/290'
    const result = await prStatus(
      context([url]),
      mockFactory({ 'SurveyMonkey/skills#290': recorded }),
      noProcess,
    )
    // 24 checks: 8 SUCCESS and 14 SKIPPED pass; 1 FAILURE and 1 CANCELLED fail.
    expect(result).toEqual({
      outcome: 'ok',
      value: {
        prs: [
          {
            url,
            number: 290,
            repo: 'SurveyMonkey/skills',
            state: 'MERGED',
            is_draft: false,
            head: 'wktr-274-converge-harness',
            base: 'wktr-274-converge-git',
            merge_state: 'DIRTY',
            behind: false,
            conflict: true,
            checks: 'failed',
            check_counts: { total: 24, passed: 22, failed: 2, pending: 0 },
            failing_checks: ['gates', 'gates'],
          },
        ],
      },
    })
  })

  it.each([
    ['BEHIND', { behind: true, conflict: false }],
    ['DIRTY', { behind: false, conflict: true }],
    ['UNKNOWN', { behind: false, conflict: false }],
    ['CLEAN', { behind: false, conflict: false }],
  ])('passes merge state %s through raw and derives behind and conflict', async (state, flags) => {
    expect(await oneReport(view({ mergeStateStatus: state }))).toEqual({
      prs: [entry({ merge_state: state, ...flags })],
    })
  })

  it.each([[true], [false]])('reports isDraft %s as found', async (isDraft) => {
    expect(await oneReport(view({ isDraft }))).toEqual({ prs: [entry({ is_draft: isDraft })] })
  })

  it('reads a field that the reply lacks as null', async () => {
    const { mergeStateStatus: _dropped, ...rest } = view()
    expect(await oneReport(rest)).toEqual({
      prs: [entry({ merge_state: null, behind: false, conflict: false })],
    })
  })
})

describe('the checks derivation', () => {
  const CASES: readonly [
    string,
    readonly unknown[],
    string,
    [number, number, number, number],
    string[],
  ][] = [
    // name, rollup, checks, [total, passed, failed, pending], failing_checks
    ['an empty rollup', [], 'none', [0, 0, 0, 0], []],
    ['a passing check', [checkRun('test', 'SUCCESS')], 'passed', [1, 1, 0, 0], []],
    ['a neutral check', [checkRun('advisory', 'NEUTRAL')], 'passed', [1, 1, 0, 0], []],
    ['a skipped check', [checkRun('e2e', 'SKIPPED')], 'passed', [1, 1, 0, 0], []],
    [
      'a failing check beside a passing one',
      [checkRun('test', 'SUCCESS'), checkRun('lint', 'FAILURE')],
      'failed',
      [2, 1, 1, 0],
      ['lint'],
    ],
    ['a cancelled check', [checkRun('e2e', 'CANCELLED')], 'failed', [1, 0, 1, 0], ['e2e']],
    [
      'a check that finished with no conclusion',
      [checkRun('e2e', null)],
      'failed',
      [1, 0, 1, 0],
      ['e2e'],
    ],
    ['a check still running', [checkRun('e2e', null, 'IN_PROGRESS')], 'pending', [1, 0, 0, 1], []],
    ['a queued check', [checkRun('e2e', null, 'QUEUED')], 'pending', [1, 0, 0, 1], []],
    [
      'a passing status context',
      [statusContext('ci/legacy', 'SUCCESS')],
      'passed',
      [1, 1, 0, 0],
      [],
    ],
    [
      'a pending status context',
      [statusContext('ci/legacy', 'PENDING')],
      'pending',
      [1, 0, 0, 1],
      [],
    ],
    [
      'an expected status context',
      [statusContext('ci/legacy', 'EXPECTED')],
      'pending',
      [1, 0, 0, 1],
      [],
    ],
    [
      'a failing status context',
      [statusContext('ci/legacy', 'FAILURE')],
      'failed',
      [1, 0, 1, 0],
      ['ci/legacy'],
    ],
    [
      'an errored status context',
      [statusContext('ci/legacy', 'ERROR')],
      'failed',
      [1, 0, 1, 0],
      ['ci/legacy'],
    ],
    [
      'both node shapes, passing',
      [checkRun('test', 'SUCCESS'), statusContext('ci/legacy', 'SUCCESS')],
      'passed',
      [2, 2, 0, 0],
      [],
    ],
    [
      'both node shapes, the status context failing',
      [checkRun('test', 'SUCCESS'), statusContext('ci/legacy', 'FAILURE')],
      'failed',
      [2, 1, 1, 0],
      ['ci/legacy'],
    ],
    [
      'a pending check and a failing check: failed wins',
      [checkRun('a', null, 'IN_PROGRESS'), checkRun('b', 'FAILURE')],
      'failed',
      [2, 0, 1, 1],
      ['b'],
    ],
    [
      'a failing node with no name',
      [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
      'failed',
      [1, 0, 1, 0],
      ['unknown'],
    ],
  ]

  it.each(CASES)('reads %s', async (_name, statusCheckRollup, checks, counts, failing) => {
    const [total, passed, failedCount, pending] = counts
    expect(await oneReport(view({ statusCheckRollup }))).toEqual({
      prs: [
        entry({
          checks,
          check_counts: { total, passed, failed: failedCount, pending },
          failing_checks: failing,
        }),
      ],
    })
  })

  it('reads a null rollup as no checks, never as passed', async () => {
    expect(await oneReport(view({ statusCheckRollup: null }))).toEqual({ prs: [entry()] })
  })

  it('reads a reply with no rollup as no checks, never as passed', async () => {
    const { statusCheckRollup: _dropped, ...rest } = view()
    expect(await oneReport(rest)).toEqual({ prs: [entry()] })
  })
})

describe('the error entries', () => {
  it.each([
    ['a URL on another host', 'https://example.com/octo/app/pull/1'],
    ['an issue URL', 'https://github.com/octo/app/issues/1'],
    ['a URL with a trailing path', 'https://github.com/octo/app/pull/1/files'],
    ['a URL that is not https', 'http://github.com/octo/app/pull/1'],
    ['a URL with no number', 'https://github.com/octo/app/pull/'],
    ['a word', 'not a url'],
    ['a number too large to name exactly', `https://github.com/octo/app/pull/${'9'.repeat(20)}`],
  ])('gives %s an entry that says so, and does not run gh', async (_name, url) => {
    const result = await prStatus(
      context([url]),
      () => {
        throw new Error('no client may be made for this URL')
      },
      noProcess,
    )
    expect(result).toEqual({
      outcome: 'failed',
      error: '1 of 1 pull request URLs could not be read',
      report: { prs: [{ url, error: 'not a GitHub pull request URL' }] },
    })
  })

  it('gives a failed gh pr view an entry with the words that gh wrote', async () => {
    const said =
      'GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)'
    const url = 'https://github.com/octo/app/pull/999'
    const result = await prStatus(
      context([url]),
      mockFactory({ 'octo/app#999': ghFails(said) }),
      noProcess,
    )
    expect(result).toEqual({
      outcome: 'failed',
      error: '1 of 1 pull request URLs could not be read',
      report: { prs: [{ url, error: said }] },
    })
  })

  it('gives an answer that it cannot read an entry, with the first characters of it', async () => {
    const reply = view({ statusCheckRollup: 'nope' })
    const result = await prStatus(context([APP]), mockFactory({ 'octo/app#12': reply }), noProcess)
    expect(result).toEqual({
      outcome: 'failed',
      error: '1 of 1 pull request URLs could not be read',
      report: {
        prs: [
          { url: APP, error: `gh pr view output could not be parsed: ${JSON.stringify(reply)}` },
        ],
      },
    })
  })

  it('cuts an answer that it cannot read at 200 characters', async () => {
    const reply = view({ statusCheckRollup: 'x'.repeat(500) })
    expect(await oneReport(reply)).toEqual({
      prs: [
        {
          url: APP,
          error: `gh pr view output could not be parsed: ${JSON.stringify(reply).slice(0, 200)}`,
        },
      ],
    })
  })

  it.each([
    ['a list with a node that is a string', ['nope']],
    ['a list with a node that is null', [null]],
    ['a list with a node that is a list', [[]]],
    ['an object', {}],
  ])('cannot read a rollup that is %s', async (_name, statusCheckRollup) => {
    const result = await prStatus(
      context([APP]),
      mockFactory({ 'octo/app#12': view({ statusCheckRollup }) }),
      noProcess,
    )
    expect(result).toMatchObject({
      outcome: 'failed',
      report: {
        prs: [
          { url: APP, error: expect.stringMatching(/^gh pr view output could not be parsed: /) },
        ],
      },
    })
  })

  it('does not hide a defect: an error that is not from gh is thrown', async () => {
    await expect(
      prStatus(context([APP]), mockFactory({ 'octo/app#12': new Error('boom') }), noProcess),
    ).rejects.toThrow('boom')
  })
})

describe('a run over several URLs', () => {
  it('keeps the entries in argument order, and reads each in its own repository', async () => {
    const other = 'https://github.com/octo/other/pull/34'
    const result = await prStatus(
      context([other, APP]),
      mockFactory({
        'octo/app#12': view({ number: 12 }),
        'octo/other#34': view({ number: 34, mergeStateStatus: 'BEHIND' }),
      }),
      noProcess,
    )
    expect(result).toEqual({
      outcome: 'ok',
      value: {
        prs: [
          entry({
            url: other,
            number: 34,
            repo: 'octo/other',
            merge_state: 'BEHIND',
            behind: true,
          }),
          entry(),
        ],
      },
    })
  })

  it('leaves the good entries whole when a bad URL is between them, and fails with the full report', async () => {
    const gone = 'https://github.com/octo/app/pull/404'
    const later = 'https://github.com/octo/app/pull/13'
    const result = await prStatus(
      context([APP, 'not a url', gone, later]),
      mockFactory({
        'octo/app#12': view(),
        'octo/app#404': ghFails(
          'GraphQL: Could not resolve to a PullRequest with the number of 404.',
        ),
        'octo/app#13': view({ number: 13 }),
      }),
      noProcess,
    )
    expect(result).toEqual({
      outcome: 'failed',
      error: '2 of 4 pull request URLs could not be read',
      report: {
        prs: [
          entry(),
          { url: 'not a url', error: 'not a GitHub pull request URL' },
          {
            url: gone,
            error: 'GraphQL: Could not resolve to a PullRequest with the number of 404.',
          },
          entry({ url: later, number: 13 }),
        ],
      },
    })
  })
})

describe('the command line', () => {
  it('answers the usage line when no URL is given', async () => {
    expect(await prStatus(context([]), mockFactory({}), noProcess)).toEqual({
      outcome: 'failed',
      error: USAGE,
    })
  })

  it('answers the usage line when only the prefix is given', async () => {
    expect(await prStatus(context(['--env-prefix', 'env']), mockFactory({}), noProcess)).toEqual({
      outcome: 'failed',
      error: USAGE,
    })
  })

  it('refuses a flag that it does not know, with the words of node', async () => {
    const result = await prStatus(context(['--nope', APP]), mockFactory({}), noProcess)
    expect(result?.outcome).toBe('failed')
    expect(result?.outcome === 'failed' && result.error).toContain('--nope')
  })
})

/** What a runner that records its calls, and answers as gh does, gives back. */
const recordingRunner = (stdout: string, stderr = '') => {
  const calls: { command: string; args: readonly string[] }[] = []
  const runner: Runner = async (command, args = []) => {
    calls.push({ command, args })
    return {
      status: 0,
      signal: null,
      stdout,
      stderr,
      combined: stdout + stderr,
      timedOut: false,
      elapsedMs: 0,
      startFailure: null,
      streamErrors: [],
    } satisfies RunResult
  }
  return { runner, calls }
}

describe('the process that runs gh', () => {
  const real: ClientFactory = createGhClient

  it('runs gh with the number and the repository, and the field list of the client', async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(view()))
    await prStatus(context([APP]), real, runner)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('gh')
    expect(calls[0]?.args.slice(0, 5)).toEqual(['pr', 'view', '12', '--repo', 'octo/app'])
    expect(calls[0]?.args[5]).toBe('--json')
    expect(calls[0]?.args[6]).toContain('headRefName,baseRefName')
  })

  it('puts the prefix before gh when --env-prefix is given', async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(view()))
    await prStatus(context(['--env-prefix', 'env', APP]), real, runner)
    expect(calls[0]?.command).toBe('env')
    expect(calls[0]?.args.slice(0, 6)).toEqual(['gh', 'pr', 'view', '12', '--repo', 'octo/app'])
  })

  it('splits a prefix of several words, in order', async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(view()))
    await prStatus(context(['--env-prefix', 'wrapper exec /work', APP]), real, runner)
    expect(calls[0]?.command).toBe('wrapper')
    expect(calls[0]?.args.slice(0, 4)).toEqual(['exec', '/work', 'gh', 'pr'])
  })

  it('reads a prefix of the word null as no prefix', async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(view()))
    await prStatus(context(['--env-prefix', 'null', APP]), real, runner)
    expect(calls[0]?.command).toBe('gh')
  })

  it('runs every URL through the prefix', async () => {
    const { runner, calls } = recordingRunner(JSON.stringify(view()))
    await prStatus(
      context(['--env-prefix', 'env', APP, 'https://github.com/octo/other/pull/34']),
      real,
      runner,
    )
    expect(calls.map((call) => call.command)).toEqual(['env', 'env'])
  })

  it('runs nothing but gh pr view, however many URLs it reads', async () => {
    // The read-only guarantee (ADR 008), as an absence: no other gh call.
    const { runner, calls } = recordingRunner(JSON.stringify(view()))
    await prStatus(
      context([APP, 'https://github.com/octo/other/pull/34', 'https://github.com/a/b/pull/1']),
      real,
      runner,
    )
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['pr', 'view'],
      ['pr', 'view'],
    ])
  })

  it('reads the reply when gh writes its upgrade notice on stderr and exits 0', async () => {
    const notice =
      'A new release of gh is available: 2.98.0 -> 2.99.0\nTo upgrade, run: brew upgrade gh\n'
    const { runner } = recordingRunner(JSON.stringify(view()), notice)
    expect(await prStatus(context([APP]), real, runner)).toEqual({
      outcome: 'ok',
      value: { prs: [entry()] },
    })
  })

  it('makes an entry, and not a crash, of a gh that answers with something that is not JSON', async () => {
    const { runner } = recordingRunner('A new release of gh is available')
    const result = await prStatus(context([APP]), real, runner)
    expect(result).toMatchObject({
      outcome: 'failed',
      report: {
        prs: [{ url: APP, error: expect.stringContaining('something that is not JSON') }],
      },
    })
  })

  it('gives gh the environment of the command', async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const runner: Runner = async (_command, _args, options) => {
      seen.push(options?.env)
      return (await recordingRunner(JSON.stringify(view())).runner('gh')) as RunResult
    }
    await prStatus(context([APP]), real, runner)
    expect(seen).toEqual([{ PATH: '/bin' }])
  })

  it('passes a call with no arguments to the runner as it is', async () => {
    // The wrapper must not depend on a client that always passes arguments.
    const { runner, calls } = recordingRunner('{}')
    const factory: ClientFactory = (options) => ({
      viewPullRequest: async () => {
        await options.run?.('gh')
        return view()
      },
    })
    await prStatus(context(['--env-prefix', 'env', APP]), factory, runner)
    expect(calls).toEqual([{ command: 'env', args: ['gh'] }])
  })
})

describe('the registered handler', () => {
  it('reads a URL with the real client factory and the real runner, and runs no gh for a bad one', async () => {
    expect(await prStatusCommand(context(['not-a-url']))).toMatchObject({
      outcome: 'failed',
      report: { prs: [{ url: 'not-a-url', error: 'not a GitHub pull request URL' }] },
    })
  })
})

describe('the entry point', () => {
  it('writes the full report on stdout, the message on stderr, and exits 1 for a bad URL', async () => {
    const sandbox = createSandbox()
    const result = await run(process.execPath, [ENTRY, 'pr-status', 'not-a-url'], {
      env: sandbox.env,
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      prs: [{ url: 'not-a-url', error: 'not a GitHub pull request URL' }],
    })
    expect(result.stderr.trim()).toBe('1 of 1 pull request URLs could not be read')
  })

  it('answers the usage line as a failure when no URL is given', async () => {
    const sandbox = createSandbox()
    const result = await run(process.execPath, [ENTRY, 'pr-status'], { env: sandbox.env })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: USAGE })
  })
})
