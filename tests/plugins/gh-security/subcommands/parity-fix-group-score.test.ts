// Parity for `fix-group score` (RFC 002, "Parity is the migration strategy").
// Each row runs `scripts/common/fix-group.sh` and then the TypeScript
// command, one after the other, on the same real repository. Each side runs
// `setup`, `classify`, `baseline` and `apply` with its own driver, and then
// `score`. Between the two sides the row removes the worktree, the work
// directory and the branch that the first side made, and then makes its
// start state again. So the paths in each answer are the same on the two
// sides. The row compares the exit status and the JSON of each step, and the
// state file at the end.
//
// The adapter is the real one on both sides: `node.sh` through `--adapter`
// for bash, and the registry for the port. The bash runs
// `scripts/common/score-merge-risk.sh` as its scorer, and the port scores in
// process (#233). The trees are
// the lockfile specimens under `spec/fixtures/`. git is real, with a bare
// origin that `harness/git.ts` builds in a sandbox.
//
// The package manager is a stand-in on PATH, the same file for both sides.
// An install reaches the network, so no example runs a real one
// (`mocking.md`). The stand-in counts its installs. Install 1 is the control
// install of `baseline`, and each later one is a fix install of `apply`.
// For install <n> it runs `install.<n>.sh`, or else `install.sh`, from the
// files of the row, and exits with `install.<n>.status`, or else
// `install.status`, or else 0. A fix install that runs `git checkout` puts
// back what the stand-in cannot write: npm `apply_constraint` removes the
// stale lockfile entries of the line (#124), and a real install writes them
// again.
//
// A step that does not exit 0 ends the side, except that an `apply` always
// runs after an `apply`. A row can edit the state file between `apply` and
// `score`, on each side alike, as a run that a crash interrupted leaves it.
//
// The state file is normalized before the compare, as
// in `parity-fix-group-apply.test.ts`. In bash, `adapter` is the path of
// `node.sh`. In the port, it is the name of the adapter, and the port also
// records the `ecosystem` that routes it.
//
// A second declared difference of the state, with #233: the bash state has
// `scorer`, the path of `score-merge-risk.sh`. The port has no such key,
// because it scores in process (ruling 9). The compare drops it from the
// bash side.
//
// Declared differences, not compared:
//   - The `validate` answer of the port carries `parent_range_breaks` (#170),
//     which `node.sh` does not write. The compare drops that key from the
//     port side, wherever it is in an answer or in the state.
//   - The port takes no `--adapter`. The route is the `ecosystem` of the
//     group, through the registry.
//   - The words on stderr. Each failure row compares the JSON on stdout,
//     which carries the same detail.
//   - A key path in the text of a state failure has no dot at the start in the
//     port: `'apply_result'`, where the bash wrote `'.apply_result'`. The
//     compare takes the dot out of the bash text (declared in `fix-group.ts`).
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
vi.setConfig({ testTimeout: 240_000 })

const DRIVER = pluginFile('gh-security', 'scripts', 'common', 'fix-group.sh')
const NODE_SH = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

/** The stand-in package manager. `PM_DIR` holds what the row tells it. */
const FAKE_PM = `#!/bin/sh
case "$1" in
  install)
    n=$(cat "$PM_DIR/install.n" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$PM_DIR/install.n"
    if [ -f "$PM_DIR/install.$n.sh" ]; then . "$PM_DIR/install.$n.sh"
    elif [ -f "$PM_DIR/install.sh" ]; then . "$PM_DIR/install.sh"; fi
    exit "$(cat "$PM_DIR/install.$n.status" 2>/dev/null || cat "$PM_DIR/install.status" 2>/dev/null || echo 0)" ;;
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

const group = (pkg: string, line: string, fixed: string): Group => ({
  package: pkg,
  ecosystem: 'npm',
  major_line: line,
  highest_fixed_version: fixed,
  branch_name: `fix/dependabot-${pkg}-${line}x`,
  alerts: [{ number: 1, vulnerable_range: `< ${fixed}` }],
  sibling_alerts: [],
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

type Phase = 'setup' | 'classify' | 'baseline' | 'apply' | 'score'

const argsOf = (w: World, phase: Phase): string[] =>
  phase === 'setup'
    ? ['setup', '--group-json', w.groupFile, '--repo-root', w.repo, '--default-branch', 'main']
    : [phase, '--work', w.work]

/** The one declared difference of the text of a state failure: no dot at the start of a key path. */
const undotted = (json: JsonValue): JsonValue => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json
  const error = json.error
  return typeof error === 'string'
    ? { ...json, error: error.replace("for '.", "for '").replace('// .', '// ') }
    : json
}

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
  return {
    status: result.status,
    json: text === '' ? null : undotted(JSON.parse(text) as JsonValue),
  }
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) return { status: 0, json: null }
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  if ('report' in result) return { status: result.exitCode ?? 1, json: result.report }
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

/** A value without the `parent_range_breaks` key (#170), at any depth. */
const withoutRangeBreaks = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutRangeBreaks)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'parent_range_breaks')
            .map(([key, entry]) => [key, withoutRangeBreaks(entry)]),
        )
      : value

/** Rewrite the state file, as a run that a crash interrupted leaves it. */
const editState = (w: World, edit: (state: Group) => Group): void => {
  const path = join(w.work, 'state.json')
  writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8')) as Group)))
}

/** Remove what a side made, so the other side starts from the same place. */
const reset = (w: World): void => {
  w.fixtures.tryGit(w.repo, 'worktree', 'remove', '--force', join(w.work, 'fix'))
  rmSync(w.work, { recursive: true, force: true })
  w.fixtures.tryGit(w.repo, 'branch', '-D', w.branch)
}

/** The scripts of the stand-in for one row: the name is `install.sh` or `install.<n>.sh`. */
type Installs = Readonly<Record<string, string>>

interface Row {
  readonly name: string
  readonly world: () => World
  readonly phases: readonly Phase[]
  /** The files of the stand-in, written again before each side. */
  readonly installs: Installs
  /** An edit of the state file, made before `score` on each side. */
  readonly edit?: (state: Group) => Group
}

/** Both sides of one row: each step until the first that does not exit 0, then the state. */
const sides = async (row: Row) => {
  const w = row.world()
  const runSide = async (step: (phase: Phase) => Answer | Promise<Answer>) => {
    rmSync(w.pmDir, { recursive: true, force: true })
    mkdirSync(w.pmDir)
    for (const [name, body] of Object.entries(row.installs)) {
      writeFileSync(join(w.pmDir, name), body)
    }
    const answers: Answer[] = []
    for (const phase of row.phases) {
      if (phase === 'score' && row.edit !== undefined) editState(w, row.edit)
      const answer = await step(phase)
      answers.push(answer)
      if (answer.status !== 0 && phase !== 'apply') break
    }
    const state = stateOf(w)
    reset(w)
    return { answers, state }
  }
  const bash = await runSide((phase) => bashStep(w, phase))
  const typescript = await runSide((phase) => tsStep(w, phase))
  return { bash, typescript }
}

const THROUGH_APPLY: readonly Phase[] = ['setup', 'classify', 'baseline', 'apply']
const ALL: readonly Phase[] = [...THROUGH_APPLY, 'score']

/** A fix install puts the lockfile back, as a real install writes it again. */
const RESTORE_LOCK = 'git checkout -q -- package-lock.json\n'

/** A fix install that leaves no change: the manifest and the lockfile as HEAD has them. */
const RESTORE_ALL = 'git checkout -q -- package.json package-lock.json\n'

const picomatch = (fixed: string) => () =>
  world('npm-ambient-drift', group('picomatch', '2', fixed))

const lodash = (line: string, fixed: string) => () => world('npm-v3', group('lodash', line, fixed))

/** A state without the named keys. */
const without =
  (...keys: string[]) =>
  (state: Group): Group =>
    Object.fromEntries(Object.entries(state).filter(([key]) => !keys.includes(key)))

const ROWS: readonly Row[] = [
  {
    name: 'a direct dependency that apply retargets in the manifest',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
  },
  {
    name: 'a fix whose content is the drift commit, a lockfile refresh',
    world: picomatch('2.3.10'),
    phases: ALL,
    installs: {
      'install.1.sh':
        'sed \'s/"2.3.9"/"2.3.10"/\' package-lock.json > lock.tmp && mv lock.tmp package-lock.json\n',
      'install.sh': RESTORE_ALL,
    },
  },
  {
    name: 'an npm package that the root declares, fixed on another line',
    world: () => world('npm-cross-line', group('minimatch', '5', '5.1.8')),
    phases: ALL,
    installs: {
      'install.1.sh': '',
      'install.sh': `${RESTORE_LOCK}sed 's/"version": "5.1.6"/"version": "5.1.8"/' package-lock.json > lock.tmp && mv lock.tmp package-lock.json\n`,
    },
  },
  {
    name: 'a scoped override on a pnpm repository',
    world: () => world('pnpm-v9', group('lodash', '4', '4.17.21')),
    phases: ALL,
    installs: {},
  },
  {
    name: 'a pnpm repository, where no violation path names a parent',
    world: () => world('pnpm-v9', group('lodash', '4', '4.99.0')),
    phases: ALL,
    installs: {},
  },
  {
    name: 'an apply that is a no-op, which is terminal',
    world: lodash('4', '4.17.21'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_ALL },
  },
  {
    name: 'an apply that needs judgment, so there is no action to score',
    world: picomatch('2.3.99'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
  },
  {
    name: 'a score before the apply',
    world: lodash('4', '4.17.21'),
    phases: ['setup', 'classify', 'baseline', 'score'],
    installs: {},
  },
  {
    name: 'a score before the baseline',
    world: lodash('4', '4.17.21'),
    phases: ['setup', 'classify', 'score'],
    installs: {},
  },
  {
    name: 'a second score on the same state',
    world: picomatch('2.3.9'),
    phases: [...ALL, 'score'],
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
  },
  {
    name: 'a scorer that refuses the override scope of the state',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: (state) => ({ ...state, override_scope: 'wide' }),
  },
  {
    name: 'a state that apply never finished: no apply_result',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: without('apply_result'),
  },
  {
    name: 'a state that apply never finished: no validate',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: without('validate'),
  },
  {
    name: 'a state that apply never finished: no observations_first',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: without('observations_first'),
  },
  {
    name: 'a state with neither applied_parents nor eligible_parents',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: without('applied_parents', 'eligible_parents'),
  },
  {
    name: 'a state whose applied_parents is false, so eligible_parents is read',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: (state) => ({ ...state, applied_parents: false }),
  },
  {
    name: 'a state whose install_signals is absent',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: without('install_signals'),
  },
  {
    name: 'a state with no package_path',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: without('package_path'),
  },
  {
    name: 'a state with no baseline',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: without('baseline'),
  },
  {
    name: 'a state with a drift_commit of text, which score passes on',
    world: picomatch('2.3.9'),
    phases: ALL,
    installs: { 'install.1.sh': '', 'install.sh': RESTORE_LOCK },
    edit: (state) => ({ ...state, drift_commit: 'maybe' }),
  },
]

describe('fix-group score against fix-group.sh', () => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const { bash, typescript } = await sides(row)
    expect(withoutRangeBreaks(typescript)).toEqual(bash)
  })
})
