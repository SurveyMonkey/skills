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

it('fails an unregistered endpoint with a plain Error, never a GhError', async () => {
  // A command's `instanceof GhError` branch must not read a missing
  // registration as a failure of gh itself.
  const client = createGhMock()

  const thrown = await client.viewPullRequest(PULL).catch((error: unknown) => error)

  expect(thrown).toBeInstanceOf(Error)
  expect(thrown).not.toBeInstanceOf(GhError)
})

// The endpoints of `detect-scope` and `check-advisories` (#225) have the same
// semantics as `viewPullRequest`: one reply for each, a fail switch for each,
// and a throw for an endpoint nobody registered.
const REPO = { repository: 'octo/app' }
const ADVISORIES = { package: 'lodash', ecosystem: 'npm' }

it('answers viewDefaultBranch and listAdvisories with the reply registered for each', async () => {
  const branch = { name: 'develop' }
  const advisories = [{ ghsa_id: 'GHSA-aaaa-1111-bbbb' }]
  const client = createGhMock({ viewDefaultBranch: branch, listAdvisories: advisories })

  await expect(client.viewDefaultBranch(REPO)).resolves.toBe(branch)
  await expect(client.listAdvisories(ADVISORIES)).resolves.toBe(advisories)
})

it('answers an empty advisory list and a null branch as replies', async () => {
  const client = createGhMock({ viewDefaultBranch: { name: null }, listAdvisories: [] })

  await expect(client.viewDefaultBranch(REPO)).resolves.toEqual({ name: null })
  await expect(client.listAdvisories(ADVISORIES)).resolves.toEqual([])
})

it('fails only the endpoint that the fail switch was registered for', async () => {
  const client = createGhMock({
    viewDefaultBranch: ghFails('gh: HTTP 404'),
    listAdvisories: [],
  })

  await expect(client.viewDefaultBranch(REPO)).rejects.toThrow(GhError)
  await expect(client.viewDefaultBranch(REPO)).rejects.toThrow('gh: HTTP 404')
  await expect(client.listAdvisories(ADVISORIES)).resolves.toEqual([])
})

it('throws and names the endpoint when nothing is registered for the new endpoints', async () => {
  const client = createGhMock()

  await expect(client.viewDefaultBranch(REPO)).rejects.toThrow(
    'gh mock: no reply registered for viewDefaultBranch',
  )
  await expect(client.listAdvisories(ADVISORIES)).rejects.toThrow(
    'gh mock: no reply registered for listAdvisories',
  )
})

// The endpoints of `discover-alerts` (#225) have the same semantics.
const ALERTS = { host: 'github.com', owner: 'octo', repo: 'app' }
const SEARCH = { repository: 'github.com/octo/app', head: 'fix/dependabot-lodash-4x' }

it('answers listDependabotAlerts and searchOpenPullRequests with the reply registered for each', async () => {
  const alerts = [{ number: 1 }]
  const found = [{ url: 'https://github.com/octo/app/pull/7' }]
  const client = createGhMock({ listDependabotAlerts: alerts, searchOpenPullRequests: found })

  await expect(client.listDependabotAlerts(ALERTS)).resolves.toBe(alerts)
  await expect(client.searchOpenPullRequests(SEARCH)).resolves.toBe(found)
})

it('fails each endpoint of discover-alerts on its own fail switch', async () => {
  const client = createGhMock({
    listDependabotAlerts: ghFails('gh: Not Found (HTTP 404)'),
    searchOpenPullRequests: [],
  })

  await expect(client.listDependabotAlerts(ALERTS)).rejects.toThrow('gh: Not Found (HTTP 404)')
  await expect(client.searchOpenPullRequests(SEARCH)).resolves.toEqual([])
})

it('throws and names each endpoint of discover-alerts when nothing is registered', async () => {
  const client = createGhMock()

  await expect(client.listDependabotAlerts(ALERTS)).rejects.toThrow(
    'gh mock: no reply registered for listDependabotAlerts',
  )
  await expect(client.searchOpenPullRequests(SEARCH)).rejects.toThrow(
    'gh mock: no reply registered for searchOpenPullRequests',
  )
})

// The write endpoints of `render-pr` (#233).
const NEW_LABEL = {
  repository: 'octo/app',
  name: 'security',
  color: 'D93F0B',
  description: 'Security fix',
}
const NEW_PULL = {
  repository: 'octo/app',
  head: 'fix/x',
  labels: ['security'],
  title: 't',
  bodyFile: '/w/body.md',
}

it('answers createLabel and createPullRequest with the reply registered for each', async () => {
  const label = { created: false }
  const pull = { url: 'https://github.com/octo/app/pull/7' }
  const client = createGhMock({ createLabel: label, createPullRequest: pull })

  await expect(client.createLabel(NEW_LABEL)).resolves.toBe(label)
  await expect(client.createPullRequest(NEW_PULL)).resolves.toBe(pull)
})

it('fails each write endpoint on its own fail switch', async () => {
  const client = createGhMock({
    createLabel: ghFails('HTTP 403: Resource not accessible'),
    createPullRequest: { url: 'https://github.com/octo/app/pull/7' },
  })

  await expect(client.createLabel(NEW_LABEL)).rejects.toThrow('HTTP 403: Resource not accessible')
  await expect(client.createPullRequest(NEW_PULL)).resolves.toEqual({
    url: 'https://github.com/octo/app/pull/7',
  })
})

it('throws and names each write endpoint when nothing is registered', async () => {
  const client = createGhMock()

  await expect(client.createLabel(NEW_LABEL)).rejects.toThrow(
    'gh mock: no reply registered for createLabel',
  )
  await expect(client.createPullRequest(NEW_PULL)).rejects.toThrow(
    'gh mock: no reply registered for createPullRequest',
  )
})
