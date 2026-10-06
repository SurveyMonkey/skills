// The merge-risk rating of a dependency fix, in process: the port of
// `scripts/common/score-merge-risk.sh` (#233). `score` of `fix-group` calls
// it, and so does the `score-merge-risk` command. The rules, and the reason
// for each, are in the header of that script and in ADR 006.
//
// Seven factors score 0 to 2 each, so the maximum is 14. The bands are Low
// for 0 to 3, Medium for 4 to 6, and High for 7 or more. Three rules
// escalate a band. A major delta never rates Low. A new unscoped override
// never rates Low. A multi-major jump on a runtime dependency with no test
// signal never rates below High. These numbers do not change (ADR 006).
//
// The adapter answers `compare_versions` and `range_facts` in process, one
// call for each distinct range (ADR 012). Its answer is checked before a
// field is read: an object, each promised key present, and each count and
// flag of its type (core.md). F3, F4 and F5 read the tree at `root`
// (`tree.ts`).
//
// Differences from the bash, each declared with #233:
//   - A count must be a non-negative integer, and a flag must be true or
//     false, as JSON values. The bash read them as text, so it also took the
//     text "2" and the text "true". A `parseable` that is not true or false
//     is a failure here. The bash read each such value as not parseable.
//   - An adapter verb that fails is the failure, with its own message and
//     outcome. The bash stopped with the status and stderr of the child.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { fieldOf, orElse, tostring } from '../jq.ts'
import { type Envelope, failed, ok } from '../lib/envelope.ts'
import {
  byBytes,
  ciStep,
  importPattern,
  matchingFiles,
  moduleBase,
  packageTested,
  prTrigger,
  siblingTested,
  sourceFiles,
  TEST_PATH,
  testImportBases,
  WORKFLOW_DIR,
  workflowDirUnreadable,
  workflowFiles,
} from './tree.ts'

/** The shapes of change that F6 rates, from the least to the most wide. */
export const OVERRIDE_SCOPES = ['none', 'scoped', 'bare-tightened', 'bare-added'] as const

export type OverrideScope = (typeof OVERRIDE_SCOPES)[number]

/** The refusal of a scope that is not one of {@link OVERRIDE_SCOPES}. */
export const SCOPE_ERROR = '--override-scope must be none, scoped, bare-tightened, or bare-added'

export const isOverrideScope = (scope: string): scope is OverrideScope =>
  (OVERRIDE_SCOPES as readonly string[]).includes(scope)

/** The two verbs of the adapter that the scorer asks, and the name its errors give. */
export interface RiskAdapter {
  readonly name: string
  readonly compareVersions: (a: string, b: string) => Envelope<unknown>
  readonly rangeFacts: (range: string, version: string) => Envelope<unknown>
}

/** What the scorer is given: the flags of the script, with the why payload read. */
export interface RiskRequest {
  readonly package: string
  /** The version before the fix. Empty when there is no baseline: F1 then scores a major. */
  readonly before: string
  readonly after: string
  /** The `why` answer. It must be a JSON object. */
  readonly why: unknown
  /** How the errors name the why payload: the `--why-json` value. */
  readonly whyLabel: string
  readonly overrideScope: string
  /** One entry for each range a dependent declares, or `none`: no range could be read. */
  readonly declaredRanges: readonly string[] | 'none'
}

export type RiskFactor = {
  readonly id: string
  readonly name: string
  readonly score: number
  readonly evidence: string
}

/** The report, with the keys of the bash in its order. */
export type RiskReport = {
  readonly package: string
  readonly score: number
  readonly max: number
  readonly band: Band
  readonly escalated: boolean
  readonly escalation_reason: string | null
  readonly delta: string
  readonly majors_crossed: number
  readonly declared_ranges: string[] | 'none-stated'
  readonly override_scope: OverrideScope
  readonly coverage: {
    readonly affected: number | null
    readonly covered: number | null
    readonly uncovered: string[]
  }
  readonly ci: {
    readonly workflow: string | null
    readonly trigger: string | null
    readonly step: string | null
  }
  readonly factors: RiskFactor[]
  readonly markdown: string
}

type Band = 'Low' | 'Medium' | 'High'

const CONTRACT = 'It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md)'

type Record_ = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A field as `read_field` gives it: absent, null, or the value. */
const has = (record: Record_, key: string): boolean => Object.hasOwn(record, key)

/** How a refusal shows a value: `read_field` gave `__null__` for null. */
const shown = (value: unknown): string => (value === null ? '__null__' : tostring(value))

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const countError = (adapter: RiskAdapter, what: string, value: unknown): string =>
  `adapter ${adapter.name}: ${what} must be a non-negative integer, got '${shown(value)}'. ` +
  `${CONTRACT}; a value the script cannot compare with would silently score the fix as crossing nothing.`

const boolError = (adapter: RiskAdapter, what: string, value: unknown): string =>
  `adapter ${adapter.name}: ${what} must be true or false, got '${shown(value)}'. ` +
  `${CONTRACT}; any other value lands in the risk-lowering branch and the range stops counting.`

const objectError = (adapter: RiskAdapter, call: string): string =>
  `adapter ${adapter.name}: ${call} emitted no JSON object on stdout. ${CONTRACT}; an adapter ` +
  'that cannot answer must exit non-zero, not answer with nothing and let the fix score as low risk.'

/** Each entry once, in the order of its first sight. */
const firstOfEach = (values: readonly string[]): string[] => [...new Set(values)]

/** What the declared ranges add up to, from `range_facts`. */
interface Distance {
  majorsCrossed: number
  pinnedRange: string | null
  /** The parseable ranges, and the ones the landed version escapes. */
  readonly declared: string[]
  readonly unsatisfied: string[]
  readonly unparseable: string[]
}

/** Ask the adapter about each distinct range. Only a range the landed version escapes counts. */
const rangeDistance = (
  ranges: readonly string[],
  after: string,
  adapter: RiskAdapter,
): Envelope<Distance> => {
  const distance: Distance = {
    majorsCrossed: 0,
    pinnedRange: null,
    declared: [],
    unsatisfied: [],
    unparseable: [],
  }
  // awk `NF && !seen[$0]++`: a line of blanks and tabs only is no range.
  for (const range of firstOfEach(ranges.filter((line) => /[^ \t]/.test(line)))) {
    const answer = adapter.rangeFacts(range, after)
    if (answer.outcome !== 'ok') return answer
    const facts = answer.value
    if (!isRecord(facts)) return failed(objectError(adapter, `range_facts '${range}' '${after}'`))
    for (const field of ['parseable', 'satisfied', 'pinned', 'majors_ahead']) {
      if (!has(facts, field)) {
        return failed(
          `adapter ${adapter.name}: range_facts '${range}' emitted no '${field}' field. ${CONTRACT}; ` +
            'an adapter that cannot answer must fail, not score the fix as low risk.',
        )
      }
    }
    const { parseable, satisfied, pinned, majors_ahead: ahead } = facts
    if (typeof parseable !== 'boolean') {
      return failed(boolError(adapter, `range_facts parseable for '${range}'`, parseable))
    }
    if (!parseable) {
      // Not a version range at all (`workspace:^`, `latest`, a git URL). It
      // stays in the evidence, and is never a dependent the fix left behind.
      distance.unparseable.push(range)
      continue
    }
    if (ahead !== null && !isCount(ahead)) {
      return failed(countError(adapter, `range_facts majors_ahead for '${range}'`, ahead))
    }
    if (typeof satisfied !== 'boolean') {
      return failed(boolError(adapter, `range_facts satisfied for '${range}'`, satisfied))
    }
    if (typeof pinned !== 'boolean') {
      return failed(boolError(adapter, `range_facts pinned for '${range}'`, pinned))
    }
    if (!satisfied) {
      if (ahead !== null && ahead > distance.majorsCrossed) distance.majorsCrossed = ahead
      distance.unsatisfied.push(range)
      if (pinned) distance.pinnedRange ??= range
    }
    distance.declared.push(range)
  }
  return ok(distance)
}

const DELTAS = ['major', 'minor', 'patch', 'prerelease', 'none']

/** F1, the version delta, and the delta text of the report. */
interface VersionDelta {
  readonly score: number
  readonly evidence: string
  readonly delta: string
  readonly distance: number
}

const versionDelta = (
  request: RiskRequest,
  unsatisfied: readonly string[],
  adapter: RiskAdapter,
): Envelope<VersionDelta> => {
  const { before, after } = request
  if (before === '') {
    // No baseline: the worst case, and the escalation keeps it out of Low.
    return ok({
      score: 2,
      evidence: 'no pre-fix baseline available; scored as major',
      delta: 'unknown',
      distance: 0,
    })
  }
  const call = `compare_versions '${before}' '${after}'`
  const answer = adapter.compareVersions(before, after)
  if (answer.outcome !== 'ok') return answer
  const cmp = answer.value
  if (!isRecord(cmp)) return failed(objectError(adapter, call))
  if (!has(cmp, 'delta') || cmp.delta === null) {
    return failed(
      `adapter ${adapter.name}: ${call} emitted no usable 'delta'. ${CONTRACT}; read as a default ` +
        'it would score every unanswered bump as a patch.',
    )
  }
  const delta = tostring(cmp.delta)
  if (typeof cmp.delta !== 'string' || !DELTAS.includes(delta)) {
    return failed(
      `adapter ${adapter.name}: ${call} answered delta '${delta}', which is not in the contract ` +
        'enum major|minor|patch|prerelease|none (docs/adr/001-ecosystem-adapter-contract.md); ' +
        'an unrecognized delta would score as a patch.',
    )
  }
  const distance = cmp.major_distance
  if (!has(cmp, 'major_distance') || distance === null) {
    return failed(
      `adapter ${adapter.name}: ${call} emitted no usable 'major_distance'. ${CONTRACT}; without ` +
        'it the multi-major escalation cannot fire and the fix would score as though it crossed nothing.',
    )
  }
  if (!isCount(distance)) {
    return failed(countError(adapter, 'compare_versions major_distance', distance))
  }
  const score = delta === 'major' ? 2 : delta === 'minor' ? 1 : 0
  const label = distance >= 2 ? `${distance} majors` : delta
  const left = unsatisfied.length > 0 ? `; parents declare ${unsatisfied.join(', ')}` : ''
  return ok({ score, evidence: `${before} -> ${after} (${label}${left})`, delta, distance })
}

/** A script is a non-empty string under `.scripts`. */
const hasScript = (manifest: Record_, name: string): boolean => {
  const scripts = orElse(fieldOf(manifest, 'scripts'), {})
  if (!isRecord(scripts)) return false
  const script = fieldOf(scripts, name)
  return typeof script === 'string' && script.length > 0
}

/** The entry points that package.json declares, split on blanks as the bash split them. */
const entryPoints = (manifest: Record_): string[] => {
  const bin = fieldOf(manifest, 'bin')
  return [
    fieldOf(manifest, 'main'),
    fieldOf(manifest, 'module'),
    fieldOf(manifest, 'browser'),
    ...(isRecord(bin) ? Object.values(bin) : [bin]),
  ]
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(/[ \t\n]+/))
    .filter((entry) => entry !== '')
}

/** A value as `jq -r` prints it: text as it is, and any other value as its JSON. */
const raw = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

/** The parents that `why` names, as `jq -r '.parents[]?' | head -20` gives them. */
const parentsText = (why: Record_): string => {
  const parents = fieldOf(why, 'parents')
  const values = Array.isArray(parents) ? parents : isRecord(parents) ? Object.values(parents) : []
  return values.map(raw).join('\n').split('\n').slice(0, 20).join('\n')
}

const words = (text: string): string[] => text.split(/[ \t\n]+/).filter((word) => word !== '')

const without = (path: string): string => path.replace(/^\.\//, '')

const factor = (id: string, name: string, score: number, evidence: string): RiskFactor => ({
  id,
  name,
  score,
  evidence,
})

/** The mark of each band: a green, a yellow and a red circle. */
const EMOJI: Readonly<Record<Band, string>> = {
  Low: '\u{1F7E2}',
  Medium: '\u{1F7E1}',
  High: '\u{1F534}',
}

const bandOf = (score: number): Band => (score <= 3 ? 'Low' : score <= 6 ? 'Medium' : 'High')

/** Read package.json at `root`, or the refusal. */
const readManifest = (root: string): Envelope<Record_> => {
  if (!statSync(join(root, 'package.json'), { throwIfNoEntry: false })?.isFile()) {
    return failed(
      `no package.json in ${root}. The scorer runs from the root of the tree being scored, and F3 ` +
        'and F4 read the manifest there; without it the fix would score as a repository that ' +
        'declares no scripts.',
    )
  }
  let manifest: unknown = null
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {}
  return isRecord(manifest)
    ? ok(manifest)
    : failed(
        `package.json in ${root} does not parse as a JSON object. Read as an absent manifest it ` +
          'scores the fix as having no test script and no entry points, which is lower risk than ' +
          'the truth.',
      )
}

/** A factor score and its evidence. */
type Rated = readonly [number, string]

/** The surface that F3 measured, which F4 then checks for tests. */
interface Surface {
  readonly rated: Rated
  /** False when a transitive package names no parents: nothing could be measured. */
  readonly known: boolean
  /** The importing modules that are not tests, as `./<path>`. */
  readonly modules: readonly string[]
}

/**
 * F3, the usage surface. A transitive package is never imported by name, so
 * its surface is the modules that import its parents. A tree that cannot be
 * read is a failure: a partial read would score the surface as zero.
 */
const usageSurface = (
  root: string,
  pkg: string,
  why: Record_,
  manifest: Record_,
): Envelope<Surface> => {
  const direct = isDirect(why)
  const targets = direct ? pkg : parentsText(why)
  const desc = direct ? pkg : `parents of ${pkg}`
  if (!direct && targets === '') {
    return ok({
      rated: [2, `no parents known for ${pkg}; usage surface could not be measured`],
      known: false,
      modules: [],
    })
  }
  const pattern = importPattern(words(targets))
  let modules: string[] = []
  if (pattern !== null) {
    try {
      modules = matchingFiles(root, sourceFiles(root, true), pattern).filter(
        (file) => !TEST_PATH.test(file),
      )
    } catch (error) {
      return failed(
        `could not read the tree under ${root} while searching for imports of ${desc} ` +
          `(the read failed with ${String((error as NodeJS.ErrnoException).code)}). A partial ` +
          'read scores the usage surface and its test coverage as zero, so this fails instead of ' +
          'guessing.',
      )
    }
  }
  const count = modules.length
  const paths = new Set(modules.map(without))
  const entryHit = entryPoints(manifest).some((entry) => paths.has(without(entry)))
  const rated: Rated =
    count === 0
      ? [0, `no source imports found for ${desc} (build or tooling only)`]
      : entryHit
        ? [2, `imported in ${count} module(s) for ${desc}, including a declared entry point`]
        : [count <= 5 ? 1 : 2, `imported in ${count} module(s) for ${desc}`]
  return ok({ rated, known: true, modules })
}

/** F4, and the coverage object of the report. */
interface Coverage {
  readonly rated: Rated
  readonly affected: number | null
  readonly covered: number | null
  readonly uncovered: string[]
}

/**
 * F4, the test coverage of the surface that F3 found. Only a test of the
 * package itself covers the whole surface: a test of a parent does not.
 */
const testCoverage = (root: string, pkg: string, manifest: Record_, surface: Surface): Coverage => {
  if (!surface.known) {
    return {
      rated: [2, `no parents known for ${pkg}; nothing could be checked for test coverage`],
      affected: null,
      covered: null,
      uncovered: [],
    }
  }
  const testFiles = sourceFiles(root, false).filter((file) => TEST_PATH.test(file))
  const bases = testImportBases(root, testFiles)
  const whole = packageTested(root, testFiles, importPattern(words(pkg)))
  const uncovered = surface.modules
    .map(without)
    .filter((module) => !whole && !siblingTested(root, module) && !bases.has(moduleBase(module)))
    .sort(byBytes)
  const affected = surface.modules.length
  const covered = affected - uncovered.length
  const shownNames = uncovered.slice(0, 5).join(',').replaceAll(',', ', ')
  const names =
    uncovered.length > 5 ? `${shownNames}, and ${uncovered.length - 5} more` : shownNames
  const rated: Rated =
    affected === 0
      ? hasScript(manifest, 'build')
        ? [0, 'no source imports; a build script exists, so a broken tooling pin fails at build']
        : hasScript(manifest, 'test')
          ? [
              1,
              'no source imports and no build script; the test script is the only thing that would notice',
            ]
          : [2, 'no source imports, and neither a build nor a test script exists']
      : !hasScript(manifest, 'test')
        ? [2, `${affected} affected module(s), and package.json declares no test script`]
        : covered === affected
          ? [0, `all ${affected} affected module(s) are covered by a test`]
          : covered > 0
            ? [
                1,
                `${covered} of ${affected} affected modules are imported by a test (${names} uncovered)`,
              ]
            : [
                2,
                `none of the ${affected} affected module(s) is covered by a test (${names} uncovered)`,
              ]
  return { rated, affected, covered, uncovered }
}

/** F5, and the ci object of the report. */
interface Ci {
  readonly rated: Rated
  readonly workflow: string | null
  readonly trigger: string | null
  readonly step: string | null
}

/**
 * F5, CI presence, from the GitHub Actions workflows alone. The first
 * workflow that triggers on a pull request and runs a check wins. Else the
 * first one that triggers on a pull request is named.
 */
const ciPresence = (root: string): Envelope<Ci> => {
  let checked: Ci | null = null
  let triggered: Ci | null = null
  let count = 0
  for (const workflow of workflowFiles(root)) {
    let text: string
    try {
      text = readFileSync(join(root, workflow), 'latin1')
    } catch {
      return failed(
        `${workflow} cannot be read, so whether it runs a check on this pull request could not ` +
          'be determined. Skipped silently it would score as a repository with less CI than it has.',
      )
    }
    count += 1
    const trigger = prTrigger(text)
    if (trigger === null) continue
    const step = ciStep(text)
    if (step !== null && checked === null) {
      checked = {
        rated: [0, `${workflow} triggers on ${trigger} and runs: ${step}`],
        workflow,
        trigger,
        step,
      }
    } else {
      triggered ??= {
        rated: [
          1,
          `${workflow} triggers on ${trigger}, but no test, build, typecheck, check, or lint step is visible in it`,
        ],
        workflow,
        trigger,
        step: null,
      }
    }
  }
  const none: Ci = {
    rated:
      count > 0
        ? [2, `${count} GitHub Actions workflow file(s), none triggering on a pull request`]
        : [
            2,
            'no GitHub Actions workflow triggers on this pull request; another CI vendor is not read',
          ],
    workflow: null,
    trigger: null,
    step: null,
  }
  return ok(checked ?? triggered ?? none)
}

/** F6, the override blast radius: the shape the caller applied, and what it is worth. */
const blastRadius = (scope: OverrideScope, pkg: string): Rated => {
  const radius: Readonly<Record<OverrideScope, Rated>> = {
    none: [0, 'no override applied by this change'],
    scoped: [0, 'scoped override: only the dependency paths that carried the alerts are pinned'],
    'bare-tightened': [
      1,
      `pre-existing unscoped override for ${pkg} tightened; the global pin already governed every consumer`,
    ],
    'bare-added': [
      2,
      `new unscoped override pins ${pkg} for every consumer, including copies that were never vulnerable`,
    ],
  }
  return radius[scope]
}

/**
 * F7, the distance from the declared ranges: the majors past the widest
 * escaped floor, with a crossed pin on top. `stated` is false for `none`.
 */
const rangeFactor = (ranges: Distance, majors: number, stated: boolean): Rated => {
  const pin = ranges.pinnedRange
  const score = Math.min(2, (majors >= 2 ? majors - 1 : 0) + (pin !== null ? 1 : 0))
  // A crossed pin below one major is the whole finding, so it comes first.
  const pinFirst = majors === 0 && pin !== null
  const parts = [
    pinFirst
      ? `crosses the pinned range ${pin}`
      : majors === 0
        ? 'no major line crossed'
        : majors === 1
          ? 'one major line crossed'
          : `${majors} major lines crossed`,
    ranges.declared.length > 0
      ? `dependents declare ${ranges.declared.join(', ')}`
      : stated
        ? 'no dependent range could be evaluated'
        : 'caller stated no dependent ranges could be read',
  ]
  const skipped = ranges.unparseable
  if (skipped.length > 0) {
    const counted =
      skipped.length === 1 ? '1 dependent range' : `${skipped.length} dependent ranges`
    parts.push(`${counted} not evaluated (${skipped.join(', ')})`)
  }
  if (pin !== null && !pinFirst) parts.push(`crosses the pinned range ${pin}`)
  return [score, parts.join('; ')]
}

/** True when `why` classifies the package as a direct dependency. */
const isDirect = (why: Record_): boolean =>
  orElse(fieldOf(why, 'relationship'), 'transitive') === 'direct'

/** F2, runtime exposure. jq read the text "true" as true. */
const runtimeExposure = (why: Record_): Rated => {
  const devOnly = orElse(fieldOf(why, 'dev_only'), false)
  if (devOnly === true || devOnly === 'true') return [0, 'dev-only dependency chain']
  return isDirect(why)
    ? [2, 'direct runtime dependency']
    : [1, 'transitive under a runtime dependency']
}

/** Score one fix. `root` is the tree being scored, where the bash ran. */
export const scoreMergeRisk = (
  request: RiskRequest,
  adapter: RiskAdapter,
  root: string,
): Envelope<RiskReport> => {
  const pkg = request.package
  const scope = request.overrideScope
  if (!isOverrideScope(scope)) return failed(SCOPE_ERROR)
  const why = request.why
  if (!isRecord(why)) {
    return failed(
      `--why-json ${request.whyLabel} did not contain a JSON object. Read through jq, a malformed ` +
        'payload answers every field with a default and the fix scores against a classification ' +
        'nobody supplied.',
    )
  }
  const read = readManifest(root)
  if (read.outcome !== 'ok') return read
  const manifest = read.value
  if (workflowDirUnreadable(root)) {
    return failed(
      `${WORKFLOW_DIR} exists but cannot be read, so whether CI runs on this pull request could ` +
        "not be determined. Reported as 'no workflow' it would be indistinguishable from a " +
        'repository that has none, which is the lower-risk answer.',
    )
  }

  const stated =
    request.declaredRanges === 'none'
      ? null
      : request.declaredRanges.flatMap((range) => range.split('\n'))
  const measured = rangeDistance(stated ?? [], request.after, adapter)
  if (measured.outcome !== 'ok') return measured
  const ranges = measured.value
  const delta = versionDelta(request, ranges.unsatisfied, adapter)
  if (delta.outcome !== 'ok') return delta
  const majors = Math.max(ranges.majorsCrossed, delta.value.distance)
  const surface = usageSurface(root, pkg, why, manifest)
  if (surface.outcome !== 'ok') return surface
  const coverage = testCoverage(root, pkg, manifest, surface.value)
  const ci = ciPresence(root)
  if (ci.outcome !== 'ok') return ci

  const rated: readonly (readonly [string, string, Rated])[] = [
    ['F1', 'Version delta', [delta.value.score, delta.value.evidence]],
    ['F2', 'Runtime exposure', runtimeExposure(why)],
    ['F3', 'Usage surface', surface.value.rated],
    ['F4', 'Test coverage', coverage.rated],
    ['F5', 'CI presence', ci.value.rated],
    ['F6', 'Override blast radius', blastRadius(scope, pkg)],
    ['F7', 'Declared-range distance', rangeFactor(ranges, majors, stated !== null)],
  ]
  const factors = rated.map(([id, name, [score, evidence]]) => factor(id, name, score, evidence))
  const scoreOf = (index: number): number => (factors[index] as RiskFactor).score
  const score = factors.reduce((sum, entry) => sum + entry.score, 0)
  const max = factors.length * 2
  const rawBand = bandOf(score)
  const blockers = [
    ...(scoreOf(0) === 2 ? ['a major version delta never rates Low'] : []),
    ...(scope === 'bare-added' ? ['a newly added unscoped override never rates Low'] : []),
  ]
  const highBlockers =
    majors >= 2 && scoreOf(1) >= 1 && scoreOf(3) === 2
      ? ['a multi-major jump on a runtime dependency with no test signal never rates below High']
      : []
  const band: Band =
    highBlockers.length > 0 ? 'High' : blockers.length > 0 && rawBand === 'Low' ? 'Medium' : rawBand
  const applied = (highBlockers.length > 0 ? highBlockers : blockers).join('; ')
  const escalated = band !== rawBand
  const markdown =
    `## Merge risk: ${EMOJI[band]} ${band} (${score}/${max})\n\n` +
    (escalated ? `> Escalated from ${rawBand}: ${applied}.\n\n` : '') +
    '| Factor | Score | Evidence |\n|---|---|---|\n' +
    factors.map((entry) => `| ${entry.name} | ${entry.score} | ${entry.evidence} |`).join('\n') +
    '\n'

  return ok({
    package: pkg,
    score,
    max,
    band,
    escalated,
    escalation_reason: escalated ? applied : null,
    delta: delta.value.delta,
    majors_crossed: majors,
    declared_ranges:
      stated === null ? 'none-stated' : firstOfEach(stated.filter((range) => range !== '')),
    override_scope: scope,
    coverage: {
      affected: coverage.affected,
      covered: coverage.covered,
      uncovered: coverage.uncovered,
    },
    ci: { workflow: ci.value.workflow, trigger: ci.value.trigger, step: ci.value.step },
    factors,
    markdown,
  })
}
