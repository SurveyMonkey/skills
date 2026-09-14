// The runtime floor, enforced where it is crossed rather than documented and
// hoped for (ADR 012). The floor is a property of the release, not of this
// process, so the check is a pure function over a version string: the entry
// point at `bin/gh-security.ts` passes `process.version` to it (#224), and
// the suite passes the spike table's versions to it.
//
// This file ships. It imports nothing outside the plugin, and stays inside
// the erasable subset (no `enum`, no parameter properties, no namespaces),
// because node strips the types rather than compiling them.

/**
 * The oldest node release that runs this plugin's TypeScript directly with
 * zero bytes on stderr, as the triple the comparison reads and as the string
 * the error message names. From ADR 012's spike table: 22.17 fails at launch
 * and 22.18.0 is the first release that clears both halves.
 */
const NODE_FLOOR_PARTS: readonly [number, number, number] = [22, 18, 0]

export const NODE_FLOOR = NODE_FLOOR_PARTS.join('.')

/** Thrown when the running node cannot execute this plugin. */
export class NodeFloorError extends Error {
  constructor(message: string) {
    super(message)
    // Set explicitly rather than inherited: `Error` names itself after its
    // own constructor, so without this the error a user sees at launch is
    // reported as a plain `Error`.
    this.name = 'NodeFloorError'
  }
}

/**
 * A release triple. The optional `v` is what `process.version` carries; a
 * prerelease or build suffix is stripped and ignored, not because ignoring
 * it is semver-safe in general (`22.18.0-rc.1` sorts below `22.18.0`), but
 * because a real node release binary's `process.version` never carries one,
 * the only caller this floor is ever compared against.
 *
 * Throws a {@link NodeFloorError} naming `version` when it is not that
 * shape, rather than returning `undefined`: an unreadable version is not
 * evidence that the floor is met, so there is nothing for a caller to
 * re-check.
 */
const parseVersion = (version: string): [number, number, number] => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (match === null) {
    throw new NodeFloorError(
      `gh-security could not read a node version from "${version}". ` +
        `It requires node ${NODE_FLOOR} or newer.`,
    )
  }
  // Three mandatory capturing groups inside an anchored match: a successful
  // match always populates all three positions, so the tuple shape is
  // asserted once here rather than defended at each read with a `?? 0`
  // fallback `noUncheckedIndexedAccess` cannot see is unreachable. The
  // assertion is erased at runtime, so unlike a fallback it adds no branch
  // for coverage to find.
  const [, major, minor, patch] = match as unknown as [string, string, string, string]
  return [Number(major), Number(minor), Number(patch)]
}

/**
 * Refuse to run on a node older than {@link NODE_FLOOR}.
 *
 * Throws a {@link NodeFloorError} naming both the required and the running
 * version, so a user below the floor is told what to change rather than left
 * with a failure deep inside a fix run. A version string that cannot be read
 * as a release is refused too, by {@link parseVersion}: an unreadable
 * version is not evidence that the floor is met.
 */
export const assertNodeFloor = (version: string): void => {
  const actual = parseVersion(version)
  // The floor is compared as the triple it is declared as, never re-parsed
  // out of the string: one source of truth. Each triple collapses to a
  // single comparable number, since major dominates minor dominates patch
  // and 1000 comfortably exceeds any real minor or patch component, rather
  // than being compared position by position, so this function has exactly
  // one branch, not three.
  const value = ([major, minor, patch]: readonly [number, number, number]): number =>
    major * 1_000_000 + minor * 1_000 + patch
  if (value(actual) >= value(NODE_FLOOR_PARTS)) return
  throw new NodeFloorError(
    `gh-security requires node ${NODE_FLOOR} or newer, but this is node ${version}. ` +
      'Upgrade node, or run the plugin under a newer release.',
  )
}
