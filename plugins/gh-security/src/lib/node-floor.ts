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
 * A release triple, or `undefined` when the string is not one. The optional
 * `v` is what `process.version` carries; a prerelease or build suffix is
 * accepted and ignored, since it never moves the release below the floor.
 */
const parseVersion = (version: string): [number, number, number] | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (match === null) return undefined
  // The pattern has three capturing groups, so all three are present on a
  // match; `noUncheckedIndexedAccess` cannot know that, hence the fallbacks,
  // which a match can never reach.
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/**
 * Refuse to run on a node older than {@link NODE_FLOOR}.
 *
 * Throws a {@link NodeFloorError} naming both the required and the running
 * version, so a user below the floor is told what to change rather than left
 * with a failure deep inside a fix run. A version string that cannot be read
 * as a release is refused too: an unreadable version is not evidence that the
 * floor is met.
 */
export const assertNodeFloor = (version: string): void => {
  const running = parseVersion(version)
  if (running === undefined) {
    throw new NodeFloorError(
      `gh-security could not read a node version from "${version}". ` +
        `It requires node ${NODE_FLOOR} or newer.`,
    )
  }
  // The floor is compared as the triple it is declared as, never re-parsed
  // out of the string: one source of truth, and no branch for a shape this
  // file's own literal cannot take.
  for (let i = 0; i < NODE_FLOOR_PARTS.length; i += 1) {
    const required = NODE_FLOOR_PARTS[i] ?? 0
    const actual = running[i] ?? 0
    if (actual > required) return
    if (actual < required) {
      throw new NodeFloorError(
        `gh-security requires node ${NODE_FLOOR} or newer, but this is node ${version}. ` +
          'Upgrade node, or run the plugin under a newer release.',
      )
    }
  }
}
