// The post-agent step for one entry of the workflow result: read the agent
// result, verify its pull request, reap the local artifacts only when the
// pull request reads `OPEN`, and report. This is the port of
// `scripts/common/post-agent.sh` (#229), which #236 deleted. `reap-batch`
// calls it once for each entry.
//
// The report has the shape that `post-agent.sh` had:
//
//   { package, major_line, branch, worktree_path,
//     result_status: "success" | "no-op" | "failure" | "unparsable" | "missing",
//     pr_url, pr_state, reaped, reason, left_behind, errors }
//
//   - `pr_url` and `pr_state` are null unless the result is a success.
//   - `reaped` is true only when the reap ran and gave its report. A reap
//     that left something is still a reap: its `left_behind` and `errors`
//     give the detail.
//   - `reason` says why nothing was reaped. It is null when the reap ran.
//   - `left_behind` names each path and branch that stays: the report of the
//     reap, or, when no reap ran, what is on disk (below).
//
// **The result.** A `null` result is `missing`. So is a `mispaired` entry:
// its result names another group, so it is never read (`fix-groups.mjs`,
// `pairEntry`). A result that is not an object, has an unknown `status`, or
// lacks a field that its status promises is `unparsable`. A success promises
// `package`, `major_line`, `branch` and `pr_url`, and a no-op or a failure
// promises the first three, each as text that is not empty. When the result
// gives none of the three, the dispatch gives them. When both give them and
// they differ, the result wins and `errors` names each difference. A file
// that the workflow wrote has no difference: `pairEntry` makes such an entry
// `mispaired`.
//
// **The path.** `worktree_path` is the work directory
// `<repo_root>/.claude/worktrees/fix-dependabot-<package_path>-<major_line>x`,
// where `<package_path>` is the package with each `/` replaced by `-`. A
// scoped name that kept its `/` would make a directory that the fix agent
// never made (#161). The git worktree is `<work>/fix` (`src/reap.ts`).
//
// **The pull request** is read only for a success, with `entryForUrl` of
// `pr-status`, under the `env_prefix` of the entry. **The reap** runs only on
// `OPEN`: `contain`, then `reap` of `src/reap.ts`, with no prefix, because it
// touches one local path and one local ref (the old `post-agent.sh` gave the
// same reason). The open pull request confirms the push, so a
// branch whose tip is on origin goes. `defaultBranch` is null, as it was in
// `reap-agent-artifacts.sh`.
//
// **What stays when no reap ran** (round 7 ruling 12 on #229). `left_behind`
// names the work directory only when its path exists, and the branch only
// when `git rev-parse --verify --quiet refs/heads/<branch>` finds it in the
// repository root. A repository root that is absent, or not a directory,
// holds neither. A read that fails is not an absent path or branch: the path
// or the branch stays in `left_behind`, and `errors` names the read. Only
// `ENOENT` and `ENOTDIR` make a path absent. A stat that fails for another
// reason, such as `EACCES`, is a failed read. Only exit 1 with no text and no
// stream error is an absent branch. On exit 0 the branch is there, so it
// stays with no error, also when a stream is lost. On another exit,
// `refReadFailure` in `src/reap.ts` holds the rule for both files.
//
// Differences from the script, each with #229:
//   - The input is one entry of the workflow result, not a file. The script
//     read a file that held the JSON or a whole transcript, and found the
//     last closed json fence in it. The workflow gives the result as a value,
//     so no fence is read.
//   - A reason names the entry (`entry <i> of <file>`), not a result file.
//     A mispaired entry has its own reason. The script read an empty file
//     for it, and gave the reason of a missing result.
//   - A difference names the field of the dispatch, not a command-line flag.
//   - A reason names `pr-status`, not `pr-status.sh`.
//   - A refused reap gives the refusal of `contain`. The script gave the
//     JSON that `reap-agent-artifacts.sh` wrote on stderr.
//   - Each error is one entry. The script split an error at each line break.
//     So a failed removal of the work directory is one error that quotes
//     node, where `rm` gave one line for each path.
//   - An answer of `gh pr view` that is not JSON has the words of the gh
//     client (`lib/gh.ts`). The script gave the words of `pr-status.sh`.
//   - An empty pull request state is the empty text. The script gave null.
//   - When no reap ran, `left_behind` names only a path or a branch that
//     exists, or whose read failed (ruling 12). The script named both from
//     the names of the group, so a failure before setup reported a worktree
//     and a branch that were never made.
//
// This file ships. It imports nothing outside the plugin.

import { statSync } from 'node:fs'

import type { JsonObject } from './lib/envelope.ts'
import { contain, type Git, reap, refReadFailure } from './reap.ts'

export type ResultStatus = 'success' | 'no-op' | 'failure' | 'unparsable' | 'missing'

export type PostAgentReport = {
  readonly package: string
  readonly major_line: string
  readonly branch: string
  readonly worktree_path: string
  readonly result_status: ResultStatus
  readonly pr_url: string | null
  readonly pr_state: string | null
  readonly reaped: boolean
  readonly reason: string | null
  readonly left_behind: string[]
  readonly errors: string[]
}

/** The group of an entry, as its dispatch names it. */
export interface Named {
  readonly package: string
  readonly major_line: string
  readonly branch: string
}

export interface PostAgentInput {
  /** The result of the entry, or null. */
  readonly result: unknown
  readonly mispaired: boolean
  /** The entry in the words of a reason: `entry <i> of <file>`. */
  readonly where: string
  readonly repoRoot: string
  readonly dispatch: Named
}

export interface PostAgentDeps {
  /** One entry of `pr-status` for a URL. */
  readonly readPullRequest: (url: string) => Promise<JsonObject>
  /** git with no prefix, for the reap. */
  readonly git: Git
}

/** What the result gives. Only a success has a URL. */
type Parsed =
  | { readonly status: 'missing' | 'unparsable' }
  | { readonly status: 'no-op' | 'failure'; readonly named: Named }
  | { readonly status: 'success'; readonly named: Named; readonly url: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

const parse = (result: unknown, mispaired: boolean): Parsed => {
  if (mispaired || result === null) return { status: 'missing' }
  if (!isRecord(result)) return { status: 'unparsable' }
  const { status, package: pkg, major_line: line, branch, pr_url: url } = result
  if (!isText(pkg) || !isText(line) || !isText(branch)) return { status: 'unparsable' }
  const named = { package: pkg, major_line: line, branch }
  if (status === 'success') {
    return isText(url) ? { status, named, url } : { status: 'unparsable' }
  }
  return status === 'no-op' || status === 'failure' ? { status, named } : { status: 'unparsable' }
}

/** The field of the dispatch for each field of the result. */
const DISPATCH_FIELDS: Readonly<Record<keyof Named, string>> = {
  package: 'group.package',
  major_line: 'group.major_line',
  branch: 'group.branch_name',
}

const disagreements = (result: Named, dispatch: Named): string[] =>
  (Object.keys(DISPATCH_FIELDS) as (keyof Named)[])
    .filter((field) => result[field] !== dispatch[field])
    .map(
      (field) =>
        `the result's ${field} ('${result[field]}') disagrees with the dispatch's ` +
        `${DISPATCH_FIELDS[field]} ('${dispatch[field]}')`,
    )

/** The state of the pull request, or why it was not read. */
const verify = async (
  url: string,
  read: PostAgentDeps['readPullRequest'],
): Promise<{ readonly state: string | null; readonly problem: string | null }> => {
  const entry = await read(url)
  if ('error' in entry) {
    return {
      state: null,
      problem: `pr-status could not read the pull request: ${String(entry.error)}`,
    }
  }
  return typeof entry.state === 'string'
    ? { state: entry.state, problem: null }
    : { state: null, problem: `pr-status returned an entry with no usable state for ${url}` }
}

/** What is at a path, after links, or the failure of the stat. */
const look = (path: string): 'absent' | 'file' | 'directory' | { readonly failed: string } => {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'file'
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : { failed: message }
  }
}

/**
 * What stays of the group when no reap ran: each of the work directory and
 * the branch that is on disk, and the error of a ref read that failed.
 */
const onDisk = async (
  git: Git,
  repoRoot: string,
  work: string,
  branch: string,
): Promise<{ readonly left: string[]; readonly errors: string[] }> => {
  const atWork = look(work)
  const left = atWork === 'absent' ? [] : [work]
  const errors = typeof atWork === 'object' ? [`stat failed: ${atWork.failed}`] : []
  const atRoot = look(repoRoot)
  if (typeof atRoot === 'object') {
    return { left: [...left, branch], errors: [...errors, `stat failed: ${atRoot.failed}`] }
  }
  if (atRoot !== 'directory') return { left, errors }
  const ref = `refs/heads/${branch}`
  const read = await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref])
  if (read.status === 0) return { left: [...left, branch], errors }
  // `refReadFailure` has the rule: only exit 1 with no text and no stream
  // error is an absent ref.
  const failure = refReadFailure(read)
  return failure === null
    ? { left, errors }
    : { left: [...left, branch], errors: [...errors, `git rev-parse ${ref} failed: ${failure}`] }
}

const REASONS: Readonly<Record<'no-op' | 'failure', string>> = {
  'no-op': 'no-op: the agent made no fix, so there is nothing to verify or reap',
  failure: "failure: the agent's result was a failure",
}

/** Verify, reap when that is allowed, and report, for one entry. */
export const postAgent = async (
  input: PostAgentInput,
  deps: PostAgentDeps,
): Promise<PostAgentReport> => {
  const parsed = parse(input.result, input.mispaired)
  const named = 'named' in parsed ? parsed.named : input.dispatch
  const errors = 'named' in parsed ? disagreements(parsed.named, input.dispatch) : []
  const worktreePath =
    `${input.repoRoot}/.claude/worktrees/fix-dependabot-` +
    `${named.package.replaceAll('/', '-')}-${named.major_line}x`
  // The keys are in the order of the script. A change keeps the place of its key.
  const report = ({
    left_behind,
    ...changes
  }: Partial<Pick<PostAgentReport, 'pr_url' | 'pr_state' | 'reaped' | 'reason'>> &
    Pick<PostAgentReport, 'left_behind'>): PostAgentReport => ({
    package: named.package,
    major_line: named.major_line,
    branch: named.branch,
    worktree_path: worktreePath,
    result_status: parsed.status,
    pr_url: null,
    pr_state: null,
    reaped: false,
    reason: null,
    ...changes,
    left_behind,
    errors,
  })
  /** The report of an entry that no reap ran for. */
  const unreaped = async (
    changes: Partial<Pick<PostAgentReport, 'pr_url' | 'pr_state'>> & { readonly reason: string },
  ): Promise<PostAgentReport> => {
    const stays = await onDisk(deps.git, input.repoRoot, worktreePath, named.branch)
    errors.push(...stays.errors)
    return report({ ...changes, left_behind: stays.left })
  }

  if (parsed.status === 'missing') {
    const reason = input.mispaired
      ? `mispaired result at ${input.where}: it names another group, so it was not read`
      : `missing result block at ${input.where}`
    return unreaped({ reason })
  }
  if (parsed.status === 'unparsable') {
    return unreaped({ reason: `unparseable result block at ${input.where}` })
  }
  if (parsed.status !== 'success') return unreaped({ reason: REASONS[parsed.status] })

  const { url } = parsed
  const { state, problem } = await verify(url, deps.readPullRequest)
  if (problem !== null) {
    errors.push(problem)
    return unreaped({ pr_url: url, reason: problem })
  }
  if (state !== 'OPEN') {
    return unreaped({
      pr_url: url,
      pr_state: state,
      reason: `pull request is not open (state=${state})`,
    })
  }

  const target = await contain(
    {
      repoRoot: input.repoRoot,
      work: worktreePath,
      worktree: `${worktreePath}/fix`,
      branch: named.branch,
    },
    deps.git,
  )
  if (target.outcome !== 'ok') {
    const reason = 'the reap refused the paths, so nothing was removed'
    errors.push(`${reason}: ${target.error}`)
    return unreaped({ pr_url: url, pr_state: state, reason })
  }
  const reaped = await reap(target.value, { pushed: true, defaultBranch: null }, deps.git)
  errors.push(...reaped.errors)
  return report({ pr_url: url, pr_state: state, reaped: true, left_behind: reaped.left_behind })
}
