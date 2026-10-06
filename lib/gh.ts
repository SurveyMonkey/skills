// The `gh` client: the interface that a command is written against, and the
// real implementation of it. The exported names and signatures are the
// target stack's `lib/gh.ts`, with the differences named in the notes below
// (`PULL_REQUEST_FIELDS`, `DEFAULT_BRANCH_FIELDS`, `ADVISORY_PAGE_SIZE`,
// `ALERT_PAGE_SIZE`, `SEARCH_FIELDS`, `createLabel` and `createPullRequest`).
// This file has the endpoints of the commands that exist: `viewPullRequest`
// for `pr-status` (#226), `viewDefaultBranch` for `detect-scope`,
// `listAdvisories` for `check-advisories`, `listDependabotAlerts` and
// `searchOpenPullRequests` for `discover-alerts` (#225), and `createLabel`
// and `createPullRequest` for `render-pr` (#233). A new endpoint comes with
// the command that calls it, in the shape the target stack gives it (#274).
//
// A command gets a client as an argument, and never builds one itself. The
// test double is `harness/gh.ts`.
//
// **Failure is a thrown `GhError`, not an envelope.** An envelope would make
// each answer a union that every caller must narrow. `gh` runs as a child,
// where a non-zero exit with stderr is an exception. A command turns what it
// catches into an `envelope.ts` outcome, which is where the exit code comes
// from.
//
// **The transport is `process.ts`,** through the `run` option. So this
// file's suite drives each failure in-process, with no `gh` on the machine.
//
// **One parity exception:** a `gh` that fails with an empty stderr gives the
// detail `gh exited <status>`. The bash it replaces gave the empty text
// (`discover-alerts.sh:441`). The port keeps the status on purpose (#302).
//
// This file ships. It imports nothing outside the plugin, and stays inside
// the erasable subset.
import { type Runner, type RunResult, run } from './process.ts'

/** What each endpoint answers with. */
export interface GhResults {
  /** One pull request's own fields. */
  viewPullRequest: Record<string, unknown>
  /** The repository's default branch name, or null for a repository with none. */
  viewDefaultBranch: { readonly name: string | null }
  /** Every advisory on the page list, flattened to one list. */
  listAdvisories: readonly Record<string, unknown>[]
  /** Every open Dependabot alert of one repository, flattened to one list. */
  listDependabotAlerts: readonly Record<string, unknown>[]
  /** The open pull requests that a `head:` search finds, in the order gh gives. */
  searchOpenPullRequests: readonly { readonly url: string }[]
  /** Whether `gh` made the label (`true`), or the label was there before (`false`). */
  createLabel: { readonly created: boolean }
  /** The URL of the pull request that `gh` opened. */
  createPullRequest: { readonly url: string }
}

export type GhEndpoint = keyof GhResults

/** The operations that a command asks `gh` for. `createGhClient`, below,
 *  implements it, and so does `createGhMock` in the harness. */
export interface GhClient {
  viewPullRequest(pull: { pullRequest: number }): Promise<GhResults['viewPullRequest']>
  /** `repository` is `[HOST/]OWNER/REPO`, as `gh repo view` reads it. */
  viewDefaultBranch(repo: { repository: string }): Promise<GhResults['viewDefaultBranch']>
  listAdvisories(query: {
    package: string
    ecosystem: string
  }): Promise<GhResults['listAdvisories']>
  /** `host` is the GitHub host, such as `github.com`, that `gh api` asks. */
  listDependabotAlerts(query: {
    host: string
    owner: string
    repo: string
  }): Promise<GhResults['listDependabotAlerts']>
  /** `repository` is `[HOST/]OWNER/REPO`, as `gh pr list --repo` reads it. */
  searchOpenPullRequests(query: {
    repository: string
    head: string
  }): Promise<GhResults['searchOpenPullRequests']>
  /**
   * `repository` is `[HOST/]OWNER/REPO`, as `gh label create --repo` reads
   * it. A label that exists already is `created: false`, not a failure.
   */
  createLabel(label: {
    repository: string
    name: string
    color: string
    description: string
  }): Promise<GhResults['createLabel']>
  /**
   * `repository` is `[HOST/]OWNER/REPO`, as `gh pr create --repo` reads it.
   * The pull request opens ready for review, never as a draft (ADR 008).
   * `labels` must exist already: `gh pr create` fails on one that does not.
   */
  createPullRequest(pull: {
    repository: string
    head: string
    labels: readonly string[]
    title: string
    bodyFile: string
  }): Promise<GhResults['createPullRequest']>
}

/**
 * What every endpoint here throws.
 *
 * `status` is gh's own exit status, or the shell's 127 and 126 when gh could
 * not start (`process.ts`). `cause` is the whole {@link RunResult}, so a
 * caller that needs stderr, the signal, or the time has them.
 *
 * Every member is public. `tsc` sees a class from `lib/` under two
 * identities, its real path and `plugins/<p>/src/lib/gh.ts` through the
 * symlink. A `private` member would make the two identities different
 * types. `cause` is `Error`'s own public property, set through `super`.
 */
export class GhError extends Error {
  /** gh's exit status, or `null` when a signal ended it. `0` is a real
   *  case: gh succeeded, and its answer was not JSON, or not the shape that
   *  the endpoint promises. So `status !== 0` does not mean "gh failed".
   *  Branch on whether the error comes at all, and use `status` only to
   *  say which failure it was. */
  readonly status: number | null

  /**
   * The account of the failure WITHOUT the `gh <argv> failed: ` prefix that
   * the message has. A caller that prints a one-line reason reads this
   * field, not `message`, so a report quotes gh and not forty characters of
   * `--json` fields.
   *
   * It is {@link accountOf} for a gh that exited non-zero or could not
   * start. It is the message itself where the message is already gh's
   * account (an answer that is not JSON, or not the promised shape).
   */
  readonly detail: string

  constructor(message: string, status: number | null, options: { cause: unknown; detail: string }) {
    super(message, { cause: options.cause })
    // Set here, not inherited. Without this line, a caught failure reports
    // as a plain `Error`.
    this.name = 'GhError'
    this.status = status
    this.detail = options.detail
  }
}

export interface GhClientOptions {
  /** Where `gh` runs. When no call names a repository, `gh` finds it from
   *  the working directory. */
  readonly cwd?: string
  /** `owner/name`, given to every call as `--repo`. A caller that does not
   *  run in the checkout names the repository here. */
  readonly repository?: string
  /**
   * The child's whole environment. When absent, `gh` gets this process's
   * environment.
   *
   * `GH_REPO` changes the repository that `gh` reads, as `GIT_DIR` does for
   * git (`gh help environment`). `GH_HOST`, `GH_TOKEN` and `GH_CONFIG_DIR`
   * are of the same class. A caller that got a `GH_REPO` it did not choose
   * gives an environment without it.
   *
   * The target stack has no `env_prefix` here. A caller that must wrap `gh`
   * in a prefix gives a `run` that does it.
   */
  readonly env?: NodeJS.ProcessEnv
  /** The spawn seam. When absent, the runner of `process.ts`. The runner is
   *  tested against real children (`tests/lib/process.test.ts`). */
  readonly run?: Runner
  /**
   * The time limit, in milliseconds, for every call this client makes. When
   * absent, a call waits for `gh` with no limit. When it fires, `process.ts`
   * kills the child's whole process group, and the call fails with a
   * {@link GhError} that says so.
   */
  readonly boundMs?: number
}

/**
 * The `--json` field list for `gh pr view`: the target stack's list, and
 * `headRefName` and `baseRefName` after it. The target list does not have
 * those two. `pr-status` (#226) reports both, so this is a known divergence
 * from the target stack (ruling 5 on #226). It keeps one endpoint and one
 * list, where a second endpoint would add a call.
 */
const PULL_REQUEST_FIELDS =
  'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
  'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision,' +
  'headRefName,baseRefName'

/**
 * The `--json` field of `gh repo view` for `viewDefaultBranch`. The endpoint
 * is not in the target stack's list. `detect-scope` (#225, ruling 5) reads the
 * default branch from GitHub, because the local `origin/HEAD` symref goes
 * stale when the branch is renamed on GitHub (#167). So this is a known
 * divergence from the target stack.
 */
const DEFAULT_BRANCH_FIELDS = 'defaultBranchRef'

/**
 * The page size of `listAdvisories`, the largest that the advisories
 * endpoint allows. `check-advisories` (#225) lists every advisory of one
 * package, so this endpoint is also not in the target stack's list, and is a
 * known divergence from it. It is the call that `check-advisories.sh` made,
 * with `--paginate --slurp`.
 */
const ADVISORY_PAGE_SIZE = 100

/**
 * The page size of `listDependabotAlerts`, the largest that the alerts
 * endpoint allows. `discover-alerts` (#225) reads every open alert of one
 * repository, so this endpoint is not in the target stack's list, and is a
 * known divergence from it. It is the call that `discover-alerts.sh` made,
 * with `--paginate --slurp`. The call also names the host, because a bare
 * path follows `GH_HOST`.
 */
const ALERT_PAGE_SIZE = 100

/**
 * The `--json` field of `gh pr list` for `searchOpenPullRequests`.
 * `discover-alerts` (#225) asks, for each branch name, if an open pull
 * request has that branch as its head. The target stack has no search, so
 * this endpoint is also a known divergence from it.
 */
const SEARCH_FIELDS = 'url'

/**
 * The phrase of `gh label create` for a label that exists. `createLabel` (#233)
 * is not in the target stack, and is a known divergence from it. It is the
 * call that `render-pr.sh` made. Sibling agents that fix other packages of
 * one batch race to make the same band label, and the loser's failure means
 * that the label is there, which is what it wanted. So the answer says
 * `created: false`, and does not throw.
 */
const LABEL_EXISTS = 'already exists'

/**
 * The URL that `gh pr create` prints. `createPullRequest` (#233) is not in
 * the target stack either, and is a known divergence from it. The pattern
 * is the one of `render-pr.sh`: the host is `github.com`, and the URL runs
 * to the next white space. A pull request of another host is no URL here,
 * the same as it was there.
 */
const PULL_REQUEST_URL = /https:\/\/github\.com\/\S+/g

/** An optional filter, as the two argv words gh wants or as nothing at all. */
const filter = (name: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [`--${name}`, String(value)]

/**
 * What to say about a failure. The first case that applies wins:
 *
 *   1. A child that never started. That is node's failure, not gh's, so
 *      node's message comes first.
 *   2. A child that this process killed at the time limit. A line it wrote
 *      before the kill is not why the call has no answer. `boundMs` is the
 *      limit the caller asked for, not the measured time, so the words are
 *      the same on each call.
 *   3. A child whose pipes failed. The words that came through can be half
 *      of what gh wrote.
 *   4. gh's own stderr, because a caller cannot tell an expired token from a
 *      missing repository without it.
 *   5. The signal, or the status, when stderr is empty.
 *
 * Parity exception, #302 (ruling 9). For an empty stderr the answer is
 * `gh exited <status>`. The bash script keeps the empty text for the same
 * failure (`discover-alerts.sh:441`, `pr_err`). The port names the status,
 * because a skip with an empty `error` tells a reader nothing.
 */
const accountOf = (result: RunResult, boundMs?: number): string => {
  if (result.startFailure !== null) return `cannot run gh: ${result.startFailure.message}`
  if (result.timedOut) return `gh did not answer in ${boundMs ?? result.elapsedMs} ms`
  const broke = result.streamErrors[0]
  if (broke !== undefined) return `gh's output could not be read: ${broke.code}, ${broke.message}`
  const said = result.stderr.trim()
  if (said !== '') return said
  if (result.status === null) return `gh was killed by ${result.signal}`
  return `gh exited ${result.status}`
}

/**
 * A process seam is where untrusted input comes in. So each answer is
 * parsed and checked against the shape that the endpoint promises, and
 * never given a default.
 *
 * The {@link GhError} thrown here has the whole {@link RunResult} as its
 * `cause`, the same as one thrown for a non-zero exit. So `cause.stderr`
 * means the same thing at each throw site. The parse error goes into the
 * message, where a reader sees it.
 */
const parse = (result: RunResult, what: string): unknown => {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    const said = `gh answered ${what} with something that is not JSON: ${(error as Error).message}`
    throw new GhError(said, result.status, { cause: result, detail: said })
  }
}

const record = (result: RunResult, what: string): Record<string, unknown> => {
  const value = parse(result, what)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const said = `gh answered ${what} with something that is not an object: ${JSON.stringify(value)}`
    throw new GhError(said, result.status, { cause: result, detail: said })
  }
  return value as Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What `viewDefaultBranch` promises: the name, or null for no default branch. */
const defaultBranchOf = (result: RunResult): GhResults['viewDefaultBranch'] => {
  const view = record(result, 'gh repo view')
  const ref = view.defaultBranchRef
  // A repository with no commits has no default branch, and `gh` answers null.
  if (ref === null) return { name: null }
  const name = isRecord(ref) ? ref.name : undefined
  if (typeof name === 'string' && name !== '') return { name }
  const said = `gh answered gh repo view with something that has no default branch name: ${JSON.stringify(view)}`
  throw new GhError(said, result.status, { cause: result, detail: said })
}

/** How much of an answer that is not the promised shape goes into the error. */
const SHOWN_CHARACTERS = 200

/**
 * What a call with `--paginate --slurp` promises: pages of objects,
 * flattened. `listAdvisories` and `listDependabotAlerts` both promise it.
 */
const pagesOf = (result: RunResult, what: string): readonly Record<string, unknown>[] => {
  const pages = parse(result, what)
  if (
    !Array.isArray(pages) ||
    !pages.every((page) => Array.isArray(page) && page.every(isRecord))
  ) {
    const said = `gh answered ${what} with something that is not a list of pages of objects: ${JSON.stringify(pages).slice(0, SHOWN_CHARACTERS)}`
    throw new GhError(said, result.status, { cause: result, detail: said })
  }
  return (pages as Record<string, unknown>[][]).flat()
}

/** What `searchOpenPullRequests` promises: a list of objects, each with its url as text. */
const pullRequestsOf = (result: RunResult): GhResults['searchOpenPullRequests'] => {
  const found = parse(result, 'gh pr list')
  if (
    !Array.isArray(found) ||
    !found.every((entry) => isRecord(entry) && typeof entry.url === 'string')
  ) {
    const said = `gh answered gh pr list with something that is not a list of pull requests with a url: ${JSON.stringify(found).slice(0, SHOWN_CHARACTERS)}`
    throw new GhError(said, result.status, { cause: result, detail: said })
  }
  return (found as { url: string }[]).map((entry) => ({ url: entry.url }))
}

/**
 * A failure that says the label is there. It reads gh's own stderr and
 * nothing else (finding 5 of #172): a stdout with the phrase in it, or a
 * child that never started, was killed, or lost a pipe, is a real failure.
 */
const labelExists = (result: RunResult): boolean =>
  result.status !== null &&
  result.status !== 0 &&
  result.startFailure === null &&
  !result.timedOut &&
  result.streamErrors.length === 0 &&
  result.stderr.includes(LABEL_EXISTS)

/**
 * What `createPullRequest` promises: a URL in what `gh` wrote. The script
 * read stdout and stderr as one text, and took the last URL in it.
 */
const pullRequestOf = (result: RunResult): GhResults['createPullRequest'] => {
  const url = [...result.combined.matchAll(PULL_REQUEST_URL)].at(-1)?.[0]
  if (url !== undefined) return { url }
  const said = `gh answered gh pr create with no pull request URL: ${result.combined.slice(0, SHOWN_CHARACTERS)}`
  throw new GhError(said, result.status, { cause: result, detail: said })
}

/** A `GhClient` that runs the real `gh`. */
export const createGhClient = (options: GhClientOptions = {}): GhClient => {
  const spawn = options.run ?? run
  const repository = filter('repo', options.repository)

  /** Run gh, and answer with all that the child did. In the target stack,
   *  a call can give its own limit as a second argument. No endpoint here
   *  does, so this has no second parameter. */
  const invoke = (args: readonly string[]): Promise<RunResult> =>
    spawn('gh', args, { cwd: options.cwd, env: options.env, timeoutMs: options.boundMs })

  /** The result, after this function has found that gh succeeded. A
   *  non-zero exit, a gh that never started, or a pipe that failed becomes
   *  a {@link GhError} with the status and gh's own words. */
  const ensured = (args: readonly string[], result: RunResult): RunResult => {
    // A pipe error is a failure even on status 0. gh exits 0 on the bytes it
    // wrote, but only some of them came through.
    if (result.status !== 0 || result.streamErrors.length !== 0) {
      const detail = accountOf(result, options.boundMs)
      throw new GhError(`gh ${args.join(' ')} failed: ${detail}`, result.status, {
        cause: result,
        detail,
      })
    }
    return result
  }

  /** What gh did, after this function has found that gh succeeded. */
  const succeeded = async (args: readonly string[]): Promise<RunResult> =>
    ensured(args, await invoke(args))

  return {
    viewPullRequest: async (pull) =>
      record(
        await succeeded([
          'pr',
          'view',
          String(pull.pullRequest),
          ...repository,
          '--json',
          PULL_REQUEST_FIELDS,
        ]),
        'gh pr view',
      ),
    viewDefaultBranch: async (repo) =>
      defaultBranchOf(
        await succeeded(['repo', 'view', repo.repository, '--json', DEFAULT_BRANCH_FIELDS]),
      ),
    listAdvisories: async (query) =>
      pagesOf(
        await succeeded([
          'api',
          `advisories?affects=${encodeURIComponent(query.package)}` +
            `&ecosystem=${encodeURIComponent(query.ecosystem)}&per_page=${ADVISORY_PAGE_SIZE}`,
          '--paginate',
          '--slurp',
        ]),
        'gh api advisories',
      ),
    listDependabotAlerts: async (query) =>
      pagesOf(
        await succeeded([
          'api',
          '--hostname',
          query.host,
          `repos/${encodeURIComponent(query.owner)}/${encodeURIComponent(query.repo)}` +
            `/dependabot/alerts?state=open&per_page=${ALERT_PAGE_SIZE}`,
          '--paginate',
          '--slurp',
        ]),
        'gh api dependabot alerts',
      ),
    searchOpenPullRequests: async (query) =>
      pullRequestsOf(
        await succeeded([
          'pr',
          'list',
          '--repo',
          query.repository,
          '--search',
          `head:${query.head}`,
          '--state',
          'open',
          '--json',
          SEARCH_FIELDS,
        ]),
      ),
    createLabel: async (label) => {
      const args = [
        'label',
        'create',
        label.name,
        '--repo',
        label.repository,
        '--color',
        label.color,
        '--description',
        label.description,
      ]
      const result = await invoke(args)
      if (labelExists(result)) return { created: false }
      ensured(args, result)
      return { created: true }
    },
    createPullRequest: async (pull) =>
      pullRequestOf(
        await succeeded([
          'pr',
          'create',
          '--repo',
          pull.repository,
          '--head',
          pull.head,
          ...pull.labels.flatMap((name) => ['--label', name]),
          '--title',
          pull.title,
          '--body-file',
          pull.bodyFile,
        ]),
      ),
  }
}
