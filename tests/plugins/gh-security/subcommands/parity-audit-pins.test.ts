// Parity for `audit-pins` (RFC 002, "Parity is the migration strategy",
// #235). Each row of `spec/fixtures/audit-pins/capture.json` (`list`,
// `baseline` and `test-pin`) and of `capture-judge-together.json` (`judge`
// and `together`, after the steps that lead to them) is one run of
// `audit-pins-driver.sh` over a real git repository and a real lockfile
// specimen, with its recipe. A row here makes the same repository with the
// same bash recipe, runs each step of the port in process, and compares the
// exit status and the JSON of each step, the state file at the end, what
// `git status --porcelain` says in the worktree, the files that the stand-in
// package manager saw, and the count of installs. For the second capture it
// also compares the advisory cache in the work directory.
//
// The adapter is the real node adapter on both sides: `node.sh` for the
// capture, and the registry for the port. git is real. The package manager is
// the stand-in of the capture, on PATH: an install reaches the network
// (`mocking.md`). `gh` is the one mocked boundary: the capture served its
// advisory pages from a stand-in on PATH to the real `check-advisories.sh`,
// and the port gets the same pages, or the same failure, from
// `createGhMock`.
//
// The state is compared without `adapter`, `advisories`, `scripts_dir` and
// `ecosystem`: the bash keeps paths there, and the port keeps the name of
// the adapter and its route (`audit-pins.ts`).
//
// Declared differences, each in the header of `audit-pins.ts`, are the
// `DECLARED` table: a row, a step, and what the port answers there. The
// words on stderr are not compared. The JSON on stdout carries the same
// detail.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { auditPins } from '#gh-security/subcommands/audit-pins.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock, ghFails } from '#harness/gh.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

// A row runs git and the stand-in many times.
vi.setConfig({ testTimeout: 120_000 })

interface Answer {
  readonly status: number | null
  readonly stdout: JsonValue
}

/** The pages of advisories that `gh api advisories` served. */
type Pages = readonly (readonly Record<string, unknown>[])[]

interface Step {
  readonly args: readonly string[]
  readonly advisories?: Pages
  readonly gh_fail?: string
  readonly edit?: string
  readonly install?: string
  readonly install_status?: number
  readonly result: Answer & { readonly stderr: string }
}

interface Row {
  readonly name: string
  readonly fixture: string
  readonly pre: string | null
  readonly steps: readonly Step[]
  readonly state: Record<string, JsonValue> | null
  readonly porcelain: string
  readonly seen: Record<string, string>
  readonly installs: number
  readonly advisories?: Pages
  readonly cache?: Record<string, JsonValue>
}

interface Capture {
  readonly prelude: string
  readonly setup: string
  readonly stand_in_pm: string
  readonly rows: readonly Row[]
}

const captureOf = (name: string): Capture =>
  JSON.parse(readFileSync(join(FIXTURES_ROOT, 'audit-pins', name), 'utf8')) as Capture

const CAPTURE = captureOf('capture.json')
const JUDGE_TOGETHER = captureOf('capture-judge-together.json')

const PLUGIN = pluginFile('gh-security')

const record = (value: JsonValue): Record<string, JsonValue> => value as Record<string, JsonValue>

/** What a declared step of the port answers, from the answer of the capture. */
type Declared = (captured: Answer) => Answer

const error = (message: string): Answer => ({ status: 1, stdout: { error: message } })

const DECLARED: Readonly<Record<string, Readonly<Record<number, Declared>>>> = {
  'npm: the usage refusals of list and baseline': {
    // The state reader of the port quotes node's error (state.ts).
    0: () =>
      error(
        "no readable state file at $ROOT/work/state.json: Error: ENOENT: no such file or directory, open '$ROOT/work/state.json'. Run 'list' first.",
      ),
    // A bad command line is in node's words.
    5: () => error("Unknown option '--bogus'"),
  },
  'npm: a manifest that does not parse at the removal': {
    // The removal quotes node's parse error, where the bash quoted jq.
    2: (captured) => {
      const detail = String(record(captured.stdout).detail)
      const kept = detail.slice(0, detail.indexOf('Quoting jq: '))
      return {
        status: 3,
        stdout: {
          ...record(captured.stdout),
          detail: `${kept}Quoting the error: <node>`,
        },
      }
    },
  },
  'npm: the guards of judge and together': {
    // A bad command line is in node's words.
    9: () => error("Unknown option '--bogus'"),
    // A phase with no --work names itself. The bash wrote the text of the
    // shell and no JSON.
    10: () => error('together: --work is required'),
    // The state reader of the port names the key with no dot.
    12: () =>
      error(
        "the state file at $ROOT/work/state.json has no usable value for 'lockfile'. Run the earlier steps first; an absent or empty value is never read as a legitimate answer here.",
      ),
  },
  'npm: together refuses a removal that did not land, and a manifest it cannot rewrite': {
    // The port refuses a candidate path that is not a list of keys. The bash
    // read a null path as the whole override block, and removed it.
    6: () => ({
      status: 3,
      stdout: {
        status: 'failure',
        phase: 'compose',
        detail:
          'package.json could not be rewritten to remove the candidate set [null]. Quoting the error: a candidate path is not a list of keys',
      },
    }),
  },
}

/** Each run-specific path as its placeholder, in each text. */
const scrub = (value: JsonValue, root: string): JsonValue => {
  if (typeof value === 'string')
    return value.replaceAll(root, '$ROOT').replaceAll(PLUGIN, '$PLUGIN')
  if (Array.isArray(value)) return value.map((each) => scrub(each, root))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, scrub(each, root)]))
  }
  return value
}

const answerOf = (result: CommandResult): Answer => {
  if (result === undefined) return { status: 0, stdout: null }
  if (result.outcome === 'ok') return { status: 0, stdout: result.value }
  if ('report' in result) return { status: result.exitCode ?? 1, stdout: result.report }
  return { status: exitCodeFor(result), stdout: { error: result.error } }
}

const withoutPaths = (state: Record<string, JsonValue> | null): JsonValue => {
  if (state === null) return null
  const { adapter: _a, advisories: _b, scripts_dir: _c, ecosystem: _d, ...rest } = state
  return rest
}

/** Run the row's recipe, then each step of the port, and read what it left. */
const runPort = async (capture: Capture, row: Row) => {
  const sandbox = createSandbox()
  mkdirSync(sandbox.join('row'))
  const root = realpathSync(sandbox.join('row'))
  const bin = sandbox.stubPath(join(root, 'bin'))
  for (const pm of ['npm', 'pnpm', 'yarn']) {
    writeFileSync(join(bin, pm), capture.stand_in_pm)
    chmodSync(join(bin, pm), 0o755)
  }
  const env: NodeJS.ProcessEnv = {
    ...sandbox.env,
    ROOT: root,
    REPO: join(root, 'repo'),
    WORK: join(root, 'work'),
    WT: join(root, 'work', 'audit'),
    PM_DIR: join(root, 'pm'),
    GH_DIR: join(root, 'gh'),
    FIXTURE: join(FIXTURES_ROOT, row.fixture),
    PRE: row.pre ?? ':',
  }
  const bash = (script: string, cwd?: string) => {
    const result = spawnSync('bash', ['-c', capture.prelude + script], {
      env,
      cwd,
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`${row.name}: ${script}: ${result.stderr}`)
  }
  bash(capture.setup)
  const expand = (arg: string) =>
    arg
      .replaceAll('$ROOT', root)
      .replaceAll('$WORK', env.WORK as string)
      .replaceAll('$WT', env.WT as string)
  const answers: Answer[] = []
  for (const step of row.steps) {
    writeFileSync(join(env.PM_DIR as string, 'install.sh'), step.install ?? '')
    writeFileSync(join(env.PM_DIR as string, 'install.status'), `${step.install_status ?? 0}\n`)
    if (step.edit !== undefined) bash(step.edit, env.WT)
    const context: CommandContext = {
      args: step.args.map(expand),
      env,
      io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
      commandNames: [],
    }
    const pages = step.advisories ?? row.advisories ?? []
    const replies = {
      listAdvisories: step.gh_fail === undefined ? pages.flat() : ghFails(step.gh_fail),
    }
    const answer = answerOf(
      await auditPins(context, {
        spawn: run,
        route: selectAdapter,
        makeClient: () => createGhMock(replies),
      }),
    )
    answers.push({ status: answer.status, stdout: scrub(answer.stdout, root) })
  }
  const statePath = join(env.WORK as string, 'state.json')
  const state = existsSync(statePath)
    ? (scrub(JSON.parse(readFileSync(statePath, 'utf8')) as JsonValue, root) as Record<
        string,
        JsonValue
      >)
    : null
  const pmDir = env.PM_DIR as string
  const seen: Record<string, string> = {}
  for (const name of readdirSync(pmDir).sort()) {
    if (name.startsWith('seen-')) seen[name] = readFileSync(join(pmDir, name), 'utf8')
  }
  const count = join(pmDir, 'install.n')
  const cacheDir = join(env.WORK as string, 'advisories')
  const cache: Record<string, JsonValue> = {}
  if (existsSync(cacheDir)) {
    for (const name of readdirSync(cacheDir).sort()) {
      cache[name] = scrub(JSON.parse(readFileSync(join(cacheDir, name), 'utf8')) as JsonValue, root)
    }
  }
  return {
    cache,
    answers,
    state: withoutPaths(state),
    porcelain: spawnSync('git', ['-C', env.WT as string, 'status', '--porcelain'], {
      env,
      encoding: 'utf8',
    }).stdout,
    seen,
    installs: existsSync(count) ? Number(readFileSync(count, 'utf8')) : 0,
  }
}

/**
 * The text of a lockfile parser that failed, cut on both sides. The words
 * are the adapter's, not the driver's: the bash quoted jq, and the port
 * quotes the TypeScript reader (lockfile.md).
 */
const PARSER_FAILED =
  'the lockfile could not be parsed for this package after the removal, and a failed parse is never an empty result: '

/** The port's quote of node at a failed removal, which the capture cannot know. */
const NODE_ERROR = /Quoting the error: .*$/s

/** The bash's quote of jq at a failed removal in `together`. */
const JQ_ERROR = /Quoting jq: .*$/s

/** A map that a parser refused in an attempt, up to the text that follows it. */
const MAP_REFUSED = /(could not read a whole-tree resolution_map: )[\s\S]*?(?=; attempt 2|$)/

/** The port names the command, not the script, where the query failed. */
const SCRIPT_NAME = /^check-advisories\.sh exited /

/** A value with each text that quotes a parser cut after its fixed words. */
const cut = (value: unknown): unknown => {
  if (typeof value === 'string') {
    if (value.startsWith(PARSER_FAILED)) return `${PARSER_FAILED}<parser>`
    return value
      .replace(NODE_ERROR, 'Quoting the error: <node>')
      .replace(JQ_ERROR, 'Quoting the error: <node>')
      .replace(MAP_REFUSED, '$1<parser>')
      .replace(SCRIPT_NAME, 'check-advisories exited ')
  }
  if (Array.isArray(value)) return value.map(cut)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, cut(each)]))
  }
  return value
}

const compare = async (capture: Capture, row: Row) => {
  const { cache, ...port } = await runPort(capture, row)
  const declared = DECLARED[row.name] ?? {}
  const expected = row.steps.map((step, index) => {
    const captured = { status: step.result.status, stdout: step.result.stdout }
    return declared[index]?.(captured) ?? captured
  })
  expect({ ...port, answers: cut(port.answers), state: cut(port.state) }).toEqual({
    answers: cut(expected),
    state: cut(withoutPaths(row.state)),
    porcelain: row.porcelain,
    seen: row.seen,
    installs: row.installs,
  })
  expect(cache).toEqual(row.cache ?? {})
}

describe('audit-pins list, baseline and test-pin against audit-pins-driver.sh', () => {
  it.each(CAPTURE.rows.map((row) => [row.name, row] as const))('%s', (_name, row) =>
    compare(CAPTURE, row),
  )

  it('declares a difference only for a row and a step that a capture has', () => {
    const steps = Object.fromEntries(
      [...CAPTURE.rows, ...JUDGE_TOGETHER.rows].map((row) => [row.name, row.steps.length]),
    )
    for (const [name, declared] of Object.entries(DECLARED)) {
      for (const index of Object.keys(declared)) {
        expect(Number(index)).toBeLessThan(steps[name] ?? 0)
      }
    }
  })
})

describe('audit-pins judge and together against audit-pins-driver.sh', () => {
  it.each(JUDGE_TOGETHER.rows.map((row) => [row.name, row] as const))('%s', (_name, row) =>
    compare(JUDGE_TOGETHER, row),
  )
})
