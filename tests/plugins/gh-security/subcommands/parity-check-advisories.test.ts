// Parity for `check-advisories` (RFC 002, "Parity is the migration
// strategy"). It runs `scripts/common/check-advisories.sh` and the TypeScript
// command on the same recorded advisories, and compares the exit status and
// the whole answer.
//
// `gh` is the one mock boundary (`mocking.md`). The bash side reads a `gh`
// stub on PATH that serves the recorded pages. The TypeScript side gets the
// same advisories from `createGhMock`. Range semantics come from the real node
// adapter on both sides: `node.sh` for bash, and the registry for the port.
//
// Declared differences, none of them compared here:
//   - The script takes `--adapter <path>` beside `--version`. The port has no
//     path, because the adapter is in process. It picks the adapter from
//     `--ecosystem` through the registry, and `--version` alone asks for a
//     verdict. The rows below map the arguments.
//   - The script writes a failure as JSON on stderr. The CLI renders a failure
//     as JSON on stdout and prose on stderr (`cli.md`). The exit status is the
//     same.
//   - The script lets a caller pass an adapter that is broken. The port has
//     one adapter, so the unit tests hold a failing `range_facts` with a
//     stand-in.
//   - The port refuses `--version` for an ecosystem with no adapter, with exit
//     3. The script has no such answer: its caller gives it an adapter path.
//   - The port encodes the package and the ecosystem in the query. The script
//     puts them in as they are. The rows use plain names.
//   - The port treats a parseable range with a non-boolean `satisfied` as
//     unevaluated (ruling 12 on #225). The unit tests hold it, because the
//     real adapter never gives one. A `parseable` that is not true or false
//     is the same case (#302).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { checkAdvisories } from '#gh-security/subcommands/check-advisories.ts'
import { createGhMock, ghFails } from '#harness/gh.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'check-advisories.sh')
const NODE_SH = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

type Advisory = Record<string, unknown>

const vuln = (name: string, range: string | null, patched: unknown = null) => ({
  package: { ecosystem: 'npm', name },
  vulnerable_version_range: range,
  first_patched_version: patched,
})

const advisory = (id: string, fields: Advisory): Advisory => ({
  ghsa_id: id,
  cve_id: null,
  severity: 'high',
  type: 'reviewed',
  withdrawn_at: null,
  published_at: '2021-02-15T00:00:00Z',
  summary: `summary of ${id}`,
  html_url: `https://github.com/advisories/${id}`,
  ...fields,
})

/** The recorded pages of the script's spec: three advisories, a withdrawn one, a sibling package. */
const PAGES = (): Advisory[][] => [
  [
    advisory('GHSA-aaaa-1111-bbbb', {
      cve_id: 'CVE-2019-10744',
      severity: 'critical',
      vulnerabilities: [vuln('lodash', '< 4.17.12', '4.17.12')],
    }),
    advisory('GHSA-cccc-2222-dddd', {
      cve_id: 'CVE-2021-23337',
      vulnerabilities: [
        vuln('lodash', '< 4.17.21', '4.17.21'),
        vuln('lodash-es', '< 4.17.21', '4.17.21'),
      ],
    }),
    advisory('GHSA-eeee-3333-ffff', {
      severity: 'moderate',
      vulnerabilities: [vuln('lodash', '>= 3.0.0, < 4.17.19', { identifier: '4.17.19' })],
    }),
    advisory('GHSA-gggg-4444-hhhh', {
      severity: 'low',
      withdrawn_at: '2022-01-01T00:00:00Z',
      vulnerabilities: [vuln('lodash', '< 99.0.0')],
    }),
  ],
]

const GH_STUB = `#!/bin/sh
case "$1 $2" in
  "api advisories"*) ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 99 ;;
esac
if [ -f "$STUB_DIR/fail" ]; then
  cat "$STUB_DIR/fail" >&2
  exit 1
fi
cat "$STUB_DIR/advisories.json"
`

/** What the stub serves: pages, a raw body that is not an array, or a failure. */
type Served =
  | { readonly pages: readonly (readonly Advisory[])[] }
  | { readonly raw: string }
  | { readonly failure: string }

const bashSide = (served: Served, args: readonly string[]) => {
  const sandbox = createSandbox()
  const bin = sandbox.join('bin')
  const data = sandbox.join('data')
  mkdirSync(bin)
  mkdirSync(data)
  writeFileSync(sandbox.join('bin', 'gh'), GH_STUB)
  chmodSync(sandbox.join('bin', 'gh'), 0o755)
  if ('failure' in served) writeFileSync(sandbox.join('data', 'fail'), `${served.failure}\n`)
  else {
    const body = 'raw' in served ? served.raw : JSON.stringify(served.pages)
    writeFileSync(sandbox.join('data', 'advisories.json'), body)
  }
  return runBash({
    command: 'env',
    args: [`PATH=${bin}:${process.env.PATH ?? ''}`, `STUB_DIR=${data}`, SCRIPT, ...args],
  })
}

const typescriptSide = async (served: Served, args: readonly string[]): Promise<CommandResult> => {
  const reply =
    'failure' in served
      ? ghFails(served.failure)
      : 'raw' in served
        ? ghFails('gh answered gh api with something that is not an array')
        : served.pages.flat()
  const context: CommandContext = {
    args,
    env: {},
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
    commandNames: [],
  }
  return checkAdvisories(context, () => createGhMock({ listAdvisories: reply }), run, selectAdapter)
}

const answerOf = (result: CommandResult): { status: number; json: JsonValue | undefined } => {
  if (result === undefined) throw new Error('check-advisories answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  return { status: exitCodeFor(result), json: undefined }
}

/** The script's arguments, and the port's for the same question. */
const args = (
  packageName: string,
  options: { ecosystem?: string; version?: string } = {},
): { bash: string[]; typescript: string[] } => {
  const ecosystem = options.ecosystem === undefined ? [] : ['--ecosystem', options.ecosystem]
  const version = options.version === undefined ? [] : ['--version', options.version]
  return {
    bash: [
      ...ecosystem,
      ...(options.version === undefined ? [] : ['--adapter', NODE_SH]),
      ...version,
      packageName,
    ],
    typescript: [...ecosystem, ...version, packageName],
  }
}

const expectSame = async (
  served: Served,
  given: { bash: string[]; typescript: string[] },
): Promise<JsonValue> => {
  const bash = bashSide(served, given.bash)
  const typescript = answerOf(await typescriptSide(served, given.typescript))
  expect(bash.status).toBe(0)
  expect(typescript.status).toBe(0)
  expect(firstDifference(JSON.parse(bash.stdout) as JsonValue, typescript.json as JsonValue)).toBe(
    null,
  )
  return typescript.json as JsonValue
}

const expectBothRefuse = async (
  served: Served,
  given: { bash: string[]; typescript: string[] },
): Promise<void> => {
  const bash = bashSide(served, given.bash)
  const typescript = answerOf(await typescriptSide(served, given.typescript))
  expect(bash.status).toBe(1)
  expect(bash.stdout).toBe('')
  expect(typescript.status).toBe(1)
}

describe('check-advisories parity: the listing', () => {
  it('unions the ranges of every published advisory, drops the withdrawn, and keeps the sibling out', async () => {
    const answer = (await expectSame({ pages: PAGES() }, args('lodash'))) as Record<string, unknown>
    expect(answer.vulnerable_ranges).toEqual(['< 4.17.12', '< 4.17.21', '>= 3.0.0, < 4.17.19'])
    expect(answer.advisory_count).toBe(3)
    expect(answer.withdrawn_excluded).toBe(1)
    expect(answer.verdict).toBeNull()
  })

  it('scopes the query to the requested ecosystem', async () => {
    const answer = (await expectSame(
      { pages: PAGES() },
      args('lodash', { ecosystem: 'pip' }),
    )) as Record<string, unknown>
    expect(answer.ecosystem).toBe('pip')
    expect(answer.advisory_count).toBe(0)
  })

  it('unions across pages', async () => {
    const [page] = PAGES()
    const pages = [[page?.[0] as Advisory], [page?.[1] as Advisory, page?.[2] as Advisory]]
    await expectSame({ pages }, args('lodash'))
  })

  it('answers no-advisories, and not safe, for an empty result', async () => {
    const answer = (await expectSame(
      { pages: [[]] },
      args('lodash', { version: '1.0.0' }),
    )) as Record<string, unknown>
    expect(answer).toMatchObject({ verdict: 'no-advisories', advisory_count: 0 })
  })

  it('reads a null first_patched_version, an object one, and a string one as found', async () => {
    await expectSame({ pages: PAGES() }, args('lodash'))
  })
})

describe('check-advisories parity: the verdict for a candidate version', () => {
  it.each([
    ['4.17.21', 'safe'],
    ['4.17.20', 'vulnerable'],
    ['4.17.11', 'vulnerable'],
    ['2.4.2', 'vulnerable'],
  ])('rates %s as %s', async (version, verdict) => {
    const answer = (await expectSame({ pages: PAGES() }, args('lodash', { version }))) as Record<
      string,
      unknown
    >
    expect(answer.verdict).toBe(verdict)
  })

  it('reports unknown, and never safe, for a range nobody can read', async () => {
    const pages = PAGES()
    const first = pages[0]?.[0] as { vulnerabilities: Advisory[] }
    first.vulnerabilities = [vuln('lodash', 'see vendor advisory')]
    const answer = (await expectSame({ pages }, args('lodash', { version: '4.17.21' }))) as Record<
      string,
      unknown
    >
    expect(answer).toMatchObject({
      verdict: 'unknown',
      unevaluated_ranges: ['see vendor advisory'],
      matched_ranges: [],
      adapter_errors: [],
    })
  })

  it('carries no adapter errors on a clean run', async () => {
    const answer = (await expectSame(
      { pages: PAGES() },
      args('lodash', { version: '4.17.21' }),
    )) as Record<string, unknown>
    expect(answer.adapter_errors).toEqual([])
  })
})

describe('check-advisories parity: the refusals', () => {
  it('requires a package name', async () => {
    await expectBothRefuse({ pages: PAGES() }, { bash: [], typescript: [] })
  })

  it('refuses an empty ecosystem', async () => {
    await expectBothRefuse(
      { pages: PAGES() },
      { bash: ['--ecosystem', '', 'lodash'], typescript: ['--ecosystem', '', 'lodash'] },
    )
  })

  it('refuses an empty version', async () => {
    await expectBothRefuse(
      { pages: PAGES() },
      {
        bash: ['--adapter', NODE_SH, '--version', '', 'lodash'],
        typescript: ['--version', '', 'lodash'],
      },
    )
  })

  it('refuses an option it does not know', async () => {
    await expectBothRefuse(
      { pages: PAGES() },
      { bash: ['--nope', 'lodash'], typescript: ['--nope', 'lodash'] },
    )
  })

  it('reports an API failure rather than an empty advisory list', async () => {
    await expectBothRefuse({ failure: 'gh: HTTP 503' }, args('lodash'))
  })

  it('reports a response that is not an array', async () => {
    await expectBothRefuse({ raw: '{"message":"Not Found"}' }, args('lodash'))
  })
})
