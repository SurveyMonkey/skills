// `gh-security render-pr-status`. The seam is the exported handler, with the
// current directory as a parameter. The input is real files. The expected
// Markdown is written by hand from `resolve-alerts` SKILL.md phase 8 ("what
// that check state is worth") and from the contract in the header of the
// command. `spec/fixtures/render-pr-status/pull-317.json` is a real answer of
// `pr-status`, saved from a run on a pull request of this repository.
// `pull-317-results.json` beside it is written by hand: one Workflow entry
// that gives that PR the band Medium, in the shape of `fix-groups.mjs`. The
// other names are fictitious. This command has no bash original, so there is
// no parity run.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { run } from '#gh-security/lib/process.ts'
import { renderPrStatus, renderPrStatusCommand } from '#gh-security/subcommands/render-pr-status.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')
const DIR = join(FIXTURES_ROOT, 'render-pr-status')

const USAGE = 'usage: gh-security render-pr-status --results <results.json> <report.json>...'

const context = (args: readonly string[]): CommandContext => ({
  args,
  env: {},
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const render = (args: readonly string[], cwd = DIR): CommandResult =>
  renderPrStatus(context(args), cwd)

const markdown = (result: CommandResult): string => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return (result.value as { markdown: string }).markdown
}

const message = (result: CommandResult): string => {
  if (result?.outcome !== 'failed') throw new Error(`expected a failure: ${JSON.stringify(result)}`)
  return result.error
}

/** A scratch directory with one file for each entry, and the entries as values or text. */
const filesOf = (entries: Record<string, unknown>): string => {
  const dir = join(createSandbox().path, 'in')
  mkdirSync(dir)
  for (const [name, content] of Object.entries(entries)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

const url = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`

/** An entry of `pr-status` for a PR whose checks all passed and whose merge is computed. */
const entry = (repo: string, number: number, overrides: Record<string, unknown> = {}) => ({
  url: url(repo, number),
  number,
  repo,
  state: 'OPEN',
  is_draft: false,
  head: 'fix/dependabot-lodash',
  base: 'main',
  merge_state: 'CLEAN',
  behind: false,
  conflict: false,
  checks: 'passed',
  check_counts: { total: 4, passed: 4, failed: 0, pending: 0 },
  failing_checks: [],
  ...overrides,
})

/**
 * The Workflow entries of `results.json`, one for each PR and its band, as
 * `fix-groups.mjs` returns them: a band is the `risk.band` of a success, and
 * a result with no score has `risk` null. Only `pr_url` and `risk` are read.
 */
const resultsOf = (...pairs: [string, string | null][]) =>
  pairs.map(([prUrl, band], index) => ({
    dispatch: { group: { package: `pkg-${index}`, major_line: '1' }, repo: 'octo/app' },
    result: {
      status: band === null ? 'failure' : 'success',
      pr_url: prUrl,
      risk: band === null ? null : { band, score: 3, f4: 0, f5: 0 },
    },
    mispaired: false,
  }))

const HEADER = '| PR | Merge risk | Checks | Merge state |\n| --- | --- | --- | --- |\n'

describe('a real answer of pr-status', () => {
  it('renders one table, with the pending count and the notes of the state', () => {
    expect(markdown(render(['--results', 'pull-317-results.json', 'pull-317.json']))).toBe(
      '## SurveyMonkey/skills\n\n' +
        HEADER +
        '| https://github.com/SurveyMonkey/skills/pull/317 | Medium | pending (13 of 15 finished) | BLOCKED |\n\n' +
        '## What the states are worth\n\n' +
        '- `pending`: the count shows how many checks have finished. The rest still run.\n',
    )
  })
})

describe('the check state', () => {
  const only = (overrides: Record<string, unknown>, band: string | null = 'Low') => {
    const dir = filesOf({
      'a.json': { prs: [entry('octo/app', 1, overrides)] },
      'results.json': resultsOf([url('octo/app', 1), band]),
    })
    return markdown(render(['--results', 'results.json', 'a.json'], dir))
  }

  it('shows none, and says that no check has reported yet', () => {
    expect(
      only({ checks: 'none', check_counts: { total: 0, passed: 0, failed: 0, pending: 0 } }),
    ).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | none | CLEAN |\n\n' +
        '## What the states are worth\n\n' +
        '- `none`: no check has reported yet. On a repository with CI, the workflows have usually not started.\n',
    )
  })

  it('shows passed as provisional', () => {
    expect(only({})).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | passed | CLEAN |\n\n' +
        '## What the states are worth\n\n' +
        '- `passed` is provisional. Checks appear as workflows start, and a job that has not reported is invisible. Absent is not pending. Do not read the set as CI-complete.\n',
    )
  })

  it('names the failing checks, and says to open that PR first', () => {
    expect(
      only({
        checks: 'failed',
        check_counts: { total: 4, passed: 2, failed: 2, pending: 0 },
        failing_checks: ['lint', 'unit | node | 22'],
      }),
    ).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | failed: lint, unit \\| node \\| 22 | CLEAN |\n\n' +
        '## What the states are worth\n\n' +
        '- `failed`: the table names the failing checks. Open these PRs first.\n',
    )
  })

  it('shows a PR with no score as not scored', () => {
    expect(only({}, null)).toContain('| https://github.com/octo/app/pull/1 | not scored | passed |')
  })
})

describe('the merge state', () => {
  const only = (overrides: Record<string, unknown>) => {
    const dir = filesOf({
      'a.json': { prs: [entry('octo/app', 1, overrides)] },
      'results.json': resultsOf([url('octo/app', 1), 'High']),
    })
    return markdown(render(['--results', 'results.json', 'a.json'], dir))
  }
  const notes = (text: string) => text.split('## What the states are worth\n\n')[1]

  it('says that UNKNOWN is not clean and not behind, and that false is not established', () => {
    const text = only({ merge_state: 'UNKNOWN' })
    expect(text).toContain('| https://github.com/octo/app/pull/1 | High | passed | UNKNOWN |')
    expect(notes(text)).toContain(
      '- `UNKNOWN`: GitHub has not computed mergeability yet. This is ordinary right after a push. It is not clean and not behind. `behind` and `conflict` are not established, and `false` there is not a sign of a clean PR.\n',
    )
  })

  it('reports behind when it is true', () => {
    const text = only({ merge_state: 'BEHIND', behind: true })
    expect(text).toContain('| passed | BEHIND, behind |')
    expect(notes(text)).toContain(
      '- `behind`: GitHub has computed mergeability, and the PR needs a rebase.\n',
    )
  })

  it('reports conflict when it is true', () => {
    const text = only({ merge_state: 'DIRTY', conflict: true })
    expect(text).toContain('| passed | DIRTY, conflict |')
    expect(notes(text)).toContain(
      '- `conflict`: GitHub has computed mergeability, and the PR has a conflicting change.\n',
    )
  })

  it('reports a draft as a PR that a person converted', () => {
    const text = only({ is_draft: true })
    expect(text).toContain('| passed | CLEAN, draft |')
    expect(notes(text)).toContain(
      '- `draft`: these PRs open ready, so a person converted each draft PR.\n',
    )
  })

  it('shows no merge-state note for BLOCKED', () => {
    expect(notes(only({ merge_state: 'BLOCKED' }))).not.toMatch(/behind|conflict|UNKNOWN|draft/)
  })

  it('keeps a merge state that is not a known value inside its cell', () => {
    expect(only({ merge_state: 'NEW|STATE' })).toContain('| passed | NEW\\|STATE |')
  })
})

describe('an entry that pr-status could not read', () => {
  it('names the error in its row, and the other entries still render', () => {
    const dir = filesOf({
      'a.json': {
        prs: [
          entry('octo/app', 1),
          { url: url('octo/app', 2), error: 'gh: Could not\r\nresolve\nto a PullRequest | 404' },
        ],
      },
      'results.json': resultsOf([url('octo/app', 1), 'Low'], [url('octo/app', 2), 'High']),
    })
    expect(markdown(render(['--results', 'results.json', 'a.json'], dir))).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | passed | CLEAN |\n' +
        '| https://github.com/octo/app/pull/2 | High | not read: gh: Could not resolve to a PullRequest \\| 404 | - |\n\n' +
        'octo/app has 2 pull requests from this run: https://github.com/octo/app/pull/1, https://github.com/octo/app/pull/2. ' +
        'They edit the same overrides block. Merging one leaves the rest behind, and the second to merge may conflict. ' +
        'Use Update branch for the usual case. Close a conflicted fix PR and run this skill again for that package.\n\n' +
        '## What the states are worth\n\n' +
        '- `passed` is provisional. Checks appear as workflows start, and a job that has not reported is invisible. Absent is not pending. Do not read the set as CI-complete.\n',
    )
  })

  it('keeps the row of an error entry whose url is not a PR URL', () => {
    const dir = filesOf({
      'a.json': {
        prs: [entry('octo/app', 1), { url: 'octo/app#2', error: 'not a GitHub pull request URL' }],
      },
      'results.json': resultsOf([url('octo/app', 1), 'Low'], ['octo/app#2', null]),
    })
    expect(markdown(render(['--results', 'results.json', 'a.json'], dir))).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | passed | CLEAN |\n\n' +
        '## not a pull request URL\n\n' +
        HEADER +
        '| octo/app#2 | not scored | not read: not a GitHub pull request URL | - |\n\n' +
        '## What the states are worth\n\n' +
        '- `passed` is provisional. Checks appear as workflows start, and a job that has not reported is invisible. Absent is not pending. Do not read the set as CI-complete.\n',
    )
  })

  it('gives URLs that are not PR URLs one table in the order of first appearance, with no paragraph on a shared block', () => {
    const dir = filesOf({
      'a.json': {
        prs: [
          { url: 'octo/app#2', error: 'not a GitHub pull request URL' },
          { url: 'octo|app#3', error: 'not a GitHub\rpull request URL' },
          entry('octo/app', 1),
        ],
      },
      'results.json': resultsOf(
        ['octo/app#2', null],
        ['octo|app#3', null],
        [url('octo/app', 1), 'Low'],
      ),
    })
    expect(markdown(render(['--results', 'results.json', 'a.json'], dir))).toBe(
      '## not a pull request URL\n\n' +
        HEADER +
        '| octo/app#2 | not scored | not read: not a GitHub pull request URL | - |\n' +
        '| octo\\|app#3 | not scored | not read: not a GitHub pull request URL | - |\n\n' +
        '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | passed | CLEAN |\n\n' +
        '## What the states are worth\n\n' +
        '- `passed` is provisional. Checks appear as workflows start, and a job that has not reported is invisible. Absent is not pending. Do not read the set as CI-complete.\n',
    )
  })
})

describe('a report with no entry that pr-status could read', () => {
  it('has a table and no notes on the states', () => {
    const dir = filesOf({
      'a.json': { prs: [{ url: url('octo/app', 2), error: 'gh: not found' }] },
      'results.json': resultsOf([url('octo/app', 2), 'High']),
    })
    expect(markdown(render(['--results', 'results.json', 'a.json'], dir))).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/2 | High | not read: gh: not found | - |\n',
    )
  })
})

describe('the repositories', () => {
  const two = () =>
    filesOf({
      'app.json': { prs: [entry('octo/app', 1), entry('octo/app', 3)] },
      'web.json': { prs: [entry('octo/web', 7, { merge_state: 'BLOCKED' })] },
      'more-app.json': { prs: [entry('octo/app', 9)] },
      'results.json': resultsOf(
        [url('octo/app', 1), 'Low'],
        [url('octo/app', 3), 'Medium'],
        [url('octo/app', 9), 'High'],
        [url('octo/web', 7), 'Low'],
      ),
    })

  it('gives one table for each repository, in the order of first appearance, and names a repository with several PRs together', () => {
    const text = markdown(
      render(['--results', 'results.json', 'app.json', 'web.json', 'more-app.json'], two()),
    )
    expect(text).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | passed | CLEAN |\n' +
        '| https://github.com/octo/app/pull/3 | Medium | passed | CLEAN |\n' +
        '| https://github.com/octo/app/pull/9 | High | passed | CLEAN |\n\n' +
        'octo/app has 3 pull requests from this run: https://github.com/octo/app/pull/1, https://github.com/octo/app/pull/3, https://github.com/octo/app/pull/9. ' +
        'They edit the same overrides block. Merging one leaves the rest behind, and the second to merge may conflict. ' +
        'Use Update branch for the usual case. Close a conflicted fix PR and run this skill again for that package.\n\n' +
        '## octo/web\n\n' +
        HEADER +
        '| https://github.com/octo/web/pull/7 | Low | passed | BLOCKED |\n\n' +
        '## What the states are worth\n\n' +
        '- `passed` is provisional. Checks appear as workflows start, and a job that has not reported is invisible. Absent is not pending. Do not read the set as CI-complete.\n',
    )
  })

  it('says nothing of a shared block for a repository with one PR', () => {
    const dir = filesOf({
      'web.json': { prs: [entry('octo/web', 7)] },
      'results.json': resultsOf([url('octo/web', 7), 'Low']),
    })
    expect(markdown(render(['--results', 'results.json', 'web.json'], dir))).not.toContain(
      'same overrides block',
    )
  })
})

describe('the refusals', () => {
  const good = { prs: [entry('octo/app', 1)] }
  const results = resultsOf([url('octo/app', 1), 'Low'])

  const fails = (files: Record<string, unknown>, args = ['--results', 'results.json', 'a.json']) =>
    message(render(args, filesOf({ 'results.json': results, 'a.json': good, ...files })))

  it.each([
    ['no option and no file', []],
    ['no file', ['--results', 'results.json']],
    ['no --results', ['a.json']],
  ])('refuses %s with the usage', (_name, args) => {
    expect(message(render(args))).toBe(USAGE)
  })

  it('refuses an option that it does not have', () => {
    expect(render(['--env-prefix', 'x', '--results', 'results.json', 'a.json'])?.outcome).toBe(
      'failed',
    )
  })

  it('refuses a file that cannot be read', () => {
    expect(fails({}, ['--results', 'results.json', 'nope.json'])).toMatch(
      /^render-pr-status: cannot read nope\.json: /,
    )
  })

  it('refuses a results file that cannot be read', () => {
    expect(fails({}, ['--results', 'nope.json', 'a.json'])).toMatch(
      /^render-pr-status: cannot read nope\.json: /,
    )
  })

  it('refuses a report that is not JSON', () => {
    expect(fails({ 'a.json': 'not json' })).toBe('render-pr-status: a.json is not JSON')
  })

  it('refuses a results file that is not JSON', () => {
    expect(fails({ 'results.json': '{' })).toBe('render-pr-status: results.json is not JSON')
  })

  it.each([
    ['a list', []],
    ['null', null],
    ['an object with another field', { prs: [entry('octo/app', 1)], extra: 1 }],
    ['an object with no prs', {}],
    ['prs that is not a list', { prs: {} }],
  ])('refuses a report that is %s', (_name, report) => {
    expect(fails({ 'a.json': report })).toBe(
      'render-pr-status: a.json is not an answer of pr-status: not an object with one field, prs, that is a list',
    )
  })

  it('refuses a report with no entry, because zero results is never a pass', () => {
    expect(fails({ 'a.json': { prs: [] } })).toBe(
      'render-pr-status: a.json is not an answer of pr-status: prs has no entry',
    )
  })

  it.each([
    ['is not an object', 'x', 'is not an object'],
    ['has no url', {}, 'has a url that is not text'],
    ['has a url that is not text', { url: 5 }, 'has a url that is not text'],
    [
      'has a url of no pull request',
      { url: 'https://example.com/a' },
      'has a url that is not a GitHub pull request URL: https://example.com/a',
    ],
    ...[
      'https://github.com/octo/app/pull/1/files',
      'x https://github.com/octo/app/pull/1',
      'https://github.com/octo/app/extra/pull/1',
      'https://github.com/octo/app/pull/',
      'https://github.com/octo/app/pull/abc',
      'http://github.com/octo/app/pull/1',
      'https://githubXcom/octo/app/pull/1',
    ].map((bad): [string, unknown, string] => [
      `has the url ${bad}`,
      { url: bad },
      `has a url that is not a GitHub pull request URL: ${bad}`,
    ]),
    [
      'has an error that is not text',
      { url: url('octo/app', 1), error: 5 },
      `has an error that is not text: ${url('octo/app', 1)}`,
    ],
    [
      'has an unknown check state',
      entry('octo/app', 1, { checks: 'green' }),
      `has a checks that is not one of none, pending, passed, failed: ${url('octo/app', 1)}`,
    ],
    [
      'has check_counts with no total',
      entry('octo/app', 1, { check_counts: { pending: 0 } }),
      `has a check_counts without a total and a pending count: ${url('octo/app', 1)}`,
    ],
    [
      'has check_counts with a pending that is not a count',
      entry('octo/app', 1, { check_counts: { total: 4, pending: -1 } }),
      `has a check_counts without a total and a pending count: ${url('octo/app', 1)}`,
    ],
    [
      'has check_counts that is null',
      entry('octo/app', 1, { check_counts: null }),
      `has a check_counts without a total and a pending count: ${url('octo/app', 1)}`,
    ],
    [
      'has check_counts with a total that is not a whole number',
      entry('octo/app', 1, { check_counts: { total: 1.5, pending: 0 } }),
      `has a check_counts without a total and a pending count: ${url('octo/app', 1)}`,
    ],
    [
      'has check_counts that is not an object',
      entry('octo/app', 1, { check_counts: 4 }),
      `has a check_counts without a total and a pending count: ${url('octo/app', 1)}`,
    ],
    [
      'has failing_checks that is not a list',
      entry('octo/app', 1, { failing_checks: 'lint' }),
      `has a failing_checks that is not a list of text: ${url('octo/app', 1)}`,
    ],
    [
      'has a failing check that is not text',
      entry('octo/app', 1, { failing_checks: [3] }),
      `has a failing_checks that is not a list of text: ${url('octo/app', 1)}`,
    ],
    [
      'has a merge_state that is not text',
      entry('octo/app', 1, { merge_state: null }),
      `has a merge_state that is not text: ${url('octo/app', 1)}`,
    ],
    [
      'has a behind that is not true or false',
      entry('octo/app', 1, { behind: 'no' }),
      `has a behind that is not true or false: ${url('octo/app', 1)}`,
    ],
    [
      'has a conflict that is not true or false',
      entry('octo/app', 1, { conflict: null }),
      `has a conflict that is not true or false: ${url('octo/app', 1)}`,
    ],
    [
      'has an is_draft that is not true or false',
      entry('octo/app', 1, { is_draft: 1 }),
      `has a is_draft that is not true or false: ${url('octo/app', 1)}`,
    ],
  ])('refuses an entry that %s', (_name, element, why) => {
    expect(fails({ 'a.json': { prs: [element] } })).toBe(
      `render-pr-status: a.json is not an answer of pr-status: prs[0] ${why}`,
    )
  })

  it('names the index of the bad entry', () => {
    expect(fails({ 'a.json': { prs: [entry('octo/app', 1), 'x'] } })).toContain('prs[1] ')
  })

  it('refuses a PR that two entries give', () => {
    expect(fails({ 'b.json': good }, ['--results', 'results.json', 'a.json', 'b.json'])).toBe(
      `render-pr-status: the PR ${url('octo/app', 1)} is in two entries`,
    )
  })

  it.each([
    ['an object', {}],
    ['null', null],
  ])('refuses a results file that is %s', (_name, content) => {
    expect(fails({ 'results.json': content })).toBe(
      'render-pr-status: results.json is not a list of workflow entries',
    )
  })

  it.each([
    ['not an object', 5],
    ['an object with no result', { dispatch: {} }],
    ['an entry whose result is not an object or null', { result: 'success' }],
  ])('refuses an entry that is %s', (_name, element) => {
    expect(fails({ 'results.json': [element] })).toBe(
      'render-pr-status: results.json[0] has no result that is an object or null',
    )
  })

  it.each([
    ['risk that is not an object', 'Low'],
    ['a band that is not one of the three', { band: 'low' }],
    ['no band', { score: 3 }],
  ])('refuses a result with a PR and %s', (_name, risk) => {
    expect(fails({ 'results.json': [{ result: { pr_url: url('octo/app', 1), risk } }] })).toBe(
      'render-pr-status: results.json[0].result.risk is not null or an object with a band of Low, Medium, High',
    )
  })

  it('refuses a PR that two results give', () => {
    expect(
      fails({
        'results.json': resultsOf([url('octo/app', 1), 'Low'], [url('octo/app', 1), 'High']),
      }),
    ).toBe(`render-pr-status: results.json gives ${url('octo/app', 1)} in two results`)
  })
})

describe('the band of each PR, from the results (#346)', () => {
  const good = { prs: [entry('octo/app', 1)] }
  const rowFor = (results: unknown) =>
    markdown(
      render(
        ['--results', 'results.json', 'a.json'],
        filesOf({ 'results.json': results, 'a.json': good }),
      ),
    )
      .split('\n')
      .find((line) => line.startsWith(`| ${url('octo/app', 1)} `))

  it('shows the band of the result that opened the PR', () => {
    expect(rowFor(resultsOf([url('octo/app', 1), 'High']))).toBe(
      `| ${url('octo/app', 1)} | High | passed | CLEAN |`,
    )
  })

  it('shows a result with a null risk as not scored', () => {
    expect(rowFor(resultsOf([url('octo/app', 1), null]))).toBe(
      `| ${url('octo/app', 1)} | not scored | passed | CLEAN |`,
    )
  })

  it('shows a PR that no result names as not scored', () => {
    expect(rowFor(resultsOf([url('octo/app', 9), 'Low']))).toBe(
      `| ${url('octo/app', 1)} | not scored | passed | CLEAN |`,
    )
  })

  it.each([
    ['a null result', { dispatch: {}, result: null, mispaired: false }],
    [
      'a result with no PR',
      { dispatch: {}, result: { status: 'failure', pr_url: null, risk: null } },
    ],
  ])('reads %s as no PR', (_name, element) => {
    expect(rowFor([element, ...resultsOf([url('octo/app', 1), 'Medium'])])).toBe(
      `| ${url('octo/app', 1)} | Medium | passed | CLEAN |`,
    )
  })
})

describe('the entry point', () => {
  it('reads the files from the current directory of the process', () => {
    const result = renderPrStatusCommand(
      context(['--results', join(DIR, 'pull-317-results.json'), join(DIR, 'pull-317.json')]),
    )
    expect(markdown(result as CommandResult)).toContain('## SurveyMonkey/skills')
  })
})

describe('the process', () => {
  const spawnCli = (args: readonly string[]) =>
    run(process.execPath, [ENTRY, 'render-pr-status', ...args], {
      cwd: DIR,
      env: createSandbox().env,
    })

  it('writes the Markdown as one JSON field on stdout with exit 0', async () => {
    const result = await spawnCli(['--results', 'pull-317-results.json', 'pull-317.json'])
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as { markdown: string }).markdown).toContain(
      '| https://github.com/SurveyMonkey/skills/pull/317 | Medium | pending (13 of 15 finished) | BLOCKED |',
    )
  })

  it('exits 1 with the error as JSON on stdout and as prose on stderr', async () => {
    const result = await spawnCli([])
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: `{"error":"${USAGE}"}\n`,
      stderr: `${USAGE}\n`,
    })
  })
})
