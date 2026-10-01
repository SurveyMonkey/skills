// Parity for the verbs of #222 layer 1 against node.sh (RFC 002, "Parity is
// the migration strategy"): `validate`, `install` and `shim`. Each example
// runs one verb of node.sh and the same verb of `node` on one input. Then it
// compares the two answers: the outcome and the payload both.
//
// `validate` runs on each fixture that spec/node_validate_spec.sh uses. This
// file reads that set from the spec, and a check fails when SPEC_CASES does
// not cover it. Two kinds of case run:
//
//   - SPEC_CASES: the argument lists of the spec examples, copied from the
//     spec, each with the title of its example.
//   - Generated cases, from the `resolution_map` and the `resolved_versions`
//     that bash answers for each fixture: each package, each major line, and
//     baselines that move a line, with each kind of sibling list.
//
// The TypeScript side gets the same argument list, read into the typed
// options by `callOf`. That function reads the flags as `verb_validate`
// does. A flag with no value is a flag with an empty value, because
// `${2:?}` refuses both with one message.
//
// `install` and `shim` write. So they run in a linked worktree that
// harness/git.ts builds in a sandbox, never in this checkout. The two sides
// run in the same worktree, one after the other, and the first answer is
// removed before the second side runs. The bash side gets its PATH through
// `env`, so both sides read one PATH. No PATH holds a package manager that
// can run: an empty file stands in for one, as in detect.test.ts, because
// `shim` only looks for the name. No example runs an install. The install
// case starts a command that is not on PATH.
//
// Declared out, each with its reason:
//
//   - The unknown option of validate. The in-process verb has no argument
//     list. The CLI entry that #237 names owns that refusal.
//   - `shim` on a tree that `detect` refuses (bun, Yarn Classic, no
//     lockfile). The verb takes a `Tree`, and only a detection that
//     succeeded gives one. There, bash `shim` refuses with its own message,
//     and the TypeScript caller gets the refusal of `detect`.
//
// Declared divergence in the exit status, as in parity-node.test.ts: where
// jq itself stops, bash exits 5. The TypeScript side answers `failed`. There
// the check is the refusal alone.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type {
  Environment,
  Tree,
  ValidateAnswer,
  ValidateOptions,
} from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import {
  type Envelope,
  exitCodeFor,
  type Failure,
  type JsonValue,
  renderJson,
} from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { type BashResult, firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile, ROOT } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ADAPTER = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

const SPEC = join(ROOT, 'spec', 'node_validate_spec.sh')

const ENV = { PATH: process.env.PATH }

/** The status jq exits with when its program stops with an error. */
const JQ_ERROR = 5

/** The time limit of an example that builds a repository. */
const GIT_TIMEOUT_MS = 60_000

/** A fresh copy that `JsonValue` admits: it has no readonly arrays. */
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

/** The tree that the TypeScript side reads, from its own `detect`. */
const treeOf = (dir: string, env: Environment = ENV): Tree<NodeDetection> => {
  const detection = node.detect(dir, env)
  if (detection.outcome !== 'ok') {
    throw new Error(`TypeScript detect refused ${dir}: ${detection.error}`)
  }
  return { root: dir, detection: detection.value }
}

/**
 * 'agree', or the first disagreement in words, for a refusal on both sides.
 *
 * bash writes a refusal to stderr, and nothing to stdout. `die` and the
 * guard write one line of JSON last, which must equal the body that the
 * entry point renders from the TypeScript envelope. The `${1:?}` usage guard
 * writes prose, which must contain the TypeScript message. Where jq stops,
 * only the refusal counts.
 */
const refusalAgreement = (answer: BashResult, failure: Failure): string => {
  if (answer.status === 0) return `bash answered: ${answer.stdout.trim()}`
  if (answer.stdout !== '') return `bash wrote an answer: ${answer.stdout.trim()}`
  const status = exitCodeFor(failure)
  if (answer.status === JQ_ERROR && status === 1) return 'agree'
  if (answer.status !== status) return `bash exits ${answer.status}, TypeScript exits ${status}`
  const last = answer.stderr.trim().split('\n').at(-1) ?? ''
  if (last.startsWith('{')) {
    const difference = firstDifference(
      JSON.parse(last) as JsonValue,
      JSON.parse(renderJson(failure).stdout) as JsonValue,
    )
    return difference === null ? 'agree' : `the refusals differ at ${difference}`
  }
  return answer.stderr.includes(failure.error)
    ? 'agree'
    : `bash stderr does not name "${failure.error}": ${answer.stderr.trim()}`
}

/**
 * 'agree', or the first disagreement in words, for `validate`. bash writes
 * the answer and exits 0 when `ok` is true, and exits 1 when it is false.
 */
const validateAgreement = (answer: BashResult, envelope: Envelope<ValidateAnswer>): string => {
  if (envelope.outcome !== 'ok') return refusalAgreement(answer, envelope)
  const status = envelope.value.ok ? 0 : 1
  if (answer.status !== status || answer.stdout === '') {
    return `bash exits ${answer.status} with "${answer.stderr.trim()}", TypeScript ok is ${envelope.value.ok}`
  }
  const difference = firstDifference(JSON.parse(answer.stdout) as JsonValue, asJson(envelope.value))
  return difference === null ? 'agree' : `they differ at ${difference}`
}

type Call = { readonly pkg: string; readonly range: string; readonly options: ValidateOptions }

/**
 * The typed call for one argument list, read as `verb_validate` reads its
 * flags, or null for an unknown option.
 */
const callOf = (args: readonly string[]): Call | null => {
  let line: string | null = null
  let baseline: string | null = null
  let siblingAlerts: string | null = null
  const vulnerable: string[] = []
  let index = 0
  while (index < args.length) {
    const flag = args[index] as string
    if (flag === '--') {
      index += 1
      break
    }
    if (!flag.startsWith('-')) break
    const value = args[index + 1] ?? ''
    if (flag === '--line') line = value
    else if (flag === '--baseline') baseline = value
    else if (flag === '--sibling-alerts') siblingAlerts = value
    else if (flag === '--vulnerable') vulnerable.push(value)
    else return null
    index += 2
  }
  return {
    pkg: args[index] ?? '',
    range: args[index + 1] ?? '',
    options: { line, vulnerable, baseline, siblingAlerts },
  }
}

/** Run both sides of `validate` on one directory and one argument list. */
const validateBoth = (dir: string, args: readonly string[]): string => {
  const call = callOf(args)
  if (call === null) throw new Error(`no typed call for ${JSON.stringify(args)}`)
  const answer = runBash({ command: ADAPTER, args: ['validate', ...args], cwd: dir })
  return validateAgreement(answer, node.validate(treeOf(dir), call.pkg, call.range, call.options))
}

// The baselines and the range of the spec, copied from it.
const NOHIT = '< 1.0.0'
const BASELINE =
  '{"pm":"yarn","package":"brace-expansion","present":true,"count":2,"versions":[{"version":"1.1.18","path":"brace-expansion@npm:1.1.18"},{"version":"5.0.6","path":"brace-expansion@npm:5.0.6"}],"lockfile_entries":10}'
const PNPM_BASELINE =
  '{"pm":"pnpm","package":"brace-expansion","present":true,"count":3,"versions":[{"version":"1.1.11","path":"brace-expansion@1.1.11"},{"version":"2.0.2","path":"brace-expansion@2.0.2"},{"version":"5.0.5","path":"brace-expansion@5.0.5"}],"lockfile_entries":14}'
const NPM_BASELINE =
  '{"pm":"npm","package":"brace-expansion","present":true,"count":3,"versions":[{"version":"5.0.5","path":"node_modules/brace-expansion"},{"version":"2.0.2","path":"node_modules/filelist/node_modules/brace-expansion"},{"version":"1.1.11","path":"node_modules/glob/node_modules/brace-expansion"}],"lockfile_entries":14}'
const DEDUP_BASELINE =
  '{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.1","path":"picomatch@2.3.1"},{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
const CLEAN_BASELINE =
  '{"pm":"pnpm","package":"picomatch","present":true,"count":2,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
const TWO_SURVIVOR_BASELINE =
  '{"pm":"pnpm","package":"picomatch","present":true,"count":4,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"2.3.9","path":"picomatch@2.3.9"},{"version":"2.3.10","path":"picomatch@2.3.10"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":6}'
const STALE_BASELINE =
  '{"pm":"pnpm","package":"picomatch","present":true,"count":2,"versions":[{"version":"2.3.9","path":"picomatch@2.3.9"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
const CONTROL_BASELINE =
  '{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.9","path":"picomatch@2.3.9"},{"version":"2.3.10","path":"picomatch@2.3.10"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":6}'
const NPM_STALE_BASELINE =
  '{"pm":"npm","package":"picomatch","present":true,"count":2,"versions":[{"version":"2.3.9","path":"node_modules/anymatch/node_modules/picomatch"},{"version":"4.0.1","path":"node_modules/picomatch"}],"lockfile_entries":5}'
const NPM_CONTROL_BASELINE =
  '{"pm":"npm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.10","path":"node_modules/readdirp/node_modules/picomatch"},{"version":"2.3.9","path":"node_modules/anymatch/node_modules/picomatch"},{"version":"4.0.1","path":"node_modules/picomatch"}],"lockfile_entries":6}'
const VANISHED_PNPM_BASELINE =
  '{"pm":"pnpm","package":"brace-expansion","present":true,"count":3,"versions":[{"version":"1.1.11","path":"brace-expansion@1.1.11"},{"version":"2.0.2","path":"brace-expansion@2.0.2"},{"version":"5.0.5","path":"brace-expansion@5.0.5"}],"lockfile_entries":14}'

const dedup = (...rest: string[]): string[] => [
  '--line',
  '4',
  '--vulnerable',
  '< 4.0.3',
  '--baseline',
  DEDUP_BASELINE,
  ...rest,
  'picomatch',
  '>=4.0.3 <5',
]

const collapsed = (baseline: string): string[] => [
  '--line',
  '5',
  '--vulnerable',
  '< 5.0.9',
  '--baseline',
  baseline,
  'brace-expansion',
  '>=5.0.9 <6',
]

/** One example of the spec: its title, its fixture, and its arguments. */
type SpecCase = readonly [title: string, fixture: string, args: readonly string[]]

const SPEC_CASES: readonly SpecCase[] = [
  // Describe 'node.sh validate --line'
  ['an unscoped major-bounded range', 'yarn-multi-major', ['undici', '>=7.27.0 <8']],
  [
    'only the targeted line',
    'yarn-multi-major',
    ['--line', '7', '--vulnerable', NOHIT, 'undici', '>=7.0.0 <8'],
  ],
  ...(
    [
      ['5', '>=5.0.0 <6'],
      ['6', '>=6.0.0 <7'],
      ['7', '>=7.0.0 <8'],
      ['9', '>=9.0.0 <10'],
    ] as const
  ).map(
    ([line, range]): SpecCase => [
      `line membership ${line}`,
      'yarn-multi-major',
      ['--line', line, '--vulnerable', NOHIT, 'undici', range],
    ],
  ),
  ['a non-numeric line', 'yarn-multi-major', ['--line', 'six', 'undici', '>=6.0.0 <7']],
  ['a line with no alert ranges', 'yarn-multi-major', ['--line', '7', 'undici', '>=7.0.0 <8']],
  // Describe 'node.sh validate --vulnerable (completeness)'
  [
    'a satisfied constraint with a copy that matches',
    'yarn-multi-major',
    ['--line', '6', '--vulnerable', '< 6.28.0', 'undici', '>=6.24.0 <7'],
  ],
  [
    'no copy matches an alert range',
    'yarn-multi-major',
    ['--line', '7', '--vulnerable', '>= 7.0.0, < 7.27.0', 'undici', '>=7.0.0 <8'],
  ],
  [
    'a copy below the line',
    'yarn-multi-major',
    ['--line', '6', '--vulnerable', '< 6.28.0', 'undici', '>=6.28.0 <7'],
  ],
  [
    'a major-bump copy after its own line is clear',
    'yarn-multi-major',
    ['--line', '6', '--vulnerable', '< 6.24.0', 'undici', '>=6.24.0 <7'],
  ],
  [
    'a locator with binding parameters',
    'yarn-binding-params',
    ['--line', '2', '--vulnerable', '>= 2.5.0, < 2.5.3', 'privreg', '>=2.5.3 <3'],
  ],
  [
    'nested patch locators',
    'yarn-patch-nested',
    ['--line', '5', '--vulnerable', '< 5.1.6', 'typescript', '>=5.1.6 <6'],
  ],
  [
    'a copy under an npm: alias key',
    'npm-alias',
    ['--line', '4', '--vulnerable', '>= 4.18.0, < 4.18.2', 'lodash', '>=4.18.2 <5'],
  ],
  ...[
    '< 6.28.0',
    '>= 7.0.0, < 7.29.0',
    '>= 6.0.0, < 6.24.2',
    '< 5.29.0',
    '>= 5.0.0, < 5.30.0 || >= 7.0.0, < 7.28.0',
    'foo',
    '*',
    '>= ',
    'all versions before 6.28.0',
    '',
    '< 1.0.0',
    '>= 7.0.0, < 7.27.0',
    '>=6.0.0 <6.24.0',
    '>= 2.0.0, < 3.0.0 || >= 8.0.0, < 9.0.0',
    '= 4.0.0',
    '>= 1.0.0-beta.1, < 1.0.0',
  ].map(
    (range): SpecCase => [
      `the alert range ${JSON.stringify(range)}`,
      'yarn-multi-major',
      ['--vulnerable', range, 'undici', '>=5.0.0'],
    ],
  ),
  ['no alert ranges', 'yarn-berry', ['undici', '>=5.0.0']],
  // Describe 'node.sh validate --baseline'
  [
    'the collapsed tree with no baseline',
    'yarn-cross-line-collapsed',
    ['--line', '5', '--vulnerable', '< 5.0.9', 'brace-expansion', '>=5.0.9 <6'],
  ],
  ['a copy dragged off another line', 'yarn-cross-line-collapsed', collapsed(BASELINE)],
  [
    'nothing outside the line moved',
    'yarn-cross-line',
    [
      '--line',
      '5',
      '--vulnerable',
      '< 5.0.5',
      '--baseline',
      BASELINE,
      'brace-expansion',
      '>=5.0.5 <6',
    ],
  ],
  [
    'a line absent from the baseline',
    'yarn-cross-line',
    [
      '--line',
      '5',
      '--vulnerable',
      '< 5.0.5',
      '--baseline',
      '{"package":"brace-expansion","versions":[{"version":"5.0.6"}]}',
      'brace-expansion',
      '>=5.0.5 <6',
    ],
  ],
  [
    'a baseline with no line',
    'yarn-cross-line',
    ['--baseline', BASELINE, 'brace-expansion', '>=5.0.5 <6'],
  ],
  ...[
    'nope',
    '["1.1.18"]',
    '{"package":"minimatch","versions":[{"version":"3.1.5"}]}',
    '{"package":"brace-expansion"}',
    '{"package":"brace-expansion","versions":"1.1.18"}',
    '{"package":"brace-expansion","versions":[{"version":118}]}',
    '',
    '{"package":"brace-expansion","versions":[{"version":"1.1.18"}]} {"package":"brace-expansion","versions":[{"version":"1.1.18"}]}',
  ].map(
    (baseline): SpecCase => [
      `the baseline ${JSON.stringify(baseline)}`,
      'yarn-cross-line-collapsed',
      collapsed(baseline),
    ],
  ),
  [
    'an empty baseline',
    'yarn-cross-line',
    [
      '--line',
      '5',
      '--vulnerable',
      '< 5.0.5',
      '--baseline',
      '{"package":"brace-expansion","present":false,"count":0,"versions":[]}',
      'brace-expansion',
      '>=5.0.5 <6',
    ],
  ],
  // Describe 'node.sh validate --baseline (pnpm)' and '(npm)'
  ['the pnpm collapse', 'pnpm-cross-line-collapsed', collapsed(PNPM_BASELINE)],
  ['the pnpm qualified keys', 'pnpm-cross-line-qualified', collapsed(PNPM_BASELINE)],
  ['the npm collapse', 'npm-cross-line-collapsed', collapsed(NPM_BASELINE)],
  ['the npm qualified keys', 'npm-cross-line-qualified', collapsed(NPM_BASELINE)],
  // Describe 'node.sh validate --sibling-alerts'
  ['the field-case dedup', 'pnpm-benign-dedup', dedup('--sibling-alerts', '[]')],
  [
    'a sibling alert on the moved line',
    'pnpm-benign-dedup',
    dedup('--sibling-alerts', '[{"major":2,"vulnerable_ranges":["< 2.3.3"]}]'),
  ],
  ['no sibling flag', 'pnpm-benign-dedup', dedup()],
  [
    'a null-major sibling',
    'pnpm-benign-dedup',
    dedup('--sibling-alerts', '[{"major":null,"vulnerable_ranges":["<= 1.3.0"]}]'),
  ],
  ...[
    '{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"2.3.3","path":"picomatch@2.3.3"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}',
    '{"pm":"pnpm","package":"picomatch","present":true,"count":2,"versions":[{"version":"2.3.1","path":"picomatch@2.3.1"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}',
    '{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"2.3.10","path":"picomatch@2.3.10"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}',
  ].map(
    (baseline, row): SpecCase => [
      `a baseline that keeps the move fatal, row ${row + 1}`,
      'pnpm-benign-dedup',
      [
        '--line',
        '4',
        '--vulnerable',
        '< 4.0.3',
        '--baseline',
        baseline,
        '--sibling-alerts',
        '[]',
        'picomatch',
        '>=4.0.3 <5',
      ],
    ],
  ),
  [
    'a vanished line with no sibling alerts',
    'pnpm-cross-line-collapsed',
    [
      ...collapsed(VANISHED_PNPM_BASELINE).slice(0, 6),
      '--sibling-alerts',
      '[]',
      'brace-expansion',
      '>=5.0.9 <6',
    ],
  ],
  [
    'sibling alerts with no baseline',
    'pnpm-benign-dedup',
    ['--line', '4', '--vulnerable', '< 4.0.3', '--sibling-alerts', '[]', 'picomatch', '>=4.0.3 <5'],
  ],
  ...[
    'nope',
    '{"major":2,"vulnerable_ranges":[]}',
    '[{"vulnerable_ranges":["< 2.3.3"]}]',
    '[{"major":"2","vulnerable_ranges":["< 2.3.3"]}]',
    '[{"major":2.5,"vulnerable_ranges":["< 2.3.3"]}]',
    '[{"major":-1,"vulnerable_ranges":["< 2.3.3"]}]',
    '[{"major":2}]',
    '[{"major":2,"vulnerable_ranges":"< 2.3.3"}]',
    '[{"major":2,"vulnerable_ranges":[233]}]',
    '',
    '[] []',
    '[{"major":2,"vulnerable_ranges":["foo"]}]',
    '[{"major":2,"vulnerable_ranges":["*"]}]',
    '[{"major":2,"vulnerable_ranges":["all versions before 2.3.3"]}]',
    '[{"major":2,"vulnerable_ranges":["< 2.0.0"]}]',
    '[{"major":3,"vulnerable_ranges":["< 2.3.3"]}]',
    '[{"major":3,"vulnerable_ranges":["<= 2.3.1"]}]',
  ].map(
    (siblings): SpecCase => [
      `the sibling list ${JSON.stringify(siblings)}`,
      'pnpm-benign-dedup',
      dedup('--sibling-alerts', siblings),
    ],
  ),
  [
    'a clean tree with an unreadable sibling range',
    'pnpm-benign-dedup',
    [
      '--line',
      '4',
      '--vulnerable',
      '< 4.0.3',
      '--baseline',
      CLEAN_BASELINE,
      '--sibling-alerts',
      '[{"major":2,"vulnerable_ranges":["foo"]}]',
      'picomatch',
      '>=4.0.3 <5',
    ],
  ],
  ...(
    [
      ['pnpm-benign-dedup-two-survivors', TWO_SURVIVOR_BASELINE],
      ['pnpm-benign-dedup-two-survivors', STALE_BASELINE],
      ['pnpm-benign-dedup-two-survivors', CONTROL_BASELINE],
      ['npm-ambient-drift', NPM_STALE_BASELINE],
      ['npm-ambient-drift', NPM_CONTROL_BASELINE],
    ] as const
  ).map(
    ([fixture, baseline], row): SpecCase => [
      `a two-survivor or drift baseline, row ${row + 1}`,
      fixture,
      [
        '--line',
        '4',
        '--vulnerable',
        '< 4.0.3',
        '--baseline',
        baseline,
        '--sibling-alerts',
        '[]',
        'picomatch',
        '>=4.0.3 <5',
      ],
    ],
  ),
]

/** The one spec example that changes its copy first: the override-placed shape. */
const PLACED_FIXTURE = 'npm-override-placed-parent'

const PLACED_ARGS = ['--line', '5', '--vulnerable', '< 5.0.9', 'brace-expansion', '>=5.0.9 <6']

type JsonRecord = Record<string, JsonValue>

/** `placed_partial_state` of the spec, on a copy. */
const placedPartialState = (dir: string): void => {
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as JsonRecord
  const overrides = manifest.overrides as JsonRecord
  overrides.lerna = {
    ...(overrides.lerna as JsonRecord),
    nx: { '.': '>=22.7.7 <23', 'brace-expansion': '>=5.0.9 <6' },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const lockPath = join(dir, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as JsonRecord
  const packages = lock.packages as JsonRecord
  const nx = packages['node_modules/nx'] as JsonRecord
  nx.dependencies = { ...((nx.dependencies ?? {}) as JsonRecord), 'brace-expansion': '>=5.0.9 <6' }
  packages['node_modules/nx/node_modules/brace-expansion'] = { version: '5.0.9' }
  packages['node_modules/foo'] = { version: '1.0.0', dependencies: { 'brace-expansion': '^5.0.4' } }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2))
}

const specFixtures: readonly string[] = [
  ...new Set(
    [...readFileSync(SPEC, 'utf8').matchAll(/use_fixture ([A-Za-z0-9._-]+)/g)].map(
      (match) => match[1] as string,
    ),
  ),
].sort()

describe('the validate cases', () => {
  it('cover each fixture that spec/node_validate_spec.sh uses', () => {
    const covered = new Set([...SPEC_CASES.map(([, fixture]) => fixture), PLACED_FIXTURE])
    expect([...covered].sort()).toEqual(specFixtures)
    expect(specFixtures.length).toBeGreaterThan(0)
  })
})

describe('validate parity on the spec cases', () => {
  it.each(SPEC_CASES)('agrees on %s (%s)', (_title, fixture, args) => {
    expect(validateBoth(join(FIXTURES_ROOT, fixture), args)).toBe('agree')
  })

  it('agrees on the override-placed shape that the spec writes', () => {
    const copy = useFixture(PLACED_FIXTURE)
    try {
      placedPartialState(copy.path)
      expect(validateBoth(copy.path, PLACED_ARGS)).toBe('agree')
    } finally {
      copy.cleanup()
    }
  })

  it('has no typed call for an unknown option, which only the argument list can carry', () => {
    expect(callOf(['--nope', 'undici', '>=6.0.0 <7'])).toBeNull()
  })
})

/** The major of a version, for the arguments of a generated case only. */
const majorOf = (version: string): number => Number.parseInt(version.replace(/^[v=]+/, ''), 10)

type Generated = readonly [fixture: string, args: readonly string[]]

/** The baseline of `pkg`, with more versions on the copy that bash gave. */
const widened = (baseline: string, extra: readonly string[]): string => {
  const parsed = JSON.parse(baseline) as { versions: JsonValue[] }
  return JSON.stringify({
    ...parsed,
    versions: [...parsed.versions, ...extra.map((version) => ({ version, path: 'baseline-only' }))],
  })
}

/** The cases for each package of one fixture, from what bash answers there. */
const generatedFor = (fixture: string): Generated[] => {
  const dir = join(FIXTURES_ROOT, fixture)
  const map = runBash({ command: ADAPTER, args: ['resolution_map'], cwd: dir })
  if (map.status !== 0) return []
  const { resolutions } = JSON.parse(map.stdout) as { resolutions: Record<string, string[]> }
  return Object.entries(resolutions).flatMap(([pkg, versions]): Generated[] => {
    const baseline = runBash({
      command: ADAPTER,
      args: ['resolved_versions', pkg],
      cwd: dir,
    }).stdout
    const majors = [...new Set(versions.map(majorOf))].filter(Number.isInteger)
    const cases: Generated[] = [
      [fixture, [pkg, '>=0.0.0']],
      [fixture, [pkg, '<0.0.1']],
    ]
    for (const major of majors) {
      const onLine = versions.filter((version) => majorOf(version) === major)
      const low = onLine[0] as string
      const high = onLine.at(-1) as string
      cases.push([
        fixture,
        [
          '--line',
          String(major),
          '--vulnerable',
          `< ${low}`,
          pkg,
          `>=${major}.0.0 <${major + 1}.0.0`,
        ],
      ])
      cases.push([
        fixture,
        [
          '--line',
          String(major),
          '--vulnerable',
          `<= ${high}`,
          '--baseline',
          baseline,
          '--sibling-alerts',
          '[]',
          pkg,
          `>=${high}`,
        ],
      ])
    }
    const [line, ...others] = majors
    if (line === undefined) return cases
    const moves = (base: string, siblings: string | null): readonly string[] => [
      '--line',
      String(line),
      '--vulnerable',
      '< 0.0.1',
      '--baseline',
      base,
      ...(siblings === null ? [] : ['--sibling-alerts', siblings]),
      pkg,
      '>=0.0.0',
    ]
    cases.push([fixture, moves(widened(baseline, ['999.0.0']), '[]')])
    if (others.length === 0) return cases
    // A prerelease below each other line: the line moves onto a version it
    // had, which is the dedup shape of #105.
    const deduped = widened(
      baseline,
      others.map((major) => `${major}.0.0-0`),
    )
    // A version above each other line: the line keeps a version that was not
    // its max.
    const raised = widened(
      baseline,
      others.map((major) => `${major}.999.0`),
    )
    for (const siblings of [
      '[]',
      null,
      `[{"major":${others[0]},"vulnerable_ranges":[]}]`,
      '[{"major":null,"vulnerable_ranges":[">= 0.0.0-0"]}]',
      '[{"major":null,"vulnerable_ranges":["foo"]}]',
    ]) {
      cases.push([fixture, moves(deduped, siblings)])
    }
    cases.push([fixture, moves(raised, '[]')])
    return cases
  })
}

const generated: readonly Generated[] = specFixtures.flatMap(generatedFor)

describe('validate parity on the generated cases', () => {
  it('finds cases to compare', () => {
    expect(generated.length).toBeGreaterThan(specFixtures.length)
  })

  it.each(generated)('agrees on %s %j', (fixture, args) => {
    expect(validateBoth(join(FIXTURES_ROOT, fixture), args)).toBe('agree')
  })

  it.each([
    ['', '>=1.0.0'],
    ['not-in-this-lockfile', '>=1.0.0'],
    ['undici', ''],
    ['undici', ' '],
    ['undici', '>=1 ||'],
  ])('agrees on validate %j %j', (pkg, range) => {
    expect(validateBoth(join(FIXTURES_ROOT, 'yarn-multi-major'), [pkg, range])).toBe('agree')
  })

  it.each([
    [['--line', '', '--vulnerable', NOHIT]],
    [['--line', '-1', '--vulnerable', NOHIT]],
    [['--line', '1.5', '--vulnerable', NOHIT]],
    [['--line', '07', '--vulnerable', NOHIT]],
    [['--line', '9', '--vulnerable', NOHIT]],
    [['--line', '7', '--vulnerable', '\n']],
    [['--line', '7', '--vulnerable', '< 1.0.0\n>= 7.27.0']],
    [['--line', '7', '--vulnerable', '>= 7.27.0', '--vulnerable', '>= 7.27.0']],
    [['--line', '7', '--vulnerable', NOHIT, '--baseline', '']],
    [
      [
        '--line',
        '7',
        '--vulnerable',
        NOHIT,
        '--baseline',
        '{"package":"undici","versions":[]}',
        '--sibling-alerts',
        '',
      ],
    ],
    [['--line', '7', '--vulnerable', NOHIT, '--baseline', '﻿{"package":"undici","versions":[]}']],
    [
      [
        '--line',
        '7',
        '--vulnerable',
        NOHIT,
        '--baseline',
        '{"package":"undici","versions":[{"version":""}]}',
      ],
    ],
    [['--line', '7']],
    [['--', '--line']],
  ])('agrees on validate %j undici', (flags) => {
    const range = flags.includes('--') ? [] : ['undici', '>=7.0.0 <8']
    expect(validateBoth(join(FIXTURES_ROOT, 'yarn-multi-major'), [...flags, ...range])).toBe(
      'agree',
    )
  })
})

/** A linked worktree in a sandbox that holds a copy of `fixture`, and its primary checkout. */
const worktreeWith = (fixture: string) => {
  const sandbox = createSandbox()
  const base = realpathSync(sandbox.path)
  const git = createGitFixtures(sandbox)
  const main = git.createAt(base, 'main')
  git.branch(main, 'fix')
  const root = join(base, 'wt')
  git.worktree(main, root, 'fix')
  cpSync(join(FIXTURES_ROOT, fixture), root, { recursive: true, verbatimSymlinks: true })
  cpSync(join(FIXTURES_ROOT, fixture), main, { recursive: true, verbatimSymlinks: true })
  const plain = join(base, 'plain')
  mkdirSync(plain)
  cpSync(join(FIXTURES_ROOT, fixture), plain, { recursive: true, verbatimSymlinks: true })
  /** A PATH of real tools and no package manager, with an empty file for each tool named. */
  const pathWith = (...tools: string[]): string => {
    const directory = join(base, `stubs-${tools.join('-') || 'none'}`)
    mkdirSync(directory, { recursive: true })
    for (const tool of tools) writeFileSync(join(directory, tool), '', { mode: 0o755 })
    return `${directory}${delimiter}${sandbox.pathWithout()}`
  }
  return { root, main, plain, pathWith }
}

/**
 * Run node.sh with one PATH and umask 022. The umask fixes the mode that
 * `chmod +x` gives, so that the mode of the bash shim is the same on each
 * machine.
 */
const bashWith = (cwd: string, path: string, ...args: string[]): BashResult =>
  runBash({
    command: '/bin/sh',
    args: ['-c', 'umask 022 && exec env "PATH=$0" "$@"', path, ADAPTER, ...args],
    cwd,
  })

/** The file at `path`: its text and its mode, or null when there is no file. */
const fileAt = (path: string): { text: string; mode: number } | null =>
  existsSync(path) ? { text: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 } : null

type ShimCase = readonly [
  title: string,
  fixture: string,
  tools: readonly string[],
  dir: string,
  runner: string | null,
]

const SHIM_CASES: readonly ShimCase[] = [
  ['npm on PATH', 'npm-v3', ['npm'], 'shim-bin', null],
  ['yarn on PATH', 'yarn-berry', ['yarn'], 'shim-bin', null],
  ['pnpm on PATH', 'pnpm-v9', ['pnpm'], 'shim-bin', null],
  ['no npm on PATH', 'npm-v3', [], 'shim-bin', null],
  ['no pnpm, and corepack on PATH', 'pnpm-v9', ['corepack'], 'shim-bin', null],
  ['a vendored yarn', 'yarn-vendored', [], 'shim-bin', null],
  ['a vendored yarn, with yarn on PATH', 'yarn-vendored', ['yarn'], 'shim-bin', null],
  ['a runner that the caller names', 'yarn-vendored', ['yarn'], 'shim-bin', 'corepack yarn'],
  ['an empty runner', 'npm-v3', ['npm'], 'shim-bin', ''],
  ['a nested directory', 'npm-v3', [], 'a/b/c', null],
  ['a directory with a slash at the end', 'npm-v3', [], 'shim-bin/', null],
  ['an absolute directory', 'npm-v3', [], '/ABSOLUTE/shim-bin', null],
]

describe('shim parity in a linked worktree', () => {
  it.each(SHIM_CASES)(
    'agrees on %s',
    (_title, fixture, tools, given, runner) => {
      const scene = worktreeWith(fixture)
      const dir = given.replace('/ABSOLUTE', join(scene.root, '..', 'out'))
      const path = scene.pathWith(...tools)
      const env = { PATH: path }
      const tree = treeOf(scene.root, env)
      const shimFile = join(resolve(scene.root, dir), tree.detection.pm)
      const answer = bashWith(scene.root, path, 'shim', dir, ...(runner === null ? [] : [runner]))
      const bashFile = fileAt(shimFile)
      rmSync(resolve(scene.root, dir), { recursive: true, force: true })
      const envelope = node.shim(tree, dir, { env, ...(runner === null ? {} : { runner }) })
      const tsFile = fileAt(shimFile)
      expect(answer.status).toBe(0)
      expect(envelope.outcome).toBe('ok')
      expect(
        firstDifference(
          JSON.parse(answer.stdout) as JsonValue,
          envelope.outcome === 'ok' ? asJson(envelope.value) : null,
        ),
      ).toBeNull()
      expect(tsFile).toEqual(bashFile)
    },
    GIT_TIMEOUT_MS,
  )

  it.each([
    ['a primary checkout', 'main', 'shim-bin'],
    ['a directory in no repository', 'plain', 'shim-bin'],
    ['an empty directory name', 'root', ''],
    ['a directory that is a file', 'root', 'package.json'],
  ] as const)(
    'agrees on the refusal in %s, and writes nothing',
    (_title, where, dir) => {
      const scene = worktreeWith('npm-v3')
      const cwd = scene[where]
      const path = scene.pathWith()
      const answer = bashWith(cwd, path, 'shim', dir)
      const env = { PATH: path }
      const envelope = node.shim(treeOf(cwd, env), dir, { env })
      expect(envelope.outcome).toBe('failed')
      if (envelope.outcome === 'ok') return
      expect(refusalAgreement(answer, envelope)).toBe('agree')
      expect(existsSync(join(cwd, 'shim-bin'))).toBe(false)
    },
    GIT_TIMEOUT_MS,
  )

  it(
    'agrees on the refusal when the shim file is a directory',
    () => {
      const scene = worktreeWith('npm-v3')
      mkdirSync(join(scene.root, 'shim-bin', 'npm'), { recursive: true })
      const path = scene.pathWith()
      const answer = bashWith(scene.root, path, 'shim', 'shim-bin')
      const env = { PATH: path }
      const envelope = node.shim(treeOf(scene.root, env), 'shim-bin', { env })
      expect(envelope.outcome).toBe('failed')
      if (envelope.outcome === 'ok') return
      expect(refusalAgreement(answer, envelope)).toBe('agree')
    },
    GIT_TIMEOUT_MS,
  )
})

describe('install parity in a linked worktree', () => {
  it.each([
    ['a primary checkout', 'main'],
    ['a directory in no repository', 'plain'],
  ] as const)(
    'agrees on the refusal in %s, and installs nothing',
    async (_title, where) => {
      const scene = worktreeWith('npm-v3')
      const cwd = scene[where]
      const path = scene.pathWith('npm')
      const lockBefore = readFileSync(join(cwd, 'package-lock.json'), 'utf8')
      const answer = bashWith(cwd, path, 'install')
      const env = { PATH: path }
      const envelope = await node.install(treeOf(cwd, env), { run, env })
      expect(envelope.outcome).toBe('failed')
      if (envelope.outcome === 'ok') return
      expect(refusalAgreement(answer, envelope)).toBe('agree')
      // npm-v3 ships `node_modules/express`, and an install adds more.
      expect(readdirSync(join(cwd, 'node_modules'))).toEqual(['express'])
      expect(readFileSync(join(cwd, 'package-lock.json'), 'utf8')).toBe(lockBefore)
    },
    GIT_TIMEOUT_MS,
  )

  it(
    'agrees on the message and the status when the package manager is not on PATH',
    async () => {
      const scene = worktreeWith('npm-v3')
      const path = scene.pathWith()
      const answer = bashWith(scene.root, path, 'install')
      const env = { PATH: path }
      const envelope = await node.install(treeOf(scene.root, env), { run, env })
      expect(envelope.outcome).toBe('ok')
      if (envelope.outcome !== 'ok') return
      expect({
        status: envelope.value.status,
        first: envelope.value.stderr.split('\n')[0],
        stdout: envelope.value.stdout,
      }).toEqual({
        status: answer.status,
        first: answer.stderr.split('\n')[0],
        stdout: answer.stdout,
      })
      expect(answer.stderr.split('\n')[0]).toBe('Running: npm install')
    },
    GIT_TIMEOUT_MS,
  )
})
