// Parity for the reap (RFC 002, "Parity is the migration strategy", #234).
// Each row of `spec/fixtures/reap/capture.json` is one run of
// `fix-group.sh cleanup` or of `reap-agent-artifacts.sh` over a real git
// repository: its recipe, the report, the exit status, and the disk before
// and after. A row builds the same repository with `harness/git.ts`, runs the
// recipe, and then runs the port: `fix-group cleanup` for a `fix-group` row,
// and `contain` then `reap` of `src/reap.ts` for a `reap` row. It compares
// the disk before, the answer, and the disk after.
//
// A `fix-group` row runs the `setup` of the port, where the capture ran the
// `setup` of the bash. The two make the same worktree, branch and paths. The
// state files differ (`fix-group.ts`), and no row compares them.
//
// The paths are under `$ROOT`, and each commit is the label of the first ref
// that names it before the run: `<origin/main>`, `<origin/branch>` or
// `<branch>`. The recipe is bash, so each side runs the same text.
//
// Declared differences, each with #234. A row in `DECLARED` gives the answer
// and the disk of the port as a change of the capture. Every other row must
// match the capture exactly, with one rule for each script:
//   - `fix-group` rows: the port adds `left_behind[]` to the report. It names
//     the worktree when its removal failed, the work directory when it
//     stayed, and the branch when it stayed with a tip.
//   - `reap` rows: the refusals have the words of the port: `the work path
//     must not contain a .. segment`, and `Nothing was removed.` after the
//     path that is not under the worktree root. These are the words of
//     `fix-group.sh`, which the module keeps.
// Two rows make `git worktree remove` fail part way: `worktree-remove-fails`
// and `reap-worktree-remove-fails`. git deletes the files of the worktree in
// the order that the file system lists them, so on Linux the `.git` file of
// the worktree can go before the locked directory stops git. The capture was
// made on macOS, where it stayed. For these two rows, the disk after is
// compared without that one file, on both sides. This is git and the file
// system, and not the port.
//
// The row `reap-no-work-flag` is a usage error of the script. The module has
// no command line: `reap-batch` (#229) has one. So no row of the port runs it.
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { contain, type Git, reap } from '#gh-security/reap.ts'
import { fixGroup } from '#gh-security/subcommands/fix-group.ts'
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

interface Row {
  readonly name: string
  readonly script: 'fix-group' | 'reap'
  readonly group?: string
  readonly branch?: string
  readonly repo_root?: string
  readonly pre?: string
  readonly prepare?: string
  readonly args: readonly string[]
  readonly result: {
    readonly status: number
    readonly stdout: JsonValue
    readonly stderr: JsonValue
  }
  readonly before: Disk
  readonly after: Disk
}

interface Capture {
  readonly prelude: string
  readonly groups: Readonly<Record<string, Record<string, JsonValue>>>
  readonly rows: readonly Row[]
}

const CAPTURE = JSON.parse(
  readFileSync(join(FIXTURES_ROOT, 'reap', 'capture.json'), 'utf8'),
) as Capture

type Result = Row['result']

/** What a declared row changes: the answer and the disk after. */
interface Declared {
  readonly why: string
  readonly result: (captured: Result) => Result
  readonly after?: (captured: Disk) => Disk
}

const record = (value: JsonValue): Record<string, JsonValue> => value as Record<string, JsonValue>

const WT = '$ROOT/work/.claude/worktrees/fix-dependabot-example-pkg-6x/fix'
const WORK = '$ROOT/work/.claude/worktrees/fix-dependabot-example-pkg-6x'
const BRANCH = 'fix/dependabot-example-pkg-6x'

/** The answer with the report changed. */
const report = (result: Result, changes: Record<string, JsonValue>): Result => ({
  ...result,
  stdout: { ...record(result.stdout), ...changes },
})

/** A refusal of the port with this message. */
const refusal = (message: string): Result => ({
  status: 1,
  stdout: '',
  stderr: { error: message },
})

const withoutBranch = (disk: Disk): Disk => ({
  ...disk,
  refs: disk.refs.filter((ref) => !ref.startsWith(`refs/heads/${BRANCH} `)),
})

const DECLARED: Readonly<Record<string, Declared>> = {
  'worktree-dir-deleted': {
    why: 'the stale registration loses its one admin entry, and the branch at origin/main then goes',
    result: (captured) =>
      report(captured, {
        worktree: { path: WT, action: 'stale-registration-removed' },
        branch_deleted: true,
        detail: null,
        left_behind: [],
      }),
    after: (captured) => ({
      ...withoutBranch(captured),
      worktrees: ['$ROOT/work'],
      admin: [],
    }),
  },
  'worktree-remove-fails': {
    why: 'the branch rule runs after a failed worktree step: git dropped the registration, so the branch at origin/main goes',
    result: (captured) => {
      const detail = String(record(captured.stdout).detail)
      const kept = detail.slice(0, detail.lastIndexOf('; branch '))
      return {
        ...report(captured, {
          branch_deleted: true,
          reason: 'tip still equals origin/main: there is nothing on the branch to lose',
          detail: kept,
          left_behind: [WT, WORK],
        }),
        stderr: `fix-group: cleanup failure: ${kept}`,
      }
    },
    after: withoutBranch,
  },
  'work-dir-remove-fails': {
    why: 'the work directory is removed in process, so the error quotes node and not rm',
    result: (captured) => ({
      ...report(captured, {
        detail: `${WORK} was not removed: <node>`,
        errors: [`${WORK} was not removed: <node>`],
        left_behind: [WORK],
      }),
      stderr: `fix-group: cleanup failure: ${WORK} was not removed: <node>`,
    }),
  },
  'no-state': {
    why: 'the state reader of the port quotes the error of node (state.ts)',
    result: () => {
      const message = `no readable state file at ${WORK}/state.json: Error: ENOENT: no such file or directory, open '${WORK}/state.json'. Run 'setup' first.`
      return { status: 1, stdout: { error: message }, stderr: message }
    },
  },
  'empty-state': {
    why: 'the state reader of the port names a file that does not parse (state.ts)',
    result: () => {
      const message = `the state file at ${WORK}/state.json could not be read: it is unparseable or truncated. Nothing was removed or deleted on its say-so.`
      return { status: 1, stdout: { error: message }, stderr: message }
    },
  },
  'state-without-work': {
    why: 'a key path in a state failure has no dot at its start (fix-group.ts)',
    result: (captured) => {
      const message = String(record(captured.stdout).error).replace("'.work'", "'work'")
      return { status: 1, stdout: { error: message }, stderr: message }
    },
  },
  'unknown-option': {
    why: 'a bad command line is in the words of node (fix-group.ts)',
    result: () => {
      const message = "Unknown option '--bogus'"
      return { status: 1, stdout: { error: message }, stderr: message }
    },
  },
  'reap-dotdot-existing': {
    why: 'the module refuses a .. segment in the path as given, before it is resolved',
    result: () =>
      refusal(
        'the work path must not contain a .. segment: $ROOT/work/.claude/worktrees/there/../fix-dependabot-example-pkg-6x',
      ),
    after: () => CAPTURED_BEFORE('reap-dotdot-existing'),
  },
  'reap-work-is-file': {
    why: 'the error has the words of the module',
    result: (captured) =>
      report(captured, { errors: [`the work path exists and is not a directory: ${WORK}`] }),
  },
  'reap-worktree-remove-fails': {
    why: 'the error has the words of the module, which are the words of fix-group.sh',
    result: (captured) =>
      report(captured, {
        errors: [
          `git worktree remove --force ${WT} failed: error: failed to delete '${WT}': Permission denied`,
        ],
      }),
  },
  'reap-work-dir-remove-fails': {
    why: 'the work directory is removed in process: one error that quotes node, where rm gave one line for each path',
    result: (captured) => report(captured, { errors: [`${WORK} was not removed: <node>`] }),
  },
}

const CAPTURED_BEFORE = (name: string): Disk => {
  const row = CAPTURE.rows.find((entry) => entry.name === name)
  if (row === undefined) throw new Error(`no row ${name}`)
  return row.before
}

/** The words of the module for a refusal that the script also gives. */
const reapWords = (message: string): string =>
  message
    .replace(/^work path must not contain/, 'the work path must not contain')
    .replace(/^work path is not under (.*)$/, 'the work path is not under $1. Nothing was removed.')
    .replace(
      /^worktree path resolves outside (.*)$/,
      'the worktree path resolves outside $1. Nothing was removed.',
    )

/** The answer the port must give for a row. */
const expected = (row: Row): Result => {
  const declared = DECLARED[row.name]
  if (declared !== undefined) return declared.result(row.result)
  const { stdout, stderr } = row.result
  if (row.script === 'reap') {
    return typeof stderr === 'object' && stderr !== null && 'error' in stderr
      ? refusal(reapWords(String(record(stderr).error)))
      : row.result
  }
  if (typeof stdout !== 'object' || stdout === null || 'error' in stdout) return row.result
  const json = record(stdout)
  const worktree = record(json.worktree as JsonValue)
  const work = record(json.work_dir as JsonValue)
  const left = [
    worktree.action === 'removal-failed' ? String(worktree.path) : null,
    ['removed', 'absent'].includes(String(work.action)) ? null : String(work.path),
    json.branch_deleted === false && json.branch_tip !== null ? String(json.branch) : null,
  ].filter((entry): entry is string => entry !== null)
  return report(row.result, { left_behind: left })
}

/** The recipe text of a row, after the prelude, with its paths in the environment. */
const bash = (script: string, env: NodeJS.ProcessEnv): void => {
  const done = spawnSync('bash', ['-c', `${CAPTURE.prelude}\n${script}`], { env, encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`the recipe failed: ${done.stderr}`)
}

interface Side {
  readonly root: string
  readonly repo: string
  readonly branch: string
  readonly env: NodeJS.ProcessEnv
  readonly git: (dir: string, ...args: string[]) => string
}

/** The disk of a row, as the generator recorded it. */
const diskOf = (side: Side, labels: (text: string) => string): Disk => {
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
  walk(side.root, '')
  const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '')
  let admin: string[] = []
  try {
    admin = readdirSync(join(side.repo, '.git', 'worktrees')).sort()
  } catch {
    admin = []
  }
  return {
    paths,
    worktrees: lines(side.git(side.repo, 'worktree', 'list', '--porcelain'))
      .filter((line) => line.startsWith('worktree '))
      .map((line) => labels(line.slice('worktree '.length))),
    admin,
    refs: lines(
      side.git(
        side.repo,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
        'refs/remotes',
      ),
    )
      .sort()
      .map(labels),
  }
}

/** Replace the root and the labelled commits in a text. */
const labeller = (side: Side): ((text: string) => string) => {
  const labels: [string, string][] = []
  for (const [name, ref] of [
    ['origin/main', 'refs/remotes/origin/main'],
    ['origin/branch', `refs/remotes/origin/${side.branch}`],
    ['branch', `refs/heads/${side.branch}`],
  ] as const) {
    const read = spawnSync('git', ['-C', side.repo, 'rev-parse', '--verify', '--quiet', ref], {
      env: side.env,
      encoding: 'utf8',
    })
    const sha = read.stdout.trim()
    if (read.status === 0 && !labels.some(([, seen]) => seen === sha)) labels.push([name, sha])
  }
  return (text) =>
    labels.reduce(
      (out, [name, sha]) => out.replaceAll(sha, `<${name}>`),
      text.replaceAll(side.root, '$ROOT'),
    )
}

const answerOf = (result: CommandResult): Result => {
  if (result === undefined) throw new Error('the port answered with silence')
  if (result.outcome === 'ok') return { status: 0, stdout: result.value, stderr: '' }
  if ('report' in result) {
    return { status: result.exitCode ?? 1, stdout: result.report, stderr: result.error }
  }
  return { status: exitCodeFor(result), stdout: { error: result.error }, stderr: result.error }
}

/**
 * The answer with its paths and commits labelled. The text of node after
 * `was not removed: ` differs by platform (EACCES or ENOTEMPTY), so it is
 * `<node>`.
 */
const normalize = (result: Result, labels: (text: string) => string): Result =>
  JSON.parse(
    labels(JSON.stringify(result)).replace(/was not removed: E[^"]*"/g, 'was not removed: <node>"'),
  ) as Result

const runRow = async (row: Row) => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const root = join(realpathSync(sandbox.path), 'r')
  const repo = fixtures.create(root)
  const group = CAPTURE.groups[row.group ?? 'plain'] as Record<string, JsonValue>
  const branch = row.branch ?? String(group.branch_name)
  const at = (text: string): string =>
    text.replaceAll('$ROOT', root).replaceAll('$REPO', repo).replaceAll('$BRANCH', branch)
  const repoArg = at(row.repo_root ?? '$REPO')
  const work = `${repoArg}/.claude/worktrees/fix-dependabot-${String(group.package).replaceAll('/', '-')}-${String(group.major_line)}x`
  const env = {
    ...sandbox.env,
    ROOT: root,
    REPO: repo,
    WORK: work,
    WT: `${work}/fix`,
    BRANCH: branch,
  }
  const side: Side = { root, repo, branch, env, git: fixtures.git }
  const args = row.args.map((arg) =>
    at(arg).replaceAll('$WORK', work).replaceAll('$WT', `${work}/fix`),
  )
  try {
    if (row.pre !== undefined) bash(row.pre, env)
    if (row.script === 'fix-group') {
      writeFileSync(join(root, 'group.json'), `${JSON.stringify(group)}\n`)
      const context = (argv: readonly string[]) => ({
        args: argv,
        env: sandbox.env,
        io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
        commandNames: [],
      })
      const deps = { spawn: run, route: selectAdapter }
      const setUp = answerOf(
        await fixGroup(
          context([
            'setup',
            '--group-json',
            join(root, 'group.json'),
            '--repo-root',
            repoArg,
            '--default-branch',
            'main',
          ]),
          deps,
        ),
      )
      expect(setUp.status).toBe(0)
      if (row.prepare !== undefined) bash(row.prepare, env)
      const labels = labeller(side)
      const before = diskOf(side, labels)
      const result = answerOf(await fixGroup(context(args), deps))
      return { before, result: normalize(result, labels), after: diskOf(side, labels) }
    }
    if (row.prepare !== undefined) bash(row.prepare, env)
    const labels = labeller(side)
    const before = diskOf(side, labels)
    const option = (name: string): string => args[args.indexOf(name) + 1] as string
    const git: Git = (dir, gitArgs) => run('git', ['-C', dir, ...gitArgs], { env: sandbox.env })
    const target = await contain(
      {
        repoRoot: option('--repo-root'),
        work: option('--work'),
        worktree: `${option('--work')}/fix`,
        branch: option('--branch'),
      },
      git,
    )
    const result: Result =
      target.outcome === 'ok'
        ? await (async () => {
            const reaped = await reap(target.value, { pushed: true, defaultBranch: null }, git)
            return {
              status: reaped.errors.length > 0 ? 1 : 0,
              stdout: reaped as unknown as JsonValue,
              stderr: '',
            }
          })()
        : refusal(target.error)
    return { before, result: normalize(result, labels), after: diskOf(side, labels) }
  } finally {
    spawnSync('chmod', ['-R', 'u+w', root])
  }
}

/** The stderr of a reap row is not compared when the script reported: it printed nothing there. */
const comparable = (row: Row, result: Result): Result =>
  row.script === 'reap' && result.status !== 1 ? { ...result, stderr: '' } : result

/** The rows where git stops part way through `worktree remove`. */
const PART_WAY = new Set(['worktree-remove-fails', 'reap-worktree-remove-fails'])

/** The disk after, without the `.git` file of a worktree that git removed part way. */
const afterOf = (row: Row, disk: Disk): Disk =>
  PART_WAY.has(row.name)
    ? {
        ...disk,
        paths: disk.paths.filter(
          (path) => path !== 'f work/.claude/worktrees/fix-dependabot-example-pkg-6x/fix/.git',
        ),
      }
    : disk

describe('parity with the capture of fix-group.sh cleanup and reap-agent-artifacts.sh', () => {
  const rows = CAPTURE.rows.filter((row) => row.name !== 'reap-no-work-flag')

  it('has every row of the capture but the usage error, and each declared row exists', () => {
    expect(CAPTURE.rows.length).toBe(56)
    expect(rows.length).toBe(55)
    for (const name of Object.keys(DECLARED)) {
      expect(CAPTURE.rows.some((row) => row.name === name)).toBe(true)
    }
  })

  it.each(rows.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const port = await runRow(row)
    expect(port.before).toEqual(row.before)
    expect(comparable(row, port.result)).toEqual(comparable(row, expected(row)))
    expect(afterOf(row, port.after)).toEqual(
      afterOf(row, DECLARED[row.name]?.after?.(row.after) ?? row.after),
    )
  })
})
