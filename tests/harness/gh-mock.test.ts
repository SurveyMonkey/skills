// The in-process `gh` mock's own examples. Each one names the mutant it
// exists for: the four semantics it carries were earned by defects in the
// shellspec helper this is the vitest twin of (mocking.md, "How gh is
// mocked"; issue #196), so an example that a tidier mock would also pass is
// an example that has never been shown able to fail.
//
// The client has one endpoint now, `viewPullRequest`. The examples that
// need two endpoints (one registration does not serve another, a failure
// fails only the endpoint it names) come back with the second endpoint.
import { describe, expect, it } from 'vitest'

import { GhError } from '#gh-security/lib/gh.ts'
import { createGhMock } from '#harness/gh-mock.ts'

describe('an operation the example did not declare', () => {
  // Mutant: a mock that answers an unregistered method with an empty
  // object. Downstream that reads as a pull request with no state, which is
  // the found-nothing-is-a-pass shape this plugin refuses everywhere.
  // Registration is the declaration.
  it('rejects rather than answering', async () => {
    const mock = createGhMock()
    await expect(mock.client.viewPullRequest({ pullRequest: 7 })).rejects.toThrow(
      /viewPullRequest was called but no answer was registered/,
    )
  })

  // Mutant: an unregistered call that rejects with a `GhError`. A caller
  // would read that as gh's own failure, and a missing registration in test
  // setup would pass as a tested failure path.
  it('rejects with a plain error, not a GhError', async () => {
    const mock = createGhMock()
    const error = await mock.client.viewPullRequest({ pullRequest: 7 }).catch((thrown) => thrown)
    expect(error).not.toBeInstanceOf(GhError)
  })
})

describe('a registered reply', () => {
  it('is answered with exactly what was registered', async () => {
    const mock = createGhMock()
    mock.reply('viewPullRequest', { number: 7, state: 'OPEN', isDraft: false })
    await expect(mock.client.viewPullRequest({ pullRequest: 7 })).resolves.toEqual({
      number: 7,
      state: 'OPEN',
      isDraft: false,
    })
  })

  // Mutant: a mock that keeps answering the first registration. An example
  // that registers a second reply for the same operation means the second
  // one, and a mock that quietly kept the first would test the code under
  // test against setup nobody wrote.
  it('is replaced by a later registration for the same operation', async () => {
    const mock = createGhMock()
    mock.reply('viewPullRequest', { number: 7, state: 'OPEN' })
    mock.reply('viewPullRequest', { number: 7, state: 'MERGED' })
    await expect(mock.client.viewPullRequest({ pullRequest: 7 })).resolves.toEqual({
      number: 7,
      state: 'MERGED',
    })
  })

  // Mutant: a registration that is replaced by a later failure keeps its
  // reply. The later registration is the one that answers.
  it('is replaced by a later failure for the same operation', async () => {
    const mock = createGhMock()
    mock.reply('viewPullRequest', { number: 7 })
    mock.fail('viewPullRequest', 'GraphQL: Could not resolve to a PullRequest')
    await expect(mock.client.viewPullRequest({ pullRequest: 7 })).rejects.toBeInstanceOf(GhError)
  })
})

describe('the failure switch', () => {
  // Mutant: a mock that tidies the wording, or that carries one spelling for
  // every operation. Classification of that text is what the code under test
  // does with it: `gh pr view` writes the GraphQL error as it came.
  it('rejects with a GhError that carries the real wording, verbatim', async () => {
    const mock = createGhMock()
    mock.fail('viewPullRequest', 'GraphQL: Could not resolve to a PullRequest')
    const error = (await mock.client
      .viewPullRequest({ pullRequest: 7 })
      .catch((thrown: unknown) => thrown)) as GhError
    expect(error).toBeInstanceOf(GhError)
    expect({ message: error.message, detail: error.detail, status: error.status }).toEqual({
      message: 'GraphQL: Could not resolve to a PullRequest',
      detail: 'GraphQL: Could not resolve to a PullRequest',
      status: 1,
    })
  })
})

describe('the request log', () => {
  // Mutant: recording the call after it is answered (issue #87). A rejected
  // or unregistered call is exactly the one that has to show up, because a
  // suppressed mutating call is invisible otherwise.
  it('carries a call the failure switch rejected', async () => {
    const mock = createGhMock()
    mock.fail('viewPullRequest', 'GraphQL: Could not resolve to a PullRequest')
    await mock.client.viewPullRequest({ pullRequest: 7 }).catch(() => undefined)
    expect(mock.requests()).toEqual([{ method: 'viewPullRequest', input: { pullRequest: 7 } }])
  })

  it('carries a call nobody registered, which rejected', async () => {
    const mock = createGhMock()
    await expect(mock.client.viewPullRequest({ pullRequest: 7 })).rejects.toThrow()
    expect(mock.requests()).toEqual([{ method: 'viewPullRequest', input: { pullRequest: 7 } }])
  })

  // Mutant: a log written only when the promise settles. The call is in the
  // log at once, before the caller awaits anything.
  it('carries a call before its answer settles', () => {
    const mock = createGhMock()
    mock.reply('viewPullRequest', {})
    const pending = mock.client.viewPullRequest({ pullRequest: 7 })
    expect(mock.requests()).toEqual([{ method: 'viewPullRequest', input: { pullRequest: 7 } }])
    return pending
  })

  // The absence claim, which is the one behavioral claim a log supports: an
  // endpoint was never reached at all.
  it('is empty when no operation was called', () => {
    const mock = createGhMock()
    mock.reply('viewPullRequest', {})
    expect(mock.requests()).toEqual([])
  })

  // Mutant: an accessor that hands out the log itself. An example that
  // changed the array it got back would then change what the next assertion
  // reads.
  it('hands out a copy, so a caller cannot change the log', async () => {
    const mock = createGhMock()
    mock.reply('viewPullRequest', {})
    await mock.client.viewPullRequest({ pullRequest: 7 })
    const first = mock.requests() as unknown[]
    first.length = 0
    expect(mock.requests()).toHaveLength(1)
  })
})
