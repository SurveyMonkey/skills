// Parity for `fix-group setup`, `classify` and `baseline` (RFC 002, "Parity
// is the migration strategy"). Each row runs `scripts/common/fix-group.sh`
// and then the TypeScript command, one after the other, on the same real
// repository. Between the two sides the row removes the worktree, the work
// directory and the branch that the first side made, and then makes its
// start state again. So the paths and the commits in each answer are the
// same on the two sides. The row compares the exit status and the JSON of
// each step, and the state file at the end.
//
// The adapter is the real node adapter on both sides: `node.sh` through
// `--adapter` for bash, and the registry for the port. The trees are the
// lockfile specimens under `spec/fixtures/`. git is real, with a bare
// origin that `harness/git.ts` builds in a sandbox.
//
// The package manager is a stand-in on PATH, the same file for both sides.
// It is the boundary that no example may run for real (`mocking.md`): an
// install reaches the network. It answers `install` from the files of the
// row, and any other verb (`npm explain`, `pnpm why`) with one fixed line.
//
// The state file is normalized before the compare. In
// bash, `adapter` is the path of `node.sh`. In the port, it is the name of
// the adapter, and the port also records the `ecosystem` that routes it.
//
// A second declared difference of the state, with #233: the bash state has
// `scorer`, the path of `score-merge-risk.sh`. The port has no such key,
// because it scores in process (ruling 9). The compare drops it from the
// bash side.
//
// Declared differences, not compared:
//   - The port takes no `--adapter`. The route is the `ecosystem` of the
//     group, through the registry.
//   - The words on stderr. Each failure row compares the JSON on stdout,
//     which carries the same detail.
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { fixGroup } from '#gh-security/subcommands/fix-group.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

// Each row starts many bash processes, which is slow on a CI runner. The
// time limit is for that, and not for a hang.
vi.setConfig({ testTimeout: 120_000 })

const DRIVER = pluginFile('gh-security', 'scripts', 'common', 'fix-group.sh')
const NODE_SH = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

const DRIFT_SUBJECT = 'chore(deps): refresh lockfile (control install, no manifest change)'

/** The stand-in package manager. `PM_DIR` holds what the row tells it. */
const FAKE_PM = `#!/bin/sh
case "$1" in
  install)
    if [ -f "$PM_DIR/install.sh" ]; then . "$PM_DIR/install.sh"; fi
    exit "$(cat "$PM_DIR/install.status" 2>/dev/null || echo 0)" ;;
  *) printf 'stand-in %s\\n' "$*" ;;
esac
`

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly repo: string
  readonly groupFile: string
  readonly pmDir: string
  readonly work: string
  readonly branch: string
}

type Group = Record<string, JsonValue>

const group = (pkg: string, line: string, fields: Group = {}): Group => ({
  package: pkg,
  ecosystem: 'npm',
  major_line: line,
  highest_fixed_version: `${line}.99.0`,
  branch_name: `fix/dependabot-${pkg}-${line}x`,
  alerts: [{ number: 1, vulnerable_range: `< ${line}.99.0` }],
  sibling_alerts: [],
  ...fields,
})

const world = (fixture: string, payload: Group): World => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const repo = fixtures.create(join(realpathSync(sandbox.path), 'r'))
  fixtures.importTree(repo, join(FIXTURES_ROOT, fixture))
  fixtures.push(repo)
  const bin = sandbox.stubPath(sandbox.join('bin'))
  for (const pm of ['npm', 'pnpm']) {
    writeFileSync(join(bin, pm), FAKE_PM)
    chmodSync(join(bin, pm), 0o755)
  }
  const pmDir = sandbox.join('pm')
  mkdirSync(pmDir)
  sandbox.env.PM_DIR = pmDir
  // The drift commit is the driver's own, so git needs a name for it.
  for (const role of ['AUTHOR', 'COMMITTER']) {
    sandbox.env[`GIT_${role}_NAME`] = 'Fixture'
    sandbox.env[`GIT_${role}_EMAIL`] = 'fixture@example.invalid'
  }
  const groupFile = sandbox.join('group.json')
  writeFileSync(groupFile, JSON.stringify(payload))
  const pkg = String(payload.package).replaceAll('/', '-')
  return {
    sandbox,
    fixtures,
    repo,
    groupFile,
    pmDir,
    work: join(
      repo,
      '.claude',
      'worktrees',
      `fix-dependabot-${pkg}-${String(payload.major_line)}x`,
    ),
    branch: String(payload.branch_name),
  }
}

interface Answer {
  readonly status: number
  readonly json: JsonValue | null
}

type Phase = 'setup' | 'classify' | 'baseline'

const argsOf = (w: World, phase: Phase): string[] =>
  phase === 'setup'
    ? ['setup', '--group-json', w.groupFile, '--repo-root', w.repo, '--default-branch', 'main']
    : [phase, '--work', w.work]

const bashStep = (w: World, phase: Phase): Answer => {
  const env = Object.entries(w.sandbox.env).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${value}`],
  )
  const extra = phase === 'setup' ? ['--adapter', NODE_SH] : []
  const result = runBash({
    command: 'env',
    args: ['-i', ...env, 'bash', DRIVER, ...argsOf(w, phase), ...extra],
  })
  const text = result.stdout.trim()
  return { status: result.status, json: text === '' ? null : (JSON.parse(text) as JsonValue) }
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) return { status: 0, json: null }
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  if ('report' in result) {
    const status = 'exitCode' in result && typeof result.exitCode === 'number' ? result.exitCode : 1
    return { status, json: result.report }
  }
  return { status: exitCodeFor(result), json: { error: result.error } }
}

const tsStep = async (w: World, phase: Phase): Promise<Answer> => {
  const context: CommandContext = {
    args: argsOf(w, phase),
    env: w.sandbox.env,
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
    commandNames: [],
  }
  return answerOf(await fixGroup(context, { spawn: run, route: selectAdapter }))
}

/** The state file, with the declared normalizations of the header. */
const stateOf = (w: World): JsonValue => {
  let text: string
  try {
    text = readFileSync(join(w.work, 'state.json'), 'utf8')
  } catch {
    return null
  }
  const {
    adapter: _adapter,
    ecosystem: _ecosystem,
    scorer: _scorer,
    ...rest
  } = JSON.parse(text) as Group
  return rest
}

/** Remove what a side made, so the other side starts from the same place. */
const reset = (w: World): void => {
  w.fixtures.tryGit(w.repo, 'worktree', 'remove', '--force', join(w.work, 'fix'))
  rmSync(w.work, { recursive: true, force: true })
  w.fixtures.tryGit(w.repo, 'branch', '-D', w.branch)
}

interface Row {
  readonly name: string
  readonly world: () => World
  readonly phases: readonly Phase[]
  /** The start state, made again before each side. */
  readonly prepare?: (w: World) => void
}

/** Both sides of one row: each step until the first that does not exit 0, then the state. */
const sides = async (row: Row) => {
  const w = row.world()
  const runSide = async (step: (phase: Phase) => Answer | Promise<Answer>) => {
    row.prepare?.(w)
    const answers: Answer[] = []
    for (const phase of row.phases) {
      const answer = await step(phase)
      answers.push(answer)
      if (answer.status !== 0) break
    }
    const state = stateOf(w)
    reset(w)
    return { answers, state }
  }
  const bash = await runSide((phase) => bashStep(w, phase))
  const typescript = await runSide((phase) => tsStep(w, phase))
  return { bash, typescript }
}

/** One commit on a side ref, made once, so each side gets the same commit. */
const staleBranch =
  (file: string, content: string, subject: string) =>
  (w: World): void => {
    const source = 'stale-source'
    if (w.fixtures.tryGit(w.repo, 'rev-parse', '--verify', '-q', source).status !== 0) {
      w.fixtures.git(w.repo, 'checkout', '-q', '-b', source)
      writeFileSync(join(w.repo, file), content)
      w.fixtures.git(w.repo, 'add', '-A')
      w.fixtures.git(w.repo, 'commit', '-qm', subject)
      w.fixtures.git(w.repo, 'checkout', '-q', 'main')
    }
    w.fixtures.git(w.repo, 'branch', '-f', w.branch, source)
  }

const installs =
  (script: string, status = 0) =>
  (w: World): void => {
    writeFileSync(join(w.pmDir, 'install.sh'), script)
    writeFileSync(join(w.pmDir, 'install.status'), `${status}\n`)
  }

const npmLodash = () => world('npm-v3', group('lodash', '4'))
const ALL: readonly Phase[] = ['setup', 'classify', 'baseline']

const ROWS: readonly Row[] = [
  {
    name: 'a run whose control install rewrites the lockfile, with a drift commit',
    world: npmLodash,
    phases: ALL,
    prepare: installs("printf '\\n' >> package-lock.json\n"),
  },
  {
    name: 'a run whose control install changes nothing',
    world: npmLodash,
    phases: ALL,
    prepare: installs(''),
  },
  {
    name: 'a control install that touches package.json, a residual',
    world: npmLodash,
    phases: ALL,
    prepare: installs("printf '\\n' >> package-lock.json\nprintf '\\n' >> package.json\n"),
  },
  {
    name: 'a control install that fails',
    world: npmLodash,
    phases: ALL,
    prepare: installs("printf 'npm ERR! code ERESOLVE\\n' >&2\n", 1),
  },
  {
    name: 'a control install that times out twice',
    world: npmLodash,
    phases: ALL,
    prepare: installs("printf 'npm ERR! network socket hang up\\n' >&2\n", 1),
  },
  {
    name: 'a control install that prints the pnpm 11 signal',
    world: npmLodash,
    phases: ALL,
    prepare: installs(
      `printf '\\n' >> package-lock.json\nprintf ' WARN  The "pnpm" field in package.json is no longer read by pnpm\\n' >&2\n`,
    ),
  },
  {
    name: 'a package that only peer resolutions reach',
    world: () => world('pnpm-peer-only', group('vite', '6')),
    phases: ALL,
  },
  {
    name: 'a workspace that a crashed run left',
    world: npmLodash,
    phases: ['setup'],
    prepare: (w) => mkdirSync(join(w.work, 'fix'), { recursive: true }),
  },
  {
    name: 'a stale branch whose only commit is the drift commit',
    world: npmLodash,
    phases: ['setup'],
    prepare: staleBranch('package-lock.json', '{"lockfileVersion":3}\n', DRIFT_SUBJECT),
  },
  {
    name: 'a stale branch that holds other work',
    world: npmLodash,
    phases: ['setup'],
    prepare: staleBranch('src.js', 'console.log(1)\n', 'feat: unpushed work'),
  },
  {
    name: 'a drift subject over package.json',
    world: npmLodash,
    phases: ['setup'],
    prepare: staleBranch('package.json', '{"name":"edited"}\n', DRIFT_SUBJECT),
  },
  {
    name: 'a major_line that is a pattern',
    world: () => world('npm-v3', group('lodash', '.*')),
    phases: ['setup'],
  },
  {
    name: 'a group with no alerts',
    world: () => world('npm-v3', group('lodash', '4', { alerts: [] })),
    phases: ['setup'],
  },
]

describe('fix-group setup, classify and baseline against fix-group.sh', () => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const { bash, typescript } = await sides(row)
    expect(typescript).toEqual(bash)
  })
})
