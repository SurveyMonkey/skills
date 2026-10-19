// The inputs of `summarize-run`, read and checked where they enter (#229).
// Each reader gives a typed value, or throws a `Refusal` that names the path
// of the bad value. The command turns a refusal into its failure. A field
// that a reader reads arrives present and of its type, or it is a refusal,
// never a default (`gh-security-guide/core.md`).
//
// This file ships. It imports nothing outside the plugin.

import type { ResultStatus } from '../post-agent.ts'
import type { Action } from './pr-inputs.ts'

/** A bad input. The message names the path of the value. */
export class Refusal extends Error {}

const refuse = (text: string): never => {
  throw new Refusal(text)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown, at: string): Record<string, unknown> =>
  isRecord(value) ? value : refuse(`${at} is not an object`)

const list = (value: unknown, at: string): unknown[] =>
  Array.isArray(value) ? value : refuse(`${at} is not a list`)

/** Text that is not empty. */
const text = (value: unknown, at: string): string =>
  typeof value === 'string' && value !== '' ? value : refuse(`${at} is not text`)

/** Text that can be empty. */
const words = (value: unknown, at: string): string =>
  typeof value === 'string' ? value : refuse(`${at} is not text`)

const textOrNull = (value: unknown, at: string): string | null =>
  value === null ? null : text(value, at)

/** An optional key: absent and null are both null. */
const optionalWords = (value: unknown, at: string): string | null =>
  value === undefined || value === null ? null : words(value, at)

const flag = (value: unknown, at: string): boolean =>
  typeof value === 'boolean' ? value : refuse(`${at} is not true or false`)

const number = (value: unknown, at: string): number =>
  typeof value === 'number' ? value : refuse(`${at} is not a number`)

const textList = (value: unknown, at: string): string[] =>
  list(value, at).map((element, index) => text(element, `${at}[${index}]`))

const oneOf = <T extends string>(value: unknown, at: string, choices: readonly T[]): T =>
  choices.includes(value as T) ? (value as T) : refuse(`${at} is not one of ${choices.join(', ')}`)

/** `major_line` as text: text that is not empty, or a whole number. */
const lineOf = (value: unknown, at: string): string => {
  if (typeof value === 'string' && value !== '') return value
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : refuse(`${at} is not text or a whole number`)
}

/** One group: one major line of one package, in one repository. */
export interface Group {
  readonly package: string
  readonly line: string
  readonly branch: string
  readonly repo: string
}

/** One payload of the Workflow `args`, as far as the summary reads it. */
export interface Dispatch {
  readonly group: Group
  readonly repoRoot: string
}

const dispatchOf = (value: unknown, at: string): Dispatch => {
  const dispatch = record(value, at)
  const group = record(dispatch.group, `${at}.group`)
  return {
    group: {
      package: text(group.package, `${at}.group.package`),
      line: lineOf(group.major_line, `${at}.group.major_line`),
      branch: text(group.branch_name, `${at}.group.branch_name`),
      repo: text(group.repo, `${at}.group.repo`),
    },
    repoRoot: text(dispatch.repo_root, `${at}.repo_root`),
  }
}

/** One entry of the Workflow result. Its `result` is read later, by its report. */
export interface Entry {
  readonly dispatch: Dispatch
  readonly result: unknown
  readonly mispaired: boolean
}

export interface Workflow {
  readonly entries: readonly Entry[]
  readonly logs: readonly string[]
}

/** The result of the Workflow tool: `result`, the entries, and `logs`. */
export const workflowOf = (value: unknown): Workflow => {
  const workflow = record(value, 'the file')
  const entries = list(workflow.result, 'result').map((element, index) => {
    const at = `result[${index}]`
    const entry = record(element, at)
    const dispatch = dispatchOf(entry.dispatch, `${at}.dispatch`)
    const mispaired = flag(entry.mispaired, `${at}.mispaired`)
    if (!('result' in entry)) refuse(`${at} has no result`)
    return { dispatch, result: entry.result, mispaired }
  })
  const logs = list(workflow.logs, 'logs').map((line, index) => words(line, `logs[${index}]`))
  return { entries, logs }
}

/** The Workflow `args`: the dispatches, in dispatch order. */
export const argsOf = (value: unknown): readonly Dispatch[] => {
  const args = record(value, 'the file')
  const dispatches = list(args.dispatches, 'dispatches')
  if (dispatches.length === 0) refuse('dispatches has no entry')
  return dispatches.map((element, index) => dispatchOf(element, `dispatches[${index}]`))
}

/** One report of `reap-batch`, as far as the summary reads it. */
export interface Report {
  readonly branch: string
  readonly worktreePath: string
  readonly status: ResultStatus
  readonly reaped: boolean
  readonly reason: string | null
  readonly leftBehind: readonly string[]
  readonly errors: readonly string[]
}

const STATUSES: readonly ResultStatus[] = ['success', 'no-op', 'failure', 'unparsable', 'missing']

/** The answer of `reap-batch`: one report for each group. */
export const reportsOf = (value: unknown): readonly Report[] =>
  list(value, 'the file').map((element, index) => {
    const at = `[${index}]`
    const report = record(element, at)
    return {
      branch: text(report.branch, `${at}.branch`),
      worktreePath: text(report.worktree_path, `${at}.worktree_path`),
      status: oneOf(report.result_status, `${at}.result_status`, STATUSES),
      reaped: flag(report.reaped, `${at}.reaped`),
      reason: textOrNull(report.reason, `${at}.reason`),
      leftBehind: textList(report.left_behind, `${at}.left_behind`),
      errors: textList(report.errors, `${at}.errors`),
    }
  })

/** One path of a cleanup report, and what the driver did to it. */
export interface Artifact {
  readonly path: string
  readonly action: string
}

/** The `cleanup` of a result: what the agent's own cleanup could not remove. */
export interface Cleanup {
  readonly worktree: Artifact
  readonly workDir: Artifact
  readonly branch: string
  /** Absent in the report is null. */
  readonly branchDeleted: boolean | null
  /** `reason`, each of `errors`, and `detail`, in that order. */
  readonly why: readonly string[]
}

const artifactOf = (value: unknown, at: string): Artifact => {
  const artifact = record(value, at)
  return { path: text(artifact.path, `${at}.path`), action: text(artifact.action, `${at}.action`) }
}

const cleanupOf = (value: unknown, at: string): Cleanup => {
  const cleanup = record(value, at)
  const reason = optionalWords(cleanup.reason, `${at}.reason`)
  const errors = textList(cleanup.errors, `${at}.errors`)
  const detail = optionalWords(cleanup.detail, `${at}.detail`)
  return {
    worktree: artifactOf(cleanup.worktree, `${at}.worktree`),
    workDir: artifactOf(cleanup.work_dir, `${at}.work_dir`),
    branch: text(cleanup.branch, `${at}.branch`),
    branchDeleted:
      cleanup.branch_deleted === undefined
        ? null
        : flag(cleanup.branch_deleted, `${at}.branch_deleted`),
    why: [reason, ...errors, detail].filter((part): part is string => part !== null && part !== ''),
  }
}

/** One observation. `canonical` is its JSON with sorted keys, for the dedup. */
export interface Observation {
  readonly type: string
  readonly key: string | null
  readonly range: string | null
  readonly reason: string | null
  readonly canonical: string
}

/** JSON with the keys of each object sorted, so two orders of one object are one text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, inner[key]]),
        )
      : inner,
  )

const observationOf = (value: unknown, at: string): Observation => {
  const observation = record(value, at)
  const type = text(observation.type, `${at}.type`)
  const added = type === 'unscoped_override_added'
  const keyed = added || type === 'unscoped_override'
  return {
    type,
    key: keyed ? text(observation.key, `${at}.key`) : null,
    range: added ? text(observation.range, `${at}.range`) : null,
    reason: added ? text(observation.reason, `${at}.reason`) : null,
    canonical: canonical(observation),
  }
}

/** One copy below the fix line that validate proved the fix cannot reach. */
export interface MajorBump {
  readonly version: string
  readonly ranges: readonly string[]
}

const ACTIONS: readonly Action[] = [
  'direct-update',
  'scoped-override',
  'bare-override',
  'lockfile-refresh',
]

export interface Risk {
  readonly band: string
  readonly score: number
  readonly f4: number
  readonly f5: number
}

/** What every read result carries. */
interface Common {
  readonly prUrl: string | null
  readonly observations: readonly Observation[]
  readonly requiresMajorBump: readonly MajorBump[]
  readonly cleanup: Cleanup | null
}

export type Result =
  | (Common & {
      readonly status: 'success'
      readonly prUrl: string
      readonly action: Action
      readonly bareOverride: string
      readonly risk: Risk | null
    })
  | (Common & {
      readonly status: 'no-op'
      readonly reason: string
      readonly mergedPrUrl: string | null
    })
  | (Common & { readonly status: 'failure'; readonly phase: string; readonly detail: string })

/**
 * A result whose report read it as `status`. The fields that status
 * promises are checked here. `branch` is the branch the result names.
 */
export const resultOf = (
  value: unknown,
  at: string,
  status: 'success' | 'no-op' | 'failure',
): { readonly result: Result; readonly branch: string } => {
  const result = record(value, at)
  if (result.status !== status) refuse(`${at}.status is not ${status}, as its report gives it`)
  const branch = text(result.branch, `${at}.branch`)
  const common: Common = {
    prUrl: textOrNull(result.pr_url, `${at}.pr_url`),
    observations: list(result.observations, `${at}.observations`).map((element, index) =>
      observationOf(element, `${at}.observations[${index}]`),
    ),
    requiresMajorBump: list(result.requires_major_bump, `${at}.requires_major_bump`).map(
      (element, index) => {
        const where = `${at}.requires_major_bump[${index}]`
        const bump = record(element, where)
        return {
          version: text(bump.version, `${where}.version`),
          ranges: textList(bump.vulnerable_ranges, `${where}.vulnerable_ranges`),
        }
      },
    ),
    cleanup: result.cleanup === null ? null : cleanupOf(result.cleanup, `${at}.cleanup`),
  }
  if (status === 'success') {
    const risk = result.risk === null ? null : record(result.risk, `${at}.risk`)
    return {
      branch,
      result: {
        ...common,
        status,
        prUrl: text(result.pr_url, `${at}.pr_url`),
        action: oneOf(result.action, `${at}.action`, ACTIONS),
        bareOverride: oneOf(result.bare_override, `${at}.bare_override`, [
          'none',
          'added',
          'tightened',
        ]),
        risk:
          risk === null
            ? null
            : {
                band: text(risk.band, `${at}.risk.band`),
                score: number(risk.score, `${at}.risk.score`),
                f4: number(risk.f4, `${at}.risk.f4`),
                f5: number(risk.f5, `${at}.risk.f5`),
              },
      },
    }
  }
  if (status === 'no-op') {
    const noOp = record(result.no_op, `${at}.no_op`)
    const evidence = record(noOp.evidence, `${at}.no_op.evidence`)
    return {
      branch,
      result: {
        ...common,
        status,
        reason: text(noOp.reason, `${at}.no_op.reason`),
        mergedPrUrl:
          evidence.merged_pr_url === undefined
            ? null
            : textOrNull(evidence.merged_pr_url, `${at}.no_op.evidence.merged_pr_url`),
      },
    }
  }
  const failure = record(result.failure, `${at}.failure`)
  return {
    branch,
    result: {
      ...common,
      status,
      phase: text(failure.phase, `${at}.failure.phase`),
      detail: words(failure.detail, `${at}.failure.detail`),
    },
  }
}

/** One kept checkout of the discovery. */
export interface Checkout {
  readonly checkout: string
  readonly nwo: string
  readonly flat: boolean
}

/** One checkout that phase 1 or phase 2 excluded. */
export interface Excluded {
  readonly checkout: string
  readonly reason: string
  readonly stderr: string
}

/** One group that phase 2 moved to `skipped`. */
export interface Skipped {
  readonly package: string
  readonly line: string
  readonly repo: string
  readonly reason: string
  /** The installed majors, for `requires major version bump`. */
  readonly majors: readonly string[]
  /** The shared parents, for `shared parent across major lines`. */
  readonly parents: readonly string[]
  /** The open pull request, or the error of the lookup. */
  readonly more: string | null
}

export const REQUIRES_MAJOR = 'requires major version bump'
export const SHARED_PARENT = 'shared parent across major lines'
const OPEN_PR = 'open PR exists'

/**
 * A skip for an open PR of the group. For a flat-scheme twin or a legacy
 * branch, the reason adds the branch in brackets (`discover-alerts.ts`).
 */
export const isOpenPr = (reason: string): boolean =>
  reason === OPEN_PR || reason.startsWith(`${OPEN_PR} (`)
const PR_CHECK_FAILED = 'PR check failed'

export interface Discovery {
  readonly checkouts: readonly Checkout[]
  readonly excluded: readonly Excluded[]
  readonly skipped: readonly Skipped[]
}

/** The answer of `merge-envelopes`. Its `actionable` is not read. */
export const discoveryOf = (value: unknown): Discovery => {
  const discovery = record(value, 'the file')
  const checkouts = list(discovery.checkouts, 'checkouts').map((element, index) => {
    const at = `checkouts[${index}]`
    const checkout = record(element, at)
    return {
      checkout: text(checkout.checkout, `${at}.checkout`),
      nwo: text(checkout.nwo, `${at}.nwo`),
      flat: oneOf(checkout.branch_style, `${at}.branch_style`, ['slash', 'flat']) === 'flat',
    }
  })
  const excluded = list(discovery.excluded, 'excluded').map((element, index) => {
    const at = `excluded[${index}]`
    const entry = record(element, at)
    return {
      checkout: text(entry.checkout, `${at}.checkout`),
      reason: text(entry.reason, `${at}.reason`),
      stderr: words(entry.stderr, `${at}.stderr`),
    }
  })
  const skipped = list(discovery.skipped, 'skipped').map((element, index) => {
    const at = `skipped[${index}]`
    const group = record(element, at)
    const reason = text(group.reason, `${at}.reason`)
    return {
      package: text(group.package, `${at}.package`),
      line: lineOf(group.major_line, `${at}.major_line`),
      repo: text(group.repo, `${at}.repo`),
      reason,
      majors:
        reason === REQUIRES_MAJOR ? textList(group.resolved_majors, `${at}.resolved_majors`) : [],
      parents:
        reason === SHARED_PARENT
          ? textList(group.collision_parents, `${at}.collision_parents`)
          : [],
      more: isOpenPr(reason)
        ? text(group.open_pr_url, `${at}.open_pr_url`)
        : reason === PR_CHECK_FAILED
          ? text(group.error, `${at}.error`)
          : null,
    }
  })
  return { checkouts, excluded, skipped }
}

export type Cause = 'auth' | 'not-found' | 'network' | 'start' | 'detect'

const CAUSES: readonly Cause[] = ['auth', 'not-found', 'network', 'start', 'detect']

/**
 * The answer of `preflight-repo` for one checkout that it excluded, with the
 * `nwo` of that checkout.
 */
export type Preflight =
  | {
      readonly checkout: string
      readonly nwo: string
      readonly error: null
      readonly cause: Cause
      readonly probe: string | null
      readonly stderr: string | null
    }
  | { readonly checkout: string; readonly nwo: string; readonly error: string }

/**
 * The preflight file: from the `checkout` of a kept checkout to the answer
 * of `preflight-repo` for it, or to its failure `{error}`. Only the
 * exclusions are kept, in the order of the file.
 */
export const preflightsOf = (value: unknown, kept: readonly Checkout[]): readonly Preflight[] => {
  const file = record(value, 'the file')
  const excluded: Preflight[] = []
  for (const [checkout, element] of Object.entries(file)) {
    const at = JSON.stringify(checkout)
    const { nwo } =
      kept.find((entry) => entry.checkout === checkout) ??
      refuse(`${at} is not a kept checkout of the discovery`)
    const answer = record(element, at)
    if ('error' in answer) {
      excluded.push({ checkout, nwo, error: text(answer.error, `${at}.error`) })
      continue
    }
    if (flag(answer.ok, `${at}.ok`)) continue
    excluded.push({
      checkout,
      nwo,
      error: null,
      cause: oneOf(answer.cause, `${at}.cause`, CAUSES),
      probe: textOrNull(answer.probe_package, `${at}.probe_package`),
      stderr: answer.stderr === null ? null : words(answer.stderr, `${at}.stderr`),
    })
  }
  return excluded
}
