// The result envelope and the exit codes (ADR 001 as amended by ADR 012).
// The seam is the exported surface: a command handler returns an envelope and
// the CLI entry renders it, so these examples call the constructors and the
// renderer directly rather than spawning anything.
//
// Every expected value is hand-written from ADR 001's own exit-code table and
// from the JSON the bash scripts emit today (`{"error": ...}` from the twelve
// `die` definitions, `{"error": ..., "unsupported": ...}` from `node.sh`'s
// exit 3). None of it is recomputed the way the module computes it.
import { describe, expect, it } from 'vitest'

import { ok, renderEnvelope } from '../../plugins/gh-security/src/lib/envelope.ts'

describe('renderEnvelope', () => {
  it('writes a success value as JSON on stdout and exits 0', () => {
    expect(renderEnvelope(ok({ actionable: [], skipped: [] }))).toEqual({
      stdout: '{"actionable":[],"skipped":[]}',
      stderr: '',
      exitCode: 0,
    })
  })
})
