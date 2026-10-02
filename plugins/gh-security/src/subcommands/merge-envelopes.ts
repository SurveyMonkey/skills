// `gh-security merge-envelopes <envelope.json>...`: put the answers of
// `prepare-checkout` for each checkout into one answer, with one order for
// the groups of all the repositories. This is the contract of #193 and #227,
// built here and not ported. Its order is that of the deleted jq function
// `combine_results` (`fdb1544^:plugins/gh-security/scripts/common/discover-alerts.sh:562`).
//
// Input: one or more files. Each file holds one answer of `prepare-checkout`,
// a kept checkout or an excluded one. The input is files and not stdin,
// because a command with a redirection cannot get approval before it runs
// (`cli.md`).
//
// Output: `{checkouts, excluded, actionable, skipped}`.
//   checkouts   for each kept checkout, in the order of the files:
//               `{checkout, nwo, default_branch, branch_style,
//               classify_errors}`.
//   excluded    for each excluded checkout, in the order of the files:
//               `{checkout, reason, stderr}`.
//   actionable  each actionable group of each kept checkout, sorted by
//               severity, then EPSS from high to low, then `repo`, `package`
//               and `major_line`. The sort is stable, and it uses the order
//               of jq. So text is in code point order, and the major line
//               `10` comes before `9`.
//   skipped     each skipped group, in the order of the files.
//
// A group keeps every field that it has. Each group has its own `repo`, so
// no group loses its repository in the merge.
//
// The command fails, with exit 1, when there is no file, when a file cannot
// be read, when a file is not JSON, and when a file does not have one of the
// two shapes of `prepare-checkout`. It also fails when a
// `max_epss_percentile` is not a number, because jq's `-(x)` stops there.
//
// Differences from `combine_results`:
//   - The input is the answers of `prepare-checkout`, and not of
//     `discover-alerts`. So `checkouts` and `excluded` are new. Without them,
//     the merge loses the default branch and the branch style of each
//     checkout, and the name of each excluded checkout.
//   - Each input must have the shape of `prepare-checkout`. jq read any
//     object with lists in `actionable` and `skipped`.
//   - A failure is `{"error": ...}` on stdout and prose on stderr, as
//     `cli.md` says.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { compareJq, fieldOf } from '../jq.ts'
import { parseCommandLine } from '../lib/args.ts'
import { failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'

const USAGE = 'usage: gh-security merge-envelopes <envelope.json>...'

/** A JSON object, and not `null`, a list or a scalar. */
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRecordList = (value: unknown): value is JsonObject[] =>
  Array.isArray(value) && value.every(isRecord)

/** The rank of a severity, as `sev_rank` of `combine_results` gives it. */
const severityRank = (severity: unknown): number => {
  if (severity === 'critical') return 0
  if (severity === 'high') return 1
  if (severity === 'medium') return 2
  return severity === 'low' ? 3 : 4
}

/** One file, read and checked: a kept checkout, or an excluded one. */
interface Answer {
  readonly kept: boolean
  readonly value: JsonObject
}

/** The fields of each answer of `prepare-checkout`. */
const KEPT_FIELDS = [
  'checkout',
  'nwo',
  'default_branch',
  'branch_style',
  'actionable',
  'skipped',
  'classify_errors',
]
const EXCLUDED_FIELDS = ['checkout', 'excluded', 'reason', 'stderr']

/** The first field of `value` that is not in `fields`, or undefined. */
const otherField = (value: JsonObject, fields: readonly string[]): string | undefined =>
  Object.keys(value).find((name) => !fields.includes(name))

/** Why a value is not a kept checkout, or null when it is one. */
const keptProblem = (value: JsonObject): string | null => {
  const other = otherField(value, KEPT_FIELDS)
  if (other !== undefined) return `${other} is not a field of a kept checkout`
  for (const name of ['checkout', 'nwo', 'default_branch']) {
    if (typeof value[name] !== 'string') return `${name} is not text`
  }
  if (value.branch_style !== 'slash' && value.branch_style !== 'flat') {
    return 'branch_style is not slash or flat'
  }
  for (const name of ['actionable', 'skipped', 'classify_errors']) {
    if (!isRecordList(value[name])) return `${name} is not a list of objects`
  }
  return null
}

/** Why a value is not an excluded checkout, or null when it is one. */
const excludedProblem = (value: JsonObject): string | null => {
  if (value.excluded !== true) return 'excluded is not true'
  const other = otherField(value, EXCLUDED_FIELDS)
  if (other !== undefined) return `${other} is not a field of an excluded checkout`
  for (const name of ['checkout', 'reason', 'stderr']) {
    if (typeof value[name] !== 'string') return `${name} is not text`
  }
  return null
}

/** The named fields of an answer that {@link readAnswer} has checked. */
const pick = (value: JsonObject, names: readonly string[]): JsonObject =>
  Object.fromEntries(names.map((name) => [name, value[name] as JsonValue]))

/** One file as an answer, or the reason that it is not one. */
const readAnswer = (path: string, given: string): Answer | string => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return `cannot read ${given}: ${(error as Error).message}`
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return `${given} is not JSON`
  }
  if (!isRecord(value)) return `${given} is not an answer of prepare-checkout: not an object`
  const kept = !Object.hasOwn(value, 'excluded')
  const problem = kept ? keptProblem(value) : excludedProblem(value)
  if (problem !== null) return `${given} is not an answer of prepare-checkout: ${problem}`
  return { kept, value }
}

/** The handler. The current directory is a parameter. */
export const mergeEnvelopes = (context: CommandContext, cwd: string): CommandResult => {
  const parsed = parseCommandLine(context.args, {})
  if (parsed.outcome !== 'ok') return parsed
  const { positionals } = parsed.value
  if (positionals.length === 0) return failed(USAGE)

  const checkouts: JsonObject[] = []
  const excluded: JsonObject[] = []
  const actionable: { readonly group: JsonObject; readonly key: JsonValue[] }[] = []
  const skipped: JsonObject[] = []
  for (const given of positionals) {
    const read = readAnswer(resolve(cwd, given), given)
    if (typeof read === 'string') return failed(read)
    const { value } = read
    if (!read.kept) {
      excluded.push(pick(value, ['checkout', 'reason', 'stderr']))
      continue
    }
    checkouts.push(
      pick(value, ['checkout', 'nwo', 'default_branch', 'branch_style', 'classify_errors']),
    )
    for (const group of value.actionable as JsonObject[]) {
      const epss = fieldOf(group, 'max_epss_percentile')
      if (typeof epss !== 'number') {
        return failed(
          `max_epss_percentile is not a number in ${given}: ${JSON.stringify(epss)} cannot be negated`,
        )
      }
      actionable.push({
        group,
        key: [
          severityRank(fieldOf(group, 'max_severity')),
          -epss,
          fieldOf(group, 'repo') as JsonValue,
          fieldOf(group, 'package') as JsonValue,
          fieldOf(group, 'major_line') as JsonValue,
        ],
      })
    }
    skipped.push(...(value.skipped as JsonObject[]))
  }

  return ok({
    checkouts,
    excluded,
    actionable: actionable.sort((a, b) => compareJq(a.key, b.key)).map(({ group }) => group),
    skipped,
  })
}

export const mergeEnvelopesCommand: CommandHandler = (context) =>
  mergeEnvelopes(context, process.cwd())
