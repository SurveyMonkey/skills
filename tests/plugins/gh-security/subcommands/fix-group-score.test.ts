// `gh-security fix-group score`. The seam is the exported handler, with the
// runner and the registry as parameters. These are the examples of
// `spec/fix_group_apply_spec.sh` that cover `score`, the examples of its
// `env_prefix` block, and the branches that only the port has.
//
// `score` reads the state that `apply` wrote and runs no git command. So each
// example writes that state by hand, in a directory that has the lockfile of
// a worktree, and the real flow is one example at the end. The adapter is the
// real node adapter with `why`, `declared_ranges` and `resolved_versions`
// replaced by written answers (`mocking.md`, "The injected collaborator").
// `compare_versions` and `range_facts` are the real ones. The scorer runs in
// process on the worktree, a copy of the npm-v3 specimen (#233). The package
// manager is a stand-in on PATH. The expected values come from the contract
// in the header of `fix-group.ts`, from jq probes of the bash lines, and, for
// the risk report, from `score-merge-risk.sh` on the same inputs.
// `parity-fix-group-score.test.ts` compares the port with `fix-group.sh`.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'

vi.setConfig({ testTimeout: 60_000 })

type Json = Record<string, JsonValue>

/** The stand-in package manager. Only the prefix log can tell a call apart. */
const FAKE_PM = `#!/bin/sh
printf 'stand-in %s\\n' "$*"
`

/** The prefix of `env_prefix`. It logs the directory and its first argument. */
const PREFIX = `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$1" >> "$PREFIX_LOG"
exec "$@"
`

/**
 * The report of `score-merge-risk.sh` on the base state: lodash 4.17.20 to
 * 4.17.21 on the npm-v3 tree, a transitive under express, a scoped override,
 * and the range ^4.17.20.
 */
const RISK: Json = {
  package: 'lodash',
  score: 3,
  max: 14,
  band: 'Low',
  escalated: false,
  escalation_reason: null,
  delta: 'patch',
  majors_crossed: 0,
  declared_ranges: ['^4.17.20'],
  override_scope: 'scoped',
  coverage: { affected: 0, covered: 0, uncovered: [] },
  ci: { workflow: null, trigger: null, step: null },
  factors: [
    { id: 'F1', name: 'Version delta', score: 0, evidence: '4.17.20 -> 4.17.21 (patch)' },
    {
      id: 'F2',
      name: 'Runtime exposure',
      score: 1,
      evidence: 'transitive under a runtime dependency',
    },
    {
      id: 'F3',
      name: 'Usage surface',
      score: 0,
      evidence: 'no source imports found for parents of lodash (build or tooling only)',
    },
    {
      id: 'F4',
      name: 'Test coverage',
      score: 0,
      evidence: 'no source imports; a build script exists, so a broken tooling pin fails at build',
    },
    {
      id: 'F5',
      name: 'CI presence',
      score: 2,
      evidence:
        'no GitHub Actions workflow triggers on this pull request; another CI vendor is not read',
    },
    {
      id: 'F6',
      name: 'Override blast radius',
      score: 0,
      evidence: 'scoped override: only the dependency paths that carried the alerts are pinned',
    },
    {
      id: 'F7',
      name: 'Declared-range distance',
      score: 0,
      evidence: 'no major line crossed; dependents declare ^4.17.20',
    },
  ],
  markdown:
    '## Merge risk: \u{1F7E2} Low (3/14)\n\n| Factor | Score | Evidence |\n|---|---|---|\n' +
    '| Version delta | 0 | 4.17.20 -> 4.17.21 (patch) |\n' +
    '| Runtime exposure | 1 | transitive under a runtime dependency |\n' +
    '| Usage surface | 0 | no source imports found for parents of lodash (build or tooling only) |\n' +
    '| Test coverage | 0 | no source imports; a build script exists, so a broken tooling pin fails at build |\n' +
    '| CI presence | 2 | no GitHub Actions workflow triggers on this pull request; another CI vendor is not read |\n' +
    '| Override blast radius | 0 | scoped override: only the dependency paths that carried the alerts are pinned |\n' +
    '| Declared-range distance | 0 | no major line crossed; dependents declare ^4.17.20 |\n',
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
  readonly bin: string
  readonly state: Json
  readonly whyRuns: string[]
  detects: number
  verbs: string[]
}

/** The state that `apply` leaves, as `score` reads it. */
const baseState = (work: string, worktree: string): Json => ({
  group: { package: 'lodash', major_line: '4' },
  repo_root: '/repo',
  default_branch: 'main',
  adapter: 'node',
  ecosystem: 'npm',
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
    bin,
    state: baseState(work, worktree),
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
      resolvedVersions: (_tree, pkg) => {
        w.verbs.push(`resolved_versions ${pkg}`)
        const message = w.script.failures.rv
        return message === undefined ? ok(w.script.rv as never) : failed(message)
      },
      why: async (_tree, pkg, source) => {
        w.verbs.push(`why ${pkg}`)
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
      declaredRanges: (_tree, pkg, line) => {
        w.verbs.push(`declared_ranges ${pkg} ${String(line)}`)
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

/** The report that the scorer left in the state, or undefined when it never ran. */
const riskOf = (w: World): Json | undefined => stateOf(w).risk as Json | undefined

/** The evidence of F1 in the report: `<before> -> <after> (...)`, or the no-baseline text. */
const deltaOf = (w: World): string | undefined =>
  ((riskOf(w)?.factors as Json[] | undefined)?.[0] as Json | undefined)?.evidence as
    | string
    | undefined

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
          f5: 2,
          markdown: RISK.markdown,
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
    expect(w.verbs).toEqual(['resolved_versions lodash', 'why lodash', 'declared_ranges lodash 4'])
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

  // The scorer runs in process (#233, ruling 9). Its input is what the bash
  // gave as flags, so each example reads that input back from the report.
  describe('what the scorer is given', () => {
    it('is the input of the bash: package, versions, scope and ranges', async () => {
      const w = world()
      await score(w)
      expect(riskOf(w)).toEqual(RISK)
    })

    it('reads the worktree as the tree to score', async () => {
      const w = world()
      rmSync(join(w.worktree, 'package.json'))
      const answer = await score(w)
      expect(answer.json).toEqual({
        status: 'failure',
        phase: 'validate',
        detail: `score-merge-risk.sh failed: ${JSON.stringify({
          error:
            `no package.json in ${w.worktree}. The scorer runs from the root of the tree being ` +
            'scored, and F3 and F4 read the manifest there; without it the fix would score as a ' +
            'repository that declares no scripts.',
        })}`,
      })
    })

    // A stat of a link to itself throws ELOOP. `[ -f package.json ]` was false
    // there, so the bash scorer failed, and the driver put it in this phase.
    it('puts a scorer that throws in the validate phase', async () => {
      const w = world()
      rmSync(join(w.worktree, 'package.json'))
      symlinkSync('package.json', join(w.worktree, 'package.json'))
      const answer = await score(w)
      expect(answer.json).toMatchObject({ status: 'failure', phase: 'validate' })
      expect((answer.json as { detail: string }).detail).toMatch(
        /^score-merge-risk\.sh failed: \{"error":".*ELOOP/,
      )
    })

    // A state that a version with `--scorer` wrote still has the key. It is
    // not read: the scorer is in process.
    it('ignores a scorer that an older state names', async () => {
      const w = world((x) => {
        x.state.scorer = join(x.bin, 'missing-scorer.sh')
      })
      expect((await score(w)).status).toBe(0)
      expect(riskOf(w)).toEqual(RISK)
    })

    // The widest shape that apply wrote is the override scope.
    it.each(['none', 'scoped', 'bare-tightened', 'bare-added'])(
      'reports the override scope %s',
      async (scope) => {
        const w = world((x) => {
          x.state.override_scope = scope
        })
        const answer = await score(w)
        expect(riskOf(w)?.override_scope).toBe(scope)
        expect(answer.json.override_scope).toBe(scope)
      },
    )

    // The adapter makes the list distinct and sorts it. `score` gives each
    // range on, in the order it has, as `jq -r '.ranges[]?'` did.
    it.each([
      [
        ['^4.17.20', '~4.17.0'],
        ['^4.17.20', '~4.17.0'],
      ],
      [
        ['~4.17.0', '^4.17.20'],
        ['~4.17.0', '^4.17.20'],
      ],
      [['^4.17.20', '^4.17.20'], ['^4.17.20']],
    ])('gives the ranges of %j to the scorer, in order', async (ranges, scored) => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges }
      })
      await score(w)
      expect(riskOf(w)?.declared_ranges).toEqual(scored)
    })

    it('splits a range with a newline into one range for each line, and drops empty lines', async () => {
      const w = world((x) => {
        x.script.declared = { ...DECLARED, ranges: ['^4.17.20\n~4.17.0\n', ''] }
      })
      await score(w)
      expect(riskOf(w)?.declared_ranges).toEqual(['^4.17.20', '~4.17.0'])
    })

    // The ranges are required, with an explicit `none` sentinel: optional,
    // their absence made the multi-major escalation unreachable.
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
      expect(riskOf(w)?.declared_ranges).toBe('none-stated')
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
    it.each([[['express']], [['express', 'koa']], [['express', 'koa', 'hapi']]])(
      'says that parents declared nothing when parents were read: %j',
      async (read) => {
        const w = world((x) => {
          x.script.declared = { ...DECLARED, ranges: [], parents_read: read }
        })
        expect(pick(await score(w), 'declared_ranges_cause')).toEqual({
          exit: 0,
          declared_ranges_cause: 'parents_declared_nothing',
        })
      },
    )

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
      expect(riskOf(w)?.declared_ranges).toBe('none-stated')
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
      expect(deltaOf(w)).toBe('4.17.20 -> 4.17.21 (patch)')
      expect(answer.json.before).toBe('4.17.20')
    })

    // On a lockfile refresh, the refresh is the change, so the delta is its own.
    it('comes from the pre-drift snapshot on a lockfile-refresh', async () => {
      const w = world((x) => {
        x.state.action = 'lockfile-refresh'
      })
      await score(w)
      expect(deltaOf(w)).toBe('4.17.19 -> 4.17.21 (patch)')
    })

    it.each(['bare-override', 'direct-update', 'scoped-override'])(
      'comes from the baseline for the action %s',
      async (action) => {
        const w = world((x) => {
          x.state.action = action
        })
        await score(w)
        expect(deltaOf(w)).toBe('4.17.20 -> 4.17.21 (patch)')
      },
    )

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
      expect(deltaOf(w)).toBe('4.17.9 -> 4.17.21 (patch)')
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
      expect(deltaOf(w)).toBe('no pre-fix baseline available; scored as major')
      expect(answer.json.before).toBeNull()
      expect(answer.status).toBe(0)
    })

    it('reads present as the text true, as jq did', async () => {
      const w = world((x) => {
        x.state.baseline = { ...rv('4.17.20'), present: 'true' }
      })
      await score(w)
      expect(deltaOf(w)).toBe('4.17.20 -> 4.17.21 (patch)')
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
      expect(riskOf(w)).toBeUndefined()
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
      expect(riskOf(w)).toBeUndefined()
    })

    it.each([
      ['a version that compares lower', -1, '4.17.20'],
      ['a version that compares equal', 0, '4.17.19'],
      ['a version that compares higher', 1, '4.17.19'],
    ])('keeps the lowest, for %s', async (_name, result, lowest) => {
      const w = world((x) => {
        x.state.baseline = rv('4.17.19', '4.17.20')
        x.script.compare = ((a: string, b: string) => {
          // The post-fix list has one version, so only the baseline is compared.
          return ok({ a, b, result, delta: 'none', major_distance: 0 })
        }) as never
      })
      await score(w)
      expect(deltaOf(w)).toBe(`${lowest} -> 4.17.21 (none)`)
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
      // 4.17.9 is below the floor of ^4.17.20, so the range is one it escapes.
      expect(deltaOf(w)).toBe('4.17.20 -> 4.17.9 (patch; parents declare ^4.17.20)')
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
      expect(riskOf(w)).toBeUndefined()
    })

    it('fails for a comparison that cannot be read, and never gives an empty --after', async () => {
      const w = world((x) => {
        x.script.rv = rv('4.17.20', '4.17.21')
        x.script.compare = (() => failed('compare: no answer')) as never
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toContain('no comparable 4.x version')
      expect(riskOf(w)).toBeUndefined()
    })

    it('fails for a post-fix answer with no version list', async () => {
      const w = world((x) => {
        x.script.rv = { present: true }
      })
      expect(failure(await score(w))).toEqual(FAILURE)
      expect(riskOf(w)).toBeUndefined()
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
      expect(riskOf(w)).toBeUndefined()
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
      expect(riskOf(w)).toBeUndefined()
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
      expect(riskOf(w)).toBeUndefined()
    })

    it('needs a package_path, and stops with exit 1 after the first write', async () => {
      const w = world((x) => {
        without(x, 'package_path')
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("no usable value for 'package_path'")
      expect(stateOf(w).post_fix).toEqual(rv('4.17.21'))
      expect(w.verbs).toEqual(['resolved_versions lodash'])
    })

    it.each(['', 5])('refuses a package_path of %j', async (path) => {
      const w = world((x) => {
        x.state.package_path = path
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("no usable value for 'package_path'")
    })
  })

  describe('a write of the state that fails', () => {
    it.each([
      ['post_fix', (w: World) => blockState(w), ['resolved_versions lodash'], false],
      [
        'declared_post',
        (w: World) => {
          w.script.onWhy = () => blockState(w)
        },
        ['resolved_versions lodash', 'why lodash', 'declared_ranges lodash 4'],
        false,
      ],
      [
        'risk',
        // The first comparison of the scorer is the last thing before the write.
        (w: World) => {
          w.script.compare = (a, b) => {
            blockState(w)
            return node.compareVersions(a, b)
          }
        },
        ['resolved_versions lodash', 'why lodash', 'declared_ranges lodash 4'],
        true,
      ],
    ])('stops with exit 1 at %s, and does nothing after it', async (_key, arrange, verbs, ran) => {
      const w = world(arrange)
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(BLOCKED)
      expect(w.verbs).toEqual(verbs)
      // The scorer runs after declared_post is written, and before risk is.
      expect(stateOf(w).declared_post !== undefined).toBe(ran)
    })
  })

  describe('the scorer', () => {
    // A scorer that fails is a phase failure, and not exit 1, which is the
    // usage and internal code of the driver. The detail is the text the bash
    // gave: the name of the script, and its JSON error.
    it('is a phase failure when it refuses the override scope, with its error', async () => {
      const w = world((x) => {
        x.state.override_scope = 'wide'
      })
      const answer = await score(w)
      expect(answer.json).toEqual({
        status: 'failure',
        phase: 'validate',
        detail:
          'score-merge-risk.sh failed: {"error":"--override-scope must be none, scoped, bare-tightened, or bare-added"}',
      })
      expect(answer.status).toBe(3)
      expect(riskOf(w)).toBeUndefined()
    })

    it('is a phase failure when the adapter breaks the contract under it', async () => {
      const w = world((x) => {
        x.script.compare = (a, b) =>
          a === '4.17.20' && b === '4.17.21' ? ok({} as never) : node.compareVersions(a, b)
      })
      const answer = await score(w)
      expect(failure(answer)).toEqual(FAILURE)
      expect(answer.json.detail).toMatch(
        /^score-merge-risk\.sh failed: \{"error":"adapter node: compare_versions '4\.17\.20' '4\.17\.21' emitted no usable 'delta'\./,
      )
    })

    it('reads F4 and F5 from the factors of the report', async () => {
      const answer = await score(world())
      expect(answer.json.risk).toMatchObject({ f4: 0, f5: 2 })
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
      expect(riskOf(w)).toBeUndefined()
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

    // jq gave the report the text of a number or a boolean as the action.
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

    it.each(
      ['override_scope', 'bare_override'].flatMap((key) =>
        [undefined, null, '', 5, true, []].map((value) => [key, value] as const),
      ),
    )('needs %s to be text, not %j', async (key, value) => {
      const w = world((x) => {
        if (value === undefined) without(x, key)
        else x.state[key] = value as JsonValue
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(`no usable value for '${key}'`)
      expect(riskOf(w)).toBeUndefined()
    })

    // `cmd_apply` writes `override_scope` and `apply_result` a few statements
    // apart. A run that stops between them leaves one, and `null.written` is
    // `null` in jq, so `score` once reported ready_for_pr with no edit at all.
    it.each([
      ['apply_result', ['apply_result'], 'apply_result'],
      ['validate', ['validate'], 'validate'],
      ['observations_first', ['observations_first'], 'observations_first'],
      [
        'applied_parents and eligible_parents',
        ['applied_parents', 'eligible_parents'],
        'applied_parents // eligible_parents',
      ],
      ['drift_commit', ['drift_commit'], 'drift_commit'],
    ])('refuses to report ready_for_pr when %s was never written', async (_name, keys, shown) => {
      const w = world((x) => {
        without(x, ...keys)
      })
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(`no usable value for '${shown}'`)
      expect(answer.json.status).toBeUndefined()
      expect(JSON.stringify(answer.json)).not.toContain('ready_for_pr')
      // The scorer ran, and the report is in the state, as in the bash.
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
      const answer = await score(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(`no usable value for '${key}'`)
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
      ['a zero applied value', 0, ['express'], 0],
      ['an empty text applied value', '', ['express'], ''],
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

    it('keeps the three lists of the stored results apart', async () => {
      const w = world((x) => {
        x.state.observations_first = ['before']
        x.state.apply_result = {
          ...APPLY_RESULT,
          superseded_keys: ['old'],
          observations: ['after'],
        }
      })
      expect(
        pick(await score(w), 'observations_pre_fix', 'superseded_keys', 'observations'),
      ).toEqual({
        exit: 0,
        observations_pre_fix: ['before'],
        superseded_keys: ['old'],
        observations: ['after'],
      })
    })

    // jq `//` reads false as absent, and a `??` does not.
    it.each([
      ['apply_result', 'written'],
      ['apply_result', 'superseded_keys'],
      ['apply_result', 'observations'],
      ['validate', 'requires_major_bump'],
      ['declared', 'parents_unreadable'],
      ['declared', 'parents_malformed'],
    ])('reads %s with %s of false as none', async (source, key) => {
      const w = world((x) => {
        if (source === 'declared') x.script.declared = { ...DECLARED, [key]: false }
        else if (source === 'validate') x.state.validate = { ...VALIDATE, [key]: false }
        else x.state.apply_result = { ...APPLY_RESULT, [key]: false }
      })
      expect(pick(await score(w), key)).toEqual({ exit: 0, [key]: [] })
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

// `env_prefix` reaches the package manager that `why` starts. The scorer runs
// in process, so it is no child and has no prefix (#233). The prefix logs
// the directory and its first argument. `score` runs no git command, so the
// git rows are for the other phases, and the end of this file runs them all.
describe('env_prefix in score', () => {
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

  it('prepends the prefix to the package manager that why starts', async () => {
    const w = prefixed()
    await score(w)
    expect(logOf(w)).toContain(`${realpathSync(w.worktree)}|npm`)
  })

  it('runs each child once, and puts the prefix in front of no directory change', async () => {
    const w = prefixed()
    await score(w)
    expect(logOf(w).filter((line) => line.endsWith('|cd'))).toEqual([])
    expect(logOf(w).map((line) => line.split('|')[1])).toEqual(['npm'])
  })

  it('gives no prefix to a package manager when the state has none, and still scores', async () => {
    const w = prefixed((x) => {
      x.state.env_prefix = ''
    })
    await score(w)
    expect(logOf(w)).toEqual([])
    expect(riskOf(w)).toEqual(RISK)
  })

  it('splits the prefix on white space', async () => {
    const w = prefixed((x) => {
      x.state.env_prefix = `${join(x.bin, 'prefix')}  env  `
    })
    expect((await score(w)).status).toBe(0)
    expect(logOf(w).map((line) => line.split('|')[1])).toEqual(['env'])
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
// real node adapter and the scorer in process, and a prefix that logs the
// children that the driver starts: git and the package manager.
describe('the whole run', () => {
  const NPM = `#!/bin/sh
case "$1" in
  install) git checkout -q -- package-lock.json ;;
  *) printf 'stand-in %s\\n' "$*" ;;
esac
`

  it('reaches ready_for_pr, and git and the package manager ran under the prefix', async () => {
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
    // The scorer is no child: git and the package manager are the only ones.
    expect([
      ...new Set(log.filter((line) => line !== '').map((line) => line.split('|')[1])),
    ]).toEqual(['git', 'npm'])
    expect(log.some((line) => line.endsWith('|git'))).toBe(true)
    expect(log.some((line) => line.endsWith('|npm'))).toBe(true)
  })
})
