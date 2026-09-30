// One rule for the node verbs: a throw from a module under a verb is the
// `failed` outcome (ADR 001, exit 1), with the text of that throw.
//
// The lockfile readers throw a `LockfileError` for a lockfile that they
// refuse, and the semver module throws a `SemverParseError` for a version
// with nothing in it to compare. node.sh stops with exit 1 for each (or with
// jq's own status 5), so the caller reports and stops. The read of the
// lockfile can also throw, for example for a file that is not there. Any
// other throw becomes `failed` too (#221, mid-round ruling 13).
//
// This file ships. It imports nothing outside the plugin.

import { type Envelope, failed, ok } from '../../lib/envelope.ts'

/**
 * The text of a thrown value: the message of an `Error`, else its string.
 * `String` itself throws for some values, such as an object with no
 * prototype. For those, the text is the tag of the object.
 */
const textOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return Object.prototype.toString.call(error)
  }
}

/** The value of `compute`, or `failed` with the text of what it throws. */
export const attempt = <T>(compute: () => T): Envelope<T> => {
  try {
    return ok(compute())
  } catch (error) {
    return failed(textOf(error))
  }
}
