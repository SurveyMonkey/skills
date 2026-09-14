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

import {
  type Envelope,
  EnvelopeError,
  EXIT_CODES,
  exitCodeFor,
  failure,
  isOk,
  mapOk,
  notImplemented,
  ok,
  renderEnvelope,
  unsupported,
  unwrap,
} from '../../plugins/gh-security/src/lib/envelope.ts'

describe('renderEnvelope', () => {
  it('writes a success value as JSON on stdout and exits 0', () => {
    expect(renderEnvelope(ok({ actionable: [], skipped: [] }))).toEqual({
      stdout: '{"actionable":[],"skipped":[]}',
      stderr: '',
      exitCode: 0,
    })
  })

  // The failure shape every consuming agent prompt reads, and the split ADR
  // 001 states: JSON on stdout, human-readable detail on stderr. The bash
  // `die` definitions print both, and a port that dropped the stdout half
  // would leave a caller parsing an empty string.
  it('writes an error as {"error": ...} on stdout and the message on stderr', () => {
    expect(renderEnvelope(failure('no state file at /w/state.json; run setup first'))).toEqual({
      stdout: '{"error":"no state file at /w/state.json; run setup first"}',
      stderr: 'no state file at /w/state.json; run setup first',
      exitCode: 1,
    })
  })

  it('names the verb that is not built yet, and exits 2', () => {
    expect(renderEnvelope(notImplemented('declared_ranges'))).toEqual({
      stdout: '{"error":"declared_ranges is not implemented"}',
      stderr: 'declared_ranges is not implemented',
      exitCode: 2,
    })
  })

  // `node.sh` emits exactly this pair for bun and Yarn Classic today: the
  // message pointing at CONTRIBUTING, and a separate `unsupported` field
  // naming the toolchain so a caller can report it without parsing prose.
  it('carries the toolchain beside the message, and exits 3', () => {
    expect(
      renderEnvelope(unsupported('yarn-classic', 'Yarn Classic (v1) is not supported.')),
    ).toEqual({
      stdout:
        '{"error":"Yarn Classic (v1) is not supported. See .github/CONTRIBUTING.md to request support.","unsupported":"yarn-classic"}',
      stderr: 'Yarn Classic (v1) is not supported. See .github/CONTRIBUTING.md to request support.',
      exitCode: 3,
    })
  })

  // Neither string carries a line ending. The entry point writes one; a
  // renderer that embedded it would double-space a `console.log` caller.
  it('emits no trailing newline on either channel', () => {
    const rendered = renderEnvelope(failure('boom'))
    expect(rendered.stdout.endsWith('\n')).toBe(false)
    expect(rendered.stderr.endsWith('\n')).toBe(false)
  })
})

describe('exitCodeFor', () => {
  // ADR 001's table, one row per outcome, hand-copied from the ADR.
  it.each([
    ['ok', ok(null), 0],
    ['error', failure('boom'), 1],
    ['not-implemented', notImplemented('install'), 2],
    ['unsupported', unsupported('bun', 'bun is not a supported package manager.'), 3],
  ] as const)('maps %s onto exit %i', (_name, envelope, expected) => {
    expect(exitCodeFor(envelope)).toBe(expected)
  })

  it('states the same four codes as a table', () => {
    expect(EXIT_CODES).toEqual({ ok: 0, error: 1, 'not-implemented': 2, unsupported: 3 })
  })
})

describe('isOk', () => {
  it('is true for a success and false for every failure', () => {
    expect(isOk(ok(1))).toBe(true)
    expect(isOk(failure('boom'))).toBe(false)
    expect(isOk(notImplemented('install'))).toBe(false)
    expect(isOk(unsupported('bun', 'bun is not supported.'))).toBe(false)
  })

  // A success carrying a falsy payload is still a success. Reading the
  // outcome off the truthiness of the value is exactly the "found nothing
  // means all clear" shape ADR 001 exists to refuse.
  it.each([[null], [0], [false], ['']] as const)('is true for the success value %j', (value) => {
    expect(isOk(ok(value))).toBe(true)
  })
})

describe('unwrap', () => {
  it('returns the value of a success', () => {
    expect(unwrap(ok({ pm: 'pnpm' }))).toEqual({ pm: 'pnpm' })
  })

  // The failure has to survive the throw with its outcome intact: the entry
  // point renders `envelope`, so an `EnvelopeError` that carried only a
  // message would turn a `not-implemented` verb into a generic error and
  // change the exit code a caller responds to.
  it('throws an EnvelopeError carrying the whole failure', () => {
    let thrown: unknown
    try {
      unwrap(notImplemented('install'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(EnvelopeError)
    const caught = thrown as EnvelopeError
    expect(caught.name).toBe('EnvelopeError')
    expect(caught.message).toBe('install is not implemented')
    expect(caught.envelope).toEqual({
      outcome: 'not-implemented',
      error: 'install is not implemented',
    })
    expect(exitCodeFor(caught.envelope)).toBe(2)
  })
})

describe('mapOk', () => {
  it('applies the function to a success value', () => {
    expect(mapOk(ok(2), (n) => n * 3)).toEqual({ outcome: 'ok', value: 6 })
  })

  // The mutant this exists for: a `mapOk` that rebuilt every failure as a
  // plain error would send an unsupported toolchain to the caller as exit 1,
  // which ADR 001 separates precisely because the responses differ.
  it('passes a failure through with its outcome and fields intact', () => {
    const bun: Envelope<number> = unsupported('bun', 'bun is not a supported package manager.')
    const mapped = mapOk(bun, (n: number) => n * 3)
    expect(mapped).toBe(bun)
    expect(exitCodeFor(mapped)).toBe(3)
  })
})
