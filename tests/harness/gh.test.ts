// The mock's own claims. The suite's other tests read a registered reply
// back through a command. A mock that quietly answered undefined would
// make them pass for the wrong reason.
import { expect, it } from 'vitest'
import { createGhMock, GhError, ghFails } from '#harness/gh.ts'

const PULL = { pullRequest: 7 }

it('answers with the reply registered for the endpoint', async () => {
  const reply = { number: 7, state: 'OPEN' }
  const client = createGhMock({ viewPullRequest: reply })

  await expect(client.viewPullRequest(PULL)).resolves.toBe(reply)
})

it('answers with the same reply on every call', async () => {
  // A reply consumed by the first call would make a command that asks
  // twice pass or fail on how many times it asked.
  const client = createGhMock({ viewPullRequest: { number: 7 } })

  await expect(client.viewPullRequest(PULL)).resolves.toEqual({ number: 7 })
  await expect(client.viewPullRequest(PULL)).resolves.toEqual({ number: 7 })
})

it.each([
  ['an empty object', {}],
  ['a zero', { number: 0 }],
])('answers with a falsy-looking reply, %s, as the reply', async (_name, reply) => {
  // The guard tests for an absent registration, not for a truthy one.
  const client = createGhMock({ viewPullRequest: reply })

  await expect(client.viewPullRequest(PULL)).resolves.toEqual(reply)
})

it('fails the endpoint the fail switch was registered for', async () => {
  const client = createGhMock({ viewPullRequest: ghFails('gh: Not Found (HTTP 404)') })

  await expect(client.viewPullRequest(PULL)).rejects.toThrow(GhError)
  await expect(client.viewPullRequest(PULL)).rejects.toThrow('gh: Not Found (HTTP 404)')
})

it('fails with the error type the real client throws, carrying the status it was given', async () => {
  // `GhError` carries gh's own exit status, so a command branches on a
  // value, not on prose. A double that threw a plain `Error` would leave
  // that branch unreachable from every command's own suite.
  const client = createGhMock({ viewPullRequest: ghFails('gh: HTTP 403', 4) })

  const thrown = await client.viewPullRequest(PULL).catch((error: unknown) => error)

  expect(thrown).toBeInstanceOf(GhError)
  expect((thrown as GhError).status).toBe(4)
  expect((thrown as GhError).message).toBe('gh: HTTP 403')
  // `detail` is gh's own account, without the `gh <argv> failed: ` prefix.
  // The double has no argv, so the message it was given is that account.
  expect((thrown as GhError).detail).toBe('gh: HTTP 403')
  expect((thrown as GhError).cause).toBe('gh: HTTP 403')
})

it('fails with status 1 unless the test names another', () => {
  expect(ghFails('gh: boom').status).toBe(1)
  expect(ghFails('gh: killed', null).status).toBeNull()
  expect(ghFails('gh: exit zero', 0).status).toBe(0)
})

it('rethrows any registered Error as it is', async () => {
  const failure = new Error('plain')
  const client = createGhMock({ viewPullRequest: failure })

  const thrown = await client.viewPullRequest(PULL).catch((error: unknown) => error)

  expect(thrown).toBe(failure)
})

it('throws and names the endpoint when nothing is registered for it', async () => {
  // This is the property a stub binary cannot give. If a command reaches
  // for gh where the test expected no call, the command fails. It does not
  // read an empty reply as an answer.
  const client = createGhMock()

  await expect(client.viewPullRequest(PULL)).rejects.toThrow(
    'gh mock: no reply registered for viewPullRequest',
  )
})
