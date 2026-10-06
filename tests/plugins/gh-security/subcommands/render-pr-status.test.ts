// `gh-security render-pr-status`. The seam is the exported handler, with the
// current directory as a parameter. The input is real files. The expected
// Markdown is written by hand from `resolve-alerts` SKILL.md phase 8 ("what
// that check state is worth") and from the contract in the header of the
// command. `spec/fixtures/render-pr-status/pull-317.json` is a real answer of
// `pr-status`, saved from a run on a pull request of this repository. The
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

const USAGE = 'usage: gh-security render-pr-status --bands <bands.json> <report.json>...'

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

const bandsOf = (...pairs: [string, string | null][]) => Object.fromEntries(pairs)

const HEADER = '| PR | Merge risk | Checks | Merge state |\n| --- | --- | --- | --- |\n'

describe('a real answer of pr-status', () => {
  it('renders one table, with the pending count and the notes of the state', () => {
    expect(markdown(render(['--bands', 'pull-317-bands.json', 'pull-317.json']))).toBe(
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
      'bands.json': bandsOf([url('octo/app', 1), band]),
    })
    return markdown(render(['--bands', 'bands.json', 'a.json'], dir))
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
        failing_checks: ['lint', 'unit | node 22'],
      }),
    ).toBe(
      '## octo/app\n\n' +
        HEADER +
        '| https://github.com/octo/app/pull/1 | Low | failed: lint, unit \\| node 22 | CLEAN |\n\n' +
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
      'bands.json': bandsOf([url('octo/app', 1), 'High']),
    })
    return markdown(render(['--bands', 'bands.json', 'a.json'], dir))
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
      '- `draft`: a person converted this PR to a draft, because these PRs open ready.\n',
    )
  })

  it('never calls a PR clean when no state says so', () => {
    expect(notes(only({ merge_state: 'BLOCKED' }))).not.toMatch(/behind|conflict|UNKNOWN|draft/)
  })
})

describe('an entry that pr-status could not read', () => {
  it('names the error in its row, and the other entries still render', () => {
    const dir = filesOf({
      'a.json': {
        prs: [
          entry('octo/app', 1),
          { url: url('octo/app', 2), error: 'gh: Could not resolve\nto a PullRequest | 404' },
        ],
      },
      'bands.json': bandsOf([url('octo/app', 1), 'Low'], [url('octo/app', 2), 'High']),
    })
    expect(markdown(render(['--bands', 'bands.json', 'a.json'], dir))).toBe(
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
})

describe('a report with no entry that pr-status could read', () => {
  it('has a table and no notes on the states', () => {
    const dir = filesOf({
      'a.json': { prs: [{ url: url('octo/app', 2), error: 'gh: not found' }] },
      'bands.json': bandsOf([url('octo/app', 2), 'High']),
    })
    expect(markdown(render(['--bands', 'bands.json', 'a.json'], dir))).toBe(
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
      'bands.json': bandsOf(
        [url('octo/app', 1), 'Low'],
        [url('octo/app', 3), 'Medium'],
        [url('octo/app', 9), 'High'],
        [url('octo/web', 7), 'Low'],
      ),
    })

  it('gives one table for each repository, in the order of first appearance, and names a repository with several PRs together', () => {
    const text = markdown(
      render(['--bands', 'bands.json', 'app.json', 'web.json', 'more-app.json'], two()),
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
      'bands.json': bandsOf([url('octo/web', 7), 'Low']),
    })
    expect(markdown(render(['--bands', 'bands.json', 'web.json'], dir))).not.toContain(
      'same overrides block',
    )
  })
})

describe('the refusals', () => {
  const good = { prs: [entry('octo/app', 1)] }
  const bands = bandsOf([url('octo/app', 1), 'Low'])

  const fails = (files: Record<string, unknown>, args = ['--bands', 'bands.json', 'a.json']) =>
    message(render(args, filesOf({ 'bands.json': bands, 'a.json': good, ...files })))

  it.each([
    ['no option and no file', []],
    ['no file', ['--bands', 'bands.json']],
    ['no --bands', ['a.json']],
  ])('refuses %s with the usage', (_name, args) => {
    expect(message(render(args))).toBe(USAGE)
  })

  it('refuses an option that it does not have', () => {
    expect(render(['--env-prefix', 'x', '--bands', 'bands.json', 'a.json'])?.outcome).toBe('failed')
  })

  it('refuses a file that cannot be read', () => {
    expect(fails({}, ['--bands', 'bands.json', 'nope.json'])).toMatch(
      /^render-pr-status: cannot read nope\.json: /,
    )
  })

  it('refuses a bands file that cannot be read', () => {
    expect(fails({}, ['--bands', 'nope.json', 'a.json'])).toMatch(
      /^render-pr-status: cannot read nope\.json: /,
    )
  })

  it('refuses a report that is not JSON', () => {
    expect(fails({ 'a.json': 'not json' })).toBe('render-pr-status: a.json is not JSON')
  })

  it('refuses a bands file that is not JSON', () => {
    expect(fails({ 'bands.json': '{' })).toBe('render-pr-status: bands.json is not JSON')
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
    expect(fails({ 'b.json': good }, ['--bands', 'bands.json', 'a.json', 'b.json'])).toBe(
      `render-pr-status: the PR ${url('octo/app', 1)} is in two entries`,
    )
  })

  it.each([
    ['a list', []],
    ['null', null],
  ])('refuses a bands file that is %s', (_name, content) => {
    expect(fails({ 'bands.json': content })).toBe(
      'render-pr-status: bands.json is not a JSON object',
    )
  })

  it.each([['low'], [3], ['']])('refuses the band %j', (band) => {
    expect(fails({ 'bands.json': { [url('octo/app', 1)]: band } })).toBe(
      `render-pr-status: bands.json gives ${url('octo/app', 1)} a band that is not Low, Medium, High or null`,
    )
  })

  it('refuses a PR that the bands file lacks', () => {
    expect(fails({ 'bands.json': {} })).toBe(
      `render-pr-status: bands.json has no band for ${url('octo/app', 1)}`,
    )
  })

  it('refuses a band for a PR that no report has', () => {
    expect(fails({ 'bands.json': { ...bands, [url('octo/app', 2)]: 'Low' } })).toBe(
      `render-pr-status: bands.json names ${url('octo/app', 2)}, which no report has`,
    )
  })
})

describe('the entry point', () => {
  it('reads the files from the current directory of the process', () => {
    const result = renderPrStatusCommand(
      context(['--bands', join(DIR, 'pull-317-bands.json'), join(DIR, 'pull-317.json')]),
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
    const result = await spawnCli(['--bands', 'pull-317-bands.json', 'pull-317.json'])
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
