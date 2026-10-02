// `gh-security fix-group setup|classify|baseline`. The seam is the exported
// handler, with the runner and the registry as parameters. These are the
// examples of `spec/fix_group_setup_spec.sh` and `spec/fix_group_spec.sh`
// that cover these three phases, and the branches that only the port has.
//
// git is real: each example runs in a repository with a bare origin from
// `harness/git.ts`. A git failure comes from the git shim of that harness on
// PATH, or from a prefix script, which is the seam that the bash specs use
// too. The package manager is a stand-in on PATH, because an install reaches
// the network (`mocking.md`). Where an example needs an adapter answer that
// the real adapter never gives, the adapter is a stand-in given through the
// registry parameter: the real node adapter with one verb replaced
// (`mocking.md`, "The injected collaborator"). The expected values are
// written by hand from the contract in the header of `fix-group.ts`.
// `parity-fix-group.test.ts` compares the port with `fix-group.sh`.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { Adapter } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, failed, type JsonValue, ok } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { fixGroup, fixGroupCommand } from '#gh-security/subcommands/fix-group.ts'
import {
  driftPathAllowed,
  porcelainPaths,
  runners,
} from '#gh-security/subcommands/fix-group-common.ts'
import { DEFAULT_SCORER } from '#gh-security/subcommands/fix-group-setup.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

// Each example makes a repository and runs git many times.
vi.setConfig({ testTimeout: 60_000 })

const DRIFT_SUBJECT = 'chore(deps): refresh lockfile (control install, no manifest change)'
const BRANCH = 'fix/dependabot-lodash-4x'

/** The stand-in package manager. `PM_DIR` holds what the example tells it. */
const FAKE_PM = `#!/bin/sh
case "$1" in
  install)
    n=$(cat "$PM_DIR/install.n" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$PM_DIR/install.n"
    if [ -f "$PM_DIR/install.sh" ]; then . "$PM_DIR/install.sh"; fi
    exit "$(cat "$PM_DIR/install.status" 2>/dev/null || echo 0)" ;;
  *) printf 'stand-in %s\\n' "$*" ;;
esac
`

type Group = Record<string, JsonValue>

const GROUP: Group = {
  package: 'lodash',
  ecosystem: 'npm',
  major_line: '4',
  highest_fixed_version: '4.17.21',
  branch_name: BRANCH,
  alerts: [{ number: 1, vulnerable_range: '< 4.17.21' }],
  sibling_alerts: [],
}

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly repo: string
  readonly groupFile: string
  readonly pmDir: string
  readonly bin: string
  readonly work: string
  readonly worktree: string
  readonly env: NodeJS.ProcessEnv
}

const world = (fixture = 'npm-v3', group: Group = GROUP): World => {
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
  for (const role of ['AUTHOR', 'COMMITTER']) {
    sandbox.env[`GIT_${role}_NAME`] = 'Fixture'
    sandbox.env[`GIT_${role}_EMAIL`] = 'fixture@example.invalid'
  }
  const groupFile = sandbox.join('group.json')
  writeFileSync(groupFile, JSON.stringify(group))
  const pkg = String(group.package).replaceAll('/', '-')
  const work = join(
    repo,
    '.claude',
    'worktrees',
    `fix-dependabot-${pkg}-${String(group.major_line)}x`,
  )
  return {
    sandbox,
    fixtures,
    repo,
    groupFile,
    pmDir,
    bin,
    work,
    worktree: join(work, 'fix'),
    env: sandbox.env,
  }
}

interface Answer {
  readonly status: number
  readonly json: JsonValue
  /** What the CLI writes on stderr. */
  readonly stderr: string
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) throw new Error('fix-group answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value, stderr: '' }
  if ('report' in result) {
    return { status: result.exitCode ?? 1, json: result.report, stderr: result.error }
  }
  return { status: exitCodeFor(result), json: { error: result.error }, stderr: result.error }
}

const context = (env: NodeJS.ProcessEnv, args: readonly string[]): CommandContext => ({
  args,
  env,
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

type Route = typeof selectAdapter

const call = async (
  w: World,
  args: readonly string[],
  route: Route = selectAdapter,
  env: NodeJS.ProcessEnv = w.env,
): Promise<Answer> => answerOf(await fixGroup(context(env, args), { spawn: run, route }))

const setupArgs = (w: World, ...extra: string[]): string[] => [
  'setup',
  '--group-json',
  w.groupFile,
  '--repo-root',
  w.repo,
  '--default-branch',
  'main',
  ...extra,
]

const setup = (w: World, ...extra: string[]) => call(w, setupArgs(w, ...extra))
const classify = (w: World, route?: Route, env?: NodeJS.ProcessEnv) =>
  call(w, ['classify', '--work', w.work], route, env)
const baseline = (w: World, route?: Route, env?: NodeJS.ProcessEnv) =>
  call(w, ['baseline', '--work', w.work], route, env)

/** A projection of an answer: the status, and the named keys of its JSON. */
const pick = (answer: Answer, ...keys: string[]) => ({
  status: answer.status,
  ...Object.fromEntries(
    keys.map((key) => [key, (answer.json as Record<string, JsonValue>)[key] ?? null]),
  ),
})

const stateOf = (w: World): Record<string, JsonValue> =>
  JSON.parse(readFileSync(join(w.work, 'state.json'), 'utf8')) as Record<string, JsonValue>

const editState = (w: World, edit: (state: Record<string, JsonValue>) => void): void => {
  const state = stateOf(w)
  edit(state)
  writeFileSync(join(w.work, 'state.json'), JSON.stringify(state))
}

/** A script on disk, executable. */
const script = (w: World, name: string, body: string): string => {
  const path = join(w.bin, name)
  writeFileSync(path, `#!/bin/sh\n${body}`)
  chmodSync(path, 0o755)
  return path
}

/** An env whose git refuses the named subcommands (`harness/git.ts`). */
const refusing = (w: World, ...failing: string[]): NodeJS.ProcessEnv => {
  const shim = w.fixtures.gitShim(...failing)
  return { ...w.env, PATH: `${shim.directory}:${w.env.PATH}`, GIT_STUB_FAIL: shim.failing }
}

/** A route to the real node adapter with some verbs replaced. */
const stand = (verbs: Partial<Adapter<NodeDetection>>): Route =>
  ((ecosystem: string) => ({
    supported: true,
    ecosystem,
    name: 'node',
    adapter: { ...node, ...verbs },
    manifest: null,
  })) as Route

const installs = (w: World, body: string, status = 0): void => {
  writeFileSync(join(w.pmDir, 'install.sh'), body)
  writeFileSync(join(w.pmDir, 'install.status'), `${status}\n`)
}

/** A commit on the fix branch, and the checkout back on main. */
const commitOnBranch = (w: World, file: string, content: string, subject: string): void => {
  w.fixtures.git(w.repo, 'checkout', '-q', '-b', BRANCH)
  writeFileSync(join(w.repo, file), content)
  w.fixtures.git(w.repo, 'add', '-A')
  w.fixtures.git(w.repo, 'commit', '-qm', subject)
  w.fixtures.git(w.repo, 'checkout', '-q', 'main')
}

describe('the command', () => {
  it('refuses a call with no phase', async () => {
    const answer = answerOf(await fixGroupCommand(context({}, [])))
    expect(answer).toEqual({
      status: 1,
      json: { error: 'usage: gh-security fix-group <setup|classify|baseline> [options]' },
      stderr: 'usage: gh-security fix-group <setup|classify|baseline> [options]',
    })
  })

  // Exit 1, never exit 2: exit 2 is `needs_judgment` in this contract.
  it.each(['apply', 'score', 'cleanup', 'bogus'])(
    'refuses the phase %s with exit 1',
    async (phase) => {
      const answer = answerOf(await fixGroupCommand(context({}, [phase])))
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(`'${phase}' is not a phase of this command`)
    },
  )

  it.each(['classify', 'baseline'])('refuses %s with no --work', async (phase) => {
    const answer = answerOf(await fixGroupCommand(context({}, [phase])))
    expect(answer.json).toEqual({ error: `${phase}: --work is required` })
  })

  it('refuses an option that the phase does not take', async () => {
    const answer = answerOf(await fixGroupCommand(context({}, ['classify', '--adapter', 'x'])))
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("'--adapter'")
  })
})

describe('setup (phase 1)', () => {
  describe('the command line and the group', () => {
    it.each(['group-json', 'repo-root', 'default-branch'])('requires --%s', async (name) => {
      const w = world()
      const args = setupArgs(w)
      const at = args.indexOf(`--${name}`)
      args.splice(at, 2)
      expect((await call(w, args)).json).toEqual({ error: `setup requires --${name}` })
    })

    // `--env-prefix ""` is legal, and means no prefix. A trailing
    // `--env-prefix` with no value is an error, never a loop.
    it('refuses --env-prefix with no value', async () => {
      const w = world()
      const answer = await call(w, [...setupArgs(w), '--env-prefix'])
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("'--env-prefix <value>' argument missing")
    })

    it('keeps an empty --env-prefix, which means no prefix', async () => {
      const w = world()
      expect((await setup(w, '--env-prefix', '')).status).toBe(0)
      expect(stateOf(w).env_prefix).toBe('')
    })

    it('refuses --adapter, which the port does not take', async () => {
      const w = world()
      const answer = await setup(w, '--adapter', '/x/node.sh')
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("'--adapter'")
    })

    it('refuses a group file that is not there', async () => {
      const w = world()
      rmSync(w.groupFile)
      expect((await setup(w)).json).toEqual({
        error: `setup: no such group file: ${w.groupFile}`,
      })
    })

    it('refuses a repo root that is not a directory', async () => {
      const w = world()
      const args = setupArgs(w)
      args[args.indexOf('--repo-root') + 1] = w.groupFile
      expect((await call(w, args)).json).toEqual({
        error: `setup: no such repo root: ${w.groupFile}`,
      })
    })

    it.each([
      ['text that is not JSON', '{"package": ', 'setup: --group-json is not readable JSON'],
      ['a JSON list', '[]', 'setup: --group-json is not a JSON object'],
      [
        'an object with no keys',
        '{}',
        'setup: the group payload is missing: package, major_line, branch_name, highest_fixed_version, alerts, ecosystem',
      ],
    ])('refuses a group that is %s', async (_shape, text, error) => {
      const w = world()
      writeFileSync(w.groupFile, text)
      expect((await setup(w)).json).toEqual({ error })
    })

    // Key presence is not a value. `{"package": null}` passed the old check,
    // and the text `null` went into the path and the branch name.
    it.each([
      ['package', null],
      ['package', ''],
      ['branch_name', null],
      ['highest_fixed_version', null],
      ['alerts', []],
      ['alerts', 'none'],
      ['major_line', null],
      ['ecosystem', ''],
    ])('refuses a group whose %s is %j, and makes no worktree', async (key, value) => {
      const w = world()
      writeFileSync(w.groupFile, JSON.stringify({ ...GROUP, [key]: value }))
      expect((await setup(w)).json).toEqual({
        error: `setup: the group payload carries no usable value for: ${key}`,
      })
      expect(existsSync(join(w.repo, '.claude', 'worktrees'))).toBe(false)
    })

    // `major_line` goes into a regex anchor, so `.*` would match each major.
    it.each(['.*', '4|3', '', 'four', 4.5])('refuses a major_line of %j', async (line) => {
      const w = world()
      writeFileSync(w.groupFile, JSON.stringify({ ...GROUP, major_line: line }))
      const answer = await setup(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toMatch(/major_line|no usable value/)
    })

    it('takes a major_line that is a JSON number', async () => {
      const w = world()
      writeFileSync(w.groupFile, JSON.stringify({ ...GROUP, major_line: 4 }))
      expect(pick(await setup(w), 'major_line')).toEqual({ status: 0, major_line: '4' })
    })

    it('refuses an ecosystem with no adapter', async () => {
      const w = world()
      writeFileSync(w.groupFile, JSON.stringify({ ...GROUP, ecosystem: 'pip' }))
      expect((await setup(w)).json).toEqual({
        error: "setup: the group's ecosystem 'pip' has no adapter: ecosystem not supported yet",
      })
    })
  })

  describe('the guard for a crashed run', () => {
    it('stops on a work directory that is there, and keeps it', async () => {
      const w = world()
      mkdirSync(w.worktree, { recursive: true })
      const answer = await setup(w)
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'worktree' })
      expect(answer.stderr).toContain("fix-group: worktree failure: a previous run's workspace")
      expect(existsSync(w.worktree)).toBe(true)
    })
  })

  describe('the stale-branch guard checks, and does not stop on sight', () => {
    it('deletes and makes again a branch whose tip is origin/main', async () => {
      const w = world()
      w.fixtures.git(w.repo, 'branch', BRANCH)
      expect(pick(await setup(w), 'step', 'branch')).toEqual({
        status: 0,
        step: 'setup',
        branch: BRANCH,
      })
    })

    it('deletes and makes again a branch whose tip is origin/<branch>', async () => {
      const w = world()
      commitOnBranch(w, 'package-lock.json', '{"lockfileVersion":3,"n":1}\n', 'feat: work')
      w.fixtures.git(w.repo, 'push', '-q', 'origin', BRANCH)
      expect((await setup(w)).status).toBe(0)
    })

    // One commit, recognized by its subject AND its paths, never by one
    // of the two (#152).
    it('deletes and makes again a branch whose only commit is the drift commit', async () => {
      const w = world()
      commitOnBranch(w, 'package-lock.json', '{"lockfileVersion":3,"n":1}\n', DRIFT_SUBJECT)
      expect((await setup(w)).status).toBe(0)
    })

    it.each([
      ['a drift subject over package.json', 'package.json', '{"name":"x"}\n', DRIFT_SUBJECT],
      ['a lockfile commit with another subject', 'package-lock.json', '{}\n', 'chore: by hand'],
      ['work that was never pushed', 'src.js', 'console.log(1)\n', 'feat: unpushed work'],
    ])('refuses %s, and keeps the branch', async (_shape, file, content, subject) => {
      const w = world()
      commitOnBranch(w, file, content, subject)
      const tip = w.fixtures.sha(w.repo, BRANCH)
      const answer = await setup(w)
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'worktree' })
      expect(answer.stderr).toContain('may hold unpushed work')
      expect(answer.stderr).toContain('it was not deleted')
      expect(answer.stderr).toContain(`tip=${tip}`)
      expect(answer.stderr).toContain(`origin/${BRANCH}=<none>`)
      expect(w.fixtures.sha(w.repo, BRANCH)).toBe(tip)
    })

    it('refuses a branch with a commit beyond the tip that it pushed', async () => {
      const w = world()
      commitOnBranch(w, 'package-lock.json', '{"n":1}\n', 'feat: pushed')
      w.fixtures.git(w.repo, 'push', '-q', 'origin', BRANCH)
      const pushed = w.fixtures.sha(w.repo, BRANCH)
      w.fixtures.git(w.repo, 'checkout', '-q', BRANCH)
      w.fixtures.commit(w.repo, 'feat: not pushed', 'src.js', 'x')
      w.fixtures.git(w.repo, 'checkout', '-q', 'main')
      const answer = await setup(w)
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'worktree' })
      expect(answer.stderr).toContain(`origin/${BRANCH}=${pushed}`)
    })

    it('refuses a drift subject on a commit with no change', async () => {
      const w = world()
      w.fixtures.git(w.repo, 'checkout', '-q', '-b', BRANCH)
      w.fixtures.git(w.repo, 'commit', '-q', '--allow-empty', '-m', DRIFT_SUBJECT)
      w.fixtures.git(w.repo, 'checkout', '-q', 'main')
      expect(pick(await setup(w), 'phase')).toEqual({ status: 3, phase: 'worktree' })
    })

    it('reports a branch -D that fails, with the reason it was safe', async () => {
      const w = world()
      w.fixtures.git(w.repo, 'branch', BRANCH)
      const answer = await call(w, setupArgs(w), selectAdapter, refusing(w, 'branch -D'))
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'worktree' })
      expect(answer.stderr).toContain(`git branch -D ${BRANCH} failed (tip equals origin/main`)
    })
  })

  describe('a git read that fails is a failure, never an absent branch', () => {
    it.each([
      ['fetch origin main', 'git fetch origin main failed: git stub: refusing fetch origin main'],
      [`fetch origin ${BRANCH}`, 'may be stale'],
      ['branch --list', `git branch --list ${BRANCH} failed`],
      ['rev-parse origin/main', 'git rev-parse origin/main failed'],
      ['worktree add', 'worktree add'],
    ])('fails the worktree phase when git %s fails', async (failing, detail) => {
      const w = world()
      const answer = await call(w, setupArgs(w), selectAdapter, refusing(w, failing))
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'worktree' })
      expect(answer.stderr).toContain(detail)
    })

    it('fails the worktree phase when the tip of a local branch cannot be read', async () => {
      const w = world()
      w.fixtures.git(w.repo, 'branch', BRANCH)
      const answer = await call(w, setupArgs(w), selectAdapter, refusing(w, `rev-parse ${BRANCH}`))
      expect(answer.stderr).toContain(`git rev-parse ${BRANCH} failed`)
    })

    it('goes on when origin has no branch of the name', async () => {
      const w = world()
      expect((await setup(w)).status).toBe(0)
    })

    it('quotes a prefix that cannot start', async () => {
      const w = world()
      const answer = await setup(w, '--env-prefix', join(w.bin, 'no-such-prefix'))
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'worktree' })
      expect(answer.stderr).toContain('git fetch origin main failed: ')
      expect(answer.stderr).toContain('no-such-prefix')
    })
  })

  describe('the worktree and the state', () => {
    it('makes the worktree and a state file with each key a later phase reads', async () => {
      const w = world()
      expect((await setup(w)).json).toEqual({
        status: 'ok',
        step: 'setup',
        work: w.work,
        worktree: w.worktree,
        branch: BRANCH,
        package: 'lodash',
        major_line: '4',
      })
      expect(existsSync(join(w.worktree, 'package.json'))).toBe(true)
      expect(w.fixtures.currentBranch(w.worktree)).toBe(BRANCH)
      expect(stateOf(w)).toEqual({
        group: GROUP,
        repo_root: w.repo,
        default_branch: 'main',
        adapter: 'node',
        ecosystem: 'npm',
        scorer: DEFAULT_SCORER,
        env_prefix: '',
        work: w.work,
        worktree: w.worktree,
        branch_name: BRANCH,
        package: 'lodash',
        package_path: 'lodash',
        major_line: '4',
        drift_commit: false,
        fix_installs: 0,
        install_signals: [],
      })
    })

    it('names the bash scorer of this plugin by default (ruling 4)', () => {
      expect(DEFAULT_SCORER).toBe(
        pluginFile('gh-security', 'scripts', 'common', 'score-merge-risk.sh'),
      )
    })

    it('records the scorer and the prefix that it was given', async () => {
      const w = world()
      await setup(w, '--scorer', '/s/scorer.sh', '--env-prefix', 'env FOO=1')
      expect({ scorer: stateOf(w).scorer, env_prefix: stateOf(w).env_prefix }).toEqual({
        scorer: '/s/scorer.sh',
        env_prefix: 'env FOO=1',
      })
    })

    // The `/` goes to `-` in the path (#161), and the branch keeps it.
    it('puts a scoped package in one directory level', async () => {
      const w = world('npm-v3', {
        ...GROUP,
        package: '@babel/traverse',
        major_line: '7',
        branch_name: 'fix/dependabot-@babel/traverse-7x',
      })
      expect(pick(await setup(w), 'work', 'branch')).toEqual({
        status: 0,
        work: join(w.repo, '.claude', 'worktrees', 'fix-dependabot-@babel-traverse-7x'),
        branch: 'fix/dependabot-@babel/traverse-7x',
      })
      expect(existsSync(join(w.repo, '.claude', 'worktrees', 'fix-dependabot-@babel'))).toBe(false)
    })

    it('fails the worktree phase when the worktrees directory cannot be made', async () => {
      const w = world()
      writeFileSync(join(w.repo, '.claude'), 'a file\n')
      const answer = await setup(w)
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'worktree' })
      expect(answer.stderr).toContain(`cannot create ${w.repo}/.claude/worktrees: `)
    })

    it('is exit 1 when the state file cannot be written', async () => {
      const w = world()
      // The prefix makes the temporary file of the state a directory, after
      // the worktree is there.
      const prefix = script(
        w,
        'block-state',
        '"$@"; st=$?\ncase "$*" in *"worktree add"*) mkdir -p "$BLOCK";; esac\nexit $st\n',
      )
      const answer = await call(w, setupArgs(w, '--env-prefix', prefix), selectAdapter, {
        ...w.env,
        BLOCK: join(w.work, 'state.json.tmp'),
      })
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain('setup: cannot write the state file at ')
    })
  })
})

/** A world after `setup`. */
const afterSetup = async (fixture?: string, group?: Group, ...extra: string[]) => {
  const w = world(fixture, group)
  const answer = await setup(w, ...extra)
  expect(answer.status).toBe(0)
  return w
}

describe('the state that a later phase reads', () => {
  it.each(['classify', 'baseline'])('%s refuses a work directory with no state', async (phase) => {
    const w = world()
    const answer = await call(w, [phase, '--work', w.work])
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(`no readable state file at ${join(w.work, 'state.json')}`)
  })

  it.each([
    ['zero-byte', ''],
    ['truncated', '{"repo_root": "'],
    ['not an object', '[]'],
  ])('refuses a %s state file, and keeps the worktree', async (_shape, text) => {
    const w = await afterSetup()
    writeFileSync(join(w.work, 'state.json'), text)
    expect((await classify(w)).status).toBe(1)
    expect(existsSync(w.worktree)).toBe(true)
  })

  it.each(['repo_root', 'worktree', 'branch_name', 'default_branch', 'ecosystem'])(
    'refuses an empty %s before any git call or verb',
    async (key) => {
      const w = await afterSetup()
      editState(w, (state) => {
        state[key] = ''
      })
      const answer = await baseline(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(`no usable value for '${key}'`)
      expect(existsSync(join(w.pmDir, 'install.n'))).toBe(false)
    },
  )

  it('refuses a state whose ecosystem has no adapter', async () => {
    const w = await afterSetup()
    editState(w, (state) => {
      state.ecosystem = 'pip'
    })
    expect((await classify(w)).stderr).toContain(
      "names the ecosystem 'pip', which has no adapter: ecosystem not supported yet",
    )
  })
})

/** A `declared_ranges` answer with no parent in any list. */
const NO_PARENTS = {
  pm: 'npm',
  package: 'lodash',
  line: 4,
  ranges: [],
  root_range: null,
  parents_read: [],
  parents_without_range: [],
  parents_unreadable: [],
  parents_malformed: [],
  parents_other_lines: [],
}

describe('classify (phase 2)', () => {
  it('answers with the relationship and the eligible parents, and writes them', async () => {
    const w = await afterSetup()
    expect((await classify(w)).json).toEqual({
      status: 'ok',
      step: 'classify',
      relationship: 'direct',
      eligible_parents: ['express'],
      parents_read: ['express'],
      parents_without_range: [],
      parents_unreadable: [],
      parents_malformed: [],
      parents_other_lines: ['test-exclude@6.0.0'],
      ranges: ['^4.17.20', '^4.17.21'],
    })
    const state = stateOf(w)
    expect({
      relationship: state.relationship,
      eligible: state.eligible_parents,
      raw: (state.why as Record<string, JsonValue>).raw,
      line: (state.declared as Record<string, JsonValue>).line,
    }).toEqual({
      relationship: 'direct',
      eligible: ['express'],
      raw: 'stand-in explain lodash',
      line: 4,
    })
  })

  // A dead end that `why` names before any install (#103).
  it('stops on a package that only peer resolutions reach, with both peer lists', async () => {
    const w = await afterSetup('pnpm-peer-only', {
      ...GROUP,
      package: 'vite',
      major_line: '6',
      branch_name: 'fix/dependabot-vite-6x',
    })
    const answer = await classify(w)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'classify' })
    expect(answer.stderr).toContain('peer_only_dependency: vite is reached only through peer')
    expect(answer.stderr).toContain('peer_parents=["@vitejs/plugin-react","@vitest/mocker"]')
    expect(answer.stderr).toContain('optional_peer_parents=["@vitest/mocker"]')
    expect(stateOf(w).why).toBeUndefined()
  })

  it('never reads declared_ranges or installs on the peer-only stop', async () => {
    const w = await afterSetup()
    const declaredRanges = vi.fn()
    const route = stand({
      why: async (tree, pkg, source) => {
        const answer = await node.why(tree, pkg, source)
        if (answer.outcome !== 'ok') return answer
        const { peer_parents: _peers, optional_peer_parents: _optional, ...rest } = answer.value
        return ok({ ...rest, peer_only: true } as never)
      },
      declaredRanges,
    })
    const answer = await classify(w, route)
    expect(answer.status).toBe(3)
    expect(answer.stderr).toContain('peer_parents=null optional_peer_parents=null')
    expect(declaredRanges).not.toHaveBeenCalled()
  })

  // The eligible set is the three lists, by name, minus nothing else (#76,
  // #83, #85).
  it.each([
    [
      'the union of the three lists, without parents_other_lines',
      {
        parents_read: ['express'],
        parents_without_range: ['koa'],
        parents_unreadable: ['fastify'],
        parents_other_lines: ['minimatch@3.1.5'],
      },
      ['express', 'fastify', 'koa'],
    ],
    [
      'every unreadable parent when none was read',
      { parents_read: [], parents_unreadable: ['express'], parents_malformed: ['express'] },
      ['express'],
    ],
    [
      'the name without the version of a copy',
      { parents_read: ['minimatch@10.2.5', '@scope/pkg@1.0.0', '@scope/bare'] },
      ['@scope/bare', '@scope/pkg', 'minimatch'],
    ],
    ['nothing for lists that are null', { parents_read: null }, []],
  ])('takes %s as eligible', async (_shape, lists, eligible) => {
    const w = await afterSetup()
    const route = stand({
      declaredRanges: () => ok({ ...NO_PARENTS, ...lists } as never),
    })
    expect(pick(await classify(w, route), 'eligible_parents')).toEqual({
      status: 0,
      eligible_parents: eligible,
    })
  })

  it('asks declared_ranges for the major line of the group', async () => {
    const w = await afterSetup()
    const declaredRanges = vi.fn(node.declaredRanges)
    await classify(w, stand({ declaredRanges }))
    expect(declaredRanges.mock.calls.map(([, pkg, line]) => [pkg, line])).toEqual([['lodash', 4]])
  })

  // A field that the contract promises is there, or the phase fails. Read
  // straight, an absent field is the text "null" and takes a branch of its own.
  it.each([
    ['peer_only', "emitted no 'peer_only' field"],
    ['relationship', "emitted no 'relationship' field"],
  ])('fails the phase on an answer of why with no %s', async (key, detail) => {
    const w = await afterSetup()
    const route = stand({
      why: async (tree, pkg, source) => {
        const answer = await node.why(tree, pkg, source)
        if (answer.outcome !== 'ok') return answer
        const { [key as 'peer_only']: _gone, ...rest } = answer.value
        return ok(rest as never)
      },
    })
    const answer = await classify(w, route)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'classify' })
    expect(answer.stderr).toContain(detail)
  })

  it('fails the phase on an answer of why that is not an object', async () => {
    const w = await afterSetup()
    const answer = await classify(w, stand({ why: async () => ok(null as never) }))
    expect(answer.stderr).toContain('adapter why lodash emitted no JSON object')
  })

  it('refuses a relationship outside the enum of the contract', async () => {
    const w = await afterSetup()
    const route = stand({
      why: async (tree, pkg, source) => {
        const answer = await node.why(tree, pkg, source)
        return answer.outcome === 'ok'
          ? ok({ ...answer.value, relationship: 'peer' as never })
          : answer
      },
    })
    const answer = await classify(w, route)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'classify' })
    expect(answer.stderr).toContain(
      "answered relationship 'peer', which is not in the contract enum direct|transitive",
    )
  })

  it('fails the phase when why fails, quoting the adapter', async () => {
    const w = await afterSetup()
    const answer = await classify(w, stand({ why: async () => failed('why broke') }))
    expect(answer.json).toEqual({
      status: 'failure',
      phase: 'classify',
      detail: 'adapter why lodash failed: why broke',
    })
  })

  it('fails the phase when the worktree has no lockfile that detect knows', async () => {
    const w = await afterSetup()
    rmSync(join(w.worktree, 'package-lock.json'))
    const answer = await classify(w)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'classify' })
    expect(answer.stderr).toContain('adapter why lodash failed: No supported lockfile found')
  })

  it('fails the phase when declared_ranges fails', async () => {
    const w = await afterSetup()
    const answer = await classify(w, stand({ declaredRanges: () => failed('ranges broke') }))
    expect((answer.json as Record<string, JsonValue>).detail).toBe(
      'adapter declared_ranges --line 4 lodash failed: ranges broke',
    )
  })

  it('fails the phase when detect fails before declared_ranges', async () => {
    const w = await afterSetup()
    let calls = 0
    const detect: Adapter<NodeDetection>['detect'] = (root, env) =>
      ++calls === 1 ? node.detect(root, env) : failed('detect broke')
    const answer = await classify(w, stand({ detect }))
    expect((answer.json as Record<string, JsonValue>).detail).toBe(
      'adapter declared_ranges --line 4 lodash failed: detect broke',
    )
  })

  it.each([
    ['not an object', () => ok(null as never), 'did not return a JSON object'],
    [
      'a parents list of numbers',
      () => ok({ parents_read: [1] } as never),
      'is not a list of names',
    ],
  ])('fails the phase on a declared_ranges answer that is %s', async (_shape, verb, detail) => {
    const w = await afterSetup()
    const answer = await classify(w, stand({ declaredRanges: verb }))
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'classify' })
    expect(answer.stderr).toContain(detail)
  })

  it('is exit 1 when the state cannot be written', async () => {
    const w = await afterSetup()
    mkdirSync(join(w.work, 'state.json.tmp'))
    const answer = await classify(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain('cannot write the state file')
  })
})

describe('baseline (phase 3)', () => {
  const ready = async (fixture?: string, group?: Group, ...extra: string[]) => {
    const w = await afterSetup(fixture, group, ...extra)
    expect((await classify(w)).status).toBe(0)
    return w
  }

  /** What HEAD of the worktree carries: its subject, then its paths. */
  const head = (w: World): string[] =>
    w.fixtures.git(w.worktree, 'show', '--name-only', '--format=%s', 'HEAD').split('\n')

  it('commits the drift when the control install rewrites the lockfile', async () => {
    const w = await ready()
    installs(w, "printf '\\n' >> package-lock.json\n")
    expect((await baseline(w)).json).toEqual({
      status: 'ok',
      step: 'baseline',
      drift_commit: true,
      baseline_present: true,
      pre_drift_present: true,
    })
    expect(head(w)).toEqual([DRIFT_SUBJECT, '', 'package-lock.json'])
    expect({ drift: stateOf(w).drift_commit, signals: stateOf(w).install_signals }).toEqual({
      drift: true,
      signals: [],
    })
  })

  it('makes no drift commit when the control install changes nothing', async () => {
    const w = await ready()
    const tip = w.fixtures.headSha(w.worktree)
    expect(pick(await baseline(w), 'drift_commit')).toEqual({ status: 0, drift_commit: false })
    expect(w.fixtures.headSha(w.worktree)).toBe(tip)
  })

  // The lockfile, the PnP files and the zero-install cache. Never
  // package.json.
  it('stages the lockfile and the install files, and nothing else', async () => {
    // A zero-install cache that main tracks, so a change to it shows as its
    // own path, as in a real Yarn Berry repository.
    const w = world()
    mkdirSync(join(w.repo, '.yarn', 'cache'), { recursive: true })
    writeFileSync(join(w.repo, '.yarn', 'cache', 'lodash-npm-4.17.20.zip'), 'old\n')
    w.fixtures.git(w.repo, 'add', '-A')
    w.fixtures.git(w.repo, 'commit', '-qm', 'add the cache')
    w.fixtures.push(w.repo)
    expect((await setup(w)).status).toBe(0)
    expect((await classify(w)).status).toBe(0)
    installs(
      w,
      "printf '\\n' >> package-lock.json\nprintf 'module.exports={}\\n' > .pnp.cjs\n" +
        "mkdir -p .yarn/cache\nprintf 'zip\\n' > .yarn/cache/lodash-npm-4.17.20.zip\n",
    )
    expect((await baseline(w)).status).toBe(0)
    expect(head(w)).toEqual([
      DRIFT_SUBJECT,
      '',
      '.pnp.cjs',
      '.yarn/cache/lodash-npm-4.17.20.zip',
      'package-lock.json',
    ])
  })

  // The drift commit takes the new name. The node adapter does not read
  // npm-shrinkwrap.json, so the read after the install then fails the phase.
  it('stages a lockfile that the install renamed, under its new name', async () => {
    const w = await ready()
    installs(
      w,
      "git mv package-lock.json npm-shrinkwrap.json\nprintf '\\n' >> npm-shrinkwrap.json\n",
    )
    expect((await baseline(w)).stderr).toContain('could not be parsed after the control install')
    expect(head(w)[0]).toBe(DRIFT_SUBJECT)
    expect(head(w)).toContain('npm-shrinkwrap.json')
  })

  it.each([
    [
      'package.json',
      "printf '\\n' >> package-lock.json\nprintf '\\n' >> package.json\n",
      'package.json',
    ],
    ['a stray file', "printf 'x\\n' > stray.txt\n", 'stray.txt'],
    ['a path that git quotes', "printf 'x\\n' > \"$(printf 'we\\303\\257rd.txt')\"\n", '"we'],
  ])('fails the phase on a residual change to %s, and keeps it', async (_shape, body, path) => {
    const w = await ready()
    installs(w, body)
    const answer = await baseline(w)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'baseline' })
    expect(answer.stderr).toContain('evidence, never noise to absorb')
    expect(answer.stderr).toContain(path)
    expect(w.fixtures.git(w.worktree, 'status', '--porcelain')).not.toBe('')
  })

  // A failed control install is phase `baseline`, never `install`.
  it('fails the phase on a control install that fails, quoting it', async () => {
    const w = await ready()
    installs(w, "printf 'npm ERR! code ERESOLVE\\n' >&2\n", 1)
    expect((await baseline(w)).json).toEqual({
      status: 'failure',
      phase: 'baseline',
      detail:
        'the control install, with no manifest change, failed. Quoting the package manager: ' +
        '\nRunning: npm install\nnpm ERR! code ERESOLVE',
    })
  })

  // One retry, and only on the shape of a registry timeout (#122).
  it.each([
    [
      'ETIMEDOUT',
      'npm ERR! request to https://registry.npmjs.org/x failed, reason: connect ETIMEDOUT',
      2,
    ],
    ['EAI_AGAIN', 'npm ERR! errno EAI_AGAIN', 2],
    ['socket hang up', 'npm ERR! network socket hang up', 2],
    ['ECONNRESET', 'npm ERR! read ECONNRESET', 2],
    ['a registry that timed out', 'the registry timed out', 2],
    [
      'self-signed',
      'npm ERR! request to https://registry.npmjs.org/x failed, reason: self signed certificate',
      1,
    ],
    ['ENOTFOUND', 'npm ERR! getaddrinfo ENOTFOUND registry.example.invalid', 1],
    ['ERESOLVE', 'npm ERR! code ERESOLVE', 1],
    ['a registry and a timeout on two lines', 'registry\ntimed out', 1],
  ])('runs the install %s: %#', async (_shape, text, times) => {
    const w = await ready()
    installs(w, `printf '%s\\n' '${text}' >&2\n`, 1)
    const answer = await baseline(w)
    expect(readFileSync(join(w.pmDir, 'install.n'), 'utf8').trim()).toBe(String(times))
    expect(answer.stderr.includes('including one sanctioned retry')).toBe(times === 2)
  })

  it('passes when the retry succeeds', async () => {
    const w = await ready()
    installs(
      w,
      '[ "$(cat "$PM_DIR/install.n")" = 1 ] || { echo 0 > "$PM_DIR/install.status"; exit 0; }\n' +
        "printf 'npm ERR! ETIMEDOUT\\n' >&2\n",
      1,
    )
    expect((await baseline(w)).status).toBe(0)
  })

  // The pnpm 11 signal goes into the state (#159).
  it('carries the pnpm 11 signal that an install wrote into the state', async () => {
    const w = await ready()
    installs(
      w,
      `printf ' WARN  The "pnpm" field in package.json is no longer read by pnpm\\n' >&2\n`,
    )
    await baseline(w)
    expect(stateOf(w).install_signals).toEqual(['pnpm_field_no_longer_read'])
  })

  it('keeps the signals that the state already had', async () => {
    const w = await ready()
    editState(w, (state) => {
      state.install_signals = ['earlier']
    })
    await baseline(w)
    expect(stateOf(w).install_signals).toEqual(['earlier'])
  })

  it('is exit 1 on a state whose install_signals is not a list', async () => {
    const w = await ready()
    editState(w, (state) => {
      state.install_signals = 'x'
    })
    const answer = await baseline(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("no usable value for 'install_signals'")
  })

  // The order is the point (#146): the baseline is after the control install.
  it('reads resolved_versions before and after the control install', async () => {
    const w = await ready()
    const seen: string[] = []
    const route = stand({
      resolvedVersions: (tree, pkg) => {
        seen.push('resolved_versions')
        return node.resolvedVersions(tree, pkg)
      },
      install: async (tree, source) => {
        seen.push('install')
        return node.install(tree, source)
      },
    })
    expect((await baseline(w, route)).status).toBe(0)
    expect(seen).toEqual(['resolved_versions', 'install', 'resolved_versions'])
  })

  it('writes the snapshot before the drift into the state, and the baseline after it', async () => {
    const w = await ready()
    let calls = 0
    const route = stand({
      resolvedVersions: (tree, pkg) => {
        const answer = node.resolvedVersions(tree, pkg)
        calls += 1
        return answer.outcome === 'ok' ? ok({ ...answer.value, count: calls }) : answer
      },
    })
    await baseline(w, route)
    const state = stateOf(w)
    expect([
      (state.pre_drift as Record<string, JsonValue>).count,
      (state.baseline as Record<string, JsonValue>).count,
    ]).toEqual([1, 2])
  })

  // A failed parse is never an empty result.
  it.each(['before', 'after'] as const)(
    'fails the phase when the lockfile cannot be parsed %s the install',
    async (when) => {
      const w = await ready()
      let calls = 0
      const route = stand({
        resolvedVersions: (tree, pkg) =>
          ++calls === (when === 'before' ? 1 : 2)
            ? failed('resolved_versions: parsed zero entries')
            : node.resolvedVersions(tree, pkg),
      })
      expect((await baseline(w, route)).json).toEqual({
        status: 'failure',
        phase: 'baseline',
        detail:
          `the lockfile could not be parsed ${when} the control install (resolved_versions ` +
          'lodash): resolved_versions: parsed zero entries. A failed parse is never an empty result.',
      })
    },
  )

  it('fails the phase when the install took the lockfile away', async () => {
    const w = await ready()
    installs(w, 'rm package-lock.json\n')
    const answer = await baseline(w)
    expect(answer.stderr).toContain('could not be parsed after the control install')
    expect(answer.stderr).toContain('No supported lockfile found')
  })

  it('fails the phase on a resolved_versions answer with no present field', async () => {
    const w = await ready()
    const route = stand({
      resolvedVersions: (tree, pkg) => {
        const answer = node.resolvedVersions(tree, pkg)
        if (answer.outcome !== 'ok') return answer
        const { present: _present, ...rest } = answer.value
        return ok(rest as never)
      },
    })
    const answer = await baseline(w, route)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'baseline' })
    expect(answer.stderr).toContain(
      "resolved_versions lodash (before the control install) emitted no 'present' field",
    )
  })

  it('reads a present that is null as false', async () => {
    const w = await ready()
    const route = stand({
      resolvedVersions: (tree, pkg) => {
        const answer = node.resolvedVersions(tree, pkg)
        return answer.outcome === 'ok' ? ok({ ...answer.value, present: null as never }) : answer
      },
    })
    expect(pick(await baseline(w, route), 'baseline_present', 'pre_drift_present')).toEqual({
      status: 0,
      baseline_present: false,
      pre_drift_present: false,
    })
  })

  it('fails the phase when the install verb itself fails', async () => {
    const w = await ready()
    const answer = await baseline(w, stand({ install: async () => failed('refusing to run') }))
    expect((answer.json as Record<string, JsonValue>).detail).toBe(
      'the control install, with no manifest change, failed. Quoting the package manager: \nrefusing to run',
    )
  })

  it('fails the phase when detect fails before the install', async () => {
    const w = await ready()
    let calls = 0
    const detect: Adapter<NodeDetection>['detect'] = (root, env) =>
      ++calls === 2 ? failed('detect broke') : node.detect(root, env)
    expect((await baseline(w, stand({ detect }))).stderr).toContain(
      'Quoting the package manager: \ndetect broke',
    )
  })

  it.each([
    ['status --porcelain', 'git status --porcelain failed in the worktree'],
    ['add --', 'git add package-lock.json failed'],
    ['commit', 'the drift commit failed'],
  ])('fails the phase when git %s fails', async (failing, detail) => {
    const w = await ready()
    installs(w, "printf '\\n' >> package-lock.json\n")
    const answer = await baseline(w, selectAdapter, refusing(w, failing))
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'baseline' })
    expect(answer.stderr).toContain(detail)
  })

  it('fails the phase when the second git status fails', async () => {
    const w = await ready()
    installs(w, "printf '\\n' >> package-lock.json\n")
    const prefix = script(
      w,
      'second-status',
      'case "$*" in *"status --porcelain"*)\n' +
        '  n=$(cat "$PM_DIR/status.n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$PM_DIR/status.n"\n' +
        '  [ "$n" = 2 ] && { echo "status refused" >&2; exit 1; } ;;\nesac\nexec "$@"\n',
    )
    editState(w, (state) => {
      state.env_prefix = prefix
    })
    const answer = await baseline(w)
    expect(answer.stderr).toContain('git status --porcelain failed in the worktree: status refused')
  })

  // The hooks of the repository run. A hook that fails the drift commit is
  // quoted; it is never bypassed.
  it('quotes a pre-commit hook that fails the drift commit', async () => {
    const w = await ready()
    installs(w, "printf '\\n' >> package-lock.json\n")
    mkdirSync(join(w.worktree, '.githooks'))
    writeFileSync(
      join(w.worktree, '.githooks', 'pre-commit'),
      "#!/bin/sh\necho 'lint: 3 problems' >&2\nexit 1\n",
    )
    chmodSync(join(w.worktree, '.githooks', 'pre-commit'), 0o755)
    w.fixtures.git(w.worktree, 'config', 'core.hooksPath', '.githooks')
    const answer = await baseline(w)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'baseline' })
    expect(answer.stderr).toContain('lint: 3 problems')
    expect(answer.stderr).toContain('never bypass a hook')
  })

  it.each([
    ['before the install', ''],
    ['after the install', 'mkdir "$BLOCK"\n'],
  ])('is exit 1 when the state cannot be written %s', async (_when, body) => {
    const w = await ready()
    const block = join(w.work, 'state.json.tmp')
    if (body === '') mkdirSync(block)
    installs(w, body)
    const answer = await baseline(w, selectAdapter, { ...w.env, BLOCK: block })
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain('cannot write the state file')
  })
})

describe('env_prefix', () => {
  // The prefix script writes the name of each command that it wraps, then
  // runs it. The log is the verdict: the prefix reaches each child.
  const logging = (w: World): string =>
    script(w, 'prefix', 'printf \'%s\\n\' "$1" >> "$PREFIX_LOG"\nexec "$@"\n')
  const logged = (w: World): string[] =>
    existsSync(w.env.PREFIX_LOG as string)
      ? [...new Set(readFileSync(w.env.PREFIX_LOG as string, 'utf8').split('\n'))]
          .filter(Boolean)
          .sort()
      : []

  it('wraps each git call of setup, each package-manager call, and each git call after', async () => {
    const w = world()
    w.env.PREFIX_LOG = w.sandbox.join('prefix.log')
    const prefix = logging(w)
    expect((await setup(w, '--env-prefix', prefix)).status).toBe(0)
    expect(logged(w)).toEqual(['git'])
    expect((await classify(w)).status).toBe(0)
    expect(logged(w)).toEqual(['git', 'npm'])
    rmSync(w.env.PREFIX_LOG as string)
    installs(w, "printf '\\n' >> package-lock.json\n")
    expect((await baseline(w)).status).toBe(0)
    expect(logged(w)).toEqual(['git', 'npm'])
  })

  it('runs bare with no prefix', async () => {
    const w = world()
    w.env.PREFIX_LOG = w.sandbox.join('prefix.log')
    logging(w)
    await setup(w)
    await classify(w)
    await baseline(w)
    expect(logged(w)).toEqual([])
  })

  it('composes after the directory of a package-manager call', async () => {
    const calls: unknown[] = []
    const spawn = (async (command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options })
      return { status: 0 }
    }) as never
    const { pm } = runners(spawn, ['env', 'A=1'], {})
    await pm('npm', ['install'], { cwd: '/w' })
    await pm('npm')
    expect(calls).toEqual([
      { command: 'env', args: ['A=1', 'npm', 'install'], options: { cwd: '/w' } },
      { command: 'env', args: ['A=1', 'npm'], options: {} },
    ])
  })
})

describe('the drift paths', () => {
  it.each([
    ['package-lock.json', true],
    ['npm-shrinkwrap.json', true],
    ['pnpm-lock.yaml', true],
    ['yarn.lock', true],
    ['.pnp.cjs', true],
    ['.pnp.loader.mjs', true],
    ['.yarn/cache/lodash-npm-4.17.20.zip', true],
    ['package.json', false],
    ['.yarn/releases/yarn.cjs', false],
    ['sub/package-lock.json', false],
    ['"we\\303\\257rd.txt"', false],
  ])('allows %s: %j', (path, allowed) => {
    expect(driftPathAllowed(path)).toBe(allowed)
  })

  it('reads one path for each line, and the destination of a rename', () => {
    expect(
      porcelainPaths(' M package-lock.json\nR  a -> b -> c\n?? "we\\303\\257rd.txt"\n\n'),
    ).toEqual(['package-lock.json', 'c', '"we\\303\\257rd.txt"'])
  })
})
