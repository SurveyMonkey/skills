// One rule for the node verbs: a throw from a module under a verb is the
// `failed` outcome (ADR 001, exit 1), with the message of that throw.
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

/** The value of `compute`, or `failed` with the message of what it throws. */
export const attempt = <T>(compute: () => T): Envelope<T> => {
  try {
    return ok(compute())
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}
