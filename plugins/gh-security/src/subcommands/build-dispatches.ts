// `gh-security build-dispatches --envelope <merged.json> --cap <n>
// [--env-prefixes <prefixes.json>] <repo>:<branch_name>...`: build the
// `args` of the dispatch Workflow for the approved groups. This is the
// contract of #193 and #228, built here and not ported. It does the payload
// part of phase 6 of the `resolve-alerts` skill.
//
// The output is the `args` object that `workflows/fix-groups.mjs` reads, as
// one JSON object on stdout. The dispatcher gives that object to the
// Workflow tool as a JSON value. A JSON-encoded string arrives as one
// string, and the guard of the Workflow then finds no `dispatches`.
//
// Input:
//   --envelope      the answer of `merge-envelopes`, as a file. The input is
//                   files and not stdin. The allow hook gives no decision for
//                   a command with a redirection (`cli.md`).
//   --cap           the cap of `detect-capacity.sh`: a whole number, 1 or
//                   more.
//   --env-prefixes  optional. A file with one JSON object, from the
//                   `checkout` of a kept checkout to its prefix. A checkout
//                   with no entry has no prefix. One flag cannot hold one
//                   prefix for each repository, so this is a file.
//   the ids         one for each approved group: `<repo>:<branch_name>`.
//                   `branch_name` alone repeats across repositories.
//
// Output: `{cap, dispatches}`. Each dispatch is
// `{group, adapter_path, nwo, default_branch, repo_root, scripts_dir}`, and
// `env_prefix` only for a checkout with a prefix. The key is then omitted,
// never null (SKILL.md phase 6). `group` is the group of the envelope, with
// each field that it has. `nwo` is the `repo` of the group. `default_branch`
// and `repo_root` come from the checkout whose `nwo` is that `repo`.
// `adapter_path` comes from the ecosystem of the group, through the adapter
// registry. `scripts_dir` is `scripts/common` of this plugin. The order is
// the order of `actionable`, which is the rank of phase 3, and not the order
// of the ids.
//
// The command fails, with exit 1, in these cases. Each one is a batch that
// the Workflow would refuse, or would run wrong without a word:
//   - a bad command line, or no `--envelope`,
//   - no id: an empty batch is an error, never an empty `args`,
//   - a `cap` that is not a whole number of 1 or more,
//   - an id given twice, which would start two agents on one branch,
//   - an id that names no actionable group, or names two,
//   - a group whose `repo` is the `nwo` of no checkout, or of two,
//   - an ecosystem with no adapter,
//   - an envelope or a prefixes file that cannot be read, is not JSON, or
//     does not have its shape,
//   - a prefix for a path that is not a kept checkout, or a prefix with no
//     word in it.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectAdapter } from '../adapters/registry.ts'
import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { type Envelope, failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'

const USAGE =
  'usage: gh-security build-dispatches --envelope <merged.json> --cap <n> [--env-prefixes <prefixes.json>] <repo>:<branch_name>...'

/** The directory of the bash scripts that the fix agent runs. */
export const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts/common', import.meta.url))

/** The directory of the bash adapters. */
const ECOSYSTEMS_DIR = fileURLToPath(new URL('../../scripts/ecosystems', import.meta.url))

/** A whole number, 1 or more, with no sign and no leading zero. */
const CAP = /^[1-9][0-9]*$/

/** The fields of the answer of `merge-envelopes`. */
const ENVELOPE_FIELDS = ['checkouts', 'excluded', 'actionable', 'skipped']

/** The fields of a group that a dispatch needs, each a text that is not empty. */
const GROUP_FIELDS = ['repo', 'package', 'major_line', 'branch_name', 'ecosystem']

/** A JSON object, and not `null`, a list or a scalar. */
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRecordList = (value: unknown): value is JsonObject[] =>
  Array.isArray(value) && value.every(isRecord)

/** One file, as JSON, or the reason that it is not. */
const readJson = (path: string, given: string): Envelope<JsonValue> => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return failed(`build-dispatches: cannot read ${given}: ${(error as Error).message}`)
  }
  try {
    return ok(JSON.parse(text) as JsonValue)
  } catch {
    return failed(`build-dispatches: ${given} is not JSON`)
  }
}

/** A kept checkout, as the envelope gives it. */
interface Checkout {
  readonly checkout: string
  readonly nwo: string
  readonly default_branch: string
}

/** The envelope, checked: its kept checkouts and its actionable groups. */
interface Merged {
  readonly checkouts: readonly Checkout[]
  readonly actionable: readonly JsonObject[]
}

/** Why `value` is not an answer of `merge-envelopes`, or the parts this command reads. */
const mergedOf = (value: JsonValue, given: string): Envelope<Merged> => {
  const problem = (why: string) =>
    failed(`build-dispatches: ${given} is not an answer of merge-envelopes: ${why}`)
  if (!isRecord(value)) return problem('not an object')
  const other = Object.keys(value).find((name) => !ENVELOPE_FIELDS.includes(name))
  if (other !== undefined) return problem(`${other} is not a field of a merge`)
  for (const name of ENVELOPE_FIELDS) {
    if (!isRecordList(value[name])) return problem(`${name} is not a list of objects`)
  }
  const checkouts = value.checkouts as JsonObject[]
  for (const [index, checkout] of checkouts.entries()) {
    for (const name of ['checkout', 'nwo', 'default_branch']) {
      if (typeof checkout[name] !== 'string')
        return problem(`checkouts[${index}].${name} is not text`)
    }
  }
  const actionable = value.actionable as JsonObject[]
  for (const [index, group] of actionable.entries()) {
    for (const name of GROUP_FIELDS) {
      const field = group[name]
      if (typeof field !== 'string' || field === '') {
        return problem(`actionable[${index}].${name} is not a text that is not empty`)
      }
    }
  }
  return ok({ checkouts: checkouts as unknown as Checkout[], actionable })
}

/** The prefix of each checkout that has one, or the reason that the file is wrong. */
const prefixesOf = (
  value: JsonValue,
  given: string,
  checkouts: readonly Checkout[],
): Envelope<ReadonlyMap<string, string>> => {
  if (!isRecord(value)) return failed(`build-dispatches: ${given} is not a JSON object`)
  const prefixes = new Map<string, string>()
  for (const [path, prefix] of Object.entries(value)) {
    if (!checkouts.some((checkout) => checkout.checkout === path)) {
      return failed(`build-dispatches: ${given} names ${path}, which is not a kept checkout`)
    }
    if (typeof prefix !== 'string' || prefix.trim() === '') {
      return failed(`build-dispatches: ${given} gives ${path} a prefix with no word in it`)
    }
    prefixes.set(path, prefix)
  }
  return ok(prefixes)
}

/** The id of a group. */
const idOf = (group: JsonObject): string => `${group.repo}:${group.branch_name}`

/** The payload of one approved group, or the reason that it cannot have one. */
const dispatchOf = (
  group: JsonObject,
  checkouts: readonly Checkout[],
  prefixes: ReadonlyMap<string, string>,
): Envelope<JsonObject> => {
  const id = idOf(group)
  const owners = checkouts.filter((checkout) => checkout.nwo === group.repo)
  if (owners.length !== 1) {
    return failed(
      `build-dispatches: ${id}: the repo ${group.repo} is the nwo of ${owners.length} checkouts, not 1`,
    )
  }
  const route = selectAdapter(group.ecosystem as string)
  if (!route.supported) {
    return failed(`build-dispatches: ${id}: the ecosystem ${route.ecosystem} has no adapter`)
  }
  const owner = owners[0] as Checkout
  const prefix = prefixes.get(owner.checkout)
  return ok({
    group,
    adapter_path: `${ECOSYSTEMS_DIR}/${route.name}.sh`,
    nwo: group.repo as string,
    default_branch: owner.default_branch,
    repo_root: owner.checkout,
    scripts_dir: SCRIPTS_DIR,
    ...(prefix === undefined ? {} : { env_prefix: prefix }),
  })
}

/** The handler. The current directory is a parameter. */
export const buildDispatches = (context: CommandContext, cwd: string): CommandResult => {
  const parsed = parseCommandLine(context.args, {
    envelope: { type: 'string', default: '' },
    cap: { type: 'string', default: '' },
    'env-prefixes': { type: 'string', default: '' },
  })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals: ids } = parsed.value
  if (options.envelope === '' || ids.length === 0) return failed(USAGE)
  if (!CAP.test(options.cap) || !Number.isSafeInteger(Number(options.cap))) {
    return failed(`build-dispatches: --cap is not a whole number of 1 or more: ${options.cap}`)
  }
  const twice = ids.find((id, index) => ids.indexOf(id) !== index)
  if (twice !== undefined) return failed(`build-dispatches: the id ${twice} is given twice`)

  const read = readJson(resolve(cwd, options.envelope), options.envelope)
  if (read.outcome !== 'ok') return read
  const merged = mergedOf(read.value, options.envelope)
  if (merged.outcome !== 'ok') return merged
  const { checkouts, actionable } = merged.value

  let prefixes: ReadonlyMap<string, string> = new Map()
  const prefixFile = options['env-prefixes']
  if (prefixFile !== '') {
    const text = readJson(resolve(cwd, prefixFile), prefixFile)
    if (text.outcome !== 'ok') return text
    const found = prefixesOf(text.value, prefixFile, checkouts)
    if (found.outcome !== 'ok') return found
    prefixes = found.value
  }

  for (const id of ids) {
    const matches = actionable.filter((group) => idOf(group) === id).length
    if (matches !== 1) {
      return failed(`build-dispatches: the id ${id} names ${matches} actionable groups, not 1`)
    }
  }

  const dispatches: JsonObject[] = []
  for (const group of actionable.filter((candidate) => ids.includes(idOf(candidate)))) {
    const dispatch = dispatchOf(group, checkouts, prefixes)
    if (dispatch.outcome !== 'ok') return dispatch
    dispatches.push(dispatch.value)
  }
  return ok({ cap: Number(options.cap), dispatches })
}

export const buildDispatchesCommand: CommandHandler = (context) =>
  buildDispatches(context, process.cwd())
