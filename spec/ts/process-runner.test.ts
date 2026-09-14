// The process runner (ADR 012: a process seam exists only at an ecosystem
// boundary). The seam is the exported surface, and the spawn function is a
// documented parameter, so an example substitutes it through that parameter
// exactly as `spec/fix_group_spec.sh` substitutes an adapter through
// `--adapter` (the testing skill's mocking.md, "The injected collaborator").
//
// The default spawn is never substituted away from: the examples at the
// bottom run real processes through it, because `nodeSpawn` is the boundary
// itself and a substitute for it would assert nothing about the boundary.
import { describe, expect, it } from 'vitest'

import {
  type RunRequest,
  type RunResult,
  run,
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
    expect(seen).toEqual([{ command: 'git', args: ['--version'] }])
  })
})
