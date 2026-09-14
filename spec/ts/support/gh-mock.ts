// The in-process `gh` mock: a `GhClient` (the interface in src/lib/gh.ts)
// whose answers an example registers one method at a time. `gh` is the one
// thing an example cannot run for real, because it is the network and someone
// else's state, and it is the only boundary this harness stands in for
// (mocking.md).
//
// It implements the interface rather than a partial of it, deliberately: a
// method added to `GhClient` makes this file fail to compile until it gains
// the method, so a new endpoint cannot reach an example through a mock that
// silently answers nothing for it.
//
// Four semantics carry over from the shellspec helper this is the twin of
// (mocking.md, "How gh is mocked"; issue #196), each earned by a defect:
//
//   * An operation the example did not declare throws. Registration IS the
//     declaration, and an unregistered call is a failure outright rather than
//     an empty answer that reads downstream as "no alerts".
//   * The failure switch is per method and carries the real wording. `gh api`
//     writes `gh: Not Found (HTTP 404)`; a subcommand writes
//     `HTTP 422: Validation Failed: name already exists` with no `gh:`
//     prefix. Classification of that text is what the code under test does
//     with it, so a tidied error tests nothing.
//   * Every call is recorded BEFORE it is answered, so a rejected or
//     unregistered call still shows up in the log. A failure alone would make
//     a suppressed mutating call invisible (issue #87).
//   * The log is asserted on shape. This module provides the accessor and
//     nothing else: no count helper and no order helper, because retries,
//     pagination and caching change both without changing behavior.
//
// What does NOT carry over is the dispatcher's key matching and its
// last-registration-wins defaulting across endpoints. That existed because a
// command-based shellspec mock is a subprocess handed an argv; a method call
// needs none of it, and a defaulting layer is exactly the conditional logic
// in test setup the SDK shape exists to remove. Re-registering the SAME
// method replaces its answer, which is a single answer being rewritten rather
// than one registration serving endpoints nobody named.
//
// This is test infrastructure: it is not under `src/` and not in the coverage
// include.

import { type Envelope, failure, ok } from '../../../plugins/gh-security/src/lib/envelope.ts'
import type { GhClient } from '../../../plugins/gh-security/src/lib/gh.ts'

/** The operations the client performs, named by the interface itself. */
export type GhMethod = keyof GhClient

/** What a success from one method carries, read off that method's envelope. */
export type GhAnswer<M extends GhMethod> = Extract<
  ReturnType<GhClient[M]>,
  { outcome: 'ok' }
>['value']

/** One recorded call: the operation, and the input it was called with. */
export interface GhRequest {
  readonly method: GhMethod
  readonly input: unknown
}

export interface GhMock {
  /** The client to inject. Every method throws until it is registered. */
  readonly client: GhClient
  /** Register the success one operation answers with. */
  readonly reply: <M extends GhMethod>(method: M, value: GhAnswer<M>) => void
  /**
   * Register the failure one operation answers with. `message` is what the
   * real `gh` writes for that operation, copied rather than tidied.
   */
  readonly fail: (method: GhMethod, message: string) => void
  /** Every call made, in the order they were made. Assert shape only. */
  readonly requests: () => readonly GhRequest[]
}

type Registration =
  | { readonly kind: 'reply'; readonly value: unknown }
  | { readonly kind: 'fail'; readonly message: string }

export const createGhMock = (): GhMock => {
  const registered = new Map<GhMethod, Registration>()
  const log: GhRequest[] = []

  // The one place an answer is decided, so every method below is the same
  // three words and there is no per-endpoint logic anywhere in this file.
  const answer = <M extends GhMethod>(method: M, input: unknown): Envelope<GhAnswer<M>> => {
    log.push({ method, input })
    const registration = registered.get(method)
    if (registration === undefined) {
      throw new Error(
        `gh mock: ${method} was called but no answer was registered for it. ` +
          'Registration is the declaration: register a reply or a failure for ' +
          'every operation the example expects, and nothing else.',
      )
    }
    return registration.kind === 'reply'
      ? ok(registration.value as GhAnswer<M>)
      : failure(registration.message)
  }

  // Spelled out method by method rather than generated, which is what makes a
  // new method on `GhClient` a compile error here.
  const client: GhClient = {
    listDependabotAlerts: (input) => answer('listDependabotAlerts', input),
    listAdvisories: (input) => answer('listAdvisories', input),
    findOpenPullRequest: (input) => answer('findOpenPullRequest', input),
    viewPullRequest: (input) => answer('viewPullRequest', input),
    createLabel: (input) => answer('createLabel', input),
    createPullRequest: (input) => answer('createPullRequest', input),
  }

  return {
    client,
    reply: (method, value) => {
      registered.set(method, { kind: 'reply', value })
    },
    fail: (method, message) => {
      registered.set(method, { kind: 'fail', message })
    },
    requests: () => [...log],
  }
}
