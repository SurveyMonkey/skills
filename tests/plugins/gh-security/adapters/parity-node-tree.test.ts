// Parity for the tree verbs of the node adapter (RFC 002, "Parity is the
// migration strategy"). Each example runs one verb of node.sh and the same
// verb of `node` on one input, and compares the two answers: the outcome and
// the payload both. The verbs are `why`, `declared_ranges` and `list_pins`
// (#221, layer 2). `parents` has no verb in node.sh, so its unit tests prove
// it (#221, round 3 sweep).
//
// The fixture set is discovered, not listed. The verbs run on each fixture
// that bash `detect` accepts, because a `Tree` holds a detection that
// succeeded. The package names come from the `resolution_map` that bash
// answers for that fixture, plus the alias keys and a name that no lockfile
// holds. `declared_ranges --line` runs for each major that the map holds for
// the package.
//
// `why` runs the package manager on PATH, as spec/node_semver_spec.sh does
// (#221, round 3 ruling 2). The TypeScript side gets the `raw` text of bash
// through its parameter, and nothing else of the bash answer. There is no
// PATH shim. The package manager can write into the tree (Yarn writes
// `.yarn/`), so `why` runs on a scratch copy of the fixture.
//
// Both sides get one PATH. `runBash` gives bash the environment of this
// process, and the TypeScript side reads PATH from that same environment.
//
// Declared out of `why` and `declared_ranges`, each with its reason. The
// unit tests hold the TypeScript answer for each:
//
//   - `pnpm-git-parent`: the #50 divergence. bash names the parent
//     `debug@git+ssh://git`, and the TypeScript reader names it `debug`.
//   - `npm-v1`: bash reads no parents from a lockfileVersion 1 lockfile and
//     answers with none. The TypeScript reader refuses that lockfile, as
//     `resolved_versions` does on both sides. Zero parents from a lockfile
//     that the reader cannot read is "found nothing" read as a pass.
//
// Declared divergence in the exit status, as in parity-node.test.ts: where
// jq itself stops, bash exits 5, and there the check is the refusal alone.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import {
  type Envelope,
  exitCodeFor,
  type JsonValue,
  renderJson,
} from '#gh-security/lib/envelope.ts'
import { FIXTURES_ROOT, type Fixture, useFixture } from '#harness/fixtures.ts'
import { type BashResult, firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'

const ADAPTER = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

const ENV = { PATH: process.env.PATH }

/**
 * The time limit of one `why` example. It starts the package manager, and a
 * cold start of one can take longer than the default limit of five seconds.
 */
const WHY_TIMEOUT_MS = 60_000

/** The status jq exits with when its program stops with an error. */
const JQ_ERROR = 5

const DECLARED: Readonly<Record<string, string>> = {
  'pnpm-git-parent': 'declared divergence: #50',
  'npm-v1': 'declared divergence: bash reads no parents from lockfileVersion 1',
}

// The names an `npm:` alias installs a copy under (ADR 001, "One documented
// exception"). An aliasing parent is a parent of both names.
const ALIAS_KEYS: Readonly<Record<string, readonly string[]>> = {
  'npm-alias': ['lodash-alias'],
  'npm-alias-installed': ['lodash-alias'],
  'yarn-alias': ['aliased', 'scoped-alias'],
  'yarn-berry-alias-parent': ['lodash-alias'],
}

const ABSENT = 'not-in-this-lockfile'

const bash = (cwd: string, ...args: string[]): BashResult =>
  runBash({ command: ADAPTER, args, cwd })

/** A fresh copy that `JsonValue` admits: it has no readonly arrays. */
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

/**
 * 'agree', or the first disagreement in words.
 *
 * bash writes a refusal to stderr. `die` writes one line of JSON, which must
 * equal the body that the entry point renders from the TypeScript envelope.
 * The `${1:?}` usage guard writes prose, which must contain the TypeScript
 * message. Where jq stops, only the refusal counts.
 */
const agreement = (answer: BashResult, envelope: Envelope<unknown>): string => {
  if (envelope.outcome === 'ok') {
    if (answer.status !== 0) {
      return `bash refused with exit ${answer.status}: ${answer.stderr.trim()}`
    }
    const difference = firstDifference(
      JSON.parse(answer.stdout) as JsonValue,
      asJson(envelope.value),
    )
    return difference === null ? 'agree' : `they differ at ${difference}`
  }
  if (answer.status === 0) return `bash answered: ${answer.stdout.trim()}`
  const status = exitCodeFor(envelope)
  if (answer.status === JQ_ERROR && status === 1) return 'agree'
  if (answer.status !== status) return `bash exits ${answer.status}, TypeScript exits ${status}`
  const last = answer.stderr.trim().split('\n').at(-1) ?? ''
  if (last.startsWith('{')) {
    const difference = firstDifference(
      JSON.parse(last) as JsonValue,
      JSON.parse(renderJson(envelope).stdout) as JsonValue,
    )
    return difference === null ? 'agree' : `the refusals differ at ${difference}`
  }
  return answer.stderr.includes(envelope.error)
    ? 'agree'
    : `bash stderr does not name "${envelope.error}": ${answer.stderr.trim()}`
}

/** The tree that the TypeScript side reads, from its own `detect`. */
const treeOf = (dir: string): Tree<NodeDetection> => {
  const detection = node.detect(dir, ENV)
  if (detection.outcome !== 'ok') {
    throw new Error(`TypeScript detect refused ${dir}: ${detection.error}`)
  }
  return { root: dir, detection: detection.value }
}

type Accepted = {
  readonly name: string
  readonly dir: string
  /** The `pm` that bash `detect` answers. */
  readonly pm: string
  /** The versions of each package, from the map that bash answers, or none when bash refuses. */
  readonly resolutions: Readonly<Record<string, readonly string[]>>
}

const accepted: Accepted[] = readdirSync(FIXTURES_ROOT)
  .sort()
  .filter((name) => statSync(join(FIXTURES_ROOT, name)).isDirectory())
  .flatMap((name) => {
    const dir = join(FIXTURES_ROOT, name)
    const detected = bash(dir, 'detect')
    if (detected.status !== 0) return []
    const map = bash(dir, 'resolution_map')
    const resolutions =
      map.status === 0
        ? (JSON.parse(map.stdout) as { resolutions: Record<string, string[]> }).resolutions
        : {}
    const { pm } = JSON.parse(detected.stdout) as { pm: string }
    return [{ name, dir, pm, resolutions }]
  })

const compared = accepted.filter(({ name }) => !(name in DECLARED))

const queriesOf = ({ name, resolutions }: Accepted): string[] => {
  const names = Object.keys(resolutions)
  return [...(names.length > 0 ? names : ['lodash']), ...(ALIAS_KEYS[name] ?? []), ABSENT]
}

/** Each package with each major line that the map holds for it. */
const linesOf = ({ resolutions }: Accepted): (readonly [string, number])[] =>
  Object.entries(resolutions).flatMap(([pkg, versions]) =>
    [...new Set(versions.map((version) => version.split('.')[0] ?? ''))]
      .filter((major) => /^[0-9]+$/.test(major))
      .map((major) => [pkg, Number(major)] as const),
  )

describe('the fixture set', () => {
  it('holds a compared fixture for each manager', () => {
    const managers = new Set(compared.map(({ pm }) => pm))
    expect([...managers].sort()).toEqual(['npm', 'pnpm', 'yarn'])
  })

  it.each(Object.keys(DECLARED))('still accepts the declared fixture %s', (name) => {
    expect(accepted.map((fixture) => fixture.name)).toContain(name)
  })

  it.each(Object.keys(ALIAS_KEYS))('still compares the alias fixture %s', (name) => {
    expect(compared.map((fixture) => fixture.name)).toContain(name)
  })

  it('finds lines to compare', () => {
    expect(compared.flatMap(linesOf).length).toBeGreaterThan(0)
  })
})

describe('list_pins', () => {
  it.each(accepted)('agrees on $name', ({ dir }) => {
    expect(agreement(bash(dir, 'list_pins'), node.listPins(treeOf(dir)))).toBe('agree')
  })
})

describe.each(compared)('$name', (fixture) => {
  it.each(queriesOf(fixture))('agrees on declared_ranges %s', (pkg) => {
    const answer = bash(fixture.dir, 'declared_ranges', pkg)
    expect(agreement(answer, node.declaredRanges(treeOf(fixture.dir), pkg, null))).toBe('agree')
  })

  it.each(linesOf(fixture))('agrees on declared_ranges %s --line %i', (pkg, line) => {
    const answer = bash(fixture.dir, 'declared_ranges', '--line', String(line), pkg)
    expect(agreement(answer, node.declaredRanges(treeOf(fixture.dir), pkg, line))).toBe('agree')
  })

  describe('why, on a scratch copy', () => {
    let copy: Fixture
    beforeAll(() => {
      copy = useFixture(fixture.name)
    })
    afterAll(() => {
      copy.cleanup()
    })

    it.each(queriesOf(fixture))(
      'agrees on why %s',
      async (pkg) => {
        const answer = bash(copy.path, 'why', pkg)
        const raw = answer.status === 0 ? (JSON.parse(answer.stdout) as { raw: string }).raw : ''
        expect(agreement(answer, await node.why(treeOf(copy.path), pkg, { raw }))).toBe('agree')
      },
      WHY_TIMEOUT_MS,
    )
  })
})

describe('the usage refusals', () => {
  const [first] = compared
  if (first === undefined) throw new Error('no fixture to compare')

  it('agrees on why with no package name', async () => {
    const answer = bash(first.dir, 'why', '')
    expect(agreement(answer, await node.why(treeOf(first.dir), '', { raw: '' }))).toBe('agree')
  })

  it('agrees on declared_ranges with no package name', () => {
    const answer = bash(first.dir, 'declared_ranges', '')
    expect(agreement(answer, node.declaredRanges(treeOf(first.dir), '', null))).toBe('agree')
  })

  it.each([-1, 1.5])('agrees on declared_ranges --line %s', (line) => {
    const answer = bash(first.dir, 'declared_ranges', '--line', String(line), 'lodash')
    expect(agreement(answer, node.declaredRanges(treeOf(first.dir), 'lodash', line))).toBe('agree')
  })
})
