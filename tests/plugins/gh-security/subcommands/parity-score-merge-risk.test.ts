// Parity for `score-merge-risk` (RFC 002, "Parity is the migration
// strategy", #233). Each row of `spec/fixtures/score-merge-risk/capture.json`
// is one example of the shellspec tables of `score-merge-risk.sh`, with the
// answer that the script gave when the capture was made. A row runs the
// script and the TypeScript command on the same copy of its fixture, and
// compares three answers: the capture, the script now, and the port. The
// exit status and the whole JSON are compared.
//
// The capture holds the inputs of each row: the fixture, the why payload,
// the arguments without `--adapter`, an edit of the tree, and the answers of
// a stand-in adapter. The bash side gets `--adapter` with the path of
// `node.sh`, or of a stand-in script that answers from two files. The port
// gets the registry, or a stand-in adapter with the same answers. A text of
// the tree path is `<root>` in each answer.
//
// Declared differences, each with #233, put into the bash text before the
// compare:
//   - A contract error names the adapter by its name in the registry,
//     `node`. The script named the path that `--adapter` gave.
//   - A tree that cannot be read names the error of node, `EACCES` here.
//     The script named the exit status of grep.
//   - A failure is `{"error": ...}` on stdout. The script wrote it on stderr.
//     The compare reads each from where it is.
import { chmodSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, failed, type JsonValue, ok } from '#gh-security/lib/envelope.ts'
import { scoreMergeRisk } from '#gh-security/subcommands/score-merge-risk.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'
import { runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'

const SCORER = pluginFile('gh-security', 'scripts', 'common', 'score-merge-risk.sh')
const NODE_SH = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

type Setup = { chmod: string } | { write: string; text: string } | { remove: string }

interface Row {
  readonly name: string
  readonly fixture: string
  readonly why?: JsonValue
  readonly why_text?: string
  readonly setup?: readonly Setup[]
  readonly stub?: { readonly compare_versions: string; readonly range_facts: string }
  readonly args: readonly string[]
  readonly status: number
  readonly answer: JsonValue
}

const ROWS = JSON.parse(
  readFileSync(join(FIXTURES_ROOT, 'score-merge-risk', 'capture.json'), 'utf8'),
) as Row[]

/** The stand-in adapter script of the bash side: it answers from two files. */
const STUB = `#!/bin/sh
here=$(dirname "$0")
case "$1" in
  compare_versions) cat "$here/cmp.json" ;;
  range_facts)      cat "$here/facts.json" ;;
esac
`

interface Answer {
  readonly status: number
  readonly json: JsonValue
}

/** A text with the tree path as `<root>`. */
const rooted = (text: string, root: string): string => text.split(root).join('<root>')

/** The declared differences, put into a bash answer. */
const declared = (answer: Answer): Answer => {
  const json = answer.json as { error?: string }
  if (answer.status === 0 || typeof json.error !== 'string') return answer
  return {
    status: answer.status,
    json: {
      error: json.error
        .replace(/^adapter \.\/stub\.sh: /, 'adapter node: ')
        .replace('(grep exited 2)', '(the read failed with EACCES)'),
    },
  }
}

/** The text of a stand-in answer as the port gets it: no text is no answer. */
const parsed = (text: string): unknown => (text === '' ? undefined : JSON.parse(text))

const bashSide = (row: Row, root: string): Answer => {
  const adapter = row.stub === undefined ? NODE_SH : './stub.sh'
  const result = runBash({ command: SCORER, args: ['--adapter', adapter, ...row.args], cwd: root })
  const text = rooted(result.status === 0 ? result.stdout : result.stderr, root)
  return { status: result.status, json: JSON.parse(text) as JsonValue }
}

const tsSide = (row: Row, root: string): Answer => {
  const stub = row.stub
  const route: typeof selectAdapter =
    stub === undefined
      ? selectAdapter
      : (ecosystem) => {
          const real = selectAdapter(ecosystem)
          if (!real.supported) return real
          return {
            ...real,
            adapter: {
              ...real.adapter,
              compareVersions: () => ok(parsed(stub.compare_versions) as never),
              rangeFacts: () => ok(parsed(stub.range_facts) as never),
            },
          }
        }
  const result: CommandResult = scoreMergeRisk(
    {
      args: row.args,
      env: {},
      io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
      commandNames: [],
    },
    route,
    root,
  )
  const envelope = result ?? failed('silence')
  const json =
    envelope.outcome === 'ok'
      ? envelope.value
      : { error: 'error' in envelope ? envelope.error : 'no error' }
  return {
    status: exitCodeFor(envelope as never),
    json: JSON.parse(rooted(JSON.stringify(json), root)) as JsonValue,
  }
}

/** Copy the fixture of a row and make the tree the row names. */
const prepare = (row: Row): { root: string; cleanup: () => void } => {
  const fixture = useFixture(row.fixture)
  const root = realpathSync(fixture.path)
  if (row.why !== undefined) writeFileSync(join(root, 'why.json'), `${JSON.stringify(row.why)}\n`)
  if (row.why_text !== undefined) writeFileSync(join(root, 'why.json'), row.why_text)
  if (row.stub !== undefined) {
    writeFileSync(join(root, 'cmp.json'), `${row.stub.compare_versions}\n`)
    writeFileSync(join(root, 'facts.json'), `${row.stub.range_facts}\n`)
    writeFileSync(join(root, 'stub.sh'), STUB)
    chmodSync(join(root, 'stub.sh'), 0o755)
  }
  const locked: string[] = []
  for (const step of row.setup ?? []) {
    if ('chmod' in step) {
      chmodSync(join(root, step.chmod), 0)
      locked.push(join(root, step.chmod))
    } else if ('write' in step) writeFileSync(join(root, step.write), step.text)
    else rmSync(join(root, step.remove), { force: true })
  }
  return {
    root,
    cleanup: () => {
      for (const path of locked) chmodSync(path, 0o755)
      fixture.cleanup()
    },
  }
}

describe('score-merge-risk against score-merge-risk.sh', () => {
  it('holds a row for every case the capture was made from', () => {
    expect(ROWS.length).toBe(110)
  })

  it.each(ROWS.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const { root, cleanup } = prepare(row)
    try {
      const captured = declared({ status: row.status, json: row.answer })
      expect(declared(bashSide(row, root))).toEqual(captured)
      expect(tsSide(row, root)).toEqual(captured)
    } finally {
      cleanup()
    }
  })
})
