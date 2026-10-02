// Parity for the node adapter verbs (RFC 002, "Parity is the migration
// strategy"). Each example runs one verb of node.sh and the same verb of
// `node` on one input, and compares the two answers: the outcome and the
// payload both. The verbs are `detect`, `resolved_versions`,
// `resolution_map`, `compare_versions` and `range_facts` (#221, layer 1).
//
// The lockfile parity run proves the parsers, and the semver parity run
// proves the semver module. This file proves what the verbs add around
// them: detection, the choice of reader, the added fields and the envelope.
//
// The fixture set is discovered, not listed. `detect` runs on every
// directory under spec/fixtures/, so `bun` and `yarn-classic` are in: both
// sides must refuse them with exit 3. The other verbs run on each fixture
// that bash `detect` accepts. The `compare_versions` pairs and the
// `range_facts` pairs come from the same fixtures: the versions of their
// lockfiles, and the ranges of their manifests.
//
// Both sides get one PATH (#221, round 3 ruling 9). `runBash` gives bash
// the environment of this process, and the TypeScript side reads PATH from
// that same environment.
//
// No fixture is out. `pnpm-git-parent` was, as the #50
// divergence. But bash and the port agree on its `resolved_versions` and
// `resolution_map`: the git copy is no registry copy on either side. The #50
// divergence is in the name of the parent, which parity-node-tree.test.ts
// declares, and in the `apply_constraint` refusal of ruling 2 on #50.
//
// Declared divergence in the exit status: where jq itself stops, bash exits
// with jq's own status 5, and writes jq's own message. That status is not
// one of the four of ADR 001. The TypeScript side answers `failed` (exit 1)
// with its own message, so there the check is the refusal alone. It occurs
// for a lockfileVersion 1 lockfile and for a version with nothing to compare
// in it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import {
  type Envelope,
  exitCodeFor,
  type JsonValue,
  renderJson,
} from '#gh-security/lib/envelope.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { type BashResult, firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'

const ADAPTER = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

const ENV = { PATH: process.env.PATH }

/** The status jq exits with when its program stops with an error. */
const JQ_ERROR = 5

// The names an `npm:` alias installs a copy under. They are not keys of the
// map, and `resolved_versions` must answer for them too (ADR 001, "One
// documented exception").
const ALIAS_KEYS: Readonly<Record<string, readonly string[]>> = {
  'npm-alias': ['lodash-alias'],
  'npm-alias-installed': ['lodash-alias'],
  'yarn-alias': ['aliased', 'scoped-alias'],
  'yarn-berry-alias-parent': ['lodash-alias'],
}

const ABSENT = 'not-in-this-lockfile'

const MANIFEST_BLOCKS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

const bash = (cwd: string, ...args: string[]): BashResult =>
  runBash({ command: ADAPTER, args, cwd })

/** A fresh copy that `JsonValue` admits: it has no readonly arrays. */
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

/**
 * 'agree', or the first disagreement in words.
 *
 * bash writes a refusal to stderr. `die` and the exit 3 branches write one
 * line of JSON, which must equal the body that the entry point renders from
 * the TypeScript envelope. The `${1:?}` usage guard writes prose, which must
 * contain the TypeScript message. Where jq stops, only the refusal counts.
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

type Fixture = { readonly name: string; readonly dir: string; readonly detected: BashResult }

const fixtures: Fixture[] = readdirSync(FIXTURES_ROOT)
  .sort()
  .filter((name) => statSync(join(FIXTURES_ROOT, name)).isDirectory())
  .map((name) => {
    const dir = join(FIXTURES_ROOT, name)
    return { name, dir, detected: bash(dir, 'detect') }
  })

/** The tree that the TypeScript side reads, from its own `detect`. */
const treeOf = (dir: string): Tree<NodeDetection> => {
  const detection = node.detect(dir, ENV)
  if (detection.outcome !== 'ok') {
    throw new Error(`TypeScript detect refused ${dir}: ${detection.error}`)
  }
  return { root: dir, detection: detection.value }
}

type Accepted = Fixture & { readonly map: BashResult }

const accepted: Accepted[] = fixtures
  .filter(({ detected }) => detected.status === 0)
  .map((fixture) => ({ ...fixture, map: bash(fixture.dir, 'resolution_map') }))

/** The map that bash answers, or none when bash refuses the lockfile. */
const resolutionsOf = ({ map }: Accepted): Readonly<Record<string, readonly string[]>> =>
  map.status === 0
    ? (JSON.parse(map.stdout) as { resolutions: Record<string, string[]> }).resolutions
    : {}

const queriesOf = (fixture: Accepted): string[] => {
  const names = Object.keys(resolutionsOf(fixture))
  return [...(names.length > 0 ? names : ['lodash']), ...(ALIAS_KEYS[fixture.name] ?? []), ABSENT]
}

// Two versions of one package, both ways round.
const versionPairs: (readonly [string, string, string])[] = accepted.flatMap((fixture) =>
  Object.values(resolutionsOf(fixture)).flatMap((versions) => {
    const first = versions[0]
    const last = versions.at(-1)
    return first === undefined || last === undefined || first === last
      ? []
      : [[fixture.name, first, last] as const, [fixture.name, last, first] as const]
  }),
)

// Each range the root manifest declares, against a version the lockfile holds.
const rangePairs: (readonly [string, string, string])[] = accepted.flatMap((fixture) => {
  const manifestPath = join(fixture.dir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const resolutions = resolutionsOf(fixture)
  return MANIFEST_BLOCKS.flatMap((block) =>
    Object.entries((manifest[block] ?? {}) as Record<string, unknown>).flatMap(([name, range]) => {
      const version = resolutions[name]?.[0]
      return typeof range === 'string' && version !== undefined
        ? [[fixture.name, range, version] as const]
        : []
    }),
  )
})

describe('the fixture set', () => {
  it('holds a fixture that each manager accepts, and each refusal of detect', () => {
    const accept = (pm: string) =>
      accepted.some(({ detected }) => (JSON.parse(detected.stdout) as { pm: string }).pm === pm)
    const statuses = new Map(fixtures.map(({ name, detected }) => [name, detected.status]))
    expect({
      npm: accept('npm'),
      pnpm: accept('pnpm'),
      yarn: accept('yarn'),
      bun: statuses.get('bun'),
      'yarn-classic': statuses.get('yarn-classic'),
      'no-lockfile': statuses.get('no-lockfile'),
    }).toEqual({ npm: true, pnpm: true, yarn: true, bun: 3, 'yarn-classic': 3, 'no-lockfile': 1 })
  })

  it.each(Object.keys(ALIAS_KEYS))('still accepts the alias fixture %s', (name) => {
    expect(accepted.map((fixture) => fixture.name)).toContain(name)
  })

  // These fixtures were out until #50. Now each side must agree on them.
  it.each(['pnpm-git-parent', 'pnpm-git-parent-copies'])(
    'compares the git parent fixture %s',
    (name) => {
      expect(accepted.map((fixture) => fixture.name)).toContain(name)
    },
  )

  it('finds version pairs and range pairs to compare', () => {
    expect({ versions: versionPairs.length > 0, ranges: rangePairs.length > 0 }).toEqual({
      versions: true,
      ranges: true,
    })
  })
})

describe('detect', () => {
  it.each(fixtures)('agrees on $name', ({ dir, detected }) => {
    expect(agreement(detected, node.detect(dir, ENV))).toBe('agree')
  })
})

describe.each(accepted)('$name', (fixture) => {
  it('agrees on resolution_map', () => {
    expect(agreement(fixture.map, node.resolutionMap(treeOf(fixture.dir)))).toBe('agree')
  })

  it.each(queriesOf(fixture))('agrees on resolved_versions %s', (pkg) => {
    const answer = bash(fixture.dir, 'resolved_versions', pkg)
    expect(agreement(answer, node.resolvedVersions(treeOf(fixture.dir), pkg))).toBe('agree')
  })
})

describe('resolved_versions without a package name', () => {
  it.each(accepted.slice(0, 1))('agrees on $name', ({ dir }) => {
    expect(
      agreement(bash(dir, 'resolved_versions', ''), node.resolvedVersions(treeOf(dir), '')),
    ).toBe('agree')
  })
})

describe('compare_versions', () => {
  it.each(versionPairs)('agrees on %s %s %s', (_fixture, a, b) => {
    expect(
      agreement(bash(FIXTURES_ROOT, 'compare_versions', a, b), node.compareVersions(a, b)),
    ).toBe('agree')
  })

  // The usage guard, and a version with nothing in it to compare.
  it.each([
    ['', '1.0.0'],
    ['1.0.0', ''],
    ['v', '1.0.0'],
    ['1.0.0', '+build'],
  ])('agrees on the refusal of %j %j', (a, b) => {
    expect(
      agreement(bash(FIXTURES_ROOT, 'compare_versions', a, b), node.compareVersions(a, b)),
    ).toBe('agree')
  })
})

describe('range_facts', () => {
  it.each(rangePairs)('agrees on %s %s %s', (_fixture, range, version) => {
    const answer = bash(FIXTURES_ROOT, 'range_facts', range, version)
    expect(agreement(answer, node.rangeFacts(range, version))).toBe('agree')
  })

  // The usage guard, a version with nothing in it, and a range that is not one.
  it.each([
    ['', '1.0.0'],
    ['^1.0.0', ''],
    ['^1.0.0', 'v'],
    ['workspace:^', '1.0.0'],
  ])('agrees on %j %j', (range, version) => {
    const answer = bash(FIXTURES_ROOT, 'range_facts', range, version)
    expect(agreement(answer, node.rangeFacts(range, version))).toBe('agree')
  })
})
