// The parity runner (RFC 002, "Parity is the migration strategy"). Nothing in
// this port is ported on a reading of the bash: for each port issue the bash
// script and its TypeScript replacement are run on the same input and their
// JSON is compared, and a script is deleted only once its replacement is
// parity-green on every fixture that covered it.
//
// It is generic over an invocation pair on one input (this issue's plan
// comment, ruling B): a bash command line, run through the process runner
// with the real spawn because the bash side is the boundary being measured,
// and a TypeScript call. Both answer JSON; a structural comparison reports
// the first differing path in a form a reviewer can act on, because "the two
// disagree" is a verdict nobody can fix from.
//
// The rule it serves is in the plugin guide's Testing section, under
// "Harness": a bash script is deleted only after its replacement is
// parity-green on every fixture that covered it.
//
// This is test infrastructure. It is not under `src/`, it is not in the
// coverage include, and it is deleted with the last bash script it has
// anything left to compare against (#241).

import type { JsonValue } from '../../../plugins/gh-security/src/lib/envelope.ts'
import {
  describeRun,
  type RunRequest,
  run,
} from '../../../plugins/gh-security/src/lib/process-runner.ts'

/** One behavior, spelled both ways. */
export interface ParitySubject<Input> {
  /** The bash invocation for one input, run as a real process. */
  readonly bash: (input: Input) => RunRequest
  /** The TypeScript call for the same input, answering the same JSON. */
  readonly typescript: (input: Input) => JsonValue
}

/**
 * Agreement, or the first disagreement in words. A verdict rather than a
 * throw: the example asserts it, so the report travels into the failure
 * message the way any other expected value does.
 */
export type ParityVerdict =
  | { readonly matched: true }
  | { readonly matched: false; readonly report: string }

const MATCHED: ParityVerdict = { matched: true }

const isObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const show = (value: JsonValue): string => JSON.stringify(value)

/**
 * The first path at which the two answers differ, or `null` when they do not.
 *
 * Depth first and left to right, so the path named is the first one a reader
 * scanning the JSON would reach. Paths are spelled `$`, `$.key` and `$[0]`,
 * which is the notation the answers are read in.
 *
 * A length or key difference is reported as itself rather than as a value
 * difference: "bash has 3 entries, TypeScript has 2" says what to look for,
 * while a comparison of entry 2 against nothing does not.
 */
export const firstDifference = (
  bash: JsonValue,
  typescript: JsonValue,
  path = '$',
): string | null => {
  if (Array.isArray(bash) || Array.isArray(typescript)) {
    if (!Array.isArray(bash) || !Array.isArray(typescript)) {
      return `${path}: bash ${show(bash)}, TypeScript ${show(typescript)}`
    }
    if (bash.length !== typescript.length) {
      return `${path}: bash has ${bash.length} entries, TypeScript has ${typescript.length}`
    }
    for (const [index, entry] of bash.entries()) {
      const other = typescript[index]
      // Unreachable while the lengths are equal, and spelled rather than
      // asserted away: `noUncheckedIndexedAccess` is on, and an assertion
      // here would be the one place in this file that trusts an index.
      if (other === undefined) return `${path}[${index}]: TypeScript has no entry`
      const found = firstDifference(entry, other, `${path}[${index}]`)
      if (found !== null) return found
    }
    return null
  }
  if (isObject(bash) || isObject(typescript)) {
    if (!isObject(bash) || !isObject(typescript)) {
      return `${path}: bash ${show(bash)}, TypeScript ${show(typescript)}`
    }
    // Sorted, so the path a mismatch reports does not depend on the order two
    // implementations happened to build their objects in.
    const keys = [...new Set([...Object.keys(bash), ...Object.keys(typescript)])].sort()
    for (const key of keys) {
      const left = bash[key]
      const right = typescript[key]
      if (left === undefined) return `${path}: TypeScript carries a key bash does not: ${key}`
      if (right === undefined) return `${path}: bash carries a key TypeScript does not: ${key}`
      const found = firstDifference(left, right, `${path}.${key}`)
      if (found !== null) return found
    }
    return null
  }
  return bash === typescript ? null : `${path}: bash ${show(bash)}, TypeScript ${show(typescript)}`
}

/**
 * Run both sides on one input and compare.
 *
 * A bash side that fails to run, or that answers something that is not JSON,
 * is reported as itself and never as a difference: parity is a claim about
 * two answers, and there is no answer to compare against in either case.
 */
export const checkParity = <Input>(subject: ParitySubject<Input>, input: Input): ParityVerdict => {
  const request = subject.bash(input)
  const result = run(request)
  if (result.status !== 0) {
    return { matched: false, report: `bash did not answer: ${describeRun(result)}` }
  }
  let answered: JsonValue
  try {
    answered = JSON.parse(result.stdout) as JsonValue
  } catch {
    return {
      matched: false,
      report: `the bash answer is not JSON: ${result.stdout.trim() || '(no output)'}`,
    }
  }
  const difference = firstDifference(answered, subject.typescript(input))
  return difference === null ? MATCHED : { matched: false, report: `they differ at ${difference}` }
}
