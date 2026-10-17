// What the phases of `audit-pins` share: the stop of a phase, the state of a
// run, the adapter calls, the checks on what the adapter answers, and the
// restore between pins. The contract is in the header of `audit-pins.ts`.
//
// A check that fails ends the phase, as `die` and `fail_phase` end the bash
// script. So each check throws a `Stop` that holds the answer, and `settle`
// at the top of each phase turns it back into that answer. This is the one
// place where the port uses a throw for an outcome (`unwrap` in
// `lib/envelope.ts` is the same idea): the bash has more than sixty exits,
// and an envelope returned from each would put a branch at each call.
//
// This file ships. It imports nothing outside the plugin.

import { dirname } from 'node:path'
import type { Adapter, Environment, Tree } from '../adapters/adapter.ts'

import type { NodeDetection } from '../adapters/node/detect.ts'
import { equal, jqType, render, toText } from '../adapters/node/jq-json.ts'
import { isRecord } from '../adapters/node/manifest.ts'
import {
  type CommandContext,
  type CommandResult,
  type FailedReport,
  failedReport,
} from '../cli/command.ts'
import { uniqueJq } from '../jq.ts'
import { parseEnvPrefix } from '../lib/env-prefix.ts'
import {
  type Envelope,
  type Failure,
  failed,
  type JsonObject,
  type JsonValue,
  ok,
} from '../lib/envelope.ts'
import type { Runner } from '../lib/process.ts'
import {
  loadState,
  readOptionalValue,
  readString,
  readValue,
  type StateFile,
  writeKey,
} from '../state.ts'
import type { ClientFactory } from './check-advisories.ts'
import {
  type FixGroupDeps,
  type Git,
  outputOf,
  promisedFieldOf,
  runners,
} from './fix-group-common.ts'

/** How a `gh` client is made. `judge` and `together` give it to `check-advisories`. */
export type { ClientFactory } from './check-advisories.ts'

/**
 * What the handler is given beside its context: the runner, the registry,
 * and the factory of the `gh` client that the advisory query uses.
 */
export interface AuditPinsDeps extends FixGroupDeps {
  readonly makeClient: ClientFactory
}

/** The deps that a phase gets: those of the handler, and the io of its context. */
export interface PhaseDeps extends AuditPinsDeps {
  readonly io: CommandContext['io']
}

/** The phase names of an exit 3. `compose` comes only from `together`. */
export type AuditPhase = 'list' | 'install' | 'restore' | 'advisories' | 'compose'

/** An answer that ends a phase. */
type Halt = Failure | FailedReport

/** What a check throws to end the phase with its answer. */
export class Stop extends Error {
  readonly result: Halt

  constructor(result: Halt) {
    super(result.error)
    this.name = 'Stop'
    this.result = result
  }
}

/** End the phase with this answer. */
export function stop(result: Halt): never {
  throw new Stop(result)
}

/** Exit 1 with `{"error": ...}`: `die` in the bash. */
export function die(message: string): never {
  return stop(failed(message))
}

/**
 * Exit 3 with `{"status":"failure","phase":...,"detail":...}`: `fail_phase`
 * in the bash. The same detail goes to stderr.
 */
export function failPhase(phase: AuditPhase, detail: string): never {
  return stop(
    failedReport(
      `audit-pins: ${phase} failure: ${detail}`,
      { status: 'failure', phase, detail },
      3,
    ),
  )
}

/** Run a phase, and give the answer of a `Stop` as the answer of the phase. */
export const settle = async (phase: () => Promise<JsonValue>): Promise<CommandResult> => {
  try {
    return ok(await phase())
  } catch (error) {
    if (error instanceof Stop) return error.result
    throw error
  }
}

/** A run after `list`: its state file, its adapter and its runners. */
export interface Session {
  /** The state as it is now. Each write replaces it. */
  state: StateFile
  readonly worktree: string
  /** The work directory, which holds the state file and the advisory cache. */
  readonly work: string
  /** The route of the adapter, which the advisory query also takes. */
  readonly ecosystem: string
  /** The text of `env_prefix`, or null for none. */
  readonly prefix: string | null
  readonly overrideFile: string
  readonly adapter: Adapter<NodeDetection>
  readonly git: Git
  readonly pm: Runner
  readonly env: Environment
  /** `detect` on the worktree, again for each verb, as each `node.sh` call did. */
  readonly tree: () => Envelope<Tree<NodeDetection>>
}

/** `detect` on a worktree, as the tree that the other verbs take. */
export const treeOf = (
  adapter: Adapter<NodeDetection>,
  worktree: string,
  env: Environment,
): Envelope<Tree<NodeDetection>> => {
  const detection = adapter.detect(worktree, env)
  return detection.outcome === 'ok' ? ok({ root: worktree, detection: detection.value }) : detection
}

/** A required text of the state, or exit 1. */
export const requiredText = (state: StateFile, key: string): string => {
  const value = readString(state, key)
  return value.outcome === 'ok' ? value.value : die(value.error)
}

/**
 * Load the state of `--work`, and route its ecosystem to an adapter: the
 * port of `load_state`. A key with no usable value is exit 1, and so is an
 * `env_prefix` that is not text.
 */
export const loadSession = (work: string, env: Environment, deps: AuditPinsDeps): Session => {
  const loaded = loadState(work, 'list')
  if (loaded.outcome !== 'ok') die(loaded.error)
  const state = loaded.value
  const worktree = requiredText(state, 'worktree')
  requiredText(state, 'adapter')
  const ecosystem = requiredText(state, 'ecosystem')
  const overrideFile = requiredText(state, 'override_file')
  const prefix = readOptionalValue(state, 'env_prefix')
  if (prefix !== null && typeof prefix !== 'string') {
    die(
      `the state file at ${state.path} has no usable value for 'env_prefix': ` +
        `expected text, found ${JSON.stringify(prefix)}.`,
    )
  }
  const route = deps.route(ecosystem)
  if (!route.supported) {
    die(
      `the state file at ${state.path} names the ecosystem '${ecosystem}', ` +
        `which has no adapter: ${route.reason}`,
    )
  }
  const adapter = route.adapter
  const { git, pm } = runners(deps.spawn, parseEnvPrefix(prefix), env)
  const tree = () => treeOf(adapter, worktree, env)
  return {
    state,
    worktree,
    work: dirname(state.path),
    ecosystem,
    prefix,
    overrideFile,
    adapter,
    git,
    pm,
    env,
    tree,
  }
}

/** Write one key of the state: `state_set` in the bash. */
export const setKey = (session: Session, key: string, value: JsonValue): void => {
  const written = writeKey(session.state, key, value)
  if (written.outcome !== 'ok') die(written.error)
  session.state = written.value
}

/** A key of the state as `state_get_opt` reads it: its text, or empty for none. */
export const optionalText = (session: Session, key: string): string => {
  const value = readOptionalValue(session.state, key)
  return value === null ? '' : rawText(value)
}

/** A key that the state must carry, or exit 1: `state_get` and `state_ok`. */
export const requiredValue = (session: Session, key: string): JsonValue => {
  const value = readValue(session.state, key)
  return value.outcome === 'ok' ? value.value : die(value.error)
}

/**
 * A value of the state in the shape that the step that wrote it promised,
 * or the failure of the phase: `state_json` in the bash. `expected` is the
 * shape in words, which the detail quotes. An absent key is null.
 */
export const stateValue = <T extends JsonValue>(
  session: Session,
  phase: AuditPhase,
  key: string,
  shape: (value: JsonValue) => value is T,
  expected: string,
  description: string,
): T => {
  const value = readOptionalValue(session.state, key)
  if (shape(value)) return value
  return failPhase(
    phase,
    `${description} is in the state file but is not the shape the step that wrote it ` +
      `promised (expected: ${expected}). An earlier step failed part-way, or the file was ` +
      `edited by hand. Value: ${render(value, null)}`,
  )
}

export const isList = (value: JsonValue): value is JsonValue[] => Array.isArray(value)

/** One entry of `test_order`: the pin as `list` wrote it. */
export type OrderedPin = JsonObject & {
  readonly key: string
  readonly path: string[]
  readonly package: string
}

const isOrderedPin = (value: JsonValue): value is OrderedPin =>
  isRecord(value) &&
  typeof value.key === 'string' &&
  Array.isArray(value.path) &&
  value.path.every((segment) => typeof segment === 'string') &&
  typeof value.package === 'string' &&
  value.package !== ''

/** `test_order` of the state, which each later phase reads. */
export const testOrder = (session: Session): OrderedPin[] =>
  stateValue(
    session,
    'install',
    'test_order',
    (value): value is OrderedPin[] => Array.isArray(value) && value.every(isOrderedPin),
    'a list of pins, each with a text key, a list of texts as its path, and a package name',
    "phase 2's test_order",
  )

/**
 * The shape that `judge` and `together` read out of `findings`, and not only
 * the list that holds it: `FINDINGS_SHAPE` in the bash. A `tested` finding
 * with a bad `attributable_versions` or `collateral_changes` reaches
 * `removable` with no advisory query run (audit-driver.md).
 */
export const FINDINGS_SHAPE = `type == "array"
  and all(.[]; type == "object")
  and all(.[] | select(.status == "tested");
          (.attributable_versions | type) == "array"
          and all(.attributable_versions[]; type == "string")
          and ((.collateral_changes | type) == "array"
               or (.collateral_changes | type) == "null")
          and all(.collateral_changes[]?;
                  type == "object" and (.judged | type) == "boolean"
                  and (.package | type) == "string"
                  and (.newly_admitted | type) == "array"))`

const isCollateralEntry = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.judged === 'boolean' &&
  typeof value.package === 'string' &&
  Array.isArray(value.newly_admitted)

const isTestedShape = (finding: JsonObject): boolean => {
  if (finding.status !== 'tested') return true
  const versions = finding.attributable_versions
  const collateral = finding.collateral_changes ?? null
  return (
    Array.isArray(versions) &&
    versions.every((version) => typeof version === 'string') &&
    (collateral === null || (Array.isArray(collateral) && collateral.every(isCollateralEntry)))
  )
}

export const isFindings = (value: JsonValue): value is JsonObject[] =>
  Array.isArray(value) && value.every(isRecord) && (value as JsonObject[]).every(isTestedShape)

/**
 * Write `findings`, and clear `judge_done`: `set_findings`. Every write to
 * `findings` goes through it, because a judgment is stale once a finding
 * changes (audit-driver.md).
 */
export const setFindings = (session: Session, findings: JsonValue[]): void => {
  setKey(session, 'findings', findings)
  setKey(session, 'judge_done', false)
}

/** Record one finding, in place of any earlier one at its path: `record_finding`. */
export const recordFinding = (session: Session, finding: JsonObject): void => {
  const findings = stateValue(
    session,
    'install',
    'findings',
    isFindings,
    FINDINGS_SHAPE,
    'the findings recorded so far',
  )
  setFindings(session, [...findings.filter((each) => !equal(each.path, finding.path)), finding])
}

/** A verb on the tree that `detect` finds now. A failed `detect` is the failure of the verb. */
export const onTree = <T>(
  session: Session,
  verb: (tree: Tree<NodeDetection>) => Envelope<T>,
): Envelope<T> => {
  const tree = session.tree()
  return tree.outcome === 'ok' ? verb(tree.value) : tree
}

/** A field that the adapter contract promises, or the failure of the phase. */
export const promised = (
  phase: AuditPhase,
  answer: unknown,
  source: string,
  key: string,
): unknown => {
  const field = promisedFieldOf(answer, source, key)
  return 'detail' in field ? failPhase(phase, field.detail) : field.value
}

/** A non-negative whole number, or null: `jq_int_or_null`. Zero is never a default (#48). */
export const countOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

/** `unreadable_entries` of a map, which must be a non-negative whole number: `map_unreadable`. */
export const mapUnreadable = (phase: AuditPhase, answer: unknown, description: string): number => {
  const value = promised(phase, answer, description, 'unreadable_entries')
  const count = countOrNull(value)
  if (count !== null) return count
  return failPhase(
    phase,
    `${description} reported unreadable_entries '${toText(value)}', which is not a ` +
      'non-negative integer. Treated as anything other than a checked zero, the whole-tree ' +
      'claim is not one (#48).',
  )
}

/** The resolutions of a map, each package with its versions. */
export type Resolutions = Readonly<Record<string, readonly string[]>>

/** `resolutions` of a map, when it is an object whose values are lists of texts. Else null. */
export const resolutionsOf = (answer: unknown): Resolutions | null => {
  const resolutions = isRecord(answer) ? answer.resolutions : undefined
  if (!isRecord(resolutions)) return null
  const lists = Object.values(resolutions).every(
    (versions) => Array.isArray(versions) && versions.every((each) => typeof each === 'string'),
  )
  return lists ? (resolutions as Resolutions) : null
}

/**
 * The versions that a `resolved_versions` answer reports, sorted and each
 * once, or the failure of the phase: `rv_versions`. A parser that found
 * nothing is never read as a package that resolves nothing, because an
 * empty delta is the cue for `removable` (audit-driver.md).
 */
export const resolvedList = (
  phase: AuditPhase,
  answer: unknown,
  source: string,
): { readonly present: boolean; readonly versions: string[] } => {
  const present = promised(phase, answer, source, 'present')
  if (present !== true && present !== false) {
    failPhase(
      phase,
      `${source} answered present '${toText(present)}', which is neither true nor false. Read ` +
        'straight, anything else takes a branch of its own: this flow reads present: false as ' +
        "'the package left the tree', which is its cue for removable.",
    )
  }
  const entries = (answer as Record<string, unknown>).versions
  if (
    !Array.isArray(entries) ||
    !entries.every((entry) => isRecord(entry) && typeof entry.version === 'string')
  ) {
    failPhase(
      phase,
      `${source} answered a versions list this flow cannot read: it is not an array, or an ` +
        'entry carries no version string. A parser that found nothing is never read as a ' +
        'package that resolves nothing; here that reading becomes an empty delta, which is the ' +
        'cue for removable.',
    )
  }
  const versions = uniqueJq(entries.map((entry) => (entry as { version: string }).version))
  if (present && versions.length === 0) {
    failPhase(
      phase,
      `${source} answered present: true with no versions at all. The two disagree, and the ` +
        "empty list is the dangerous half: it makes the delta empty, which this flow reads as 'nothing " +
        "new resolved' and reports removable without a single advisory query.",
    )
  }
  if (!present && versions.length > 0) {
    failPhase(
      phase,
      `${source} answered present: false while reporting versions ${render(versions, null)}. ` +
        "The payload contradicts itself, and present: false is this flow's cue for 'the " +
        "package left the tree entirely', which is a removable verdict.",
    )
  }
  return { present, versions }
}

/**
 * Return the manifest, the workspace file and the lockfile to HEAD, and
 * check that they match HEAD, or end the run: `restore_tree`. `HEAD` is in
 * both commands, so the check cannot agree with a restore from the index
 * (#46). A restore that is not complete ends the run, not the pin.
 */
export const restoreTree = async (session: Session, label: string): Promise<void> => {
  const lockfile = requiredText(session.state, 'lockfile')
  const paths =
    session.overrideFile === 'pnpm-workspace.yaml'
      ? ['package.json', 'pnpm-workspace.yaml', lockfile]
      : ['package.json', lockfile]
  const checkout = await session.git(session.worktree, ['checkout', 'HEAD', '--', ...paths])
  const diff = await session.git(session.worktree, ['diff', '--quiet', 'HEAD', '--', ...paths])
  if (diff.status === 0) return
  const status = await session.git(session.worktree, ['status', '--porcelain', '--', ...paths])
  failPhase(
    'restore',
    `the worktree could not be returned to its pre-pin state after testing ${label}, so every ` +
      'later pin would have been tested against a manifest still carrying this removal. git ' +
      `checkout said: ${outputOf(checkout) || '<nothing>'}. git status --porcelain -- ` +
      `${paths.join(' ')}: ${outputOf(status)}`,
  )
}

/** The fields of a finding that no step has judged yet. */
export const UNJUDGED = {
  sibling_pins: [],
  collateral_changes: null,
  collateral_verdict: null,
  advisory_verdict: null,
  advisory_count: null,
  matched_ranges: [],
} as const satisfies JsonObject

/** A finding for a pin that was not tested to the end. */
export const inconclusive = (
  pin: OrderedPin,
  tested: boolean,
  detail: string,
  reason: string,
): JsonObject => ({
  ...pin,
  status: 'inconclusive',
  tested,
  detail,
  collateral_not_checked_reason: reason,
  resolved_with_pin: null,
  resolved_without_pin: null,
  attributable_versions: null,
  ...UNJUDGED,
})

/** jq's `.[]`: the entries of a list, or the values of an object. jq stops on any other value. */
export const jqValues = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (isRecord(value)) return Object.values(value)
  throw new Error(`Cannot iterate over ${jqType(value)}`)
}

/** jq's `length`. jq stops on a boolean. */
export const jqLength = (value: unknown): number => {
  if (value === null) return 0
  if (typeof value === 'boolean') throw new Error('boolean has no length')
  if (typeof value === 'number') return Math.abs(value)
  if (typeof value === 'string') return [...value].length
  return jqValues(value).length
}

/**
 * jq's `join`: null is empty, a number or a boolean is its JSON text. jq
 * stops on a list or an object inside.
 */
export const jqJoin = (value: unknown, separator: string): string =>
  jqValues(value)
    .map((each) => {
      if (each === null) return ''
      if (typeof each === 'string') return each
      if (typeof each === 'object') throw new Error(`cannot join a ${jqType(each)}`)
      return JSON.stringify(each)
    })
    .join(separator)

/**
 * The text that `$(jq -r ...)` gives: a text as it is, and another value as
 * JSON. jq writes a list or an object over lines, with an indent of two.
 * `$( )` removes the line breaks at the end.
 */
export const rawText = (value: unknown): string =>
  (typeof value === 'string' ? value : render(value, '  ')).replace(/\n+$/, '')

/**
 * The lines that `jq -r '.[]'` gives a `while read` loop: each value as
 * `rawText` gives it, cut at each line break, with each empty line skipped.
 */
export const linesOf = (values: readonly unknown[]): string[] =>
  values.flatMap((value) => rawText(value).split('\n')).filter((line) => line !== '')

/** The text of a jq program whose error the bash does not check: empty, as `$( )` gives it. */
export const orEmpty = (text: () => string): string => {
  try {
    return text()
  } catch {
    return ''
  }
}
