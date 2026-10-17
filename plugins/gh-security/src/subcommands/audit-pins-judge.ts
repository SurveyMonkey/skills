// `audit-pins judge`: phase 5, the port of `cmd_judge` and `advisory_for` in
// `scripts/common/audit-pins-driver.sh`. It asks the advisory database about
// each version that a removal let in, and about each version of another
// package that moved with it. Then it gives each tested pin its verdict, and
// applies the sibling rule. The contract is in the header of `audit-pins.ts`.
//
// The verdict table of `check-advisories`:
//   safe          -> removable
//   vulnerable    -> still-required, with the ranges that matched
//   unknown       -> inconclusive, with the range that could not be read
//   no-advisories -> inconclusive
// `no-advisories` is not `safe`. A pin can exist for a reason that is not an
// advisory, and a wrong name or ecosystem gives the same empty answer.
//
// Each value of the state is read as jq reads it in the bash. Where jq stops,
// the port stops with the same answer.
//
// This file ships. It imports nothing outside the plugin.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { equal, or, render, toText } from '../adapters/node/jq-json.ts'
import { isRecord } from '../adapters/node/manifest.ts'
import type { CommandResult } from '../cli/command.ts'
import { fieldOf, uniqueJq } from '../jq.ts'
import { parseArguments } from '../lib/args.ts'
import { type Envelope, exitCodeFor, type JsonObject, type JsonValue } from '../lib/envelope.ts'
import { readOptionalValue } from '../state.ts'
import {
  type AuditPinsDeps,
  die,
  FINDINGS_SHAPE,
  failPhase,
  isFindings,
  jqJoin,
  jqLength,
  jqValues,
  linesOf,
  loadSession,
  orEmpty,
  type Session,
  setFindings,
  setKey,
  settle,
  stateValue,
  stop,
} from './audit-pins-common.ts'
import { checkAdvisories } from './check-advisories.ts'

const VERDICTS: readonly string[] = ['safe', 'vulnerable', 'unknown', 'no-advisories']

const FIELDS = [
  'verdict',
  'advisory_count',
  'matched_ranges',
  'unevaluated_ranges',
  'adapter_errors',
] as const

/** An advisory answer that has all five fields, with a verdict of the four. */
export type Advisory = JsonObject & { readonly verdict: string }

/**
 * Each field that a caller reads from an advisory answer, on each route to
 * it: `advisory_validate`. `quote` is the end of the first detail, which
 * quotes the stderr of a fresh query.
 */
const validated = (
  value: unknown,
  pkg: string,
  version: string,
  source: string,
  quote: string,
): Advisory => {
  if (!isRecord(value)) {
    failPhase(
      'advisories',
      `${source} for ${pkg} ${version} is not a JSON object. A script that cannot answer exits ` +
        `non-zero; answering with nothing lets every check below be skipped rather than failed.${quote}`,
    )
  }
  for (const field of FIELDS) {
    if (!Object.hasOwn(value, field)) {
      failPhase(
        'advisories',
        `${source} for ${pkg} ${version} carries no '${field}'. The output contract promises all ` +
          'five fields this driver reads; read straight, an absent one arrives as the string "null" ' +
          "and takes a branch of its own instead of failing \u2014 and for 'adapter_errors' that " +
          'branch is the test standing between a broken adapter and an audit of inconclusive ' +
          'verdicts with nothing naming the cause.',
      )
    }
  }
  const verdict = value.verdict
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) {
    failPhase(
      'advisories',
      `${source} answered verdict '${toText(verdict)}' for ${pkg} ${version}, which is not one of ` +
        'safe, vulnerable, unknown or no-advisories. Anything else falls through every verdict ' +
        'test into the last arm, and the last arm cannot be allowed to be a default.',
    )
  }
  return value as Advisory
}

/** The text of a cache file, or empty when it cannot be read, as `$(cat)` gives it. */
const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** One JSON text, or undefined for a text that is not one. */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The advisory answer for one version of one package: `advisory_for`. The
 * answer is cached for each package and version under `<work>/advisories/`,
 * because a version can be in the delta of several pins. A later call reads
 * the cache, so the cache goes through the same checks as a fresh answer.
 * A failed query is never read as no advisories.
 */
export const advisoryFor = async (
  session: Session,
  deps: AuditPinsDeps,
  pkg: string,
  version: string,
): Promise<Advisory> => {
  const directory = join(session.work, 'advisories')
  const cache = join(directory, `${`${pkg}@${version}`.replaceAll('/', '-')}.json`)
  if (statSync(cache, { throwIfNoEntry: false })?.isFile() === true) {
    return validated(
      parsed(readText(cache)),
      pkg,
      version,
      `the cached advisory answer at ${cache}`,
      '',
    )
  }
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    die(`cannot create ${directory}`)
  }
  const prefix = session.prefix === null ? [] : ['--env-prefix', session.prefix]
  const answer = (await checkAdvisories(
    {
      args: ['--ecosystem', session.ecosystem, '--version', version, ...prefix, '--', pkg],
      env: session.env,
      io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
      commandNames: [],
    },
    deps.makeClient,
    deps.spawn,
    deps.route,
  )) as Envelope<JsonValue>
  if (answer.outcome !== 'ok') {
    failPhase(
      'advisories',
      `check-advisories exited ${exitCodeFor(answer)} for ${pkg} ${version}, so there is no ` +
        'verdict for it. A failed query is never read as an absence of advisories. Quoting it: ' +
        render({ error: answer.error }, null),
    )
  }
  const advisory = validated(
    answer.value,
    pkg,
    version,
    'check-advisories',
    ' Quoting stderr: <none>',
  )
  const errors = advisory.adapter_errors as JsonValue[]
  // `unknown` with adapter errors describes the tooling, not the package,
  // and each pin after this one would have the same broken adapter.
  if (advisory.verdict === 'unknown' && errors.length !== 0) {
    failPhase(
      'advisories',
      `check-advisories answered 'unknown' for ${pkg} ${version} with a non-empty ` +
        `adapter_errors[], which describes the tooling and not the package: ${render(errors, null)}. ` +
        'Every pin after this one would inherit the same broken adapter.',
    )
  }
  // A temporary file, then a rename, as the state file is written: a torn
  // write would leave half an object for the next call to read.
  try {
    writeFileSync(`${cache}.tmp`, render(advisory, '  '))
  } catch {
    die(`cannot write ${cache}.tmp`)
  }
  try {
    renameSync(`${cache}.tmp`, cache)
  } catch {
    die(`cannot replace ${cache}`)
  }
  return advisory
}

/** A finding as `judge` reads it. Each field can be any JSON value. */
type Finding = JsonObject

/** The fields that one version of the tested package gives the finding. */
interface VersionVerdict extends JsonObject {
  readonly version: string
  readonly verdict: string
  readonly advisory_count: JsonValue
  readonly matched_ranges: JsonValue
  readonly unevaluated_ranges: JsonValue
}

const LEFT_TREE =
  'the package is no longer resolved at all: this pin was the only thing holding it in the tree, so there is no newly resolved version to judge'

const EMPTY_DELTA =
  'nothing new resolved: removing the entry changes nothing observable in this manifest as it stands, which is what a sibling pin on the same package, or an ordinary dependency range, holding the tree looks like. No version was judged against the advisory database, because none appeared'

const NO_VIEW = "no whole-tree view was available, so no other package's resolution was re-checked"

/** The detail of the versions of the tested package. jq gives empty text where it stops. */
const detailOf = (verdicts: readonly VersionVerdict[]): string =>
  orEmpty(() =>
    verdicts
      .map(
        (each) =>
          `${each.version}: ${each.verdict}` +
          (jqLength(each.matched_ranges) > 0 ? ` (${jqJoin(each.matched_ranges, '; ')})` : '') +
          (jqLength(each.unevaluated_ranges) > 0
            ? ` [unreadable range: ${jqJoin(each.unevaluated_ranges, '; ')}]`
            : ''),
      )
      .join(', '),
  )

/** The own verdict of the tested package, and the status it gives the pin. */
interface Own {
  readonly status: string
  readonly verdict: JsonValue
  readonly count: JsonValue
  readonly matched: JsonValue[]
  readonly detail: string
  readonly finding: Finding
}

const ownVerdict = async (
  session: Session,
  deps: AuditPinsDeps,
  finding: Finding,
  pkg: string,
): Promise<Own> => {
  const left = finding.left_tree === true || finding.left_tree === 'true'
  const delta = finding.attributable_versions as string[]
  const quiet = { verdict: null, count: null, matched: [], finding }
  if (left) return { ...quiet, status: 'removable', detail: LEFT_TREE }
  if (delta.length === 0) return { ...quiet, status: 'removable', detail: EMPTY_DELTA }
  const verdicts: VersionVerdict[] = []
  for (const version of linesOf(delta)) {
    const answer = await advisoryFor(session, deps, pkg, version)
    verdicts.push({
      version,
      verdict: answer.verdict,
      advisory_count: answer.advisory_count as JsonValue,
      matched_ranges: answer.matched_ranges as JsonValue,
      unevaluated_ranges: answer.unevaluated_ranges as JsonValue,
    })
  }
  const any = (verdict: string) => verdicts.some((each) => each.verdict === verdict)
  // Removable only when each version is safe. There is no partial removal.
  const status = any('vulnerable')
    ? 'still-required'
    : verdicts.every((each) => each.verdict === 'safe')
      ? 'removable'
      : 'inconclusive'
  // One of the four words of `check-advisories`: the least sure answer.
  const verdict = any('vulnerable')
    ? 'vulnerable'
    : any('unknown')
      ? 'unknown'
      : any('no-advisories')
        ? 'no-advisories'
        : 'safe'
  let matched: JsonValue[] = []
  try {
    matched = uniqueJq(verdicts.flatMap((each) => jqValues(each.matched_ranges) as JsonValue[]))
  } catch {
    failPhase(
      'advisories',
      `the matched ranges for ${pkg} could not be read back out of the per-version answers: ${render(verdicts, null)}`,
    )
  }
  return {
    status,
    verdict,
    // The count of the package does not change with the version, so the
    // first answer is the count as it was given.
    count: verdicts[0]?.advisory_count ?? null,
    matched,
    detail: detailOf(verdicts),
    finding: { ...finding, advisory_versions: verdicts },
  }
}

/** The verdict of the other packages that moved, and the text that it adds. */
const collateralVerdict = async (
  session: Session,
  deps: AuditPinsDeps,
  own: Own,
  pkg: string,
): Promise<{ readonly verdict: string; readonly finding: Finding; readonly detail: string }> => {
  const finding = own.finding
  const recorded = finding.collateral_verdict ?? null
  if (recorded === 'not-checked' || recorded === '"not-checked"') {
    // The reason travels with the finding: an adapter with no map and a
    // parser that refused the lockfile read the same here otherwise.
    const reason = toText(or(finding.collateral_not_checked_reason ?? null, NO_VIEW))
    return {
      verdict: 'not-checked',
      finding,
      detail: `${own.detail}. the verdict covers ${pkg} only: ${reason}`,
    }
  }
  const changes = (finding.collateral_changes ?? []) as JsonObject[]
  if (changes.length === 0) return { verdict: 'none', finding, detail: own.detail }
  const verdicts: JsonObject[] = []
  let judged = 0
  for (const entry of changes) {
    if (entry.judged !== true) continue
    judged += 1
    // Each version is judged under the name of its own package.
    const name = entry.package as string
    for (const version of linesOf(entry.newly_admitted as JsonValue[])) {
      const answer = await advisoryFor(session, deps, name, version)
      verdicts.push({
        package: name,
        version,
        verdict: answer.verdict,
        matched_ranges: answer.matched_ranges as JsonValue,
      })
    }
  }
  // An empty list of verdicts reads as safe, so a list where nothing was
  // judged is a broken record, not a clean tree.
  if (judged === 0) {
    failPhase(
      'advisories',
      `the collateral list for ${pkg} carries ${changes.length} entr(ies) and not one of them is ` +
        'marked judged, so nothing in the tree was checked. An empty verdict list would collapse ' +
        "to 'safe' here, which is the strongest claim available about packages nobody looked at.",
    )
  }
  const each = (verdict: string) => verdicts.filter((entry) => entry.verdict === verdict)
  let verdict = 'inconclusive'
  if (verdicts.length === 0) verdict = 'safe'
  else if (each('vulnerable').length > 0) verdict = 'vulnerable'
  else if (each('safe').length === verdicts.length) {
    try {
      verdict = jqLength(or(finding.sampled_families ?? null, [])) > 0 ? 'sampled-family' : 'safe'
    } catch {
      failPhase(
        'advisories',
        `the collateral verdict for ${pkg} could not be collapsed out of ${render(verdicts, null)}`,
      )
    }
  }
  const next = { ...finding, collateral_verdicts: verdicts }
  if (verdict === 'vulnerable') {
    const named = each('vulnerable')
      .map((entry) => `${entry.package} ${entry.version}`)
      .join(', ')
    return {
      verdict,
      finding: next,
      detail:
        `this pin is not required for ${pkg}; it is required because removing it newly admits ` +
        `${named} elsewhere in the tree, which a published advisory range admits`,
    }
  }
  if (verdict === 'inconclusive') {
    const named = verdicts
      .filter((entry) => entry.verdict !== 'safe')
      .map((entry) => `${entry.package} ${entry.version}: ${entry.verdict}`)
      .join(', ')
    return {
      verdict,
      finding: next,
      detail: `${own.detail}; a package whose resolution moved with this removal could not be cleared: ${named}`,
    }
  }
  return { verdict, finding: next, detail: own.detail }
}

/** One tested finding, judged. */
const judgeOne = async (
  session: Session,
  deps: AuditPinsDeps,
  finding: Finding,
): Promise<Finding> => {
  const pkg = toText(finding.package ?? null)
  const own = await ownVerdict(session, deps, finding, pkg)
  const collateral = await collateralVerdict(session, deps, own, pkg)
  // A vulnerable collateral makes the pin still-required. An inconclusive
  // one makes it inconclusive, unless it is still-required already.
  const status =
    collateral.verdict === 'vulnerable'
      ? 'still-required'
      : collateral.verdict === 'inconclusive' && own.status !== 'still-required'
        ? 'inconclusive'
        : own.status
  return {
    ...collateral.finding,
    status,
    detail: collateral.detail,
    advisory_verdict: own.verdict,
    advisory_count: own.count,
    matched_ranges: own.matched,
    collateral_verdict: collateral.verdict,
  }
}

const SIBLING_FAILED =
  'judge: the sibling rule could not be applied to the judged findings, so removable-individually was never assigned. Nothing was written.'

/**
 * The sibling rule. One pin at a time proves each pin removable alone, and
 * nothing about a set. Two or more removable pins on one package are
 * `removable-individually`, and `sibling_pins` names the others.
 */
const siblingRule = (findings: readonly Finding[]): Finding[] => {
  const counts = new Map<string, number>()
  for (const finding of findings) {
    if (finding.status !== 'removable') continue
    const pkg = finding.package ?? null
    // jq cannot index an object with a key that is not text.
    if (typeof pkg !== 'string') die(SIBLING_FAILED)
    counts.set(pkg, (counts.get(pkg) ?? 0) + 1)
  }
  return findings.map((finding) => {
    if (finding.status !== 'removable' || (counts.get(finding.package as string) as number) < 2) {
      return finding
    }
    const siblings = findings
      .filter(
        (other) =>
          equal(other.package ?? null, finding.package) &&
          !equal(other.key ?? null, finding.key ?? null) &&
          !equal(other.path ?? null, finding.path ?? null),
      )
      .map((other) => other.key ?? null)
    return { ...finding, status: 'removable-individually', sibling_pins: siblings }
  })
}

/**
 * The count of pins that the baseline did not refuse. jq reads the two lists
 * with `// []`, and stops on an entry that is not an object or null.
 */
const pinsOwed = (session: Session): number => {
  try {
    const refused = jqValues(or(readOptionalValue(session.state, 'baseline_inconclusive'), [])).map(
      (entry) => fieldOf(entry, 'package'),
    )
    return jqValues(or(readOptionalValue(session.state, 'test_order'), [])).filter(
      (pin) => !found(refused, fieldOf(pin, 'package')),
    ).length
  } catch {
    return die(
      `judge: phase 2's test_order and the baseline's inconclusive list could not be read out of ${session.state.path}`,
    )
  }
}

/**
 * jq's `index($p) != null` on a list. A list as `$p` is found where its
 * entries are in a row, and an empty list is never found.
 */
const found = (list: readonly unknown[], wanted: unknown): boolean => {
  if (!Array.isArray(wanted)) return list.some((each) => equal(each, wanted))
  return list.some(
    (_, start) =>
      wanted.length > 0 &&
      start + wanted.length <= list.length &&
      wanted.every((each, offset) => equal(list[start + offset], each)),
  )
}

/**
 * The pins of `test_order` with no finding at their path. jq reads
 * `.test_order[]` with no default, so a null list stops it, after the
 * findings are written.
 */
const untestedPins = (session: Session, findings: readonly Finding[]): JsonValue[] => {
  try {
    return jqValues(readOptionalValue(session.state, 'test_order')).flatMap((pin) => {
      const path = fieldOf(pin, 'path')
      if (findings.some((finding) => equal(finding.path ?? null, path))) return []
      return [{ key: fieldOf(pin, 'key'), path, package: fieldOf(pin, 'package') } as JsonObject]
    })
  } catch {
    return die(`judge: the untested-pin list could not be computed from ${session.state.path}`)
  }
}

const keysWith = (findings: readonly Finding[], status: string): JsonValue[] =>
  findings.filter((finding) => finding.status === status).map((finding) => finding.key ?? null)

/** The judge phase. */
export const judge = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: AuditPinsDeps,
): Promise<CommandResult> =>
  settle(async () => {
    const parsedArgs = parseArguments(args, { work: { type: 'string', default: '' } })
    if (parsedArgs.outcome !== 'ok') stop(parsedArgs)
    if (parsedArgs.value.work === '') die('judge: --work is required')
    const session = loadSession(parsedArgs.value.work, env, deps)
    if (readOptionalValue(session.state, 'baseline_done') !== true) {
      die(
        "judge: run 'baseline' first. With no with-all-pins baseline there is nothing any finding was measured against.",
      )
    }
    // The baseline writes findings for the pins it refused, so a guard on
    // `baseline_done` alone lets an audit that tested nothing report that it
    // kept each pin.
    const expected = pinsOwed(session)
    const findings = stateValue(
      session,
      'advisories',
      'findings',
      isFindings,
      FINDINGS_SHAPE,
      'the findings phase 4 recorded',
    )
    if (expected !== 0 && !findings.some((finding) => finding.tested === true)) {
      die(
        `judge: run 'test-pin' first. ${expected} pin(s) survived the baseline and none has been ` +
          'tested, so every finding on file is one the baseline refused \u2014 and judging that set ' +
          'reports an audit that examined nothing as one that kept every pin it has.',
      )
    }
    const judged: Finding[] = []
    for (const finding of findings) {
      judged.push(finding.status === 'tested' ? await judgeOne(session, deps, finding) : finding)
    }
    const out = siblingRule(judged)
    setFindings(session, out)
    setKey(session, 'judge_done', true)
    return {
      status: 'ok',
      step: 'judge',
      findings: out,
      untested: untestedPins(session, out),
      removable: keysWith(out, 'removable'),
      removable_individually: keysWith(out, 'removable-individually'),
      still_required: keysWith(out, 'still-required'),
      inconclusive: keysWith(out, 'inconclusive'),
    }
  })
