// `gh-security summarize-run --workflow <workflow.json> --reports
// <reports.json> --discovery <merged.json> [--preflight <preflights.json>]
// [--args <args.json>]`: write the summary of `resolve-alerts` phase 7. This
// is the contract of #229. Phase 7 was prose that the model did by hand, so
// there is no script to port and no parity run.
//
// Input, all as files. The allow hook gives no decision for a command with a
// redirection (`cli.md`).
//   --workflow   the result of the Workflow tool: `result`, the entries of
//                `workflows/fix-groups.mjs` in dispatch order
//                (`{dispatch, result, mispaired}`), and `logs`, the lines of
//                its log.
//   --reports    the answer of `reap-batch`: one report for each group.
//   --discovery  the answer of `merge-envelopes`: `checkouts` (`checkout`,
//                `nwo`, `branch_style`), `excluded` (`checkout`, `reason`,
//                `stderr`) and `skipped`. Its `actionable` is not read.
//   --preflight  optional. One JSON object, from the `checkout` of a kept
//                checkout to the answer of `preflight-repo` for it, or to
//                `{error}` for a call that failed. Without it, no repository
//                was excluded by the registry preflight.
//   --args       optional. The Workflow `args`, `{cap, dispatches}`. Give it
//                for a run that was interrupted. Each entry then names a
//                dispatch by its `repo` and `branch_name`, and a dispatch with
//                no entry is a group with no entry. Phase 6 reaps the whole
//                dispatch list, so the reports are one for each dispatch, in
//                dispatch order. Without it, the reports are one for each
//                entry, in entry order.
//
// The report of a group decides how its result is read, because `reap-batch`
// has read it already: `success`, `no-op` and `failure` read the result with
// that status. `unparsable` does not read it. `missing` fits only a `null`
// result, a `mispaired` entry, or a dispatch with no entry.
//
// Output: `{"markdown": "..."}`. A command can only write JSON (`run.ts`).
// The sections, in this order. A section with nothing to say is left out,
// except the table and the reap.
//    1. Still vulnerable after this batch: each `requires_major_bump` copy of
//       each result, then each group that phase 2 skipped under `requires
//       major version bump`, with its installed majors.
//    2. Groups: one row for each group. The `Repo`
//       column is left out when one checkout is in scope (the kept and the
//       excluded checkouts). `PR` is the `pr_url` of the result. `Risk` is
//       `<band> (<score>)` and `F4/F5` is `<f4>/<f5>` of a success. Notes:
//         - a success: its action. `bare-override` is `bare override added`
//           or `bare override tightened`. A non-null `cleanup` adds that the
//           group shipped and its cleanup did not finish.
//         - a failure: `baseline could not be established (ambient, affects
//           every group)` for any `baseline`; `peer-only dependency` for a
//           `classify` whose `detail` names `peer_only_dependency`; `shared
//           parent, no reachable override` for an `apply` whose `detail`
//           names the shared-parent shape or a pre-existing override that
//           `pins a DIFFERENT major line`; `branch-namespace collision
//           (preflight miss)` for a `push` whose `detail` names `directory
//           file conflict`; else `failure: <phase>`. A failure with a
//           `pr_url` adds that gh opened that pull request.
//         - a no-op: `no-op: already fixed`, with its line in section 3.
//         - `no result` for a `null` result, `unknown: mispaired result`,
//           `result not read` for an unparsable one, and `unknown: no entry`.
//         - `unverified bookkeeping: <violations>` for a group that the log
//           warned about (`Cross-field inconsistency in the result for
//           <repo> <package> <major_line>: <violations>`).
//    3. Already fixed: each no-op, with its reason and its merged PR.
//    4. Failures: each failure with its label and its `detail`, each `null`
//       result, and each unparsable result with the reason of its report.
//    5. Unknown groups: each mispaired entry and each dispatch with no entry,
//       after one line that says the run was interrupted and at which entry.
//    6. Excluded checkouts and repositories: each excluded checkout with its
//       reason and its stderr, then each repository that the preflight
//       excluded, with the probe package, the cause, and that a new run
//       probes again.
//    7. Flat branch scheme: each checkout whose branch style is `flat`.
//    8. Shared-parent skips: each skip under `shared parent across major
//       lines`, with its `collision_parents`.
//    9. Other skips: each other skip, with its open PR or its error.
//   10. Reap: the count of reports whose `left_behind` is empty, then one
//       line for each report with a `left_behind`, `errors` or a `cleanup`.
//       A path of `left_behind` that ends with a `cleanup` path at a `/`, or
//       the reverse, is one artifact: the line shows the `cleanup` path once,
//       with its action. A `cleanup` path that matches nothing is named after
//       it, with the reason, errors and detail of the cleanup.
//   11. Observations: the observations of all results, without duplicates
//       (the same repository and the same JSON). Each
//       `unscoped_override_added` is one line with its PR. Each repository
//       with an `unscoped_override` is one line with its keys. Each other
//       type is one count for each repository.
//
// The command fails, with exit 1, before it writes anything, in these cases:
//   - a bad command line: an option it does not know, a required flag that
//     is missing, or a word that is not a flag,
//   - a file that cannot be read, or is not JSON,
//   - a file without its shape, or a field that the summary reads that is
//     missing or of another type. The message names the file and the path,
//   - a Workflow result with no entry and no `--args`,
//   - an entry that names no dispatch of `--args`, or the dispatch of an
//     entry before it,
//   - a count of reports that is not the count of groups,
//   - a report whose `result_status` does not fit its entry, or whose
//     `branch` is not the branch of its group or of its result,
//   - a report with `reaped` true and a `reason`, or `reaped` false and no
//     `reason`,
//   - a result whose `status` is not the `result_status` of its report,
//   - a log warning about a group that is not in the batch,
//   - a preflight entry for a path that is not a kept checkout.
//
// Differences from the prose of phase 7, each with #229:
//   - A `null` result is a failure, as phase 7 says. A mispaired entry is
//     unknown, as phase 6 says, and so is a dispatch with no entry. Phase 7
//     names a group with no result at all unknown.
//   - The other skips of phase 2 (`no fix available`, `open PR exists`,
//     `ecosystem not supported yet`, `PR check failed`) have a section. Phase
//     7 does not name them. An `open PR exists` reason that names a
//     flat-scheme or legacy branch also gives its open PR.
//   - An observation of a type that phase 7 does not name is counted, and
//     not dropped.
//   - A `cleanup` with an empty `left_behind` says that the reap cleared what
//     the agent could not only when the reap ran. When no reap ran, it says
//     that nothing is left on disk.
//   - A requires-major line names the vulnerable ranges of the copy, and not
//     its major line. The major of a version is a rule of the adapter
//     (`core.md`).
//   - A `worktree` failure, a phase that phase 7 does not label, gets the
//     generic `failure: worktree`.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { failed, ok } from '../lib/envelope.ts'
import {
  argsOf,
  type Dispatch,
  discoveryOf,
  type Entry,
  preflightsOf,
  Refusal,
  type Report,
  reportsOf,
  resultOf,
  workflowOf,
} from '../render/run-inputs.ts'
import { type Kind, type Row, renderSummary } from '../render/run-summary.ts'

const USAGE =
  'usage: gh-security summarize-run --workflow <workflow.json> --reports <reports.json> --discovery <merged.json> [--preflight <preflights.json>] [--args <args.json>]'

/** The line that `fix-groups.mjs` logs for a result that breaks a cross-field rule. */
const WARNING = /^Cross-field inconsistency in the result for (.+?): (.*)$/

/** One file as JSON, read through `read`. A refusal names the file. */
const readFile = <T>(cwd: string, given: string, read: (value: unknown) => T): T => {
  let text: string
  try {
    text = readFileSync(resolve(cwd, given), 'utf8')
  } catch (error) {
    throw new Refusal(`cannot read ${given}: ${(error as Error).message}`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Refusal(`${given} is not JSON`)
  }
  try {
    return read(value)
  } catch (error) {
    throw new Refusal(`${given}: ${(error as Error).message}`)
  }
}

/** The group of each dispatch, and its entry when the Workflow returned one. */
const pairDispatches = (
  entries: readonly Entry[],
  dispatches: readonly Dispatch[],
  given: string,
): (Entry | Dispatch)[] => {
  const paired: (Entry | Dispatch)[] = [...dispatches]
  for (const [index, entry] of entries.entries()) {
    const { repo, branch } = entry.dispatch.group
    const at = dispatches.findIndex(
      (dispatch) => dispatch.group.repo === repo && dispatch.group.branch === branch,
    )
    if (at === -1)
      throw new Refusal(
        `result[${index}] names ${repo} ${branch}, which no dispatch of ${given} has`,
      )
    if ('result' in (paired[at] as Entry | Dispatch)) {
      throw new Refusal(`result[${index}] names ${repo} ${branch}, as an entry before it does`)
    }
    paired[at] = entry
  }
  return paired
}

/** The row of one group, from its entry, or from its dispatch alone. */
const rowOf = (
  index: number,
  slot: Entry | Dispatch,
  report: Report,
  warnings: ReadonlyMap<string, string>,
  where: (entry: Entry) => string,
): Row => {
  const dispatch = 'result' in slot ? slot.dispatch : slot
  const { group } = dispatch
  const kind: Kind = !('result' in slot)
    ? 'unknown'
    : slot.mispaired
      ? 'mispaired'
      : slot.result === null
        ? 'null'
        : report.status === 'unparsable'
          ? 'unparsable'
          : 'read'
  const fits =
    kind === 'read'
      ? report.status !== 'missing'
      : kind === 'unparsable' || report.status === 'missing'
  if (!fits) {
    throw new Refusal(
      `report ${index} gives result_status ${report.status}, which does not fit group ${index}`,
    )
  }
  // `post-agent` gives a reason exactly when no reap ran.
  if (report.reaped === (report.reason !== null)) {
    throw new Refusal(
      `report ${index} gives reaped ${report.reaped}, and ${report.reason === null ? 'no reason' : 'a reason'}`,
    )
  }
  const read =
    kind === 'read'
      ? resultOf(
          (slot as Entry).result,
          where(slot as Entry),
          report.status as 'success' | 'no-op' | 'failure',
        )
      : null
  const branch = read?.branch ?? group.branch
  if (report.branch !== branch) {
    throw new Refusal(
      `report ${index} names the branch ${report.branch}, and group ${index} is ${branch}`,
    )
  }
  return {
    group,
    kind,
    result: read?.result ?? null,
    report,
    warning: warnings.get(`${group.repo} ${group.package} ${group.line}`) ?? null,
  }
}

/** The handler. The current directory is a parameter. */
export const summarizeRun = (context: CommandContext, cwd: string): CommandResult => {
  const parsed = parseCommandLine(context.args, {
    workflow: { type: 'string', default: '' },
    reports: { type: 'string', default: '' },
    discovery: { type: 'string', default: '' },
    preflight: { type: 'string', default: '' },
    args: { type: 'string', default: '' },
  })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals } = parsed.value
  if (
    options.workflow === '' ||
    options.reports === '' ||
    options.discovery === '' ||
    positionals.length > 0
  ) {
    return failed(USAGE)
  }
  try {
    const workflow = readFile(cwd, options.workflow, workflowOf)
    const reports = readFile(cwd, options.reports, reportsOf)
    const discovery = readFile(cwd, options.discovery, discoveryOf)
    const preflights =
      options.preflight === ''
        ? []
        : readFile(cwd, options.preflight, (value) => preflightsOf(value, discovery.checkouts))
    const dispatches = options.args === '' ? null : readFile(cwd, options.args, argsOf)
    if (dispatches === null && workflow.entries.length === 0) {
      throw new Refusal(`${options.workflow}: result has no entry`)
    }
    const slots =
      dispatches === null
        ? workflow.entries
        : pairDispatches(workflow.entries, dispatches, options.args)
    if (reports.length !== slots.length) {
      throw new Refusal(
        `${options.reports} has ${reports.length} reports for ${slots.length} groups`,
      )
    }
    const labels = slots.map((slot) => {
      const { group } = 'result' in slot ? slot.dispatch : slot
      return `${group.repo} ${group.package} ${group.line}`
    })
    const warnings = new Map<string, string>()
    for (const [index, line] of workflow.logs.entries()) {
      const [, label, violations] = WARNING.exec(line) ?? []
      if (label === undefined) continue
      if (!labels.includes(label)) {
        throw new Refusal(
          `${options.workflow}: logs[${index}] warns about ${label}, which is not a group of the batch`,
        )
      }
      warnings.set(label, violations as string)
    }
    const where = (entry: Entry) =>
      `${options.workflow}: result[${workflow.entries.indexOf(entry)}].result`
    const rows = slots.map((slot, index) =>
      rowOf(index, slot, reports[index] as Report, warnings, where),
    )
    const returned = workflow.entries.length
    return ok({
      markdown: renderSummary({
        rows,
        discovery,
        preflights,
        interrupted: returned < slots.length ? { returned, dispatched: slots.length } : null,
      }),
    })
  } catch (error) {
    // Each reader throws a `Refusal`. Any other throw is a defect, and
    // `run.ts` would render it in these same words.
    return failed(`summarize-run: ${(error as Error).message}`)
  }
}

export const summarizeRunCommand: CommandHandler = (context) => summarizeRun(context, process.cwd())
