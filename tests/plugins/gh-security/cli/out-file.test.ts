// `--out <file>` (#346). The seam is `runCli`, the one place that renders a
// command's stdout, with a substituted io and a handler substituted through
// the registry's `load` (the pattern of run.test.ts). The file is real, in a
// scratch directory.
//
// Each expected value is written by hand from the contract in
// `src/cli/out-file.ts`: the file holds the bytes that stdout holds, stdout
// is unchanged, and a write that fails is a failure that names the file.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type CommandContext,
  type CommandEntry,
  type CommandResult,
  failedReport,
  type Io,
} from '#gh-security/cli/command.ts'
import { takeOut } from '#gh-security/cli/out-file.ts'
import { COMMANDS } from '#gh-security/cli/registry.ts'
import { runCli } from '#gh-security/cli/run.ts'

const capturing = () => {
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    stdout: (text) => {
      out.push(text)
    },
    stderr: (text) => {
      err.push(text)
    },
    readStdin: () => '',
  }
  return { io, written: () => ({ stdout: out.join(''), stderr: err.join('') }) }
}

let scratch = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gh-security-out-file-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(scratch, { recursive: true, force: true })
})

/** Substitute the handler of one command, and record the arguments it gets. */
const substitute = (
  name: string,
  answer: (context: CommandContext) => CommandResult | Promise<CommandResult>,
) => {
  const seen: (readonly string[])[] = []
  vi.spyOn(COMMANDS[name] as CommandEntry, 'load').mockResolvedValue(async (context) => {
    seen.push(context.args)
    return answer(context)
  })
  return seen
}

describe('--out on each command whose answer a later command reads', () => {
  it.each([
    ['prepare-checkout', ['/repo']],
    ['merge-envelopes', ['/run/checkout-1.json']],
    ['preflight-repo', ['--fallback-package', 'lodash', '/repo']],
    ['build-dispatches', ['--envelope', '/run/merged.json', '--cap', '2', 'octo/app:b']],
    ['reap-batch', ['/run/results.json']],
    ['summarize-run', ['--workflow', '/run/workflow.json']],
    ['pr-status', ['https://github.com/octo/app/pull/1']],
  ])(
    '%s writes its answer to the file and to stdout, and never sees the flag',
    async (name, rest) => {
      const seen = substitute(name, () => ({ outcome: 'ok', value: { answer: 1 } }))
      const file = join(scratch, 'answer.json')
      const { io, written } = capturing()
      expect(await runCli([name, ...rest, '--out', file], {}, io)).toBe(0)
      expect({
        file: readFileSync(file, 'utf8'),
        written: written(),
        seen,
      }).toEqual({
        file: '{"answer":1}\n',
        written: { stdout: '{"answer":1}\n', stderr: '' },
        seen: [rest],
      })
    },
  )

  it('fix-group score writes its answer to the file, and its report on a failed phase', async () => {
    const seen = substitute('fix-group', () =>
      failedReport('fix-group: score failure: no why', { status: 'failure', phase: 'score' }, 3),
    )
    const file = join(scratch, 'work', 'ready-for-pr.json')
    const { io } = capturing()
    expect(await runCli(['fix-group', 'score', '--work', '/w', '--out', file], {}, io)).toBe(3)
    expect({ file: readFileSync(file, 'utf8'), seen }).toEqual({
      file: '{"status":"failure","phase":"score"}\n',
      seen: [['score', '--work', '/w']],
    })
  })

  it.each([['commit-msg'], ['body']])(
    'render-pr %s writes its text to the file and to stdout',
    async (verb) => {
      const seen = substitute('render-pr', (context) => {
        context.io.stdout('fix(deps): a title\n\nThe body.\n')
        return undefined
      })
      const file = join(scratch, 'text.txt')
      const { io, written } = capturing()
      expect(await runCli(['render-pr', verb, '--repo', 'octo/app', '--out', file], {}, io)).toBe(0)
      expect({ file: readFileSync(file, 'utf8'), written: written(), seen }).toEqual({
        file: 'fix(deps): a title\n\nThe body.\n',
        written: { stdout: 'fix(deps): a title\n\nThe body.\n', stderr: '' },
        seen: [[verb, '--repo', 'octo/app']],
      })
    },
  )

  it('takes the flag before the other arguments too', async () => {
    const seen = substitute('merge-envelopes', () => ({ outcome: 'ok', value: [] }))
    const file = join(scratch, 'merged.json')
    const { io } = capturing()
    expect(await runCli(['merge-envelopes', '--out', file, '/run/a.json'], {}, io)).toBe(0)
    expect({ file: readFileSync(file, 'utf8'), seen }).toEqual({
      file: '[]\n',
      seen: [['/run/a.json']],
    })
  })

  it('makes the parent directories of the file', async () => {
    substitute('reap-batch', () => ({ outcome: 'ok', value: { reaped: true } }))
    const file = join(scratch, 'plugins', 'data', 'gh-security-x', 'runs', 'r1', 'reports.json')
    const { io } = capturing()
    expect(await runCli(['reap-batch', '/run/results.json', '--out', file], {}, io)).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('{"reaped":true}\n')
  })

  it('replaces a file that is already there', async () => {
    substitute('pr-status', () => ({ outcome: 'ok', value: { prs: [] } }))
    const file = join(scratch, 'pr-status-1.json')
    writeFileSync(file, 'an older and much longer answer\n')
    const { io } = capturing()
    expect(await runCli(['pr-status', 'u', '--out', file], {}, io)).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('{"prs":[]}\n')
  })
})

describe('--out on a failure', () => {
  it('writes the report of a failure that carries one, and keeps its exit status', async () => {
    substitute('preflight-repo', () =>
      failedReport('preflight-repo: no package', {
        error: 'preflight-repo: no package',
        exclude_error: 'locked',
      }),
    )
    const file = join(scratch, 'preflight-1.json')
    const { io, written } = capturing()
    expect(await runCli(['preflight-repo', '/repo', '--out', file], {}, io)).toBe(1)
    expect({ file: readFileSync(file, 'utf8'), written: written() }).toEqual({
      file: '{"error":"preflight-repo: no package","exclude_error":"locked"}\n',
      written: {
        stdout: '{"error":"preflight-repo: no package","exclude_error":"locked"}\n',
        stderr: 'preflight-repo: no package\n',
      },
    })
  })

  it('writes the report of the real pr-status, which reports and fails', async () => {
    const file = join(scratch, 'pr-status-1.json')
    const { io, written } = capturing()
    expect(await runCli(['pr-status', 'not-a-url', '--out', file], {}, io)).toBe(1)
    expect({ file: readFileSync(file, 'utf8'), stdout: written().stdout }).toEqual({
      file: '{"prs":[{"url":"not-a-url","error":"not a GitHub pull request URL"}]}\n',
      stdout: '{"prs":[{"url":"not-a-url","error":"not a GitHub pull request URL"}]}\n',
    })
  })

  it('writes the error envelope of a failure that has no report', async () => {
    substitute('build-dispatches', () => ({ outcome: 'failed', error: 'no envelope' }))
    const file = join(scratch, 'args.json')
    const { io, written } = capturing()
    expect(await runCli(['build-dispatches', '--out', file], {}, io)).toBe(1)
    expect({ file: readFileSync(file, 'utf8'), written: written() }).toEqual({
      file: '{"error":"no envelope"}\n',
      written: { stdout: '{"error":"no envelope"}\n', stderr: 'no envelope\n' },
    })
  })

  it('writes the error envelope of a render-pr text verb that fails, and no text', async () => {
    substitute('render-pr', () => ({ outcome: 'failed', error: '--state requires a file' }))
    const file = join(scratch, 'commit-msg.txt')
    const { io, written } = capturing()
    expect(await runCli(['render-pr', 'commit-msg', '--out', file], {}, io)).toBe(1)
    expect({ file: readFileSync(file, 'utf8'), stdout: written().stdout }).toEqual({
      file: '{"error":"--state requires a file"}\n',
      stdout: '{"error":"--state requires a file"}\n',
    })
  })

  it('writes the failed envelope of a handler that throws', async () => {
    substitute('summarize-run', () => {
      throw new Error('boom')
    })
    const file = join(scratch, 'summary.json')
    const { io } = capturing()
    expect(await runCli(['summarize-run', '--out', file], {}, io)).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('{"error":"summarize-run: boom"}\n')
  })
})

describe('--out that cannot be written', () => {
  // A parent that is a regular file: no directory can be made under it, on
  // any platform and for any user.
  const blocked = () => {
    const parent = join(scratch, 'a-file')
    writeFileSync(parent, '')
    return join(parent, 'answer.json')
  }

  it('fails, names the file, and writes no answer on stdout', async () => {
    substitute('merge-envelopes', () => ({ outcome: 'ok', value: { merged: true } }))
    const file = blocked()
    const { io, written } = capturing()
    expect(await runCli(['merge-envelopes', '/run/a.json', '--out', file], {}, io)).toBe(1)
    const { stdout, stderr } = written()
    const { error } = JSON.parse(stdout) as { error: string }
    expect({
      stdout: Object.keys(JSON.parse(stdout)),
      prefix: error.startsWith(`merge-envelopes: cannot write --out ${file}: `),
      stderr,
    }).toEqual({ stdout: ['error'], prefix: true, stderr: `${error}\n` })
  })

  it('writes none of the text of a render-pr text verb on stdout', async () => {
    substitute('render-pr', (context) => {
      context.io.stdout('fix(deps): a title\n')
      return undefined
    })
    const file = blocked()
    const { io, written } = capturing()
    expect(await runCli(['render-pr', 'body', '--out', file], {}, io)).toBe(1)
    expect(written().stdout).toMatch(/^\{"error":"render-pr: cannot write --out /)
  })

  it('fails when the file is a directory', async () => {
    substitute('reap-batch', () => ({ outcome: 'ok', value: [] }))
    const file = join(scratch, 'a-directory')
    mkdirSync(file)
    const { io, written } = capturing()
    expect(await runCli(['reap-batch', 'r.json', '--out', file], {}, io)).toBe(1)
    expect(written().stdout).toMatch(/^\{"error":"reap-batch: cannot write --out /)
  })
})

describe('--out on a command line that is wrong', () => {
  it.each([
    ['no value', ['merge-envelopes', 'a.json', '--out'], 'merge-envelopes: --out requires a file'],
    [
      'an empty value',
      ['merge-envelopes', '--out', '', 'a.json'],
      'merge-envelopes: --out requires a file',
    ],
    [
      'a flag as its value',
      ['build-dispatches', '--out', '--cap', '2'],
      'build-dispatches: --out requires a file',
    ],
    [
      'the flag twice',
      ['pr-status', '--out', 'a.json', 'u', '--out', 'b.json'],
      'pr-status: --out is given more than once',
    ],
  ])('refuses %s before the command runs', async (_case, argv, error) => {
    const seen = substitute(argv[0] as string, () => ({ outcome: 'ok', value: 1 }))
    const { io, written } = capturing()
    expect(await runCli(argv, {}, io)).toBe(1)
    expect({ written: written(), seen }).toEqual({
      written: { stdout: `${JSON.stringify({ error })}\n`, stderr: `${error}\n` },
      seen: [],
    })
  })

  it.each([
    ['version', ['version', '--out', 'x.json']],
    ['render-pr labels', ['render-pr', 'labels', '--out', 'x.json']],
    ['render-pr create', ['render-pr', 'create', '--out', 'x.json']],
    ['fix-group apply', ['fix-group', 'apply', '--out', 'x.json']],
  ])('gives the flag to %s, which does not take it, as an argument', async (_case, argv) => {
    const seen = substitute(argv[0] as string, () => undefined)
    const { io } = capturing()
    expect(await runCli(argv, {}, io)).toBe(0)
    expect(seen).toEqual([argv.slice(1)])
  })
})

describe('takeOut', () => {
  it('leaves the arguments of a command that does not take the flag as they are', () => {
    expect(takeOut(['--out', 'x'], undefined)).toEqual({
      outcome: 'ok',
      value: { out: null, args: ['--out', 'x'] },
    })
  })

  it('reads a verb list against the first argument only', () => {
    expect(takeOut(['labels', 'commit-msg', '--out', 'x'], ['commit-msg'])).toEqual({
      outcome: 'ok',
      value: { out: null, args: ['labels', 'commit-msg', '--out', 'x'] },
    })
  })

  it('answers no file for a command line with no flag', () => {
    expect(takeOut(['a.json'], 'every call')).toEqual({
      outcome: 'ok',
      value: { out: null, args: ['a.json'] },
    })
  })

  it('reads a verb list against an empty command line as no verb', () => {
    expect(takeOut([], ['body'])).toEqual({ outcome: 'ok', value: { out: null, args: [] } })
  })
})
