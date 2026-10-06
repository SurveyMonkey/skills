// The inputs of the PR renderer, read and checked (#233). `render-pr.sh`
// read two JSON files with jq, and rendered from them. It checked a field
// with `require_field`, and a field of a wrong type could still reach the
// text: `jq -r` printed a number, an object or `null` as text. Here each
// field is read as the type that the contract promises, or the read fails
// with a message that names the file and the field. Nothing is rendered from
// a field that this file did not read, and nothing is read as a default.
//
// The checks run in the order that the script ran them, so a state that has
// two defects gives the same first message as before. Every check runs
// before the first byte of a body is made, so a failure never leaves part of
// a body (the script printed a body, and then `{"error": ...}`).
//
// Declared differences from the script, each with #233:
//   - A field has the type that the contract promises. The script printed a
//     number for a text field, and the text of an unknown `action` or
//     `bare_override`. A value of another type is refused here, in `body`
//     and `commit-msg` alike.
//   - An alert id or a severity that is the empty text is refused. The
//     script shifted the columns of the alerts table for it.
//   - `epss_percentile` is a number from 0 to 1, a fraction. The script
//     printed any number as a percentage.
//   - A `summary` that is not text is refused. The script stopped in the
//     middle of the body, after it had printed the first sections.
//   - `commit-msg` checks `major_line` as `body` does.
//   - The range of a bare override is the value of the first top-level entry
//     of `written[]` that has a text value. The script read `.value` of the
//     first top-level entry, whatever its type, and printed `null` for a
//     value that is not there.
//   - A `requires_major_bump` version that names no major line is refused.
//     The script printed `no patched release in the .x line`.
//   - A moves `major` is text or a number, and a `before` or `after` is a
//     list of texts.
//   - A `requires_major_bump` or a `vulnerable_ranges` that is `false` is
//     refused. The script read `false` as the empty list, with `// []`.
//
// This file ships. It imports nothing outside the plugin.

import { type Envelope, failed, ok } from '../lib/envelope.ts'
import { DASH, shown } from './markdown.ts'

/** The actions of the fix driver that a PR can follow. */
const ACTIONS = ['direct-update', 'scoped-override', 'bare-override', 'lockfile-refresh'] as const
export type Action = (typeof ACTIONS)[number]

const BARE_OVERRIDES = ['none', 'added', 'tightened'] as const
export type BareOverride = (typeof BARE_OVERRIDES)[number]

type Rec = Record<string, unknown>

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

/** A value as `jq -r` printed it for a message: text as it is, and JSON otherwise. */
const describe = (value: unknown): string => (isText(value) ? value : JSON.stringify(value))

/** The names of the two files, for the messages. */
export interface Files {
  readonly state: string
  readonly group: string
}

/** The text of one required note, or nothing when the caller gave none. */
export interface Notes {
  readonly override: string | undefined
  readonly collateral: string | undefined
}

const missing = (where: string, path: string): Envelope<never> =>
  failed(
    `${where} has no usable '.${path}'. The driver's contract promises this field; an absent or null value here is never rendered as a default.`,
  )

const wrongType = (where: string, path: string, expected: string): Envelope<never> =>
  failed(
    `${where} has a '.${path}' that is not ${expected}. The driver's contract promises ${expected}; a value of another type is never rendered as text.`,
  )

/** The value at a path, or `undefined` when a step of it is not an object. */
const at = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), root)

/** A field that the contract promises: there, not null, and of the type. */
const required = <T>(
  root: unknown,
  path: string,
  where: string,
  expected: string,
  accepts: (value: unknown) => value is T,
): Envelope<T> => {
  const value = at(root, path)
  if (value === undefined || value === null) return missing(where, path)
  return accepts(value) ? ok(value) : wrongType(where, path, expected)
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isArray = (value: unknown): value is unknown[] => Array.isArray(value)

/** The checks that open each verb: both inputs are JSON objects. */
const objects = (
  verb: string,
  state: unknown,
  group: unknown,
  files: Files,
): Envelope<{ state: Rec; group: Rec }> => {
  if (!isRecord(state)) {
    return failed(`${verb}: --state ${files.state} is not readable JSON, or not a JSON object.`)
  }
  if (!isRecord(group)) {
    return failed(
      `${verb}: --group-json ${files.group} is not readable JSON, or not a JSON object.`,
    )
  }
  return ok({ state, group })
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/** What a commit message needs of one alert. */
export interface CommitAlert {
  readonly number: number
  /** The id of the table and the commit message: the CVE, or else the GHSA. */
  readonly id: string
  /** The id of the not-fixed table: the GHSA, or else the CVE. */
  readonly ghsaFirst: string
  readonly severity: string
}

/** What the body needs of one alert, beside {@link CommitAlert}. */
export interface BodyAlert extends CommitAlert {
  readonly summary: string
  readonly epss: number
  /** The range of the alert, or null. Read only for the not-fixed table. */
  readonly vulnerableRange: string | null
  /** The alert has the `cve`, `ghsa` and `vulnerable_range` keys, in their types. */
  readonly hasRangeKeys: boolean
}

/** An id: text that is not empty, or null for an absent or null id. `undefined` is a wrong type. */
const identifier = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return null
  return isText(value) && value !== '' ? value : undefined
}

const readCommitAlert = (raw: unknown): CommitAlert | null => {
  if (!isRecord(raw)) return null
  const cve = identifier(raw.cve)
  const ghsa = identifier(raw.ghsa)
  if (cve === undefined || ghsa === undefined) return null
  const id = cve ?? ghsa
  if (id === null) return null
  const { number, severity } = raw
  if (typeof number !== 'number' || !Number.isInteger(number)) return null
  if (!isText(severity) || severity === '') return null
  return { number, id, ghsaFirst: ghsa ?? id, severity }
}

/** The text of an optional text field: absent and null are nothing, and another type is `undefined`. */
const optionalText = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return null
  return isText(value) ? value : undefined
}

const readBodyAlert = (raw: unknown): BodyAlert | null => {
  const base = readCommitAlert(raw)
  if (base === null) return null
  const alert = raw as Rec
  const epss = alert.epss_percentile
  if (typeof epss !== 'number' || epss < 0 || epss > 1) return null
  // An absent or null summary is the empty text, as `.summary // ""` was.
  const summary = optionalText(alert.summary)
  if (summary === undefined) return null
  const range = alert.vulnerable_range
  return {
    ...base,
    summary: summary ?? '',
    epss,
    vulnerableRange: isText(range) ? range : null,
    hasRangeKeys:
      Object.hasOwn(alert, 'cve') &&
      Object.hasOwn(alert, 'ghsa') &&
      Object.hasOwn(alert, 'vulnerable_range') &&
      (range === null || isText(range)),
  }
}

/** The alerts of the group, or the message for an empty list or a bad alert. */
const readAlerts = <T>(
  group: Rec,
  read: (raw: unknown) => T | null,
  emptyMessage: string,
  alertMessage: string,
): Envelope<T[]> => {
  const raw = group.alerts
  if (!Array.isArray(raw) || raw.length === 0) return failed(emptyMessage)
  const alerts: T[] = []
  for (const entry of raw) {
    const alert = read(entry)
    if (alert === null) return failed(alertMessage)
    alerts.push(alert)
  }
  return ok(alerts)
}

/** `major_line`, as text: a plain non-negative integer, as a number or as text. */
const readMajorLine = (group: Rec, message: string): Envelope<string> => {
  const raw = group.major_line
  const text = typeof raw === 'number' ? String(raw) : raw
  return isText(text) && /^[0-9]+$/.test(text) ? ok(text) : failed(message)
}

/** The three fields that name the package and its fix. */
interface PackageFacts {
  readonly package: string
  readonly majorLine: string
  readonly highestFixedVersion: string
}

const readPackage = (group: Rec, where: string, majorMessage: string): Envelope<PackageFacts> => {
  const name = required(group, 'package', where, 'text', isText)
  if (name.outcome !== 'ok') return name
  // The text check of `major_line` is the third: the script asked for the
  // presence of the three fields first, and for the format of one later.
  if (group.major_line === undefined || group.major_line === null) {
    return missing(where, 'major_line')
  }
  const version = required(group, 'highest_fixed_version', where, 'text', isText)
  if (version.outcome !== 'ok') return version
  const majorLine = readMajorLine(group, majorMessage)
  if (majorLine.outcome !== 'ok') return majorLine
  return ok({
    package: shown(name.value),
    majorLine: shown(majorLine.value),
    highestFixedVersion: shown(version.value),
  })
}

// ---------------------------------------------------------------------------
// commit-msg
// ---------------------------------------------------------------------------

export interface CommitInputs extends PackageFacts {
  readonly alerts: readonly CommitAlert[]
  /** `Direct update`, `Scoped override` or `Bare override`. */
  readonly kind: string
  /** The file that holds the fix. */
  readonly location: string
}

const KINDS: Readonly<Record<string, string>> = {
  'direct-update': 'Direct update',
  'scoped-override': 'Scoped override',
  'bare-override': 'Bare override',
}

export const readCommitInputs = (
  stateJson: unknown,
  groupJson: unknown,
  files: Files,
): Envelope<CommitInputs> => {
  const roots = objects('commit-msg', stateJson, groupJson, files)
  if (roots.outcome !== 'ok') return roots
  const { state, group } = roots.value
  const groupFile = `--group-json ${files.group}`
  const alerts = readAlerts(
    group,
    readCommitAlert,
    `commit-msg: ${groupFile} carries no non-empty alerts[]. A dispatched group is never empty; rendering a count and an alert list from zero alerts is a false claim, not a legitimate empty state.`,
    `commit-msg: ${groupFile} has an alert missing 'number', both of 'cve' and 'ghsa', or 'severity'. Every alert line and Refs: trailer needs all three.`,
  )
  if (alerts.outcome !== 'ok') return alerts

  const stateWhere = `commit-msg: --state ${files.state}`
  const raw = at(state, 'action')
  if (raw === undefined || raw === null) return missing(stateWhere, 'action')
  if (raw === 'lockfile-refresh') {
    return failed(
      `commit-msg: action is lockfile-refresh ${DASH} there is nothing to commit beyond phase 3's drift commit, which is already on the branch. Skip straight to push.`,
    )
  }
  const name = describe(raw)
  const kind = Object.hasOwn(KINDS, name) ? KINDS[name] : undefined
  if (kind === undefined) return failed(`commit-msg: unrecognized action '${name}'`)

  let location = 'package.json'
  if (raw !== 'direct-update') {
    const file = required(state, 'override_file', `${stateWhere} (action '${raw}')`, 'text', isText)
    if (file.outcome !== 'ok') return file
    location = shown(file.value)
  }

  const facts = readPackage(
    group,
    `commit-msg: ${groupFile}`,
    `commit-msg: ${groupFile}'s major_line is not a plain non-negative integer, as a number or a string.`,
  )
  if (facts.outcome !== 'ok') return facts
  return ok({ ...facts.value, alerts: alerts.value, kind, location })
}

// ---------------------------------------------------------------------------
// body
// ---------------------------------------------------------------------------

/** One move of another major line. */
export interface Move {
  readonly major: string
  readonly before: readonly string[]
  readonly after: readonly string[]
}

/** The `other_line_moves` of the state, as the body tells them. */
export type Moves =
  | { readonly kind: 'no-baseline' }
  | { readonly kind: 'clean' }
  | { readonly kind: 'benign' | 'fatal'; readonly moves: readonly Move[] }

/** One copy that no patched release of its line fixes. */
export interface Bump {
  readonly version: string
  readonly path: string
  readonly major: string
  readonly ranges: readonly unknown[]
}

/** The facts of a bare override. */
export interface GlobalOverride {
  readonly verb: 'Added' | 'Tightened'
  readonly range: string
  readonly appliedParents: readonly string[]
  readonly resolvedVersions: readonly string[]
  readonly note: string
}

export interface BodyInputs extends PackageFacts {
  readonly alerts: readonly BodyAlert[]
  readonly action: Action
  readonly resolvedVersion: string
  readonly drift: boolean
  readonly riskMarkdown: string
  readonly whyRaw: string
  readonly checked: number
  /** The version on the line before the fix, or null for none. */
  readonly before: string | null
  /** What `apply` wrote. A lockfile refresh reads it only for the range of a bare override. */
  readonly written: readonly unknown[]
  readonly overrideFile: string | null
  readonly globalOverride: GlobalOverride | null
  readonly bumps: readonly Bump[]
  readonly moves: Moves
  /** The note that a fatal move needs, when the caller gave it. */
  readonly collateralNote: string | undefined
}

/** A list that may be absent or null, as `// []` read it, and whose entries are all text. */
const textList = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) return []
  return isArray(value) && value.every(isText) ? value : undefined
}

/** An entry of `written[]` with no parent and a text value: it holds the range of a bare override. */
const isTopLevel = (entry: Rec): entry is Rec & { value: string } =>
  (entry.parent ?? null) === null && isText(entry.value)

/** A list of texts: the shape of the `before` and `after` of one move. */
const isTextArray = (value: unknown): value is string[] => isArray(value) && value.every(isText)

const readMoves = (state: Rec, message: string): Envelope<Moves> => {
  const raw = state.other_line_moves
  if (raw === null) return ok({ kind: 'no-baseline' })
  if (!Array.isArray(raw)) return failed(message)
  if (raw.length === 0) return ok({ kind: 'clean' })
  const moves: Move[] = []
  let fatal = false
  for (const entry of raw) {
    if (!isRecord(entry)) return failed(message)
    const { class: kind, major, before, after } = entry
    if (kind !== 'fatal' && kind !== 'benign_dedup') return failed(message)
    if (typeof major !== 'string' && typeof major !== 'number') return failed(message)
    if (!isTextArray(before) || !isTextArray(after)) return failed(message)
    fatal ||= kind === 'fatal'
    moves.push({ major: String(major), before, after })
  }
  return ok({ kind: fatal ? 'fatal' : 'benign', moves })
}

/** The major of a version, as `major_of` read it: no `v` or `=` prefix, and the leading digits. */
const majorOf = (version: string): string => version.replace(/^[vV=]*/, '').replace(/[^0-9].*$/, '')

const readBumps = (state: Rec, files: Files): Envelope<Bump[]> => {
  const raw = state.requires_major_bump ?? []
  if (!Array.isArray(raw)) {
    return failed(`body: --state ${files.state}'s requires_major_bump is not an array.`)
  }
  const bumps: Bump[] = []
  for (const entry of raw) {
    const ranges = isRecord(entry) ? (entry.vulnerable_ranges ?? []) : undefined
    if (
      !isRecord(entry) ||
      !isText(entry.version) ||
      !isText(entry.path) ||
      !Array.isArray(ranges)
    ) {
      return failed(
        `body: --state ${files.state} has a requires_major_bump entry missing 'version' or 'path' as a string, or an unreadable vulnerable_ranges[]. Rendering the table's header with no rows from this would read as "nothing left open" ${DASH} the opposite of the truth ${DASH} so nothing is rendered instead.`,
      )
    }
    const major = majorOf(shown(entry.version))
    if (major === '') {
      return failed(
        `body: --state ${files.state} has a requires_major_bump entry whose version '${shown(entry.version)}' names no major line, so its row cannot say which line has no patched release.`,
      )
    }
    bumps.push({ version: entry.version, path: entry.path, major, ranges })
  }
  return ok(bumps)
}

export const readBodyInputs = (
  stateJson: unknown,
  groupJson: unknown,
  files: Files,
  notes: Notes,
): Envelope<BodyInputs> => {
  const roots = objects('body', stateJson, groupJson, files)
  if (roots.outcome !== 'ok') return roots
  const { state, group } = roots.value
  const groupFile = `--group-json ${files.group}`
  const stateFile = `--state ${files.state}`
  const alerts = readAlerts(
    group,
    readBodyAlert,
    `body: ${groupFile} carries no non-empty alerts[]. A dispatched group is never empty; a Summary and an Alerts resolved table rendered from zero alerts is a false claim, not a legitimate empty state.`,
    `body: ${groupFile} has an alert missing 'number', both of 'cve' and 'ghsa', 'severity', or a numeric 'epss_percentile'. Every alerts-table row and Refs: line needs all four.`,
  )
  if (alerts.outcome !== 'ok') return alerts

  const where = `body: ${stateFile}`
  const actionText = required(state, 'action', where, 'text', isText)
  if (actionText.outcome !== 'ok') return actionText
  const resolved = required(state, 'resolved_version', where, 'text', isText)
  if (resolved.outcome !== 'ok') return resolved
  const drift = required(state, 'drift_commit', where, 'true or false', isBoolean)
  if (drift.outcome !== 'ok') return drift
  const bare = required(
    state,
    'bare_override',
    where,
    'one of none, added or tightened',
    (value): value is BareOverride => BARE_OVERRIDES.includes(value as BareOverride),
  )
  if (bare.outcome !== 'ok') return bare
  const risk = required(state, 'risk.markdown', where, 'text', isText)
  if (risk.outcome !== 'ok') return risk
  const why = required(state, 'why_raw', where, 'text', isText)
  if (why.outcome !== 'ok') return why
  const checked = required(
    state,
    'validate.checked',
    where,
    'a whole number',
    (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0,
  )
  if (checked.outcome !== 'ok') return checked
  // `other_line_moves` and `before` may be null, and that is a real answer.
  // Only the absence of the key is a violation.
  if (!Object.hasOwn(state, 'other_line_moves')) {
    return failed(
      `body: ${stateFile} has no 'other_line_moves' key at all. \`null\` there is a real, checked answer (no baseline was available); an absent key is not, and rendering the null-case text for it would be a specific factual claim made from a hole in the data.`,
    )
  }
  if (!Object.hasOwn(state, 'before')) {
    return failed(
      `body: ${stateFile} has no 'before' key at all. \`null\` there is a real, checked answer (nothing to report pre-fix on this line); an absent key is not.`,
    )
  }

  const facts = readPackage(
    group,
    `body: ${groupFile}`,
    `body: ${groupFile}'s major_line is not a plain non-negative integer, as a number or a string.`,
  )
  if (facts.outcome !== 'ok') return facts

  const action = actionText.value
  if (!ACTIONS.includes(action as Action)) {
    return failed(`body: unrecognized action '${action}'`)
  }
  const before = optionalText(state.before)
  if (before === undefined) return wrongType(where, 'before', 'text or null')
  const moves = readMoves(
    state,
    `body: ${stateFile}'s other_line_moves does not parse as an array of {class: fatal|benign_dedup, major, before: [], after: []} entries.`,
  )
  if (moves.outcome !== 'ok') return moves

  // Every required note is checked before anything is made.
  if (bare.value !== 'none' && notes.override === undefined) {
    return failed(
      `body: bare_override is '${bare.value}', so the PR needs a ## Global override section, and its reasoning (why no scoped form covered every path, and which resolved copies it pins) is evidence only the agent has. Pass --global-override-note <file>.`,
    )
  }
  if (moves.value.kind === 'fatal' && notes.collateral === undefined) {
    return failed(
      'body: other_line_moves carries a fatal entry, which only happens on a human re-dispatch, and the narrative explaining why the move was accepted is evidence only the agent has. Pass --collateral-note <file>.',
    )
  }
  if (checked.value === 0) {
    return failed(
      `body: ${stateFile} reports validate.checked: 0. Zero resolved versions checked on the ${facts.value.majorLine}.x line is never a legitimate 'Lockfile validated' claim, whether the field was genuinely zero or silently defaulted from an absent one.`,
    )
  }

  const actionWhere = `${where} (action '${action}')`
  // A lockfile refresh does not need `written`. A bare override still reads
  // its range from it, as `.written[]?` of the script did.
  let written: unknown[] = isArray(state.written) ? state.written : []
  if (action !== 'lockfile-refresh') {
    const found = required(state, 'written', actionWhere, 'a list', isArray)
    if (found.outcome !== 'ok') return found
    written = found.value
  }
  let overrideFile: string | null = null
  if (action === 'scoped-override' || action === 'bare-override') {
    const file = required(state, 'override_file', actionWhere, 'text', isText)
    if (file.outcome !== 'ok') return file
    overrideFile = shown(file.value)
  } else {
    const file = optionalText(state.override_file)
    if (file === undefined) return wrongType(where, 'override_file', 'text')
    overrideFile = file === null ? null : shown(file)
  }

  let globalOverride: GlobalOverride | null = null
  if (bare.value !== 'none') {
    // The range is the value of the first top-level entry (no parent) that
    // has a text value. An entry that is not an object is a state that
    // contradicts itself. For `jq`, a number or a text was an error too. A
    // null entry passed, and the script printed `null` as the range. Here a
    // null entry is refused (#233).
    const top = written.every(isRecord) ? written.find(isTopLevel) : undefined
    if (top === undefined) {
      return failed(
        `body: bare_override is '${bare.value}' but ${stateFile}'s written[] carries no top-level (parent: null) entry with a string value to report the range from. The state file contradicts its own classification; nothing is rendered rather than a fabricated range.`,
      )
    }
    const appliedParents = textList(state.applied_parents)
    if (appliedParents === undefined) {
      return failed(`body: ${stateFile}'s applied_parents is not an array of strings.`)
    }
    const resolvedVersions = textList(at(state, 'validate.resolved_versions'))
    if (resolvedVersions === undefined) {
      return failed(`body: ${stateFile}'s validate.resolved_versions is not an array of strings.`)
    }
    globalOverride = {
      verb: bare.value === 'added' ? 'Added' : 'Tightened',
      range: shown(top.value),
      appliedParents,
      resolvedVersions,
      note: notes.override as string,
    }
  }

  const bumps = readBumps(state, files)
  if (bumps.outcome !== 'ok') return bumps
  if (bumps.value.length > 0 && !alerts.value.every((alert) => alert.hasRangeKeys)) {
    return failed(
      `body: ${groupFile} has an alert missing 'vulnerable_range', 'ghsa' or 'cve', needed to say which alerts stay open in the Not-fixed-by-this-PR table.`,
    )
  }

  return ok({
    ...facts.value,
    alerts: alerts.value,
    action: action as Action,
    resolvedVersion: shown(resolved.value),
    drift: drift.value,
    riskMarkdown: risk.value,
    whyRaw: why.value,
    checked: checked.value,
    // An empty `before` is no version, as `[ -n "$before" ]` read it.
    before: before === null || before === '' ? null : shown(before),
    written,
    overrideFile,
    globalOverride,
    bumps: bumps.value,
    moves: moves.value,
    collateralNote: notes.collateral,
  })
}
