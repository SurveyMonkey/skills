// Parity for the lockfile readers (RFC 002, "Parity is the migration
// strategy"). It compares the `resolution_map` and `resolved_versions` verbs
// of node.sh with the npm, pnpm and yarn modules that replace their parsers
// (#220).
//
// The fixture set is discovered, not listed, so a new specimen joins this run
// with nothing to remember. Each fixture goes to the reader of the lockfile
// that `detect_raw` picks first. Two fixtures are out, and DECLARED below
// names each with its reason.
//
// `parents` is not here. No node.sh verb returns it. The `why` and
// `declared_ranges` verbs use it inside their own output, and both are #221.
// The unit tests prove it.
//
// The TypeScript side adds the fields that the verb adds around the parser.
// The semver parity run does the same for the arguments that `compare_versions`
// echoes. The added fields are `pm`, `package`, `present`, `count` and the
// renamed coverage counts.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as npm from '#gh-security/lockfiles/npm.ts'
import * as pnpm from '#gh-security/lockfiles/pnpm.ts'
import type { ResolutionMap, ResolvedVersions } from '#gh-security/lockfiles/shared.ts'
import * as yarn from '#gh-security/lockfiles/yarn.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { checkParity, type ParitySubject, runBash } from '#harness/parity.ts'
import { GH_SECURITY_ROOT } from '#harness/paths.ts'

const ADAPTER = join(GH_SECURITY_ROOT, 'scripts', 'ecosystems', 'node.sh')

type Reader = {
  readonly resolvedVersions: (text: string, pkg: string) => ResolvedVersions
  readonly resolutionMap: (text: string) => ResolutionMap
}

// The order of `detect_raw`: pnpm, then yarn, then npm.
const FORMATS: readonly { pm: string; lockfile: string; reader: Reader }[] = [
  { pm: 'pnpm', lockfile: 'pnpm-lock.yaml', reader: pnpm },
  { pm: 'yarn', lockfile: 'yarn.lock', reader: yarn },
  { pm: 'npm', lockfile: 'package-lock.json', reader: npm },
]

const DECLARED: Readonly<Record<string, string>> = {
  // The #50 fix. bash splits a snapshots key on its last `@`, so it names the
  // git parent `debug@git+ssh://git`. The module names it `debug`. The two
  // must differ here, and the unit test holds the expected value.
  'pnpm-git-parent': 'declared divergence: #50',
  // A Yarn Classic lockfile. `detect` refuses it with exit 3 before any
  // parser runs, and detection is not in these modules.
  'yarn-classic': 'refused by detect, not by a parser',
}

// The fixtures that both sides must refuse. They are an empty lockfile, a
// lockfileVersion 1 lockfile, and a lockfile that the parser reads too little
// of.
const REFUSED = new Set([
  'empty-npm',
  'empty-yarn',
  'npm-major-qualified',
  'npm-pins',
  'npm-v1',
  'pnpm-no-overrides',
  'pnpm-pins',
  'yarn-major-qualified',
  'yarn-pins',
  'yarn-unknown-protocol',
])

// The names an `npm:` alias installs a copy under. They are not keys of the
// map, and `resolved_versions` must answer for them too (#46).
const ALIAS_KEYS: Readonly<Record<string, readonly string[]>> = {
  'npm-alias': ['lodash-alias'],
  'npm-alias-installed': ['lodash-alias'],
  'yarn-alias': ['aliased', 'scoped-alias'],
  'yarn-berry-alias-parent': ['lodash-alias'],
}

const ABSENT = 'not-in-this-lockfile'

type Case = { name: string; dir: string; pm: string; text: string; reader: Reader }

const cases: Case[] = readdirSync(FIXTURES_ROOT)
  .sort()
  .filter((name) => !(name in DECLARED))
  .flatMap((name) => {
    const dir = join(FIXTURES_ROOT, name)
    const format = FORMATS.find(({ lockfile }) => existsSync(join(dir, lockfile)))
    if (format === undefined) return []
    const text = readFileSync(join(dir, format.lockfile), 'utf8')
    return [{ name, dir, pm: format.pm, text, reader: format.reader }]
  })

const mapAnswer = (pm: string, map: ResolutionMap) => ({
  pm,
  lockfile_entries: map.coverage.entries,
  entries_read: map.coverage.read,
  entries_expected: map.coverage.expected,
  unreadable_entries: map.coverage.expected - map.coverage.read,
  package_count: Object.keys(map.resolutions).length,
  // A fresh copy: `JsonValue` has no readonly arrays.
  resolutions: Object.fromEntries(
    Object.entries(map.resolutions).map(([name, versions]) => [name, [...versions]]),
  ),
})

const versionsAnswer = (pm: string, pkg: string, read: ResolvedVersions) => ({
  pm,
  package: pkg,
  present: read.copies.length > 0,
  count: read.copies.length,
  versions: read.copies.map((copy) => ({ ...copy })),
  lockfile_entries: read.coverage.entries,
})

const resolutionMapSubject: ParitySubject<Case> = {
  bash: ({ dir }) => ({ command: ADAPTER, args: ['resolution_map'], cwd: dir }),
  typescript: ({ pm, text, reader }) => mapAnswer(pm, reader.resolutionMap(text)),
}

const resolvedVersionsSubject: ParitySubject<readonly [Case, string]> = {
  bash: ([{ dir }, pkg]) => ({ command: ADAPTER, args: ['resolved_versions', pkg], cwd: dir }),
  typescript: ([{ pm, text, reader }, pkg]) =>
    versionsAnswer(pm, pkg, reader.resolvedVersions(text, pkg)),
}

// Both sides refuse for the same reason. bash writes the reason to stderr.
// `die` writes `{"error": ...}`. For lockfileVersion 1, jq writes its own error
// line. The check is that the bash stderr contains the TypeScript message.
const refusal = (bash: { cwd: string; args: string[] }, typescript: () => unknown): string => {
  const result = runBash({ command: ADAPTER, args: bash.args, cwd: bash.cwd })
  let message = 'the TypeScript side answered'
  try {
    typescript()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (result.status === 0) return `bash answered: ${result.stdout.trim()}`
  return result.stderr.includes(message) ? 'both refuse' : `bash: ${result.stderr.trim()}`
}

// The package names of the bash map. Each one becomes a query for the
// TypeScript side.
const bashPackages = ({ dir }: Case): string[] => {
  const result = runBash({ command: ADAPTER, args: ['resolution_map'], cwd: dir })
  const answer = JSON.parse(result.stdout) as { resolutions: Record<string, unknown> }
  return Object.keys(answer.resolutions)
}

const matched = { matched: true }

describe('the fixture set', () => {
  it('finds lockfiles of all three formats', () => {
    expect(new Set(cases.map(({ pm }) => pm))).toEqual(new Set(['npm', 'pnpm', 'yarn']))
  })

  it.each(Object.keys(DECLARED))('still carries the declared fixture %s', (name) => {
    expect(existsSync(join(FIXTURES_ROOT, name))).toBe(true)
  })

  it.each([...REFUSED])('still carries the refused fixture %s', (name) => {
    expect(cases.map((entry) => entry.name)).toContain(name)
  })
})

describe.each(cases.filter(({ name }) => !REFUSED.has(name)))('$name', (entry) => {
  it('agrees on resolution_map', () => {
    expect(checkParity(resolutionMapSubject, entry)).toEqual(matched)
  })

  const queries = [...bashPackages(entry), ...(ALIAS_KEYS[entry.name] ?? []), ABSENT]
  it.each(queries)('agrees on resolved_versions %s', (pkg) => {
    expect(checkParity(resolvedVersionsSubject, [entry, pkg])).toEqual(matched)
  })
})

describe.each(cases.filter(({ name }) => REFUSED.has(name)))('$name', (entry) => {
  it('is refused by both sides on resolution_map', () => {
    const verdict = refusal({ cwd: entry.dir, args: ['resolution_map'] }, () =>
      entry.reader.resolutionMap(entry.text),
    )
    expect(verdict).toBe('both refuse')
  })

  it('is refused by both sides on resolved_versions', () => {
    const verdict = refusal({ cwd: entry.dir, args: ['resolved_versions', 'lodash'] }, () =>
      entry.reader.resolvedVersions(entry.text, 'lodash'),
    )
    expect(verdict).toBe('both refuse')
  })
})
