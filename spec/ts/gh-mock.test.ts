// The in-process `gh` mock's own examples. Each one names the mutant it
// exists for: the four semantics it carries were earned by defects in the
// shellspec helper this is the vitest twin of (mocking.md, "How gh is
// mocked"; issue #196), so an example that a tidier mock would also pass is
// an example that has never been shown able to fail.
import { describe, expect, it } from 'vitest'

import { PR_VIEW_FIELDS } from '../../plugins/gh-security/src/lib/gh.ts'
import { createGhMock } from './support/gh-mock.ts'

describe('an operation the example did not declare', () => {
  // Mutant: a mock that answers an unregistered method with an empty
  // envelope. Downstream that reads as "this repository has no open alerts",
  // which is the found-nothing-is-a-pass shape this plugin refuses
  // everywhere. Registration is the declaration.
  it('throws rather than answering', () => {
    const mock = createGhMock()
    expect(() => mock.client.listDependabotAlerts({ repo: 'octo/app' })).toThrow(
      /listDependabotAlerts/,
    )
  })

  // Mutant: one registration serving every method, which is the defaulting
  // layer the SDK shape exists to remove. Declaring one operation says
  // nothing about any other.
  it('throws even when a different operation is registered', () => {
    const mock = createGhMock()
    mock.reply('listDependabotAlerts', [])
    expect(() => mock.client.listAdvisories({ package: 'lodash', ecosystem: 'npm' })).toThrow(
      /listAdvisories/,
    )
  })
})

describe('a registered reply', () => {
  it('is answered as a success carrying exactly what was registered', () => {
    const mock = createGhMock()
    mock.reply('listDependabotAlerts', [{ number: 1 }, { number: 2 }])
    expect(mock.client.listDependabotAlerts({ repo: 'octo/app' })).toEqual({
      outcome: 'ok',
      value: [{ number: 1 }, { number: 2 }],
    })
  })

  // The reply is typed by the method it is registered against, which is what
  // keeps a substitution honest: the shape an example hands the code under
  // test is the shape the real client promises for that endpoint.
  it('carries the promised shape for a method that answers a record', () => {
    const mock = createGhMock()
    mock.reply('viewPullRequest', {
      number: 7,
      state: 'OPEN',
      isDraft: false,
      headRefName: 'fix/lodash-4x',
      baseRefName: 'main',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [],
    })
    const viewed = mock.client.viewPullRequest({ url: 'https://github.com/octo/app/pull/7' })
    expect(viewed).toEqual({
      outcome: 'ok',
      value: {
        number: 7,
        state: 'OPEN',
        isDraft: false,
        headRefName: 'fix/lodash-4x',
        baseRefName: 'main',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [],
      },
    })
    // The field list the real client asks `gh` for is not this mock's
    // business, and reading it here would be an example about the client.
    // It is named only to keep the reply above recognisable as that
    // projection.
    expect(PR_VIEW_FIELDS).toContain('mergeStateStatus')
  })

  // Mutant: a mock that keeps answering the first registration. An example
  // that registers a second reply for the same operation means the second
  // one, and a mock that quietly kept the first would test the code under
  // test against setup nobody wrote.
  it('is replaced by a later registration for the same operation', () => {
    const mock = createGhMock()
    mock.reply('findOpenPullRequest', null)
    mock.reply('findOpenPullRequest', 'https://github.com/octo/app/pull/7')
    expect(mock.client.findOpenPullRequest({ repo: 'octo/app', head: 'fix/lodash-4x' })).toEqual({
      outcome: 'ok',
      value: 'https://github.com/octo/app/pull/7',
    })
  })
})

describe('the failure switch', () => {
  // Mutant: a mock that tidies the wording, or that carries one spelling for
  // every operation. Classification of that text is what the code under test
  // does with it, and there is no single spelling: `gh api` writes
  // `gh: Not Found (HTTP 404)`, while a subcommand writes
  // `HTTP 422: Validation Failed: ...` with no `gh:` prefix.
  it.each([
    ['listDependabotAlerts' as const, 'gh: Not Found (HTTP 404)'],
    ['createLabel' as const, 'HTTP 422: Validation Failed: name already exists'],
  ])('answers %s with the real wording, verbatim', (method, wording) => {
    const mock = createGhMock()
    mock.fail(method, wording)
    const answered =
      method === 'listDependabotAlerts'
        ? mock.client.listDependabotAlerts({ repo: 'octo/app' })
        : mock.client.createLabel({
            repo: 'octo/app',
            name: 'merge-risk:low',
            color: '0e8a16',
            description: 'low risk',
          })
    expect(answered).toEqual({ outcome: 'error', error: wording })
  })

  // Mutant: a failure switch that fails every operation at once. The example
  // says which operation fails, and the others answer as registered.
  it('fails only the operation it names', () => {
    const mock = createGhMock()
    mock.fail('createPullRequest', 'GraphQL: A pull request already exists')
    mock.reply('findOpenPullRequest', null)
    expect(mock.client.findOpenPullRequest({ repo: 'octo/app', head: 'fix/lodash-4x' })).toEqual({
      outcome: 'ok',
      value: null,
    })
  })
})

describe('the request log', () => {
  // Mutant: recording the call after it is answered (issue #87). A rejected
  // or unregistered call is exactly the one that has to show up, because a
  // suppressed mutating call is invisible otherwise: the first version of
  // that assertion passed under mutation for this reason.
  it('carries a call the failure switch rejected', () => {
    const mock = createGhMock()
    mock.fail('createPullRequest', 'GraphQL: A pull request already exists')
    mock.client.createPullRequest({
      repo: 'octo/app',
      head: 'fix/lodash-4x',
      title: 'fix: lodash',
      bodyFile: '/tmp/body.md',
      labels: ['dependencies'],
    })
    expect(mock.requests()).toContainEqual(expect.objectContaining({ method: 'createPullRequest' }))
  })

  it('carries a call nobody registered, which threw', () => {
    const mock = createGhMock()
    expect(() => mock.client.listAdvisories({ package: 'lodash', ecosystem: 'npm' })).toThrow()
    expect(mock.requests()).toContainEqual(expect.objectContaining({ method: 'listAdvisories' }))
  })

  // Request shape, which is what a log assertion may claim: that the alert
  // query carried this repository, that the PR search carried this head. The
  // accessor is the whole surface; there is deliberately no count or order
  // helper, because retries, pagination and caching change both without
  // changing behavior.
  it('carries the input each operation was called with', () => {
    const mock = createGhMock()
    mock.reply('listDependabotAlerts', [])
    mock.reply('findOpenPullRequest', null)
    mock.client.listDependabotAlerts({ repo: 'octo/app' })
    mock.client.findOpenPullRequest({ repo: 'octo/app', head: 'fix/lodash-4x' })
    expect(mock.requests()).toContainEqual({
      method: 'listDependabotAlerts',
      input: { repo: 'octo/app' },
    })
    expect(mock.requests()).toContainEqual({
      method: 'findOpenPullRequest',
      input: { repo: 'octo/app', head: 'fix/lodash-4x' },
    })
  })

  // The absence claim, which is the one behavioral claim a log supports: a
  // mutating endpoint was never reached at all (the allowlist in
  // spec/pr_status_spec.sh makes exactly this one).
  it('shows a mutating operation was never reached', () => {
    const mock = createGhMock()
    mock.reply('listDependabotAlerts', [])
    mock.client.listDependabotAlerts({ repo: 'octo/app' })
    expect(mock.requests()).not.toContainEqual(
      expect.objectContaining({ method: 'createPullRequest' }),
    )
  })
})
