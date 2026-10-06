// The in-process `gh` double. It gives one reply registered per endpoint, a
// fail switch per endpoint, and an unhandled endpoint that throws instead
// of returning empty (mocking.md, "How gh is mocked"). A stub binary on PATH
// cannot give that last property. It is the difference between a test that
// proves a call was made correctly and a test that passes because nothing
// was called.
//
// `GhClient` and its result types live in the root `lib/`, where the real
// client is written against them. This file imports them back and
// re-exports them, so a test reaches the double and the interface it
// implements through one module. What stays here is only what does not
// ship: the double, its reply map, and its fail switch.
//
// Failure is a thrown Error, not a result envelope, for three reasons, and
// the real client in `lib/gh.ts` matches this shape. First, an unregistered
// endpoint must throw anyway, so this keeps one shape for everything that
// goes wrong. Second, an envelope would make every endpoint's return a
// union that every caller must narrow, including callers that do not model
// failure at all. Third, the real client runs `gh` as a child process,
// where a non-zero exit with stderr is exactly an exception.
//
// There is no request log, no call counter, and no call-order assertion
// here, on purpose. A call count is an implementation detail, and a test
// that counts calls would turn a refactor red (mocking.md).

import { type GhClient, type GhEndpoint, GhError, type GhResults } from '#lib/gh.ts'

export type { GhClient, GhEndpoint, GhResults } from '#lib/gh.ts'
export { GhError } from '#lib/gh.ts'

/** One reply per endpoint, or a failure in its place. A test that
 *  registers nothing for an endpoint means "this must not be called". */
export type GhReplies = { [K in GhEndpoint]?: GhResults[K] | Error }

/**
 * The fail switch. Register it in place of an endpoint's reply, and that
 * one endpoint fails with this message.
 *
 * This is a `GhError`, not a plain one, because that is what the real
 * client throws. `GhError` carries gh's exit status, so a caller branches
 * on a value, not on prose. A command whose test registered a plain
 * `Error` could never reach its own `error instanceof GhError &&
 * error.status === ...` branch. The double would then make the command look
 * covered, while the branch that matters stayed unreachable.
 *
 * `status` defaults to 1, gh's own generic non-zero status. A test that
 * does not care about the number need not name it. The `cause` field holds
 * the message. The real client puts the whole `RunResult` there, and there
 * is no run here, so `cause` carries the one fact there is, instead of
 * `undefined`.
 *
 * `detail` is the message too. On a real failure, `detail` holds gh's own
 * account, without the `gh <argv> failed: ` prefix. A command reads
 * `detail`, not `message`, for its one-line reason. A test writes the
 * message it wants that command to print, so here the two fields hold the
 * same string. A double whose `detail` was empty, or absent, would make a
 * command that reads it look broken, for a reason the real client never
 * produces.
 */
export function ghFails(message: string, status: number | null = 1): GhError {
  return new GhError(message, status, { cause: message, detail: message })
}

/** The reply registered for one endpoint, or the failure it stands for.
 *
 *  An endpoint with no registration throws an error and names itself. If a
 *  command calls gh where the test expected no call, the command fails
 *  loudly. It does not read an empty list as an answer.
 */
function answer<K extends GhEndpoint>(replies: GhReplies, endpoint: K): GhResults[K] {
  const registered = replies[endpoint]
  if (registered === undefined) {
    throw new Error(`gh mock: no reply registered for ${endpoint}`)
  }
  if (registered instanceof Error) {
    throw registered
  }
  // This cast is the price of one `answer` function for every endpoint.
  // `GhReplies` pairs each key with its own result type, but TypeScript
  // cannot narrow an indexed access on a generic parameter past the two
  // guards above. A test enforces the pairing where it registers a reply,
  // which is where a mistake would happen.
  return registered as GhResults[K]
}

/** A `GhClient` that answers from `replies`.
 *
 *  Each endpoint returns its registered reply on every call. The mock holds
 *  no state and has no conditional logic. So a test can measure only what a
 *  command does with the reply.
 */
export function createGhMock(replies: GhReplies = {}): GhClient {
  return {
    viewPullRequest: async () => answer(replies, 'viewPullRequest'),
    viewDefaultBranch: async () => answer(replies, 'viewDefaultBranch'),
    listAdvisories: async () => answer(replies, 'listAdvisories'),
    listDependabotAlerts: async () => answer(replies, 'listDependabotAlerts'),
    searchOpenPullRequests: async () => answer(replies, 'searchOpenPullRequests'),
    createLabel: async () => answer(replies, 'createLabel'),
    createPullRequest: async () => answer(replies, 'createPullRequest'),
  }
}
