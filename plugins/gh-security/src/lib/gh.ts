// The typed `gh` client: one method per operation this plugin performs,
// injected into command handlers and mocked one method at a time (issue
// #216's decision comment, and the testing skill's mocking.md).
//
// The method list is not a design: it is every `gh` call site in the shipped
// scripts, and it is meant to stay that way. Adding a call means adding a
// method here, which is what keeps the endpoints a handler touches legible
// from its substitution list rather than buried in an argv somewhere.
//
// **Octokit is not the client.** Nothing shipped imports anything outside the
// plugin (ADR 012), so the per-endpoint method shape is the model rather than
// the library, and `gh` stays the transport: it already carries the user's
// authentication, and `env_prefix` already wraps it where a session needs
// one. Each method is a thin call through the runner, so the only logic here
// is the request it builds and what it makes of the reply.
//
// **A process seam is where untrusted input arrives** (the plugin guide), so
// every reply is validated where it enters: parsed, asserted to be the shape
// the endpoint promises, and never defaulted. `gh api --paginate --slurp`
// answers one array per response page; collapsing that nesting is this
// client's job, because a caller that forgot would read a page as a record.
//
// This file ships. It imports nothing outside the plugin.

import { type EnvPrefix, NO_ENV_PREFIX, withEnvPrefix } from './env-prefix.ts'
import { type Envelope, failure, type JsonValue, ok } from './envelope.ts'
import { describeRun, type RunResult, run, type Spawn } from './process-runner.ts'

export interface GhClientOptions {
  readonly spawn?: Spawn
  readonly envPrefix?: EnvPrefix
}

/** The `gh pr view` projection `pr-status` reads, and nothing beyond it. */
export interface PullRequestView {
  readonly number: number
  readonly state: string
  readonly isDraft: boolean
  readonly headRefName: string
  readonly baseRefName: string
  readonly mergeStateStatus: string | null
  readonly statusCheckRollup: readonly JsonValue[]
}

/** The fields the view above is built from, in the order `gh` is asked for them. */
export const PR_VIEW_FIELDS: readonly string[] = [
  'number',
  'state',
  'isDraft',
  'headRefName',
  'baseRefName',
  'mergeStateStatus',
  'statusCheckRollup',
]

export interface GhClient {
  /** Every open Dependabot alert for a repository, pages collapsed. */
  readonly listDependabotAlerts: (input: { repo: string }) => Envelope<readonly JsonValue[]>
  /** Every published advisory affecting a package in one ecosystem. */
  readonly listAdvisories: (input: {
    package: string
    ecosystem: string
  }) => Envelope<readonly JsonValue[]>
  /** The URL of an open PR headed from a branch, or `null` when there is none. */
  readonly findOpenPullRequest: (input: { repo: string; head: string }) => Envelope<string | null>
  /** One pull request's state, checks included. */
  readonly viewPullRequest: (input: { url: string }) => Envelope<PullRequestView>
  /** Create a label, tolerating one that is already there. */
  readonly createLabel: (input: {
    repo: string
    name: string
    color: string
    description: string
  }) => Envelope<{ created: boolean }>
  /** Open a pull request, answering with its URL. */
  readonly createPullRequest: (input: {
    repo: string
    head: string
    title: string
    bodyFile: string
    labels: readonly string[]
  }) => Envelope<{ url: string }>
}

const parseJson = (text: string, what: string): Envelope<JsonValue> => {
  try {
    return ok(JSON.parse(text) as JsonValue)
  } catch {
    return failure(`Invalid JSON response for ${what}`)
  }
}

/**
 * The API's own `.message` when the body is a JSON object carrying one. A
 * non-JSON-object body has none to read, so the two cases report differently
 * rather than one of them reporting nothing.
 */
const apiMessage = (body: JsonValue): string => {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const message = body.message
    if (typeof message === 'string') return message
  }
  return 'response is not a JSON array'
}

/**
 * Collapse the page nesting `--paginate --slurp` produces.
 *
 * The load-bearing assumption, inherited from the scripts and stated here
 * because it is what makes a short answer impossible: `--paginate --slurp`
 * either emits the whole collection or exits non-zero, never a truncated
 * collection at status 0. Slurping requires `gh` to hold every page before it
 * can emit the enclosing array, so a mid-pagination failure has nothing
 * partial to print.
 */
const flattenPages = (text: string, what: string): Envelope<readonly JsonValue[]> => {
  const parsed = parseJson(text, what)
  if (parsed.outcome !== 'ok') return parsed
  const body = parsed.value
  if (!Array.isArray(body)) {
    return failure(`Unexpected API response for ${what}: ${apiMessage(body)}`)
  }
  const items: JsonValue[] = []
  for (const page of body) {
    if (!Array.isArray(page)) {
      return failure(`Unexpected API response for ${what}: a page is not an array of results`)
    }
    items.push(...page)
  }
  return ok(items)
}

const asObject = (value: JsonValue, what: string): Envelope<{ [key: string]: JsonValue }> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? ok(value)
    : failure(`${what} did not answer with a JSON object`)

export const createGhClient = (options: GhClientOptions = {}): GhClient => {
  const prefix = options.envPrefix ?? NO_ENV_PREFIX

  // Every method goes through here, so `env_prefix` is applied once and the
  // failure of a `gh` that exits non-zero carries `gh`'s own wording, which
  // is what a caller classifies.
  const gh = (args: readonly string[]): Envelope<RunResult> => {
    const result = run(withEnvPrefix(prefix, { command: 'gh', args }), options.spawn)
    return result.status === 0 ? ok(result) : failure(describeRun(result))
  }

  const paginated = (path: string, what: string): Envelope<readonly JsonValue[]> => {
    const answered = gh(['api', path, '--paginate', '--slurp'])
    return answered.outcome === 'ok' ? flattenPages(answered.value.stdout, what) : answered
  }

  return {
    listDependabotAlerts: (input) =>
      paginated(
        `repos/${input.repo}/dependabot/alerts?state=open&per_page=100`,
        `alerts for ${input.repo}`,
      ),

    // `affects` matches the package name; the ecosystem narrows it, since the
    // same name exists in more than one registry. The query is built by
    // interpolation rather than by an encoder, which is what the script this
    // replaces does and what the field runs are evidence for: a registry
    // package name carries no character that would end the value early.
    listAdvisories: (input) =>
      paginated(
        `advisories?affects=${input.package}&ecosystem=${input.ecosystem}&per_page=100`,
        `advisories for ${input.package} (${input.ecosystem})`,
      ),

    findOpenPullRequest: (input) => {
      const answered = gh([
        'pr',
        'list',
        '--repo',
        input.repo,
        '--search',
        `head:${input.head}`,
        '--state',
        'open',
        '--json',
        'url',
      ])
      if (answered.outcome !== 'ok') return answered
      const what = `the open-PR search for ${input.head}`
      const parsed = parseJson(answered.value.stdout, what)
      if (parsed.outcome !== 'ok') return parsed
      if (!Array.isArray(parsed.value)) {
        return failure(`Unexpected API response for ${what}: ${apiMessage(parsed.value)}`)
      }
      const [first] = parsed.value
      // No match is `null`, which is an answer. It is never confused with a
      // failure: a search that could not run is the failure above, and this
      // plugin dispatching a group whose PR is open is what folding the two
      // together produces.
      if (first === undefined) return ok(null)
      const entry = asObject(first, what)
      if (entry.outcome !== 'ok') return entry
      const url = entry.value.url
      return typeof url === 'string' && url !== ''
        ? ok(url)
        : failure(`${what} answered a result carrying no url`)
    },

    viewPullRequest: (input) => {
      const answered = gh(['pr', 'view', input.url, '--json', PR_VIEW_FIELDS.join(',')])
      if (answered.outcome !== 'ok') return answered
      const what = `gh pr view ${input.url}`
      const parsed = parseJson(answered.value.stdout, what)
      if (parsed.outcome !== 'ok') return parsed
      const view = asObject(parsed.value, what)
      if (view.outcome !== 'ok') return view
      const fields = view.value
      // Present and of the promised type, or a hard error, never a default
      // (ADR 001). A field read straight out of an absent key takes a branch
      // of its own downstream: a missing `isDraft` reads as "ready", and a
      // missing `state` reads as neither open nor merged.
      //
      // Two fields are the documented exception, because GitHub itself
      // answers them null: `mergeStateStatus` while mergeability is still
      // being computed, and `statusCheckRollup` on a head commit that has no
      // checks. `pr-status.sh` reads the same two that way today
      // (`(.statusCheckRollup // []) as $roll`, and `.mergeStateStatus`
      // straight), so `??` here is the port of that and not a default papering
      // over an absent key. Every other field is checked below with no
      // fallback at all.
      const number = fields.number
      const state = fields.state
      const isDraft = fields.isDraft
      const headRefName = fields.headRefName
      const baseRefName = fields.baseRefName
      const mergeStateStatus = fields.mergeStateStatus ?? null
      const statusCheckRollup = fields.statusCheckRollup ?? []
      if (
        typeof number !== 'number' ||
        typeof state !== 'string' ||
        typeof isDraft !== 'boolean' ||
        typeof headRefName !== 'string' ||
        typeof baseRefName !== 'string' ||
        !(mergeStateStatus === null || typeof mergeStateStatus === 'string') ||
        !Array.isArray(statusCheckRollup)
      ) {
        return failure(`${what} answered a pull request this client cannot read`)
      }
      return ok({
        number,
        state,
        isDraft,
        headRefName,
        baseRefName,
        mergeStateStatus,
        statusCheckRollup,
      })
    },

    // Sibling agents fixing other packages in the same batch race to create
    // the same band label, and the loser's failure means the label is there,
    // which is what it wanted. The match runs against stderr ALONE, never
    // against a combined stream: `gh`'s own error text is what carries the
    // phrase, and matching the combination let any failure whose stdout
    // happened to contain it read as success.
    createLabel: (input) => {
      const result = run(
        withEnvPrefix(prefix, {
          command: 'gh',
          args: [
            'label',
            'create',
            input.name,
            '--repo',
            input.repo,
            '--color',
            input.color,
            '--description',
            input.description,
          ],
        }),
        options.spawn,
      )
      if (result.status === 0) return ok({ created: true })
      if (result.stderr.includes('already exists')) return ok({ created: false })
      return failure(describeRun(result))
    },

    createPullRequest: (input) => {
      const labelArgs = input.labels.flatMap((label) => ['--label', label])
      const answered = gh([
        'pr',
        'create',
        '--repo',
        input.repo,
        '--head',
        input.head,
        ...labelArgs,
        '--title',
        input.title,
        '--body-file',
        input.bodyFile,
      ])
      if (answered.outcome !== 'ok') return answered
      // `gh` prints the URL of the pull request it made, and that is the only
      // thing that proves one was made. An exit 0 with no URL in the output
      // is a success claim backed by nothing.
      const urls = answered.value.stdout.match(/https:\/\/github\.com\/\S+/g)
      const url = urls?.at(-1)
      return url === undefined
        ? failure(`gh pr create produced no PR URL. Output: ${answered.value.stdout.trim()}`)
        : ok({ url })
    },
  }
}
