// The real `gh` client. Nothing here spawns anything: the client takes the
// runner as its documented `run` option, so a stand-in drives the one thing
// that would start `gh` (the testing skill's mocking.md, "The injected
// collaborator"). The runner itself is tested against real children in
// `process.test.ts`.
//
// Every expected argv and message is written by hand, never derived from the
// client, so a change to the client can make a test disagree.
import { describe, expect, it } from 'vitest'

import { createGhClient, type GhClientOptions, GhError } from '#gh-security/lib/gh.ts'
import type { Runner, RunResult } from '#gh-security/lib/process.ts'

const FIELDS =
  'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
  'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision'

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly env: NodeJS.ProcessEnv | undefined
  readonly timeoutMs: number | undefined
}

/** What the runner answers with. A field not given is what a child that
 *  succeeded and wrote nothing would report. */
interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly status?: number | null
  readonly signal?: NodeJS.Signals
  readonly timedOut?: boolean
  readonly elapsedMs?: number
  readonly startFailure?: { code: string; message: string }
  readonly streamErrors?: Array<{ code: string; message: string }>
}

const asResult = (reply: Reply): RunResult => ({
  status: reply.status === undefined ? 0 : reply.status,
  signal: reply.signal ?? null,
  stdout: reply.stdout ?? '',
  stderr: reply.stderr ?? '',
  combined: `${reply.stdout ?? ''}${reply.stderr ?? ''}`,
  timedOut: reply.timedOut ?? false,
  elapsedMs: reply.elapsedMs ?? 0,
  startFailure: reply.startFailure ?? null,
  streamErrors: reply.streamErrors ?? [],
})

/** A client whose runner answers `reply` and records each call. */
const clientAnswering = (reply: Reply, options: Omit<GhClientOptions, 'run'> = {}) => {
  const calls: Call[] = []
  const answering: Runner = async (command, args, runOptions) => {
    calls.push({
      command,
      args: args ?? [],
      cwd: runOptions?.cwd,
      env: runOptions?.env,
      timeoutMs: runOptions?.timeoutMs,
    })
    return asResult(reply)
  }
  return { gh: createGhClient({ ...options, run: answering }), calls }
}

/** The error a call rejects with. */
const refusal = async (reply: Reply, options: Omit<GhClientOptions, 'run'> = {}) => {
  const { gh } = clientAnswering(reply, options)
  return (await gh
    .viewPullRequest({ pullRequest: 7 })
    .catch((thrown: unknown) => thrown)) as GhError
}

describe('the argv', () => {
  it('asks gh pr view for one pull request with the field list, and nothing more', async () => {
    const { gh, calls } = clientAnswering({ stdout: '{}' })
    await gh.viewPullRequest({ pullRequest: 7 })
    // The whole argv, not a prefix: a slice lets a stray flag in at the end.
    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: 'gh', args: ['pr', 'view', '7', '--json', FIELDS] },
    ])
  })

  it('names the repository when the client was given one', async () => {
    const { gh, calls } = clientAnswering({ stdout: '{}' }, { repository: 'octo/app' })
    await gh.viewPullRequest({ pullRequest: 7 })
    expect(calls[0]?.args).toEqual(['pr', 'view', '7', '--repo', 'octo/app', '--json', FIELDS])
  })

  it('names an empty repository as given, rather than reading it as absent', async () => {
    // `filter` tests `undefined`, not truthiness, as the target stack does.
    const { gh, calls } = clientAnswering({ stdout: '{}' }, { repository: '' })
    await gh.viewPullRequest({ pullRequest: 7 })
    expect(calls[0]?.args).toEqual(['pr', 'view', '7', '--repo', '', '--json', FIELDS])
  })

  it('spells pull request 0 as 0', async () => {
    const { gh, calls } = clientAnswering({ stdout: '{}' })
    await gh.viewPullRequest({ pullRequest: 0 })
    expect(calls[0]?.args).toEqual(['pr', 'view', '0', '--json', FIELDS])
  })
})

describe('the client options', () => {
  it('runs gh where it was told to, and in the current directory otherwise', async () => {
    const here = clientAnswering({ stdout: '{}' }, { cwd: '/w/app' })
    await here.gh.viewPullRequest({ pullRequest: 7 })
    const anywhere = clientAnswering({ stdout: '{}' })
    await anywhere.gh.viewPullRequest({ pullRequest: 7 })
    expect([here.calls[0]?.cwd, anywhere.calls[0]?.cwd]).toEqual(['/w/app', undefined])
  })

  it('hands gh the environment it was built with, and none otherwise', async () => {
    const pinned = clientAnswering({ stdout: '{}' }, { env: { PATH: '/usr/bin' } })
    await pinned.gh.viewPullRequest({ pullRequest: 7 })
    const ambient = clientAnswering({ stdout: '{}' })
    await ambient.gh.viewPullRequest({ pullRequest: 7 })
    expect([pinned.calls[0]?.env, ambient.calls[0]?.env]).toEqual([{ PATH: '/usr/bin' }, undefined])
  })

  it('binds each call when the client has a bound, and leaves it unbound otherwise', async () => {
    const bound = clientAnswering({ stdout: '{}' }, { boundMs: 5_000 })
    await bound.gh.viewPullRequest({ pullRequest: 7 })
    const unbound = clientAnswering({ stdout: '{}' })
    await unbound.gh.viewPullRequest({ pullRequest: 7 })
    expect([bound.calls[0]?.timeoutMs, unbound.calls[0]?.timeoutMs]).toEqual([5_000, undefined])
  })

  it("defaults to process.ts's runner, with the one endpoint present", () => {
    // Built, not called: a call would start the real `gh`.
    expect(Object.keys(createGhClient())).toEqual(['viewPullRequest'])
  })
})

describe('the answer', () => {
  it('hands back the object gh printed', async () => {
    const { gh } = clientAnswering({ stdout: '{"number":7,"state":"OPEN","isDraft":false}' })
    await expect(gh.viewPullRequest({ pullRequest: 7 })).resolves.toEqual({
      number: 7,
      state: 'OPEN',
      isDraft: false,
    })
  })

  it('hands back an empty object as an answer', async () => {
    const { gh } = clientAnswering({ stdout: '{}' })
    await expect(gh.viewPullRequest({ pullRequest: 7 })).resolves.toEqual({})
  })

  it('answers from stdout alone, and leaves a notice on stderr out of it', async () => {
    // gh writes release and auth notices to stderr when it exits 0.
    const { gh } = clientAnswering({ stdout: '{"number":7}', stderr: 'gh: a new release\n' })
    await expect(gh.viewPullRequest({ pullRequest: 7 })).resolves.toEqual({ number: 7 })
  })
})

describe('GhError', () => {
  it('carries its message, status, detail and cause, and names itself', () => {
    const cause = { stderr: 'x' }
    const error = new GhError('gh pr view 7 failed: x', 4, { cause, detail: 'x' })
    expect(error).toBeInstanceOf(Error)
    expect({
      name: error.name,
      message: error.message,
      status: error.status,
      detail: error.detail,
      cause: error.cause,
    }).toEqual({
      name: 'GhError',
      message: 'gh pr view 7 failed: x',
      status: 4,
      detail: 'x',
      cause,
    })
  })
})

describe('a refusal', () => {
  it("throws gh's own words, its status, and the whole run, when gh exits non-zero", async () => {
    const error = await refusal({
      status: 1,
      stderr: 'GraphQL: Could not resolve to a PullRequest\n',
    })
    expect(error).toBeInstanceOf(GhError)
    expect({ message: error.message, detail: error.detail, status: error.status }).toEqual({
      message: `gh pr view 7 --json ${FIELDS} failed: GraphQL: Could not resolve to a PullRequest`,
      detail: 'GraphQL: Could not resolve to a PullRequest',
      status: 1,
    })
    expect(error.cause).toMatchObject({
      status: 1,
      stderr: 'GraphQL: Could not resolve to a PullRequest\n',
    })
  })

  it('names the status when gh exited non-zero and said nothing', async () => {
    const error = await refusal({ status: 1 })
    expect(error.detail).toBe('gh exited 1')
  })

  it('names the status when stderr is only white space', async () => {
    const error = await refusal({ status: 2, stderr: ' \n' })
    expect(error.detail).toBe('gh exited 2')
  })

  it('names the signal when something killed gh', async () => {
    const error = await refusal({ status: null, signal: 'SIGKILL' })
    expect({ detail: error.detail, status: error.status }).toEqual({
      detail: 'gh was killed by SIGKILL',
      status: null,
    })
  })

  it("reports a gh that never started as node's account, over what stderr says", async () => {
    const error = await refusal({
      status: 127,
      stderr: 'stray\n',
      timedOut: true,
      startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' },
    })
    expect({ detail: error.detail, status: error.status }).toEqual({
      detail: 'cannot run gh: spawn gh ENOENT',
      status: 127,
    })
  })

  it("reports a call that timed out as the bound, over gh's words and a pipe error", async () => {
    // stderr is there, a pipe failed, and `elapsedMs` differs from the
    // bound, so a reply that read any of them would turn this red.
    const error = await refusal(
      {
        timedOut: true,
        status: null,
        signal: 'SIGKILL',
        elapsedMs: 5_014,
        stderr: 'gh: API rate limit exceeded\n',
        streamErrors: [{ code: 'EIO', message: 'read EIO' }],
      },
      { boundMs: 5_000 },
    )
    expect(error.detail).toBe('gh did not answer in 5000 ms')
  })

  it('reports a bound of 0 as 0, not as the measured time', async () => {
    const error = await refusal({ timedOut: true, status: null, elapsedMs: 3 }, { boundMs: 0 })
    expect(error.detail).toBe('gh did not answer in 0 ms')
  })

  it('reports the measured time when a client with no bound times out', async () => {
    const error = await refusal({ timedOut: true, status: null, elapsedMs: 1_234 })
    expect(error.detail).toBe('gh did not answer in 1234 ms')
  })

  it("throws when one of gh's pipes failed, over gh's words, even on exit 0", async () => {
    const error = await refusal({
      stdout: '{"number":7}',
      stderr: 'gh: a new release\n',
      streamErrors: [{ code: 'EIO', message: 'read EIO' }],
    })
    expect({ detail: error.detail, status: error.status }).toEqual({
      detail: "gh's output could not be read: EIO, read EIO",
      status: 0,
    })
  })

  it('throws when gh answered with something that is not JSON, with the run as cause', async () => {
    const error = await refusal({ stdout: 'not json at all', stderr: 'a note\n' })
    expect(error).toBeInstanceOf(GhError)
    expect(error.message).toMatch(/^gh answered gh pr view with something that is not JSON: /)
    // No argv prefix to remove, so the account and the message are one.
    expect(error.detail).toBe(error.message)
    expect(error.status).toBe(0)
    expect(error.cause).toMatchObject({ stdout: 'not json at all', stderr: 'a note\n' })
  })

  it('throws when gh answered nothing at all', async () => {
    const error = await refusal({ stdout: '' })
    expect(error.message).toMatch(/^gh answered gh pr view with something that is not JSON: /)
  })

  // The falsy JSON values are here on purpose: a guard that tested truthiness
  // would pass `0`, `false` and `""` through as a pull request.
  it.each([
    ['null', 'null'],
    ['a list', '[{"number":7}]'],
    ['an empty list', '[]'],
    ['a string', '"octo/app#7"'],
    ['an empty string', '""'],
    ['0', '0'],
    ['false', 'false'],
    ['a number', '7'],
  ])('throws when gh answered %s', async (_shape, stdout) => {
    const error = await refusal({ stdout })
    expect({ message: error.message, detail: error.detail, status: error.status }).toEqual({
      message: `gh answered gh pr view with something that is not an object: ${stdout}`,
      detail: `gh answered gh pr view with something that is not an object: ${stdout}`,
      status: 0,
    })
    expect(error.cause).toMatchObject({ stdout })
  })
})
