// The process runner (ADR 012: a process seam exists only at an ecosystem
// boundary). The seam is the exported surface, and the spawn function is a
// documented parameter, so an example substitutes it through that parameter
// exactly as `spec/fix_group_spec.sh` substitutes an adapter through
// `--adapter` (the testing skill's mocking.md, "The injected collaborator").
//
// The default spawn is never substituted away from: `nodeSpawn` IS the
// boundary, so the block at the bottom runs real processes through it. A
// stand-in there would assert nothing about the thing under test.
//
// Expected values are hand-written from what a shell reports (127 for a
// command it cannot find, 128 plus the signal number for a signal death) and
// from real `node` and `sh` output.
import { describe, expect, it } from 'vitest'

import { isOk } from '../../plugins/gh-security/src/lib/envelope.ts'
import {
  describeRun,
  MAX_OUTPUT_BYTES,
  type RunRequest,
  type RunResult,
  run,
  runOk,
  SIGNAL_EXIT_BASE,
  SPAWN_FAILED,
} from '../../plugins/gh-security/src/lib/process-runner.ts'

const spawnReturning = (result: Partial<RunResult>) => {
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

describe('run', () => {
  it('hands the request to the injected spawn and returns what it answered', () => {
    const { spawn, seen } = spawnReturning({ status: 0, stdout: 'v2.51.0\n' })
    expect(run({ command: 'git', args: ['--version'] }, spawn)).toEqual({
      command: 'git',
      args: ['--version'],
      status: 0,
      stdout: 'v2.51.0\n',
      stderr: '',
    })
    // The request shape, which is what a log assertion may claim
    // (mocking.md). Not a count and not an order.
    expect(seen).toEqual([{ command: 'git', args: ['--version'] }])
  })

  it('carries cwd, stdin and added environment through to the spawn', () => {
    const { spawn, seen } = spawnReturning({})
    run(
      {
        command: 'gh',
        args: ['pr', 'create'],
        cwd: '/w/fix',
        input: 'body',
        env: { GH_TOKEN: 'x' },
      },
      spawn,
    )
    expect(seen[0]).toEqual({
      command: 'gh',
      args: ['pr', 'create'],
      cwd: '/w/fix',
      input: 'body',
      env: { GH_TOKEN: 'x' },
    })
  })
})

describe('runOk', () => {
  it('is a success carrying the result when the command exits 0', () => {
    const { spawn } = spawnReturning({ status: 0, stdout: '{"pm":"pnpm"}' })
    const envelope = runOk({ command: 'gh', args: ['api', 'rate_limit'] }, spawn)
    expect(isOk(envelope)).toBe(true)
    expect(envelope).toEqual({
      outcome: 'ok',
      value: {
        command: 'gh',
        args: ['api', 'rate_limit'],
        status: 0,
        stdout: '{"pm":"pnpm"}',
        stderr: '',
      },
    })
  })

  // The verdict, not the parse: a non-zero status has to become a failure
  // envelope carrying the command's own diagnosis, because that string is
  // what the caller reports and, for `gh`, what it classifies. The spelling
  // is `gh`'s real one for a 404 on `gh api`.
  it('is a failure naming the command and quoting its stderr', () => {
    const { spawn } = spawnReturning({
      status: 1,
      stderr: 'gh: Not Found (HTTP 404)\n',
    })
    expect(runOk({ command: 'gh', args: ['api', 'repos/octo/app/foo'] }, spawn)).toEqual({
      outcome: 'error',
      error: 'gh api repos/octo/app/foo failed (exit 1): gh: Not Found (HTTP 404)',
    })
  })
})

describe('describeRun', () => {
  const result = (over: Partial<RunResult>): RunResult => ({
    command: 'gh',
    args: ['label', 'create', 'security'],
    status: 1,
    stdout: '',
    stderr: '',
    ...over,
  })

  it('quotes stderr when there is stderr', () => {
    // `gh`'s spelling for a subcommand failure: no `gh:` prefix, unlike
    // `gh api`'s. Both spellings are in this suite because classifying that
    // text is what a caller does with it.
    expect(
      describeRun(result({ stderr: 'HTTP 422: Validation Failed: name already exists' })),
    ).toBe(
      'gh label create security failed (exit 1): HTTP 422: Validation Failed: name already exists',
    )
  })

  it('falls back to stdout when the command diagnosed itself there', () => {
    expect(describeRun(result({ stdout: '{"error":"jq is required"}\n' }))).toBe(
      'gh label create security failed (exit 1): {"error":"jq is required"}',
    )
  })

  // A command that failed silently says so. An empty quote reads as no
  // failure at all, which is the found-nothing-is-a-pass shape in miniature.
  it('says so when the command wrote nothing at all', () => {
    expect(describeRun(result({ status: 3 }))).toBe(
      'gh label create security failed (exit 3): no output',
    )
  })
})

// The boundary itself, through the default spawn: no substitution, real
// child processes. `nodeSpawn` is what every example above stands in for, so
// these are the only examples that can say it works.
describe('nodeSpawn, through run with no spawn argument', () => {
  it('captures stdout, stderr and the exit status of a real process', () => {
    const result = run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(4)'],
    })
    expect(result).toEqual({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(4)'],
      status: 4,
      stdout: 'out',
      stderr: 'err',
    })
  })

  it('writes input to the child and runs it in the requested directory', () => {
    const result = run({
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout);process.stdout.write(process.cwd())'],
      cwd: '/',
      input: '|piped',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('/|piped')
  })

  // Added to the inherited environment, never replacing it: a git helper sets
  // GIT_CONFIG_GLOBAL without having to rebuild PATH, and a command that needs
  // PATH still finds it.
  it('adds to the environment rather than replacing it', () => {
    const result = run({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(process.env.GH_SECURITY_PROBE + ":" + String(!!process.env.PATH))',
      ],
      env: { GH_SECURITY_PROBE: 'set' },
    })
    expect(result.stdout).toBe('set:true')
  })

  // A command that never started is 127 with node's own message, not an
  // exception unwinding through a caller that did not expect one (RFC 002's
  // named risk for the in-process port).
  it('reports a command that is not on PATH as 127, quoting the spawn error', () => {
    const result = run({ command: 'gh-security-no-such-command', args: ['--version'] })
    expect(result.status).toBe(SPAWN_FAILED)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('ENOENT')
  })

  // A signal death has no exit code at all. Reporting it as 0 would read as
  // success, and reporting it as 1 would be indistinguishable from an
  // ordinary failure; 128 plus the signal number is what a shell reports.
  it('reports a signal death as 128 plus the signal number', () => {
    const result = run({ command: '/bin/sh', args: ['-c', 'kill -9 $$'] })
    expect(result.status).toBe(SIGNAL_EXIT_BASE + 9)
  })

  it('allows an answer far larger than the 1 MiB node defaults to', () => {
    expect(MAX_OUTPUT_BYTES).toBe(64 * 1024 * 1024)
    const result = run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(4 * 1024 * 1024))'],
    })
    expect(result.status).toBe(0)
    expect(result.stdout.length).toBe(4 * 1024 * 1024)
  })
})
