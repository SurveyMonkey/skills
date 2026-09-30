// Parity for `pr-status` (RFC 002, "Parity is the migration strategy"). It runs
// `scripts/common/pr-status.sh` and the TypeScript command on the same
// recorded `gh pr view` replies, and compares the exit status and the whole
// report.
//
// `gh` is the one mock boundary (`mocking.md`). The bash side reads a `gh` stub
// on PATH that serves the recorded JSON for the PR number in the URL. The
// TypeScript side gets the same JSON from `createGhMock`. Nothing else is
// substituted: `jq` and `bash` are real.
//
// The bash script exits 1 when any URL made an error entry, and still writes the
// full report. `checkParity` refuses a non-zero bash status, so this file runs
// `runBash` itself and compares the status beside the report.
//
// Two differences are declared, and neither is compared here. The TypeScript
// side names the pull request to `gh` by number and `--repo`, where bash gives
// the whole URL, so the argv `gh` sees differs. The unit tests hold the argv.
// And `gh pr view` output that is not JSON becomes a `GhError` from the client
// before the command sees it. The unit tests hold that entry.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { type ClientFactory, prStatus } from '#gh-security/subcommands/pr-status.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'pr-status.sh')

const url = (number: number, repo = 'octo/app'): string =>
  `https://github.com/${repo}/pull/${number}`

// Stand-in for `gh`. It serves `<number>.json` and exits 0, or prints
// `<number>.err` on stderr and exits 1. Any other call fails, so a call that
// is not `gh pr view <url>` makes the bash side fail and not pass.
const GH_STUB = `#!/bin/sh
if [ "$1" != pr ] || [ "$2" != view ]; then
  echo "gh stub: unexpected call: $*" >&2
  exit 99
fi
number=\${3##*/}
if [ -f "$PR_STUB_DIR/$number.err" ]; then
  cat "$PR_STUB_DIR/$number.err" >&2
  exit 1
fi
cat "$PR_STUB_DIR/$number.json"
`

type Reply = Record<string, unknown> | { readonly failure: string }

const isFailure = (reply: Reply): reply is { readonly failure: string } => 'failure' in reply

/** What the bash script writes and exits with, on the stub. */
const bashSide = (replies: Readonly<Record<number, Reply>>, urls: readonly string[]) => {
  const sandbox = createSandbox()
  const bin = sandbox.join('bin')
  const data = sandbox.join('replies')
  mkdirSync(bin)
  mkdirSync(data)
  writeFileSync(sandbox.join('bin', 'gh'), GH_STUB)
  chmodSync(sandbox.join('bin', 'gh'), 0o755)
  for (const [number, reply] of Object.entries(replies)) {
    if (isFailure(reply))
      writeFileSync(sandbox.join('replies', `${number}.err`), `${reply.failure}\n`)
    else writeFileSync(sandbox.join('replies', `${number}.json`), JSON.stringify(reply))
  }
  return runBash({
    command: 'env',
    args: [`PATH=${bin}:${process.env.PATH ?? ''}`, `PR_STUB_DIR=${data}`, SCRIPT, ...urls],
  })
}

/** The same replies, served by the harness mock, one client per number. */
const typescriptSide = async (
  replies: Readonly<Record<number, Reply>>,
  urls: readonly string[],
): Promise<CommandResult> => {
  const mocks: GhReplies[] = []
  const factory: ClientFactory = () => ({
    viewPullRequest: (pull) => {
      const reply = replies[pull.pullRequest]
      const registered: GhReplies = {
        viewPullRequest:
          reply === undefined || isFailure(reply) ? ghFails(reply?.failure ?? '') : reply,
      }
      mocks.push(registered)
      return createGhMock(registered).viewPullRequest(pull)
    },
  })
  const context: CommandContext = {
    args: urls,
    env: {},
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
    commandNames: [],
  }
  const noProcess = () => Promise.reject(new Error('the mock client starts no process'))
  return prStatus(context, factory, noProcess)
}

const answerOf = (result: CommandResult): { status: number; json: JsonValue | undefined } => {
  if (result === undefined) throw new Error('pr-status answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  if ('report' in result) return { status: 1, json: result.report }
  return { status: exitCodeFor(result), json: undefined }
}

const expectParity = async (replies: Readonly<Record<number, Reply>>, urls: readonly string[]) => {
  const bash = bashSide(replies, urls)
  const typescript = answerOf(await typescriptSide(replies, urls))
  expect(typescript.status).toBe(bash.status)
  expect(bash.stderr).toBe('')
  expect(typescript.json).toBeDefined()
  expect(
    firstDifference(JSON.parse(bash.stdout) as JsonValue, typescript.json as JsonValue),
  ).toBeNull()
}

/** A `gh pr view` reply, with the fields that `pr-status` reads. */
const view = (
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  number,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'fix/dependabot-lodash',
  baseRefName: 'main',
  mergeStateStatus: 'UNKNOWN',
  statusCheckRollup: [],
  ...overrides,
})

const run = (name: string, conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
})

const context = (name: string, state: string) => ({
  __typename: 'StatusContext',
  context: name,
  state,
})

const ROLLUPS: readonly [string, readonly unknown[]][] = [
  ['an empty rollup', []],
  ['one passing check', [run('test', 'SUCCESS')]],
  ['a failing check beside a passing one', [run('test', 'SUCCESS'), run('lint', 'FAILURE')]],
  ['a check still running', [run('e2e', null, 'IN_PROGRESS')]],
  ['a queued check', [run('e2e', null, 'QUEUED')]],
  ['a neutral check', [run('advisory', 'NEUTRAL')]],
  ['a skipped check', [run('e2e', 'SKIPPED')]],
  ['a cancelled check', [run('e2e', 'CANCELLED')]],
  ['a timed out check', [run('e2e', 'TIMED_OUT')]],
  ['a completed check with no conclusion', [run('e2e', null)]],
  ['a passing status context', [context('ci/legacy', 'SUCCESS')]],
  ['a pending status context', [context('ci/legacy', 'PENDING')]],
  ['an expected status context', [context('ci/legacy', 'EXPECTED')]],
  ['a failing status context', [context('ci/legacy', 'FAILURE')]],
  ['an errored status context', [context('ci/legacy', 'ERROR')]],
  ['both node shapes, passing', [run('test', 'SUCCESS'), context('ci/legacy', 'SUCCESS')]],
  ['both node shapes, one failing', [run('test', 'SUCCESS'), context('ci/legacy', 'FAILURE')]],
  ['a failing node that has no name', [{ status: 'COMPLETED', conclusion: 'FAILURE' }]],
  ['a pending and a failing check', [run('a', null, 'IN_PROGRESS'), run('b', 'FAILURE')]],
]

describe('pr-status parity: the checks derivation', () => {
  it.each(ROLLUPS)('reports %s the same way', async (_name, statusCheckRollup) => {
    await expectParity({ 12: view(12, { statusCheckRollup }) }, [url(12)])
  })

  it('reports a null rollup as none, the same way', async () => {
    await expectParity({ 12: view(12, { statusCheckRollup: null }) }, [url(12)])
  })
})

describe('pr-status parity: the pull request fields', () => {
  it.each([
    ['UNKNOWN'],
    ['BEHIND'],
    ['DIRTY'],
    ['CLEAN'],
    ['BLOCKED'],
    ['UNSTABLE'],
    ['HAS_HOOKS'],
  ])(
    'passes merge state %s through raw and derives behind and conflict from it',
    async (mergeStateStatus) => {
      await expectParity({ 12: view(12, { mergeStateStatus }) }, [url(12)])
    },
  )

  it.each([[true], [false]])('reports isDraft %s as found', async (isDraft) => {
    await expectParity({ 12: view(12, { isDraft }) }, [url(12)])
  })

  it.each([['OPEN'], ['MERGED'], ['CLOSED']])('reports state %s as found', async (state) => {
    await expectParity({ 12: view(12, { state }) }, [url(12)])
  })

  it('reports the recorded reply of a real pull request the same way', async () => {
    const recorded = JSON.parse(
      readFileSync(`${FIXTURES_ROOT}/pr-view/pr-290.json`, 'utf8'),
    ) as Record<string, unknown>
    await expectParity({ 290: recorded }, [url(290, 'SurveyMonkey/skills')])
  })
})

describe('pr-status parity: the run as a whole', () => {
  it('keeps the entries in argument order across repositories', async () => {
    await expectParity(
      {
        12: view(12, { statusCheckRollup: [run('test', 'SUCCESS')] }),
        34: view(34, { mergeStateStatus: 'BEHIND' }),
      },
      [url(34, 'octo/other'), url(12)],
    )
  })

  it('reports a URL that is not a pull request URL as an error entry, and exits 1', async () => {
    await expectParity({ 12: view(12) }, [
      url(12),
      'https://example.com/octo/app/pull/1',
      'https://github.com/octo/app/issues/1',
      'not a url',
    ])
  })

  it('reports a failed gh pr view as an error entry with the words gh wrote, and exits 1', async () => {
    await expectParity(
      {
        12: view(12),
        999: {
          failure:
            'GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)',
        },
      },
      [url(999), url(12)],
    )
  })

  it('exits 1 with nothing on stdout when no URL is given', async () => {
    const bash = bashSide({}, [])
    const typescript = answerOf(await typescriptSide({}, []))
    expect(bash.status).toBe(1)
    expect(bash.stdout).toBe('')
    expect(typescript).toEqual({ status: 1, json: undefined })
  })
})
