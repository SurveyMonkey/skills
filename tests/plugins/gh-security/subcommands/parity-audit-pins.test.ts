// Parity for `audit-pins list`, `baseline` and `test-pin` (RFC 002, "Parity
// is the migration strategy", #235). Each row of
// `spec/fixtures/audit-pins/capture.json` is one run of
// `audit-pins-driver.sh` over a real git repository and a real lockfile
// specimen, with its recipe. A row here makes the same repository with the
// same bash recipe, runs each step of the port in process, and compares the
// exit status and the JSON of each step, the state file at the end, what
// `git status --porcelain` says in the worktree, the files that the stand-in
// package manager saw, and the count of installs.
//
// The adapter is the real node adapter on both sides: `node.sh` for the
// capture, and the registry for the port. git is real. The package manager is
// the stand-in of the capture, on PATH: an install reaches the network
// (`mocking.md`).
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
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

// A row runs git and the stand-in many times.
vi.setConfig({ testTimeout: 120_000 })

interface Answer {
  readonly status: number | null
  readonly stdout: JsonValue
}

interface Step {
  readonly args: readonly string[]
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
}

interface Capture {
  readonly prelude: string
  readonly setup: string
  readonly stand_in_pm: string
  readonly rows: readonly Row[]
}

const CAPTURE = JSON.parse(
  readFileSync(join(FIXTURES_ROOT, 'audit-pins', 'capture.json'), 'utf8'),
) as Capture

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
const runPort = async (row: Row) => {
  const sandbox = createSandbox()
  mkdirSync(sandbox.join('row'))
  const root = realpathSync(sandbox.join('row'))
  const bin = sandbox.stubPath(join(root, 'bin'))
  for (const pm of ['npm', 'pnpm', 'yarn']) {
    writeFileSync(join(bin, pm), CAPTURE.stand_in_pm)
    chmodSync(join(bin, pm), 0o755)
  }
  const env: NodeJS.ProcessEnv = {
    ...sandbox.env,
    ROOT: root,
    REPO: join(root, 'repo'),
    WORK: join(root, 'work'),
    WT: join(root, 'work', 'audit'),
    PM_DIR: join(root, 'pm'),
    FIXTURE: join(FIXTURES_ROOT, row.fixture),
    PRE: row.pre ?? ':',
  }
  const bash = (script: string, cwd?: string) => {
    const result = spawnSync('bash', ['-c', CAPTURE.prelude + script], {
      env,
      cwd,
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`${row.name}: ${script}: ${result.stderr}`)
  }
  bash(CAPTURE.setup)
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
    const answer = answerOf(await auditPins(context, { spawn: run, route: selectAdapter }))
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
  return {
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

/** A value with each text that quotes a parser cut after its fixed words. */
const cut = (value: unknown): unknown => {
  if (typeof value === 'string') {
    if (value.startsWith(PARSER_FAILED)) return `${PARSER_FAILED}<parser>`
    return value.replace(NODE_ERROR, 'Quoting the error: <node>')
  }
  if (Array.isArray(value)) return value.map(cut)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, cut(each)]))
  }
  return value
}

describe('audit-pins list, baseline and test-pin against audit-pins-driver.sh', () => {
  it.each(CAPTURE.rows.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const port = await runPort(row)
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
  })

  it('declares a difference only for a row and a step that the capture has', () => {
    const steps = Object.fromEntries(CAPTURE.rows.map((row) => [row.name, row.steps.length]))
    for (const [name, declared] of Object.entries(DECLARED)) {
      for (const index of Object.keys(declared)) {
        expect(Number(index)).toBeLessThan(steps[name] ?? 0)
      }
    }
  })
})
