// `gh-security summarize-run`. The seam is the exported handler, with the
// current directory as a parameter. The input is real files. Each expected
// text is written by hand from `resolve-alerts` SKILL.md phase 7 and from the
// contract in the header of the command. This command has no bash original,
// so there is no parity run.
//
// The field run (`spec/fixtures/summarize-run/field-run/`) is one example end
// to end. Its specimens are not edited. Two inputs of the command are made
// from them by the real commands that make them in a run:
//   - The reports come from `reap-batch` over the entries of the Workflow
//     result. The repository of the field run is not on this machine, so the
//     test gives `reap-batch` the same entries with `repo_root` set to an
//     empty real repository. That is the state of the field repository after
//     the run: no group left a worktree or a branch. `gh` answers with the
//     state that `pr-status.json` read for the one pull request.
//   - The discovery is the answer of `merge-envelopes` over the answer that
//     `prepare-checkout` gives from `detect-scope.json`, the empty namespace
//     probe (`slash`) and `classify-lines.json`.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import type { JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { mergeEnvelopes } from '#gh-security/subcommands/merge-envelopes.ts'
import { reapBatch } from '#gh-security/subcommands/reap-batch.ts'
import { summarizeRun, summarizeRunCommand } from '#gh-security/subcommands/summarize-run.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock } from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'

vi.setConfig({ testTimeout: 60_000 })

const FIELD = join(FIXTURES_ROOT, 'summarize-run', 'field-run')

const USAGE =
  'usage: gh-security summarize-run --workflow <workflow.json> --reports <reports.json> --discovery <merged.json> [--preflight <preflights.json>] [--args <args.json>]'

const specimen = (name: string): JsonValue =>
  JSON.parse(readFileSync(join(FIELD, name), 'utf8')) as JsonValue

const context = (args: readonly string[]): CommandContext => ({
  args,
  env: {},
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const markdown = (result: CommandResult): string => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return (result.value as { markdown: string }).markdown
}

const message = (result: CommandResult): string => {
  if (result?.outcome !== 'failed') throw new Error(`expected a failure: ${JSON.stringify(result)}`)
  return result.error
}

/** A scratch directory with one file for each input, as JSON or as text. */
const inputs = (files: Readonly<Record<string, unknown>>): string => {
  const dir = createSandbox().path
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

/** The text of one `## ` section, without its heading, or null. */
const section = (text: string, heading: string): string | null => {
  const start = text.indexOf(`## ${heading}\n\n`)
  if (start === -1) return null
  const body = text.slice(start + heading.length + 5)
  const end = body.indexOf('\n\n## ')
  return end === -1 ? body.replace(/\n$/, '') : body.slice(0, end)
}

/** The reports of `reap-batch` over the field entries, in an empty repository. */
const fieldReportsOf = async (): Promise<JsonValue> => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(join(sandbox.path, 'r'))
  const workflow = specimen('workflow-result.json') as {
    result: { dispatch: Record<string, JsonValue> }[]
  }
  const entries = workflow.result.map((entry) => ({
    ...entry,
    dispatch: { ...entry.dispatch, repo_root: repo },
  }))
  const file = join(sandbox.path, 'results.json')
  writeFileSync(file, JSON.stringify(entries))
  const read = specimen('pr-status.json') as { prs: { state: string; head: string }[] }
  const pull = read.prs[0] as { state: string; head: string }
  const client = createGhMock({
    viewPullRequest: {
      number: 2502,
      state: pull.state,
      isDraft: false,
      headRefName: pull.head,
      baseRefName: 'main',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [],
    },
  })
  const result = await reapBatch({ ...context([file]), env: sandbox.env }, () => client, run)
  if (result?.outcome !== 'ok') throw new Error(JSON.stringify(result))
  return result.value
}

/** The answer of merge-envelopes for the one checkout of the field run. */
const fieldDiscoveryOf = (): JsonValue => {
  const scope = specimen('detect-scope.json') as Record<string, JsonValue>
  const classified = specimen('classify-lines.json') as Record<string, JsonValue>
  const probe = readFileSync(join(FIELD, 'namespace-probe.stdout'), 'utf8')
  const dir = inputs({
    'checkout.json': {
      checkout: (specimen('discover-repos.json') as { repos: string[] }).repos[0],
      nwo: scope.nwo,
      default_branch: scope.default_branch,
      branch_style: probe === '' ? 'slash' : 'flat',
      actionable: classified.actionable,
      skipped: classified.skipped,
      classify_errors: classified.classify_errors,
    },
  })
  const merged = mergeEnvelopes(context(['checkout.json']), dir)
  if (merged?.outcome !== 'ok') throw new Error(JSON.stringify(merged))
  return merged.value
}

describe('the field run', () => {
  it('gives the whole summary of the run, with nothing left behind', async () => {
    const reports = await fieldReportsOf()
    // Ruling 12: each report names nothing that stays.
    expect((reports as { left_behind: JsonValue }[]).map((report) => report.left_behind)).toEqual([
      [],
      [],
      [],
    ])
    const dir = inputs({ 'reports.json': reports, 'merged.json': fieldDiscoveryOf() })
    const result = summarizeRun(
      context([
        '--workflow',
        join(FIELD, 'workflow-result.json'),
        '--reports',
        'reports.json',
        '--discovery',
        'merged.json',
      ]),
      dir,
    )
    expect(markdown(result)).toBe(`## Still vulnerable after this batch

- \`nx\` 20.8.4 in \`octo/app\` stays vulnerable (\`>= 13.10.0, < 22.7.10\`, \`>= 14.0.0, < 22.7.8\`, \`>= 14.6.0, < 22.7.9\`, \`>= 17.0.4, < 22.7.2\`, \`>= 20.8.0, < 22.7.7\`): the fix of the 22.x line did not reach this copy. No override bounded to the line of this copy can fix it. It needs a major bump of the parent that pins it, or the removal of that parent.
- \`uuid\` 11.x in \`octo/app\` was skipped before dispatch: the installed majors are 8, 9, and the fix line is 11.x. It needs a major bump of the parent that holds it, or the removal of that parent.
- \`@tiptap/core\` 3.x in \`octo/app\` was skipped before dispatch: the installed majors are 2, and the fix line is 3.x. It needs a major bump of the parent that holds it, or the removal of that parent.

## Groups

| Package | Line | PR | Risk | F4/F5 | Notes |
| --- | --- | --- | --- | --- | --- |
| nx | 22.x | https://github.com/octo/app/pull/2502 | Low (1) | 0/0 | scoped override |
| smol-toml | 1.x | none | n/a | n/a | failure: validate |
| brace-expansion | 2.x | none | n/a | n/a | failure: worktree |

## Failures

- \`smol-toml\` 1.x in \`octo/app\`: failure: validate. validate_failed_after_ladder: the scoped override overrides.nx.smol-toml = '>=1.9.0 <2' was written to package.json, but the install left smol-toml 1.6.1 at node_modules/smol-toml (npm ls shows nx@22.7.7 'overridden' yet smol-toml@1.6.1; nx declares it as exact 1.6.1). Violations: 1.6.1 at node_modules/smol-toml, unresolved for <=1.7.0 and <=1.8.0 (alerts 305, 350). Only parent was nx; tighten-bare was applied but no bare entry ended up written. smol-toml 1.9.0 and 1.9.1 do exist in the registry, so this is not a missing version. The lockfile did not change after the install. Needs manual reconciliation (e.g. a regenerated lockfile or an nx bump) by a human.
- \`brace-expansion\` 2.x in \`octo/app\`: failure: worktree. setup failed: git fetch origin fix/dependabot-brace-expansion-2x failed, so origin/fix/dependabot-brace-expansion-2x may be stale and cannot be used to judge whether a local branch of that name is a duplicate of pushed work: fatal: unable to access 'https://github.com/octo/app.git/': Failed to connect to github.com port 443 after 75002 ms: Couldn't connect to server. This looks like a network or sandbox problem affecting every group in this repo. No worktree was created and I did not retry.

## Other skips

- \`braces\` (no fix line) in \`octo/app\`: no fix available.
- \`webpack-dev-middleware\` 7.x in \`octo/app\`: open PR exists (https://github.com/octo/app/pull/2435).
- \`http-cache-semantics\` (no fix line) in \`octo/app\`: no fix available.
- \`axios\` 1.x in \`octo/app\`: open PR exists (https://github.com/octo/app/pull/2436).
- \`brace-expansion\` 5.x in \`octo/app\`: open PR exists (https://github.com/octo/app/pull/2439).
- \`qs\` 6.x in \`octo/app\`: open PR exists (https://github.com/octo/app/pull/2437).
- \`sprintf-js\` (no fix line) in \`octo/app\`: no fix available.

## Reap

3 of 3 groups came back with an empty \`left_behind\`: nothing was left behind.

- \`brace-expansion\` 2.x in \`octo/app\`: nothing is left on disk. The agent's cleanup: worktree \`/Users/example/src/octo/app/.claude/worktrees/fix-dependabot-brace-expansion-2x\` (not created), work directory \`/Users/example/src/octo/app/.claude/worktrees/fix-dependabot-brace-expansion-2x\` (not created), branch \`fix/dependabot-brace-expansion-2x\` (not deleted): setup failed before any worktree or branch was created.

## Observations

- Note: \`octo/app\` contains 1 unscoped global override(s): \`minimatch\`. These may be removable or convertible to scoped pins. \`/gh-security:audit-pins\` tests removability.
`)
  })
})

describe('the field run with its args', () => {
  it('pairs each entry with its dispatch, and gives the same summary', async () => {
    const reports = await fieldReportsOf()
    const dir = inputs({ 'reports.json': reports, 'merged.json': fieldDiscoveryOf() })
    const args = (more: readonly string[]) =>
      context([
        '--workflow',
        join(FIELD, 'workflow-result.json'),
        '--reports',
        'reports.json',
        '--discovery',
        'merged.json',
        ...more,
      ])
    expect(markdown(summarizeRun(args(['--args', join(FIELD, 'workflow-args.json')]), dir))).toBe(
      markdown(summarizeRun(args([]), dir)),
    )
  })
})

describe('the command line', () => {
  it.each([
    [[]],
    [['--reports', 'r.json', '--discovery', 'd.json']],
    [['--workflow', 'w.json', '--discovery', 'd.json']],
    [['--workflow', 'w.json', '--reports', 'r.json']],
    [['--workflow', 'w.json', '--reports', 'r.json', '--discovery', 'd.json', 'extra']],
  ])('refuses %j with the usage', (args) => {
    expect(message(summarizeRun(context(args), '/'))).toBe(USAGE)
  })

  it('refuses an option it does not know', () => {
    expect(message(summarizeRun(context(['--bogus']), '/'))).toMatch(/^Unknown option '--bogus'/)
  })

  it('runs the handler, which refuses a bare invocation with its usage', async () => {
    expect(await summarizeRunCommand(context([]))).toEqual({ outcome: 'failed', error: USAGE })
  })
})

// The examples below use fictitious groups. Each result has the shape of the
// Result contract of `agents/fix-dependency.md`, and each report the shape of
// `reap-batch`. Each expected text is written by hand from phase 7.

// A type, and not an interface, so that a group is a JSON value.
type Grp = {
  readonly package: string
  readonly major_line: string | number
  readonly branch_name: string
  readonly repo: string
}

const ROOT = '/Users/example/src/octo/app'

const grp = (name: string, line = '6', repo = 'octo/app'): Grp => ({
  package: name,
  major_line: line,
  branch_name: `fix/dependabot-${name}-${line}x`,
  repo,
})

const PKG = grp('example-pkg')
const URL = 'https://github.com/octo/app/pull/12'

/** The work directory of a group, as `reap-batch` names it in its report. */
const workOf = (group: Grp, root = ROOT): string =>
  `${root}/.claude/worktrees/fix-dependabot-${group.package}-${group.major_line}x`

const entry = (
  group: Grp,
  result: JsonValue,
  options: { mispaired?: boolean; root?: string } = {},
): JsonValue => ({
  dispatch: { group, repo_root: options.root ?? ROOT, default_branch: 'main' },
  result,
  mispaired: options.mispaired ?? false,
})

const resultOf = (group: Grp, status: string, changes: Record<string, JsonValue>) => ({
  status,
  package: group.package,
  major_line: String(group.major_line),
  repo: group.repo,
  branch: group.branch_name,
  pr_url: null,
  action: null,
  resolved_version: null,
  risk: null,
  observations: [],
  requires_major_bump: [],
  bare_override: 'none',
  no_op: null,
  failure: null,
  cleanup: null,
  ...changes,
})

const success = (group: Grp, changes: Record<string, JsonValue> = {}) =>
  resultOf(group, 'success', {
    pr_url: URL,
    action: 'scoped-override',
    resolved_version: '6.1.0',
    risk: { band: 'Medium', score: 4, f4: 1, f5: 2 },
    ...changes,
  })

const failure = (
  group: Grp,
  phase: string,
  detail: string,
  changes: Record<string, JsonValue> = {},
) => resultOf(group, 'failure', { failure: { phase, detail }, ...changes })

const noOp = (group: Grp, evidence: Record<string, JsonValue>) =>
  resultOf(group, 'no-op', {
    resolved_version: '6.28.0',
    no_op: { reason: 'the scoped overrides are already on main', evidence },
  })

// A report that no reap ran for gives a reason, as `post-agent` does.
const report = (group: Grp, status: string, changes: Record<string, JsonValue> = {}) => ({
  package: group.package,
  major_line: String(group.major_line),
  branch: group.branch_name,
  worktree_path: workOf(group),
  result_status: status,
  pr_url: null,
  pr_state: null,
  reaped: false,
  reason: changes.reaped === true ? null : `the result is ${status}`,
  left_behind: [],
  errors: [],
  ...changes,
})

const reaped = (group: Grp, changes: Record<string, JsonValue> = {}) =>
  report(group, 'success', { pr_url: URL, pr_state: 'OPEN', reaped: true, ...changes })

const CHECKOUT = {
  checkout: ROOT,
  nwo: 'octo/app',
  default_branch: 'main',
  branch_style: 'slash',
  classify_errors: [],
}

const discovery = (changes: Record<string, JsonValue> = {}) => ({
  checkouts: [CHECKOUT],
  excluded: [],
  actionable: [],
  skipped: [],
  ...changes,
})

interface Run {
  readonly entries: readonly JsonValue[]
  readonly reports: readonly JsonValue[]
  readonly discovery?: JsonValue
  readonly logs?: readonly string[]
  readonly preflight?: JsonValue
  readonly args?: JsonValue
}

/** Write the inputs of one run, and run the command on them. */
const summarize = (run: Run): CommandResult => {
  const files: Record<string, unknown> = {
    'workflow.json': { result: run.entries, logs: run.logs ?? [] },
    'reports.json': run.reports,
    'merged.json': run.discovery ?? discovery(),
  }
  const args = ['--workflow', 'workflow.json', '--reports', 'reports.json']
  args.push('--discovery', 'merged.json')
  if (run.preflight !== undefined) {
    files['preflight.json'] = run.preflight
    args.push('--preflight', 'preflight.json')
  }
  if (run.args !== undefined) {
    files['args.json'] = run.args
    args.push('--args', 'args.json')
  }
  return summarizeRun(context(args), inputs(files))
}

/** One section of the summary of a run. */
const sectionOf = (run: Run, heading: string): string | null =>
  section(markdown(summarize(run)), heading)

/** The headings of the summary, in order. */
const headings = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3))

/** One success with an open pull request, reaped clean. */
const CLEAN: Run = { entries: [entry(PKG, success(PKG))], reports: [reaped(PKG)] }

describe('the order of the sections', () => {
  it('gives each section in the order of phase 7, the alerts that stay open first', () => {
    const [a, b, c, d] = ['a-pkg', 'b-pkg', 'c-pkg', 'd-pkg'].map((name) => grp(name)) as [
      Grp,
      Grp,
      Grp,
      Grp,
    ]
    const text = markdown(
      summarize({
        entries: [
          entry(a, success(a, { observations: [{ type: 'unscoped_override', key: 'x' }] })),
          entry(b, noOp(b, {})),
          entry(c, failure(c, 'install', 'the install failed')),
          entry(d, null, { mispaired: true }),
        ],
        reports: [
          reaped(a, { left_behind: [a.branch_name] }),
          report(b, 'no-op'),
          report(c, 'failure'),
          report(d, 'missing'),
        ],
        discovery: discovery({
          checkouts: [{ ...CHECKOUT, branch_style: 'flat' }],
          skipped: [
            {
              package: 'e-pkg',
              major_line: '2',
              repo: 'octo/app',
              reason: 'requires major version bump',
              resolved_majors: ['1'],
            },
            {
              package: 'f-pkg',
              major_line: '3',
              repo: 'octo/app',
              reason: 'shared parent across major lines',
              collision_parents: ['p'],
            },
            { package: 'g-pkg', major_line: 'none', repo: 'octo/app', reason: 'no fix available' },
          ],
        }),
        preflight: {
          [ROOT]: {
            ok: false,
            probe_package: 'q',
            cause: 'auth',
            stderr: null,
            exclude_error: null,
          },
        },
      }),
    )
    expect(headings(text)).toEqual([
      'Still vulnerable after this batch',
      'Groups',
      'Already fixed',
      'Failures',
      'Unknown groups',
      'Excluded checkouts and repositories',
      'Flat branch scheme',
      'Shared-parent skips',
      'Other skips',
      'Reap',
      'Observations',
    ])
    expect(text.startsWith('## Still vulnerable after this batch\n')).toBe(true)
  })

  it('leaves out each section with nothing to say, and keeps the table and the reap', () => {
    expect(headings(markdown(summarize(CLEAN)))).toEqual(['Groups', 'Reap'])
  })
})

describe('what stays open because the fix crosses a major', () => {
  it('names each requires_major_bump copy of a result, then each skip of phase 2', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          success(PKG, {
            requires_major_bump: [
              { version: '5.29.0', vulnerable_ranges: ['< 5.29.1', '>= 5.0.0, < 6.0.0'] },
              { version: '4.1.0', vulnerable_ranges: ['< 6.0.0'] },
            ],
          }),
        ),
      ],
      reports: [reaped(PKG)],
      discovery: discovery({
        skipped: [
          {
            package: 'tiny',
            major_line: '1',
            repo: 'octo/app',
            reason: 'requires major version bump',
            resolved_majors: ['0'],
          },
        ],
      }),
    }
    expect(sectionOf(run, 'Still vulnerable after this batch')).toBe(
      [
        '- `example-pkg` 5.29.0 in `octo/app` stays vulnerable (`< 5.29.1`, `>= 5.0.0, < 6.0.0`): the fix of the 6.x line did not reach this copy. No override bounded to the line of this copy can fix it. It needs a major bump of the parent that pins it, or the removal of that parent.',
        '- `example-pkg` 4.1.0 in `octo/app` stays vulnerable (`< 6.0.0`): the fix of the 6.x line did not reach this copy. No override bounded to the line of this copy can fix it. It needs a major bump of the parent that pins it, or the removal of that parent.',
        '- `tiny` 1.x in `octo/app` was skipped before dispatch: the installed majors are 0, and the fix line is 1.x. It needs a major bump of the parent that holds it, or the removal of that parent.',
      ].join('\n'),
    )
  })

  it('reads requires_major_bump from a failure too', () => {
    const result = failure(PKG, 'validate', 'other_line_moves: 5.x moved', {
      requires_major_bump: [{ version: '5.0.0', vulnerable_ranges: ['< 5.1.0'] }],
    })
    expect(
      sectionOf(
        { entries: [entry(PKG, result)], reports: [report(PKG, 'failure')] },
        'Still vulnerable after this batch',
      ),
    ).toBe(
      '- `example-pkg` 5.0.0 in `octo/app` stays vulnerable (`< 5.1.0`): the fix of the 6.x line did not reach this copy. No override bounded to the line of this copy can fix it. It needs a major bump of the parent that pins it, or the removal of that parent.',
    )
  })
})

describe('the table', () => {
  const HEAD =
    '| Package | Line | PR | Risk | F4/F5 | Notes |\n| --- | --- | --- | --- | --- | --- |'

  it('gives the band, the score, f4 and f5 of a success', () => {
    expect(sectionOf(CLEAN, 'Groups')).toBe(
      `${HEAD}\n| example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override |`,
    )
  })

  it('gives n/a for a success with no risk', () => {
    const run: Run = { entries: [entry(PKG, success(PKG, { risk: null }))], reports: [reaped(PKG)] }
    expect(sectionOf(run, 'Groups')).toBe(
      `${HEAD}\n| example-pkg | 6.x | ${URL} | n/a | n/a | scoped override |`,
    )
  })

  it.each([
    ['direct-update', 'none', 'direct update'],
    ['scoped-override', 'none', 'scoped override'],
    ['bare-override', 'added', 'bare override added'],
    ['bare-override', 'tightened', 'bare override tightened'],
    ['lockfile-refresh', 'none', 'lockfile refresh, no manifest edit'],
  ])('labels the action %s (bare_override %s) as %s', (action, bare, label) => {
    const run: Run = {
      entries: [entry(PKG, success(PKG, { action, bare_override: bare }))],
      reports: [reaped(PKG)],
    }
    expect(sectionOf(run, 'Groups')).toBe(
      `${HEAD}\n| example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | ${label} |`,
    )
  })

  // Phase 7 names four failure shapes. The details are written by hand from
  // the words that the driver and the adapter give for each: no real run has
  // given these shapes yet.
  it.each([
    [
      'baseline',
      'the control install failed',
      'baseline could not be established (ambient, affects every group)',
    ],
    [
      'baseline',
      'a repo hook failed the drift commit',
      'baseline could not be established (ambient, affects every group)',
    ],
    [
      'classify',
      'peer_only_dependency: example-pkg is reached only through peer resolutions',
      'peer-only dependency',
    ],
    ['classify', 'the why read failed', 'failure: classify'],
    [
      'apply',
      "apply_constraint: cannot scope 'example-pkg' on this line. This is the shared-parent shape: escalate it",
      'shared parent, no reachable override',
    ],
    [
      'apply',
      "apply_constraint: a pre-existing bare override for 'example-pkg' under a parent this call must version-qualify pins a DIFFERENT major line: {}",
      'shared parent, no reachable override',
    ],
    ['apply', 'apply_constraint: the placing rule spans major lines', 'failure: apply'],
    [
      'push',
      'branch-namespace collision (directory file conflict): ! [remote rejected]',
      'branch-namespace collision (preflight miss)',
    ],
    ['push', 'the hook rejected the push', 'failure: push'],
    ['validate', 'peer_only_dependency', 'failure: validate'],
    ['install', 'this is the shared-parent shape', 'failure: install'],
    ['validate', 'directory file conflict', 'failure: validate'],
    ['worktree', 'setup failed', 'failure: worktree'],
  ])('labels a %s failure whose detail is %j as %s', (phase, detail, label) => {
    const run: Run = {
      entries: [entry(PKG, failure(PKG, phase, detail))],
      reports: [report(PKG, 'failure')],
    }
    expect(sectionOf(run, 'Groups')).toBe(
      `${HEAD}\n| example-pkg | 6.x | none | n/a | n/a | ${label} |`,
    )
    expect(sectionOf(run, 'Failures')).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: ${label}. ${detail}`,
    )
  })

  it('keeps a pipe and a line break of a detail inside the cell and the line', () => {
    const run: Run = {
      entries: [entry(PKG, failure(PKG, 'install', 'a | b\nc'))],
      reports: [report(PKG, 'failure')],
    }
    expect(sectionOf(run, 'Failures')).toBe(
      '- `example-pkg` 6.x in `octo/app`: failure: install. a | b c',
    )
  })

  it('shows the Repo column when more than one checkout is in scope', () => {
    const lib = grp('example-pkg', '6', 'octo/lib')
    const run: Run = {
      entries: [
        entry(PKG, success(PKG)),
        entry(lib, failure(lib, 'install', 'failed'), { root: '/Users/example/src/octo/lib' }),
      ],
      reports: [reaped(PKG), report(lib, 'failure')],
      discovery: discovery({
        checkouts: [
          CHECKOUT,
          { ...CHECKOUT, checkout: '/Users/example/src/octo/lib', nwo: 'octo/lib' },
        ],
      }),
    }
    expect(sectionOf(run, 'Groups')).toBe(
      [
        '| Repo | Package | Line | PR | Risk | F4/F5 | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| octo/app | example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override |`,
        '| octo/lib | example-pkg | 6.x | none | n/a | n/a | failure: install |',
      ].join('\n'),
    )
  })

  it('counts an excluded checkout as one in scope', () => {
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        excluded: [
          { checkout: '/Users/example/src/octo/lib', reason: 'no usable origin', stderr: '' },
        ],
      }),
    }
    expect(sectionOf(run, 'Groups')?.split('\n')[0]).toBe(
      '| Repo | Package | Line | PR | Risk | F4/F5 | Notes |',
    )
  })

  it('reads a major_line that the dispatch gives as a number', () => {
    const numbered = { ...PKG, major_line: 6 }
    const run: Run = { entries: [entry(numbered, success(PKG))], reports: [reaped(PKG)] }
    expect(sectionOf(run, 'Groups')).toBe(
      `${HEAD}\n| example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override |`,
    )
  })
})

describe('a failure that carries pr_url (ruling 13)', () => {
  // The derived specimen is result[1] of the field run, the smol-toml
  // failure, with one field changed: result.pr_url, as a failed
  // `render-pr create` gives it. Its report is the report of reap-batch for
  // a failure, with nothing on disk.
  const derived = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, 'summarize-run', 'derived-failure-with-pr-url.json'), 'utf8'),
  ) as JsonValue
  const smol = grp('smol-toml', '1')

  it('reports that pull request in the table and in the failure line', () => {
    const run: Run = {
      entries: [derived],
      reports: [report(smol, 'failure', { reason: "failure: the agent's result was a failure" })],
    }
    const text = markdown(summarize(run))
    expect(section(text, 'Groups')?.split('\n')[2]).toBe(
      '| smol-toml | 1.x | https://github.com/octo/app/pull/2503 | n/a | n/a | failure: validate; gh opened this pull request before the failure |',
    )
    expect(section(text, 'Failures')).toMatch(
      /^- `smol-toml` 1\.x in `octo\/app`: failure: validate\. validate_failed_after_ladder: .* by a human\. gh opened the pull request https:\/\/github\.com\/octo\/app\/pull\/2503 before the failure\.$/,
    )
  })
})

describe('an entry with no result to read', () => {
  // The two reports are those of the capture of post-agent.sh for a null
  // result and for a mispaired entry (`spec/fixtures/post-agent/capture.json`).
  const capture = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, 'post-agent', 'capture.json'), 'utf8'),
  ) as { rows: { name: string; result: { stdout: JsonValue } }[]; groups: { plain: Grp } }
  const captured = (name: string): JsonValue =>
    (capture.rows.find((row) => row.name === name) as { result: { stdout: JsonValue } }).result
      .stdout
  const plain = { ...capture.groups.plain }

  it('reports a null result as a failure with no result, and names what it left', () => {
    const run: Run = { entries: [entry(plain, null)], reports: [captured('null-result')] }
    const text = markdown(summarize(run))
    expect(section(text, 'Groups')?.split('\n')[2]).toBe(
      '| example-pkg | 6.x | none | n/a | n/a | no result |',
    )
    expect(section(text, 'Failures')).toBe(
      '- `example-pkg` 6.x in `octo/app`: no result. The agent stopped, or gave no result that matched its schema.',
    )
    expect(section(text, 'Unknown groups')).toBeNull()
    expect(section(text, 'Reap')).toBe(
      [
        '0 of 1 groups came back with an empty `left_behind`.',
        '',
        '- `example-pkg` 6.x in `octo/app`: left on disk: `$ROOT/work/.claude/worktrees/fix-dependabot-example-pkg-6x`, branch `fix/dependabot-example-pkg-6x`. Not reaped: missing result block at $RESULT.',
        '',
        'A leftover under `.claude/worktrees/` comes off by hand with `git -C <repo_root> worktree remove --force <path>` when no agent is in flight.',
      ].join('\n'),
    )
  })

  it('reports a mispaired entry as unknown, and not as a failure', () => {
    const run: Run = {
      entries: [entry(plain, null, { mispaired: true })],
      reports: [captured('mispaired')],
    }
    const text = markdown(summarize(run))
    expect(section(text, 'Groups')?.split('\n')[2]).toBe(
      '| example-pkg | 6.x | none | n/a | n/a | unknown: mispaired result |',
    )
    expect(section(text, 'Unknown groups')).toBe(
      '- `example-pkg` 6.x in `octo/app`: unknown. Its result named another group, so it was not read. This is a defect of the dispatch workflow, not of the repository.',
    )
    expect(section(text, 'Failures')).toBeNull()
  })

  it('reports an unparsable result with the reason of its report, and does not read it', () => {
    const run: Run = {
      entries: [entry(PKG, 'done')],
      reports: [
        report(PKG, 'unparsable', {
          reason: 'unparseable result block at entry 0 of results.json',
        }),
      ],
    }
    const text = markdown(summarize(run))
    expect(section(text, 'Groups')?.split('\n')[2]).toBe(
      '| example-pkg | 6.x | none | n/a | n/a | result not read |',
    )
    expect(section(text, 'Failures')).toBe(
      '- `example-pkg` 6.x in `octo/app`: the result was not read: unparseable result block at entry 0 of results.json.',
    )
  })
})

describe('an interrupted run', () => {
  const other = grp('other-pkg', '1')
  const args = (...groups: Grp[]) => ({
    cap: 2,
    dispatches: groups.map((group) => ({ group, repo_root: ROOT, default_branch: 'main' })),
  })

  it('names each dispatch with no entry as unknown, and says where the run stopped', () => {
    const run: Run = {
      entries: [entry(other, success(other))],
      reports: [
        report(PKG, 'missing', { reason: 'missing result block at entry 0 of results.json' }),
        reaped(other),
      ],
      args: args(PKG, other),
    }
    const text = markdown(summarize(run))
    expect(section(text, 'Unknown groups')).toBe(
      [
        'The run was interrupted: the workflow returned 1 of 2 entries.',
        '',
        '- `example-pkg` 6.x in `octo/app`: unknown. The workflow returned no entry for it. It can have opened a pull request that nothing here read.',
      ].join('\n'),
    )
    expect(section(text, 'Groups')?.split('\n').slice(2)).toEqual([
      '| example-pkg | 6.x | none | n/a | n/a | unknown: no entry |',
      `| other-pkg | 1.x | ${URL} | Medium (4) | 1/2 | scoped override |`,
    ])
    expect(section(text, 'Failures')).toBeNull()
  })

  it('pairs an entry by its repository and its branch, not its branch alone', () => {
    const lib = grp('example-pkg', '6', 'octo/lib')
    const run: Run = {
      entries: [entry(lib, success(lib), { root: '/Users/example/src/octo/lib' })],
      reports: [report(PKG, 'missing'), reaped(lib)],
      args: args(PKG, lib),
      discovery: discovery({
        checkouts: [
          CHECKOUT,
          { ...CHECKOUT, checkout: '/Users/example/src/octo/lib', nwo: 'octo/lib' },
        ],
      }),
    }
    expect(sectionOf(run, 'Groups')?.split('\n').slice(2)).toEqual([
      '| octo/app | example-pkg | 6.x | none | n/a | n/a | unknown: no entry |',
      `| octo/lib | example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override |`,
    ])
  })

  it('says nothing of an interruption when each dispatch has its entry', () => {
    const run: Run = { ...CLEAN, args: args(PKG) }
    expect(markdown(summarize(run))).toBe(markdown(summarize(CLEAN)))
  })
})

describe('a no-op', () => {
  it('gets its own line with the merged pull request, and a row that points to it', () => {
    const run: Run = {
      entries: [entry(PKG, noOp(PKG, { merged_pr_url: 'https://github.com/octo/app/pull/597' }))],
      reports: [
        report(PKG, 'no-op', {
          reason: 'no-op: the agent made no fix, so there is nothing to verify or reap',
        }),
      ],
    }
    const text = markdown(summarize(run))
    expect(section(text, 'Already fixed')).toBe(
      [
        '- `example-pkg` 6.x in `octo/app`: the scoped overrides are already on main. The fix merged in https://github.com/octo/app/pull/597.',
        '',
        'Validate confirms that the installed versions clear these alerts. Dependabot has not scanned again yet, so the alerts can still show as open.',
      ].join('\n'),
    )
    expect(section(text, 'Groups')?.split('\n')[2]).toBe(
      '| example-pkg | 6.x | none | n/a | n/a | no-op: already fixed (see Already fixed) |',
    )
    expect(section(text, 'Failures')).toBeNull()
  })

  it.each([
    ['null', { merged_pr_url: null }],
    ['absent', {}],
  ])('names no merged pull request when merged_pr_url is %s', (_name, evidence) => {
    const run: Run = { entries: [entry(PKG, noOp(PKG, evidence))], reports: [report(PKG, 'no-op')] }
    expect(sectionOf(run, 'Already fixed')?.split('\n')[0]).toBe(
      '- `example-pkg` 6.x in `octo/app`: the scoped overrides are already on main.',
    )
  })
})

describe('a result that disagrees with its dispatch', () => {
  it('reads the report that names the branch of the result, as reap-batch gives it', () => {
    const dispatched = { ...PKG, branch_name: 'fix/other' }
    const run: Run = { entries: [entry(dispatched, success(PKG))], reports: [reaped(PKG)] }
    expect(sectionOf(run, 'Groups')?.split('\n')[2]).toBe(
      `| example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override |`,
    )
  })
})

describe('a warning of the Workflow log', () => {
  it('adds unverified bookkeeping to the Notes of its group', () => {
    const run: Run = {
      ...CLEAN,
      logs: [
        'Dispatching 1 group(s), 1 at a time',
        'Cross-field inconsistency in the result for octo/app example-pkg 6: status "success" requires a non-null risk',
      ],
    }
    expect(sectionOf(run, 'Groups')?.split('\n')[2]).toBe(
      `| example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override; unverified bookkeeping: status "success" requires a non-null risk |`,
    )
  })
})

describe('the text of an input', () => {
  it('escapes a pipe in a table cell', () => {
    const run: Run = {
      ...CLEAN,
      logs: ['Cross-field inconsistency in the result for octo/app example-pkg 6: a | b'],
    }
    expect(sectionOf(run, 'Groups')?.split('\n')[2]).toBe(
      `| example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override; unverified bookkeeping: a \\| b |`,
    )
  })
})

describe('the checkouts and repositories that the batch never touched', () => {
  it('names each excluded checkout with its reason, and its output when there is one', () => {
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        excluded: [
          { checkout: '/Users/example/src/octo/a', reason: 'no usable origin', stderr: '' },
          {
            checkout: '/Users/example/src/octo/b',
            reason: 'branch namespace probe failed twice',
            stderr: 'fatal: could not read Username\n',
          },
        ],
      }),
    }
    expect(sectionOf(run, 'Excluded checkouts and repositories')).toBe(
      [
        '- `/Users/example/src/octo/a`: no usable origin.',
        '- `/Users/example/src/octo/b`: branch namespace probe failed twice. Output: fatal: could not read Username ',
      ].join('\n'),
    )
  })

  const TAIL = 'The failure can be transient. A new run of the skill probes again.'
  const HEAD =
    '- `octo/app` (`/Users/example/src/octo/app`): the registry preflight excluded each group of this repository.'

  it.each([
    [
      'auth',
      '@example-scope/a',
      'npm error code E401',
      'The probe of `@example-scope/a` got an auth failure (HTTP 401 or 403): the registry credentials are dead. Run the login flow of that registry. Output: npm error code E401',
    ],
    [
      'not-found',
      'a',
      null,
      'The probe of `a` got not-found (HTTP 404): the registry that the probe reached has no such package. Check the scope routing.',
    ],
    [
      'network',
      'a',
      '',
      'The probe of `a` failed with a network problem, such as a time limit, DNS or a reset.',
    ],
    ['start', 'a', null, 'The package manager did not start for the probe of `a`.'],
    ['start', null, null, 'The package manager did not start for the probe of the package.'],
    [
      'detect',
      null,
      'no lockfile',
      'The adapter could not detect the package manager. Output: no lockfile',
    ],
  ])('names a %s exclusion of the registry preflight', (cause, probe, stderr, words) => {
    const run: Run = {
      ...CLEAN,
      preflight: {
        [ROOT]: {
          ok: false,
          pm: null,
          pm_exec: null,
          probe_package: probe,
          cause,
          stderr,
          exclude_error: null,
        },
      },
    }
    expect(sectionOf(run, 'Excluded checkouts and repositories')).toBe(`${HEAD} ${words} ${TAIL}`)
  })

  it('names a preflight-repo call that failed', () => {
    const run: Run = {
      ...CLEAN,
      preflight: { [ROOT]: { error: 'a manifest that cannot be read' } },
    }
    expect(sectionOf(run, 'Excluded checkouts and repositories')).toBe(
      `${HEAD} preflight-repo failed: a manifest that cannot be read. ${TAIL}`,
    )
  })

  it('names the repository of the checkout that the preflight excluded', () => {
    // The second kept checkout is the one excluded, so its own nwo is named.
    const LIB = '/Users/example/src/octo/lib'
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        checkouts: [CHECKOUT, { ...CHECKOUT, checkout: LIB, nwo: 'octo/lib' }],
      }),
      preflight: { [LIB]: { error: 'a manifest that cannot be read' } },
    }
    expect(sectionOf(run, 'Excluded checkouts and repositories')).toBe(
      `- \`octo/lib\` (\`${LIB}\`): the registry preflight excluded each group of this repository. preflight-repo failed: a manifest that cannot be read. ${TAIL}`,
    )
  })

  it('says nothing of a preflight that answered', () => {
    const run: Run = {
      ...CLEAN,
      preflight: {
        [ROOT]: {
          ok: true,
          pm: 'npm',
          pm_exec: 'npm',
          probe_package: 'a',
          cause: null,
          stderr: null,
          exclude_error: null,
        },
      },
    }
    expect(sectionOf(run, 'Excluded checkouts and repositories')).toBeNull()
  })

  const EXCLUDE_LINE =
    '- `octo/app` (`/Users/example/src/octo/app`): the worktree exclude could not be written: lock held. Worktree directories can show in `git status` there.'

  it('names an exclude error of a preflight that answered ok, and excludes nothing', () => {
    const run: Run = {
      ...CLEAN,
      preflight: {
        [ROOT]: {
          ok: true,
          pm: 'npm',
          pm_exec: 'npm',
          probe_package: 'a',
          cause: null,
          stderr: null,
          exclude_error: 'lock held',
        },
      },
    }
    expect(sectionOf(run, 'Observations')).toBe(EXCLUDE_LINE)
    expect(sectionOf(run, 'Excluded checkouts and repositories')).toBeNull()
  })

  it('names an exclude error of a preflight that excluded the repository, in both sections', () => {
    const run: Run = {
      ...CLEAN,
      preflight: {
        [ROOT]: {
          ok: false,
          pm: 'npm',
          pm_exec: 'npm',
          probe_package: 'a',
          cause: 'network',
          stderr: null,
          exclude_error: 'lock held',
        },
      },
    }
    expect(sectionOf(run, 'Observations')).toBe(EXCLUDE_LINE)
    expect(sectionOf(run, 'Excluded checkouts and repositories')).toContain(
      'failed with a network problem',
    )
  })

  it('names no exclude error when a failed preflight has none', () => {
    const run: Run = {
      ...CLEAN,
      preflight: {
        [ROOT]: {
          ok: false,
          pm: 'npm',
          pm_exec: 'npm',
          probe_package: 'a',
          cause: 'network',
          stderr: null,
          exclude_error: null,
        },
      },
    }
    expect(sectionOf(run, 'Observations')).toBeNull()
  })

  it('names each repository whose batch ran under the flat branch scheme', () => {
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        checkouts: [
          CHECKOUT,
          {
            ...CHECKOUT,
            checkout: '/Users/example/src/octo/lib',
            nwo: 'octo/lib',
            branch_style: 'flat',
          },
        ],
      }),
    }
    expect(sectionOf(run, 'Flat branch scheme')).toBe(
      '- `octo/lib`: a remote branch named `fix` takes the `fix/*` ref namespace, so the pull requests of this repository come from `fix-dependabot-...` branches.',
    )
  })
})

describe('the skips of phase 2', () => {
  it('names each shared-parent skip with its parents', () => {
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        skipped: [
          {
            package: 'qs',
            major_line: '6',
            repo: 'octo/app',
            reason: 'shared parent across major lines',
            collision_parents: ['express', 'body-parser'],
          },
        ],
      }),
    }
    expect(sectionOf(run, 'Shared-parent skips')).toBe(
      '- `qs` 6.x in `octo/app`: the line shares the parents `express`, `body-parser` with another major line, and no override key can scope them apart. Bump the shared parent past the old line, or remove the dependent that pins it.',
    )
    expect(sectionOf(run, 'Other skips')).toBeNull()
  })

  it('names each other skip with its open PR or its error', () => {
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        skipped: [
          { package: 'a', major_line: 'none', repo: 'octo/app', reason: 'no fix available' },
          {
            package: 'b',
            major_line: '2',
            repo: 'octo/app',
            reason: 'open PR exists',
            open_pr_url: 'https://github.com/octo/app/pull/9',
          },
          {
            package: 'c',
            major_line: 3,
            repo: 'octo/app',
            reason: 'PR check failed',
            error: 'gh: HTTP 502',
          },
          {
            package: 'd',
            major_line: '1',
            repo: 'octo/app',
            reason: 'ecosystem not supported yet',
          },
        ],
      }),
    }
    expect(sectionOf(run, 'Other skips')).toBe(
      [
        '- `a` (no fix line) in `octo/app`: no fix available.',
        '- `b` 2.x in `octo/app`: open PR exists (https://github.com/octo/app/pull/9).',
        '- `c` 3.x in `octo/app`: PR check failed: gh: HTTP 502.',
        '- `d` 1.x in `octo/app`: ecosystem not supported yet.',
      ].join('\n'),
    )
  })
})

describe('an open PR on another branch scheme', () => {
  // `discover-alerts` gives the open PR of a flat-scheme twin or of a legacy
  // branch under its own reason, with `open_pr_url`.
  it.each([
    ['open PR exists (flat-scheme branch fix-dependabot-b-2x)'],
    ['open PR exists (legacy branch fix/dependabot-b)'],
  ])('names the pull request of %s', (reason) => {
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        skipped: [
          {
            package: 'b',
            major_line: '2',
            repo: 'octo/app',
            reason,
            open_pr_url: 'https://github.com/octo/app/pull/9',
          },
        ],
      }),
    }
    expect(sectionOf(run, 'Other skips')).toBe(
      `- \`b\` 2.x in \`octo/app\`: ${reason} (https://github.com/octo/app/pull/9).`,
    )
  })

  it('refuses one with no open_pr_url', () => {
    const run: Run = {
      ...CLEAN,
      discovery: discovery({
        skipped: [
          {
            package: 'b',
            major_line: '2',
            repo: 'octo/app',
            reason: 'open PR exists (legacy branch fix/dependabot-b)',
          },
        ],
      }),
    }
    expect(message(summarize(run))).toBe(
      'summarize-run: merged.json: skipped[0].open_pr_url is not text',
    )
  })
})

describe('the reap', () => {
  const WORK = workOf(PKG)
  const HINT =
    'A leftover under `.claude/worktrees/` comes off by hand with `git -C <repo_root> worktree remove --force <path>` when no agent is in flight.'

  /** A cleanup report of the driver, with the given fields changed. */
  const cleanup = (changes: Record<string, JsonValue> = {}) => ({
    worktree: { path: `/private${WORK}/fix`, action: 'failed' },
    work_dir: { path: `/private${WORK}`, action: 'skipped' },
    branch: PKG.branch_name,
    branch_deleted: false,
    branch_tip: null,
    reason: null,
    detail: null,
    errors: ['git worktree remove --force failed: locked'],
    ...changes,
  })

  it('counts the clean reports, names what stays, and gives the way to remove it', () => {
    const other = grp('other-pkg', '1')
    const run: Run = {
      entries: [entry(PKG, success(PKG)), entry(other, success(other))],
      reports: [reaped(PKG, { left_behind: [PKG.branch_name] }), reaped(other)],
    }
    expect(sectionOf(run, 'Reap')).toBe(
      [
        '1 of 2 groups came back with an empty `left_behind`.',
        '',
        '- `example-pkg` 6.x in `octo/app`: left on disk: branch `fix/dependabot-example-pkg-6x`.',
        '',
        HINT,
      ].join('\n'),
    )
  })

  it('gives the count alone for a run that left nothing', () => {
    expect(sectionOf(CLEAN, 'Reap')).toBe(
      '1 of 1 groups came back with an empty `left_behind`: nothing was left behind.',
    )
  })

  it('names the errors of a report that left nothing', () => {
    const run: Run = {
      entries: [entry(PKG, success(PKG))],
      reports: [reaped(PKG, { errors: ["the result's package disagrees"] })],
    }
    expect(sectionOf(run, 'Reap')).toBe(
      [
        '1 of 1 groups came back with an empty `left_behind`: nothing was left behind.',
        '',
        "- `example-pkg` 6.x in `octo/app`: nothing is left on disk. Errors: the result's package disagrees.",
      ].join('\n'),
    )
  })

  it('names two artifacts when one path ends with the text of the other inside a name', () => {
    const glued = `/x${WORK.slice(1)}`
    const run: Run = {
      entries: [
        entry(
          PKG,
          failure(PKG, 'pr', 'failed', {
            cleanup: cleanup({
              errors: [],
              work_dir: { path: glued, action: 'failed' },
              worktree: { path: `${glued}/fix`, action: 'failed' },
            }),
          }),
        ),
      ],
      reports: [report(PKG, 'failure', { left_behind: [WORK] })],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: left on disk: \`${WORK}\`. Not reaped: the result is failure. The agent's cleanup: worktree \`${glued}/fix\` (failed), work directory \`${glued}\` (failed), branch \`fix/dependabot-example-pkg-6x\` (not deleted).`,
    )
  })

  it('names the errors of a report', () => {
    const run: Run = {
      entries: [entry(PKG, success(PKG))],
      reports: [
        reaped(PKG, { left_behind: [WORK], errors: [`${WORK} was not removed: EACCES`, 'second'] }),
      ],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: left on disk: \`${WORK}\`. Errors: ${WORK} was not removed: EACCES; second.`,
    )
  })

  it('says it once when left_behind and cleanup name one directory, and shows the resolved path', () => {
    // The driver resolved /private/var, and the reap derived /var: the same
    // directory, matched on its end.
    const run: Run = {
      entries: [entry(PKG, success(PKG, { cleanup: cleanup() }))],
      reports: [reaped(PKG, { left_behind: [WORK, PKG.branch_name] })],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\` shipped ${URL}, and its own cleanup did not finish: left on disk: \`/private${WORK}\` (skipped in the agent's cleanup), branch \`fix/dependabot-example-pkg-6x\`. The agent's cleanup: worktree \`/private${WORK}/fix\` (failed): git worktree remove --force failed: locked.`,
    )
  })

  it('matches a path that is the same text', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          failure(PKG, 'pr', 'gh failed', {
            cleanup: cleanup({ work_dir: { path: WORK, action: 'failed' } }),
          }),
        ),
      ],
      reports: [
        report(PKG, 'failure', {
          reason: "failure: the agent's result was a failure",
          left_behind: [WORK],
        }),
      ],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: left on disk: \`${WORK}\` (failed in the agent's cleanup). Not reaped: failure: the agent's result was a failure. The agent's cleanup: worktree \`/private${WORK}/fix\` (failed), branch \`fix/dependabot-example-pkg-6x\` (not deleted): git worktree remove --force failed: locked.`,
    )
  })

  it('says it once when the cleanup path is the shorter one', () => {
    // The reverse of the example that says it once with the resolved path:
    // here the report has the longer text.
    const run: Run = {
      entries: [
        entry(
          PKG,
          failure(PKG, 'pr', 'gh failed', {
            cleanup: cleanup({ work_dir: { path: WORK, action: 'skipped' } }),
          }),
        ),
      ],
      reports: [report(PKG, 'failure', { left_behind: [`/private${WORK}`] })],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: left on disk: \`${WORK}\` (skipped in the agent's cleanup). Not reaped: the result is failure. The agent's cleanup: worktree \`/private${WORK}/fix\` (failed), branch \`fix/dependabot-example-pkg-6x\` (not deleted): git worktree remove --force failed: locked.`,
    )
  })

  it('names two artifacts when the paths differ after the match', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          success(PKG, {
            cleanup: cleanup({
              work_dir: { path: '/elsewhere/work', action: 'failed' },
              worktree: { path: '/elsewhere/work/fix', action: 'failed' },
            }),
          }),
        ),
      ],
      reports: [reaped(PKG, { left_behind: [WORK] })],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\` shipped ${URL}, and its own cleanup did not finish: left on disk: \`${WORK}\`. The agent's cleanup: worktree \`/elsewhere/work/fix\` (failed), work directory \`/elsewhere/work\` (failed), branch \`fix/dependabot-example-pkg-6x\` (not deleted): git worktree remove --force failed: locked.`,
    )
  })

  it('says that the reap cleared what the agent could not', () => {
    const run: Run = {
      entries: [entry(PKG, success(PKG, { cleanup: cleanup({ branch_deleted: true }) }))],
      reports: [reaped(PKG)],
    }
    expect(sectionOf(run, 'Reap')).toBe(
      [
        '1 of 1 groups came back with an empty `left_behind`: nothing was left behind.',
        '',
        `- \`example-pkg\` 6.x in \`octo/app\` shipped ${URL}, and its own cleanup did not finish: the reap cleared what the agent could not. The agent's cleanup: worktree \`/private${WORK}/fix\` (failed), work directory \`/private${WORK}\` (skipped), branch \`fix/dependabot-example-pkg-6x\` (deleted): git worktree remove --force failed: locked.`,
      ].join('\n'),
    )
    expect(sectionOf(run, 'Groups')?.split('\n')[2]).toBe(
      `| example-pkg | 6.x | ${URL} | Medium (4) | 1/2 | scoped override; shipped, and its cleanup did not finish (see Reap) |`,
    )
    // A shipped pull request with a leak is never a failed group.
    expect(sectionOf(run, 'Failures')).toBeNull()
  })

  it('gives the reason, the errors and the detail of a cleanup in that order, and no branch state when it has none', () => {
    const { branch_deleted: _, ...noState } = cleanup({
      reason: 'the reason',
      detail: 'the detail',
      errors: ['e1', 'e2'],
    })
    const run: Run = {
      entries: [entry(PKG, failure(PKG, 'worktree', 'cleanup failed', { cleanup: noState }))],
      reports: [report(PKG, 'failure')],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: nothing is left on disk. The agent's cleanup: worktree \`/private${WORK}/fix\` (failed), work directory \`/private${WORK}\` (skipped), branch \`fix/dependabot-example-pkg-6x\`: the reason; e1; e2; the detail.`,
    )
  })

  it('names only the reasons of a cleanup whose artifacts the line already names', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          failure(PKG, 'pr', 'failed', {
            cleanup: cleanup({
              worktree: { path: WORK, action: 'failed' },
              work_dir: { path: WORK, action: 'failed' },
            }),
          }),
        ),
      ],
      reports: [report(PKG, 'failure', { left_behind: [WORK, PKG.branch_name] })],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: left on disk: \`${WORK}\` (failed in the agent's cleanup), branch \`fix/dependabot-example-pkg-6x\`. Not reaped: the result is failure. The agent's cleanup: git worktree remove --force failed: locked.`,
    )
  })

  it('says nothing more of a cleanup with no reason whose artifacts the line names', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          failure(PKG, 'pr', 'failed', {
            cleanup: cleanup({
              errors: [],
              worktree: { path: WORK, action: 'failed' },
              work_dir: { path: WORK, action: 'failed' },
            }),
          }),
        ),
      ],
      reports: [report(PKG, 'failure', { left_behind: [WORK, PKG.branch_name] })],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: left on disk: \`${WORK}\` (failed in the agent's cleanup), branch \`fix/dependabot-example-pkg-6x\`. Not reaped: the result is failure.`,
    )
  })

  it('reads a cleanup with no reason and no detail key, and skips an empty reason', () => {
    const { reason: _r, detail: _d, ...bare } = cleanup({ errors: ['e'] })
    const empty = cleanup({ reason: '', errors: ['e'] })
    for (const given of [bare, empty]) {
      const run: Run = {
        entries: [entry(PKG, failure(PKG, 'worktree', 'failed', { cleanup: given }))],
        reports: [report(PKG, 'failure')],
      }
      expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
        `- \`example-pkg\` 6.x in \`octo/app\`: nothing is left on disk. The agent's cleanup: worktree \`/private${WORK}/fix\` (failed), work directory \`/private${WORK}\` (skipped), branch \`fix/dependabot-example-pkg-6x\` (not deleted): e.`,
      )
    }
  })

  it('gives no reason when the cleanup has none', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          failure(PKG, 'worktree', 'failed', { cleanup: cleanup({ errors: [], reason: '' }) }),
        ),
      ],
      reports: [report(PKG, 'failure')],
    }
    expect(sectionOf(run, 'Reap')?.split('\n')[2]).toBe(
      `- \`example-pkg\` 6.x in \`octo/app\`: nothing is left on disk. The agent's cleanup: worktree \`/private${WORK}/fix\` (failed), work directory \`/private${WORK}\` (skipped), branch \`fix/dependabot-example-pkg-6x\` (not deleted).`,
    )
  })
})

describe('the observations', () => {
  const lib = grp('lib-pkg', '2', 'octo/lib')
  const LIB = '/Users/example/src/octo/lib'
  const twoRepos = discovery({
    checkouts: [CHECKOUT, { ...CHECKOUT, checkout: LIB, nwo: 'octo/lib' }],
  })

  it('names each added override with its pull request, and each repository with its pre-existing keys once', () => {
    const other = grp('other-pkg', '1')
    const pre = {
      type: 'unscoped_override',
      key: 'minimatch',
      range: '^9.0.7',
      targets_this_package: false,
    }
    const run: Run = {
      entries: [
        entry(
          PKG,
          success(PKG, {
            action: 'bare-override',
            bare_override: 'added',
            observations: [
              pre,
              {
                type: 'unscoped_override_added',
                key: 'sharp',
                range: '>=0.35.0 <1',
                reason: 'no parent can scope it',
              },
            ],
          }),
        ),
        // The same pre-existing override in the same repository, with its
        // keys in another order, is one entry.
        entry(
          other,
          failure(other, 'install', 'failed', {
            observations: [
              {
                targets_this_package: false,
                range: '^9.0.7',
                key: 'minimatch',
                type: 'unscoped_override',
              },
              { type: 'unscoped_override', key: 'semver', range: '^7' },
            ],
          }),
        ),
        entry(
          lib,
          success(lib, {
            observations: [
              pre,
              { type: 'pnpm_major_unknown' },
              { type: 'pnpm_major_unknown', package: 'x' },
            ],
          }),
          { root: LIB },
        ),
      ],
      reports: [reaped(PKG), report(other, 'failure'), reaped(lib)],
      discovery: twoRepos,
    }
    expect(sectionOf(run, 'Observations')).toBe(
      [
        'This batch added 1 unscoped global override(s):',
        '',
        `- \`sharp\` \`>=0.35.0 <1\` in \`octo/app\` (${URL}), because no parent can scope it. It pins \`sharp\` for every consumer in that repository, including copies that were never vulnerable.`,
        '',
        '- Note: `octo/app` contains 2 unscoped global override(s): `minimatch`, `semver`. These may be removable or convertible to scoped pins. `/gh-security:audit-pins` tests removability.',
        '- Note: `octo/lib` contains 1 unscoped global override(s): `minimatch`. These may be removable or convertible to scoped pins. `/gh-security:audit-pins` tests removability.',
        '- `pnpm_major_unknown` in `octo/lib`: 2 observation(s).',
      ].join('\n'),
    )
  })

  it('keeps one of each identical observation of one repository, and counts each type by repository', () => {
    const again = grp('again-pkg', '4')
    const observations: JsonValue[] = [
      { type: 'unscoped_override_added', key: 'sharp', range: '<1', reason: 'r' },
      { type: 'pnpm_major_unknown' },
    ]
    const run: Run = {
      entries: [
        entry(PKG, success(PKG, { action: 'bare-override', bare_override: 'added', observations })),
        entry(
          again,
          success(again, {
            action: 'bare-override',
            bare_override: 'added',
            observations: [...observations, { type: 'pnpm_major_unknown' }],
          }),
        ),
        entry(lib, success(lib, { observations: [{ type: 'pnpm_major_unknown' }] }), { root: LIB }),
      ],
      reports: [reaped(PKG), reaped(again), reaped(lib)],
      discovery: twoRepos,
    }
    expect(sectionOf(run, 'Observations')).toBe(
      [
        'This batch added 1 unscoped global override(s):',
        '',
        `- \`sharp\` \`<1\` in \`octo/app\` (${URL}), because r. It pins \`sharp\` for every consumer in that repository, including copies that were never vulnerable.`,
        '',
        '- `pnpm_major_unknown` in `octo/app`: 1 observation(s).',
        '- `pnpm_major_unknown` in `octo/lib`: 1 observation(s).',
      ].join('\n'),
    )
  })

  it('keeps one of two observations that differ only in the order of their keys', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          success(PKG, {
            observations: [
              { type: 'pnpm_major_unknown', package: 'a', line: '1' },
              { line: '1', package: 'a', type: 'pnpm_major_unknown' },
            ],
          }),
        ),
      ],
      reports: [reaped(PKG)],
    }
    expect(sectionOf(run, 'Observations')).toBe(
      '- `pnpm_major_unknown` in `octo/app`: 1 observation(s).',
    )
  })

  it('names an added override of a group with no pull request', () => {
    const run: Run = {
      entries: [
        entry(
          PKG,
          failure(PKG, 'install', 'failed', {
            bare_override: 'added',
            observations: [
              { type: 'unscoped_override_added', key: 'sharp', range: '<1', reason: 'r' },
            ],
          }),
        ),
      ],
      reports: [report(PKG, 'failure')],
    }
    expect(sectionOf(run, 'Observations')).toBe(
      [
        'This batch added 1 unscoped global override(s):',
        '',
        '- `sharp` `<1` in `octo/app` (no pull request), because r. It pins `sharp` for every consumer in that repository, including copies that were never vulnerable.',
      ].join('\n'),
    )
  })
})

describe('an input that is refused', () => {
  const NOP = grp('nop-pkg', '2')
  const BAD = grp('bad-pkg', '3')
  const added = { type: 'unscoped_override_added', key: 'sharp', range: '<1', reason: 'r' }

  /** A valid run that has each field the command reads. */
  const base = (): Record<string, unknown> => ({
    'workflow.json': {
      result: [
        entry(
          PKG,
          success(PKG, {
            action: 'bare-override',
            bare_override: 'added',
            observations: [{ type: 'unscoped_override', key: 'minimatch' }, added],
            requires_major_bump: [{ version: '5.0.0', vulnerable_ranges: ['< 5.1.0'] }],
            cleanup: {
              worktree: { path: `${workOf(PKG)}/fix`, action: 'failed' },
              work_dir: { path: workOf(PKG), action: 'skipped' },
              branch: PKG.branch_name,
              branch_deleted: false,
              reason: 'r',
              detail: 'd',
              errors: ['e'],
            },
          }),
        ),
        entry(NOP, noOp(NOP, { merged_pr_url: 'https://github.com/octo/app/pull/1' })),
        entry(BAD, failure(BAD, 'install', 'failed')),
      ],
      logs: [],
    },
    'reports.json': [reaped(PKG), report(NOP, 'no-op'), report(BAD, 'failure')],
    'merged.json': discovery({
      excluded: [{ checkout: '/Users/example/src/octo/x', reason: 'no usable origin', stderr: '' }],
      skipped: [
        {
          package: 'a',
          major_line: '1',
          repo: 'octo/app',
          reason: 'requires major version bump',
          resolved_majors: ['0'],
        },
        {
          package: 'b',
          major_line: '1',
          repo: 'octo/app',
          reason: 'shared parent across major lines',
          collision_parents: ['p'],
        },
        {
          package: 'c',
          major_line: '1',
          repo: 'octo/app',
          reason: 'open PR exists',
          open_pr_url: 'https://github.com/octo/app/pull/2',
        },
        { package: 'd', major_line: '1', repo: 'octo/app', reason: 'PR check failed', error: 'e' },
      ],
    }),
    'preflight.json': {
      [ROOT]: { ok: false, probe_package: 'a', cause: 'auth', stderr: null, exclude_error: null },
    },
    'args.json': {
      cap: 1,
      dispatches: [PKG, NOP, BAD].map((group) => ({ group: { ...group }, repo_root: ROOT })),
    },
  })

  const ARGS = [
    '--workflow',
    'workflow.json',
    '--reports',
    'reports.json',
    '--discovery',
    'merged.json',
    '--preflight',
    'preflight.json',
    '--args',
    'args.json',
  ]

  const GONE = Symbol('gone')

  /** The base run with the value at `path` of one file set, or removed for `GONE`. */
  const refusal = (file: string, path: readonly (string | number)[], to: unknown): string => {
    const files = structuredClone(base())
    if (path.length === 0) {
      files[file] = to
    } else {
      const at = path
        .slice(0, -1)
        .reduce<Record<string | number, unknown>>(
          (node, key) => node[key] as Record<string | number, unknown>,
          files[file] as Record<string | number, unknown>,
        )
      const last = path[path.length - 1] as string | number
      if (to === GONE) Reflect.deleteProperty(at, last)
      else at[last] = to
    }
    return message(summarizeRun(context(ARGS), inputs(files)))
  }

  it('reads the base run, which has each field', () => {
    expect(markdown(summarizeRun(context(ARGS), inputs(base())))).toMatch(/^## Still vulnerable/)
  })

  const R0 = ['result', 0, 'result']
  const D0 = ['result', 0, 'dispatch']

  it.each([
    // The Workflow result.
    ['workflow.json', [], [], 'the file is not an object'],
    ['workflow.json', ['result'], {}, 'result is not a list'],
    ['workflow.json', ['result', 0], 'x', 'result[0] is not an object'],
    ['workflow.json', D0, null, 'result[0].dispatch is not an object'],
    ['workflow.json', [...D0, 'group'], GONE, 'result[0].dispatch.group is not an object'],
    [
      'workflow.json',
      [...D0, 'group', 'package'],
      '',
      'result[0].dispatch.group.package is not text',
    ],
    [
      'workflow.json',
      [...D0, 'group', 'major_line'],
      1.5,
      'result[0].dispatch.group.major_line is not text or a whole number',
    ],
    [
      'workflow.json',
      [...D0, 'group', 'major_line'],
      -1,
      'result[0].dispatch.group.major_line is not text or a whole number',
    ],
    [
      'workflow.json',
      [...D0, 'group', 'major_line'],
      '',
      'result[0].dispatch.group.major_line is not text or a whole number',
    ],
    [
      'workflow.json',
      [...D0, 'group', 'branch_name'],
      5,
      'result[0].dispatch.group.branch_name is not text',
    ],
    ['workflow.json', [...D0, 'group', 'repo'], GONE, 'result[0].dispatch.group.repo is not text'],
    ['workflow.json', [...D0, 'repo_root'], GONE, 'result[0].dispatch.repo_root is not text'],
    ['workflow.json', ['result', 0, 'mispaired'], 'no', 'result[0].mispaired is not true or false'],
    ['workflow.json', R0, GONE, 'result[0] has no result'],
    ['workflow.json', ['logs'], GONE, 'logs is not a list'],
    ['workflow.json', ['logs', 0], 5, 'logs[0] is not text'],
    // The result of a group, read by its report.
    ['workflow.json', R0, [], 'result[0].result is not an object'],
    [
      'workflow.json',
      [...R0, 'status'],
      'failure',
      'result[0].result.status is not success, as its report gives it',
    ],
    ['workflow.json', [...R0, 'branch'], GONE, 'result[0].result.branch is not text'],
    ['workflow.json', [...R0, 'pr_url'], null, 'result[0].result.pr_url is not text'],
    ['workflow.json', ['result', 2, 'result', 'pr_url'], 5, 'result[2].result.pr_url is not text'],
    ['workflow.json', [...R0, 'observations'], GONE, 'result[0].result.observations is not a list'],
    [
      'workflow.json',
      [...R0, 'observations', 0],
      'x',
      'result[0].result.observations[0] is not an object',
    ],
    [
      'workflow.json',
      [...R0, 'observations', 0, 'type'],
      '',
      'result[0].result.observations[0].type is not text',
    ],
    [
      'workflow.json',
      [...R0, 'observations', 0, 'key'],
      GONE,
      'result[0].result.observations[0].key is not text',
    ],
    [
      'workflow.json',
      [...R0, 'observations', 1, 'key'],
      5,
      'result[0].result.observations[1].key is not text',
    ],
    [
      'workflow.json',
      [...R0, 'observations', 1, 'range'],
      GONE,
      'result[0].result.observations[1].range is not text',
    ],
    [
      'workflow.json',
      [...R0, 'observations', 1, 'reason'],
      null,
      'result[0].result.observations[1].reason is not text',
    ],
    [
      'workflow.json',
      [...R0, 'requires_major_bump'],
      null,
      'result[0].result.requires_major_bump is not a list',
    ],
    [
      'workflow.json',
      [...R0, 'requires_major_bump', 0],
      5,
      'result[0].result.requires_major_bump[0] is not an object',
    ],
    [
      'workflow.json',
      [...R0, 'requires_major_bump', 0, 'version'],
      GONE,
      'result[0].result.requires_major_bump[0].version is not text',
    ],
    [
      'workflow.json',
      [...R0, 'requires_major_bump', 0, 'vulnerable_ranges'],
      '< 5',
      'result[0].result.requires_major_bump[0].vulnerable_ranges is not a list',
    ],
    [
      'workflow.json',
      [...R0, 'requires_major_bump', 0, 'vulnerable_ranges', 0],
      5,
      'result[0].result.requires_major_bump[0].vulnerable_ranges[0] is not text',
    ],
    ['workflow.json', [...R0, 'cleanup'], 'leaked', 'result[0].result.cleanup is not an object'],
    ['workflow.json', [...R0, 'cleanup'], GONE, 'result[0].result.cleanup is not an object'],
    [
      'workflow.json',
      [...R0, 'cleanup', 'worktree'],
      GONE,
      'result[0].result.cleanup.worktree is not an object',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'worktree', 'path'],
      '',
      'result[0].result.cleanup.worktree.path is not text',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'worktree', 'action'],
      GONE,
      'result[0].result.cleanup.worktree.action is not text',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'work_dir'],
      null,
      'result[0].result.cleanup.work_dir is not an object',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'branch'],
      GONE,
      'result[0].result.cleanup.branch is not text',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'branch_deleted'],
      'no',
      'result[0].result.cleanup.branch_deleted is not true or false',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'branch_deleted'],
      null,
      'result[0].result.cleanup.branch_deleted is not true or false',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'reason'],
      5,
      'result[0].result.cleanup.reason is not text',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'detail'],
      [],
      'result[0].result.cleanup.detail is not text',
    ],
    [
      'workflow.json',
      [...R0, 'cleanup', 'errors'],
      GONE,
      'result[0].result.cleanup.errors is not a list',
    ],
    [
      'workflow.json',
      [...R0, 'action'],
      null,
      'result[0].result.action is not one of direct-update, scoped-override, bare-override, lockfile-refresh',
    ],
    [
      'workflow.json',
      [...R0, 'bare_override'],
      'removed',
      'result[0].result.bare_override is not one of none, added, tightened',
    ],
    ['workflow.json', [...R0, 'risk'], 'Low', 'result[0].result.risk is not an object'],
    ['workflow.json', [...R0, 'risk'], GONE, 'result[0].result.risk is not an object'],
    ['workflow.json', [...R0, 'risk', 'band'], GONE, 'result[0].result.risk.band is not text'],
    ['workflow.json', [...R0, 'risk', 'score'], '4', 'result[0].result.risk.score is not a number'],
    ['workflow.json', [...R0, 'risk', 'f4'], GONE, 'result[0].result.risk.f4 is not a number'],
    ['workflow.json', [...R0, 'risk', 'f5'], null, 'result[0].result.risk.f5 is not a number'],
    [
      'workflow.json',
      ['result', 1, 'result', 'no_op'],
      null,
      'result[1].result.no_op is not an object',
    ],
    [
      'workflow.json',
      ['result', 1, 'result', 'no_op', 'reason'],
      GONE,
      'result[1].result.no_op.reason is not text',
    ],
    [
      'workflow.json',
      ['result', 1, 'result', 'no_op', 'evidence'],
      GONE,
      'result[1].result.no_op.evidence is not an object',
    ],
    [
      'workflow.json',
      ['result', 1, 'result', 'no_op', 'evidence', 'merged_pr_url'],
      597,
      'result[1].result.no_op.evidence.merged_pr_url is not text',
    ],
    [
      'workflow.json',
      ['result', 2, 'result', 'failure'],
      null,
      'result[2].result.failure is not an object',
    ],
    [
      'workflow.json',
      ['result', 2, 'result', 'failure', 'phase'],
      '',
      'result[2].result.failure.phase is not text',
    ],
    [
      'workflow.json',
      ['result', 2, 'result', 'failure', 'detail'],
      GONE,
      'result[2].result.failure.detail is not text',
    ],
    // The reports.
    ['reports.json', [], {}, 'the file is not a list'],
    ['reports.json', [0], null, '[0] is not an object'],
    ['reports.json', [0, 'branch'], GONE, '[0].branch is not text'],
    ['reports.json', [0, 'worktree_path'], '', '[0].worktree_path is not text'],
    [
      'reports.json',
      [0, 'result_status'],
      'done',
      '[0].result_status is not one of success, no-op, failure, unparsable, missing',
    ],
    ['reports.json', [0, 'reaped'], GONE, '[0].reaped is not true or false'],
    ['reports.json', [0, 'reason'], 5, '[0].reason is not text'],
    ['reports.json', [0, 'left_behind'], 'x', '[0].left_behind is not a list'],
    ['reports.json', [0, 'left_behind'], [''], '[0].left_behind[0] is not text'],
    ['reports.json', [0, 'errors'], GONE, '[0].errors is not a list'],
    // The discovery.
    ['merged.json', [], null, 'the file is not an object'],
    ['merged.json', ['checkouts'], GONE, 'checkouts is not a list'],
    ['merged.json', ['checkouts', 0], 'x', 'checkouts[0] is not an object'],
    ['merged.json', ['checkouts', 0, 'checkout'], GONE, 'checkouts[0].checkout is not text'],
    ['merged.json', ['checkouts', 0, 'nwo'], null, 'checkouts[0].nwo is not text'],
    [
      'merged.json',
      ['checkouts', 0, 'branch_style'],
      'dash',
      'checkouts[0].branch_style is not one of slash, flat',
    ],
    ['merged.json', ['excluded'], {}, 'excluded is not a list'],
    ['merged.json', ['excluded', 0], 5, 'excluded[0] is not an object'],
    ['merged.json', ['excluded', 0, 'checkout'], '', 'excluded[0].checkout is not text'],
    ['merged.json', ['excluded', 0, 'reason'], GONE, 'excluded[0].reason is not text'],
    ['merged.json', ['excluded', 0, 'stderr'], null, 'excluded[0].stderr is not text'],
    ['merged.json', ['skipped'], GONE, 'skipped is not a list'],
    ['merged.json', ['skipped', 0], [], 'skipped[0] is not an object'],
    ['merged.json', ['skipped', 0, 'reason'], GONE, 'skipped[0].reason is not text'],
    ['merged.json', ['skipped', 0, 'package'], 5, 'skipped[0].package is not text'],
    [
      'merged.json',
      ['skipped', 0, 'major_line'],
      null,
      'skipped[0].major_line is not text or a whole number',
    ],
    ['merged.json', ['skipped', 0, 'repo'], GONE, 'skipped[0].repo is not text'],
    [
      'merged.json',
      ['skipped', 0, 'resolved_majors'],
      GONE,
      'skipped[0].resolved_majors is not a list',
    ],
    [
      'merged.json',
      ['skipped', 1, 'collision_parents'],
      'p',
      'skipped[1].collision_parents is not a list',
    ],
    ['merged.json', ['skipped', 2, 'open_pr_url'], GONE, 'skipped[2].open_pr_url is not text'],
    ['merged.json', ['skipped', 3, 'error'], '', 'skipped[3].error is not text'],
    // The preflight answers.
    ['preflight.json', [], [], 'the file is not an object'],
    ['preflight.json', [ROOT], 'failed', `"${ROOT}" is not an object`],
    ['preflight.json', [ROOT, 'ok'], GONE, `"${ROOT}".ok is not true or false`],
    [
      'preflight.json',
      [ROOT, 'cause'],
      'dns',
      `"${ROOT}".cause is not one of auth, not-found, network, start, detect`,
    ],
    ['preflight.json', [ROOT, 'probe_package'], GONE, `"${ROOT}".probe_package is not text`],
    ['preflight.json', [ROOT, 'stderr'], GONE, `"${ROOT}".stderr is not text`],
    ['preflight.json', [ROOT, 'exclude_error'], GONE, `"${ROOT}".exclude_error is not text`],
    ['preflight.json', [ROOT, 'exclude_error'], 5, `"${ROOT}".exclude_error is not text`],
    ['preflight.json', [ROOT, 'exclude_error'], '', `"${ROOT}".exclude_error is not text`],
    ['preflight.json', [ROOT], { error: '' }, `"${ROOT}".error is not text`],
    [
      'preflight.json',
      ['/Users/example/src/octo/x'],
      { ok: true },
      '"/Users/example/src/octo/x" is not a kept checkout of the discovery',
    ],
    // The Workflow args.
    ['args.json', [], 5, 'the file is not an object'],
    ['args.json', ['dispatches'], GONE, 'dispatches is not a list'],
    ['args.json', ['dispatches'], [], 'dispatches has no entry'],
    [
      'args.json',
      ['dispatches', 1, 'group', 'branch_name'],
      '',
      'dispatches[1].group.branch_name is not text',
    ],
  ] as const)('refuses %s where %j is %j', (file, path, to, problem) => {
    expect(refusal(file, path, to)).toBe(`summarize-run: ${file}: ${problem}`)
  })

  it.each([
    ['workflow.json', 'is not JSON', '{'],
    ['reports.json', 'is not JSON', ''],
  ])('refuses a %s that %s', (file, problem, text) => {
    const files = { ...base(), [file]: text }
    expect(message(summarizeRun(context(ARGS), inputs(files)))).toBe(
      `summarize-run: ${file} ${problem}`,
    )
  })

  it('refuses a file that cannot be read', () => {
    const files = base()
    Reflect.deleteProperty(files, 'merged.json')
    expect(message(summarizeRun(context(ARGS), inputs(files)))).toMatch(
      /^summarize-run: cannot read merged\.json: ENOENT/,
    )
  })

  /** The base run with one file replaced, and the command run on it. */
  const withFile = (file: string, edit: (value: never) => unknown, args = ARGS): string => {
    const files = structuredClone(base())
    files[file] = edit(files[file] as never)
    return message(summarizeRun(context(args), inputs(files)))
  }

  type Workflow = { result: Record<string, unknown>[]; logs: string[] }

  it('refuses a Workflow result with no entry and no args', () => {
    expect(
      withFile('workflow.json', (w: Workflow) => ({ ...w, result: [] }), ARGS.slice(0, 8)),
    ).toBe('summarize-run: workflow.json: result has no entry')
  })

  it('refuses an entry that names no dispatch of the args', () => {
    expect(
      withFile('args.json', (a: { dispatches: unknown[] }) => ({
        ...a,
        dispatches: a.dispatches.slice(0, 2),
      })),
    ).toBe(
      'summarize-run: result[2] names octo/app fix/dependabot-bad-pkg-3x, which no dispatch of args.json has',
    )
  })

  it('refuses an entry that names the dispatch of an entry before it', () => {
    expect(
      withFile('workflow.json', (w: Workflow) => ({
        ...w,
        result: [w.result[0], w.result[0], w.result[2]],
      })),
    ).toBe(
      'summarize-run: result[1] names octo/app fix/dependabot-example-pkg-6x, as an entry before it does',
    )
  })

  it('names the entry by its place in the Workflow result, not by its dispatch', () => {
    // The entry of the last dispatch comes first in the result.
    expect(
      withFile('workflow.json', (w: Workflow) => {
        const last = structuredClone(w.result[2]) as { result: Record<string, unknown> }
        Reflect.deleteProperty(last.result, 'branch')
        return { ...w, result: [last, w.result[0], w.result[1]] }
      }),
    ).toBe('summarize-run: workflow.json: result[0].result.branch is not text')
  })

  it('refuses a count of reports that is not the count of groups', () => {
    expect(withFile('reports.json', (r: unknown[]) => r.slice(0, 2))).toBe(
      'summarize-run: reports.json has 2 reports for 3 groups',
    )
    expect(withFile('reports.json', (r: unknown[]) => r.slice(0, 2), ARGS.slice(0, 8))).toBe(
      'summarize-run: reports.json has 2 reports for 3 groups',
    )
  })

  it.each([
    ['a null result with a report that read one', ['result', 0, 'result'], null, 'success'],
    ['a mispaired entry with a report that read one', ['result', 0, 'mispaired'], true, 'success'],
  ])('refuses %s', (_name, path, to, status) => {
    expect(refusal('workflow.json', path, to)).toBe(
      `summarize-run: report 0 gives result_status ${status}, which does not fit group 0`,
    )
  })

  it('refuses an unparsable report with no reason', () => {
    const files = structuredClone(base())
    ;(files['reports.json'] as Record<string, unknown>[])[2] = report(BAD, 'unparsable', {
      reason: null,
    })
    expect(message(summarizeRun(context(ARGS), inputs(files)))).toBe(
      'summarize-run: report 2 gives reaped false, and no reason',
    )
  })

  it('refuses a reaped report that gives a reason', () => {
    // `post-agent` gives a reason only when no reap ran.
    expect(refusal('reports.json', [0, 'reason'], 'pull request is not open (state=MERGED)')).toBe(
      'summarize-run: report 0 gives reaped true, and a reason',
    )
  })

  it('refuses a missing report for a result that is there', () => {
    expect(refusal('reports.json', [0, 'result_status'], 'missing')).toBe(
      'summarize-run: report 0 gives result_status missing, which does not fit group 0',
    )
  })

  it('refuses a report for a dispatch with no entry that read a result', () => {
    expect(withFile('workflow.json', (w: Workflow) => ({ ...w, result: w.result.slice(1) }))).toBe(
      'summarize-run: report 0 gives result_status success, which does not fit group 0',
    )
  })

  it.each([
    ['the branch of its result', 'reports.json', [0, 'branch'], 'fix/other'],
    ['the branch of its failure result', 'reports.json', [2, 'branch'], 'fix/other'],
  ])('refuses a report that does not name %s', (_name, file, path, to) => {
    const index = path[0]
    const branch = index === 0 ? PKG.branch_name : BAD.branch_name
    expect(refusal(file, path, to)).toBe(
      `summarize-run: report ${index} names the branch fix/other, and group ${index} is ${branch}`,
    )
  })

  it('refuses a report of an unread result that names another branch', () => {
    const files = structuredClone(base())
    const workflow = files['workflow.json'] as Workflow
    ;(workflow.result[2] as Record<string, unknown>).result = null
    ;(files['reports.json'] as Record<string, unknown>[])[2] = report(
      { ...BAD, branch_name: 'fix/other' },
      'missing',
    )
    expect(message(summarizeRun(context(ARGS), inputs(files)))).toBe(
      `summarize-run: report 2 names the branch fix/other, and group 2 is ${BAD.branch_name}`,
    )
  })

  it('refuses a log warning about a group that is not in the batch', () => {
    expect(
      withFile('workflow.json', (w: Workflow) => ({
        ...w,
        logs: ['Cross-field inconsistency in the result for octo/app other-pkg 1: x'],
      })),
    ).toBe(
      'summarize-run: workflow.json: logs[0] warns about octo/app other-pkg 1, which is not a group of the batch',
    )
  })
})
