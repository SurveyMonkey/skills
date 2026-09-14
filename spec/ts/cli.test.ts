// The CLI entry point (#224, ADR 012). The seam a spawn covers is only what
// the entry itself adds: the Node-floor preamble's placement, the `--help`
// listing, the unknown-command envelope, the stdout and stderr split, and
// the allow hook reading its input on stdin. Everything a command decides is
// covered through that command's export (the testing skill's "Seams", and
// issue #216's decision comment, which this entry point is thin for).
//
// Every expected value below is hand-written from the contract on #224, never
// read back out of the code under test.
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { run } from '../../plugins/gh-security/src/lib/process-runner.ts'

const ENTRY = fileURLToPath(
  new URL('../../plugins/gh-security/bin/gh-security.ts', import.meta.url),
)

const entry = (args: readonly string[], input?: string) =>
  run({ command: process.execPath, args: [ENTRY, ...args], input })

describe('gh-security --help', () => {
  it('lists every registered command on stdout and exits 0', () => {
    const result = entry(['--help'])
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    expect(result.stdout).toContain('allow-own-commands')
  })
})
