// This file enforces the runtime floor where it is crossed. It does not
// only write the floor down and hope a user obeys it. ADR 012 sets the
// floor at node 22.18. The guard that the entry point calls first
// executes it. The floor is a property of the release, not of this
// process. So the check is a pure function over a version string.
//
// The entry point passes `process.version` to it, and the suite passes the
// versions that ADR 012's spike table records.
//
// **This file imports nothing. That absence is essential.** `import`
// declarations are hoisted, and run before any statement in an entry point
// runs. So a guard with a module graph would load that graph on the very
// runtime it exists to refuse. The sentence a user should read would then
// be a syntax error from inside a dependency, instead.
// `plugins/gh-security/scripts/gh-security.ts` makes this its one static
// import. It reaches everything else by `await import` after the check.
//
// This file ships, so it stays inside the erasable subset (no `enum`, no
// parameter properties, no namespaces). node strips the types; it does not
// compile them (ADR 012).

/**
 * The oldest node release that runs this marketplace's TypeScript directly,
 * with zero bytes on stderr. This is the triple the comparison reads, and
 * the string the error message names. From ADR 012: 22.16 and 22.17
 * fail at launch. 22.18.0 is the first release that meets both conditions.
 */
const NODE_FLOOR_PARTS: readonly [number, number, number] = [22, 18, 0]

export const NODE_FLOOR = NODE_FLOOR_PARTS.join('.')

/** Thrown when the node in use cannot execute the plugin that called this. */
export class NodeFloorError extends Error {
  constructor(message: string) {
    super(message)
    // This name is set explicitly, not inherited. `Error` names itself
    // after its own constructor. Without this line, the refusal a user
    // reads at launch would report as a plain `Error`.
    this.name = 'NodeFloorError'
  }
}

/**
 * A release triple, or `undefined` when the string is not one.
 *
 * The optional `v` is what `process.version` carries. A prerelease or
 * build suffix is stripped and dropped. This does not mean the suffix is
 * always safe to drop under semver (`22.18.0-rc.1` sorts below `22.18.0`).
 * It is because a real node release binary's `process.version` never
 * carries one. That is the only caller this floor compares against.
 *
 * This is not a global regular expression. `exec` on a global one carries
 * `lastIndex` between calls. So a second read of the same string would
 * wrongly answer `null`.
 */
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

const parseVersion = (version: string): [number, number, number] | undefined => {
  const match = RELEASE.exec(version)
  if (match === null) return undefined
  // This match has three mandatory capturing groups, inside an anchored
  // pattern. A successful match always fills all three positions. So the
  // tuple shape is asserted once here, rather than guarded at each read
  // with a `?? 0` fallback. `noUncheckedIndexedAccess` cannot see that such
  // a fallback would be unreachable.
  //
  // The assertion is erased at runtime. Unlike a fallback, it adds no
  // branch for coverage to find. It also adds no case that a test would
  // have to invent an input for.
  const [, major, minor, patch] = match as unknown as [string, string, string, string]
  return [Number(major), Number(minor), Number(patch)]
}

/**
 * Compares two release triples in order: negative when `a` sorts before
 * `b`, positive when after, zero when equal. Major decides first, then
 * minor, then patch. Each part is compared as its own subtraction, not
 * folded into one number, so no part has a ceiling.
 *
 * Consider a collapsed formula instead: `major * 1_000_000 + minor * 1_000
 * + patch`. It would carry a patch of 1000 into the minor part. node has
 * never shipped one.
 * But this check is the first thing that runs on every user's machine. It
 * must not build in that assumption as a silent guess.
 */
const compareTriples = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * Whether `version` is at or above {@link NODE_FLOOR}.
 *
 * This is the shape a hook needs. A hook asks the question and stays
 * quiet. It does not catch a refusal that it must not print.
 *
 * A version string that cannot be read as a release answers `false`. An
 * unreadable version is not proof that the floor is met. To treat it as
 * proof would be the "found nothing counts as a pass" shape this
 * repository refuses everywhere else.
 */
export const meetsNodeFloor = (version: string): boolean => {
  const running = parseVersion(version)
  return running !== undefined && compareTriples(running, NODE_FLOOR_PARTS) >= 0
}

/**
 * Refuse to run on a node older than {@link NODE_FLOOR}.
 *
 * This is the shape an entry point needs. It throws a
 * {@link NodeFloorError} that names both the required version and the
 * version in use. A user below the floor is then told what to change,
 * rather than left with a failure inside a command.
 *
 * One message covers both refusals: the old release and the unreadable
 * string. The sentence a user must act on is the same either way. A
 * second message would add a second branch with no second remedy behind
 * it.
 */
export const assertNodeFloor = (version: string): void => {
  if (meetsNodeFloor(version)) return
  throw new NodeFloorError(
    `This plugin requires node ${NODE_FLOOR} or newer, but this is node "${version}". ` +
      'Upgrade node, or run Claude Code under a newer release.',
  )
}

/**
 * One line for a `SessionStart` hook to write. It names the floor, for
 * a `version` below it.
 *
 * A `SessionStart` hook runs once, not on every tool call. So it may say
 * this, where a per-tool-call hook must stay silent (`meetsNodeFloor`).
 * This never throws: the hook must not read the below-floor case as an
 * exception to catch. `version` is always quoted, the same way, whether
 * it reads as a release or not. So this needs no second branch for the
 * case that cannot be read.
 */
export const belowFloorMessage = (version: string): string =>
  `node "${version}" is below the floor: ${NODE_FLOOR} or newer.`
