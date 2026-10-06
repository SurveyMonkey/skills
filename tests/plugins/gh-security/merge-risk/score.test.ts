// The merge-risk scorer, at its seam: `scoreMergeRisk` with a request, an
// adapter and a tree. Each tree is built in a sandbox. The adapter is the
// real node one, or a stand-in through the adapter parameter for an answer
// that breaks the contract (`mocking.md`, "The injected collaborator").
//
// The expected values are written by hand from ADR 006 and the header of
// `score-merge-risk.sh`. `parity-score-merge-risk.test.ts` compares the port
// with the script on the shellspec tables.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import { failed, ok } from '#gh-security/lib/envelope.ts'
import {
  type RiskAdapter,
  type RiskReport,
  type RiskRequest,
  scoreMergeRisk,
} from '#gh-security/merge-risk/score.ts'
import { createSandbox } from '#harness/sandbox.ts'

const NODE: RiskAdapter = {
  name: 'node',
  compareVersions: node.compareVersions,
  rangeFacts: node.rangeFacts,
}

/** A workflow that triggers on a pull request and runs a check: F5 0. */
const CHECKED_CI = 'on: pull_request\njobs:\n  t:\n    steps:\n      - run: npm test\n'

/** Build a tree from paths and their text. */
const tree = (files: Readonly<Record<string, string>>): string => {
  const root = createSandbox().join('tree')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  mkdirSync(root, { recursive: true })
  return root
}

const manifest = (fields: Record<string, unknown>): string => JSON.stringify(fields)

const request = (change: Partial<RiskRequest> = {}): RiskRequest => ({
  package: 'lodash',
  before: '1.0.0',
  after: '1.0.1',
  why: { relationship: 'direct', dev_only: true, parents: [] },
  whyLabel: 'why.json',
  overrideScope: 'none',
  declaredRanges: 'none',
  ...change,
})

const scored = (
  root: string,
  change: Partial<RiskRequest> = {},
  adapter: RiskAdapter = NODE,
): RiskReport => {
  const answer = scoreMergeRisk(request(change), adapter, root)
  if (answer.outcome !== 'ok') throw new Error(answer.error)
  return answer.value
}

const errorOf = (
  root: string,
  change: Partial<RiskRequest> = {},
  adapter: RiskAdapter = NODE,
): string => {
  const answer = scoreMergeRisk(request(change), adapter, root)
  if (answer.outcome === 'ok') throw new Error('the scorer answered')
  return answer.error
}

const scores = (report: RiskReport): number[] => report.factors.map((entry) => entry.score)

/** A tree where every factor but the ones a request moves is 0. */
const quiet = (): string =>
  tree({
    'package.json': manifest({ scripts: { build: 'tsc', test: 'vitest' } }),
    '.github/workflows/ci.yml': CHECKED_CI,
  })

describe('the factors and the bands (ADR 006)', () => {
  it('rates seven factors of 0 to 2, so the maximum is 14', () => {
    const report = scored(quiet())
    expect(report.factors.map((entry) => [entry.id, entry.name])).toEqual([
      ['F1', 'Version delta'],
      ['F2', 'Runtime exposure'],
      ['F3', 'Usage surface'],
      ['F4', 'Test coverage'],
      ['F5', 'CI presence'],
      ['F6', 'Override blast radius'],
      ['F7', 'Declared-range distance'],
    ])
    expect({ score: report.score, max: report.max, band: report.band }).toEqual({
      score: 0,
      max: 14,
      band: 'Low',
    })
  })

  // Each row sets the total with F2 (why), F1 (the delta), F4 (the scripts),
  // F5 (no workflow) and F6 (the scope). No row trips an escalation.
  it.each([
    ['3, the top of Low', 'direct', true, '1.0.1', 'none', [0, 0, 0, 1, 2, 0, 0], 'Low'],
    [
      '4, the bottom of Medium',
      'transitive',
      false,
      '1.0.1',
      'none',
      [0, 1, 0, 1, 2, 0, 0],
      'Medium',
    ],
    [
      '6, the top of Medium',
      'transitive',
      false,
      '1.1.0',
      'bare-tightened',
      [1, 1, 0, 1, 2, 1, 0],
      'Medium',
    ],
    [
      '7, the bottom of High',
      'direct',
      false,
      '1.1.0',
      'bare-tightened',
      [1, 2, 0, 1, 2, 1, 0],
      'High',
    ],
  ] as const)(
    'bands a total of %s',
    (_name, relationship, devOnly, after, scope, factors, band) => {
      const root = tree({ 'package.json': manifest({ scripts: { test: 'vitest' } }) })
      const report = scored(root, {
        after,
        overrideScope: scope,
        why: { relationship, dev_only: devOnly, parents: ['express'] },
      })
      expect({ factors: scores(report), band: report.band, escalated: report.escalated }).toEqual({
        factors,
        band,
        escalated: false,
      })
    },
  )

  it('never rates a major version delta Low', () => {
    const report = scored(quiet(), { after: '2.0.0' })
    expect({
      score: report.score,
      band: report.band,
      escalated: report.escalated,
      reason: report.escalation_reason,
    }).toEqual({
      score: 2,
      band: 'Medium',
      escalated: true,
      reason: 'a major version delta never rates Low',
    })
  })

  it('never rates a newly added unscoped override Low', () => {
    const report = scored(quiet(), { overrideScope: 'bare-added' })
    expect([report.score, report.band, report.escalation_reason]).toEqual([
      2,
      'Medium',
      'a newly added unscoped override never rates Low',
    ])
  })

  it('does not escalate a major delta whose total is already Medium', () => {
    const root = tree({ 'package.json': manifest({ scripts: { test: 'vitest' } }) })
    const report = scored(root, { after: '2.0.0' })
    expect([report.score, report.band, report.escalated, report.escalation_reason]).toEqual([
      5,
      'Medium',
      false,
      null,
    ])
  })

  // No source imports and no scripts makes F4 2: nothing verifies the result.
  // A workflow that runs a check keeps F5 at 0, so the total stays below High.
  const untested = (): string =>
    tree({ 'package.json': manifest({}), '.github/workflows/ci.yml': CHECKED_CI })

  // F1 is 2 here, so a Low blocker also applies. The reason names the High one alone.
  it('never rates a multi-major jump on a runtime dependency with no test signal below High', () => {
    const report = scored(untested(), {
      before: '9.0.1',
      after: '11.1.1',
      why: { relationship: 'transitive', dev_only: false, parents: ['express'] },
      overrideScope: 'scoped',
    })
    expect([scores(report), report.band, report.escalation_reason]).toEqual([
      [2, 1, 0, 2, 0, 0, 1],
      'High',
      'a multi-major jump on a runtime dependency with no test signal never rates below High',
    ])
    expect(report.markdown.split('\n')[2]).toBe(
      '> Escalated from Medium: a multi-major jump on a runtime dependency with no test signal never rates below High.',
    )
  })

  it.each([
    [
      'a dev-only chain',
      { relationship: 'direct', dev_only: true, parents: [] },
      '11.1.1',
      'Medium',
    ],
    [
      'one major line',
      { relationship: 'transitive', dev_only: false, parents: ['x'] },
      '10.0.0',
      'Medium',
    ],
  ])('leaves %s where the total puts it', (_name, why, after, band) => {
    const report = scored(untested(), { before: '9.0.1', after, why })
    expect([report.band, report.escalated]).toEqual([band, false])
  })

  it('does not mark a High total as escalated by the High blocker', () => {
    const report = scored(untested(), {
      before: '9.0.1',
      after: '11.1.1',
      why: { relationship: 'direct', dev_only: false, parents: [] },
      overrideScope: 'bare-added',
    })
    expect([report.score, report.band, report.escalated]).toEqual([9, 'High', false])
  })

  // The marks are a green, a yellow and a red circle.
  it('writes the markdown table, with the mark of each band', () => {
    expect(scored(quiet()).markdown).toBe(
      '## Merge risk: \u{1F7E2} Low (0/14)\n\n' +
        '| Factor | Score | Evidence |\n|---|---|---|\n' +
        '| Version delta | 0 | 1.0.0 -> 1.0.1 (patch) |\n' +
        '| Runtime exposure | 0 | dev-only dependency chain |\n' +
        '| Usage surface | 0 | no source imports found for lodash (build or tooling only) |\n' +
        '| Test coverage | 0 | no source imports; a build script exists, so a broken tooling pin fails at build |\n' +
        '| CI presence | 0 | .github/workflows/ci.yml triggers on pull_request and runs: npm test |\n' +
        '| Override blast radius | 0 | no override applied by this change |\n' +
        '| Declared-range distance | 0 | no major line crossed; caller stated no dependent ranges could be read |\n',
    )
    expect(scored(quiet(), { after: '2.0.0' }).markdown).toMatch(
      /^## Merge risk: \u{1F7E1} Medium \(2\/14\)/u,
    )
    expect(scored(untested(), { after: '2.0.0', why: {} }).markdown).toMatch(
      /^## Merge risk: \u{1F534} High \(7\/14\)/u,
    )
  })
})

describe('F1 and F7: the version delta and the declared ranges', () => {
  it('scores no baseline as a major, with the delta unknown', () => {
    const report = scored(quiet(), { before: '' })
    expect([report.factors[0], report.delta]).toEqual([
      {
        id: 'F1',
        name: 'Version delta',
        score: 2,
        evidence: 'no pre-fix baseline available; scored as major',
      },
      'unknown',
    ])
  })

  it.each([
    ['1.0.0', '1.1.0', 1, '1.0.0 -> 1.1.0 (minor)'],
    ['1.0.0', '3.0.0', 2, '1.0.0 -> 3.0.0 (2 majors)'],
    ['1.0.0-rc.1', '1.0.0', 0, '1.0.0-rc.1 -> 1.0.0 (prerelease)'],
  ])('scores %s -> %s as F1 %i', (before, after, score, evidence) => {
    expect(scored(quiet(), { before, after }).factors[0]).toMatchObject({ score, evidence })
  })

  // F7 is the majors past the widest escaped floor, less one, plus a crossed
  // pin, and never more than 2.
  it.each([
    ['1.0.0', '2.0.0', [], 0, 'one major line crossed; no dependent range could be evaluated'],
    ['1.0.0', '3.0.0', [], 1, '2 major lines crossed; no dependent range could be evaluated'],
    ['1.0.0', '7.0.0', [], 2, '6 major lines crossed; no dependent range could be evaluated'],
    ['9.0.1', '9.1.0', ['^7'], 1, '2 major lines crossed; dependents declare ^7'],
    [
      '1.0.0',
      '3.0.0',
      ['~1.0.0'],
      2,
      '2 major lines crossed; dependents declare ~1.0.0; crosses the pinned range ~1.0.0',
    ],
    [
      '6.14.0',
      '6.15.0',
      ['~6.14.0'],
      1,
      'crosses the pinned range ~6.14.0; dependents declare ~6.14.0',
    ],
    ['11.0.0', '11.1.1', ['>=1'], 0, 'no major line crossed; dependents declare >=1'],
  ])('scores %s -> %s against %j as F7 %i', (before, after, ranges, score, evidence) => {
    const report = scored(quiet(), { before, after, declaredRanges: ranges })
    expect(report.factors[6]).toMatchObject({ score, evidence })
  })

  it('names the escaped ranges in F1, and the first crossed pin in F7', () => {
    const report = scored(quiet(), {
      before: '9.0.1',
      after: '11.1.1',
      declaredRanges: ['^9', '~9.0.0', '~10.0.0', '^11'],
    })
    expect([report.factors[0]?.evidence, report.factors[6]?.evidence]).toEqual([
      '9.0.1 -> 11.1.1 (2 majors; parents declare ^9, ~9.0.0, ~10.0.0)',
      '2 major lines crossed; dependents declare ^9, ~9.0.0, ~10.0.0, ^11; crosses the pinned range ~9.0.0',
    ])
  })

  it('takes one range for each line, once, and skips a line of blanks', () => {
    const asked: string[] = []
    const adapter: RiskAdapter = {
      ...NODE,
      rangeFacts: (range, version) => {
        asked.push(range)
        return node.rangeFacts(range, version)
      },
    }
    const report = scored(
      quiet(),
      { declaredRanges: ['^1\n~1.0.0', '^1', ' \t', '', '~1.0.0\n'] },
      adapter,
    )
    expect(asked).toEqual(['^1', '~1.0.0'])
    expect(report.declared_ranges).toEqual(['^1', '~1.0.0', ' \t'])
  })

  it('counts each range it cannot evaluate apart, and says so', () => {
    const report = scored(quiet(), { declaredRanges: ['workspace:^', 'latest', '^1.0.0'] })
    expect(report.factors[6]?.evidence).toBe(
      'no major line crossed; dependents declare ^1.0.0; 2 dependent ranges not evaluated (workspace:^, latest)',
    )
    expect(scored(quiet(), { declaredRanges: ['latest'] }).factors[6]?.evidence).toBe(
      'no major line crossed; no dependent range could be evaluated; 1 dependent range not evaluated (latest)',
    )
  })

  it('reports the sentinel, and not an empty list, when no range could be read', () => {
    expect(scored(quiet()).declared_ranges).toBe('none-stated')
    expect(scored(quiet(), { declaredRanges: [] }).declared_ranges).toEqual([])
  })

  it('reads a null majors_ahead as no distance, and still counts the pin', () => {
    const adapter: RiskAdapter = {
      ...NODE,
      rangeFacts: () =>
        ok({
          parseable: true,
          satisfied: false,
          pinned: true,
          floor_major: null,
          majors_ahead: null,
        }),
    }
    const report = scored(quiet(), { declaredRanges: ['x'] }, adapter)
    expect([report.majors_crossed, report.factors[6]?.score]).toEqual([0, 1])
  })
})

describe('the adapter contract', () => {
  const answering = (cmp: unknown, facts: unknown = {}): RiskAdapter => ({
    name: 'stub',
    compareVersions: () => ok(cmp),
    rangeFacts: () => ok(facts),
  })
  const FACTS = { parseable: true, satisfied: false, pinned: false, majors_ahead: 2 }
  const CONTRACT = '(docs/adr/001-ecosystem-adapter-contract.md)'

  it.each([
    ['no object', undefined, "compare_versions '1.0.0' '1.0.1' emitted no JSON object on stdout"],
    ['a list', [], "compare_versions '1.0.0' '1.0.1' emitted no JSON object on stdout"],
    ['no delta', { major_distance: 0 }, "emitted no usable 'delta'"],
    ['a null delta', { delta: null, major_distance: 0 }, "emitted no usable 'delta'"],
    ['a delta outside the enum', { delta: 'MAJOR', major_distance: 0 }, "answered delta 'MAJOR'"],
    ['a delta that is not text', { delta: 5, major_distance: 0 }, "answered delta '5'"],
    ['no major_distance', { delta: 'patch' }, "emitted no usable 'major_distance'"],
    [
      'a null major_distance',
      { delta: 'patch', major_distance: null },
      "no usable 'major_distance'",
    ],
    [
      'a text major_distance',
      { delta: 'patch', major_distance: '2' },
      "non-negative integer, got '2'",
    ],
    ['a negative major_distance', { delta: 'patch', major_distance: -1 }, "got '-1'"],
    ['a fraction', { delta: 'patch', major_distance: 1.5 }, "got '1.5'"],
  ])('refuses a compare_versions answer with %s', (_name, cmp, text) => {
    const error = errorOf(quiet(), {}, answering(cmp))
    expect(error).toMatch(/^adapter stub: /)
    expect(error).toContain(text)
    expect(error).toContain(CONTRACT)
  })

  it.each([
    ['no object', null, "range_facts '^9' '1.0.1' emitted no JSON object on stdout"],
    ...['parseable', 'satisfied', 'pinned', 'majors_ahead'].map((key) => [
      `no ${key}`,
      Object.fromEntries(Object.entries(FACTS).filter(([name]) => name !== key)),
      `range_facts '^9' emitted no '${key}' field`,
    ]),
    [
      'a text parseable',
      { ...FACTS, parseable: 'true' },
      "parseable for '^9' must be true or false, got 'true'",
    ],
    [
      'a text majors_ahead',
      { ...FACTS, majors_ahead: 'two' },
      "majors_ahead for '^9' must be a non-negative integer, got 'two'",
    ],
    [
      'a text satisfied',
      { ...FACTS, satisfied: 'no' },
      "satisfied for '^9' must be true or false, got 'no'",
    ],
    [
      'a null pinned',
      { ...FACTS, pinned: null },
      "pinned for '^9' must be true or false, got '__null__'",
    ],
  ] as [string, unknown, string][])(
    'refuses a range_facts answer with %s',
    (_name, facts, text) => {
      const error = errorOf(quiet(), { declaredRanges: ['^9'] }, answering({}, facts))
      expect(error).toContain(text)
      expect(error).toContain(CONTRACT)
    },
  )

  it('passes a failed verb on as it is', () => {
    const adapter: RiskAdapter = {
      ...NODE,
      compareVersions: () => failed('compare: no answer'),
    }
    expect(scoreMergeRisk(request(), adapter, quiet())).toEqual(failed('compare: no answer'))
    const facts: RiskAdapter = { ...NODE, rangeFacts: () => failed('facts: no answer') }
    expect(scoreMergeRisk(request({ declaredRanges: ['^1'] }), facts, quiet())).toEqual(
      failed('facts: no answer'),
    )
  })
})

describe('the inputs it cannot read', () => {
  it('refuses an override scope outside the four', () => {
    expect(errorOf(quiet(), { overrideScope: 'global' })).toBe(
      '--override-scope must be none, scoped, bare-tightened, or bare-added',
    )
  })

  it.each([[undefined], [null], [[]], ['direct']])('refuses a why payload of %j', (why) => {
    expect(errorOf(quiet(), { why })).toMatch(
      /^--why-json why\.json did not contain a JSON object\./,
    )
  })

  it('refuses a tree with no package.json, and one where it is a directory', () => {
    const root = tree({ 'src/a.js': '' })
    expect(errorOf(root)).toMatch(new RegExp(`^no package\\.json in ${root}\\. `))
    mkdirSync(join(root, 'package.json'))
    expect(errorOf(root)).toMatch(/^no package\.json in /)
  })

  it.each([['{nope'], ['[]'], ['"text"']])('refuses a package.json of %s', (text) => {
    const root = tree({ 'package.json': text })
    expect(errorOf(root)).toBe(
      `package.json in ${root} does not parse as a JSON object. Read as an absent manifest it ` +
        'scores the fix as having no test script and no entry points, which is lower risk than the truth.',
    )
  })

  const locked = (root: string, path: string, check: () => void): void => {
    chmodSync(join(root, path), 0)
    try {
      check()
    } finally {
      chmodSync(join(root, path), 0o755)
    }
  }

  it('refuses a workflows directory it cannot read', () => {
    const root = quiet()
    locked(root, '.github/workflows', () => {
      expect(errorOf(root)).toMatch(/^\.github\/workflows exists but cannot be read, /)
    })
  })

  it('refuses a workflow file it cannot read', () => {
    const root = quiet()
    locked(root, '.github/workflows/ci.yml', () => {
      expect(errorOf(root)).toMatch(/^\.github\/workflows\/ci\.yml cannot be read, /)
    })
  })

  it.each([
    ['a source file', 'src/a.js'],
    ['a source directory', 'src'],
  ])('refuses a tree with %s it cannot read', (_name, path) => {
    const root = tree({ 'package.json': manifest({}), 'src/a.js': "require('lodash')\n" })
    locked(root, path, () => {
      expect(errorOf(root)).toBe(
        `could not read the tree under ${root} while searching for imports of lodash (the read ` +
          'failed with EACCES). A partial read scores the usage surface and its test coverage as ' +
          'zero, so this fails instead of guessing.',
      )
    })
  })

  it('does not read a directory that no walk enters', () => {
    const root = tree({ 'package.json': manifest({}), 'node_modules/x/a.js': "require('lodash')" })
    locked(root, 'node_modules', () => {
      expect(scored(root).factors[2]?.score).toBe(0)
    })
  })

  // The import search reads every source file, test files too. With no name
  // to search for, only the test walk reads them, and it skips what it cannot
  // read, as `grep 2>/dev/null` did.
  it('skips a test file it cannot read when no import search ran', () => {
    const root = tree({
      'package.json': manifest({ scripts: { test: 'vitest' } }),
      'tests/a.test.js': "require('lodash')",
    })
    locked(root, 'tests/a.test.js', () => {
      const report = scored(root, { why: { relationship: 'transitive', parents: [' '] } })
      expect([report.factors[3]?.score, report.coverage]).toEqual([
        1,
        { affected: 0, covered: 0, uncovered: [] },
      ])
    })
  })
})

describe('F2, F3 and F4: exposure, usage surface and test coverage', () => {
  it.each([
    ['the text true for dev_only', { relationship: 'direct', dev_only: 'true' }, 0],
    ['no relationship', { dev_only: false }, 1],
    ['a null relationship', { relationship: null }, 1],
    ['a direct dependency', { relationship: 'direct', dev_only: false }, 2],
  ])('scores F2 for %s', (_name, why, score) => {
    expect(scored(quiet(), { why }).factors[1]?.score).toBe(score)
  })

  const imports = (count: number): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`src/m${index}.js`, "import x from 'lodash'"]),
    )

  it.each([
    [5, 1, 'imported in 5 module(s) for lodash'],
    [6, 2, 'imported in 6 module(s) for lodash'],
  ])('scores %i importing modules as F3 %i', (count, score, evidence) => {
    const root = tree({ 'package.json': manifest({}), ...imports(count) })
    expect(scored(root, { why: { relationship: 'direct' } }).factors[2]).toMatchObject({
      score,
      evidence,
    })
  })

  it.each([
    ['main', { main: './src/m0.js' }],
    ['a bin map', { bin: { a: 'other.js', b: 'src/m0.js' } }],
    ['a bin text', { bin: 'src/m0.js' }],
    ['one of two words', { module: 'x.js src/m0.js' }],
  ])('scores an import in a declared entry point, %s, as F3 2', (_name, fields) => {
    const root = tree({ 'package.json': manifest(fields), ...imports(1) })
    expect(scored(root, { why: { relationship: 'direct' } }).factors[2]).toEqual({
      id: 'F3',
      name: 'Usage surface',
      score: 2,
      evidence: 'imported in 1 module(s) for lodash, including a declared entry point',
    })
  })

  it('does not take a browser map as an entry point', () => {
    const root = tree({
      'package.json': manifest({ browser: { 'src/m0.js': false } }),
      ...imports(1),
    })
    expect(scored(root, { why: { relationship: 'direct' } }).factors[2]?.score).toBe(1)
  })

  it.each([
    ['ESM', "import { a } from 'lodash/fp'"],
    ['a side effect', "import 'lodash'"],
    ['a dynamic import', 'await import ( "lodash" )'],
    ['CJS', "const _ = require ('lodash')"],
  ])('finds an import in the %s form', (_name, line) => {
    const root = tree({ 'package.json': manifest({}), 'src/a.ts': line })
    expect(scored(root, { why: { relationship: 'direct' } }).coverage.affected).toBe(1)
  })

  it.each([
    ['another package', "import 'lodash-es'"],
    ['a dot read as any character', "import 'lodashXes'"],
    ['a file that is not source', null],
  ])('does not count %s', (_name, line) => {
    const files: Record<string, string> =
      line === null ? { 'src/a.json': "require('lodash')" } : { 'src/a.js': line }
    const root = tree({ 'package.json': manifest({}), ...files })
    expect(scored(root, { why: { relationship: 'direct' } }).coverage.affected).toBe(0)
  })

  it('reads the parents of a transitive package, and no more than 20 lines of them', () => {
    const parents = Array.from({ length: 21 }, (_, index) => `p${index}`)
    const root = tree({
      'package.json': manifest({}),
      'src/a.js': "require('p19')",
      'src/b.js': "require('p20')",
    })
    const report = scored(root, { why: { relationship: 'transitive', parents } })
    expect(report.factors[2]?.evidence).toBe('imported in 1 module(s) for parents of lodash')
  })

  it.each([
    ['an object', { a: 'express' }, 1],
    ['white space only', [' '], 0],
    ['a value that is not text', [{ name: 'express' }], 0],
  ])('reads parents given as %s', (_name, parents, affected) => {
    const root = tree({ 'package.json': manifest({}), 'src/a.js': "require('express')" })
    const report = scored(root, { why: { relationship: 'transitive', parents } })
    expect(report.coverage.affected).toBe(affected)
  })

  it.each([
    ['no parents', []],
    ['an empty name', ['']],
    ['parents that are not a list', 'express'],
  ])('scores a transitive with %s as unmeasured', (_name, parents) => {
    const report = scored(quiet(), { why: { relationship: 'transitive', parents } })
    expect([scores(report).slice(2, 4), report.coverage]).toEqual([
      [2, 2],
      { affected: null, covered: null, uncovered: [] },
    ])
  })

  // F4 rows: each tree has one importing module, src/lib/a.js, and a test script.
  it.each([
    ['a sibling test', { 'src/lib/a.test.ts': '' }, 0],
    ['a sibling spec', { 'src/lib/a.spec.js': '' }, 0],
    ['an __tests__ entry', { 'src/lib/__tests__/a.jsx': '' }, 0],
    ['a sibling that is a directory', { 'src/lib/a.test.d/x.txt': '' }, 2],
    [
      'a test that imports the module by path',
      { 'tests/x.test.js': "import a from '@/lib/a.js'" },
      0,
    ],
    ['a test that imports the package', { 'tests/x.test.js': "require('lodash')" }, 0],
    ['a path on a line with no import word', { 'tests/x.test.js': "const a = '../src/lib/a'" }, 2],
    ['a bare name', { 'tests/x.test.js': "import a from 'a'" }, 2],
    ['an import word inside a name', { 'tests/x.test.js': "reimported('../src/lib/a')" }, 2],
  ])('scores %s as F4 %i', (_name, files, score) => {
    const root = tree({
      'package.json': manifest({ scripts: { test: 'vitest' } }),
      'src/lib/a.js': "import x from 'lodash'",
      ...files,
    })
    expect(scored(root, { why: { relationship: 'direct' } }).factors[3]?.score).toBe(score)
  })

  it.each([
    ['no scripts', {}, 2, 'no source imports, and neither a build nor a test script exists'],
    ['scripts that are a list', { scripts: ['build'] }, 2, 'no source imports, and neither'],
    ['a null scripts', { scripts: null }, 2, 'no source imports, and neither'],
    [
      'an empty build script',
      { scripts: { build: '', test: 'x' } },
      1,
      'the test script is the only',
    ],
    ['a build script', { scripts: { build: 'tsc' } }, 0, 'a build script exists'],
  ])('scores a tree that imports nothing with %s as F4 %i', (_name, fields, score, text) => {
    const root = tree({ 'package.json': manifest(fields) })
    const f4 = scored(root).factors[3]
    expect(f4?.score).toBe(score)
    expect(f4?.evidence).toContain(text)
  })

  it('scores an imported surface with no test script as F4 2', () => {
    const root = tree({ 'package.json': manifest({ scripts: { test: null } }), ...imports(2) })
    expect(scored(root, { why: { relationship: 'direct' } }).factors[3]?.evidence).toBe(
      '2 affected module(s), and package.json declares no test script',
    )
  })

  it('names five uncovered modules in byte order, and counts the rest', () => {
    const root = tree({
      'package.json': manifest({ scripts: { test: 'x' } }),
      ...imports(7),
      'src/B,c.js': "require('lodash')",
      'src/m0.test.js': '',
    })
    const report = scored(root, { why: { relationship: 'direct' } })
    expect([report.factors[3]?.evidence, report.coverage]).toEqual([
      '1 of 8 affected modules are imported by a test (src/B, c.js, src/m1.js, src/m2.js, src/m3.js, src/m4.js, and 2 more uncovered)',
      {
        affected: 8,
        covered: 1,
        uncovered: [
          'src/B,c.js',
          'src/m1.js',
          'src/m2.js',
          'src/m3.js',
          'src/m4.js',
          'src/m5.js',
          'src/m6.js',
        ],
      },
    ])
  })

  it('does not count a test file, or a module in a pruned directory, as the surface', () => {
    const root = tree({
      'package.json': manifest({}),
      'src/a.stories.tsx': "import 'lodash'",
      'e2e/b.js': "import 'lodash'",
      '.claude/worktrees/x/src/a.js': "import 'lodash'",
      'dist/a.js': "import 'lodash'",
      'src/latest/a.js': "import 'lodash'",
    })
    expect(scored(root, { why: { relationship: 'direct' } }).coverage.affected).toBe(1)
  })
})

describe('F5: CI presence', () => {
  const ci = (workflows: Readonly<Record<string, string>>) => {
    const files = Object.fromEntries(
      Object.entries(workflows).map(([name, text]) => [`.github/workflows/${name}`, text]),
    )
    const report = scored(tree({ 'package.json': manifest({}), ...files }))
    return { f5: report.factors[4], ci: report.ci }
  }

  it('names the first workflow that triggers and runs a check, in byte order, .yml first', () => {
    expect(
      ci({
        'b.yml': 'on: [pull_request]\njobs:\n  a:\n    steps:\n      - run: pnpm lint\n',
        'a.yml': 'on: pull_request\n',
        'C.yml': 'on: push\n',
        'a.yaml': CHECKED_CI,
      }),
    ).toEqual({
      f5: {
        id: 'F5',
        name: 'CI presence',
        score: 0,
        evidence: '.github/workflows/b.yml triggers on [pull_request] and runs: pnpm lint',
      },
      ci: { workflow: '.github/workflows/b.yml', trigger: '[pull_request]', step: 'pnpm lint' },
    })
  })

  it('names the first workflow that triggers when none runs a check', () => {
    expect(ci({ 'b.yml': 'on: pull_request_target\n', 'c.yml': 'on: pull_request\n' })).toEqual({
      f5: {
        id: 'F5',
        name: 'CI presence',
        score: 1,
        evidence:
          '.github/workflows/b.yml triggers on pull_request_target, but no test, build, typecheck, check, or lint step is visible in it',
      },
      ci: { workflow: '.github/workflows/b.yml', trigger: 'pull_request_target', step: null },
    })
  })

  it('counts the workflows when none triggers on a pull request', () => {
    expect(
      ci({ 'a.yml': 'on: push\n', 'b.yaml': 'on: push\n', '.c.yml': CHECKED_CI }).f5,
    ).toMatchObject({
      score: 2,
      evidence: '2 GitHub Actions workflow file(s), none triggering on a pull request',
    })
  })

  it('reads no workflow from a directory named like one, or a file of another name', () => {
    const root = tree({
      'package.json': manifest({}),
      '.github/workflows/x.yml/ci.yml': CHECKED_CI,
      '.github/workflows/ci.YML': CHECKED_CI,
    })
    expect([scored(root).factors[4]?.evidence, scored(root).ci]).toEqual([
      'no GitHub Actions workflow triggers on this pull request; another CI vendor is not read',
      { workflow: null, trigger: null, step: null },
    ])
  })
})
