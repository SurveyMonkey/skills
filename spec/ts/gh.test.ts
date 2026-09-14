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
})
