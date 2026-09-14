// The typed `gh` client: one method per operation the plugin performs,
// injected into handlers and substituted per method by their examples (issue
// #216's decision comment). `gh` is the one thing an example cannot run for
// real, because it is the network and someone else's state, so here the
// client's own two jobs are what is asserted: the request shape it builds,
// and what it makes of the reply.
//
// The substitution is the runner's documented spawn parameter, standing in
// for `gh` the process. Every stdout below is a real `gh` output shape and
// every stderr a real `gh` error spelling, tidied in neither direction:
// `gh api` reports `gh: Not Found (HTTP 404)`, while a subcommand reports
// `HTTP 422: Validation Failed: name already exists` with no `gh:` prefix.
import { describe, expect, it } from 'vitest'
import { parseEnvPrefix } from '../../plugins/gh-security/src/lib/env-prefix.ts'
import { unwrap } from '../../plugins/gh-security/src/lib/envelope.ts'
import { createGhClient } from '../../plugins/gh-security/src/lib/gh.ts'
import type { RunRequest, RunResult } from '../../plugins/gh-security/src/lib/process-runner.ts'

const answering = (result: Partial<RunResult>) => {
  const seen: RunRequest[] = []
  const spawn = (request: RunRequest): RunResult => {
    seen.push(request)
    return {
      command: request.command,
      args: request.args,
      status: 0,
      stdout: '',
      stderr: '',
      ...result,
    }
  }
  return { spawn, seen }
}

describe('listDependabotAlerts', () => {
  // `--paginate --slurp` answers one array per response page, which is the
  // nesting `discover-alerts.sh` collapses with `flatten` before it reads
  // anything. A client that handed the pages through would give every
  // consumer that job, and the one that forgot it would see a page as an
  // alert.
  it('asks the open-alerts endpoint and flattens the pages it answers with', () => {
    const { spawn, seen } = answering({
      stdout: '[[{"number":1},{"number":2}],[{"number":3}]]',
    })
    const client = createGhClient({ spawn })
    expect(unwrap(client.listDependabotAlerts({ repo: 'octo/app' }))).toEqual([
      { number: 1 },
      { number: 2 },
      { number: 3 },
    ])
    expect(seen).toEqual([
      {
        command: 'gh',
        args: [
          'api',
          'repos/octo/app/dependabot/alerts?state=open&per_page=100',
          '--paginate',
          '--slurp',
        ],
      },
    ])
  })

  // A JSON error object is not zero alerts. Read as one, a repository whose
  // alerts could not be fetched reports clean, which is the shape ADR 001
  // exists to refuse arriving through the network instead of a lockfile.
  it('refuses an error body rather than reading it as no alerts', () => {
    const { spawn } = answering({ stdout: '{"message":"Bad credentials"}' })
    expect(createGhClient({ spawn }).listDependabotAlerts({ repo: 'octo/app' })).toEqual({
      outcome: 'error',
      error: 'Unexpected API response for alerts for octo/app: Bad credentials',
    })
  })

  // A non-JSON body has no `.message` to read, so the two report differently
  // rather than one of them reporting nothing.
  it('reports a body that is not JSON at all as its own failure', () => {
    const { spawn } = answering({ stdout: '<html>502 Bad Gateway</html>' })
    expect(createGhClient({ spawn }).listDependabotAlerts({ repo: 'octo/app' })).toEqual({
      outcome: 'error',
      error: 'Invalid JSON response for alerts for octo/app',
    })
  })

  // A JSON body with no `.message` has nothing to quote, so the report says
  // what it saw instead of quoting an empty string.
  it.each([
    ['an object carrying no message', '{"documentation_url":"https://docs.github.com/rest"}'],
    ['a bare string', '"OPEN"'],
    ['a number', '42'],
  ])('reports %s as not being the array of pages it expected', (_shape, stdout) => {
    const { spawn } = answering({ stdout })
    expect(createGhClient({ spawn }).listDependabotAlerts({ repo: 'octo/app' })).toEqual({
      outcome: 'error',
      error: 'Unexpected API response for alerts for octo/app: response is not a JSON array',
    })
  })

  it('reports a JSON array whose pages are not arrays', () => {
    const { spawn } = answering({ stdout: '[{"number":1}]' })
    const envelope = createGhClient({ spawn }).listDependabotAlerts({ repo: 'octo/app' })
    expect(envelope).toEqual({
      outcome: 'error',
      error: 'Unexpected API response for alerts for octo/app: a page is not an array of results',
    })
  })

  // No alerts is an answer, and it is not the same as a failed fetch.
  it('answers an empty list for a repository with no open alerts', () => {
    const { spawn } = answering({ stdout: '[[]]' })
    expect(unwrap(createGhClient({ spawn }).listDependabotAlerts({ repo: 'octo/app' }))).toEqual([])
  })

  // `gh api`'s own spelling, which is what a caller classifies. Copied, not
  // tidied: the `gh: ` prefix is part of it.
  it('carries the gh error wording when the fetch fails', () => {
    const { spawn } = answering({ status: 1, stderr: 'gh: Not Found (HTTP 404)\n' })
    const envelope = createGhClient({ spawn }).listDependabotAlerts({ repo: 'octo/app' })
    expect(envelope.outcome === 'error' && envelope.error).toContain('gh: Not Found (HTTP 404)')
  })
})

describe('listAdvisories', () => {
  it('narrows by package and ecosystem, and flattens the pages', () => {
    const { spawn, seen } = answering({
      stdout: '[[{"ghsa_id":"GHSA-1"}],[{"ghsa_id":"GHSA-2"}]]',
    })
    const client = createGhClient({ spawn })
    expect(unwrap(client.listAdvisories({ package: 'lodash', ecosystem: 'npm' }))).toEqual([
      { ghsa_id: 'GHSA-1' },
      { ghsa_id: 'GHSA-2' },
    ])
    expect(seen).toEqual([
      {
        command: 'gh',
        args: [
          'api',
          'advisories?affects=lodash&ecosystem=npm&per_page=100',
          '--paginate',
          '--slurp',
        ],
      },
    ])
  })

  // A scoped name reaches the query as written, which is what the script this
  // replaces sends and what the field runs are evidence for.
  it('sends a scoped package name as written', () => {
    const { spawn, seen } = answering({ stdout: '[[]]' })
    createGhClient({ spawn }).listAdvisories({ package: '@babel/core', ecosystem: 'npm' })
    expect(seen[0]?.args[1]).toBe('advisories?affects=@babel/core&ecosystem=npm&per_page=100')
  })
})

describe('findOpenPullRequest', () => {
  it('searches by head branch and answers the first URL', () => {
    const { spawn, seen } = answering({
      stdout: '[{"url":"https://github.com/octo/app/pull/12"}]',
    })
    const client = createGhClient({ spawn })
    expect(unwrap(client.findOpenPullRequest({ repo: 'octo/app', head: 'fix/lodash-4' }))).toBe(
      'https://github.com/octo/app/pull/12',
    )
    // The request shape: that the lookup searched `head:...`, scoped to the
    // repository and to open PRs. Not a count and not an order.
    expect(seen).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'list',
          '--repo',
          'octo/app',
          '--search',
          'head:fix/lodash-4',
          '--state',
          'open',
          '--json',
          'url',
        ],
      },
    ])
  })

  // No match is an answer, and it has to stay distinguishable from a search
  // that could not run: folding them together is how a group whose PR is
  // already open gets dispatched again.
  it('answers null when no open PR is headed from the branch', () => {
    const { spawn } = answering({ stdout: '[]\n' })
    const client = createGhClient({ spawn })
    expect(
      unwrap(client.findOpenPullRequest({ repo: 'octo/app', head: 'fix/lodash-4' })),
    ).toBeNull()
  })

  it('is a failure, not a null, when the search itself failed', () => {
    const { spawn } = answering({ status: 1, stderr: 'gh: Not Found (HTTP 404)\n' })
    const client = createGhClient({ spawn })
    expect(client.findOpenPullRequest({ repo: 'octo/app', head: 'fix/lodash-4' }).outcome).toBe(
      'error',
    )
  })

  it.each([
    ['{"message":"Validation Failed"}', 'is not an array'],
    ['[{"number":12}]', 'carries no url'],
    ['[{"url":""}]', 'carries an empty url'],
    ['["https://github.com/octo/app/pull/12"]', 'is not a result object'],
    ['not json at all', 'is not JSON'],
  ])('refuses a reply that %s, rather than reading it as no PR', (stdout) => {
    const { spawn } = answering({ stdout })
    const client = createGhClient({ spawn })
    expect(client.findOpenPullRequest({ repo: 'octo/app', head: 'fix/lodash-4' }).outcome).toBe(
      'error',
    )
  })
})

describe('viewPullRequest', () => {
  const view = {
    number: 12,
    state: 'OPEN',
    isDraft: false,
    headRefName: 'fix/lodash-4',
    baseRefName: 'main',
    mergeStateStatus: 'BEHIND',
    statusCheckRollup: [{ name: 'gates', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }

  it('asks for exactly the fields the status report is built from', () => {
    const { spawn, seen } = answering({ stdout: JSON.stringify(view) })
    const client = createGhClient({ spawn })
    expect(unwrap(client.viewPullRequest({ url: 'https://github.com/octo/app/pull/12' }))).toEqual(
      view,
    )
    expect(seen).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'view',
          'https://github.com/octo/app/pull/12',
          '--json',
          'number,state,isDraft,headRefName,baseRefName,mergeStateStatus,statusCheckRollup',
        ],
      },
    ])
  })

  // Both fields are legitimately null on a real PR: a rollup arrives null on
  // a PR with no checks, and `mergeStateStatus` is null while GitHub is still
  // computing mergeability.
  it('reads a null rollup as no checks and a null merge state as unknown', () => {
    const { spawn } = answering({
      stdout: JSON.stringify({ ...view, mergeStateStatus: null, statusCheckRollup: null }),
    })
    const client = createGhClient({ spawn })
    const answered = unwrap(client.viewPullRequest({ url: 'https://github.com/octo/app/pull/12' }))
    expect(answered.mergeStateStatus).toBeNull()
    expect(answered.statusCheckRollup).toEqual([])
  })

  // Present and of the promised type, or a hard error, never a default (ADR
  // 001). One row per field, because a missing `isDraft` read straight takes
  // a branch of its own: the PR reports as ready for review.
  it.each([
    ['number', { ...view, number: '12' }],
    ['state', { ...view, state: 12 }],
    ['isDraft', { ...view, isDraft: 'false' }],
    ['headRefName', { ...view, headRefName: null }],
    ['baseRefName', { ...view, baseRefName: [] }],
    ['mergeStateStatus', { ...view, mergeStateStatus: 3 }],
    ['statusCheckRollup', { ...view, statusCheckRollup: {} }],
  ])('refuses a reply whose %s is not the promised type', (_field, body) => {
    const { spawn } = answering({ stdout: JSON.stringify(body) })
    const client = createGhClient({ spawn })
    expect(client.viewPullRequest({ url: 'https://github.com/octo/app/pull/12' })).toEqual({
      outcome: 'error',
      error:
        'gh pr view https://github.com/octo/app/pull/12 answered a pull request this client cannot read',
    })
  })

  it.each([
    ['an array', '[]'],
    ['a bare string', '"OPEN"'],
  ])('refuses a reply that is %s rather than an object', (_shape, stdout) => {
    const { spawn } = answering({ stdout })
    const client = createGhClient({ spawn })
    expect(client.viewPullRequest({ url: 'https://github.com/octo/app/pull/12' })).toEqual({
      outcome: 'error',
      error: 'gh pr view https://github.com/octo/app/pull/12 did not answer with a JSON object',
    })
  })

  // `gh`'s own chatter arrives on stderr WITH a zero exit (the release
  // upgrade notice is the common one), which is why the runner keeps the two
  // streams apart and this parses stdout alone.
  it('parses stdout alone, ignoring chatter on stderr', () => {
    const { spawn } = answering({
      stdout: JSON.stringify(view),
      stderr: 'A new release of gh is available: 2.62.0 -> 2.63.0\n',
    })
    const client = createGhClient({ spawn })
    expect(
      unwrap(client.viewPullRequest({ url: 'https://github.com/octo/app/pull/12' })).number,
    ).toBe(12)
  })

  it('refuses a reply that is not JSON', () => {
    const { spawn } = answering({ stdout: 'no such pull request' })
    const client = createGhClient({ spawn })
    expect(client.viewPullRequest({ url: 'https://github.com/octo/app/pull/12' })).toEqual({
      outcome: 'error',
      error: 'Invalid JSON response for gh pr view https://github.com/octo/app/pull/12',
    })
  })

  it('carries the gh error wording when the view fails', () => {
    const { spawn } = answering({ status: 1, stderr: 'gh: Not Found (HTTP 404)\n' })
    const client = createGhClient({ spawn })
    const envelope = client.viewPullRequest({ url: 'https://github.com/octo/app/pull/12' })
    expect(envelope.outcome === 'error' && envelope.error).toContain('gh: Not Found (HTTP 404)')
  })
})

describe('createLabel', () => {
  it('creates the label with its colour and description', () => {
    const { spawn, seen } = answering({})
    const client = createGhClient({ spawn })
    expect(
      unwrap(
        client.createLabel({
          repo: 'octo/app',
          name: 'merge-risk:low',
          color: '2da44e',
          description: 'Low merge risk',
        }),
      ),
    ).toEqual({ created: true })
    expect(seen).toEqual([
      {
        command: 'gh',
        args: [
          'label',
          'create',
          'merge-risk:low',
          '--repo',
          'octo/app',
          '--color',
          '2da44e',
          '--description',
          'Low merge risk',
        ],
      },
    ])
  })

  // Sibling agents in one batch race to create the same band label, and the
  // loser's failure means the label is there, which is what it wanted. The
  // spelling is `gh`'s real one for a subcommand: no `gh: ` prefix, unlike
  // `gh api`'s.
  it('treats a label that already exists as a success that created nothing', () => {
    const { spawn } = answering({
      status: 1,
      stderr: 'HTTP 422: Validation Failed: name already exists',
    })
    const client = createGhClient({ spawn })
    expect(
      unwrap(
        client.createLabel({
          repo: 'octo/app',
          name: 'security',
          color: 'D93F0B',
          description: 'Security fix',
        }),
      ),
    ).toEqual({ created: false })
  })

  // The match runs against stderr ALONE. Matching a combined stream let any
  // failure whose stdout happened to carry the phrase read as success, which
  // is a label the PR then fails to apply.
  it('does not read the phrase out of stdout', () => {
    const { spawn } = answering({
      status: 1,
      stdout: 'the label security already exists in some other repository',
      stderr: 'HTTP 403: Resource not accessible by integration',
    })
    const client = createGhClient({ spawn })
    expect(
      client.createLabel({
        repo: 'octo/app',
        name: 'security',
        color: 'D93F0B',
        description: 'Security fix',
      }).outcome,
    ).toBe('error')
  })
})

describe('createPullRequest', () => {
  it('opens the PR with every label and answers with its URL', () => {
    const { spawn, seen } = answering({
      stdout:
        'Creating pull request for fix/lodash-4 into main in octo/app\n\nhttps://github.com/octo/app/pull/12\n',
    })
    const client = createGhClient({ spawn })
    expect(
      unwrap(
        client.createPullRequest({
          repo: 'octo/app',
          head: 'fix/lodash-4',
          title: 'fix(deps): lodash 4.17.21',
          bodyFile: '/w/fix/body.md',
          labels: ['security', 'dependencies', 'merge-risk:low'],
        }),
      ),
    ).toEqual({ url: 'https://github.com/octo/app/pull/12' })
    expect(seen).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'create',
          '--repo',
          'octo/app',
          '--head',
          'fix/lodash-4',
          '--label',
          'security',
          '--label',
          'dependencies',
          '--label',
          'merge-risk:low',
          '--title',
          'fix(deps): lodash 4.17.21',
          '--body-file',
          '/w/fix/body.md',
        ],
      },
    ])
  })

  it('opens a PR with no labels at all', () => {
    const { spawn, seen } = answering({ stdout: 'https://github.com/octo/app/pull/13\n' })
    const client = createGhClient({ spawn })
    expect(
      unwrap(
        client.createPullRequest({
          repo: 'octo/app',
          head: 'fix/lodash-4',
          title: 't',
          bodyFile: '/w/fix/body.md',
          labels: [],
        }),
      ),
    ).toEqual({ url: 'https://github.com/octo/app/pull/13' })
    expect(seen[0]?.args).not.toContain('--label')
  })

  // An exit 0 with no URL in the output is a success claim backed by nothing,
  // and the PR URL is what every later phase reads.
  it('refuses an exit 0 that produced no PR URL', () => {
    const { spawn } = answering({ stdout: 'Warning: 1 uncommitted change\n' })
    const client = createGhClient({ spawn })
    expect(
      client.createPullRequest({
        repo: 'octo/app',
        head: 'fix/lodash-4',
        title: 't',
        bodyFile: '/w/fix/body.md',
        labels: [],
      }),
    ).toEqual({
      outcome: 'error',
      error: 'gh pr create produced no PR URL. Output: Warning: 1 uncommitted change',
    })
  })

  it('carries the gh error wording when the create fails', () => {
    const { spawn } = answering({
      status: 1,
      stderr: 'pull request create failed: GraphQL: No commits between main and fix/lodash-4',
    })
    const client = createGhClient({ spawn })
    const envelope = client.createPullRequest({
      repo: 'octo/app',
      head: 'fix/lodash-4',
      title: 't',
      bodyFile: '/w/fix/body.md',
      labels: [],
    })
    expect(envelope.outcome === 'error' && envelope.error).toContain('No commits between')
  })
})

// The prefix reaches every method, because a bare `gh` in an environment that
// needs one reports "please run gh auth login" on a correctly configured
// machine (the plugin guide).
describe('a client built with an env_prefix', () => {
  it('runs gh under it', () => {
    const { spawn, seen } = answering({ stdout: '[[]]' })
    const client = createGhClient({ spawn, envPrefix: parseEnvPrefix('run-in exec /src/app') })
    client.listDependabotAlerts({ repo: 'octo/app' })
    client.createLabel({ repo: 'octo/app', name: 'security', color: 'D93F0B', description: 'x' })
    for (const request of seen) {
      expect(request.command).toBe('run-in')
      expect(request.args.slice(0, 3)).toEqual(['exec', '/src/app', 'gh'])
    }
  })
})
