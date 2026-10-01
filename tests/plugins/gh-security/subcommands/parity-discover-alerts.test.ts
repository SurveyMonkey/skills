// Parity for `discover-alerts` (RFC 002, "Parity is the migration strategy").
// It runs `scripts/common/discover-alerts.sh` and the TypeScript command on the
// same recorded alerts, and compares the exit status and the whole answer. Each
// answer of the port is compared twice: once with the alerts from the alerts
// endpoint, and once with the same alerts on stdin (#54).
//
// `gh` is the one mock boundary (`mocking.md`). The bash side reads a `gh`
// stub on PATH. It serves the recorded alerts, and one answer for each `head:`
// search. The TypeScript side gets the same alerts and the same answers from a
// stand-in client. The stand-in looks up each search in a map, because the
// harness mock gives one reply for each endpoint, and this check asks once for
// each branch. Version order comes from the real node adapter on both sides.
//
// The rows are the fixtures and the alerts of `spec/discover_alerts_spec.sh`,
// and some more shapes that the script reads in a way that is not obvious.
//
// Declared differences, not compared:
//   - The script writes a failure as JSON on stderr. The CLI renders a failure
//     as JSON on stdout and prose on stderr (`cli.md`). The exit status is the
//     same, and the rows compare it.
//   - The script lets a test copy a stand-in adapter beside it. The port has
//     one adapter, so the unit tests hold a failing `compare_versions` with a
//     stand-in registry.
//   - The script drops a null alert from the list. The port refuses it, with
//     exit 1. A row below shows the two answers.
//   - The port refuses a package name that is not text, a target that is not
//     `<owner>/<repo>`, and a second target. The unit tests hold them.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { type GhClient, GhError } from '#gh-security/lib/gh.ts'
import type { Runner } from '#gh-security/lib/process.ts'
import { discoverAlerts } from '#gh-security/subcommands/discover-alerts.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

// Each row starts the bash side as real processes, which is slow on a CI
// runner. The time limit is for that, and not for a hang.
vi.setConfig({ testTimeout: 60_000 })

const COMMON = pluginFile('gh-security', 'scripts', 'common')
const SCRIPT = join(COMMON, 'discover-alerts.sh')
const SELECT = join(COMMON, 'select-adapter.sh')
const CLASSIFY = join(COMMON, 'classify-lines.sh')

const REPO = 'octo/app'

const fixture = (name: string): JsonValue =>
  JSON.parse(readFileSync(join(FIXTURES_ROOT, 'alerts', name), 'utf8')) as JsonValue

/** One alert, in the shape that the alerts endpoint gives. */
const alert = (
  number: number,
  name: string,
  patched: JsonValue,
  fields: { ecosystem?: JsonValue; severity?: string; epss?: number; range?: string } = {},
): { [key: string]: JsonValue } => ({
  number,
  dependency: {
    package: { ecosystem: fields.ecosystem === undefined ? 'npm' : fields.ecosystem, name },
    manifest_path: 'package.json',
    relationship: 'transitive',
  },
  security_advisory: {
    ghsa_id: `GHSA-${name}-${number}`,
    cve_id: `CVE-2000-${String(number).padStart(4, '0')}`,
    severity: fields.severity ?? 'high',
    summary: 's',
    epss: { percentile: fields.epss ?? 0.1 },
  },
  security_vulnerability: {
    vulnerable_version_range: fields.range ?? '< 7.29.0',
    first_patched_version: patched === null ? null : { identifier: patched },
  },
})

/** What the alerts endpoint serves: pages of alerts, a raw body, or a failure. */
type Served =
  | { readonly pages: JsonValue }
  | { readonly raw: string }
  | { readonly failure: string }

interface Scenario {
  readonly served: Served
  /** The open pull request URL for each `head:` search that finds one. */
  readonly prs?: Readonly<Record<string, string>>
  /** When set, every `head:` search fails with these words. */
  readonly prFailure?: string
}

const GH_STUB = `#!/bin/sh
case "$1 $2" in
  "api repos/"*)
    if [ -f "$STUB_DIR/alerts-fail" ]; then cat "$STUB_DIR/alerts-fail" >&2; exit 1; fi
    cat "$STUB_DIR/alerts.json" ;;
  "pr list")
    if [ -f "$STUB_DIR/pr-fail" ]; then cat "$STUB_DIR/pr-fail" >&2; exit 1; fi
    head=""
    while [ $# -gt 0 ]; do
      case "$1" in --search) head="\${2#head:}"; shift 2 ;; *) shift ;; esac
    done
    key=$(printf '%s' "$head" | tr / _)
    if [ -f "$STUB_DIR/pr-$key" ]; then cat "$STUB_DIR/pr-$key"; fi ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 99 ;;
esac
`

/** A sandbox with the `gh` stub on PATH, serving the scenario. */
const stubbed = (scenario: Scenario): { path: string; data: string } => {
  const sandbox = createSandbox()
  const bin = sandbox.join('bin')
  const data = sandbox.join('data')
  mkdirSync(bin)
  mkdirSync(data)
  writeFileSync(join(bin, 'gh'), GH_STUB)
  chmodSync(join(bin, 'gh'), 0o755)
  const { served } = scenario
  if ('failure' in served) writeFileSync(join(data, 'alerts-fail'), `${served.failure}\n`)
  else {
    const body = 'raw' in served ? served.raw : JSON.stringify(served.pages)
    writeFileSync(join(data, 'alerts.json'), body)
  }
  for (const [head, url] of Object.entries(scenario.prs ?? {})) {
    writeFileSync(join(data, `pr-${head.replaceAll('/', '_')}`), `${url}\n`)
  }
  if (scenario.prFailure !== undefined) {
    writeFileSync(join(data, 'pr-fail'), `${scenario.prFailure}\n`)
  }
  return { path: `${bin}:${process.env.PATH ?? ''}`, data }
}

const bashSide = (scenario: Scenario, args: readonly string[]) => {
  const { path, data } = stubbed(scenario)
  return runBash({ command: 'env', args: [`PATH=${path}`, `STUB_DIR=${data}`, SCRIPT, ...args] })
}

/**
 * The stand-in for `gh`: the alerts the endpoint promises (every page, as one
 * list), and the answer of each `head:` search. A body that is not a list of
 * pages is what the real client refuses with a `GhError` on exit 0.
 */
const standIn = (scenario: Scenario): GhClient => {
  const refuse = (detail: string, status: number): never => {
    throw new GhError(detail, status, { cause: detail, detail })
  }
  return {
    viewPullRequest: () => Promise.reject(new Error('not asked')),
    viewDefaultBranch: () => Promise.reject(new Error('not asked')),
    listAdvisories: () => Promise.reject(new Error('not asked')),
    listDependabotAlerts: async () => {
      const { served } = scenario
      if ('failure' in served) return refuse(served.failure, 1)
      if ('raw' in served) return refuse(`gh answered something else: ${served.raw}`, 0)
      return (served.pages as Record<string, unknown>[][]).flat()
    },
    searchOpenPullRequests: async ({ head }) => {
      if (scenario.prFailure !== undefined) return refuse(scenario.prFailure, 1)
      const url = scenario.prs?.[head]
      return url === undefined ? [] : [{ url }]
    },
  }
}

const noProcess: Runner = () => Promise.reject(new Error('the stand-in client starts no process'))

const typescriptSide = (
  scenario: Scenario,
  args: readonly string[],
  stdin: string,
): Promise<CommandResult> => {
  const context: CommandContext = {
    args,
    env: {},
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => stdin },
    commandNames: [],
  }
  return discoverAlerts(context, () => standIn(scenario), noProcess, selectAdapter)
}

const answerOf = (result: CommandResult): { status: number; json: JsonValue | undefined } => {
  if (result === undefined) throw new Error('discover-alerts answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  return { status: exitCodeFor(result), json: undefined }
}

/** The body that the stdin form reads: the same text that the endpoint served. */
const stdinOf = (served: Served): string => {
  if ('raw' in served) return served.raw
  if ('pages' in served) return JSON.stringify(served.pages)
  return ''
}

/** The bash answer, the port's answer from the endpoint, and from stdin, all the same. */
const expectSame = async (scenario: Scenario, args: readonly string[]): Promise<JsonValue> => {
  const bash = bashSide(scenario, args)
  expect(bash.stderr).toBe('')
  expect(bash.status).toBe(0)
  const answer = JSON.parse(bash.stdout) as JsonValue
  const fetched = answerOf(await typescriptSide(scenario, args, ''))
  const injected = answerOf(
    await typescriptSide(scenario, ['--stdin', ...args], stdinOf(scenario.served)),
  )
  expect(fetched.status).toBe(0)
  expect(injected.status).toBe(0)
  expect(firstDifference(answer, fetched.json as JsonValue)).toBeNull()
  expect(firstDifference(answer, injected.json as JsonValue)).toBeNull()
  return answer
}

const expectBothRefuse = async (scenario: Scenario, args: readonly string[]): Promise<void> => {
  const bash = bashSide(scenario, args)
  expect(bash.status).toBe(1)
  expect(bash.stdout).toBe('')
  expect(answerOf(await typescriptSide(scenario, args, '')).status).toBe(1)
}

const MULTI: Scenario = { served: { pages: fixture('multi-major.json') } }

const names = (answer: JsonValue): string[] => {
  const { actionable, skipped } = answer as Record<string, Record<string, unknown>[]>
  return [...(actionable ?? []), ...(skipped ?? [])].map((group) => String(group.branch_name))
}

describe('discover-alerts parity: grouping and naming', () => {
  it('groups the multi-major fixture by package and line, slash style', async () => {
    const answer = await expectSame(MULTI, [REPO])
    expect(names(answer)).toEqual([
      'fix/dependabot-undici-7x',
      'fix/dependabot-undici-6x',
      'fix/dependabot-lodash-4x',
      'fix/dependabot-left-pad-unfixed',
    ])
  })

  it.each([[['--branch-style', 'flat', REPO]], [['--branch-style=flat', REPO]]])(
    'groups the multi-major fixture, flat style (%j)',
    async (args) => {
      const answer = await expectSame(MULTI, args)
      expect(names(answer)).toEqual([
        'fix-dependabot-undici-7x',
        'fix-dependabot-undici-6x',
        'fix-dependabot-lodash-4x',
        'fix-dependabot-left-pad-unfixed',
      ])
    },
  )

  it('reads alerts that come on more than one page', async () => {
    const pages = fixture('multi-major.json') as JsonValue[][]
    const all = pages.flat()
    await expectSame({ served: { pages: [all.slice(0, 3), [], all.slice(3)] } }, [REPO])
  })

  it.each([
    ['slash', [REPO]],
    ['flat', ['--branch-style', 'flat', REPO]],
  ])('keeps a scoped package name in the branch, %s style', async (_style, args) => {
    await expectSame({ served: { pages: fixture('scoped-package.json') } }, args)
  })

  it.each([
    ['v-prefixed', 'v7.29.0'],
    ['white space', '  7.29.0 '],
    ['prose', 'See vendor advisory'],
    ['empty', ''],
    ['a number', 7],
    ['an equals prefix', '=7.29.0'],
    ['a leading zero', '07.1.0'],
  ])('reads the line from a %s identifier', async (_shape, identifier) => {
    await expectSame({ served: { pages: [[alert(1, 'undici', identifier)]] } }, [REPO])
  })

  it('keeps a no-fix line as a sibling with major null', async () => {
    const pages = [
      [
        alert(1, 'undici', '7.29.0'),
        alert(2, 'undici', null, { severity: 'low', range: '<= 5.28.0' }),
      ],
    ]
    await expectSame({ served: { pages } }, [REPO])
  })

  it('answers empty lists for no alerts', async () => {
    await expectSame({ served: { pages: [] } }, [REPO])
    await expectSame({ served: { pages: [[]] } }, [REPO])
  })

  it('picks the highest fix of a line with the adapter', async () => {
    const pages = [
      [
        alert(1, 'undici', '6.24.0'),
        alert(2, 'undici', '6.28.0', { severity: 'critical' }),
        alert(3, 'undici', '6.3.0', { epss: 0.9 }),
      ],
    ]
    await expectSame({ served: { pages } }, [REPO])
  })

  it('picks the highest fix of an ecosystem with no adapter in version order', async () => {
    const pages = [
      [
        alert(1, 'flask', '2.0.1', { ecosystem: 'pip' }),
        alert(2, 'flask', '2.0.10', { ecosystem: 'pip' }),
        alert(3, 'flask', '2.0.9', { ecosystem: 'pip' }),
        alert(4, 'rails', '7.0.0.rc1', { ecosystem: 'rubygems' }),
        alert(5, 'rails', '7.0.0', { ecosystem: 'rubygems' }),
        alert(6, 'odd', '1.9', { ecosystem: null }),
        alert(7, 'odd', '1.10', { ecosystem: null }),
      ],
    ]
    await expectSame({ served: { pages } }, [REPO])
  })

  it('names the branch of a package whose name ends in a line break without the break', async () => {
    await expectSame({ served: { pages: [[alert(1, 'undici\n', '7.29.0')]] } }, [REPO])
  })

  it('ranks by severity, then EPSS, then package and line', async () => {
    const pages = [
      [
        alert(1, 'b', '1.0.1', { severity: 'low', epss: 0.9 }),
        alert(2, 'a', '1.0.1', { severity: 'low', epss: 0.9 }),
        alert(3, 'a', '10.0.1', { severity: 'low', epss: 0.9 }),
        alert(4, 'a', '9.0.1', { severity: 'low', epss: 0.9 }),
        alert(5, 'c', '1.0.1', { severity: 'moderate' }),
        alert(6, 'd', '1.0.1', { severity: 'critical', epss: 0.01 }),
        alert(7, 'e', '1.0.1', { severity: 'medium' }),
      ],
    ]
    await expectSame({ served: { pages } }, [REPO])
  })
})

describe('discover-alerts parity: the open pull request check', () => {
  it.each([
    ['its own branch', 'fix/dependabot-undici-6x'],
    ['the legacy branch of the newest line', 'fix/dependabot-undici'],
    ['the legacy branch of a one-line package', 'fix/dependabot-lodash'],
    ['the flat twin under the slash style', 'fix-dependabot-undici-6x'],
  ])('skips a line whose PR is open on %s', async (_case, head) => {
    await expectSame({ ...MULTI, prs: { [head]: 'https://github.com/octo/app/pull/7' } }, [REPO])
  })

  it('names the first match when two candidates have a PR', async () => {
    const prs = {
      'fix/dependabot-undici-7x': 'https://github.com/octo/app/pull/1',
      'fix-dependabot-undici-7x': 'https://github.com/octo/app/pull/2',
      'fix/dependabot-undici': 'https://github.com/octo/app/pull/3',
    }
    await expectSame({ ...MULTI, prs }, [REPO])
  })

  it('skips a line whose flat-named PR is open under the flat style', async () => {
    const prs = { 'fix-dependabot-undici-6x': 'https://github.com/octo/app/pull/9' }
    await expectSame({ ...MULTI, prs }, ['--branch-style', 'flat', REPO])
  })

  it('asks for neither a slash name nor a legacy name under the flat style', async () => {
    const prs = {
      'fix/dependabot-undici-7x': 'https://github.com/octo/app/pull/1',
      'fix/dependabot-lodash': 'https://github.com/octo/app/pull/3',
    }
    const answer = await expectSame({ ...MULTI, prs }, ['--branch-style', 'flat', REPO])
    expect((answer as { actionable: unknown[] }).actionable).toHaveLength(3)
  })

  it('reports a failed search as a skip reason, with the words of gh', async () => {
    await expectSame({ ...MULTI, prFailure: 'gh: could not resolve to a Repository' }, [REPO])
  })
})

describe('discover-alerts parity: the refusals', () => {
  it.each([
    ['no target', []],
    ['the withdrawn --scope flag', ['--scope', 'repo', REPO]],
    ['an unknown branch style', ['--branch-style', 'diagonal', REPO]],
  ])('refuses %s', async (_case, args) => {
    await expectBothRefuse(MULTI, args)
  })

  it.each([
    ['a failed fetch', { failure: 'gh: Not Found (HTTP 404)' }],
    ['a body that is not JSON', { raw: 'not json' }],
    ['a body that is not a list', { raw: '{"message":"Not Found"}' }],
  ])('refuses %s, and never reads it as no alerts', async (_case, served: Served) => {
    await expectBothRefuse({ served }, [REPO])
  })
})

describe('discover-alerts parity: the declared difference', () => {
  it('drops a null alert in the script, where the port refuses it', async () => {
    const scenario: Scenario = { served: { pages: [[alert(1, 'undici', '7.29.0'), null]] } }
    const bash = bashSide(scenario, [REPO])
    expect(bash.status).toBe(0)
    const injected = answerOf(
      await typescriptSide(scenario, ['--stdin', REPO], stdinOf(scenario.served)),
    )
    expect(injected.status).toBe(1)
  })
})

describe('discover-alerts parity: flat names at the source (#54)', () => {
  // `classify-lines.sh --branch-style flat` renames the slash names that
  // discovery gave. The port gives the flat names at the source, from the same
  // alerts on stdin. This row shows that the two give the same names, so the
  // rename is not needed.
  it('gives the names that the rewrite of classify-lines.sh gives', async () => {
    const root = useFixture('npm-cross-line')
    try {
      const { path, data } = stubbed(MULTI)
      const pipeline = runBash({
        command: 'env',
        args: [
          `PATH=${path}`,
          `STUB_DIR=${data}`,
          'bash',
          '-o',
          'pipefail',
          '-c',
          '"$1" "$2" | "$3" --from-discovery | "$4" --repo-root "$5" --branch-style flat',
          'pipeline',
          SCRIPT,
          REPO,
          SELECT,
          CLASSIFY,
          root.path,
        ],
      })
      expect(pipeline.status).toBe(0)
      const injected = answerOf(
        await typescriptSide(
          MULTI,
          ['--stdin', '--branch-style', 'flat', REPO],
          stdinOf(MULTI.served),
        ),
      )
      expect(names(injected.json as JsonValue).sort()).toEqual(
        names(JSON.parse(pipeline.stdout) as JsonValue).sort(),
      )
    } finally {
      root.cleanup()
    }
  })
})
