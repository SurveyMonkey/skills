// Parity for `reap-batch` (RFC 002, "Parity is the migration strategy", #229).
// Each row of `spec/fixtures/post-agent/capture.json` is one run of
// `post-agent.sh` over a real git repository: its recipe, the agent result,
// the answers of `gh pr view`, the report, and the disk before and after. A
// row builds the same repository with `harness/git.ts`, runs the recipe, and
// then runs `reap-batch` over one workflow entry: the dispatch of the row, its
// result, and `mispaired`. It compares the disk before, the report, and the
// disk after.
//
// The script read `gh pr view` through a stand-in on PATH. The port runs the
// real `gh` client over a runner that gives the same answers, by pull request
// number. git is real on both sides.
//
// The paths are under `$ROOT`, the results file is `$RESULTS`, and each
// commit is the label of the first ref that names it before the run:
// `<origin/main>`, `<origin/branch>` or `<branch>`.
//
// Differences, each with #229 and the header of `src/post-agent.ts`. Each
// row must match the capture with these rules for the words:
//   - A reason names the entry, not the result file. A mispaired entry has
//     its own reason.
//   - A difference names the field of the dispatch, not the flag.
//   - `pr-status.sh` is `pr-status`.
// The rows in `DECLARED` give the report of the port as a change of the
// capture.
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '#gh-security/cli/command.ts'
import type { JsonValue } from '#gh-security/lib/envelope.ts'
import { createGhClient } from '#gh-security/lib/gh.ts'
import { type Runner, type RunResult, run } from '#gh-security/lib/process.ts'
import { reapBatch } from '#gh-security/subcommands/reap-batch.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'

vi.setConfig({ testTimeout: 60_000 })

interface Disk {
  readonly paths: string[]
  readonly worktrees: string[]
  readonly admin: string[]
  readonly refs: string[]
}

interface Answer {
  readonly number: number
  readonly status: number
  readonly stdout?: string
  readonly stderr?: string
}

type Report = Record<string, JsonValue>

interface Row {
  readonly name: string
  readonly group?: string
  readonly result_value: JsonValue
  readonly mispaired?: boolean
  readonly env_prefix?: string
  readonly fallback?: Readonly<Record<string, string>>
  readonly gh: readonly Answer[]
  readonly pre?: string
  readonly result: { readonly status: number; readonly stdout: Report; readonly stderr: string }
  readonly before: Disk
  readonly after: Disk
}

interface Capture {
  readonly prelude: string
  readonly groups: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly rows: readonly Row[]
}

const CAPTURE = JSON.parse(
  readFileSync(join(FIXTURES_ROOT, 'post-agent', 'capture.json'), 'utf8'),
) as Capture

const WORK = '$ROOT/work/.claude/worktrees/fix-dependabot-example-pkg-6x'

/** The words of the port for the words of the script. */
const portWords = (row: Row, text: string): string =>
  text
    .replace(
      /^missing result block at \$RESULT$/,
      row.mispaired === true
        ? 'mispaired result at entry 0 of $RESULTS: it names another group, so it was not read'
        : 'missing result block at entry 0 of $RESULTS',
    )
    .replace(
      /^unparseable result block at \$RESULT$/,
      'unparseable result block at entry 0 of $RESULTS',
    )
    .replace(/^pr-status\.sh /, 'pr-status ')
    .replace(
      /^the result block's (package|major-line|branch) \('(.*)'\) disagrees with the --(?:package|major-line|branch) fallback \('(.*)'\)$/,
      (_all, flag: string, result: string, dispatch: string) => {
        const field = flag === 'major-line' ? 'major_line' : flag
        const given = { package: 'package', major_line: 'major_line', branch: 'branch_name' }[field]
        return `the result's ${field} ('${result}') disagrees with the dispatch's group.${given} ('${dispatch}')`
      },
    )

/** A declared row: the report of the port, as a change of the capture. */
interface Declared {
  readonly why: string
  readonly report: (captured: Report) => Report
}

/** The words of the gh client for an answer that is not JSON. The rest is the words of node. */
const NOT_JSON = expect.stringMatching(
  /^pr-status could not read the pull request: gh answered gh pr view with something that is not JSON: /,
) as unknown as string

const DECLARED: Readonly<Record<string, Declared>> = {
  'success-pr-not-json': {
    why: 'the gh client of the port refuses an answer that is not JSON in its own words (lib/gh.ts)',
    report: (captured) => ({ ...captured, reason: NOT_JSON, errors: [NOT_JSON] }),
  },
  'success-open-reap-refused': {
    why: 'a refused reap gives the refusal of contain, where the script gave the stderr JSON of reap-agent-artifacts.sh',
    report: (captured) => ({
      ...captured,
      reason: 'the reap refused the paths, so nothing was removed',
      errors: [
        'the reap refused the paths, so nothing was removed: the work path is not under $ROOT/work/.claude/worktrees/: $ROOT/elsewhere/fix-dependabot-example-pkg-6x. Nothing was removed.',
      ],
    }),
  },
  'success-open-work-dir-locked': {
    why: 'the work directory is removed in process: one error that quotes node, where rm gave one line for each path',
    report: (captured) => ({ ...captured, errors: [`${WORK} was not removed: <node>`] }),
  },
}

/** The report that the port must give for a row. */
const expected = (row: Row): Report => {
  const captured = row.result.stdout
  const worded: Report = {
    ...captured,
    reason: captured.reason === null ? null : portWords(row, String(captured.reason)),
    errors: (captured.errors as string[]).map((error) => portWords(row, error)),
  }
  return DECLARED[row.name]?.report(worded) ?? worded
}

const bash = (script: string, env: NodeJS.ProcessEnv): void => {
  const done = spawnSync('bash', ['-c', `${CAPTURE.prelude}\n${script}`], { env, encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`the recipe failed: ${done.stderr}`)
}

const diskOf = (
  root: string,
  repo: string,
  git: (dir: string, ...args: string[]) => string,
  labels: (text: string) => string,
): Disk => {
  const paths: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const relPath = rel === '' ? name : `${rel}/${name}`
      if (relPath === 'origin.git' || relPath === 'work/.git') continue
      const path = join(dir, name)
      const stat = lstatSync(path)
      paths.push(`${stat.isSymbolicLink() ? 'l' : stat.isDirectory() ? 'd' : 'f'} ${relPath}`)
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, relPath)
    }
  }
  walk(root, '')
  const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '')
  let admin: string[] = []
  try {
    admin = readdirSync(join(repo, '.git', 'worktrees')).sort()
  } catch {
    admin = []
  }
  return {
    paths,
    worktrees: lines(git(repo, 'worktree', 'list', '--porcelain'))
      .filter((line) => line.startsWith('worktree '))
      .map((line) => labels(line.slice('worktree '.length))),
    admin,
    refs: lines(
      git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes'),
    )
      .sort()
      .map(labels),
  }
}

/** Replace the root, the results file and the labelled commits in a text. */
const labeller = (
  root: string,
  repo: string,
  branch: string,
  results: string,
  env: NodeJS.ProcessEnv,
): ((text: string) => string) => {
  const labels: [string, string][] = []
  for (const [name, ref] of [
    ['origin/main', 'refs/remotes/origin/main'],
    ['origin/branch', `refs/remotes/origin/${branch}`],
    ['branch', `refs/heads/${branch}`],
  ] as const) {
    const read = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], {
      env,
      encoding: 'utf8',
    })
    const sha = read.stdout.trim()
    if (read.status === 0 && !labels.some(([, seen]) => seen === sha)) labels.push([name, sha])
  }
  return (text) =>
    labels.reduce(
      (out, [name, sha]) => out.replaceAll(sha, `<${name}>`),
      text.replaceAll(results, '$RESULTS').replaceAll(root, '$ROOT'),
    )
}

/** A `RunResult` for one answer of `gh`. */
const resultOf = (answer: Answer | undefined, number: string): RunResult => {
  const stdout = answer?.stdout ?? ''
  const stderr = answer === undefined ? `no pull requests found for pull request #${number}\n` : ''
  return {
    status: answer === undefined ? 1 : answer.status,
    signal: null,
    stdout,
    stderr: answer?.stderr ?? stderr,
    combined: `${stdout}${stderr}`,
    timedOut: false,
    elapsedMs: 0,
    startFailure: null,
    streamErrors: [],
  }
}

/**
 * git is real. `gh pr view <number>` answers from the row, after the words of
 * a prefix. `env` runs nothing here: a prefix of the row only names a
 * variable.
 */
const runnerOf =
  (row: Row): Runner =>
  (command, args = [], options) => {
    if (command === 'git') return run(command, args, options)
    const at = command === 'gh' ? -1 : args.indexOf('gh')
    const call = at === -1 ? args : args.slice(at + 1)
    if (call[0] !== 'pr' || call[1] !== 'view') throw new Error(`unexpected gh ${call.join(' ')}`)
    const number = call[2] as string
    return Promise.resolve(
      resultOf(
        row.gh.find((answer) => String(answer.number) === number),
        number,
      ),
    )
  }

const runRow = async (row: Row) => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const root = join(realpathSync(sandbox.path), 'r')
  const repo = fixtures.create(root)
  const group = CAPTURE.groups[row.group ?? 'plain'] as Readonly<Record<string, string>>
  const branch = String(group.branch_name)
  const work = `${repo}/.claude/worktrees/fix-dependabot-${String(group.package).replaceAll('/', '-')}-${String(group.major_line)}x`
  const env = {
    ...sandbox.env,
    ROOT: root,
    REPO: repo,
    WORK: work,
    WT: `${work}/fix`,
    BRANCH: branch,
  }
  const results = join(realpathSync(sandbox.path), 'results.json')
  try {
    if (row.pre !== undefined) bash(row.pre, env)
    const labels = labeller(root, repo, branch, results, sandbox.env)
    const before = diskOf(root, repo, fixtures.git, labels)
    const dispatched = { ...group, ...row.fallback }
    writeFileSync(
      results,
      JSON.stringify([
        {
          dispatch: {
            group: {
              package: dispatched.package,
              major_line: dispatched.major_line,
              branch_name: dispatched.branch ?? dispatched.branch_name,
              repo: 'octo/app',
            },
            repo_root: repo,
            ...(row.env_prefix === undefined ? {} : { env_prefix: row.env_prefix }),
          },
          result: row.result_value,
          mispaired: row.mispaired === true,
        },
      ]),
    )
    const context: CommandContext = {
      args: [results],
      env: sandbox.env,
      io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
      commandNames: [],
    }
    const result = await reapBatch(context, createGhClient, runnerOf(row))
    if (result?.outcome !== 'ok') throw new Error(`reap-batch failed: ${JSON.stringify(result)}`)
    const report = JSON.parse(
      labels(JSON.stringify((result.value as JsonValue[])[0])).replace(
        /was not removed: E[^"]*"/g,
        'was not removed: <node>"',
      ),
    ) as Report
    return { before, report, after: diskOf(root, repo, fixtures.git, labels) }
  } finally {
    spawnSync('chmod', ['-R', 'u+w', root])
  }
}

describe('parity with the capture of post-agent.sh', () => {
  it('has the rows of each report shape, the null entry and the mispaired one', () => {
    expect(CAPTURE.rows.length).toBe(22)
    expect(new Set(CAPTURE.rows.map((row) => row.result.stdout.result_status))).toEqual(
      new Set(['success', 'no-op', 'failure', 'unparsable', 'missing']),
    )
    expect(CAPTURE.rows.filter((row) => row.result_value === null).map((row) => row.name)).toEqual([
      'null-result',
      'mispaired',
    ])
    for (const name of Object.keys(DECLARED)) {
      expect(CAPTURE.rows.some((row) => row.name === name)).toBe(true)
    }
  })

  it.each(CAPTURE.rows.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    expect(row.result.status).toBe(0)
    const port = await runRow(row)
    expect(port.before).toEqual(row.before)
    expect(port.report).toEqual(expected(row))
    expect(port.after).toEqual(row.after)
  })
})
