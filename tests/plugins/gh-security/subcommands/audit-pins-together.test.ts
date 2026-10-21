// `gh-security audit-pins together`. The seam is the exported handler, with
// the runner, the registry and the `gh` client factory as parameters. These
// are the `together` examples of `spec/audit_driver_judge_spec.sh` (deleted in
// #236), and the branches that only the port has.
//
// git is real: each example runs in a linked worktree of a repository from
// `harness/git.ts`, over a lockfile specimen of `spec/fixtures/`. `list` and
// `baseline` run for real. The findings that `judge` would leave are then
// written into the state, because what these examples are about is what a
// set of removals does. The package manager is a stand-in on PATH, because an
// install reaches the network (`mocking.md`). `gh` is mocked through
// `createGhMock`. Where an example needs an adapter answer that the real
// adapter never gives, the adapter is the real one with one verb replaced,
// through the registry parameter. The expected values are written by hand
// from the contract in the header of `audit-pins.ts`.
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
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, failed, type JsonValue, ok } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { auditPins } from '#gh-security/subcommands/audit-pins.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'

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
  readonly fixtures: GitFixtures
  readonly work: string
  readonly wt: string
  readonly pmDir: string
  readonly env: NodeJS.ProcessEnv
}

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
  return { fixtures, work, wt, pmDir, env: sandbox.env }
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

type Route = typeof selectAdapter

interface Options {
  readonly route?: Route
  readonly replies?: GhReplies
  readonly env?: NodeJS.ProcessEnv
}

const call = async (w: World, args: readonly string[], options: Options = {}): Promise<Answer> =>
  answerOf(
    await auditPins(
      {
        args,
        env: options.env ?? w.env,
        io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
        commandNames: [],
      },
      {
        spawn: run,
        route: options.route ?? selectAdapter,
        makeClient: () => createGhMock(options.replies ?? {}),
      },
    ),
  )

const together = (w: World, options?: Options) => call(w, ['together', '--work', w.work], options)

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

const installCount = (w: World): number =>
  existsSync(join(w.pmDir, 'install.n'))
    ? Number(readFileSync(join(w.pmDir, 'install.n'), 'utf8'))
    : 0

/** `git status --porcelain`, which the harness gives with no white space at the ends. */
const porcelain = (w: World) => w.fixtures.git(w.wt, 'status', '--porcelain')

const manifest = (w: World): Record<string, JsonValue> =>
  JSON.parse(readFileSync(join(w.wt, 'package.json'), 'utf8')) as Record<string, JsonValue>

/** A route to the real node adapter with some verbs replaced. */
const stand = (verbs: Partial<Adapter<NodeDetection>>): Route =>
  ((ecosystem: string) => ({
    supported: true,
    ecosystem,
    name: 'node',
    adapter: { ...node, ...verbs },
    manifest: null,
  })) as Route

const LODASH = { key: 'lodash', path: ['lodash'], package: 'lodash', value: '^4.17.21' }
const TEST_EXCLUDE = {
  key: 'test-exclude',
  path: ['test-exclude', 'lodash'],
  package: 'lodash',
  value: '3.10.1',
}

/** `list` and `baseline` for real, then the findings that `judge` would leave. */
const judged = async (w: World, findings: JsonValue[], extra: Record<string, JsonValue> = {}) => {
  expect((await call(w, ['list', '--work', w.work, '--worktree', w.wt])).status).toBe(0)
  expect((await call(w, ['baseline', '--work', w.work])).status).toBe(0)
  editState(w, (state) => {
    Object.assign(state, { findings, judge_done: true, ...extra })
  })
}

/** Both pins of npm-v3, removable on their own, so attempt 2 is the bare pin alone. */
const TWO = [
  { ...LODASH, status: 'removable' },
  { ...TEST_EXCLUDE, status: 'removable-individually' },
]

const adv = (id: string, name: string, range: string): Record<string, unknown> => ({
  ghsa_id: id,
  cve_id: null,
  severity: 'high',
  type: 'reviewed',
  withdrawn_at: null,
  published_at: '2021-02-15T00:00:00Z',
  summary: `summary of ${id}`,
  html_url: `https://github.com/advisories/${id}`,
  vulnerabilities: [
    {
      package: { ecosystem: 'npm', name },
      vulnerable_version_range: range,
      first_patched_version: null,
    },
  ],
})

const EXPRESS_OLD = { listAdvisories: [adv('GHSA-eeee-5555-ffff', 'express', '< 4.18.0')] }

/** Move express down at the install whose count is `n`, or at each install. */
const expressDown = (n?: number) => {
  const sed =
    'sed -e \'s/"version": "4.18.2"/"version": "4.17.0"/\' package-lock.json > l.tmp\nmv l.tmp package-lock.json\n'
  return n === undefined ? sed : `if [ "$n" = ${n} ]; then\n${sed}fi\n`
}

const SEEN = 'cp package.json "$PM_DIR/seen-$n"\n'
const seen = (w: World, n: number) =>
  JSON.parse(readFileSync(join(w.pmDir, `seen-${n}`), 'utf8')) as Record<string, JsonValue>

const ADMITTED_EXPRESS = 'attempt 1 admitted express 4.17.0 (vulnerable via < 4.18.0)'

const compose = (detail: string): Answer => ({
  status: 3,
  json: { status: 'failure', phase: 'compose', detail },
})

describe('together (phase 7)', () => {
  it('installs the whole set as attempt 1, and leaves the removals for phase 8', async () => {
    const w = world()
    await judged(w, TWO)
    installs(w, SEEN)
    expect(await together(w)).toEqual({
      status: 0,
      json: {
        status: 'ready_for_pr',
        step: 'together',
        attempt: 1,
        removed_keys: ['lodash', 'test-exclude'],
        removed: [
          { ...LODASH, status: 'removable' },
          { ...TEST_EXCLUDE, status: 'removable-individually' },
        ],
        left_behind: [],
        collateral: [],
        advisory_verdicts: [],
        lockfile: 'package-lock.json',
        override_file: 'package.json',
      },
    })
    expect(seen(w, 2).overrides).toBeUndefined()
    expect(manifest(w).overrides).toBeUndefined()
    expect(porcelain(w)).toBe('M package.json')
  })

  // jq's `{key, path, package, value, status}` gives null for an absent key.
  it('picks an absent key or value of a finding as null', async () => {
    const w = world()
    await judged(w, [{ path: ['lodash'], package: 'lodash', status: 'removable' }])
    const json = (await together(w)).json as Record<string, JsonValue>
    expect({ keys: json.removed_keys, removed: json.removed }).toEqual({
      keys: [null],
      removed: [
        { key: null, path: ['lodash'], package: 'lodash', value: null, status: 'removable' },
      ],
    })
  })

  // The bash names the versions after the removal of a set `without_pins`
  // (`run_attempt`), and those of one pin `without_pin` (`test-pin`).
  it('reports the moves of a clean attempt, and the advisory answer of each', async () => {
    const w = world()
    await judged(w, TWO)
    installs(w, expressDown())
    const answer = await together(w, {
      replies: { listAdvisories: [adv('GHSA-eeee-5555-ffff', 'express', '< 4.0.0')] },
    })
    const json = answer.json as Record<string, JsonValue>
    expect({ collateral: json.collateral, verdicts: json.advisory_verdicts }).toEqual({
      collateral: [
        {
          package: 'express',
          baseline: ['4.18.2'],
          without_pins: ['4.17.0'],
          newly_admitted: ['4.17.0'],
        },
      ],
      verdicts: [{ package: 'express', version: '4.17.0', verdict: 'safe', matched_ranges: [] }],
    })
  })

  it('narrows to the removable pins when attempt 1 is dirty, restoring the tree between', async () => {
    const w = world()
    await judged(w, TWO)
    installs(w, `${SEEN}${expressDown(2)}`)
    expect(await together(w, { replies: EXPRESS_OLD })).toEqual({
      status: 0,
      json: {
        status: 'ready_for_pr',
        step: 'together',
        attempt: 2,
        removed_keys: ['lodash'],
        removed: [{ ...LODASH, status: 'removable' }],
        left_behind: [
          { key: 'test-exclude', reason: `${ADMITTED_EXPRESS}; excluded from attempt 2` },
        ],
        collateral: [],
        advisory_verdicts: [],
        lockfile: 'package-lock.json',
        override_file: 'package.json',
      },
    })
    // Attempt 2 saw the manifest of HEAD without only its own removal.
    expect(seen(w, 3).overrides).toEqual({ 'test-exclude': { lodash: '3.10.1' } })
    expect(manifest(w).overrides).toEqual({ 'test-exclude': { lodash: '3.10.1' } })
    expect(installCount(w)).toBe(3)
  })

  it('reports both attempts failing as a finding, and restores the tree', async () => {
    const w = world()
    await judged(w, TWO)
    installs(w, expressDown())
    expect(await together(w, { replies: EXPRESS_OLD })).toEqual({
      status: 0,
      json: {
        status: 'combined_failed',
        step: 'together',
        attempt: 2,
        pr_skipped_reason: 'combined test failed',
        pr_skipped_detail: `${ADMITTED_EXPRESS}; attempt 2 admitted express 4.17.0 (vulnerable via < 4.18.0)`,
      },
    })
    expect(porcelain(w)).toBe('')
  })

  it('reads a version that is not safe as dirty, with no ranges to name', async () => {
    const w = world()
    await judged(w, [
      { ...LODASH, status: 'removable' },
      { ...TEST_EXCLUDE, status: 'removable' },
    ])
    installs(w, expressDown())
    expect((await together(w, { replies: { listAdvisories: [] } })).json).toEqual({
      status: 'combined_failed',
      step: 'together',
      attempt: 1,
      pr_skipped_reason: 'combined test failed',
      pr_skipped_detail:
        "attempt 1 admitted express 4.17.0 (no-advisories); attempt 2 was not run: no finding was removable-individually, so its set is attempt 1's set and narrowing had nothing to drop",
    })
    expect(installCount(w)).toBe(2)
  })

  it('gives an empty detail where jq stops on a cached answer', async () => {
    const w = world()
    await judged(w, [{ ...LODASH, status: 'removable' }])
    mkdirSync(join(w.work, 'advisories'))
    writeFileSync(
      join(w.work, 'advisories', 'express@4.17.0.json'),
      JSON.stringify({
        verdict: 'vulnerable',
        advisory_count: 1,
        matched_ranges: true,
        unevaluated_ranges: [],
        adapter_errors: [],
      }),
    )
    installs(w, expressDown())
    expect(((await together(w)).json as Record<string, JsonValue>).pr_skipped_detail).toBe(
      "; attempt 2 was not run: no finding was removable-individually, so its set is attempt 1's set and narrowing had nothing to drop",
    )
  })

  it('says the attempt 2 set was empty when every finding carried sibling ambiguity', async () => {
    const w = world()
    await judged(w, [{ ...LODASH, status: 'removable-individually' }])
    installs(w, expressDown())
    expect((await together(w, { replies: EXPRESS_OLD })).json).toEqual({
      status: 'combined_failed',
      step: 'together',
      attempt: 1,
      pr_skipped_reason: 'combined test failed',
      pr_skipped_detail: `${ADMITTED_EXPRESS}; attempt 2 set was empty because every removable finding carried sibling ambiguity`,
    })
  })

  describe('a partial view fails an attempt closed', () => {
    it('reports a map that the parser refused as a partial map', async () => {
      const w = world()
      await judged(w, TWO)
      installs(w, "printf 'garbage\\n' > package-lock.json\n")
      const json = (await together(w)).json as Record<string, string>
      expect({
        status: json.status,
        attempt: json.attempt,
        reason: json.pr_skipped_reason,
      }).toEqual({
        status: 'combined_failed',
        attempt: 2,
        reason: 'partial resolution map',
      })
      expect(json.pr_skipped_detail).toMatch(
        /^attempt 1 could not read a whole-tree resolution_map: [\s\S]+; attempt 2 could not read a whole-tree resolution_map: /,
      )
      expect(porcelain(w)).toBe('')
    })

    it('reports a map that could not read every entry as a partial map', async () => {
      const w = world()
      await judged(w, [{ ...LODASH, status: 'removable' }])
      const answer = await together(w, {
        route: stand({
          resolutionMap: (tree) => {
            const real = node.resolutionMap(tree)
            return (
              real.outcome === 'ok' ? ok({ ...real.value, unreadable_entries: 2 }) : real
            ) as never
          },
        }),
      })
      expect((answer.json as Record<string, JsonValue>).pr_skipped_detail).toBe(
        "attempt 1's resolution_map could not read 2 lockfile entries, so it is not a whole-tree view; attempt 2 was not run: no finding was removable-individually, so its set is attempt 1's set and narrowing had nothing to drop",
      )
    })

    it.each([
      [
        'an absent unreadable_entries',
        undefined,
        "attempt 1's resolution_map emitted no 'unreadable_entries' field.",
      ],
      [
        'a fractional unreadable_entries',
        0.5,
        "attempt 1's resolution_map reported unreadable_entries '0.5'",
      ],
    ])('stops on %s, before the restore', async (_name, value, start) => {
      const w = world()
      await judged(w, [{ ...LODASH, status: 'removable' }])
      const answer = await together(w, {
        route: stand({
          resolutionMap: (tree) => {
            const real = node.resolutionMap(tree)
            if (real.outcome !== 'ok') return real as never
            const { unreadable_entries: _unread, ...rest } = real.value
            return ok(value === undefined ? rest : { ...rest, unreadable_entries: value }) as never
          },
        }),
      })
      const json = answer.json as { status: string; phase: string; detail: string }
      expect({ exit: answer.status, status: json.status, phase: json.phase }).toEqual({
        exit: 3,
        status: 'failure',
        phase: 'compose',
      })
      expect(json.detail.startsWith(start)).toBe(true)
      expect(porcelain(w)).toBe('M package.json')
    })
  })

  describe('the edit is checked before the install', () => {
    it('restores the tree and stops when the manifest cannot be rewritten', async () => {
      const w = world()
      await judged(w, TWO)
      writeFileSync(join(w.wt, 'package.json'), 'not json at all\n')
      const answer = await together(w)
      expect((answer.json as Record<string, string>).detail).toMatch(
        /^package\.json could not be rewritten to remove the candidate set \[\["lodash"\],\["test-exclude","lodash"\]\]\. Quoting the error: ./,
      )
      expect({ status: answer.status, porcelain: porcelain(w), installs: installCount(w) }).toEqual(
        {
          status: 3,
          porcelain: '',
          installs: 1,
        },
      )
    })

    it.each([
      ['null', null],
      ['a text', 'lodash'],
      ['a list with a number', ['lodash', 1]],
    ])('refuses a candidate path that is %s, and restores the tree', async (_name, path) => {
      const w = world()
      await judged(w, [{ ...LODASH, path, status: 'removable' }])
      expect(await together(w)).toEqual(
        compose(
          `package.json could not be rewritten to remove the candidate set [${JSON.stringify(path)}]. Quoting the error: a candidate path is not a list of keys`,
        ),
      )
      expect(manifest(w).overrides).toEqual({
        lodash: '^4.17.21',
        'test-exclude': { lodash: '3.10.1' },
      })
    })

    it('reads a candidate with no fields as nulls, and refuses its path', async () => {
      const w = world()
      await judged(w, [{ status: 'removable' }])
      expect(await together(w)).toEqual(
        compose(
          'package.json could not be rewritten to remove the candidate set [null]. Quoting the error: a candidate path is not a list of keys',
        ),
      )
    })

    it('refuses an override root that is not a list, before any edit', async () => {
      const w = world()
      await judged(w, TWO, { override_root: 'x' })
      expect(await together(w)).toEqual(
        compose(
          'the override block\'s address is in the state file but is not the shape the step that wrote it promised (expected: type == "array"). An earlier step failed part-way, or the file was edited by hand. Value: "x"',
        ),
      )
    })

    it('restores and stops when the count shows that an edit matched nothing', async () => {
      const w = world()
      await judged(w, [{ ...LODASH, path: ['nope'], status: 'removable' }])
      expect(await together(w)).toEqual(
        compose(
          'attempt 1 left 2 pins where phase 2 counted 2 and 1 entries were removed, which should leave 1.',
        ),
      )
      expect(installCount(w)).toBe(1)
    })

    it('restores and stops when list_pins still carries a candidate', async () => {
      const w = world()
      await judged(w, TWO)
      const listed = node.listPins
      const route = stand({
        listPins: (...args) => {
          const real = listed(...args)
          return (
            real.outcome === 'ok'
              ? ok({ ...real.value, pins: [null, { key: 'kept', path: ['lodash'] }] })
              : real
          ) as never
        },
      })
      expect(await together(w, { route })).toEqual(
        compose(
          'attempt 1 still carries the candidate key(s) ["kept"] after the removal, so the install would have been an install of a manifest still holding them.',
        ),
      )
      expect(porcelain(w)).toBe('')
    })

    it.each([
      ['a pins that is null', null],
      ['a pin that is text', ['x']],
    ])('stops, before the restore, on %s', async (_name, pins) => {
      const w = world()
      await judged(w, TWO)
      const route = stand({ listPins: () => ok({ count: 0, pins }) as never })
      expect(await together(w, { route })).toEqual(
        compose(
          "attempt 1 could not be checked against list_pins' reply, so whether the removals landed is unknown and no verdict is reported as if it were.",
        ),
      )
      expect(porcelain(w)).toBe('M package.json')
    })

    it('stops, before the restore, when list_pins gives no count after the edit', async () => {
      const w = world()
      await judged(w, TWO)
      const route = stand({ listPins: () => ok({ pins: [] }) as never })
      expect(await together(w, { route })).toEqual(
        compose(
          'list_pins (attempt 1) emitted no \'count\' field. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); read straight, an absent field arrives as the string "null" and takes a branch of its own instead of failing.',
        ),
      )
      expect(porcelain(w)).toBe('M package.json')
    })

    it('restores and stops when list_pins fails after the edit', async () => {
      const w = world()
      await judged(w, TWO)
      const route = stand({ listPins: () => failed('list_pins: refused') as never })
      expect(await together(w, { route })).toEqual(
        compose('list_pins failed after composing attempt 1: list_pins: refused'),
      )
      expect(porcelain(w)).toBe('')
    })

    it('stops with exit 1 on a pins_count that is not a number', async () => {
      const w = world()
      await judged(w, TWO, { pins_count: '2' })
      expect((await together(w)).json).toEqual({
        error: `the state file at ${join(w.work, 'state.json')} has no usable value for 'pins_count': expected a number, found "2".`,
      })
    })
  })

  it('ends the run on a combined install failure, phase compose, without attempt 2', async () => {
    const w = world()
    await judged(w, TWO)
    installs(w, "printf 'npm ERR! code ERESOLVE\\n' >&2\n", 1)
    expect(await together(w)).toEqual(
      compose(
        "attempt 1's combined install failed, so the map was not read and attempt 2 was not tried: \nRunning: npm install\nnpm ERR! code ERESOLVE",
      ),
    )
    expect({ porcelain: porcelain(w), installs: installCount(w) }).toEqual({
      porcelain: '',
      installs: 2,
    })
  })

  it('ends the run on a failed advisory query in an attempt, before the restore', async () => {
    const w = world()
    await judged(w, TWO)
    installs(w, expressDown())
    const answer = await together(w, {
      replies: { listAdvisories: ghFails('gh: Not Found (HTTP 404)') },
    })
    expect({
      status: answer.status,
      phase: (answer.json as Record<string, JsonValue>).phase,
    }).toEqual({
      status: 3,
      phase: 'advisories',
    })
    expect(porcelain(w)).toBe('M package-lock.json\n M package.json')
  })

  it.each([
    ['a baseline map that is null', { baseline_map: null }, undefined],
    [
      'a baseline map with a version that is not text',
      { baseline_map: { resolutions: { a: [1] } } },
      undefined,
    ],
    [
      'a map of the attempt with no resolutions',
      {},
      stand({
        resolutionMap: () => ok({ unreadable_entries: 0 }) as never,
      }),
    ],
  ])('stops, before the restore, on %s', async (_name, extra, route) => {
    const w = world()
    await judged(w, TWO, extra as Record<string, JsonValue>)
    expect(await together(w, { route })).toEqual(
      compose(
        "attempt 1's map could not be diffed against the with-all-pins baseline, so nothing is known about what the set moved.",
      ),
    )
  })

  it('refuses a baseline map of the state that is not an object or null', async () => {
    const w = world()
    await judged(w, TWO, { baseline_map: [] })
    expect(await together(w)).toEqual(
      compose(
        'the with-all-pins baseline resolution_map is in the state file but is not the shape the step that wrote it promised (expected: type == "object" or type == "null"). An earlier step failed part-way, or the file was edited by hand. Value: []',
      ),
    )
  })

  describe('the terminal answers before any attempt', () => {
    it('reports an empty candidate set as no removable pins found', async () => {
      const w = world()
      await judged(w, [
        { ...LODASH, status: 'still-required' },
        { ...TEST_EXCLUDE, status: 'inconclusive' },
      ])
      expect(await together(w)).toEqual({
        status: 0,
        json: {
          status: 'no_candidates',
          step: 'together',
          pr_skipped_reason: 'no removable pins found',
          pr_skipped_detail:
            'the audit ran and every pin it tested was kept, so there is nothing to open a PR about',
        },
      })
    })

    it.each([
      ['a map that was not available', { map_available: false }, '0'],
      ['a map_available that is text', { map_available: 'true' }, '0'],
      ['unread entries at the baseline', { baseline_unreadable_entries: 2 }, '2'],
      ['no count of unread entries', { baseline_unreadable_entries: null }, 'unavailable'],
      ['a count that is text', { baseline_unreadable_entries: '0' }, '0'],
      ['a count that is a list', { baseline_unreadable_entries: [1] }, '[\n  1\n]'],
      ['a count that is text with a line break', { baseline_unreadable_entries: '2\n' }, '2'],
    ])('runs no attempt after %s', async (_name, extra, unreadable) => {
      const w = world()
      await judged(w, TWO, extra as Record<string, JsonValue>)
      expect(await together(w)).toEqual({
        status: 0,
        json: {
          status: 'partial_map',
          step: 'together',
          pr_skipped_reason: 'partial resolution map',
          pr_skipped_detail: `the with-all-pins baseline resolution_map was unavailable or partial (unreadable_entries: ${unreadable}), so no combined attempt can be measured against it and none was run`,
        },
      })
      expect(installCount(w)).toBe(1)
    })
  })

  describe('the guards and the state', () => {
    it('requires --work', async () => {
      const w = world()
      expect(await call(w, ['together'])).toEqual({
        status: 1,
        json: { error: 'together: --work is required' },
      })
    })

    it("refuses an option it does not know, in node's words", async () => {
      const w = world()
      expect(await call(w, ['together', '--bogus'])).toEqual({
        status: 1,
        json: { error: "Unknown option '--bogus'" },
      })
    })

    it.each([false, 'true', null])(
      'refuses to run before judge (judge_done %j), and installs nothing',
      async (done) => {
        const w = world()
        await judged(w, TWO, { judge_done: done })
        expect(await together(w)).toEqual({
          status: 1,
          json: {
            error:
              "together: run 'judge' first. Before it runs every finding is still 'tested', so the candidate set is empty and this step would report 'no removable pins found' for an advisory judgment that never happened.",
          },
        })
        expect(installCount(w)).toBe(1)
      },
    )

    it('refuses findings that are not the shape the callers read, phase compose', async () => {
      const w = world()
      await judged(w, TWO, { findings: 'oops' })
      const json = (await together(w)).json as { phase: string; detail: string }
      expect({
        phase: json.phase,
        end: json.detail.endsWith(
          '. An earlier step failed part-way, or the file was edited by hand. Value: "oops"',
        ),
      }).toEqual({
        phase: 'compose',
        end: true,
      })
      expect(json.detail.startsWith("phase 5's findings is in the state file")).toBe(true)
    })

    it('refuses to hand phase 8 a state with no lockfile name', async () => {
      const w = world()
      await judged(w, TWO)
      editState(w, (state) => {
        delete state.lockfile
      })
      expect(((await together(w)).json as { error: string }).error).toContain(
        "has no usable value for 'lockfile'",
      )
      expect(installCount(w)).toBe(1)
    })
  })

  describe('a tracked .yarn/cache', () => {
    const tracked = (repo: string) => {
      mkdirSync(join(repo, '.yarn', 'cache'), { recursive: true })
      writeFileSync(join(repo, '.yarn', 'cache', 'a.zip'), 'a\n')
    }
    const BABEL = {
      key: '@babel/core',
      path: ['@babel/core'],
      package: '@babel/core',
      value: '^7.24.0',
    }

    it('returns a tracked cache to HEAD before the attempt, and leaves untracked files', async () => {
      const w = world('yarn-berry', tracked)
      await judged(w, [{ ...BABEL, status: 'removable' }])
      writeFileSync(join(w.wt, '.yarn', 'cache', 'a.zip'), 'residue\n')
      writeFileSync(join(w.wt, '.yarn', 'cache', 'b.zip'), 'b\n')
      expect(((await together(w)).json as Record<string, JsonValue>).status).toBe('ready_for_pr')
      expect(porcelain(w)).toBe('M package.json\n?? .yarn/cache/b.zip')
    })

    it('touches no cache that git does not track', async () => {
      const w = world('yarn-berry')
      await judged(w, [{ ...BABEL, status: 'removable' }])
      expect(((await together(w)).json as Record<string, JsonValue>).status).toBe('ready_for_pr')
    })

    it.each([
      [
        'ls-files',
        'git ls-files -- .yarn/cache failed in the worktree: git stub: refusing ls-files',
      ],
      [
        'checkout HEAD -- .yarn/cache',
        'git checkout HEAD -- .yarn/cache failed, so per-pin cache residue would have reached the removal commit: git stub: refusing checkout HEAD -- .yarn/cache',
      ],
    ])('ends the run, phase restore, when git %s fails', async (failing, detail) => {
      const w = world('yarn-berry', tracked)
      await judged(w, [{ ...BABEL, status: 'removable' }])
      const shim = w.fixtures.gitShim()
      const env = { ...w.env, PATH: `${shim.directory}:${w.env.PATH}`, GIT_STUB_FAIL: failing }
      expect(await together(w, { env })).toEqual({
        status: 3,
        json: { status: 'failure', phase: 'restore', detail },
      })
    })
  })

  describe('the override file the edits target (issue #159)', () => {
    const presentPins = (repo: string) =>
      writeFileSync(
        join(repo, 'pnpm-workspace.yaml'),
        "packages:\n  - packages/*\n\noverrides:\n  minimatch: '>=10.2.5'\n  \"brace-expansion\": '>=5.0.5'\n  balanced-match: '>=4.0.2'\n",
      )
    const pin = (key: string, status: string) => ({
      key,
      path: [key],
      package: key,
      value: 'x',
      status,
    })

    it('removes each key of the set from pnpm-workspace.yaml, and the last takes the block line', async () => {
      const w = world('pnpm11-workspace-overrides', presentPins)
      await judged(w, [
        pin('minimatch', 'removable'),
        pin('brace-expansion', 'removable'),
        pin('balanced-match', 'removable'),
      ])
      installs(w, 'cp pnpm-workspace.yaml "$PM_DIR/seen"\n')
      expect(((await together(w)).json as Record<string, JsonValue>).status).toBe('ready_for_pr')
      expect(readFileSync(join(w.pmDir, 'seen'), 'utf8')).toBe('packages:\n  - packages/*\n\n')
      expect(porcelain(w)).toBe('M pnpm-workspace.yaml')
    })

    it('restores both files and stops when a key of the set is not in the block', async () => {
      const w = world('pnpm11-workspace-overrides', presentPins)
      await judged(w, [pin('minimatch', 'removable'), pin('nope', 'removable')])
      expect(await together(w)).toEqual(
        compose(
          "the pnpm-workspace.yaml overrides block could not be edited to remove 'nope', so the combined set was never installed.",
        ),
      )
      expect(porcelain(w)).toBe('')
    })
  })
})
