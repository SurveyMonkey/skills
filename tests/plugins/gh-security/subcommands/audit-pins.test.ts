// `gh-security audit-pins list|baseline|test-pin`. The seam is the exported
// handler, with the runner and the registry as parameters. These are the
// examples of `spec/audit_driver_spec.sh` and `spec/audit_restore_spec.sh`
// for these three phases, and the branches that only the port has.
//
// git is real: each example runs in a linked worktree of a repository from
// `harness/git.ts`, over a lockfile specimen of `spec/fixtures/`. The package
// manager is a stand-in on PATH, because an install reaches the network
// (`mocking.md`). Where an example needs an adapter answer that the real
// adapter never gives, the adapter is a stand-in given through the registry
// parameter: the real node adapter with one verb replaced (`mocking.md`,
// "The injected collaborator"). The `list_pins` stand-ins read the manifest
// on disk through the real verb, so the driver's own removal is what the
// count check measures. The expected values are written by hand from the
// contract in the header of `audit-pins.ts`. `parity-audit-pins.test.ts`
// compares the port with `audit-pins-driver.sh`.
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { Adapter, ListPinsAnswer } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import {
  exitCodeFor,
  failed,
  type JsonValue,
  notImplemented,
  ok,
} from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { auditPins, auditPinsCommand } from '#gh-security/subcommands/audit-pins.ts'
import { Stop, settle } from '#gh-security/subcommands/audit-pins-common.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

// Each example makes a repository and runs git many times.
vi.setConfig({ testTimeout: 60_000 })

/** The stand-in package manager. `PM_DIR` holds what the example tells it. */
const FAKE_PM = `#!/bin/sh
case "$1" in
  install)
    n=$(cat "$PM_DIR/install.n" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$PM_DIR/install.n"
    if [ -f "$PM_DIR/install.sh" ]; then . "$PM_DIR/install.sh"; fi
    exit "$(cat "$PM_DIR/install.status" 2>/dev/null || echo 0)" ;;
  *) printf 'stand-in %s\\n' "$*" ;;
esac
`

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly repo: string
  readonly work: string
  readonly wt: string
  readonly pmDir: string
  readonly env: NodeJS.ProcessEnv
}

/** A repository of `fixture`, `edit` committed on it, and a linked worktree at `<work>/audit`. */
const world = (fixture = 'npm-v3', edit?: (repo: string) => void): World => {
  const sandbox = createSandbox()
  const fixtures = createGitFixtures(sandbox)
  const root = realpathSync(sandbox.path)
  const repo = fixtures.create(join(root, 'r'))
  fixtures.importTree(repo, join(FIXTURES_ROOT, fixture))
  if (edit !== undefined) {
    edit(repo)
    fixtures.git(repo, 'add', '-A')
    fixtures.git(repo, 'commit', '-qm', 'edit')
  }
  const work = join(root, 'audit-work')
  const wt = join(work, 'audit')
  fixtures.git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
  const bin = sandbox.stubPath(sandbox.join('bin'))
  for (const pm of ['npm', 'pnpm', 'yarn']) {
    writeFileSync(join(bin, pm), FAKE_PM)
    chmodSync(join(bin, pm), 0o755)
  }
  const pmDir = sandbox.join('pm')
  mkdirSync(pmDir)
  sandbox.env.PM_DIR = pmDir
  return { sandbox, fixtures, repo, work, wt, pmDir, env: sandbox.env }
}

interface Answer {
  readonly status: number
  readonly json: JsonValue
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) throw new Error('audit-pins answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  if ('report' in result) return { status: result.exitCode ?? 1, json: result.report }
  return { status: exitCodeFor(result), json: { error: result.error } }
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
): Promise<Answer> =>
  answerOf(
    await auditPins(context(env, args), { spawn: run, route, makeClient: () => createGhMock() }),
  )

const list = (w: World, route?: Route, ...extra: string[]) =>
  call(w, ['list', '--work', w.work, '--worktree', w.wt, ...extra], route)
const baseline = (w: World, route?: Route) => call(w, ['baseline', '--work', w.work], route)
const testPin = (w: World, args: readonly string[], route?: Route, env?: NodeJS.ProcessEnv) =>
  call(w, ['test-pin', '--work', w.work, ...args], route, env)

/** `list` then `baseline`, each of which must answer ok. */
const prepare = async (w: World, route?: Route): Promise<void> => {
  expect((await list(w, route)).status).toBe(0)
  expect((await baseline(w, route)).status).toBe(0)
}

/** A projection of an answer: the status, and the named keys of its JSON. */
const pick = (answer: Answer, ...keys: string[]) => ({
  status: answer.status,
  ...Object.fromEntries(
    keys.map((key) => [key, (answer.json as Record<string, JsonValue>)[key] ?? null]),
  ),
})

/** The finding of a `test-pin` answer. */
const finding = (answer: Answer): Record<string, JsonValue> =>
  (answer.json as Record<string, Record<string, JsonValue>>).finding as Record<string, JsonValue>

const stateOf = (w: World): Record<string, JsonValue> =>
  JSON.parse(readFileSync(join(w.work, 'state.json'), 'utf8')) as Record<string, JsonValue>

const editState = (w: World, edit: (state: Record<string, JsonValue>) => void): void => {
  const state = stateOf(w)
  edit(state)
  writeFileSync(join(w.work, 'state.json'), JSON.stringify(state))
}

const installs = (w: World, body: string, status = 0): void => {
  writeFileSync(join(w.pmDir, 'install.sh'), body)
  writeFileSync(join(w.pmDir, 'install.status'), `${status}\n`)
}

const installCount = (w: World): number => {
  try {
    return Number(readFileSync(join(w.pmDir, 'install.n'), 'utf8'))
  } catch {
    return 0
  }
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

/** A verb that answers this value, whatever its type should be. */
const answers = (value: unknown) => (): never => ok(value) as never

/** `list_pins` on disk, with this change to its answer. */
const listPinsWith =
  (change: (answer: ListPinsAnswer) => unknown) =>
  (...args: Parameters<Adapter<NodeDetection>['listPins']>) => {
    const real = node.listPins(...args)
    return (real.outcome === 'ok' ? ok(change(real.value)) : real) as never
  }

const FAIL = (reason: string) => () => failed(reason) as never

/** The text of `package.json` that the stand-in saw at its last install. */
const seenAtInstall = (w: World, file = 'package.json'): string => {
  installs(w, `cp ${file} "$PM_DIR/seen"\n`)
  return join(w.pmDir, 'seen')
}

const GIT_CLEAN = (w: World) => w.fixtures.git(w.wt, 'status', '--porcelain')

describe('the command', () => {
  it('refuses a call with no phase', async () => {
    expect(answerOf(await auditPinsCommand(context({}, [])))).toEqual({
      status: 1,
      json: {
        error: 'usage: gh-security audit-pins <list|baseline|test-pin|judge|together> [options]',
      },
    })
  })

  it.each(['score', 'constructor'])('refuses %s as a phase it does not have', async (phase) => {
    expect(answerOf(await auditPinsCommand(context({}, [phase])))).toEqual({
      status: 1,
      json: {
        error: `audit-pins: '${phase}' is not a phase of this command. The phases are list, baseline, test-pin, judge and together.`,
      },
    })
  })

  it('gives a throw that is not a stop to its caller, as a defect', async () => {
    await expect(settle(async () => Promise.reject(new Error('a defect')))).rejects.toThrow(
      'a defect',
    )
  })

  it('names itself in the throw of a stop', () => {
    expect(new Stop(failed('x')).name).toBe('Stop')
  })
})

describe('list (phase 2)', () => {
  it('routes each pin by kind, orders bare pins first, and writes the state', async () => {
    const w = world('npm-v3')
    expect(await list(w)).toEqual({
      status: 0,
      json: {
        status: 'ok',
        step: 'list',
        pm: 'npm',
        override_file: 'package.json',
        override_location: 'overrides',
        count: 2,
        test_order: [
          { key: 'lodash', path: ['lodash'], package: 'lodash', scope: 'bare', value: '^4.17.21' },
          {
            key: 'test-exclude',
            path: ['test-exclude', 'lodash'],
            package: 'lodash',
            scope: 'scoped',
            value: '3.10.1',
          },
        ],
        not_a_version_pin: [],
      },
    })
    const state = stateOf(w)
    expect({
      work: state.work,
      worktree: state.worktree,
      adapter: state.adapter,
      ecosystem: state.ecosystem,
      env_prefix: state.env_prefix,
      override_root: state.override_root,
      pins_count: state.pins_count,
      findings: state.findings,
      baseline_done: state.baseline_done,
    }).toEqual({
      work: w.work,
      worktree: w.wt,
      adapter: 'node',
      ecosystem: 'npm',
      env_prefix: '',
      override_root: ['overrides'],
      pins_count: 2,
      findings: [],
      baseline_done: false,
    })
  })

  it('orders bare pins before scoped ones whatever the manifest order', async () => {
    const w = world('npm-v3', (repo) =>
      writeFileSync(
        join(repo, 'package.json'),
        '{"name":"demo-npm","overrides":{"test-exclude":{"lodash":"3.10.1"},"lodash":"^4.17.21"}}\n',
      ),
    )
    const answer = await list(w)
    expect(
      (answer.json as { test_order: { scope: string }[] }).test_order.map((pin) => pin.scope),
    ).toEqual(['bare', 'scoped'])
  })

  it.each([
    [
      'alias',
      'a redirect to a different package, not a version pin: removing it changes which code ships',
    ],
    ['protocol', 'a patch, a local path, a workspace or git target, not a version pin'],
    ['reference', 'npm\'s "$pkg" form, deferring to a declared dependency, not a version pin'],
    [
      'unparseable',
      'a value this adapter cannot read, so it is not a version pin this audit can test, and the report says so',
    ],
    ['other', 'not a version pin'],
  ])('routes a %s pin to not-a-version-pin with its words', async (kind, detail) => {
    const w = world('npm-v3')
    const route = stand({
      listPins: listPinsWith((real) => ({
        ...real,
        pins: [{ ...real.pins[0], kind }, real.pins[1]],
      })),
    })
    const answer = await list(w, route)
    expect(pick(answer, 'test_order', 'not_a_version_pin')).toEqual({
      status: 0,
      test_order: [
        {
          key: 'test-exclude',
          path: ['test-exclude', 'lodash'],
          package: 'lodash',
          scope: 'scoped',
          value: '3.10.1',
        },
      ],
      not_a_version_pin: [
        { key: 'lodash', path: ['lodash'], package: 'lodash', kind, value: '^4.17.21', detail },
      ],
    })
  })

  it('reads an absent field of a pin as null, as jq does', async () => {
    const w = world('npm-v3')
    const route = stand({
      listPins: listPinsWith((real) => ({ ...real, count: 1, pins: [{ kind: 'range' }] })),
    })
    const answer = await list(w, route)
    expect(pick(answer, 'test_order')).toEqual({
      status: 0,
      test_order: [{ key: null, path: null, package: null, scope: null, value: null }],
    })
  })

  it('reports a repository that pins nothing as no_pins, not as a failure', async () => {
    const w = world('no-overrides')
    expect(await list(w)).toEqual({
      status: 0,
      json: {
        status: 'no_pins',
        step: 'list',
        pm: 'yarn',
        override_file: 'package.json',
        override_location: 'resolutions',
        count: 0,
        pins: [],
        test_order: [],
        pr_skipped_reason: 'no pins',
      },
    })
  })

  it('addresses the pnpm-workspace.yaml block by key, with an empty root', async () => {
    const w = world('pnpm11-workspace-overrides')
    expect(pick(await list(w), 'override_file', 'count')).toEqual({
      status: 0,
      override_file: 'pnpm-workspace.yaml',
      count: 4,
    })
    expect(stateOf(w).override_root).toEqual([])
  })

  it('addresses pnpm.overrides inside package.json', async () => {
    const w = world('pnpm-pins')
    expect((await list(w)).status).toBe(0)
    expect(stateOf(w).override_root).toEqual(['pnpm', 'overrides'])
  })

  it('records the prefix it was given', async () => {
    const w = world('npm-v3')
    expect((await list(w, undefined, '--env-prefix', 'env A=1')).status).toBe(0)
    expect(stateOf(w).env_prefix).toBe('env A=1')
  })

  it('never reports a refused manifest as a repository that pins nothing', async () => {
    const w = world('npm-v3', (repo) =>
      writeFileSync(join(repo, 'package.json'), '{"name":"demo-npm","overrides":"x"}\n'),
    )
    const answer = await list(w)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'list' })
    expect((answer.json as { detail: string }).detail).toMatch(
      /^list_pins failed: list_pins: 'overrides' in package\.json is a string.*A non-zero exit is not an empty result/,
    )
  })

  it('fails phase list on a tree with no lockfile', async () => {
    const w = world('npm-v3')
    rmSync(join(w.wt, 'package-lock.json'))
    const answer = await list(w)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'list' })
    expect((answer.json as { detail: string }).detail).toMatch(
      /^list_pins failed: No supported lockfile/,
    )
  })

  it.each(['count', 'override_file', 'override_location', 'pm'])(
    'fails phase list naming an absent %s',
    async (key) => {
      const w = world('npm-v3')
      const route = stand({
        listPins: listPinsWith((real) =>
          Object.fromEntries(Object.entries(real).filter(([k]) => k !== key)),
        ),
      })
      const answer = await list(w, route)
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'list' })
      expect((answer.json as { detail: string }).detail).toContain(
        `list_pins emitted no '${key}' field`,
      )
    },
  )

  it('fails when list_pins answers no object', async () => {
    const w = world('npm-v3')
    const answer = await list(w, stand({ listPins: answers('') }))
    expect((answer.json as { detail: string }).detail).toMatch(
      /^list_pins emitted no JSON object on stdout/,
    )
  })

  it.each([
    ['a text', '2'],
    ['a fraction', 1.5],
    ['a negative number', -1],
  ])('refuses a count that is %s', async (_name, count) => {
    const w = world('npm-v3')
    const answer = await list(w, stand({ listPins: listPinsWith((real) => ({ ...real, count })) }))
    expect(answer).toEqual({
      status: 3,
      json: {
        status: 'failure',
        phase: 'list',
        detail: `list_pins reported a count of '${count}', which is not a non-negative integer.`,
      },
    })
  })

  it('refuses a pins that is not a list', async () => {
    const w = world('npm-v3')
    const answer = await list(
      w,
      stand({ listPins: listPinsWith((real) => ({ ...real, pins: {} })) }),
    )
    expect((answer.json as { detail: string }).detail).toBe(
      "list_pins answered a 'pins' that is not an array; it is the only statement of what this repository pins.",
    )
  })

  it('refuses a count that disagrees with the entries beside it', async () => {
    const w = world('npm-v3')
    const answer = await list(
      w,
      stand({ listPins: listPinsWith((real) => ({ ...real, count: 9 })) }),
    )
    expect((answer.json as { detail: string }).detail).toBe(
      'list_pins reported count=9 beside 2 entries. The two disagree, and this flow verifies every later edit against that count.',
    )
  })

  it('names the routing when an entry is not an object', async () => {
    const w = world('npm-v3')
    const answer = await list(
      w,
      stand({ listPins: listPinsWith((real) => ({ ...real, count: 1, pins: ['oops'] })) }),
    )
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'list' })
    expect((answer.json as { detail: string }).detail).toMatch(
      /^list_pins' entries could not be routed by kind: \{"pm":"npm",/,
    )
  })

  it('refuses an override location it cannot address', async () => {
    const w = world('npm-v3')
    const answer = await list(
      w,
      stand({ listPins: listPinsWith((real) => ({ ...real, override_location: 'elsewhere' })) }),
    )
    expect(answer).toEqual({
      status: 1,
      json: {
        error:
          'list: list_pins reported an override_location this driver cannot address: elsewhere',
      },
    })
  })

  it.each([
    ['--work', ['list', '--worktree', '/x'], 'list requires --work'],
    ['--worktree', ['list', '--work', '/x'], 'list requires --worktree'],
  ])('requires %s', async (_flag, args, error) => {
    const w = world('npm-v3')
    expect(await call(w, args)).toEqual({ status: 1, json: { error } })
  })

  it('refuses a worktree that is not a directory', async () => {
    const w = world('npm-v3')
    for (const path of [
      join(w.wt, 'absent'),
      join(w.wt, 'package.json'),
      join(w.wt, 'package.json', 'x'),
    ]) {
      expect(await call(w, ['list', '--work', w.work, '--worktree', path])).toEqual({
        status: 1,
        json: { error: `list: no such worktree: ${path}` },
      })
    }
  })

  it('refuses an ecosystem with no adapter', async () => {
    const w = world('npm-v3')
    expect(await list(w, undefined, '--ecosystem', 'pip')).toEqual({
      status: 1,
      json: { error: "list: the ecosystem 'pip' has no adapter: ecosystem not supported yet" },
    })
  })

  it("refuses an option it does not know, in node's words", async () => {
    const w = world('npm-v3')
    expect(await list(w, undefined, '--adapter', 'node.sh')).toEqual({
      status: 1,
      json: { error: "Unknown option '--adapter'" },
    })
  })

  it('quotes node when the work directory cannot be made', async () => {
    const w = world('npm-v3')
    const work = join(w.wt, 'package.json', 'work')
    const answer = await call(w, ['list', '--work', work, '--worktree', w.wt])
    expect(
      (answer.json as { error: string }).error.startsWith(`list: cannot create ${work}: ENOTDIR`),
    ).toBe(true)
  })

  it('quotes the state reader when the state cannot be written', async () => {
    const w = world('npm-v3')
    mkdirSync(join(w.work, 'state.json.tmp'), { recursive: true })
    const answer = await list(w)
    expect(
      (answer.json as { error: string }).error.startsWith(
        `list: cannot write the state file at ${w.work}/state.json: Error: EISDIR`,
      ),
    ).toBe(true)
  })
})

describe('baseline (phase 4 head)', () => {
  it('installs once, asks detect for the lockfile, and writes both baselines', async () => {
    const w = world('npm-v3')
    await list(w)
    expect(await baseline(w)).toEqual({
      status: 0,
      json: {
        status: 'ok',
        step: 'baseline',
        lockfile: 'package-lock.json',
        resolution_map_available: true,
        unreadable_entries: 0,
        whole_tree_view: true,
        packages: [{ package: 'lodash', present: true, versions: ['3.10.1', '4.17.21'] }],
        inconclusive: [],
        test_order: [
          { key: 'lodash', path: ['lodash'], package: 'lodash', scope: 'bare', value: '^4.17.21' },
          {
            key: 'test-exclude',
            path: ['test-exclude', 'lodash'],
            package: 'lodash',
            scope: 'scoped',
            value: '3.10.1',
          },
        ],
      },
    })
    expect(installCount(w)).toBe(1)
    const state = stateOf(w)
    expect({
      lockfile: state.lockfile,
      map_available: state.map_available,
      baseline_unreadable_entries: state.baseline_unreadable_entries,
      baseline_done: state.baseline_done,
      judge_done: state.judge_done,
      findings: state.findings,
      resolutions: (state.baseline_map as { resolutions: JsonValue }).resolutions,
    }).toEqual({
      lockfile: 'package-lock.json',
      map_available: true,
      baseline_unreadable_entries: 0,
      baseline_done: true,
      judge_done: false,
      findings: [],
      resolutions: {
        '@babel/core': ['7.24.0'],
        express: ['4.18.2'],
        lodash: ['3.10.1', '4.17.21'],
        'serve-static': ['1.15.0'],
        'sha.js': ['2.4.11'],
        'test-exclude': ['6.0.0'],
      },
    })
  })

  it('records a pin on a package the baseline does not resolve inconclusive, and never tests it', async () => {
    const w = world('npm-v3', (repo) =>
      writeFileSync(
        join(repo, 'package.json'),
        '{"name":"demo-npm","overrides":{"lodash":"^4.17.21","left-pad":"^1.3.0"}}\n',
      ),
    )
    await list(w)
    const answer = await baseline(w)
    expect({
      inconclusive: (answer.json as { inconclusive: { package: string }[] }).inconclusive.map(
        (each) => each.package,
      ),
      order: (answer.json as { test_order: { key: string }[] }).test_order.map((pin) => pin.key),
    }).toEqual({ inconclusive: ['left-pad'], order: ['lodash'] })
    expect(stateOf(w).findings).toEqual([
      {
        key: 'left-pad',
        path: ['left-pad'],
        package: 'left-pad',
        scope: 'bare',
        value: '^1.3.0',
        status: 'inconclusive',
        tested: false,
        detail:
          'the with-all-pins baseline reports present: false for left-pad, which the manifest pins and the tree was just installed from. That is a claim the parser is making about itself, not about the tree, and every later step reads present: false as "the package left the tree" \u2014 this flow\'s cue for removable (#44, #46). The pin was not tested.',
        collateral_not_checked_reason:
          'this pin was never tested, so no other package in the tree was compared',
        resolved_with_pin: null,
        resolved_without_pin: null,
        attributable_versions: null,
        sibling_pins: [],
        collateral_changes: null,
        collateral_verdict: null,
        advisory_verdict: null,
        advisory_count: null,
        matched_ranges: [],
      },
    ])
    expect(await testPin(w, ['--key', 'left-pad'])).toEqual({
      status: 1,
      json: {
        error:
          "test-pin: the baseline recorded left-pad inconclusive (present: false), so this pin is not tested. Recording it and never testing it is the baseline's answer, not a step to redo.",
      },
    })
  })

  it('stops on a failed baseline install, phase install, quoting the manager', async () => {
    const w = world('npm-v3')
    await list(w)
    installs(w, "printf 'npm ERR! code ERESOLVE\\n' >&2\n", 1)
    expect(await baseline(w)).toEqual({
      status: 3,
      json: {
        status: 'failure',
        phase: 'install',
        detail:
          'the with-all-pins baseline install failed, so no pin was tested. One failure reported honestly beats a whole audit of plausible-looking verdicts. Quoting the package manager: \nRunning: npm install\nnpm ERR! code ERESOLVE',
      },
    })
  })

  it('stops when detect cannot name the lockfile', async () => {
    const w = world('npm-v3')
    await list(w)
    rmSync(join(w.wt, 'package-lock.json'))
    const answer = await baseline(w)
    expect((answer.json as { detail: string }).detail).toMatch(
      /^adapter detect failed, so the lockfile this phase restores between every pin has no name: No supported lockfile/,
    )
  })

  it('stops when detect answers no lockfile', async () => {
    const w = world('npm-v3')
    await list(w)
    const route = stand({
      detect: (root, env) => {
        const real = node.detect(root, env)
        if (real.outcome !== 'ok') return real
        const { lockfile: _lockfile, ...rest } = real.value
        return ok(rest) as never
      },
    })
    const answer = await baseline(w, route)
    expect((answer.json as { detail: string }).detail).toMatch(
      /^adapter detect emitted no 'lockfile' field/,
    )
  })

  it('stops on a baseline resolution_map that errors', async () => {
    const w = world('npm-v3')
    await list(w)
    const answer = await baseline(w, stand({ resolutionMap: FAIL('refused') }))
    expect(answer).toEqual({
      status: 3,
      json: {
        status: 'failure',
        phase: 'install',
        detail:
          'the baseline resolution_map failed on this lockfile: refused. A parser that refuses a lockfile it could not read is answering, and a diff against a map that was never built reports every package unchanged.',
      },
    })
  })

  it('keeps auditing when resolution_map is not implemented, with no whole-tree view', async () => {
    const w = world('npm-v3')
    await list(w)
    const answer = await baseline(
      w,
      stand({ resolutionMap: () => notImplemented('resolution_map') as never }),
    )
    expect(
      pick(answer, 'resolution_map_available', 'unreadable_entries', 'whole_tree_view'),
    ).toEqual({
      status: 0,
      resolution_map_available: false,
      unreadable_entries: null,
      whole_tree_view: false,
    })
    expect({ map: stateOf(w).baseline_map, refusal: stateOf(w).map_refusal }).toEqual({
      map: null,
      refusal:
        "the adapter does not implement resolution_map, so no other package's resolution was re-checked",
    })
  })

  it.each([
    [
      'absent',
      undefined,
      "the with-all-pins baseline resolution_map emitted no 'unreadable_entries' field",
    ],
    ['a text', '0', "reported unreadable_entries '0', which is not a non-negative integer"],
    ['null', null, "reported unreadable_entries 'null', which is not a non-negative integer"],
    ['below zero', -1, "reported unreadable_entries '-1', which is not a non-negative integer"],
    ['a fraction', 1.5, "reported unreadable_entries '1.5', which is not a non-negative integer"],
  ])('refuses a map whose unreadable_entries is %s', async (_name, value, words) => {
    const w = world('npm-v3')
    await list(w)
    const route = stand({
      resolutionMap: (tree) => {
        const real = node.resolutionMap(tree)
        if (real.outcome !== 'ok') return real
        const { unreadable_entries: _u, ...rest } = real.value
        return ok(value === undefined ? rest : { ...rest, unreadable_entries: value }) as never
      },
    })
    const answer = await baseline(w, route)
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'install' })
    expect((answer.json as { detail: string }).detail).toContain(words)
  })

  it.each([
    ['not an object', 'x'],
    ['an object with a version that is not a list', { lodash: '4.17.21' }],
    ['an object with a version that is not text', { lodash: [4] }],
  ])('refuses a map whose resolutions is %s', async (_name, resolutions) => {
    const w = world('npm-v3')
    await list(w)
    const answer = await baseline(
      w,
      stand({ resolutionMap: answers({ unreadable_entries: 0, resolutions }) }),
    )
    expect((answer.json as { detail: string }).detail).toBe(
      'the baseline resolution_map carries no resolutions object, so there is nothing to diff a removal against.',
    )
  })

  it('stops on a baseline resolved_versions that errors', async () => {
    const w = world('npm-v3')
    await list(w)
    const answer = await baseline(w, stand({ resolvedVersions: FAIL('parsed zero entries') }))
    expect((answer.json as { detail: string }).detail).toBe(
      'the baseline lockfile could not be parsed for lodash (resolved_versions): parsed zero entries. A failed parse is never an empty result.',
    )
  })

  describe('a resolved_versions payload that found nothing is never an empty one', () => {
    const RV = { present: true, versions: [{ version: '4.17.21', path: 'node_modules/lodash' }] }
    it.each([
      ['present absent', { versions: RV.versions }, "emitted no 'present' field"],
      [
        'present a text',
        { ...RV, present: 'yes' },
        "answered present 'yes', which is neither true nor false",
      ],
      ['versions absent', { present: true }, 'answered a versions list this flow cannot read'],
      [
        'versions an object',
        { ...RV, versions: {} },
        'answered a versions list this flow cannot read',
      ],
      [
        'an entry that is not an object',
        { ...RV, versions: ['4.17.21'] },
        'answered a versions list this flow cannot read',
      ],
      [
        'an entry with no version text',
        { ...RV, versions: [{ path: 'x' }] },
        'answered a versions list this flow cannot read',
      ],
      [
        'present true, nothing in it',
        { ...RV, versions: [] },
        'removable without a single advisory query',
      ],
      [
        'present false with versions',
        { ...RV, present: false },
        'answered present: false while reporting versions ["4.17.21"]. The payload contradicts itself',
      ],
    ])('stops the baseline on %s', async (_name, payload, words) => {
      const w = world('npm-v3')
      await list(w)
      const answer = await baseline(w, stand({ resolvedVersions: answers(payload) }))
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'install' })
      expect((answer.json as { detail: string }).detail).toMatch(
        /^resolved_versions lodash \(the with-all-pins baseline\) /,
      )
      expect((answer.json as { detail: string }).detail).toContain(words)
    })
  })

  it('requires --work, and a state that list wrote', async () => {
    const w = world('npm-v3')
    expect(await call(w, ['baseline'])).toEqual({
      status: 1,
      json: { error: 'baseline: --work is required' },
    })
    const missing = ((await baseline(w)).json as { error: string }).error
    expect([
      missing.startsWith(`no readable state file at ${w.work}/state.json: Error: ENOENT`),
      missing.endsWith(". Run 'list' first."),
    ]).toEqual([true, true])
    expect(await call(w, ['baseline', '--work', w.work, '--bogus'])).toEqual({
      status: 1,
      json: { error: "Unknown option '--bogus'" },
    })
  })

  it.each(['worktree', 'adapter', 'ecosystem', 'override_file'])(
    'refuses a state with no %s',
    async (key) => {
      const w = world('npm-v3')
      await list(w)
      editState(w, (state) => {
        delete state[key]
      })
      expect(await baseline(w)).toEqual({
        status: 1,
        json: {
          error: `the state file at ${w.work}/state.json has no usable value for '${key}'. Run the earlier steps first; an absent or empty value is never read as a legitimate answer here.`,
        },
      })
    },
  )

  it('refuses a state whose env_prefix is not text', async () => {
    const w = world('npm-v3')
    await list(w)
    editState(w, (state) => {
      state.env_prefix = 5
    })
    expect(await baseline(w)).toEqual({
      status: 1,
      json: {
        error: `the state file at ${w.work}/state.json has no usable value for 'env_prefix': expected text, found 5.`,
      },
    })
  })

  it('refuses a state whose ecosystem has no adapter', async () => {
    const w = world('npm-v3')
    await list(w)
    editState(w, (state) => {
      state.ecosystem = 'pip'
    })
    expect(await baseline(w)).toEqual({
      status: 1,
      json: {
        error: `the state file at ${w.work}/state.json names the ecosystem 'pip', which has no adapter: ecosystem not supported yet`,
      },
    })
  })

  it('runs the install under the prefix of the state', async () => {
    const w = world('npm-v3')
    const prefix = join(w.pmDir, 'prefix')
    writeFileSync(prefix, '#!/bin/sh\necho prefixed > "$PM_DIR/prefixed"\nexec "$@"\n')
    chmodSync(prefix, 0o755)
    await list(w, undefined, '--env-prefix', prefix)
    expect((await baseline(w)).status).toBe(0)
    expect(readFileSync(join(w.pmDir, 'prefixed'), 'utf8')).toBe('prefixed\n')
  })

  it.each([
    ['not a list', 'x'],
    ['a list with an entry that is not a pin', ['oops']],
    ['a pin with no key text', [{ key: 1, path: ['a'], package: 'a' }]],
    ['a pin with no path list', [{ key: 'a', path: 'a', package: 'a' }]],
    ['a pin with a path of other values', [{ key: 'a', path: [1], package: 'a' }]],
    ['a pin with no package text', [{ key: 'a', path: ['a'], package: 1 }]],
    ['a pin with an empty package', [{ key: 'a', path: ['a'], package: '' }]],
  ])('refuses a test_order that is %s', async (_name, order) => {
    const w = world('npm-v3')
    await list(w)
    editState(w, (state) => {
      state.test_order = order as JsonValue
    })
    expect(await baseline(w)).toEqual({
      status: 3,
      json: {
        status: 'failure',
        phase: 'install',
        detail: `phase 2's test_order is in the state file but is not the shape the step that wrote it promised (expected: a list of pins, each with a text key, a list of texts as its path, and a package name). An earlier step failed part-way, or the file was edited by hand. Value: ${JSON.stringify(order)}`,
      },
    })
  })

  it('quotes the state reader when a key cannot be written', async () => {
    const w = world('npm-v3')
    await list(w)
    mkdirSync(join(w.work, 'state.json.tmp'))
    expect(
      ((await baseline(w)).json as { error: string }).error.startsWith(
        `cannot write the state file at ${w.work}/state.json: Error: EISDIR`,
      ),
    ).toBe(true)
  })
})

describe('test-pin (phase 4, one pin per install)', () => {
  it('removes exactly that entry, installs, records the finding, and restores the tree', async () => {
    const w = world('npm-v3')
    await prepare(w)
    const seen = seenAtInstall(w)
    const answer = await testPin(w, ['--key', 'lodash'])
    expect(answer).toEqual({
      status: 0,
      json: {
        status: 'ok',
        step: 'test-pin',
        finding: {
          key: 'lodash',
          path: ['lodash'],
          package: 'lodash',
          scope: 'bare',
          value: '^4.17.21',
          status: 'tested',
          tested: true,
          left_tree: false,
          detail: "tested; the advisory judgment is phase 5's",
          collateral_not_checked_reason: null,
          resolved_with_pin: ['3.10.1', '4.17.21'],
          resolved_without_pin: ['3.10.1', '4.17.21'],
          attributable_versions: [],
          sibling_pins: [],
          collateral_changes: [],
          collateral_verdict: null,
          sampled_families: [],
          whole_tree_view: true,
          unreadable_entries: { baseline: 0, without_pin: 0 },
          advisory_verdict: null,
          advisory_count: null,
          matched_ranges: [],
        },
      },
    })
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({
      name: 'demo-npm',
      dependencies: { express: '^4.18.2', lodash: '^4.17.21' },
      overrides: { 'test-exclude': { lodash: '3.10.1' } },
      scripts: { build: 'webpack', test: 'jest', start: 'node server.js' },
    })
    expect(GIT_CLEAN(w)).toBe('')
    expect(installCount(w)).toBe(2)
    expect((stateOf(w).findings as JsonValue[]).length).toBe(1)
  })

  it('takes the delta, not the raw list, and lists the other packages that moved', async () => {
    const w = world('npm-v3')
    await prepare(w)
    installs(
      w,
      'sed -e \'s/"version": "3.10.1"/"version": "3.10.2"/\' -e \'s/"version": "4.18.2"/"version": "4.19.2"/\' package-lock.json > l.tmp\nmv l.tmp package-lock.json\n',
    )
    const found = finding(await testPin(w, ['--path', '["test-exclude","lodash"]']))
    expect({
      raw: found.resolved_without_pin,
      delta: found.attributable_versions,
      moved: found.collateral_changes,
    }).toEqual({
      raw: ['3.10.2', '4.17.21'],
      delta: ['3.10.2'],
      moved: [
        {
          package: 'express',
          baseline: ['4.18.2'],
          without_pin: ['4.19.2'],
          newly_admitted: ['4.19.2'],
          judged: true,
          represented_by: null,
          family: null,
        },
      ],
    })
    expect(GIT_CLEAN(w)).toBe('')
  })

  it('replaces the finding of a pin tested again, and clears judge_done', async () => {
    const w = world('npm-v3')
    await prepare(w)
    await testPin(w, ['--key', 'lodash'])
    editState(w, (state) => {
      state.judge_done = true
    })
    await testPin(w, ['--key', 'lodash'])
    const state = stateOf(w)
    expect({ count: (state.findings as JsonValue[]).length, judge_done: state.judge_done }).toEqual(
      {
        count: 1,
        judge_done: false,
      },
    )
  })

  it('removes the whole override block when the entry was the last one', async () => {
    const w = world('npm-v3', (repo) =>
      writeFileSync(
        join(repo, 'package.json'),
        '{"name":"demo-npm","overrides":{"lodash":"^4.17.21"}}\n',
      ),
    )
    await prepare(w)
    const seen = seenAtInstall(w)
    expect((await testPin(w, ['--key', 'lodash'])).status).toBe(0)
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({ name: 'demo-npm' })
  })

  it('records a pin whose install fails inconclusive, and the next pin runs on a restored tree', async () => {
    const w = world('npm-v3')
    await prepare(w)
    installs(
      w,
      "printf 'npm ERR! ERESOLVE could not resolve\\n' >&2\nprintf 'garbage\\n' > package-lock.json\n",
      1,
    )
    const failedPin = finding(await testPin(w, ['--key', 'lodash']))
    expect({
      status: failedPin.status,
      tested: failedPin.tested,
      detail: failedPin.detail,
      reason: failedPin.collateral_not_checked_reason,
    }).toEqual({
      status: 'inconclusive',
      tested: false,
      detail:
        'the install without this pin failed, so nothing about the removal was observed: \nRunning: npm install\nnpm ERR! ERESOLVE could not resolve',
      reason: 'this pin was not tested to completion, so no other package in the tree was compared',
    })
    expect(GIT_CLEAN(w)).toBe('')
    installs(w, '')
    expect(finding(await testPin(w, ['--path', '["test-exclude","lodash"]'])).status).toBe('tested')
  })

  it('records a lockfile that does not parse after the removal inconclusive, tested', async () => {
    const w = world('npm-v3')
    await prepare(w)
    const found = finding(
      await testPin(w, ['--key', 'lodash'], stand({ resolvedVersions: FAIL('cannot parse') })),
    )
    expect({ status: found.status, tested: found.tested, detail: found.detail }).toEqual({
      status: 'inconclusive',
      tested: true,
      detail:
        'the lockfile could not be parsed for this package after the removal, and a failed parse is never an empty result: cannot parse',
    })
    expect(GIT_CLEAN(w)).toBe('')
  })

  it('stops the pin rather than reporting an empty delta from an unread list', async () => {
    const w = world('npm-v3')
    await prepare(w)
    const answer = await testPin(
      w,
      ['--key', 'lodash'],
      stand({ resolvedVersions: answers({ present: true }) }),
    )
    expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'install' })
    expect((answer.json as { detail: string }).detail).toContain(
      'resolved_versions lodash (after removing lodash) answered a versions list this flow cannot read',
    )
    expect(stateOf(w).findings).toEqual([])
  })

  it('reads present: false after the removal as the package leaving the tree', async () => {
    const w = world('npm-v3')
    await prepare(w)
    const gone = {
      pm: 'npm',
      package: 'lodash',
      present: false,
      count: 0,
      versions: [],
      lockfile_entries: 6,
    }
    const route = stand({
      resolvedVersions: answers(gone),
      resolutionMap: (tree) => {
        const real = node.resolutionMap(tree)
        if (real.outcome !== 'ok') return real
        const { lodash: _lodash, ...rest } = real.value.resolutions
        return ok({ ...real.value, resolutions: rest }) as never
      },
    })
    const found = finding(await testPin(w, ['--key', 'lodash'], route))
    expect({
      left: found.left_tree,
      delta: found.attributable_versions,
      detail: found.detail,
    }).toEqual({
      left: true,
      delta: [],
      detail:
        'the package is no longer resolved at all: removing this pin took it out of the tree entirely, so nothing new resolved to judge',
    })
  })

  describe('the whole-tree map', () => {
    const partial = (tree: Parameters<Adapter<NodeDetection>['resolutionMap']>[0]) => {
      const real = node.resolutionMap(tree)
      return (real.outcome === 'ok' ? ok({ ...real.value, unreadable_entries: 3 }) : real) as never
    }

    it('maps a partial map onto null collateral and not-checked, naming the counts', async () => {
      const w = world('npm-v3')
      expect((await list(w)).status).toBe(0)
      expect(pick(await baseline(w, stand({ resolutionMap: partial })), 'whole_tree_view')).toEqual(
        {
          status: 0,
          whole_tree_view: false,
        },
      )
      const found = finding(
        await testPin(w, ['--key', 'lodash'], stand({ resolutionMap: partial })),
      )
      expect({
        c: found.collateral_changes,
        v: found.collateral_verdict,
        w: found.whole_tree_view,
        r: found.collateral_not_checked_reason,
        u: found.unreadable_entries,
      }).toEqual({
        c: null,
        v: 'not-checked',
        w: false,
        r: 'the resolution_map could not read 3 lockfile entries at the baseline and 3 after this removal, so it is not a whole-tree view',
        u: { baseline: 3, without_pin: 3 },
      })
    })

    it.each([
      ['the baseline', 3, 0],
      ['the map after the removal', 0, 3],
    ])('is no whole-tree view when only %s is partial', async (_name, before, after) => {
      const w = world('npm-v3')
      const at = (count: number) => (count === 0 ? undefined : stand({ resolutionMap: partial }))
      await prepare(w, at(before))
      const found = finding(await testPin(w, ['--key', 'lodash'], at(after)))
      expect({
        c: found.collateral_changes,
        v: found.collateral_verdict,
        w: found.whole_tree_view,
        r: found.collateral_not_checked_reason,
      }).toEqual({
        c: null,
        v: 'not-checked',
        w: false,
        r: `the resolution_map could not read ${before} lockfile entries at the baseline and ${after} after this removal, so it is not a whole-tree view`,
      })
    })

    it('reads a map_available of the state that is the text "true" as no map', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.map_available = 'true'
      })
      expect(finding(await testPin(w, ['--key', 'lodash'])).collateral_not_checked_reason).toBe(
        "the with-all-pins baseline found no whole-tree resolution_map, so no other package's resolution was re-checked",
      )
    })

    it('records a map refusal after the removal as a refusal, quoting the adapter', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const found = finding(
        await testPin(w, ['--key', 'lodash'], stand({ resolutionMap: FAIL('refused') })),
      )
      expect({
        v: found.collateral_verdict,
        r: found.collateral_not_checked_reason,
        u: found.unreadable_entries,
      }).toEqual({
        v: 'not-checked',
        r: 'resolution_map refused this lockfile after removing lodash: refused',
        u: { baseline: 0, without_pin: null },
      })
    })

    it('records a map that is not implemented after the removal as one', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const route = stand({ resolutionMap: () => notImplemented('resolution_map') as never })
      expect(
        finding(await testPin(w, ['--key', 'lodash'], route)).collateral_not_checked_reason,
      ).toBe(
        "the adapter does not implement resolution_map, so no other package's resolution was re-checked",
      )
    })

    it('gives the reason of the baseline when there was no map, and null counts', async () => {
      const w = world('npm-v3')
      const route = stand({ resolutionMap: () => notImplemented('resolution_map') as never })
      await prepare(w, route)
      const found = finding(await testPin(w, ['--key', 'lodash'], route))
      expect({
        r: found.collateral_not_checked_reason,
        u: found.unreadable_entries,
        c: found.collateral_changes,
      }).toEqual({
        r: "the adapter does not implement resolution_map, so no other package's resolution was re-checked",
        u: { baseline: null, without_pin: null },
        c: null,
      })
    })

    it('gives its own reason when the state has no map and no refusal', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.map_available = false
      })
      expect(finding(await testPin(w, ['--key', 'lodash'])).collateral_not_checked_reason).toBe(
        "the with-all-pins baseline found no whole-tree resolution_map, so no other package's resolution was re-checked",
      )
    })

    it('reports a baseline count that the state does not hold as null, never as a checked zero', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        delete state.baseline_unreadable_entries
      })
      const found = finding(await testPin(w, ['--key', 'lodash']))
      expect({
        u: found.unreadable_entries,
        v: found.collateral_verdict,
        r: found.collateral_not_checked_reason,
      }).toEqual({
        u: { baseline: null, without_pin: 0 },
        v: 'not-checked',
        r: 'the resolution_map could not read  lockfile entries at the baseline and 0 after this removal, so it is not a whole-tree view',
      })
    })

    it('stops on a map after the removal whose unreadable_entries is absent', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const answer = await testPin(
        w,
        ['--key', 'lodash'],
        stand({ resolutionMap: answers({ resolutions: {} }) }),
      )
      expect((answer.json as { detail: string }).detail).toBe(
        'the resolution_map taken after removing lodash emitted no \'unreadable_entries\' field. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); read straight, an absent field arrives as the string "null" and takes a branch of its own instead of failing.',
      )
    })

    it.each([
      ['no resolutions', { unreadable_entries: 0 }],
      ['a package with no list', { unreadable_entries: 0, resolutions: { lodash: null } }],
    ])('stops on a map after the removal with %s, and restores', async (_name, map) => {
      const w = world('npm-v3')
      await prepare(w)
      const answer = await testPin(w, ['--key', 'lodash'], stand({ resolutionMap: answers(map) }))
      expect((answer.json as { detail: string }).detail).toBe(
        'the resolution_map taken after removing lodash carries no resolutions object with a list of versions for each package, so there is nothing to diff this removal against.',
      )
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('stops when the baseline map of the state cannot be diffed', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.baseline_map = { resolutions: 'x' }
      })
      expect((await testPin(w, ['--key', 'lodash'])).json).toEqual({
        status: 'failure',
        phase: 'install',
        detail: "this pin's finding could not be assembled, so nothing was recorded for it.",
      })
    })

    it('stops when the state has a map but no baseline map to diff', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.baseline_map = null
      })
      expect(((await testPin(w, ['--key', 'lodash'])).json as { detail: string }).detail).toBe(
        "this pin's finding could not be assembled, so nothing was recorded for it.",
      )
    })

    it('refuses a baseline map of the state that is not an object or null', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.baseline_map = 'x'
      })
      expect(((await testPin(w, ['--key', 'lodash'])).json as { detail: string }).detail).toBe(
        'the with-all-pins baseline resolution_map is in the state file but is not the shape the step that wrote it promised (expected: type == "object" or type == "null"). An earlier step failed part-way, or the file was edited by hand. Value: "x"',
      )
    })

    it('samples a platform-binary family that moves as one unit', async () => {
      const w = world('npm-v3', (repo) => {
        const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'))
        for (const name of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
          lock.packages[`node_modules/@esbuild/${name}`] = { version: '0.21.0' }
        }
        writeFileSync(join(repo, 'package-lock.json'), JSON.stringify(lock))
      })
      await prepare(w)
      installs(
        w,
        "sed -e 's/0.21.0/0.23.1/g' package-lock.json > l.tmp\nmv l.tmp package-lock.json\n",
      )
      const found = finding(await testPin(w, ['--key', 'lodash']))
      expect({
        judged: (found.collateral_changes as { package: string; judged: boolean }[])
          .filter((change) => change.judged)
          .map((change) => change.package),
        families: found.sampled_families,
      }).toEqual({
        judged: ['@esbuild/darwin-arm64'],
        families: [
          {
            key: '@esbuild/',
            size: 3,
            members: ['@esbuild/darwin-arm64', '@esbuild/linux-x64', '@esbuild/win32-x64'],
            sample: '@esbuild/darwin-arm64',
            shared_version: '0.23.1',
          },
        ],
      })
    })
  })

  describe('the two verbs must agree about the tested package', () => {
    const ALIAS_DETAIL =
      'this pin is keyed on an npm: alias of the package named in its value, so the map holds ' +
      'that copy under the real package name \u2014 the name an advisory query needs \u2014 while ' +
      'resolved_versions answers under both. The map therefore has no entry for the key this pin ' +
      'uses, and the two views cannot be compared under one name (#46).'

    it('reports an alias-keyed pin inconclusive on [] against a non-empty list', async () => {
      const w = world('npm-alias')
      await prepare(w)
      const found = finding(await testPin(w, ['--key', 'lodash-alias']))
      expect({
        status: found.status,
        tested: found.tested,
        disagreement: found.disagreement,
        detail: found.detail,
        with: found.resolved_with_pin,
        without: found.resolved_without_pin,
        delta: found.attributable_versions,
      }).toEqual({
        status: 'inconclusive',
        tested: true,
        disagreement: {
          shape: 'alias-key',
          map: [],
          resolved_versions: ['4.18.1'],
          detail: ALIAS_DETAIL,
        },
        detail: ALIAS_DETAIL,
        with: ['4.18.1'],
        without: ['4.18.1'],
        delta: null,
      })
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('normalizes both sides, so one version at two paths is not a disagreement', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const twice = {
        pm: 'npm',
        package: 'lodash',
        present: true,
        count: 3,
        versions: [
          { version: '4.17.21', path: 'node_modules/lodash' },
          { version: '4.17.21', path: 'node_modules/x/node_modules/lodash' },
          { version: '3.10.1', path: 'node_modules/test-exclude/node_modules/lodash' },
        ],
        lockfile_entries: 6,
      }
      const found = finding(
        await testPin(w, ['--key', 'lodash'], stand({ resolvedVersions: answers(twice) })),
      )
      expect({ status: found.status, disagreement: found.disagreement ?? null }).toEqual({
        status: 'tested',
        disagreement: null,
      })
    })
  })

  describe('the removal is verified before anything installs', () => {
    it('fails when list_pins still carries the entry after the removal, and never installs', async () => {
      const w = world('npm-v3')
      await prepare(w)
      // The pins of HEAD, as if the removal had matched nothing.
      const detection = node.detect(w.repo, w.env)
      const head =
        detection.outcome === 'ok'
          ? node.listPins({ root: w.repo, detection: detection.value })
          : detection
      const answer = await testPin(w, ['--key', 'lodash'], stand({ listPins: () => head }))
      expect(answer).toEqual({
        status: 3,
        json: {
          status: 'failure',
          phase: 'install',
          detail:
            'the entry at ["lodash"] is still present after the removal of lodash, so the install would have been an install of the manifest this audit started with and the verdict would have read as a tested removal.',
        },
      })
      expect(installCount(w)).toBe(1)
      expect(GIT_CLEAN(w)).toBe('')
    })

    it.each([
      ['a pins that is not a list', { count: 1, pins: null }],
      ['a pin that is not an object', { count: 1, pins: ['x'] }],
    ])('reads %s after the removal as the entry still there', async (_name, payload) => {
      const w = world('npm-v3')
      await prepare(w)
      const answer = await testPin(w, ['--key', 'lodash'], stand({ listPins: answers(payload) }))
      expect((answer.json as { detail: string }).detail).toMatch(
        /^the entry at \["lodash"\] is still present/,
      )
    })

    it('reads a null pin after the removal as jq does: not the pin', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const answer = await testPin(
        w,
        ['--key', 'lodash'],
        stand({
          listPins: listPinsWith((real) => ({ ...real, count: 1, pins: [null] })),
        }),
      )
      expect(finding(answer).status).toBe('tested')
    })

    it.each([
      ['fell by two', (count: number): unknown => count - 1, '0'],
      ['did not fall', (count: number): unknown => count + 1, '2'],
      ['is the text of one less', (count: number): unknown => String(count), '1'],
    ])('fails, and restores, when the count %s', async (_name, change, left) => {
      const w = world('npm-v3')
      await prepare(w)
      const answer = await testPin(
        w,
        ['--key', 'lodash'],
        stand({ listPins: listPinsWith((real) => ({ ...real, count: change(real.count) })) }),
      )
      expect((answer.json as { detail: string }).detail).toBe(
        `removing lodash left ${left} pins where phase 2 counted 2, and one less is 1. An edit that silently matched nothing, or that matched a similar key elsewhere in the manifest, produces exactly this.`,
      )
      expect(installCount(w)).toBe(1)
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('fails when list_pins fails after the removal, and restores', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const answer = await testPin(w, ['--key', 'lodash'], stand({ listPins: FAIL('broken') }))
      expect((answer.json as { detail: string }).detail).toBe(
        'list_pins failed after removing lodash: broken',
      )
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('fails when detect fails after the removal, and the restore brings the lockfile back', async () => {
      const w = world('npm-v3')
      await prepare(w)
      rmSync(join(w.wt, 'package-lock.json'))
      const answer = await testPin(w, ['--key', 'lodash'])
      expect((answer.json as { detail: string }).detail).toMatch(
        /^list_pins failed after removing lodash: No supported lockfile found in /,
      )
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('fails when list_pins answers no count after the removal', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const answer = await testPin(
        w,
        ['--key', 'lodash'],
        stand({ listPins: answers({ pins: [] }) }),
      )
      expect((answer.json as { detail: string }).detail).toMatch(
        /^list_pins \(after removing lodash\) emitted no 'count' field/,
      )
    })

    it('stops on a manifest that does not parse, and leaves it matching HEAD', async () => {
      const w = world('npm-v3')
      await prepare(w)
      writeFileSync(
        join(w.wt, 'package.json'),
        '{"name":"app","overrides":{"lodash":"^4.17.21",}\n',
      )
      const answer = await testPin(w, ['--key', 'lodash'])
      expect(pick(answer, 'phase')).toEqual({ status: 3, phase: 'install' })
      expect((answer.json as { detail: string }).detail).toMatch(
        /^package\.json could not be rewritten to remove \["lodash"\], so the manifest does not parse .* Quoting the error: .*JSON/,
      )
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('refuses an override root of the state that is not a list', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.override_root = 'overrides'
      })
      expect(((await testPin(w, ['--key', 'lodash'])).json as { detail: string }).detail).toMatch(
        /^the override block's address is in the state file but is not the shape/,
      )
    })
  })

  describe('the restore between pins', () => {
    it('returns the manifest to HEAD even when the index holds the removal', async () => {
      const w = world('npm-v3')
      await prepare(w)
      installs(w, 'git add package.json\n')
      expect((await testPin(w, ['--key', 'lodash'])).status).toBe(0)
      expect(w.fixtures.tryGit(w.wt, 'diff', '--quiet', 'HEAD', '--', 'package.json').status).toBe(
        0,
      )
    })

    it('checks the restore against HEAD, not against the index', async () => {
      const w = world('npm-v3')
      await prepare(w)
      installs(w, 'git add package.json\n')
      const shim = w.fixtures.gitShim()
      const env = { ...w.env, PATH: `${shim.directory}:${w.env.PATH}`, GIT_STUB_SILENT: 'checkout' }
      expect(pick(await testPin(w, ['--key', 'lodash'], undefined, env), 'phase')).toEqual({
        status: 3,
        phase: 'restore',
      })
    })

    it('ends the run, phase restore, when the restore cannot be verified', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.lockfile = 'yarn.lock'
      })
      expect(await testPin(w, ['--key', 'lodash'])).toEqual({
        status: 3,
        json: {
          status: 'failure',
          phase: 'restore',
          detail:
            "the worktree could not be returned to its pre-pin state after testing lodash, so every later pin would have been tested against a manifest still carrying this removal. git checkout said: error: pathspec 'yarn.lock' did not match any file(s) known to git. git status --porcelain -- package.json yarn.lock:  M package.json",
        },
      })
    })

    it('names a checkout that said nothing', async () => {
      const w = world('npm-v3')
      await prepare(w)
      const shim = w.fixtures.gitShim()
      const env = { ...w.env, PATH: `${shim.directory}:${w.env.PATH}`, GIT_STUB_SILENT: 'checkout' }
      const answer = await testPin(w, ['--key', 'lodash'], undefined, env)
      expect((answer.json as { detail: string }).detail).toContain('git checkout said: <nothing>.')
    })

    it('refuses a state with no lockfile', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        delete state.lockfile
      })
      expect(((await testPin(w, ['--key', 'lodash'])).json as { error: string }).error).toContain(
        "has no usable value for 'lockfile'",
      )
    })
  })

  describe('the override file the edits target (issue #159)', () => {
    const presentPins = (repo: string) =>
      writeFileSync(
        join(repo, 'pnpm-workspace.yaml'),
        "packages:\n  - packages/*\n\noverrides:\n  minimatch: '>=10.2.5'\n  \"brace-expansion\": '>=5.0.5'\n",
      )

    it('edits pnpm-workspace.yaml, leaves each other line, and restores both files', async () => {
      const w = world('pnpm11-workspace-overrides', presentPins)
      await prepare(w)
      const seen = seenAtInstall(w, 'pnpm-workspace.yaml')
      expect(finding(await testPin(w, ['--key', 'minimatch'])).status).toBe('tested')
      expect(readFileSync(seen, 'utf8')).toBe(
        'packages:\n  - packages/*\n\noverrides:\n  "brace-expansion": \'>=5.0.5\'\n',
      )
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('restores package.json as well as the workspace file', async () => {
      const w = world('pnpm11-workspace-overrides', presentPins)
      await prepare(w)
      installs(w, 'echo " " >> package.json\n')
      expect(finding(await testPin(w, ['--key', 'minimatch'])).status).toBe('tested')
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('reports a missing workspace entry as missing, not as an unreadable block', async () => {
      const w = world('pnpm11-workspace-overrides', presentPins)
      await prepare(w)
      writeFileSync(
        join(w.wt, 'pnpm-workspace.yaml'),
        'overrides:\n  "brace-expansion": \'>=5.0.5\'\n',
      )
      expect(((await testPin(w, ['--key', 'minimatch'])).json as { detail: string }).detail).toBe(
        "the pnpm-workspace.yaml overrides block carries no entry 'minimatch', so nothing was removed and an install of it would have been an install of the manifest this audit started with.",
      )
      expect(GIT_CLEAN(w)).toBe('')
    })

    it('still reports a block it cannot read as a block it cannot read', async () => {
      const w = world('pnpm11-workspace-overrides', presentPins)
      await prepare(w)
      writeFileSync(join(w.wt, 'pnpm-workspace.yaml'), "overrides:\n  minimatch\n  ws: '1'\n")
      expect(
        ((await testPin(w, ['--key', 'minimatch'])).json as { detail: string }).detail,
      ).toMatch(
        /^the pnpm-workspace.yaml overrides block could not be edited to remove 'minimatch'\. /,
      )
    })
  })

  describe('the refusals of test-pin', () => {
    it.each([
      [['--key', 'nope'], "test-pin: no testable pin with key 'nope'"],
      [['--path', 'not-json'], 'test-pin: --path must be a JSON array, as list_pins reports it'],
      [['--path', '{"a":1}'], 'test-pin: --path must be a JSON array, as list_pins reports it'],
      [['--path', '["nope"]'], 'test-pin: no testable pin at path ["nope"]'],
      [[], 'test-pin requires --key or --path'],
      [['--bogus'], "Unknown option '--bogus'"],
    ])('refuses %j', async (args, error) => {
      const w = world('npm-v3')
      await prepare(w)
      expect(await testPin(w, args)).toEqual({ status: 1, json: { error } })
    })

    it('requires --work', async () => {
      const w = world('npm-v3')
      expect(await call(w, ['test-pin', '--key', 'x'])).toEqual({
        status: 1,
        json: { error: 'test-pin: --work is required' },
      })
    })

    it('takes --path over --key', async () => {
      const w = world('npm-v3')
      await prepare(w)
      expect(finding(await testPin(w, ['--key', 'nope', '--path', '["lodash"]'])).key).toBe(
        'lodash',
      )
    })

    it.each([false, 'true'])(
      'refuses to run before baseline, on a baseline_done of %j',
      async (done) => {
        const w = world('npm-v3')
        await list(w)
        editState(w, (state) => {
          state.baseline_done = done
        })
        expect(await testPin(w, ['--key', 'lodash'])).toEqual({
          status: 1,
          json: {
            error:
              "test-pin: run 'baseline' first. Without the with-all-pins baseline there is nothing to measure a removal against.",
          },
        })
      },
    )

    it('refuses a key that names two pins', async () => {
      const w = world('npm-v3', (repo) =>
        writeFileSync(
          join(repo, 'package.json'),
          '{"name":"demo-npm","overrides":{"test-exclude":{".":"^6.0.0","lodash":"3.10.1"}}}\n',
        ),
      )
      await prepare(w)
      expect(await testPin(w, ['--key', 'test-exclude'])).toEqual({
        status: 1,
        json: {
          error:
            "test-pin: 'test-exclude' names 2 pins in this manifest, so it does not identify one. Pass --path with the pin's own path array, which list_pins reports.",
        },
      })
      expect(finding(await testPin(w, ['--path', '["test-exclude","."]'])).status).toBe('tested')
      await testPin(w, ['--path', '["test-exclude","lodash"]'])
      expect((stateOf(w).findings as { path: JsonValue }[]).map((each) => each.path)).toEqual([
        ['test-exclude', '.'],
        ['test-exclude', 'lodash'],
      ])
    })

    it('refuses a state whose pins_count is absent or not a number', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.pins_count = '2'
      })
      expect(await testPin(w, ['--key', 'lodash'])).toEqual({
        status: 1,
        json: {
          error: `the state file at ${w.work}/state.json has no usable value for 'pins_count': expected a number, found "2".`,
        },
      })
      editState(w, (state) => {
        delete state.pins_count
      })
      expect(((await testPin(w, ['--key', 'lodash'])).json as { error: string }).error).toContain(
        "has no usable value for 'pins_count'. Run the earlier steps first",
      )
    })

    it.each([
      ['baseline_inconclusive', 'x', "the baseline's inconclusive list"],
      ['baseline_packages', 'x', 'the with-all-pins baseline snapshots'],
      [
        'findings',
        [{ status: 'tested', attributable_versions: 'x' }],
        'the findings recorded so far',
      ],
    ])(
      'refuses a %s that is not the shape list and baseline wrote',
      async (key, value, description) => {
        const w = world('npm-v3')
        await prepare(w)
        editState(w, (state) => {
          state[key] = value as JsonValue
        })
        expect(((await testPin(w, ['--key', 'lodash'])).json as { detail: string }).detail).toMatch(
          new RegExp(`^${description} is in the state file but is not the shape`),
        )
      },
    )

    it.each([
      ['an entry that is not an object', ['x'], 1],
      ['a null entry', [null], 0],
    ])('reads a baseline_inconclusive with %s as jq does', async (_name, refused, status) => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.baseline_inconclusive = refused
      })
      expect(await testPin(w, ['--key', 'lodash'])).toEqual(
        status === 0
          ? expect.objectContaining({ status: 0 })
          : {
              status: 1,
              json: {
                error:
                  "test-pin: the baseline recorded lodash inconclusive (present: false), so this pin is not tested. Recording it and never testing it is the baseline's answer, not a step to redo.",
              },
            },
      )
    })

    it('reads a null entry beside the snapshot of the baseline as jq does', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.baseline_packages = [
          null,
          { package: 'lodash', present: true, versions: ['3.10.1', '4.17.21'] },
        ]
      })
      expect(finding(await testPin(w, ['--key', 'lodash'])).status).toBe('tested')
    })

    it('reads a baseline_unreadable_entries below zero as no count', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.baseline_unreadable_entries = -1
      })
      const found = finding(await testPin(w, ['--key', 'lodash']))
      expect({ u: found.unreadable_entries, w: found.whole_tree_view }).toEqual({
        u: { baseline: null, without_pin: 0 },
        w: false,
      })
    })

    it('reads a state with no env_prefix as no prefix', async () => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        delete state.env_prefix
      })
      expect(finding(await testPin(w, ['--key', 'lodash'])).status).toBe('tested')
    })

    it.each([
      ['no snapshot', []],
      ['a snapshot that is not an object', ['x']],
      [
        'an entry that is not an object beside its snapshot',
        ['x', { package: 'lodash', present: true, versions: ['3.10.1', '4.17.21'] }],
      ],
      ['a snapshot with no versions list', [{ package: 'lodash', versions: null }]],
      ['a snapshot whose versions is text', [{ package: 'lodash', versions: 'x' }]],
    ])('stops the pin when the baseline holds %s for its package', async (_name, packages) => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.baseline_packages = packages as JsonValue
      })
      expect(((await testPin(w, ['--key', 'lodash'])).json as { detail: string }).detail).toMatch(
        /^the with-all-pins baseline holds no snapshot for lodash/,
      )
    })
  })

  describe('the shape of the findings on file', () => {
    it.each([
      [
        'a finding that is not tested, whatever it holds',
        [{ path: ['x'], status: 'inconclusive', attributable_versions: 1 }],
      ],
      [
        'a tested finding with no collateral',
        [{ path: ['x'], status: 'tested', attributable_versions: ['1'] }],
      ],
      [
        'a tested finding with good collateral',
        [
          {
            path: ['x'],
            status: 'tested',
            attributable_versions: [],
            collateral_changes: [{ judged: true, package: 'a', newly_admitted: [] }],
          },
        ],
      ],
    ])('takes %s', async (_name, findings) => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.findings = findings as JsonValue
      })
      expect((await testPin(w, ['--key', 'lodash'])).status).toBe(0)
      expect((stateOf(w).findings as JsonValue[]).length).toBe(2)
    })

    it.each([
      ['not a list', {}],
      ['a finding that is not an object', ['x']],
      ['attributable_versions not a list', [{ status: 'tested', attributable_versions: 'x' }]],
      ['attributable_versions of other values', [{ status: 'tested', attributable_versions: [1] }]],
      [
        'collateral that is an object',
        [{ status: 'tested', attributable_versions: [], collateral_changes: {} }],
      ],
      [
        'collateral that is not an object',
        [{ status: 'tested', attributable_versions: [], collateral_changes: ['x'] }],
      ],
      [
        'collateral with no boolean judged',
        [
          {
            status: 'tested',
            attributable_versions: [],
            collateral_changes: [{ judged: 'yes', package: 'a', newly_admitted: [] }],
          },
        ],
      ],
      [
        'collateral with no package text',
        [
          {
            status: 'tested',
            attributable_versions: [],
            collateral_changes: [{ judged: true, package: 1, newly_admitted: [] }],
          },
        ],
      ],
      [
        'collateral with no newly_admitted list',
        [
          {
            status: 'tested',
            attributable_versions: [],
            collateral_changes: [{ judged: true, package: 'a', newly_admitted: 'x' }],
          },
        ],
      ],
    ])('refuses findings with %s, before the restore', async (_name, findings) => {
      const w = world('npm-v3')
      await prepare(w)
      editState(w, (state) => {
        state.findings = findings as JsonValue
      })
      expect(((await testPin(w, ['--key', 'lodash'])).json as { detail: string }).detail).toMatch(
        /^the findings recorded so far is in the state file but is not the shape the step that wrote it promised \(expected: type == "array"\n {2}and all/,
      )
    })
  })
})
