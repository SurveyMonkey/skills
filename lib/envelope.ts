// The result envelope: ADR 001's four exit codes carried as four outcomes in
// one typed value, per ADR 012's amendment to it. A verb or a command handler
// returns an envelope; the CLI entry point (#224) is the only place that
// turns one back into a stdout/stderr pair and a process exit code.
//
// This is the first thing built, and RFC 002 says why: the in-process adapter
// loses the one property the process boundary gave for free, a crash the
// caller sees as an exit code. An outcome that is a value rather than a
// control-flow event is what puts that back, and it is what keeps "empty
// results are never implicitly successful" (ADR 001) checkable by the
// compiler rather than by a reviewer's memory.
//
// This file ships. It imports nothing outside the plugin and stays inside the
// erasable subset (no `enum`, no parameter properties, no namespaces).

/** Anything `JSON.stringify` round-trips, which is what a payload may be. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** A JSON object, the shape every command's success payload takes. */
export type JsonObject = { [key: string]: JsonValue }

/**
 * The four ADR 001 outcomes. `failed` carries the message the twelve bash
 * `die` definitions used to print; `unsupported` additionally names the
 * toolchain, which is the field `node.sh` emits beside its exit 3 today.
 * The target stack has `failed` (exit 1) and `refused` (exit 2), and no
 * exit 3. This type shares `failed`, drops `refused`, and adds
 * `not-implemented` (exit 2) and `unsupported` (exit 3).
 */
export type Failure =
  | { readonly outcome: 'failed'; readonly error: string }
  | { readonly outcome: 'not-implemented'; readonly error: string }
  | { readonly outcome: 'unsupported'; readonly error: string; readonly unsupported: string }

/**
 * A success carrying its value, or one of the three failures. Split so that a
 * failure is a type of its own: `Envelope<never>` still admits the success
 * arm, so a value known to be a failure has to say so to be read as one.
 */
export type Envelope<T> = { readonly outcome: 'ok'; readonly value: T } | Failure

export type ExitCode = 0 | 1 | 2 | 3

/**
 * ADR 001's table, spelled once. A caller responds differently to each, which
 * is the whole reason there are four rather than "zero or not".
 */
export const EXIT_CODES: {
  readonly ok: 0
  readonly failed: 1
  readonly 'not-implemented': 2
  readonly unsupported: 3
} = {
  ok: 0,
  failed: 1,
  'not-implemented': 2,
  unsupported: 3,
}

/** Where a toolchain this plugin does not handle is reported and asked for. */
const CONTRIBUTING = '.github/CONTRIBUTING.md'

export const ok = <T>(value: T): Envelope<T> => ({ outcome: 'ok', value })

/** Exit 1: this code went wrong. */
export const failed = (message: string): Failure => ({
  outcome: 'failed',
  error: message,
})

/** Exit 2: the verb is part of the contract and is not built yet. */
export const notImplemented = (verb: string): Failure => ({
  outcome: 'not-implemented',
  error: `${verb} is not implemented`,
})

/**
 * Exit 3: a configuration fact rather than a bug, so it is reported with the
 * toolchain named and a pointer at where to ask for it (ADR 001).
 */
export const unsupported = (toolchain: string, detail: string): Failure => ({
  outcome: 'unsupported',
  error: `${detail} See ${CONTRIBUTING} to request support.`,
  unsupported: toolchain,
})

export const isOk = <T>(envelope: Envelope<T>): envelope is { outcome: 'ok'; value: T } =>
  envelope.outcome === 'ok'

export const exitCodeFor = (envelope: Envelope<unknown>): ExitCode => EXIT_CODES[envelope.outcome]

/** What the process writes and exits with. */
export interface Rendered {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: ExitCode
}

/**
 * A failure keeps its ADR 001 shape: `{"error": ...}` on stdout, and the same
 * message on stderr. The target stack writes nothing to stdout here. This
 * plugin cannot: every consuming agent prompt reads stdout as JSON, and the
 * bash `die` definitions print both halves. An `unsupported` failure adds
 * the toolchain field that `node.sh` emits beside its exit 3.
 *
 * Neither string carries a trailing newline. The entry point writes one. A
 * renderer that embedded it would double-space the output of a caller that
 * writes through `console.log`.
 */
const renderFailure = (failure: Failure): Rendered => {
  const body: JsonObject =
    failure.outcome === 'unsupported'
      ? { error: failure.error, unsupported: failure.unsupported }
      : { error: failure.error }
  return {
    stdout: JSON.stringify(body),
    stderr: failure.error,
    exitCode: EXIT_CODES[failure.outcome],
  }
}

/** A payload rendered as the one line of JSON on stdout that a caller parses. */
export const renderJson = (envelope: Envelope<JsonValue>): Rendered =>
  envelope.outcome === 'ok'
    ? { stdout: JSON.stringify(envelope.value), stderr: '', exitCode: EXIT_CODES.ok }
    : renderFailure(envelope)

/** A payload that is already the text to print, written verbatim. */
export const renderText = (envelope: Envelope<string>): Rendered =>
  envelope.outcome === 'ok'
    ? { stdout: envelope.value, stderr: '', exitCode: EXIT_CODES.ok }
    : renderFailure(envelope)

/**
 * The status for a command that threw, in place of node's own crash.
 *
 * A command answers with an envelope for every outcome it decides. A throw
 * that reaches the entry point is a defect. Without this guard, node writes
 * a stack trace to stderr and exits with a status the contract never chose.
 * This guard writes one line, `<label>: <message>`, and answers
 * {@link EXIT_CODES}`.failed`. Any status the command settled on, or `null`,
 * passes through unchanged.
 *
 * The writer is structural, so this file still imports nothing.
 */
export const failedOnThrow = async <T>(
  pending: Promise<T>,
  label: string,
  err: { write(text: string): unknown },
): Promise<T | typeof EXIT_CODES.failed> =>
  pending.catch((error: unknown) => {
    err.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_CODES.failed
  })

/** Thrown by {@link unwrap}. Carries the envelope so a boundary can render it. */
export class EnvelopeError extends Error {
  readonly envelope: Failure

  constructor(envelope: Failure) {
    super(envelope.error)
    // Set explicitly rather than inherited: `Error` names itself after its own
    // constructor, so without this a failure at the boundary reports as a
    // plain `Error` and the outcome it carries is invisible in the message.
    this.name = 'EnvelopeError'
    this.envelope = envelope
  }
}

/**
 * The value, or a throw carrying the failure. This is the one deliberate
 * conversion from an outcome back into an exception, for a caller deep in a
 * composition where every step returning an envelope would be noise; the
 * entry point catches it and renders `envelope` rather than a stack trace.
 * Prefer checking {@link isOk} where the failure has somewhere to go.
 */
export const unwrap = <T>(envelope: Envelope<T>): T => {
  if (envelope.outcome === 'ok') return envelope.value
  throw new EnvelopeError(envelope)
}
