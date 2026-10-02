// `gh-security fix-group apply`. The seam is the exported handler, with the
// runner and the registry as parameters. These are the examples of
// `spec/fix_group_apply_spec.sh` that cover `apply`, and the branches that
// only the port has. The examples of `score` in that file are for layer B3.
//
// As in the bash spec, the adapter is a stand-in that gives a written
// answer for each call, and records each call. It comes through the
// registry parameter (`mocking.md`, "The injected collaborator"). It is the
// real node adapter, with `why`, `declared_ranges`, `resolved_versions`,
// `apply_constraint` and `validate` replaced. `install` is real. `detect`
// is real too, with a count of its calls and a failure that an example can
// put at one call. The package manager is a stand-in on PATH, because an install
// reaches the network. git is real: each example runs in a repository with a
// bare origin from `harness/git.ts`. The expected values are written by hand
// from the contract in the header of `fix-group.ts`.
// `parity-fix-group-apply.test.ts` compares the port with `fix-group.sh` on
// the real adapter.
import {
  chmodSync,
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
import type { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, failed, type JsonValue, ok } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { fixGroup, fixGroupCommand } from '#gh-security/subcommands/fix-group.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'

// Each example makes a repository and runs git many times.
vi.setConfig({ testTimeout: 60_000 })

type Json = Record<string, JsonValue>

/**
 * The stand-in package manager. It counts its installs in `PM_DIR`. For
 * install <n> it runs `install.<n>.sh`, or else `install.sh`, and exits with
 * `install.<n>.status`, or else `install.status`, or else 0.
 */
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

/** The group of the bash spec: two alerts with one range, and `sibling_alerts`. */
const group = (siblings: JsonValue | 'absent' = []): Json => ({
  package: 'lodash',
  ecosystem: 'npm',
  major_line: '4',
  highest_fixed_version: '4.17.21',
  branch_name: 'fix/dependabot-lodash-4x',
  alerts: [
    { number: 1, vulnerable_range: '< 4.17.21' },
    { number: 2, vulnerable_range: '< 4.17.21' },
  ],
  ...(siblings === 'absent' ? {} : { sibling_alerts: siblings }),
})

const rv = (...versions: string[]): Json => ({
  pm: 'npm',
  package: 'lodash',
  present: true,
  count: versions.length,
  versions: versions.map((version) => ({ version, path: 'node_modules/lodash' })),
  lockfile_entries: 3,
})

const SCOPED = [
  { parent: 'express', path: ['overrides', 'express', 'lodash'], value: '>=4.17.21 <5' },
]

const applyAnswer = (written: JsonValue = SCOPED, observations: JsonValue = []): Json => ({
  pm: 'npm',
  package: 'lodash',
  range: '>=4.17.21 <5',
  override_location: 'overrides',
  override_file: 'package.json',
  mode: 'scoped',
  parents: ['express'],
  written,
  superseded_keys: [],
  alias_lookup: { source: 'lockfile', parents_unresolved: [] },
  lockfile_invalidated: { performed: true, keys: ['node_modules/lodash'] },
  observations,
})

const validateAnswer = (
  passed: boolean,
  violations: JsonValue = [],
  moves: JsonValue = [],
): Json => ({
  ok: passed,
  package: 'lodash',
  range: '>=4.17.21 <5',
  line: '4',
  line_present: true,
  checked: 1,
  resolved_count: 1,
  violations,
  unresolved_alerts: [],
  requires_major_bump: [],
  other_line_moves: moves,
  resolved_versions: ['4.17.21'],
})

/** A violation at one path. */
const at = (path: JsonValue): Json[] => [{ version: '4.17.20', path }]

/** What the stand-in adapter answers. Each list is by call, from call 1. */
interface Script {
  why: Json
  declared: Json
  rv: Json[]
  /** An answer, or `{ error }` for a verb that fails. */
  apply: Json[]
  applyFallback: Json
  validate: Json[]
  validateFallback: Json | null
  /** Run a side effect on the named call of a verb, before it answers. */
  on: Partial<Record<'apply' | 'validate', Record<number, () => void>>>
  /** The call of `detect`, counted from the start of `apply`, that fails. */
  failDetectAt: number | null
}

const script = (): Script => ({
  why: {
    pm: 'npm',
    package: 'lodash',
    relationship: 'transitive',
    dev_only: false,
    parents: ['express'],
    parent_count: 1,
    peer_only: false,
    peer_parents: [],
    optional_peer_parents: [],
    raw: 'lodash@4.17.20',
  },
  declared: {
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
  },
  // The snapshot before the drift, then the baseline after it.
  rv: [rv('4.17.20'), rv('4.17.20')],
  apply: [applyAnswer()],
  applyFallback: applyAnswer(),
  validate: [validateAnswer(true)],
  validateFallback: null,
  on: {},
  failDetectAt: null,
})

interface Call {
  readonly verb: 'apply' | 'validate'
  readonly request: JsonValue
}

interface World {
  readonly script: Script
  readonly calls: Call[]
  readonly env: NodeJS.ProcessEnv
  readonly pmDir: string
  readonly work: string
  readonly worktree: string
  readonly groupFile: string
  readonly repo: string
  readonly bin: string
  readonly fixtures: ReturnType<typeof createGitFixtures>
  /** True from the start of `apply`, so that `failDetectAt` counts from there. */
  applying: boolean
  detects: number
}

const world = (payload: Json = group()): World => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const repo = fixtures.create(join(realpathSync(sandbox.path), 'r'))
  fixtures.importTree(repo, join(FIXTURES_ROOT, 'npm-v3'))
  fixtures.push(repo)
  const bin = sandbox.stubPath(sandbox.join('bin'))
  writeFileSync(join(bin, 'npm'), FAKE_PM)
  chmodSync(join(bin, 'npm'), 0o755)
  const pmDir = sandbox.join('pm')
  mkdirSync(pmDir)
  sandbox.env.PM_DIR = pmDir
  for (const role of ['AUTHOR', 'COMMITTER']) {
    sandbox.env[`GIT_${role}_NAME`] = 'Fixture'
    sandbox.env[`GIT_${role}_EMAIL`] = 'fixture@example.invalid'
  }
  const groupFile = sandbox.join('group.json')
  writeFileSync(groupFile, JSON.stringify(payload))
  const work = join(repo, '.claude', 'worktrees', 'fix-dependabot-lodash-4x')
  // Each install rewrites the lockfile: the control install makes a drift
  // commit, and the fix install a change to the diff.
  writeFileSync(
    join(pmDir, 'install.sh'),
    'printf \'{"lockfileVersion":3,"n":%s}\\n\' "$n" > package-lock.json\n',
  )
  return {
    script: script(),
    calls: [],
    env: sandbox.env,
    pmDir,
    work,
    worktree: join(work, 'fix'),
    groupFile,
    repo,
    bin,
    fixtures,
    applying: false,
    detects: 0,
  }
}

/** The answer of a call by its number, or the last of the list, or the fallback. */
const nth = (list: Json[], n: number, fallback: Json | null): Json | null => list[n - 1] ?? fallback

/** The registry, with the stand-in adapter of the world. */
const route = (w: World): typeof selectAdapter => {
  const counts = { rv: 0, apply: 0, validate: 0 }
  const adapter: Adapter<NodeDetection> = {
    ...node,
    detect: (root, env) => {
      if (w.applying) w.detects += 1
      if (w.script.failDetectAt !== null && w.detects === w.script.failDetectAt) {
        return failed('detect: the stand-in found no lockfile')
      }
      return node.detect(root, env)
    },
    why: async () => ok(w.script.why as never),
    declaredRanges: () => ok(w.script.declared as never),
    resolvedVersions: () => {
      counts.rv += 1
      return ok(nth(w.script.rv, counts.rv, w.script.rv.at(-1) as Json) as never)
    },
    applyConstraint: (_tree, request) => {
      counts.apply += 1
      w.calls.push({ verb: 'apply', request: request as unknown as JsonValue })
      w.script.on.apply?.[counts.apply]?.()
      const answer = nth(w.script.apply, counts.apply, w.script.applyFallback) as Json
      return 'error' in answer ? failed(String(answer.error)) : ok(answer as never)
    },
    validate: (_tree, pkg, range, options) => {
      counts.validate += 1
      w.calls.push({
        verb: 'validate',
        request: { pkg, range, ...options } as unknown as JsonValue,
      })
      w.script.on.validate?.[counts.validate]?.()
      const answer = nth(w.script.validate, counts.validate, w.script.validateFallback)
      if (answer === null) return failed('validate: the stand-in has no answer for this call')
      if ('error' in answer) return failed(String(answer.error))
      return ok(answer as never)
    },
  }
  return ((ecosystem: string) => ({
    supported: true,
    ecosystem,
    name: 'node',
    adapter,
    manifest: null,
  })) as typeof selectAdapter
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

/** One adapter route for the whole example, so that the call counts go on. */
const routes = new WeakMap<World, typeof selectAdapter>()

const call = async (w: World, args: readonly string[], env = w.env): Promise<Answer> => {
  let routed = routes.get(w)
  if (routed === undefined) {
    routed = route(w)
    routes.set(w, routed)
  }
  return answerOf(await fixGroup(context(env, args), { spawn: run, route: routed }))
}

const setupOnly = async (w: World, ...extra: string[]): Promise<void> => {
  const answer = await call(w, [
    'setup',
    '--group-json',
    w.groupFile,
    '--repo-root',
    w.repo,
    '--default-branch',
    'main',
    ...extra,
  ])
  expect(answer.status).toBe(0)
}

const classify = async (w: World): Promise<void> => {
  expect((await call(w, ['classify', '--work', w.work])).status).toBe(0)
}

const throughBaseline = async (w: World, ...extra: string[]): Promise<void> => {
  await setupOnly(w, ...extra)
  await classify(w)
  expect((await call(w, ['baseline', '--work', w.work])).status).toBe(0)
}

const apply = (w: World, env = w.env): Promise<Answer> => {
  w.applying = true
  w.detects = 0
  return call(w, ['apply', '--work', w.work], env)
}

/** A world through `baseline`, ready for `apply`. */
const ready = async (edit: (s: Script) => void = () => {}, payload?: Json): Promise<World> => {
  const w = world(payload)
  edit(w.script)
  await throughBaseline(w)
  return w
}

/** A projection of an answer: the exit status, and the named keys of its JSON. */
const pick = (answer: Answer, ...keys: string[]) => ({
  exit: answer.status,
  ...Object.fromEntries(keys.map((key) => [key, answer.json[key] ?? null])),
})

const stateOf = (w: World): Json =>
  JSON.parse(readFileSync(join(w.work, 'state.json'), 'utf8')) as Json

const editState = (w: World, edit: (state: Json) => void): void => {
  const state = stateOf(w)
  edit(state)
  writeFileSync(join(w.work, 'state.json'), JSON.stringify(state))
}

const installs = (w: World): number => Number(readFileSync(join(w.pmDir, 'install.n'), 'utf8'))

const callsOf = (w: World, verb: Call['verb']): Json[] =>
  w.calls.filter((entry) => entry.verb === verb).map((entry) => entry.request as Json)

/** An install script for one install. */
const install = (w: World, n: number, body: string, status = 0): void => {
  writeFileSync(join(w.pmDir, `install.${n}.sh`), body)
  writeFileSync(join(w.pmDir, `install.${n}.status`), `${status}\n`)
}

/** A directory where the state's temporary file goes, so the next write fails. */
const blockState = (w: World) => (): void => {
  mkdirSync(join(w.work, 'state.json.tmp'))
}

const BLOCKED = 'cannot write the state file'

describe('the command', () => {
  it('names apply in its usage', async () => {
    const answer = answerOf(await fixGroupCommand(context({}, [])))
    expect(answer.json).toEqual({
      error: 'usage: gh-security fix-group <setup|classify|baseline|apply|score> [options]',
    })
  })

  it('refuses apply with no --work', async () => {
    const answer = answerOf(await fixGroupCommand(context({}, ['apply'])))
    expect(answer.json).toEqual({ error: 'apply: --work is required' })
  })

  // The phase table is an object. A name of its prototype is not a phase.
  it.each(['toString', 'constructor', 'cleanup'])(
    'refuses the phase %s with exit 1',
    async (phase) => {
      const answer = answerOf(await fixGroupCommand(context({}, [phase, '--work', '/x'])))
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain(`'${phase}' is not a phase of this command`)
    },
  )
})

describe('apply (phase 4)', () => {
  // jq `$validate.requires_major_bump // []`.
  it('answers an empty requires_major_bump when validate gives none', async () => {
    const passed = validateAnswer(true)
    delete passed.requires_major_bump
    const w = await ready((s) => {
      s.validate = [passed]
    })
    expect(pick(await apply(w), 'requires_major_bump')).toEqual({
      exit: 0,
      requires_major_bump: [],
    })
  })

  it('reaches a scoped-override success on the ordinary path', async () => {
    const answer = await apply(await ready())
    expect(pick(answer, 'status', 'step', 'action', 'override_scope', 'bare_override')).toEqual({
      exit: 0,
      status: 'ok',
      step: 'apply',
      action: 'scoped-override',
      override_scope: 'scoped',
      bare_override: 'none',
    })
  })

  it('answers with each key of the contract, and writes the state that score reads', async () => {
    const w = await ready()
    const answer = await apply(w)
    expect(answer.json).toEqual({
      status: 'ok',
      step: 'apply',
      action: 'scoped-override',
      override_scope: 'scoped',
      bare_override: 'none',
      applied_parents: ['express'],
      parent_derivation: null,
      install_signals: [],
      written: SCOPED,
      superseded_keys: [],
      alias_lookup: { source: 'lockfile', parents_unresolved: [] },
      lockfile_invalidated: { performed: true, keys: ['node_modules/lodash'] },
      override_file: 'package.json',
      observations: [],
      observations_pre_fix: [],
      requires_major_bump: [],
      other_line_moves: [],
      benign_moves: [],
    })
    const state = stateOf(w)
    expect({
      range: state.range,
      fix_installs: state.fix_installs,
      action: state.action,
      override_scope: state.override_scope,
      bare_override: state.bare_override,
      apply_result: state.apply_result,
      validate: state.validate,
      applied_parents: state.applied_parents,
      tighten_bare: state.tighten_bare,
      observations_first: state.observations_first,
    }).toEqual({
      range: '>=4.17.21 <5',
      fix_installs: 1,
      action: 'scoped-override',
      override_scope: 'scoped',
      bare_override: 'none',
      apply_result: applyAnswer(),
      validate: validateAnswer(true),
      applied_parents: ['express'],
      tighten_bare: false,
      observations_first: [],
    })
  })

  it('derives a major-bounded range from highest_fixed_version', async () => {
    const w = await ready()
    await apply(w)
    expect(callsOf(w, 'apply').map((request) => request.range)).toEqual(['>=4.17.21 <5'])
    expect(callsOf(w, 'validate').map((request) => request.range)).toEqual(['>=4.17.21 <5'])
  })

  // Any fatal entry stops the run. The checks of `--line` cannot see a copy
  // on another line (#83).
  it('stops on a fatal cross-line move and quotes the array', async () => {
    const fatal = { major: 1, before: ['1.1.18'], after: [], status: 'vanished', class: 'fatal' }
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, [], [fatal])]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain('"class":"fatal"')
    expect(answer.stderr).toContain('Narrowing the key is not the remedy')
    expect(answer.stderr).toContain(`Entries apply_constraint wrote: ${JSON.stringify(SCOPED)}`)
  })

  // The check does not read `ok`: a fatal move stops a validate that passed.
  it('stops on a fatal cross-line move when validate says ok', async () => {
    const fatal = { major: 1, before: ['1.1.18'], after: [], status: 'vanished', class: 'fatal' }
    const w = await ready((s) => {
      s.validate = [validateAnswer(true, [], [fatal])]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain('"class":"fatal"')
  })

  it('stops on an other_line_moves that is an object, and quotes it', async () => {
    const fatal = { major: 1, before: ['1.1.18'], after: [], status: 'vanished', class: 'fatal' }
    const w = await ready((s) => {
      s.validate = [validateAnswer(true, [], { x: fatal })]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain(JSON.stringify([{ x: fatal }]))
  })

  // That class is the verdict of the adapter, and the run goes on (#105).
  it('proceeds when every cross-line move is benign_dedup', async () => {
    const benign = {
      major: 2,
      before: ['2.3.1', '2.3.2'],
      after: ['2.3.2'],
      status: 'moved',
      class: 'benign_dedup',
    }
    const w = await ready((s) => {
      s.validate = [validateAnswer(true, [], [benign])]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'action', 'benign_moves')).toEqual({
      exit: 0,
      status: 'ok',
      action: 'scoped-override',
      benign_moves: [benign],
    })
  })

  // `[]` is an answer and goes as `[]`. An absent field omits the flag, and
  // validate then calls each move on another line fatal (#105).
  it('passes --sibling-alerts verbatim when the group carries the field', async () => {
    const w = await ready()
    await apply(w)
    expect(callsOf(w, 'validate')[0]?.siblingAlerts).toBe('[]')
  })

  it('omits --sibling-alerts entirely when the field is absent from the payload', async () => {
    const w = await ready(() => {}, group('absent'))
    await apply(w)
    expect(callsOf(w, 'validate')[0]?.siblingAlerts).toBeNull()
  })

  it('passes the sibling_alerts value verbatim, not merely the flag', async () => {
    const w = await ready(() => {}, group([{ number: 9, package: 'lodash', major: 3 }]))
    await apply(w)
    expect(callsOf(w, 'validate')[0]?.siblingAlerts).toBe(
      '[{"number":9,"package":"lodash","major":3}]',
    )
  })

  it('passes one --vulnerable per distinct vulnerable_range, sorted', async () => {
    const payload = group()
    payload.alerts = [
      { number: 1, vulnerable_range: '< 4.17.21' },
      { number: 2, vulnerable_range: '>= 4.0.0, < 4.17.19' },
      { number: 3, vulnerable_range: '< 4.17.21' },
    ]
    const w = await ready(() => {}, payload)
    await apply(w)
    expect(callsOf(w, 'validate')[0]).toMatchObject({
      line: '4',
      vulnerable: ['< 4.17.21', '>= 4.0.0, < 4.17.19'],
      baseline: JSON.stringify(rv('4.17.20')),
    })
  })

  // The adapter retargets a declaration that merely shares the name, and
  // writes a version of another package that does not exist (#49).
  it('rejects a written npm: value naming a different package', async () => {
    const w = await ready((s) => {
      s.apply = [
        applyAnswer([
          {
            parent: 'express',
            path: ['overrides', 'express', 'lodash'],
            value: 'npm:underscore@>=4.17.21 <5',
          },
        ]),
      ]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({ exit: 3, status: 'failure', phase: 'apply' })
    expect(answer.stderr).toContain('npm:underscore')
    expect(answer.stderr).toContain('resolved by hand')
    // No fix install ran: the one install is the control install.
    expect(installs(w)).toBe(1)
  })

  // A `"."` self key quotes a value that was there before (#147).
  it('exempts a preserved: true entry from the npm: rejection', async () => {
    const w = await ready((s) => {
      s.apply = [
        applyAnswer([
          {
            parent: 'express',
            path: ['overrides', 'express', '.'],
            value: 'npm:underscore@^1.13.6',
            preserved: true,
          },
          ...SCOPED,
        ]),
      ]
    })
    expect(pick(await apply(w), 'status', 'action')).toEqual({
      exit: 0,
      status: 'ok',
      action: 'scoped-override',
    })
  })

  it('passes an apply_constraint refusal through as phase apply, verbatim', async () => {
    const refusal =
      'apply_constraint: the root manifest spec for express also admits copies on other major lines'
    const w = await ready((s) => {
      s.apply = [{ error: refusal }]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({ exit: 3, status: 'failure', phase: 'apply' })
    expect(answer.json.detail).toBe(
      'apply_constraint exited non-zero, so no fix install was run and no PR was opened. ' +
        'Whether it wrote anything before failing is not observed here; the worktree is ' +
        `discarded on cleanup either way. Quoting the adapter verbatim: ${refusal}`,
    )
    expect(answer.stderr).toBe(`fix-group: apply failure: ${answer.json.detail}`)
  })

  // The two checks came too late before: the baseline not at all, and the
  // alerts only after the manifest was written and a full install ran.
  it('refuses to run without a baseline, before anything is written', async () => {
    const w = world()
    await setupOnly(w)
    await classify(w)
    const before = stateOf(w)
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.json).toEqual({
      error:
        "apply: run 'baseline' first. Without its post-control-install snapshot, validate is " +
        "handed --baseline null, which reports every cross-line move as 'not checked' rather " +
        'than as checked and clean (#146).',
    })
    expect(w.calls).toEqual([])
    expect(existsSync(join(w.pmDir, 'install.n'))).toBe(false)
    expect(stateOf(w)).toEqual(before)
  })

  it('names the missing classify step', async () => {
    const w = world()
    await setupOnly(w)
    expect((await apply(w)).json).toEqual({ error: "apply: run 'classify' first" })
  })

  it('reads an empty relationship as a classify that did not run', async () => {
    const w = await ready()
    editState(w, (state) => {
      state.relationship = ''
    })
    expect((await apply(w)).json).toEqual({ error: "apply: run 'classify' first" })
  })

  // An alert dropped from `--vulnerable` lets `unresolved_alerts` come back
  // empty for an alert that nothing checked.
  it('fails on an alert carrying no vulnerable_range rather than dropping it, and writes nothing', async () => {
    const payload = group()
    payload.alerts = [
      { number: 1, vulnerable_range: '< 4.17.21' },
      { number: 2, vulnerable_range: null },
    ]
    const w = await ready(() => {}, payload)
    const before = stateOf(w)
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({ exit: 3, status: 'failure', phase: 'apply' })
    expect(answer.stderr).toContain('[2]')
    expect(answer.stderr).toContain('nothing checked')
    expect(w.calls).toEqual([])
    expect(stateOf(w)).toEqual(before)
  })

  it.each([
    ['absent', (state: Json) => delete (state.group as Json).alerts],
    ['empty', (state: Json) => ((state.group as Json).alerts = [])],
    ['not a list', (state: Json) => ((state.group as Json).alerts = { number: 1 })],
  ])('is exit 1 when the alerts of the state are %s', async (_name, edit) => {
    const w = await ready()
    editState(w, edit)
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(w.calls).toEqual([])
  })

  it('names the alerts when the list is empty', async () => {
    const w = await ready()
    editState(w, (state) => {
      ;(state.group as Json).alerts = []
    })
    expect((await apply(w)).json).toEqual({
      error: "apply: the group payload carries no alerts array; run 'setup' with a complete group",
    })
  })

  it('is exit 1 when highest_fixed_version is absent', async () => {
    const w = await ready()
    editState(w, (state) => {
      delete (state.group as Json).highest_fixed_version
    })
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("'group.highest_fixed_version'")
  })

  it('is exit 1 when highest_fixed_version has no readable major', async () => {
    const w = await ready()
    editState(w, (state) => {
      ;(state.group as Json).highest_fixed_version = 'next'
    })
    expect((await apply(w)).json).toEqual({
      error: "apply: highest_fixed_version 'next' has no readable major",
    })
    expect(w.calls).toEqual([])
  })

  it('is exit 1 on a sibling_alerts that is null, before anything is written', async () => {
    const w = await ready()
    editState(w, (state) => {
      ;(state.group as Json).sibling_alerts = null
    })
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("'group.sibling_alerts'")
    expect(w.calls).toEqual([])
  })

  it('reports a direct dependency retarget as direct-update, end to end', async () => {
    const w = await ready((s) => {
      s.why.relationship = 'direct'
      s.why.parents = []
      s.apply = [
        applyAnswer([{ parent: null, path: ['dependencies', 'lodash'], value: '>=4.17.21 <5' }]),
      ]
    })
    const answer = await apply(w)
    expect(pick(answer, 'action', 'override_scope', 'bare_override', 'applied_parents')).toEqual({
      exit: 0,
      action: 'direct-update',
      override_scope: 'none',
      bare_override: 'none',
      applied_parents: [],
    })
  })

  it('passes no parent arguments on the direct path', async () => {
    const w = await ready((s) => {
      s.why.relationship = 'direct'
    })
    await apply(w)
    expect(callsOf(w, 'apply')).toEqual([
      { pkg: 'lodash', range: '>=4.17.21 <5', parents: [], tightenBare: false },
    ])
  })

  it('passes the eligible parents on the transitive path', async () => {
    const w = await ready()
    await apply(w)
    expect(callsOf(w, 'apply')).toEqual([
      { pkg: 'lodash', range: '>=4.17.21 <5', parents: ['express'], tightenBare: false },
    ])
  })

  // `mode` is the input of the call: `direct` means no parent was passed. A
  // transitive package with no eligible parent takes the same branch, and the
  // adapter writes a bare top-level key for it.
  describe('a bare override is never labelled by apply_constraint mode', () => {
    it.each([
      ['overrides', ['overrides', 'lodash']],
      ['resolutions', ['resolutions', 'lodash']],
      ['pnpm.overrides', ['pnpm', 'overrides', 'lodash']],
    ])('reports a top-level %s write as bare-added despite mode direct', async (_name, path) => {
      const w = await ready((s) => {
        s.declared.parents_read = []
        s.declared.ranges = []
        s.declared.parents_other_lines = ['express@3.1.5']
        s.apply = [
          { ...applyAnswer([{ parent: null, path, value: '>=4.17.21 <5' }]), mode: 'direct' },
        ]
      })
      const answer = await apply(w)
      expect(pick(answer, 'action', 'override_scope', 'bare_override')).toEqual({
        exit: 0,
        action: 'bare-override',
        override_scope: 'bare-added',
        bare_override: 'added',
      })
    })
  })

  it('reports it as bare-tightened when a pre-fix observation targeted the package', async () => {
    const w = await ready((s) => {
      s.declared.parents_read = []
      s.apply = [
        applyAnswer(
          [{ parent: null, path: ['overrides', 'lodash'], value: '>=4.17.21 <5' }],
          [
            {
              type: 'unscoped_override',
              key: 'lodash',
              range: '^4.17.0',
              targets_this_package: true,
            },
          ],
        ),
      ]
    })
    const answer = await apply(w)
    expect(pick(answer, 'action', 'override_scope', 'bare_override')).toEqual({
      exit: 0,
      action: 'bare-override',
      override_scope: 'bare-tightened',
      bare_override: 'tightened',
    })
  })

  it('keeps a nested override key scoped', async () => {
    const w = await ready((s) => {
      s.apply = [{ ...applyAnswer(), mode: 'direct' }]
    })
    expect(pick(await apply(w), 'action', 'override_scope')).toEqual({
      exit: 0,
      action: 'scoped-override',
      override_scope: 'scoped',
    })
  })

  // A `"."` self key quotes a value that was there before. This call did not
  // choose its shape, so it never decides the widest shape.
  it('ignores a preserved entry when deciding the widest shape', async () => {
    const w = await ready((s) => {
      s.apply = [
        applyAnswer([
          { parent: 'express', path: ['overrides', 'lodash'], value: '^4.0.0', preserved: true },
          ...SCOPED,
        ]),
      ]
    })
    expect(pick(await apply(w), 'action', 'override_scope')).toEqual({
      exit: 0,
      action: 'scoped-override',
      override_scope: 'scoped',
    })
  })

  it('fails the phase on a written[] entry that cannot be classified', async () => {
    const w = await ready((s) => {
      s.apply = [applyAnswer([...SCOPED, 'overrides.lodash'])]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({ exit: 3, status: 'failure', phase: 'apply' })
    expect(answer.stderr).toContain("apply_constraint's written[] could not be classified")
  })

  // Read with a default of zero, the count re-opens the hole that the state
  // closed: the budget no longer bounds the run.
  describe('the persisted install budget is read strictly', () => {
    it.each([
      ['absent', (state: Json) => delete state.fix_installs],
      ['null', (state: Json) => (state.fix_installs = null)],
      ['not-a-number', (state: Json) => (state.fix_installs = 'lots')],
      ['negative', (state: Json) => (state.fix_installs = '-1')],
      ['empty text', (state: Json) => (state.fix_installs = '')],
      ['a fraction', (state: Json) => (state.fix_installs = 1.5)],
      ['a boolean', (state: Json) => (state.fix_installs = true)],
    ])(
      'refuses to run when fix_installs is %s rather than defaulting to zero',
      async (_n, edit) => {
        const w = await ready()
        editState(w, edit)
        const answer = await apply(w)
        expect(answer.status).toBe(1)
        expect(answer.json).toHaveProperty('error')
        expect(w.calls).toEqual([])
      },
    )

    it('names the value that is not a count', async () => {
      const w = await ready()
      editState(w, (state) => {
        state.fix_installs = 'lots'
      })
      expect((await apply(w)).json).toEqual({
        error:
          "apply: the state file's fix_installs is 'lots', which is not a count. The " +
          'fix-install budget cannot be enforced against it, and defaulting it to zero would ' +
          'silently unbound the run.',
      })
    })

    it('reads a count written as digits', async () => {
      const w = await ready()
      editState(w, (state) => {
        state.fix_installs = '2'
      })
      expect((await apply(w)).status).toBe(0)
      expect(stateOf(w).fix_installs).toBe(3)
    })
  })

  // The drift flag decides between a no-op and a lockfile refresh. A value
  // read as "not true" takes the no-op branch, which leaves the alerts open
  // (#146).
  describe('the drift flag fails away from no_op, never toward it', () => {
    const noChange = (w: World) => {
      install(w, 2, ':\n')
    }

    it.each([
      ['absent', (state: Json) => delete state.drift_commit, 1],
      ['null', (state: Json) => (state.drift_commit = null), 1],
      ['not-a-boolean', (state: Json) => (state.drift_commit = 'yes'), 3],
      ['the text true', (state: Json) => (state.drift_commit = 'true'), 3],
      ['empty text', (state: Json) => (state.drift_commit = ''), 3],
    ])('refuses to decide the empty-diff case when drift_commit is %s', async (_n, edit, exit) => {
      const w = world()
      w.script.rv = [rv('4.17.21'), rv('4.17.21')]
      noChange(w)
      await throughBaseline(w)
      editState(w, edit)
      const answer = await apply(w)
      expect(answer.status).toBe(exit)
      expect(answer.json.status).not.toBe('no_op')
      expect(answer.stderr).not.toBe('')
      expect(stateOf(w).action).toBeUndefined()
    })

    it('names the value in the failure', async () => {
      const w = world()
      noChange(w)
      await throughBaseline(w)
      editState(w, (state) => {
        state.drift_commit = 'yes'
      })
      expect((await apply(w)).json).toEqual({
        status: 'failure',
        phase: 'validate',
        detail:
          "the state file's drift_commit is 'yes', which is neither true nor false. It decides " +
          'whether an empty fix diff is a true no-op or a lockfile-refresh, and anything ' +
          "unreadable there defaults toward no_op: that reports a real fix as 'already fixed' " +
          'and leaves the alerts open (#146).',
      })
    })
  })

  // The evidence for "already fixed on the default branch" is the resolved
  // version. An empty one was read as "against the resolved ".
  it('never reports a no_op whose resolved_version is empty', async () => {
    const w = world()
    w.script.rv = [rv('4.17.21'), rv('4.17.21')]
    w.script.validate = [{ ...validateAnswer(true), resolved_versions: [] }]
    install(w, 2, ':\n')
    await throughBaseline(w)
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain('no evidence')
    expect(stateOf(w).action).toBeUndefined()
  })

  it.each([
    ['omits resolved_versions entirely', undefined, "no 'resolved_versions' field"],
    ['answers a resolved_versions that is not a list', '4.17.21', 'no evidence'],
  ])('fails the same way when validate %s', async (_name, value, text) => {
    const w = world()
    w.script.rv = [rv('4.17.21'), rv('4.17.21')]
    const answer = validateAnswer(true)
    if (value === undefined) delete answer.resolved_versions
    else answer.resolved_versions = value
    w.script.validate = [answer]
    install(w, 2, ':\n')
    await throughBaseline(w)
    const result = await apply(w)
    expect(pick(result, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(result.stderr).toContain(text)
  })

  // A state with no eligible parents is a classify that did not run. It is
  // never reported as an adapter that cannot be read.
  it('names the missing classify step rather than blaming the adapter', async () => {
    const w = await ready()
    editState(w, (state) => {
      delete state.eligible_parents
      state.relationship = 'transitive'
    })
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain('eligible_parents')
    expect(answer.stderr).not.toContain('violations')
  })

  it('is exit 1 on eligible_parents that are not a list of names', async () => {
    const w = await ready()
    editState(w, (state) => {
      state.eligible_parents = 'express'
    })
    const answer = await apply(w)
    expect(answer.json).toEqual({
      error: `the state file at ${join(w.work, 'state.json')} has no usable value for 'eligible_parents': expected a list of names, found "express".`,
    })
    expect(w.calls).toEqual([])
  })
})

describe('the remediation ladder', () => {
  // Step 1: the copy that violates usually comes through a parent that has
  // no entry. Its path names that parent.
  it('adds the uncovered parent from a violating copy path and re-runs', async () => {
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
        validateAnswer(true),
      ]
      s.apply = [
        applyAnswer(),
        applyAnswer([
          { parent: 'koa', path: ['overrides', 'koa', 'lodash'], value: '>=4.17.21 <5' },
        ]),
      ]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'action', 'applied_parents')).toEqual({
      exit: 0,
      status: 'ok',
      action: 'scoped-override',
      applied_parents: ['express', 'koa'],
    })
    expect(callsOf(w, 'apply').map((request) => request.parents)).toEqual([
      ['express'],
      ['express', 'koa'],
    ])
  })

  // Step 2: the widest change, so the last one. `tightened` needs an
  // observation from before the first call of the run.
  it('escalates to a tightened bare override when one already targeted the package', async () => {
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, at('node_modules/lodash')), validateAnswer(true)]
      s.apply = [
        applyAnswer(
          [],
          [
            {
              type: 'unscoped_override',
              key: 'lodash',
              range: '^4.17.0',
              targets_this_package: true,
            },
          ],
        ),
      ]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'action', 'override_scope', 'bare_override')).toEqual({
      exit: 0,
      status: 'ok',
      action: 'bare-override',
      override_scope: 'bare-tightened',
      bare_override: 'tightened',
    })
  })

  it('reports an added bare override when no pre-fix observation targeted the package', async () => {
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, at('node_modules/lodash')), validateAnswer(true)]
      s.apply = [
        applyAnswer(
          [],
          [
            {
              type: 'unscoped_override',
              key: 'sharp',
              range: '>=0.35.0 <1',
              targets_this_package: false,
            },
          ],
        ),
      ]
    })
    expect(pick(await apply(w), 'action', 'override_scope', 'bare_override')).toEqual({
      exit: 0,
      action: 'bare-override',
      override_scope: 'bare-added',
      bare_override: 'added',
    })
  })

  it('passes --tighten-bare on the escalation, once', async () => {
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, at('node_modules/lodash')), validateAnswer(true)]
    })
    await apply(w)
    expect(callsOf(w, 'apply').map((request) => request.tightenBare)).toEqual([false, true])
    expect(stateOf(w).tighten_bare).toBe(true)
  })

  // Step 4: no copy of the line is installed, so the override does nothing.
  // Never open a pull request for a change with no effect.
  it('fails on line_present false, naming requires_major_bump', async () => {
    const bump = [{ version: '3.10.1', path: 'node_modules/test-exclude/node_modules/lodash' }]
    const w = await ready((s) => {
      s.validate = [
        { ...validateAnswer(false), line_present: false, checked: 0, requires_major_bump: bump },
      ]
    })
    const answer = await apply(w)
    expect(answer.json).toEqual({
      status: 'failure',
      phase: 'validate',
      detail:
        'line_present is false: nothing on the 4.x line of lodash is installed, so there was ' +
        'nothing here to fix and the override applied does nothing. requires_major_bump: ' +
        JSON.stringify(bump),
    })
    expect(answer.status).toBe(3)
  })

  // The check comes at each failed validate, not only at the first.
  it('fails on line_present false after step 1', async () => {
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
        { ...validateAnswer(false), line_present: false, checked: 0 },
      ]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain('line_present is false')
    expect(callsOf(w, 'apply')).toHaveLength(2)
  })

  it('reads a line_present of the text false the same way, and quotes an absent requires_major_bump as null', async () => {
    const answer = validateAnswer(false)
    answer.line_present = 'false'
    delete answer.requires_major_bump
    const w = await ready((s) => {
      s.validate = [answer]
    })
    const result = await apply(w)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('requires_major_bump: null')
  })

  // A failure that the ladder does not cover is for the agent to diagnose.
  it('hands an undecidable install failure back as needs_judgment', async () => {
    const w = world()
    install(
      w,
      2,
      "printf 'npm ERR! notarget No matching version found for lodash@>=4.17.21\\n' >&2\n",
      1,
    )
    await throughBaseline(w)
    const answer = await apply(w)
    expect(answer.status).toBe(2)
    expect(answer.json).toEqual({
      status: 'needs_judgment',
      decision_point: 'install_failure',
      evidence: {
        phase: 'install',
        error:
          '\nRunning: npm install\nnpm ERR! notarget No matching version found for lodash@>=4.17.21',
        registry_timeout_retry: false,
        fix_installs: 1,
        install_signals: [],
        written: SCOPED,
      },
    })
    expect(answer.stderr).toBe('fix-group: needs judgment at install_failure')
  })

  it('retries an install that times out once, and says so in the evidence', async () => {
    const w = world()
    const timeout = "printf 'npm ERR! code ETIMEDOUT\\n' >&2\n"
    install(w, 2, timeout, 1)
    install(w, 3, timeout, 1)
    await throughBaseline(w)
    const answer = await apply(w)
    expect((answer.json.evidence as Json).registry_timeout_retry).toBe(true)
    expect(installs(w)).toBe(3)
    // The retry rides inside one install of the budget.
    expect(stateOf(w).fix_installs).toBe(1)
  })

  it('carries the pnpm 11 signal of a failed install in the evidence and the state', async () => {
    const w = world()
    install(
      w,
      2,
      `printf ' WARN  The "pnpm" field in package.json is no longer read by pnpm\\n' >&2\n`,
      1,
    )
    await throughBaseline(w)
    const answer = await apply(w)
    expect((answer.json.evidence as Json).install_signals).toEqual(['pnpm_field_no_longer_read'])
    expect(stateOf(w).install_signals).toEqual(['pnpm_field_no_longer_read'])
  })

  it('carries the signals of the run into the answer', async () => {
    const w = world()
    install(
      w,
      1,
      `printf 'The "pnpm" field in package.json is no longer read by pnpm\\n'\nprintf '{"n":1}\\n' > package-lock.json\n`,
    )
    await throughBaseline(w)
    expect((await apply(w)).json.install_signals).toEqual(['pnpm_field_no_longer_read'])
  })

  // A parent on another line never gets a scoped entry: a sibling agent
  // owns that line (#83).
  it('never derives a parent that is on another major line', async () => {
    const w = await ready((s) => {
      s.declared.parents_other_lines = ['koa@1.4.0']
      s.validate = [
        validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
        validateAnswer(true),
      ]
    })
    expect(pick(await apply(w), 'applied_parents', 'action')).toEqual({
      exit: 0,
      applied_parents: ['express'],
      action: 'bare-override',
    })
  })

  it('reads no other line when the state has no declared answer', async () => {
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
        validateAnswer(true),
      ]
    })
    editState(w, (state) => {
      delete state.declared
    })
    expect(pick(await apply(w), 'applied_parents')).toEqual({
      exit: 0,
      applied_parents: ['express', 'koa'],
    })
  })

  // jq `.declared.parents_other_lines // []` reads false as no list.
  it('reads a parents_other_lines of false as no other line', async () => {
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
        validateAnswer(true),
      ]
    })
    editState(w, (state) => {
      ;(state.declared as Json).parents_other_lines = false
    })
    expect(pick(await apply(w), 'applied_parents')).toEqual({
      exit: 0,
      applied_parents: ['express', 'koa'],
    })
  })

  it.each([
    ['a declared answer that is not an object', (state: Json) => (state.declared = 'x')],
    [
      'a parents_other_lines that is not a list of names',
      (state: Json) => ((state.declared as Json).parents_other_lines = [1]),
    ],
  ])('fails step 1 on %s', async (_name, edit) => {
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, at('node_modules/koa/node_modules/lodash'))]
    })
    editState(w, edit)
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain("could not be read for the ladder's first step")
  })

  // Step 1, then step 2, in one run: the parents of each call.
  it('runs step 1 and then step 2 when the added parent is not enough', async () => {
    const koa = at('node_modules/koa/node_modules/lodash')
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, koa), validateAnswer(false, koa), validateAnswer(true)]
    })
    const answer = await apply(w)
    expect(answer.status).toBe(0)
    expect({
      action: answer.json.action,
      applied_parents: answer.json.applied_parents,
      step1: answer.json.parent_derivation,
    }).toEqual({
      action: 'bare-override',
      applied_parents: ['express', 'koa'],
      // The derivation of step 1, not of the validate after it.
      step1: {
        parents: ['koa'],
        paths_naming_a_parent: 1,
        paths_naming_only_the_copy: 0,
        opaque_paths: [],
        possible: true,
        reason: null,
      },
    })
    expect(callsOf(w, 'apply')).toEqual([
      { pkg: 'lodash', range: '>=4.17.21 <5', parents: ['express'], tightenBare: false },
      { pkg: 'lodash', range: '>=4.17.21 <5', parents: ['express', 'koa'], tightenBare: false },
      { pkg: 'lodash', range: '>=4.17.21 <5', parents: ['express', 'koa'], tightenBare: true },
    ])
    // Exactly three fix installs, and the control install.
    expect(stateOf(w).fix_installs).toBe(3)
    expect(installs(w)).toBe(4)
  })

  // Only an npm path names a parent. pnpm gives `<name>@<version>` and Yarn
  // Berry the locator: both name the copy. Then step 1 cannot run, and the
  // answer says so in place of a step that looks done.
  describe('a violation path that names only the copy', () => {
    it.each([
      ['pnpm', 'lodash@4.17.20'],
      ['yarn', 'lodash@npm:4.17.20'],
      ['pnpm, scoped', '@babel/traverse@7.23.0'],
      ['yarn, scoped', '@babel/traverse@npm:7.23.0'],
    ])('records that step 1 was impossible under %s instead of faking it', async (_pm, path) => {
      const w = await ready((s) => {
        s.validate = [validateAnswer(false, at(path)), validateAnswer(true)]
      })
      const answer = await apply(w)
      expect(answer.json.parent_derivation).toMatchObject({
        possible: false,
        parents: [],
        paths_naming_only_the_copy: 1,
        paths_naming_a_parent: 0,
        opaque_paths: [path],
      })
    })

    it.each([
      ['pnpm', 'lodash@4.17.20'],
      ['yarn', 'lodash@npm:4.17.20'],
    ])('names the reason in the %s escalation evidence', async (_pm, path) => {
      const w = await ready((s) => {
        s.validate = []
        s.validateFallback = validateAnswer(false, at(path))
      })
      const answer = await apply(w)
      expect(answer.status).toBe(2)
      expect(answer.json.decision_point).toBe('validate_failed_after_ladder')
      const derivation = (answer.json.evidence as Json).parent_derivation as Json
      expect(derivation.possible).toBe(false)
      expect(derivation.reason).toMatch(/name the copy itself/)
      expect(answer.stderr).toBe('fix-group: needs judgment at validate_failed_after_ladder')
    })
  })

  // A scoped parent is two segments. Read as one, the path named `core`, a
  // package that does not exist, and the run went on to a bare pin.
  describe('the parent name is the whole name, scope included', () => {
    it.each([
      ['nested-scoped-parent', 'node_modules/@nestjs/core/node_modules/lodash', ['@nestjs/core']],
      ['nested-plain-parent', 'node_modules/koa/node_modules/lodash', ['koa']],
      [
        'deep-scoped-parent',
        'node_modules/a/node_modules/@types/node/node_modules/lodash',
        ['@types/node'],
      ],
      ['deep-plain-parent', 'node_modules/a/node_modules/koa/node_modules/lodash', ['koa']],
      ['top-level-copy', 'node_modules/lodash', []],
    ])('derives the parents of an npm %s', async (_name, path, parents) => {
      const w = await ready((s) => {
        s.validate = [validateAnswer(false, at(path)), validateAnswer(true)]
      })
      expect((await apply(w)).json.parent_derivation).toMatchObject({ parents })
    })

    it('passes the scoped parent to apply_constraint verbatim, never the remainder', async () => {
      const w = await ready((s) => {
        s.validate = [
          validateAnswer(false, at('node_modules/@nestjs/core/node_modules/lodash')),
          validateAnswer(true),
        ]
      })
      const answer = await apply(w)
      expect(callsOf(w, 'apply')[1]?.parents).toEqual(['@nestjs/core', 'express'])
      expect(answer.json.applied_parents).toEqual(['@nestjs/core', 'express'])
      expect(stateOf(w).applied_parents).toEqual(['@nestjs/core', 'express'])
    })

    // A scoped parent with an entry is not derived again. That holds only
    // when the two sides spell the name the same way.
    it('excludes a scoped parent that already carries an entry', async () => {
      const w = await ready((s) => {
        s.declared.parents_read = ['@nestjs/core@10.4.1']
        s.validate = []
        s.validateFallback = validateAnswer(
          false,
          at('node_modules/@nestjs/core/node_modules/lodash'),
        )
      })
      const answer = await apply(w)
      expect(answer.status).toBe(2)
      const evidence = answer.json.evidence as Json
      expect({
        parents: (evidence.parent_derivation as Json).parents,
        applied: evidence.applied_parents,
      }).toEqual({ parents: [], applied: ['@nestjs/core'] })
    })
  })

  // `path` is promised on each violation. Dropped, the entry counted in no
  // total, and the run gave the pnpm and Yarn reason for an answer that had
  // stopped.
  describe('a violation with no readable path', () => {
    it.each([
      ['absent', [{ version: '4.17.20' }]],
      ['null', [{ version: '4.17.20', path: null }]],
      ['not-text', [{ version: '4.17.20', path: ['node_modules', 'lodash'] }]],
      ['an entry that is not an object', ['node_modules/lodash']],
    ])('fails the phase when a violation path is %s', async (_name, violations) => {
      const w = await ready((s) => {
        s.validate = [validateAnswer(false, violations), validateAnswer(true)]
      })
      const answer = await apply(w)
      expect(pick(answer, 'status', 'phase')).toEqual({
        exit: 3,
        status: 'failure',
        phase: 'validate',
      })
      expect(answer.stderr).toContain("no readable 'path'")
      expect(answer.stderr).toContain(`violations: ${JSON.stringify(violations)}`)
      expect(answer.stderr).not.toContain('Yarn Berry the resolution locator')
    })

    it('fails the phase when validate gives no violations list', async () => {
      const answer = validateAnswer(false)
      delete answer.violations
      const w = await ready((s) => {
        s.validate = [answer]
      })
      const result = await apply(w)
      expect(result.status).toBe(3)
      expect(result.stderr).toContain('violations: null')
    })
  })

  it('reports step 1 as possible on an npm install path', async () => {
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
        validateAnswer(true),
      ]
    })
    expect((await apply(w)).json.parent_derivation).toMatchObject({
      possible: true,
      parents: ['koa'],
    })
  })

  // Step 3: the invalidation pass cannot explain the failure, and to delete
  // a whole lockfile needs a confirmation that this flow cannot get.
  describe('the stale-lockfile stop', () => {
    it.each([
      ['refused-with-a-reason', { performed: false, reason: 'npm only' }],
      ['performed-no-keys', { performed: true, keys: [] }],
    ])('stops when the lockfile-invalidation pass was %s', async (_name, invalidated) => {
      const w = await ready((s) => {
        s.validate = []
        s.validateFallback = validateAnswer(false, at('node_modules/lodash'))
        s.apply = []
        s.applyFallback = { ...applyAnswer([]), lockfile_invalidated: invalidated }
      })
      const answer = await apply(w)
      expect(answer.json).toEqual({
        status: 'failure',
        phase: 'validate',
        detail:
          'validation still fails and the lockfile-invalidation pass cannot account for it: ' +
          `${JSON.stringify(invalidated)}. Deleting a whole lockfile needs interactive ` +
          'confirmation this flow cannot obtain, so lockfile regeneration is likely required ' +
          'and needs a human-driven session.',
      })
      expect(answer.status).toBe(3)
    })
  })

  // The count is in the state, which makes the budget real. One `apply`
  // spends at most three of four, and a re-run continues the count.
  it('resumes the fix-install count across a re-run rather than resetting it', async () => {
    const w = await ready((s) => {
      s.validate = []
      s.validateFallback = validateAnswer(false, at('node_modules/koa/node_modules/lodash'))
    })
    expect((await apply(w)).status).toBe(2)
    expect(stateOf(w).fix_installs).toBe(3)
    await apply(w)
    expect(stateOf(w).fix_installs).toBe(4)
  })

  it('reaches install_budget_exhausted on the re-run rather than installing a fifth time', async () => {
    const w = await ready((s) => {
      s.validate = []
      s.validateFallback = validateAnswer(false, at('node_modules/koa/node_modules/lodash'))
    })
    await apply(w)
    const answer = await apply(w)
    expect(answer.status).toBe(2)
    expect(answer.json).toEqual({
      status: 'needs_judgment',
      decision_point: 'install_budget_exhausted',
      evidence: {
        fix_installs: 4,
        budget: 4,
        validate: validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
      },
    })
    expect(answer.stderr).toBe('fix-group: needs judgment at install_budget_exhausted')
    // The control install and four fix installs: never a fifth.
    expect(installs(w)).toBe(5)
  })

  // The edge of the budget: with three spent, one install is left.
  it.each([
    [3, 0, 4],
    [4, 2, 4],
    [5, 2, 5],
  ])(
    'with %i installs spent, apply exits %i and leaves the count at %i',
    async (spent, exit, after) => {
      const w = await ready()
      editState(w, (state) => {
        state.fix_installs = spent
      })
      const answer = await apply(w)
      expect(answer.status).toBe(exit)
      expect(stateOf(w).fix_installs).toBe(after)
    },
  )

  it('gives a null validate in the evidence when no validate ran in this apply', async () => {
    const w = await ready()
    editState(w, (state) => {
      state.fix_installs = 4
    })
    const answer = await apply(w)
    expect(answer.json.evidence).toEqual({ fix_installs: 4, budget: 4, validate: null })
  })

  // Read again on the re-run, the observations see the override that this
  // run wrote, and call a bare override that it added `tightened`.
  it('keeps the first run pre-fix observations across a re-run', async () => {
    const w = await ready((s) => {
      s.validate = []
      s.validateFallback = validateAnswer(false, at('node_modules/lodash'))
      s.apply = []
      s.applyFallback = applyAnswer([])
    })
    await apply(w)
    w.script.applyFallback = applyAnswer(
      [],
      [
        {
          type: 'unscoped_override',
          key: 'lodash',
          range: '>=4.17.21 <5',
          targets_this_package: true,
        },
      ],
    )
    await apply(w)
    expect(stateOf(w).observations_first).toEqual([])
  })

  // The first run spends two installs: the first, and step 2. The re-run
  // spends the last two, and validate clears on its step 2.
  it('reports a re-run bare override as added, not as tightened', async () => {
    const lodash = at('node_modules/lodash')
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, lodash),
        validateAnswer(false, lodash),
        validateAnswer(false, lodash),
      ]
      s.apply = []
      s.applyFallback = applyAnswer([])
    })
    await apply(w)
    w.script.validateFallback = validateAnswer(true)
    w.script.applyFallback = applyAnswer(
      [],
      [
        {
          type: 'unscoped_override',
          key: 'lodash',
          range: '>=4.17.21 <5',
          targets_this_package: true,
        },
      ],
    )
    const answer = await apply(w)
    expect(pick(answer, 'action', 'bare_override', 'observations_pre_fix')).toEqual({
      exit: 0,
      action: 'bare-override',
      bare_override: 'added',
      observations_pre_fix: [],
    })
  })

  it.each([
    ['null', null],
    ['not a list', { type: 'unscoped_override' }],
  ])('is exit 1 on stored observations_first that are %s', async (_name, value) => {
    const w = await ready()
    editState(w, (state) => {
      state.observations_first = value
    })
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("'observations_first'")
    expect(w.calls).toEqual([])
  })

  // Exit 2 always carries a decision point and an evidence object. The
  // install error is the one field with bytes from outside this flow.
  it('never exits 2 without a decision point and an evidence object', async () => {
    const w = world()
    install(w, 2, "printf 'npm ERR! notarget \\001\\002 no matching version\\n' >&2\n", 1)
    await throughBaseline(w)
    const answer = await apply(w)
    expect(answer.status).toBe(2)
    expect(answer.json.decision_point).toBe('install_failure')
    expect((answer.json.evidence as Json).error).toContain('\u0001\u0002')
  })

  it('fails when validate omits line_present rather than bypassing its stop', async () => {
    const answer = validateAnswer(false, at('node_modules/lodash'))
    delete answer.line_present
    const w = await ready((s) => {
      s.validate = [answer]
    })
    const result = await apply(w)
    expect(pick(result, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(result.stderr).toContain("no 'line_present' field")
  })

  it('still fails validation after the ladder rather than guessing', async () => {
    const lodash = at('node_modules/lodash')
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, lodash),
        validateAnswer(false, lodash),
        validateAnswer(false, lodash),
      ]
    })
    const answer = await apply(w)
    expect(answer.status).toBe(2)
    expect(answer.json).toEqual({
      status: 'needs_judgment',
      decision_point: 'validate_failed_after_ladder',
      evidence: {
        validate: validateAnswer(false, lodash),
        written: SCOPED,
        applied_parents: ['express'],
        tighten_bare_applied: true,
        lockfile_invalidated: { performed: true, keys: ['node_modules/lodash'] },
        parent_derivation: {
          parents: [],
          paths_naming_a_parent: 1,
          paths_naming_only_the_copy: 0,
          opaque_paths: [],
          possible: true,
          reason: null,
        },
      },
    })
    // No state of a finished apply is written.
    expect(stateOf(w).action).toBeUndefined()
  })

  it('gives {} for a lockfile_invalidated that the answer does not have', async () => {
    const lodash = at('node_modules/lodash')
    const answer = applyAnswer()
    delete answer.lockfile_invalidated
    const w = await ready((s) => {
      s.validate = []
      s.validateFallback = validateAnswer(false, lodash)
      s.apply = []
      s.applyFallback = answer
    })
    expect(((await apply(w)).json.evidence as Json).lockfile_invalidated).toEqual({})
  })

  it('stops on an apply_constraint that fails on a later step', async () => {
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, at('node_modules/lodash'))]
      s.apply = [applyAnswer(), { error: 'apply_constraint: no' }]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({ exit: 3, status: 'failure', phase: 'apply' })
    // The refusal came before the install of step 2.
    expect(stateOf(w).fix_installs).toBe(1)
  })

  it('stops on a fatal move after step 1', async () => {
    const fatal = {
      major: 3,
      before: ['3.10.1'],
      after: ['3.10.2'],
      status: 'moved',
      class: 'fatal',
    }
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, at('node_modules/koa/node_modules/lodash')),
        validateAnswer(false, [], [fatal]),
      ]
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain('"major":3')
  })

  it('stops on a fatal move after step 2', async () => {
    const w = await ready((s) => {
      s.validate = [
        validateAnswer(false, at('node_modules/lodash')),
        validateAnswer(false, [], ['an entry that cannot be read']),
      ]
    })
    const answer = await apply(w)
    expect(answer.status).toBe(3)
    expect(answer.stderr).toContain('["an entry that cannot be read"]')
  })
})

describe('the empty diff', () => {
  // The drift commit of `baseline` took any ambient drift. So an empty
  // porcelain here means that the fix install changed nothing (#146).
  const noFixChange = (w: World) => {
    install(w, 2, ':\n')
  }

  const empty = async (pre: Json, base: Json, edit: (s: Script) => void = () => {}) => {
    const w = world()
    w.script.rv = [pre, base]
    edit(w.script)
    noFixChange(w)
    await throughBaseline(w)
    return { w, answer: await apply(w) }
  }

  it('is a true no-op when the line resolves identically across the drift commit', async () => {
    const { w, answer } = await empty(rv('4.17.21'), rv('4.17.21'))
    expect(answer.status).toBe(0)
    expect(answer.json).toEqual({
      status: 'no_op',
      package: 'lodash',
      major_line: '4',
      resolved_version: '4.17.21',
      drift_commit: true,
      no_op: {
        reason:
          'the 4.x line is already fixed on the default branch: the fix install changed nothing ' +
          'and validate clears every alert in this group against the resolved 4.17.21. A drift ' +
          'commit exists but left this line where the committed lockfile had it, so it clears ' +
          'none of the alerts in this group',
        evidence: {
          diff: '',
          resolved_version: '4.17.21',
          validate: {
            ok: true,
            violations: [],
            unresolved_alerts: [],
            other_line_moves: [],
            checked: 1,
          },
          merged_pr_url: null,
        },
      },
    })
    expect(stateOf(w).action).toBe('no-op')
    expect(stateOf(w).override_scope).toBeUndefined()
  })

  it('is a no-op with no drift note when the control install made no drift commit', async () => {
    const w = world()
    w.script.rv = [rv('4.17.20'), rv('4.17.20')]
    install(w, 1, ':\n')
    noFixChange(w)
    await throughBaseline(w)
    const answer = await apply(w)
    expect(pick(answer, 'status', 'drift_commit')).toEqual({
      exit: 0,
      status: 'no_op',
      drift_commit: false,
    })
    expect((answer.json.no_op as Json).reason).toBe(
      'the 4.x line is already fixed on the default branch: the fix install changed nothing ' +
        'and validate clears every alert in this group against the resolved 4.17.21',
    )
  })

  it('joins each resolved version, and reads a null one as empty, as jq join does', async () => {
    const { answer } = await empty(rv('4.17.21'), rv('4.17.21'), (s) => {
      s.validate = [{ ...validateAnswer(true), resolved_versions: ['3.10.1', null, '4.17.21'] }]
    })
    expect(answer.json.resolved_version).toBe('3.10.1, , 4.17.21')
  })

  // jq `["3.10.1", 4, true] | join(", ")` gives the text of each value.
  it('joins a resolved version that is a number or a boolean as its text', async () => {
    const { answer } = await empty(rv('4.17.21'), rv('4.17.21'), (s) => {
      s.validate = [{ ...validateAnswer(true), resolved_versions: ['3.10.1', 4, true] }]
    })
    expect(pick(answer, 'status', 'resolved_version')).toEqual({
      exit: 0,
      status: 'no_op',
      resolved_version: '3.10.1, 4, true',
    })
  })

  // jq `join` stops on an object or a list, and the bash failed the phase.
  it.each([
    ['an object', {}],
    ['a list', ['4.17.21']],
  ])('refuses a no_op whose resolved_versions holds %s', async (_name, entry) => {
    const { w, answer } = await empty(rv('4.17.21'), rv('4.17.21'), (s) => {
      s.validate = [{ ...validateAnswer(true), resolved_versions: ['4.17.21', entry] }]
    })
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain('no evidence')
    expect(stateOf(w).action).toBeUndefined()
  })

  it('quotes an absent validate field in the no_op evidence as null', async () => {
    const answer = validateAnswer(true)
    delete answer.unresolved_alerts
    delete answer.checked
    const result = await empty(rv('4.17.21'), rv('4.17.21'), (s) => {
      s.validate = [answer]
    })
    expect(((result.answer.json.no_op as Json).evidence as Json).validate).toEqual({
      ok: true,
      violations: [],
      unresolved_alerts: null,
      other_line_moves: [],
      checked: null,
    })
  })

  // A real fix whose content is the drift commit: the manifest already
  // admits the fixed version, and the stale lockfile pinned the old one.
  it('is a lockfile-refresh when the control install moved the line', async () => {
    const { w, answer } = await empty(rv('4.17.20'), rv('4.17.21'))
    expect(pick(answer, 'status', 'action', 'override_scope', 'bare_override')).toEqual({
      exit: 0,
      status: 'ok',
      action: 'lockfile-refresh',
      override_scope: 'none',
      bare_override: 'none',
    })
    expect(stateOf(w).action).toBe('lockfile-refresh')
  })

  // The specimen is the field shape: two versions of the line before the
  // drift, so the compare is of lists and not of two values.
  it('is a lockfile-refresh when a multi-version line deduped across the drift', async () => {
    const { answer } = await empty(rv('4.17.15', '4.17.20'), rv('4.17.21', '4.17.21'))
    expect(pick(answer, 'status', 'action')).toEqual({
      exit: 0,
      status: 'ok',
      action: 'lockfile-refresh',
    })
  })

  it('is a no-op when a multi-version line resolves identically across the drift', async () => {
    const { answer } = await empty(rv('4.17.21', '4.17.21'), rv('4.17.21', '4.17.21'))
    expect(answer.json.status).toBe('no_op')
  })

  // Two failed reads compare equal, which gave "already fixed on the
  // default branch" out of nothing (#146).
  describe('a snapshot that could not be read is never evidence of equality', () => {
    const SHAPES: [string, Json][] = [
      [
        'a null version',
        { ...rv('4.17.21'), versions: [{ version: null, path: 'node_modules/lodash' }] },
      ],
      [
        'no versions key',
        { pm: 'npm', package: 'lodash', present: true, count: 1, lockfile_entries: 3 },
      ],
      ['zero versions', rv()],
    ]

    it.each(SHAPES)(
      'refuses to report no_op when the pre-drift snapshot carries %s',
      async (_n, shape) => {
        const { answer } = await empty(shape, rv('4.17.21'))
        expect(pick(answer, 'status', 'phase')).toEqual({
          exit: 3,
          status: 'failure',
          phase: 'validate',
        })
        expect(answer.stderr).not.toBe('')
      },
    )

    it.each(SHAPES)(
      'refuses to report no_op when the baseline snapshot carries %s',
      async (_n, shape) => {
        const { answer } = await empty(rv('4.17.21'), shape)
        expect(pick(answer, 'status', 'phase')).toEqual({
          exit: 3,
          status: 'failure',
          phase: 'validate',
        })
        expect(answer.stderr).not.toBe('')
      },
    )

    it('names the two sides when one has no version of the line', async () => {
      const { answer } = await empty(rv('3.10.1'), rv('4.17.21'))
      expect(answer.stderr).toContain('pre_drift=[] baseline=["4.17.21"]')
    })

    it('is exit 1 when the state has no pre-drift snapshot', async () => {
      const w = world()
      w.script.rv = [rv('4.17.21'), rv('4.17.21')]
      noFixChange(w)
      await throughBaseline(w)
      editState(w, (state) => {
        delete state.pre_drift
      })
      const answer = await apply(w)
      expect(answer.status).toBe(1)
      expect(answer.stderr).toContain("'pre_drift'")
    })
  })
})

describe('what apply does not get from the adapter', () => {
  it.each([
    ['written', 'absent', "no 'written' field"],
    ['written', 'not a list', "answered a 'written' that is not an array"],
    ['observations', 'absent', "no 'observations' field"],
    ['observations', 'not a list', "answered an 'observations' that is not an array"],
  ])('fails the phase on a %s that is %s', async (key, shape, text) => {
    const answer = applyAnswer()
    if (shape === 'absent') delete answer[key]
    else answer[key] = 'x'
    const w = await ready((s) => {
      s.apply = [answer]
    })
    const result = await apply(w)
    expect(pick(result, 'status', 'phase')).toEqual({ exit: 3, status: 'failure', phase: 'apply' })
    expect(result.stderr).toContain(text)
  })

  it('fails the phase on a validate that fails, quoting it', async () => {
    const w = await ready((s) => {
      s.validate = [{ error: "validate: 'lodash' resolves to no versions in the lockfile." }]
    })
    const answer = await apply(w)
    expect(answer.json).toEqual({
      status: 'failure',
      phase: 'validate',
      detail:
        "validate produced no readable report: validate: 'lodash' resolves to no versions in the lockfile.",
    })
  })

  it('fails the phase on a validate answer with no ok', async () => {
    const answer = validateAnswer(true)
    delete answer.ok
    const w = await ready((s) => {
      s.validate = [answer]
    })
    expect((await apply(w)).json).toEqual({
      status: 'failure',
      phase: 'validate',
      detail: 'validate produced no readable report: ',
    })
  })

  it('reads an ok that is the text true as a failed validate', async () => {
    const answer = validateAnswer(true)
    answer.ok = 'true'
    const w = await ready((s) => {
      s.validate = [answer, validateAnswer(true)]
    })
    expect((await apply(w)).json.action).toBe('bare-override')
  })

  it('fails the apply phase when detect fails before apply_constraint', async () => {
    const w = await ready((s) => {
      s.failDetectAt = 1
    })
    const answer = await apply(w)
    expect(pick(answer, 'status', 'phase')).toEqual({ exit: 3, status: 'failure', phase: 'apply' })
    expect(answer.stderr).toContain('detect: the stand-in found no lockfile')
  })

  it('fails the validate phase when detect fails before validate', async () => {
    const w = await ready((s) => {
      s.failDetectAt = 3
    })
    const answer = await apply(w)
    expect(answer.json).toEqual({
      status: 'failure',
      phase: 'validate',
      detail: 'validate produced no readable report: detect: the stand-in found no lockfile',
    })
  })

  it('fails the validate phase when git status fails in the worktree', async () => {
    const w = await ready()
    const shim = w.fixtures.gitShim('status')
    const answer = await apply(w, {
      ...w.env,
      PATH: `${shim.directory}:${w.env.PATH}`,
      GIT_STUB_FAIL: shim.failing,
    })
    expect(pick(answer, 'status', 'phase')).toEqual({
      exit: 3,
      status: 'failure',
      phase: 'validate',
    })
    expect(answer.stderr).toContain('git status --porcelain failed in the worktree')
    expect(stateOf(w).action).toBeUndefined()
  })
})

describe('a state that cannot be written', () => {
  it('is exit 1 at the first write, and nothing ran', async () => {
    const w = await ready()
    blockState(w)()
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(BLOCKED)
    expect(w.calls).toEqual([])
  })

  it('is exit 1 at the write of observations_first, before any fix install', async () => {
    const w = await ready()
    w.script.on.apply = { 1: blockState(w) }
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(BLOCKED)
    expect(installs(w)).toBe(1)
  })

  it('is exit 1 at the write of the count, before the install', async () => {
    const w = await ready()
    editState(w, (state) => {
      state.observations_first = []
    })
    w.script.on.apply = { 1: blockState(w) }
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(installs(w)).toBe(1)
  })

  it('is exit 1 at the write of the install signals', async () => {
    const w = await ready()
    install(w, 2, `mkdir "${join(w.work, 'state.json.tmp')}"\n`)
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(BLOCKED)
    expect(w.calls.map((entry) => entry.verb)).toEqual(['apply'])
  })

  it('is exit 1 on install_signals in the state that are not a list of strings', async () => {
    const w = await ready()
    editState(w, (state) => {
      state.install_signals = 'pnpm'
    })
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain("'install_signals'")
  })

  it('is exit 1 at the write of the parents of step 1', async () => {
    const w = await ready((s) => {
      s.validate = [validateAnswer(false, at('node_modules/koa/node_modules/lodash'))]
    })
    w.script.on.validate = { 1: blockState(w) }
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(callsOf(w, 'apply')).toHaveLength(1)
  })

  it('is exit 1 at the write of a no-op', async () => {
    const w = world()
    w.script.rv = [rv('4.17.21'), rv('4.17.21')]
    install(w, 2, ':\n')
    await throughBaseline(w)
    w.script.on.validate = { 1: blockState(w) }
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(BLOCKED)
  })

  it('is exit 1 at the write of the result', async () => {
    const w = await ready()
    w.script.on.validate = { 1: blockState(w) }
    const answer = await apply(w)
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(BLOCKED)
  })
})

describe('env_prefix', () => {
  // The prefix script writes the directory and the name of each command that
  // it wraps, then runs it. The log is the verdict.
  it('wraps the fix install and the git call of apply, after the directory', async () => {
    const w = world()
    const log = join(w.bin, '..', 'prefix.log')
    const prefix = join(w.bin, 'prefix')
    writeFileSync(prefix, `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$1" >> "${log}"\nexec "$@"\n`)
    chmodSync(prefix, 0o755)
    await throughBaseline(w, '--env-prefix', prefix)
    writeFileSync(log, '')
    expect((await apply(w)).status).toBe(0)
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect([...new Set(lines.map((line) => line.split('|')[1]))].sort()).toEqual(['git', 'npm'])
    expect(lines).toContain(`${w.worktree}|npm`)
    expect(lines.some((line) => line.endsWith('|cd'))).toBe(false)
  })

  // `apply` runs one git command. It never prunes a worktree (git.md).
  it('runs git status and no other git command', async () => {
    const w = world()
    const log = join(w.bin, '..', 'git.log')
    const prefix = join(w.bin, 'prefix')
    writeFileSync(
      prefix,
      `#!/bin/sh\nif [ "$1" = git ]; then printf '%s\\n' "$*" >> "${log}"; fi\nexec "$@"\n`,
    )
    chmodSync(prefix, 0o755)
    await throughBaseline(w, '--env-prefix', prefix)
    writeFileSync(log, '')
    await apply(w)
    expect(readFileSync(log, 'utf8')).toBe(`git -C ${w.worktree} status --porcelain\n`)
  })
})
