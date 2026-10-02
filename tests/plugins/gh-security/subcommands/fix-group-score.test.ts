// `gh-security fix-group score`. The seam is the exported handler, with the
// runner and the registry as parameters. These are the examples of
// `spec/fix_group_apply_spec.sh` that cover `score`, the examples of its
// `env_prefix` block that name the scorer, and the branches that only the
// port has.
//
// `score` reads the state that `apply` wrote and runs no git command. So each
// example writes that state by hand, in a directory that has the lockfile of
// a worktree, and the real flow is one example at the end. The adapter is the
// real node adapter with `why`, `declared_ranges` and `resolved_versions`
// replaced by written answers (`mocking.md`, "The injected collaborator").
// `compare_versions` is the real one. The scorer is a stand-in program, which
// is a real seam because the port runs it as a child. It writes its argv and
// its directory to a log. The package manager is a stand-in on PATH.
// The expected values come from the contract in the header of `fix-group.ts`
// and from the jq probes that it cites. `parity-fix-group-score.test.ts`
// compares the port with `fix-group.sh` and the real scorer.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
import { NODE_ADAPTER } from '#gh-security/subcommands/fix-group-score.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

vi.setConfig({ testTimeout: 60_000 })

type Json = Record<string, JsonValue>

/** The stand-in scorer. It logs its argv with a NUL after each argument, and its directory. */
const SCORER = `#!/bin/sh
printf '%s\\0' "$@" > "$SCORER_DIR/argv"
pwd > "$SCORER_DIR/cwd"
env | grep '^SCORER_MARK=' > "$SCORER_DIR/mark" || true
[ -f "$SCORER_DIR/hook.sh" ] && . "$SCORER_DIR/hook.sh"
[ -f "$SCORER_DIR/err.txt" ] && cat "$SCORER_DIR/err.txt" >&2
[ -f "$SCORER_DIR/out.txt" ] && cat "$SCORER_DIR/out.txt"
exit "$(cat "$SCORER_DIR/status" 2>/dev/null || echo 0)"
`

/** The stand-in package manager. Only the prefix log can tell a call apart. */
const FAKE_PM = `#!/bin/sh
printf 'stand-in %s\\n' "$*"
`

/** The prefix of `env_prefix`. It logs the directory and its first argument. */
const PREFIX = `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$1" >> "$PREFIX_LOG"
exec "$@"
`

const RISK = {
  package: 'lodash',
  score: 3,
  band: 'Low',
  factors: [
    { id: 'F1', score: 2 },
    { id: 'F4', score: 0 },
    { id: 'F5', score: 1 },
  ],
  markdown: '## Merge risk',
  coverage: { affected: 1, covered: 1, uncovered: [] },
  ci: { workflow: null, trigger: null, step: null },
}

const rv = (...versions: string[]): Json => ({
  pm: 'npm',
  package: 'lodash',
  present: true,
  count: versions.length,
  versions: versions.map((version) => ({ version, path: 'node_modules/lodash' })),
  lockfile_entries: 3,
})

const WHY: Json = {
  pm: 'npm',
  package: 'lodash',
  relationship: 'transitive',
  dev_only: false,
  parents: ['express'],
  parent_count: 1,
  peer_only: false,
  peer_parents: [],
  optional_peer_parents: [],
  raw: 'lodash@4.17.21',
}

const DECLARED: Json = {
  pm: 'npm',
  package: 'lodash',
  line: 4,
  ranges: ['^4.17.20'],
  root_range: null,
  parents_read: ['express'],
  parents_without_range: [],
  parents_unreadable: [],
  parents_malformed: [],
  parents_other_lines: [],
}

const WRITTEN = [
  { parent: 'express', path: ['overrides', 'express', 'lodash'], value: '>=4.17.21 <5' },
]

const APPLY_RESULT: Json = {
  pm: 'npm',
  package: 'lodash',
  range: '>=4.17.21 <5',
  override_location: 'overrides',
  override_file: 'package.json',
  mode: 'scoped',
  parents: ['express'],
  written: WRITTEN,
  superseded_keys: [],
  alias_lookup: { source: 'lockfile', parents_unresolved: [] },
  lockfile_invalidated: { performed: true, keys: ['node_modules/lodash'] },
  observations: [],
}

const VALIDATE: Json = {
  ok: true,
  package: 'lodash',
  range: '>=4.17.21 <5',
  line: '4',
  line_present: true,
  checked: 1,
  resolved_count: 1,
  violations: [],
  unresolved_alerts: [],
  requires_major_bump: [],
  other_line_moves: [],
  resolved_versions: ['4.17.21'],
}

/** What the stand-in adapter answers. */
interface Script {
  why: unknown
  declared: unknown
  rv: unknown
  /** A verb that fails, by name, with its message. */
  failures: Partial<Record<'rv' | 'why' | 'declared', string>>
  /** The call of `detect`, counted from the start of `score`, that fails. */
  failDetectAt: number | null
  compare: Adapter<NodeDetection>['compareVersions'] | null
  onWhy: () => void
}

interface World {
  readonly script: Script
  readonly env: NodeJS.ProcessEnv
  readonly work: string
  readonly worktree: string
  readonly scorerDir: string
  readonly scorer: string
  readonly bin: string
  readonly state: Json
  readonly whyRuns: string[]
  detects: number
  verbs: string[]
}

/** The state that `apply` leaves, as `score` reads it. */
const baseState = (work: string, worktree: string, scorer: string): Json => ({
  group: { package: 'lodash', major_line: '4' },
  repo_root: '/repo',
  default_branch: 'main',
  adapter: 'node',
  ecosystem: 'npm',
  scorer,
  env_prefix: '',
  work,
  worktree,
  branch_name: 'fix/dependabot-lodash-4x',
  package: 'lodash',
  package_path: 'lodash',
  major_line: '4',
  pre_drift: rv('4.17.19'),
  baseline: rv('4.17.20'),
  drift_commit: false,
  relationship: 'transitive',
  eligible_parents: ['express'],
  declared: DECLARED,
  fix_installs: 1,
  install_signals: [],
  observations_first: [],
  action: 'scoped-override',
  override_scope: 'scoped',
  bare_override: 'none',
  apply_result: APPLY_RESULT,
  validate: VALIDATE,
  applied_parents: ['express'],
  tighten_bare: false,
})

const world = (edit: (w: World) => void = () => {}): World => {
  const sandbox = createSandbox()
  const bin = sandbox.stubPath(sandbox.join('bin'))
  writeFileSync(join(bin, 'npm'), FAKE_PM)
  chmodSync(join(bin, 'npm'), 0o755)
  const work = sandbox.join('work')
  const worktree = join(work, 'fix')
  mkdirSync(work)
  cpSync(join(FIXTURES_ROOT, 'npm-v3'), worktree, { recursive: true })
  const scorerDir = sandbox.join('scorer')
  mkdirSync(scorerDir)
  const scorer = join(bin, 'score-merge-risk.sh')
  writeFileSync(scorer, SCORER)
  chmodSync(scorer, 0o755)
  writeFileSync(join(scorerDir, 'out.txt'), JSON.stringify(RISK))
  sandbox.env.SCORER_DIR = scorerDir
  sandbox.env.STATE_TMP = join(work, 'state.json.tmp')
  const w: World = {
    script: {
      why: WHY,
      declared: DECLARED,
      rv: rv('4.17.21'),
      failures: {},
      failDetectAt: null,
      compare: null,
      onWhy: () => {},
    },
    env: sandbox.env,
    work,
    worktree,
    scorerDir,
    scorer,
    bin,
    state: baseState(work, worktree, scorer),
    whyRuns: [],
    detects: 0,
    verbs: [],
  }
  edit(w)
  writeFileSync(join(work, 'state.json'), JSON.stringify(w.state))
  return w
}

/** The registry, with the stand-in adapter of the world. */
const route =
  (w: World): typeof selectAdapter =>
  (ecosystem: string) => {
    const adapter: Adapter<NodeDetection> = {
      ...node,
      detect: (root, env) => {
        w.detects += 1
        if (w.script.failDetectAt === w.detects)
          return failed('detect: the stand-in found no lockfile')
        return node.detect(root, env)
      },
      resolvedVersions: () => {
        w.verbs.push('resolved_versions')
        const message = w.script.failures.rv
        return message === undefined ? ok(w.script.rv as never) : failed(message)
      },
      why: async (_tree, _pkg, source) => {
        w.verbs.push('why')
        w.script.onWhy()
        // The source gives the runner of the package manager. A verb that
        // reads `raw` from it runs `npm why`.
        if (source.run !== undefined) {
          const answer = await source.run('npm', ['explain'], {
            cwd: w.worktree,
            env: source.env as NodeJS.ProcessEnv,
          })
          w.whyRuns.push(answer.stdout.trim())
        }
        const message = w.script.failures.why
        return message === undefined ? ok(w.script.why as never) : failed(message)
      },
      declaredRanges: (_tree, _pkg, line) => {
        w.verbs.push(`declared_ranges ${String(line)}`)
        const message = w.script.failures.declared
        return message === undefined ? ok(w.script.declared as never) : failed(message)
      },
      compareVersions: (a, b) => (w.script.compare ?? node.compareVersions)(a, b),
    }
    return { supported: true, ecosystem, name: 'node', adapter, manifest: null }
  }

interface Answer {
  readonly status: number
  readonly json: Json
  readonly stderr: string
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) throw new Error('fix-group answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value as Json, stderr: '' }
  if ('report' in result) {
    return { status: result.exitCode ?? 1, json: result.report as Json, stderr: result.error }
  }
  return { status: exitCodeFor(result), json: { error: result.error }, stderr: result.error }
}

const context = (env: NodeJS.ProcessEnv, args: readonly string[]): CommandContext => ({
  args,
  env,
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

/** Run `score` on the world. */
const score = async (w: World, work = w.work): Promise<Answer> =>
  answerOf(
    await fixGroup(context(w.env, ['score', '--work', work]), {
      spawn: run,
      route: route(w),
    }),
  )

const stateOf = (w: World): Json =>
  JSON.parse(readFileSync(join(w.work, 'state.json'), 'utf8')) as Json

/** What the scorer was run with: its argv, in order. Null when it never ran. */
const argvOf = (w: World): string[] | null => {
  const path = join(w.scorerDir, 'argv')
  return existsSync(path) ? readFileSync(path, 'utf8').split('\0').slice(0, -1) : null
}

/** The value after the first flag of that name. */
const flag = (argv: string[] | null, name: string): string | undefined =>
  argv?.[argv.indexOf(name) + 1]

const scorerOut = (w: World, text: string): void => {
  writeFileSync(join(w.scorerDir, 'out.txt'), text)
}

const scorerHook = (w: World, body: string): void => {
  writeFileSync(join(w.scorerDir, 'hook.sh'), body)
}

/** A projection of an answer: the exit status, and the named keys of its JSON. */
const pick = (answer: Answer, ...keys: string[]): { exit: number } & Json => ({
  exit: answer.status,
  ...Object.fromEntries(keys.map((key) => [key, answer.json[key] ?? null])),
})

const FAILURE = { exit: 3, status: 'failure', phase: 'validate' }

const failure = (answer: Answer) => pick(answer, 'status', 'phase')

/** A state without the named keys. */
const without = (w: World, ...keys: string[]): void => {
  for (const key of keys) delete w.state[key]
}

/** A directory where the state's temporary file goes, so the next write fails. */
const blockState = (w: World): void => {
  mkdirSync(join(w.work, 'state.json.tmp'))
}

const BLOCKED = 'cannot write the state file'

describe('the command', () => {
  it('names score in its usage', async () => {
    const answer = answerOf(await fixGroupCommand(context({}, [])))
    expect(answer.json.error).toContain('<setup|classify|baseline|apply|score>')
  })

  it('refuses score with no --work', async () => {
    const answer = answerOf(await fixGroupCommand(context({}, ['score'])))
    expect(answer.json).toEqual({ error: 'score: --work is required' })
  })

  it('refuses a work directory with no state file', async () => {
    const w = world()
    const answer = await score(w, join(w.work, 'nowhere'))
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain('no readable state file')
  })

  it('names the scorer of this plugin, a script that is there', () => {
    expect(NODE_ADAPTER).toBe(pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh'))
    expect(existsSync(NODE_ADAPTER)).toBe(true)
  })
})

describe('score (phase 5)', () => {
  it('returns ready_for_pr with the whole report', async () => {
    const w = world()
    const answer = await score(w)
    expect(answer).toEqual({
      status: 0,
      stderr: '',
      json: {
        status: 'ready_for_pr',
        package: 'lodash',
        major_line: '4',
        branch: 'fix/dependabot-lodash-4x',
        work: w.work,
        worktree: w.worktree,
        why_json: `${w.work}/why-lodash.json`,
        action: 'scoped-override',
        override_scope: 'scoped',
        bare_override: 'none',
        drift_commit: false,
        resolved_version: '4.17.21',
        before: '4.17.20',
        risk: {
          band: 'Low',
          score: 3,
          f4: 0,
          f5: 1,
          markdown: '## Merge risk',
          coverage: RISK.coverage,
          ci: RISK.ci,
        },
        written: WRITTEN,
        superseded_keys: [],
        override_file: 'package.json',
        alias_lookup: APPLY_RESULT.alias_lookup,
        lockfile_invalidated: APPLY_RESULT.lockfile_invalidated,
        observations: [],
        observations_pre_fix: [],
        install_signals: [],
        applied_parents: ['express'],
        requires_major_bump: [],
        other_line_moves: [],
        benign_moves: [],
        validate: VALIDATE,
        why_raw: 'lodash@4.17.21',
        declared_ranges: ['^4.17.20'],
        declared_ranges_cause: null,
        parents_unreadable: [],
        parents_malformed: [],
      },
    })
  })

  it('reads each verb once, in the order of the bash', async () => {
    const w = world()
    await score(w)
    expect(w.verbs).toEqual(['resolved_versions', 'why', 'declared_ranges 4'])
    expect(w.detects).toBe(3)
  })

  it('keeps the post-fix reads and the report in the state', async () => {
    const w = world()
    await score(w)
    const state = stateOf(w)
    expect(state.post_fix).toEqual(rv('4.17.21'))
    expect(state.declared_post).toEqual(DECLARED)
    expect(state.risk).toEqual(RISK)
  })

  it('writes the why capture under the work directory, with a newline at its end', async () => {
    const w = world()
    await score(w)
    expect(readFileSync(join(w.work, 'why-lodash.json'), 'utf8')).toBe(`${JSON.stringify(WHY)}\n`)
    expect(existsSync(join(w.work, 'why-lodash.json.tmp'))).toBe(false)
  })

  // The why capture is package-qualified and lives under the work directory,
  // never in a shared scratchpad (#133). The name comes from `package_path`,
  // so a scoped package has a path that exists (#161).
  it('names the why capture from package_path', async () => {
    const w = world((x) => {
      x.state.package_path = 'scope-lodash'
    })
    const answer = await score(w)
    expect(answer.json.why_json).toBe(`${w.work}/why-scope-lodash.json`)
    expect(flag(argvOf(w), '--why-json')).toBe(`${w.work}/why-scope-lodash.json`)
  })

  it('gives the text of --work to the names of the report as it is', async () => {
    const w = world()
    const answer = await score(w, `${w.work}/`)
    expect(pick(answer, 'work', 'why_json')).toEqual({
      exit: 0,
      work: `${w.work}/`,
      why_json: `${w.work}//why-lodash.json`,
    })
  })

  describe('the argv of the scorer', () => {
    it('is the argv of the bash, in its order', async () => {
      const w = world()
      await score(w)
      expect(argvOf(w)).toEqual([
        '--package',
        'lodash',
        '--after',
        '4.17.21',
        '--adapter',
        NODE_ADAPTER,
        '--why-json',
        `${w.work}/why-lodash.json`,
        '--override-scope',
        'scoped',
        '--before',
        '4.17.20',
        '--declared-range',
        '^4.17.20',
      ])
    })

    it('runs in the worktree', async () => {
      const w = world()
      await score(w)
      // The sandbox path can sit behind a link, as /var does on macOS.
      expect(readFileSync(join(w.scorerDir, 'cwd'), 'utf8').trim()).toMatch(/\/work\/fix$/)
    })

    it('gives the scorer the environment of the command', async () => {
      const w = world()
      w.env.SCORER_MARK = 'seen'
      await score(w)
      expect(readFileSync(join(w.scorerDir, 'mark'), 'utf8').trim()).toBe('SCORER_MARK=seen')
    })

    it('runs the scorer that the state names', async () => {
      const w = world()
      const other = join(w.bin, 'other-scorer.sh')
      writeFileSync(other, `#!/bin/sh\nprintf '{"band":"High"}'\n`)
      chmodSync(other, 0o755)
      w.state.scorer = other
      writeFileSync(join(w.work, 'state.json'), JSON.stringify(w.state))
      expect((await score(w)).json.risk).toMatchObject({ band: 'High' })
      expect(argvOf(w)).toBeNull()
    })

    // The widest shape that apply wrote goes through `--override-scope`.
    it.each(['none', 'scoped', 'bare-tightened', 'bare-added'])(
      'reports the override scope %s',
      async (scope) => {
        const w = world((x) => {
          x.state.override_scope = scope
        })
        const answer = await score(w)
        expect(flag(argvOf(w), '--override-scope')).toBe(scope)
        expect(answer.json.override_scope).toBe(scope)
      },
    )

    it('gives one --declared-range for each distinct range', async () => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges: ['^4.17.20', '~4.17.0'] }
      })
      await score(w)
      expect(argvOf(w)?.slice(12)).toEqual([
        '--declared-range',
        '^4.17.20',
        '--declared-range',
        '~4.17.0',
      ])
    })

    it('splits a range with a newline into one flag for each line, and drops empty lines', async () => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges: ['^4.17.20\n~4.17.0\n', ''] }
      })
      await score(w)
      expect(argvOf(w)?.slice(12)).toEqual([
        '--declared-range',
        '^4.17.20',
        '--declared-range',
        '~4.17.0',
      ])
    })

    // `--declared-range` is required, with an explicit `none` sentinel:
    // optional, its absence made the multi-major escalation unreachable.
    it.each([
      ['an empty list', []],
      ['null', null],
      ['a list of empty text', ['', '\n']],
    ])('gives the none sentinel for %s', async (_name, ranges) => {
      const w = world((x) => {
        x.script.declared = {
          ...DECLARED,
          ranges,
          parents_read: [],
          parents_unreadable: ['express'],
        }
      })
      const answer = await score(w)
      expect(argvOf(w)?.slice(12)).toEqual(['--declared-range', 'none'])
      expect(pick(answer, 'declared_ranges', 'declared_ranges_cause')).toEqual({
        exit: 0,
        declared_ranges: ranges === null ? [] : ranges,
        declared_ranges_cause: 'none_readable',
      })
    })
  })

  describe('declared_ranges_cause', () => {
    // The sentinel is the same and the reviewer's conclusion is not, so the two
    // ways of reaching it are reported apart.
    it('says that parents declared nothing when parents were read', async () => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges: [], parents_without_range: ['express'] }
      })
      expect(pick(await score(w), 'declared_ranges_cause')).toEqual({
        exit: 0,
        declared_ranges_cause: 'parents_declared_nothing',
      })
    })

    it.each([
      ['an empty list', { parents_read: [] }],
      ['null', { parents_read: null }],
      ['false', { parents_read: false }],
    ])('says that nothing was readable for parents_read of %s', async (_name, change) => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges: [], ...change }
      })
      expect((await score(w)).json.declared_ranges_cause).toBe('none_readable')
    })

    it('says that nothing was readable when parents_read is absent', async () => {
      const w = world((x) => {
        const { parents_read: _read, ...rest } = DECLARED
        x.script.declared = { ...rest, ranges: [] }
      })
      expect((await score(w)).json.declared_ranges_cause).toBe('none_readable')
    })

    // jq read a text by its characters, a number by its size and an object by
    // its keys, and stopped on `true`.
    it.each([
      ['a text', 'abc'],
      ['a number', 5],
      ['true', true],
      ['an object', { a: 1 }],
    ])('is a validate failure for parents_read of %s', async (_name, parents) => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges: [], parents_read: parents }
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain("'parents_read' that is not a list")
      expect(answer.json.detail).toContain(JSON.stringify(parents))
      // The report is in the state, because the bash wrote it first.
      expect(stateOf(w).risk).toEqual(RISK)
    })

    it('does not read parents_read when a range was read', async () => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, parents_read: 'abc' }
      })
      expect((await score(w)).status).toBe(0)
    })
  })

  describe('--before', () => {
    // F1's --before comes from the post-control-install baseline, so the delta
    // it measures is fix-attributable (#146).
    it('comes from the baseline on an ordinary fix', async () => {
      const w = world()
      const answer = await score(w)
      expect(flag(argvOf(w), '--before')).toBe('4.17.20')
      expect(answer.json.before).toBe('4.17.20')
    })

    // On a lockfile refresh, the refresh is the change, so the delta is its own.
    it('comes from the pre-drift snapshot on a lockfile-refresh', async () => {
      const w = world((x) => {
        x.state.action = 'lockfile-refresh'
      })
      await score(w)
      expect(flag(argvOf(w), '--before')).toBe('4.17.19')
    })

    it('needs the baseline on an ordinary fix, and not the pre-drift snapshot', async () => {
      const w = world((x) => {
        without(x, 'pre_drift')
      })
      expect((await score(w)).status).toBe(0)
    })

    it('needs the pre-drift snapshot on a lockfile-refresh, and not the baseline', async () => {
      const w = world((x) => {
        x.state.action = 'lockfile-refresh'
        without(x, 'baseline')
      })
      expect((await score(w)).status).toBe(0)
      const missing = world((x) => {
        x.state.action = 'lockfile-refresh'
        without(x, 'pre_drift')
      })
      const answer = await score(missing)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("no usable value for 'pre_drift'")
    })

    it('is the lowest version on the line, by the comparison of the adapter and not by text', async () => {
      const w = world((x) => {
        x.state.baseline = rv('4.17.9', '4.17.10')
      })
      await score(w)
      expect(flag(argvOf(w), '--before')).toBe('4.17.9')
    })

    // A package that is not in the pre-fix tree has no baseline, and the
    // scorer's own branch scores F1 as a major, which is the safe direction.
    it.each([
      ['a snapshot with present false', { ...rv(), present: false }],
      ['a snapshot with present of null', { ...rv('4.17.20'), present: null }],
      ['a snapshot with no version on this line', rv('3.10.1')],
    ])('is not given for %s', async (_name, baseline) => {
      const w = world((x) => {
        x.state.baseline = baseline
      })
      const answer = await score(w)
      expect(argvOf(w)).not.toContain('--before')
      expect(answer.json.before).toBeNull()
      expect(answer.status).toBe(0)
    })

    it('reads present as the text true, as jq did', async () => {
      const w = world((x) => {
        x.state.baseline = { ...rv('4.17.20'), present: 'true' }
      })
      await score(w)
      expect(flag(argvOf(w), '--before')).toBe('4.17.20')
    })

    // A version from another line is never put in its place (#76).
    it.each([
      ['no versions list', { present: true }],
      ['a versions list that is not a list', { present: true, versions: 'x' }],
      ['an entry with no version text', { present: true, versions: [{ version: 5 }] }],
    ])('is a validate failure for %s in the snapshot', async (_name, baseline) => {
      const w = world((x) => {
        x.state.baseline = baseline
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain("F1's --before cannot be stated")
      expect(argvOf(w)).toBeNull()
    })

    it.each([
      ['an adapter that fails', () => failed('compare: the stand-in has no answer')],
      ['an answer with no result', () => ok({ a: 'x', b: 'y' } as never)],
      ['a result that is not -1, 0 or 1', () => ok({ result: 2 } as never)],
    ])('is a validate failure for %s in a comparison', async (_name, compare) => {
      const w = world((x) => {
        x.state.baseline = rv('4.17.19', '4.17.20')
        x.script.compare = compare as never
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain('could not be compared for the 4.x line')
      expect(argvOf(w)).toBeNull()
    })

    it.each([
      ['a version that compares lower', -1, '4.17.20'],
      ['a version that compares equal', 0, '4.17.19'],
      ['a version that compares higher', 1, '4.17.19'],
    ])('keeps the lowest, for %s', async (_name, result, lowest) => {
      const w = world((x) => {
        x.state.baseline = rv('4.17.19', '4.17.20')
        x.script.compare = ((a: string, b: string) => {
          // The first compare is the post-fix list, which holds one version.
          return ok({ a, b, result, delta: 'none', major_distance: 0 })
        }) as never
      })
      await score(w)
      expect(flag(argvOf(w), '--before')).toBe(lowest)
    })
  })

  describe('--after', () => {
    // `lowest_on_line` is a comparison. Read by text, 4.17.9 sorts above
    // 4.17.10 and the answer comes back wrong.
    it('is the lowest version on the line, and not the lowest by text', async () => {
      const w = world((x) => {
        x.script.rv = rv('4.17.10', '4.17.9')
      })
      const answer = await score(w)
      expect(answer.json.resolved_version).toBe('4.17.9')
      expect(flag(argvOf(w), '--after')).toBe('4.17.9')
    })

    it('reads one version for each line of a version text', async () => {
      const w = world((x) => {
        x.script.rv = rv('4.17.21\n4.17.9\n')
      })
      expect((await score(w)).json.resolved_version).toBe('4.17.9')
    })

    // There is no fall back to the lowest version overall. That reported a
    // version from a major line that this group does not own (#76).
    it('fails rather than report a version from another line', async () => {
      const w = world((x) => {
        x.script.rv = rv('3.10.1')
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.stderr).toContain('no comparable 4.x version')
      expect(argvOf(w)).toBeNull()
    })

    it('fails for a comparison that cannot be read, and never gives an empty --after', async () => {
      const w = world((x) => {
        x.script.rv = rv('4.17.20', '4.17.21')
        x.script.compare = (() => failed('compare: no answer')) as never
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain('no comparable 4.x version')
      expect(argvOf(w)).toBeNull()
    })

    it('fails for a post-fix answer with no version list', async () => {
      const w = world((x) => {
        x.script.rv = { present: true }
      })
      expect(failure(await score(w))).toEqual(FAILURE)
      expect(argvOf(w)).toBeNull()
    })
  })

  describe('the adapter verbs after the fix', () => {
    it.each([
      [
        'resolved_versions',
        { rv: 'the lockfile could not be read' },
        'resolved_versions lodash failed after the fix: the lockfile could not be read',
      ],
      ['why', { why: 'npm explain failed' }, 'why lodash failed after the fix: npm explain failed'],
      [
        'declared_ranges',
        { declared: 'a manifest is gone' },
        'declared_ranges --line 4 lodash failed after the fix: a manifest is gone',
      ],
    ])('is a validate failure when %s fails', async (_name, failures, detail) => {
      const w = world((x) => {
        x.script.failures = failures
      })
      const answer = await score(w)
      expect(answer.json).toEqual({ status: 'failure', phase: 'validate', detail })
      expect(answer.status).toBe(3)
      expect(answer.stderr).toBe(`fix-group: validate failure: ${detail}`)
      expect(argvOf(w)).toBeNull()
    })

    // `detect` runs again for each verb, and its failure is the failure of
    // that verb.
    it.each([
      [1, 'resolved_versions lodash failed after the fix'],
      [2, 'why lodash failed after the fix'],
      [3, 'declared_ranges --line 4 lodash failed after the fix'],
    ])('is a validate failure when detect fails at call %i', async (call, detail) => {
      const w = world((x) => {
        x.script.failDetectAt = call
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain(detail)
      expect(answer.json.detail).toContain('the stand-in found no lockfile')
      expect(argvOf(w)).toBeNull()
    })

    // An adapter answering with nothing used to make `jq -n --argjson` die
    // with exit 2 and no stdout, and exit 2 is `needs_judgment`.
    it.each([
      ['resolved_versions', 'rv'],
      ['why', 'why'],
      ['declared_ranges', 'declared'],
    ] as const)('is a validate failure when %s answers with nothing', async (verb, key) => {
      const w = world((x) => {
        x.script[key] = null
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.stderr).toContain(`${verb}`)
      expect(answer.stderr).toContain('emitted no JSON object')
    })

    it.each([
      ['resolved_versions', 'rv', 'present', rv('4.17.21')],
      ['why', 'why', 'raw', WHY],
      ['declared_ranges', 'declared', 'ranges', DECLARED],
    ] as const)('is a validate failure when %s has no %s', async (_verb, key, field, answer) => {
      const w = world((x) => {
        x.script[key] = Object.fromEntries(
          Object.entries(answer).filter(([name]) => name !== field),
        )
      })
      const result = await score(w)
      expect(failure(result)).toEqual(FAILURE)
      expect(result.stderr).toContain(`no '${field}' field`)
    })

    it('is a validate failure when the baseline has no present field', async () => {
      const w = world((x) => {
        x.state.baseline = { versions: [] }
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.stderr).toContain(
        "the pre-fix resolved_versions snapshot emitted no 'present' field",
      )
    })

    it.each(['a text', 5, ['present']])(
      'is a validate failure when the baseline is %j',
      async (baseline) => {
        const w = world((x) => {
          x.state.baseline = baseline as JsonValue
        })
        const answer = await score(w)
        expect(failure(answer)).toEqual(FAILURE)
        expect(answer.stderr).toContain('emitted no JSON object')
      },
    )

    it('runs why under the package manager that the state gives', async () => {
      const w = world()
      await score(w)
      expect(w.whyRuns).toEqual(['stand-in explain'])
    })
  })

  describe('the why capture', () => {
    it('is a failure of the phase when it cannot be written', async () => {
      const w = world()
      mkdirSync(join(w.work, 'why-lodash.json.tmp'))
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toBe(
        `the why capture could not be written to ${w.work}/why-lodash.json, so the risk scorer has no --why-json to read.`,
      )
      expect(argvOf(w)).toBeNull()
    })

    it('needs a package_path, and stops with exit 1 after the first write', async () => {
      const w = world((x) => {
        without(x, 'package_path')
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("no usable value for 'package_path'")
      expect(stateOf(w).post_fix).toEqual(rv('4.17.21'))
      expect(w.verbs).toEqual(['resolved_versions'])
    })

    it.each(['', 5])('refuses a package_path of %j', async (path) => {
      const w = world((x) => {
        x.state.package_path = path
      })
      expect((await score(w)).status).toBe(1)
    })
  })

  describe('a write of the state that fails', () => {
    it.each([
      ['post_fix', (w: World) => blockState(w)],
      [
        'declared_post',
        (w: World) => {
          w.script.onWhy = () => blockState(w)
        },
      ],
      [
        'risk',
        (w: World) => {
          scorerHook(w, 'mkdir "$STATE_TMP"\n')
        },
      ],
    ])('stops with exit 1 at %s', async (_key, arrange) => {
      const w = world(arrange)
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(BLOCKED)
    })
  })

  describe('the scorer', () => {
    // A scorer that ran and failed is a phase failure, and not exit 1, which
    // is the usage and internal code of the driver.
    it('is a phase failure when it exits non-zero, with its stderr', async () => {
      const w = world()
      writeFileSync(
        join(w.scorerDir, 'err.txt'),
        'score-merge-risk.sh: adapter contract violation\n\n',
      )
      writeFileSync(join(w.scorerDir, 'status'), '1\n')
      const answer = await score(w)
      expect(answer.json).toEqual({
        status: 'failure',
        phase: 'validate',
        detail: 'score-merge-risk.sh failed: score-merge-risk.sh: adapter contract violation',
      })
      expect(answer.status).toBe(3)
      expect(stateOf(w).risk).toBeUndefined()
    })

    it('is a phase failure when a signal ends it', async () => {
      const w = world()
      scorerHook(w, 'kill -9 $$\n')
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toBe('score-merge-risk.sh failed: ')
    })

    it('is a phase failure when it does not start, with the error of node', async () => {
      const w = world((x) => {
        x.state.scorer = join(x.bin, 'missing-scorer.sh')
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain('score-merge-risk.sh failed: ')
      expect(answer.json.detail).toContain('ENOENT')
    })

    // A scorer that writes nothing, and one with JSON of the wrong shape.
    it.each([
      ['nothing', ''],
      ['white space', ' \n '],
      ['text that is not JSON', 'nope'],
      ['a list', '[{"band":"Low"}]'],
      ['a text', '"band"'],
      ['null', 'null'],
      ['an object with no band', '{"package":"lodash"}'],
      ['two objects', '{"band":1}{"band":2}'],
    ])('is a phase failure for %s on stdout', async (_name, text) => {
      const w = world()
      scorerOut(w, text)
      const answer = await score(w)
      expect(answer.json).toEqual({
        status: 'failure',
        phase: 'validate',
        detail: `score-merge-risk.sh returned no usable report: ${text.replace(/\n+$/, '')}`,
      })
      expect(answer.status).toBe(3)
      expect(stateOf(w).risk).toBeUndefined()
    })

    it('accepts a report with a band of null, as jq has("band") did', async () => {
      const w = world()
      scorerOut(w, '{"band":null}\n')
      const answer = await score(w)
      expect(pick(answer, 'risk')).toEqual({
        exit: 0,
        risk: {
          band: null,
          score: null,
          f4: null,
          f5: null,
          markdown: null,
          coverage: null,
          ci: null,
        },
      })
    })

    it('writes a number of the report as node reads it', async () => {
      const w = world()
      scorerOut(w, '{"band":"Low","score":1.0,"big":1E2}')
      const answer = await score(w)
      expect(answer.json.risk).toMatchObject({ score: 1 })
      expect(stateOf(w).risk).toEqual({ band: 'Low', score: 1, big: 100 })
    })
  })

  describe('the factors of the report', () => {
    const withFactors = (factors: unknown) => (w: World) =>
      scorerOut(w, JSON.stringify({ band: 'Low', factors }))

    it.each([
      ['absent', undefined, null, null],
      ['null', null, null, null],
      ['an empty list', [], null, null],
      ['a list with a null entry', [null, { id: 'F5', score: 2 }], null, 2],
      [
        'two entries for F4, so the first wins',
        [
          { id: 'F4', score: 2 },
          { id: 'F4', score: 0 },
        ],
        2,
        null,
      ],
      ['an F4 with no score', [{ id: 'F4' }, { id: 'F5', score: 1 }], null, 1],
      ['an F4 with a score of null', [{ id: 'F4', score: null }], null, null],
      ['an entry with no id', [{ score: 1 }], null, null],
    ])('reads F4 and F5 from %s', async (_name, factors, f4, f5) => {
      const w = world((x) => {
        scorerOut(
          x,
          JSON.stringify(factors === undefined ? { band: 'Low' } : { band: 'Low', factors }),
        )
      })
      const answer = await score(w)
      expect(pick(answer, 'risk').risk).toMatchObject({ f4, f5 })
    })

    // jq read a text, a number, `true` and `false` as no factors, an object by
    // its values, and stopped on a list with an entry of another type.
    it.each([
      ['a text', 'abc'],
      ['a number', 5],
      ['true', true],
      ['false', false],
      ['an object', { a: { id: 'F4', score: 2 } }],
      ['a list with a number', [1]],
      ['a list with a text', ['x']],
      ['a list with a boolean', [true]],
      ['a list with a list', [[]]],
    ])('is a validate failure for factors of %s', async (_name, factors) => {
      const w = world(withFactors(factors))
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain("'factors' that is neither null nor a list of objects")
      expect(answer.json.detail).toContain(JSON.stringify(factors))
    })

    it('passes markdown, coverage and ci on, and null when they are absent', async () => {
      const w = world()
      scorerOut(w, '{"band":"High","score":9,"markdown":"m","coverage":[1],"ci":false}')
      expect(pick(await score(w), 'risk').risk).toEqual({
        band: 'High',
        score: 9,
        f4: null,
        f5: null,
        markdown: 'm',
        coverage: [1],
        ci: false,
      })
    })
  })

  describe('the ranges that declared_ranges answers', () => {
    // jq read a text, a number, `true` and `false` as an empty list, and
    // each value of an object, and a null or a number in a list as text.
    it.each([
      ['a text', 'abc'],
      ['a number', 5],
      ['true', true],
      ['false', false],
      ['an object', { a: '^1' }],
      ['a list with null', [null]],
      ['a list with a number', ['^1', 5]],
      ['a list with a list', [['^1']]],
    ])('is a validate failure for ranges of %s', async (_name, ranges) => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges }
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain("'ranges' that is neither null nor a list of text")
      expect(answer.json.detail).toContain(JSON.stringify(ranges))
      expect(argvOf(w)).toBeNull()
      expect(stateOf(w).declared_post).toEqual({ ...DECLARED, ranges })
    })

    it('passes parents_unreadable and parents_malformed on as they are, and [] for null or absent', async () => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, parents_unreadable: ['a'], parents_malformed: null }
      })
      expect(pick(await score(w), 'parents_unreadable', 'parents_malformed')).toEqual({
        exit: 0,
        parents_unreadable: ['a'],
        parents_malformed: [],
      })
      const bare = world((x) => {
        const { parents_unreadable: _a, parents_malformed: _b, ...rest } = DECLARED
        x.script.declared = rest
      })
      expect(pick(await score(bare), 'parents_unreadable', 'parents_malformed')).toEqual({
        exit: 0,
        parents_unreadable: [],
        parents_malformed: [],
      })
    })
  })

  describe('a state that apply did not finish', () => {
    it.each([[undefined], [null], ['']])("asks for 'apply' when action is %j", async (action) => {
      const w = world((x) => {
        if (action === undefined) without(x, 'action')
        else x.state.action = action
      })
      const answer = await score(w)
      expect(answer).toMatchObject({ status: 1, json: { error: "score: run 'apply' first" } })
      expect(w.verbs).toEqual([])
    })

    // A true no-op is terminal at `apply`: there is no change to score (#34).
    it('refuses to score a run that apply ended as a no-op', async () => {
      const w = world((x) => {
        x.state.action = 'no-op'
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain('which is terminal')
      expect(w.verbs).toEqual([])
    })

    // jq gave the scorer the text of a number or a boolean as the action.
    it.each([[5], [true], [false], [[]], [{}]])('refuses an action of %j', async (action) => {
      const w = world((x) => {
        x.state.action = action as JsonValue
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("no usable value for 'action'")
      expect(answer.stderr).toContain('expected text')
      expect(w.verbs).toEqual([])
    })

    it.each(['override_scope', 'bare_override'])('needs %s to be text', async (key) => {
      for (const value of [undefined, null, '', 5, true, []]) {
        const w = world((x) => {
          if (value === undefined) without(x, key)
          else x.state[key] = value as JsonValue
        })
        const answer = await score(w)
        expect(answer.status).toBe(1)
        expect(answer.stderr).toContain(`no usable value for '${key}'`)
        expect(argvOf(w)).toBeNull()
      }
    })

    // `cmd_apply` writes `override_scope` and `apply_result` three statements
    // apart. A run that stops between them leaves one, and `null.written` is
    // `null` in jq, so `score` once reported ready_for_pr with no edit at all.
    it.each([
      ['apply_result', ['apply_result']],
      ['validate', ['validate']],
      ['observations_first', ['observations_first']],
      ['applied_parents and eligible_parents', ['applied_parents', 'eligible_parents']],
      ['drift_commit', ['drift_commit']],
    ])('refuses to report ready_for_pr when %s was never written', async (_name, keys) => {
      const w = world((x) => {
        without(x, ...keys)
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain('no usable value')
      expect(answer.json.status).toBeUndefined()
      expect(JSON.stringify(answer.json)).not.toContain('ready_for_pr')
      // The scorer ran, and the report is in the state, as in the bash.
      expect(argvOf(w)).not.toBeNull()
      expect(stateOf(w).risk).toEqual(RISK)
    })

    it.each([
      ['apply_result', 'apply_result'],
      ['validate', 'validate'],
      ['observations_first', 'observations_first'],
      ['drift_commit', 'drift_commit'],
    ])('refuses a state whose %s is null', async (_name, key) => {
      const w = world((x) => {
        x.state[key] = null
      })
      expect((await score(w)).status).toBe(1)
    })

    it('names the key of the two parent lists when neither has a value', async () => {
      const w = world((x) => {
        without(x, 'applied_parents', 'eligible_parents')
      })
      const answer = await score(w)
      expect(answer.stderr).toContain("no usable value for 'applied_parents // eligible_parents'")
    })

    // `.applied_parents // .eligible_parents`: a false or a null falls
    // through, and an empty list does not.
    it.each([
      ['an applied list', ['koa'], ['express'], ['koa']],
      ['an empty applied list', [], ['express'], []],
      ['a false applied value', false, ['express'], ['express']],
      ['a null applied value', null, ['express'], ['express']],
      ['an absent applied value', undefined, ['express'], ['express']],
      ['a false eligible value', false, false, false],
    ])('reads applied_parents for %s', async (_name, applied, eligible, expected) => {
      const w = world((x) => {
        if (applied === undefined) without(x, 'applied_parents')
        else x.state.applied_parents = applied
        x.state.eligible_parents = eligible
      })
      expect(pick(await score(w), 'applied_parents')).toEqual({
        exit: 0,
        applied_parents: expected,
      })
    })

    it('passes a drift_commit that is not a boolean on, as the bash did', async () => {
      const w = world((x) => {
        x.state.drift_commit = 'maybe'
      })
      expect(pick(await score(w), 'drift_commit')).toEqual({ exit: 0, drift_commit: 'maybe' })
    })

    it.each([
      ['a text', 'x'],
      ['a number', 5],
      ['a list', []],
      ['true', true],
    ])('is a validate failure when apply_result is %s', async (_name, value) => {
      const w = world((x) => {
        x.state.apply_result = value as JsonValue
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain('not JSON objects')
      expect(answer.json.detail).toContain(`apply_result: ${JSON.stringify(value)}`)
    })

    it('is a validate failure when validate is not an object', async () => {
      const w = world((x) => {
        x.state.validate = ['ok']
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain('validate: ["ok"]')
    })

    it('carries the install signals through to the report', async () => {
      const w = world((x) => {
        x.state.install_signals = ['pnpm_field_no_longer_read']
      })
      expect(pick(await score(w), 'install_signals')).toEqual({
        exit: 0,
        install_signals: ['pnpm_field_no_longer_read'],
      })
    })

    it.each([
      ['absent', undefined, []],
      ['null', null, []],
    ])('reads install_signals that is %s as none', async (_name, value, expected) => {
      const w = world((x) => {
        if (value === undefined) without(x, 'install_signals')
        else x.state.install_signals = value
      })
      expect(pick(await score(w), 'install_signals').install_signals).toEqual(expected)
    })

    // The bash passed any value on. Here the state must hold a list of text.
    it.each([['x'], [false], [[1]], [{}]])('refuses install_signals of %j', async (value) => {
      const w = world((x) => {
        x.state.install_signals = value as JsonValue
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("no usable value for 'install_signals'")
    })
  })

  describe('the fields of the stored apply result and validate report', () => {
    it('reads each field of apply_result, with [] for written, superseded_keys and observations', async () => {
      const w = world((x) => {
        x.state.apply_result = {}
      })
      expect(
        pick(
          await score(w),
          'written',
          'superseded_keys',
          'observations',
          'override_file',
          'alias_lookup',
          'lockfile_invalidated',
        ),
      ).toEqual({
        exit: 0,
        written: [],
        superseded_keys: [],
        observations: [],
        override_file: null,
        alias_lookup: null,
        lockfile_invalidated: null,
      })
    })

    it('reads null for written, as jq // does', async () => {
      const w = world((x) => {
        x.state.apply_result = { ...APPLY_RESULT, written: null, observations: false }
      })
      expect(pick(await score(w), 'written', 'observations')).toEqual({
        exit: 0,
        written: [],
        observations: [],
      })
    })

    it('has [] for requires_major_bump and null for other_line_moves when validate has neither', async () => {
      const w = world((x) => {
        x.state.validate = { ok: true }
      })
      expect(
        pick(await score(w), 'requires_major_bump', 'other_line_moves', 'benign_moves'),
      ).toEqual({ exit: 0, requires_major_bump: [], other_line_moves: null, benign_moves: [] })
    })

    it('keeps only the moves of the class benign_dedup', async () => {
      const moves: JsonValue[] = [
        { major: 3, class: 'benign_dedup' },
        { major: 2, class: 'fatal' },
        { major: 1 },
        null,
        5,
        'x',
        { major: 5, class: 'benign_dedup' },
      ]
      const w = world((x) => {
        x.state.validate = { ...VALIDATE, other_line_moves: moves, requires_major_bump: [{ a: 1 }] }
      })
      const answer = await score(w)
      expect(pick(answer, 'benign_moves', 'other_line_moves', 'requires_major_bump')).toEqual({
        exit: 0,
        benign_moves: [
          { major: 3, class: 'benign_dedup' },
          { major: 5, class: 'benign_dedup' },
        ],
        other_line_moves: moves,
        requires_major_bump: [{ a: 1 }],
      })
    })

    it.each([[{ a: { class: 'benign_dedup' } }], ['x'], [5]])(
      'gives no benign move for other_line_moves of %j',
      async (moves) => {
        const w = world((x) => {
          x.state.validate = { ...VALIDATE, other_line_moves: moves as JsonValue }
        })
        expect(pick(await score(w), 'benign_moves')).toEqual({ exit: 0, benign_moves: [] })
      },
    )
  })
})

// `env_prefix` reaches the adapter, the install and the scorer. The prefix
// logs the directory and its first argument. `score` runs no git command, so
// the git rows are for the other phases, and the end of this file runs them
// all.
describe('env_prefix reaches the scorer', () => {
  const prefixed = (extra: (w: World) => void = () => {}) =>
    world((w) => {
      const prefix = join(w.bin, 'prefix')
      writeFileSync(prefix, PREFIX)
      chmodSync(prefix, 0o755)
      w.env.PREFIX_LOG = join(w.work, 'prefix.log')
      writeFileSync(w.env.PREFIX_LOG, '')
      w.state.env_prefix = prefix
      extra(w)
    })

  const logOf = (w: World): string[] =>
    readFileSync(w.env.PREFIX_LOG as string, 'utf8')
      .split('\n')
      .filter((line) => line !== '')

  it('prepends the prefix to the scorer, from inside the worktree', async () => {
    const w = prefixed()
    expect((await score(w)).status).toBe(0)
    expect(logOf(w)).toContain(`${realpathSync(w.worktree)}|${w.scorer}`)
    expect(argvOf(w)).not.toBeNull()
  })

  it('prepends the prefix to the package manager that why starts', async () => {
    const w = prefixed()
    await score(w)
    expect(logOf(w)).toContain(`${realpathSync(w.worktree)}|npm`)
  })

  it('runs each child once, and puts the prefix in front of no directory change', async () => {
    const w = prefixed()
    await score(w)
    expect(logOf(w).filter((line) => line.endsWith('|cd'))).toEqual([])
    expect(logOf(w).map((line) => line.split('|')[1])).toEqual(['npm', w.scorer])
  })

  it('gives no prefix a bare scorer', async () => {
    const w = prefixed((x) => {
      x.state.env_prefix = ''
    })
    await score(w)
    expect(logOf(w)).toEqual([])
    expect(argvOf(w)).not.toBeNull()
  })

  it('splits the prefix on white space', async () => {
    const w = prefixed((x) => {
      x.state.env_prefix = `${join(x.bin, 'prefix')}  env  `
    })
    expect((await score(w)).status).toBe(0)
    expect(logOf(w).map((line) => line.split('|')[1])).toEqual(['env', 'env'])
  })

  it('refuses an env_prefix that is not text', async () => {
    const w = prefixed((x) => {
      x.state.env_prefix = 5
    })
    const answer = await score(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("no usable value for 'env_prefix'")
  })
})

// The real flow, through `setup`, `classify`, `baseline` and `apply`, with the
// real node adapter and the real scorer, and a prefix that logs each child.
describe('the whole run', () => {
  const NPM = `#!/bin/sh
case "$1" in
  install) git checkout -q -- package-lock.json ;;
  *) printf 'stand-in %s\\n' "$*" ;;
esac
`

  it('reaches ready_for_pr, and each child ran under the prefix', async () => {
    const sandbox = createSandbox()
    const fixtures = createGitFixtures(sandbox)
    const repo = fixtures.create(join(realpathSync(sandbox.path), 'r'))
    fixtures.importTree(repo, join(FIXTURES_ROOT, 'npm-ambient-drift'))
    fixtures.push(repo)
    const bin = sandbox.stubPath(sandbox.join('bin'))
    writeFileSync(join(bin, 'npm'), NPM)
    chmodSync(join(bin, 'npm'), 0o755)
    const prefix = join(bin, 'prefix')
    writeFileSync(prefix, PREFIX)
    chmodSync(prefix, 0o755)
    sandbox.env.PREFIX_LOG = sandbox.join('prefix.log')
    writeFileSync(sandbox.env.PREFIX_LOG, '')
    for (const role of ['AUTHOR', 'COMMITTER']) {
      sandbox.env[`GIT_${role}_NAME`] = 'Fixture'
      sandbox.env[`GIT_${role}_EMAIL`] = 'fixture@example.invalid'
    }
    const groupFile = sandbox.join('group.json')
    writeFileSync(
      groupFile,
      JSON.stringify({
        package: 'picomatch',
        ecosystem: 'npm',
        major_line: '2',
        highest_fixed_version: '2.3.9',
        branch_name: 'fix/dependabot-picomatch-2x',
        alerts: [{ number: 1, vulnerable_range: '< 2.3.9' }],
        sibling_alerts: [],
      }),
    )
    const work = join(repo, '.claude', 'worktrees', 'fix-dependabot-picomatch-2x')
    const step = async (args: string[]) =>
      answerOf(await fixGroup(context(sandbox.env, args), { spawn: run, route: selectAdapter }))
    const steps = [
      [
        'setup',
        '--group-json',
        groupFile,
        '--repo-root',
        repo,
        '--default-branch',
        'main',
        '--env-prefix',
        prefix,
      ],
      ['classify', '--work', work],
      ['baseline', '--work', work],
      ['apply', '--work', work],
    ]
    for (const args of steps) expect((await step(args)).status).toBe(0)
    const answer = await step(['score', '--work', work])
    expect(answer.status).toBe(0)
    expect(pick(answer, 'status', 'action', 'resolved_version', 'before')).toEqual({
      exit: 0,
      status: 'ready_for_pr',
      action: 'direct-update',
      resolved_version: '2.3.9',
      before: '2.3.9',
    })
    expect((answer.json.risk as Json).band).toMatch(/^(Low|Medium|High)$/)
    const log = readFileSync(sandbox.env.PREFIX_LOG, 'utf8').split('\n')
    const scorer = pluginFile('gh-security', 'scripts', 'common', 'score-merge-risk.sh')
    expect(log).toContain(`${join(work, 'fix')}|${scorer}`)
    expect(log.some((line) => line.endsWith('|git'))).toBe(true)
    expect(log.some((line) => line.endsWith('|npm'))).toBe(true)
  })
})
