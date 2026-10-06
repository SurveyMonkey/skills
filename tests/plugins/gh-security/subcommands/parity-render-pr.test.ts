// Parity for `render-pr` (RFC 002, "Parity is the migration strategy", #233).
// Each row of `spec/fixtures/render-pr/capture.json` is one run of
// `render-pr.sh`: its arguments, the files that it was given, the `gh` rules
// of a stand-in on PATH, and what the script answered. A row runs the script
// and the TypeScript command on the same inputs, and compares three answers:
// the capture, the script now, and the port.
//
// The script runs as a real process. Its `gh` is a stand-in on PATH that
// records its argv and answers from the rules of the row. The port runs the
// real `gh` client over a runner that does the same, so the argv that the
// client builds, and the env prefix in front of it, are compared too.
// `HOME` and `TMPDIR` are neutral for the script, as they were for the
// capture.
//
// The capture lists every file of the fixture directory. An example checks
// that the list is the directory.
//
// Declared differences, each with #233, are the rows of `DECLARED`. A row in
// it gives the answer of the port, written by hand or as a change of the
// script's text. Every other row must match the capture exactly. The kinds:
//   - A field of another type than the contract promises is refused. The
//     script printed it as text. So are an unknown `action`, an unknown
//     `bare_override`, an alert id, severity or version that is empty, and
//     an `epss_percentile` that is not a fraction.
//   - `commit-msg` checks `major_line` as `body` does.
//   - A table cell is escaped for Markdown: a pipe, a backslash and a line
//     break. The script printed a pipe unescaped in a version, and as `\\|`
//     in a summary. It printed `\r`, `\n` and `\t` as two characters.
//   - A line break in a value of a line is one space.
//   - A code block has a fence longer than any run of backticks inside it.
//   - The next major line is exact for a `major_line` above 2^53.
//   - A top-level entry of `written[]` with no text value does not give the
//     range of a bare override. The next one does.
//   - A body that cannot be rendered writes no part of it. The script wrote
//     the sections before the one that failed.
//   - A `gh` failure names the stderr of `gh`, or `gh exited <status>` when
//     it is empty (#302). `gh pr create` that exits 0 with no URL says so
//     in the words of the client.
//   - A usage failure names `gh-security render-pr`, and an unknown verb has
//     the prefix of the command.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { createGhClient } from '#gh-security/lib/gh.ts'
import type { Runner, RunResult } from '#gh-security/lib/process.ts'
import { renderPr } from '#gh-security/subcommands/render-pr.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'

const FX = join(FIXTURES_ROOT, 'render-pr')
const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'render-pr.sh')

interface Rule {
  readonly argv: readonly string[]
  readonly status?: number
  readonly stdout?: string
  readonly stderr?: string
}

interface Row {
  readonly name: string
  readonly argv: readonly string[]
  readonly files?: Readonly<Record<string, string>>
  readonly gh?: readonly Rule[]
  readonly wrapper?: boolean
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly calls: readonly (readonly string[])[]
  readonly wrapped?: readonly (readonly string[])[]
}

const CAPTURE = JSON.parse(readFileSync(join(FX, 'capture.json'), 'utf8')) as {
  fixtures: string[]
  rows: Row[]
}
const ROWS = CAPTURE.rows

/** The `gh` stand-in of the script: it records its argv, and answers from the rules. */
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs')
const dir = process.env.GH_STUB_DIR
const argv = process.argv.slice(2)
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(argv) + '\\n')
const rules = JSON.parse(fs.readFileSync(dir + '/rules.json', 'utf8'))
const rule = rules.find((r) => r.argv.every((w, i) => argv[i] === w))
if (rule) {
  if (rule.stdout) process.stdout.write(rule.stdout)
  if (rule.stderr) process.stderr.write(rule.stderr)
  process.exit(rule.status ?? 0)
}
`

/** The env prefix of the script: it records its argv, and runs the `gh` in it. */
const WRAPPER = `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const dir = process.env.GH_STUB_DIR
const argv = process.argv.slice(2)
fs.appendFileSync(dir + '/wrapped.jsonl', JSON.stringify(argv) + '\\n')
const at = argv.indexOf('gh')
const r = spawnSync(argv[at], argv.slice(at + 1), { stdio: 'inherit' })
process.exit(r.status ?? 1)
`

/** The answer of one side, in the form that the compare reads. */
interface Answer {
  readonly status: number
  /** The text that a success of `commit-msg` or `body` wrote. */
  readonly text?: string
  /** The JSON that every other answer wrote. */
  readonly json?: unknown
  /** What a failure wrote before its error: the script printed part of a body. */
  readonly partial?: string
  readonly calls: readonly (readonly string[])[]
  readonly wrapped: readonly (readonly string[])[]
}

const TEXT_VERBS = ['commit-msg', 'body']

/** The start of the error object that `die` printed: the last one in the text. */
const ERROR_START = '{\n  "error"'

const answerOf = (
  row: Row,
  status: number,
  stdout: string,
  calls: Answer['calls'],
  wrapped: Answer['wrapped'],
): Answer => {
  if (status === 0) {
    return TEXT_VERBS.includes(row.argv[0] ?? '')
      ? { status, text: stdout, calls, wrapped }
      : { status, json: JSON.parse(stdout), calls, wrapped }
  }
  const start = stdout.lastIndexOf(ERROR_START)
  return {
    status,
    json: JSON.parse(stdout.slice(start)),
    partial: stdout.slice(0, start),
    calls,
    wrapped,
  }
}

interface Places {
  readonly tmp: string
  readonly stub: string
  readonly neutral: string
}

const filled = (text: string, places: Places): string =>
  text.replaceAll('$FX', FX).replaceAll('$TMP', places.tmp).replaceAll('$STUB', places.stub)

const emptied = (text: string, places: Places): string =>
  text
    .replaceAll(FX, '$FX')
    .replaceAll(places.tmp, '$TMP')
    .replaceAll(places.stub, '$STUB')
    .replaceAll(places.neutral, '$NEUTRAL_TMP')

const lines = (path: string, places: Places): string[][] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as string[]).map((word) => emptied(word, places)))

const bashSide = (row: Row, places: Places): Answer => {
  writeFileSync(join(places.stub, 'gh'), GH_STUB)
  chmodSync(join(places.stub, 'gh'), 0o755)
  writeFileSync(join(places.stub, 'wrapper'), WRAPPER)
  chmodSync(join(places.stub, 'wrapper'), 0o755)
  writeFileSync(join(places.stub, 'rules.json'), JSON.stringify(row.gh ?? []))
  writeFileSync(join(places.stub, 'calls.jsonl'), '')
  writeFileSync(join(places.stub, 'wrapped.jsonl'), '')
  const result = runBash({
    command: 'env',
    args: [
      `PATH=${places.stub}:${process.env.PATH}`,
      'HOME=/nonexistent/home/example',
      `TMPDIR=${places.neutral}`,
      `GH_STUB_DIR=${places.stub}`,
      SCRIPT,
      ...row.argv.map((word) => filled(word, places)),
    ],
    cwd: places.tmp,
  })
  return answerOf(
    row,
    result.status,
    emptied(result.stdout, places),
    lines(join(places.stub, 'calls.jsonl'), places),
    lines(join(places.stub, 'wrapped.jsonl'), places),
  )
}

/** A `RunResult` for one answer of the stand-in, as `process.ts` would give it. */
const resultOf = (rule: Rule | undefined): RunResult => ({
  status: rule?.status ?? 0,
  signal: null,
  stdout: rule?.stdout ?? '',
  stderr: rule?.stderr ?? '',
  combined: `${rule?.stdout ?? ''}${rule?.stderr ?? ''}`,
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
})

const tsSide = async (row: Row, places: Places): Promise<Answer> => {
  const calls: string[][] = []
  const wrapped: string[][] = []
  const spawn: Runner = async (command, args = []) => {
    // A prefix gives the words in front of `gh`, and the script's own wrapper
    // recorded them. Nothing runs here: the stand-in answers.
    const at = command === 'gh' ? -1 : args.indexOf('gh')
    const call = (at === -1 ? args : args.slice(at + 1)).map((word) => emptied(word, places))
    if (command !== 'gh') wrapped.push([...args.map((word) => emptied(word, places))])
    calls.push(call)
    return resultOf((row.gh ?? []).find((rule) => rule.argv.every((word, i) => call[i] === word)))
  }
  let written = ''
  const context: CommandContext = {
    args: row.argv.map((word) => filled(word, places)),
    env: {},
    io: {
      stdout: (text) => {
        written += text
      },
      stderr: () => {},
      readStdin: () => '',
    },
    commandNames: [],
  }
  const result: CommandResult = await renderPr(context, createGhClient, spawn)
  if (result === undefined) return { status: 0, text: emptied(written, places), calls, wrapped }
  if (result.outcome === 'ok') return { status: 0, json: result.value, calls, wrapped }
  return {
    status: 1,
    json: { error: emptied(result.error, places) },
    partial: '',
    calls,
    wrapped,
  }
}

/** A scratch place for one row, with its files written. */
const prepare = (row: Row): { places: Places; cleanup: () => void } => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'render-pr-parity-')))
  const places = {
    tmp: join(root, 'tmp'),
    stub: join(root, 'stub'),
    neutral: join(root, 'neutral'),
  }
  for (const dir of Object.values(places)) mkdirSync(dir)
  for (const [name, text] of Object.entries(row.files ?? {})) {
    writeFileSync(join(places.tmp, name), text)
  }
  return { places, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** What the script answered when the capture was made. */
const captured = (row: Row): Answer =>
  answerOf(row, row.status, row.stdout, row.calls, row.wrapped ?? [])

// ---------------------------------------------------------------------------
// The declared differences. A row here is a row whose answer the port gives
// differently, and the answer is written out. Messages are written by hand.
// ---------------------------------------------------------------------------

type Declared =
  | { readonly error: string }
  | { readonly replace: readonly (readonly [string, string])[] }

const STATE = 'body: --state $TMP/state.json'
const ACTION = (action: string): string => `${STATE} (action '${action}')`
const wrong = (where: string, path: string, expected: string): string =>
  `${where} has a '.${path}' that is not ${expected}. The driver's contract promises ${expected}; a value of another type is never rendered as text.`
const ALERT_BODY =
  "body: --group-json $TMP/group.json has an alert missing 'number', both of 'cve' and 'ghsa', 'severity', or a numeric 'epss_percentile'. Every alerts-table row and Refs: line needs all four."
const ALERT_COMMIT =
  "commit-msg: --group-json $TMP/group.json has an alert missing 'number', both of 'cve' and 'ghsa', or 'severity'. Every alert line and Refs: trailer needs all three."
const major = (verb: string, file: string): string =>
  `${verb}: --group-json ${file}'s major_line is not a plain non-negative integer, as a number or a string.`
const NO_MAJOR = (version: string): string =>
  `${STATE} has a requires_major_bump entry whose version '${version}' names no major line, so its row cannot say which line has no patched release.`
const MOVES = `${STATE}'s other_line_moves does not parse as an array of {class: fatal|benign_dedup, major, before: [], after: []} entries.`
const NO_RANGE = (bare: string): string =>
  `body: bare_override is '${bare}' but --state $TMP/state.json's written[] carries no top-level (parent: null) entry with a string value to report the range from. The state file contradicts its own classification; nothing is rendered rather than a fabricated range.`
const NO_URL = (output: string): string =>
  `gh pr create failed: gh answered gh pr create with no pull request URL: ${output}`

/** The summary row of the alert table, as a script row prints it, for a change of its text. */
const summaryRow = (text: string): string =>
  `| [#42](https://github.com/octo/app/security/dependabot/42) | CVE-2021-23337 | high | 84.2% | ${text} |`

const DECLARED: Readonly<Record<string, Declared>> = {
  'no verb': { error: 'usage: gh-security render-pr <commit-msg|body|labels|create> [options]' },
  'unknown verb': { error: "render-pr: unknown subcommand 'frobnicate'" },

  // A field of another type than the contract promises.
  'body action a number': { error: wrong(STATE, 'action', 'text') },
  'body action unknown': { error: "body: unrecognized action 'weird'" },
  'body resolved_version a number': { error: wrong(STATE, 'resolved_version', 'text') },
  'body drift_commit a string': { error: wrong(STATE, 'drift_commit', 'true or false') },
  'body bare_override unknown': {
    error: wrong(STATE, 'bare_override', 'one of none, added or tightened'),
  },
  'body bare_override with a trailing newline': {
    error: wrong(STATE, 'bare_override', 'one of none, added or tightened'),
  },
  'body risk.markdown a number': { error: wrong(STATE, 'risk.markdown', 'text') },
  'body why_raw a number': { error: wrong(STATE, 'why_raw', 'text') },
  'body validate.checked a string': { error: wrong(STATE, 'validate.checked', 'a whole number') },
  'body validate.checked a string zero': {
    error: wrong(STATE, 'validate.checked', 'a whole number'),
  },
  'body validate.checked negative': { error: wrong(STATE, 'validate.checked', 'a whole number') },
  'body validate.checked a fraction': { error: wrong(STATE, 'validate.checked', 'a whole number') },
  'body written an object': { error: wrong(ACTION('scoped-override'), 'written', 'a list') },
  'body written a string': { error: wrong(ACTION('scoped-override'), 'written', 'a list') },
  'body bare, written is an object': {
    error: wrong(ACTION('bare-override'), 'written', 'a list'),
  },
  'body override_file a number': {
    error: wrong(ACTION('scoped-override'), 'override_file', 'text'),
  },
  'commit-msg override_file a number': {
    error: wrong(
      "commit-msg: --state $TMP/state.json (action 'scoped-override')",
      'override_file',
      'text',
    ),
  },
  'body refresh, before a number': { error: wrong(STATE, 'before', 'text or null') },
  'body refresh, before false': { error: wrong(STATE, 'before', 'text or null') },
  'body bare, parent false': { error: NO_RANGE('added') },
  'body bare, applied_parents false': {
    error: "body: --state $TMP/state.json's applied_parents is not an array of strings.",
  },
  'body moves, major false': { error: MOVES },
  'body moves, a number among the versions': { error: MOVES },
  'body moves, null among the versions': { error: MOVES },
  'body bump, a version with no major digits': { error: NO_MAJOR('latest') },
  'body bump, an empty version': { error: NO_MAJOR('') },

  // An alert, and an id, a severity or a fraction that the table cannot hold.
  'body alert number as a string': { error: ALERT_BODY },
  'body alert with an empty cve': { error: ALERT_BODY },
  'body epss 7': { error: ALERT_BODY },
  'body epss -0.5': { error: ALERT_BODY },
  'body summary a number': { error: ALERT_BODY },
  'commit-msg alert number as a string': { error: ALERT_COMMIT },
  'commit-msg alert with an empty cve': { error: ALERT_COMMIT },

  // `major_line`, checked by `commit-msg` as by `body`.
  'commit-msg state-scoped.json group-bad-major-line.json': {
    error: major('commit-msg', '$FX/group-bad-major-line.json'),
  },
  'commit-msg major_line with a trailing newline': {
    error: major('commit-msg', '$TMP/group.json'),
  },
  'body major_line with a trailing newline': { error: major('body', '$TMP/group.json') },
  'body major_line large': {
    replace: [['<12345678901234567000`', '<12345678901234567891`']],
  },

  // Escapes and fences.
  'body summary with a pipe': {
    replace: [[summaryRow('Bypass via a\\\\|b operator'), summaryRow('Bypass via a\\|b operator')]],
  },
  'body summary with a backslash then a pipe': {
    replace: [[summaryRow('Escape a\\\\\\\\|b'), summaryRow('Escape a\\\\\\|b')]],
  },
  'body summary with CRLF': {
    replace: [[summaryRow('line one\\r line two'), summaryRow('line one line two')]],
  },
  'body summary with a lone CR': {
    replace: [[summaryRow('line one\\rline two'), summaryRow('line one line two')]],
  },
  'body summary with a tab': {
    replace: [[summaryRow('col one\\tcol two'), summaryRow('col one\tcol two')]],
  },
  'body package with an inner newline': { replace: [['`lo\ndash`', '`lo dash`']] },
  'body bump, a pipe in a version': { replace: [['| 3.18.1|x |', '| 3.18.1\\|x |']] },
  'body bump, a newline in a version': {
    replace: [
      ['| 3.18.1\\nx |', '| 3.18.1 x |'],
      ['in the 3.18.1.x line', 'in the 3.x line'],
    ],
  },
  'body bump, a tab in a version': { replace: [['| 3.18.1\\tx |', '| 3.18.1\tx |']] },
  'body moves, major a pipe': { replace: [['| a|b.x |', '| a\\|b.x |']] },
  'body moves, a pipe in a version': { replace: [['| 2.0.0|x |', '| 2.0.0\\|x |']] },
  'body moves, a newline in a version': { replace: [['| 2.0.0\\nx |', '| 2.0.0 x |']] },
  'body why_raw with a code fence': {
    replace: [
      [
        '## Dependency chain\n\n```\na\n```\nb\n````\nc\n```\n',
        '## Dependency chain\n\n`````\na\n```\nb\n````\nc\n`````\n',
      ],
    ],
  },
  'body written with a code fence': {
    replace: [
      ['## Changes\n\n```json\n', '## Changes\n\n````json\n'],
      ['    "value": "```x```"\n  }\n]\n```\n', '    "value": "```x```"\n  }\n]\n````\n'],
    ],
  },
  'body bare, first top-level entry has a null value': {
    replace: [['`lodash: "null"`', '`lodash: ">=2"`']],
  },

  // The client names the stderr of gh, and the status when stderr is empty.
  'labels a failure with an empty stderr and a stdout': {
    error: 'gh label create security failed: gh exited 1',
  },
  'labels a failure with nothing at all': { error: 'gh label create security failed: gh exited 1' },
  'create gh fails on stdout only': { error: 'gh pr create failed: gh exited 1' },
  'create gh fails on both': { error: 'gh pr create failed: err text' },
  'create gh fails with nothing': { error: 'gh pr create failed: gh exited 1' },
  'create gh succeeds with no URL': { error: NO_URL('done') },
  'create gh succeeds with nothing': { error: NO_URL('') },
  'create a URL of another host': { error: NO_URL('https://ghe.example/octo/app/pull/99') },
}

/**
 * Rows whose answer from the script depends on the version of jq. The capture
 * was made with jq 1.8.1, and CI has jq 1.7. `"4\n" | tonumber` is an error
 * in 1.8 and the number 4 in 1.7, so the script answered with no next major
 * in one, and with `<5` in the other. The capture and the port are compared,
 * and the live script is not.
 */
const VARIES_WITH_JQ: ReadonlySet<string> = new Set(['body major_line with a trailing newline'])

/** The answer that the port gives for a row: the script's, or the declared difference. */
const portExpects = (row: Row, bash: Answer): Answer => {
  const declared = DECLARED[row.name]
  if (declared === undefined) return bash
  if ('error' in declared) {
    return { ...bash, status: 1, json: { error: declared.error }, partial: '', text: undefined }
  }
  return {
    ...bash,
    text: declared.replace.reduce((text, [from, to]) => text.replaceAll(from, to), bash.text ?? ''),
  }
}

describe('render-pr against render-pr.sh', () => {
  it('holds a row for every case the capture was made from', () => {
    expect(ROWS.length).toBe(414)
  })

  it('lists every file of the fixture directory, and the directory has no other', () => {
    expect(CAPTURE.fixtures).toEqual(
      readdirSync(FX)
        .filter((name) => name !== 'capture.json')
        .sort(),
    )
  })

  // A declared difference that the port no longer has is a stale entry.
  it('declares a difference only for a row that exists, and that differs', () => {
    const names = new Set(ROWS.map((row) => row.name))
    expect(Object.keys(DECLARED).filter((name) => !names.has(name))).toEqual([])
    expect(
      ROWS.filter((row) => DECLARED[row.name] !== undefined)
        .filter((row) => {
          const bash = captured(row)
          return JSON.stringify(portExpects(row, bash)) === JSON.stringify(bash)
        })
        .map((row) => row.name),
    ).toEqual([])
  })

  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const { places, cleanup } = prepare(row)
    try {
      const expected = captured(row)
      if (!VARIES_WITH_JQ.has(row.name)) expect(bashSide(row, places)).toEqual(expected)
      expect(await tsSide(row, places)).toEqual(portExpects(row, expected))
    } finally {
      cleanup()
    }
  })
})
