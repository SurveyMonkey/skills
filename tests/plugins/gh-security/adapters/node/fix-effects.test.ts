// `fixEffects` of the node adapter (#334). The seam is `node.fixEffects`.
// Each pair is two real npm 11.19.0 runs of `npm install --package-lock-only
// --ignore-scripts`: the tree before the fix, which `before` reads as the
// last commit has it, and the tree after it. The expected values are written
// by hand from those runs. The PR of #334 has the table of the runs.
//
//   npm-stale-qualified-key-before  nx 22.7.7, with the key `nx@22.7.7`.
//   npm-stale-qualified-key         the field fix: nx 22.7.10, and the rule
//                                   `@nx/workspace > nx`. npm gave nx the
//                                   child of that rule, so the key matched
//                                   nothing. axios went to 1.18.1, and nx
//                                   got its own brace-expansion 5.0.8.
//   npm-stale-qualified-key-direct  nx 22.7.10 as the only dependency.
//   npm-qualified-key-range-edge    nx 22.7.10 beside @nx/devkit 22.7.7. The
//                                   peer range of devkit matched the key, so
//                                   axios stayed at 1.20.0.
//   npm-qualified-key-rekeyed       nx 22.7.10, with the key `nx@22.7.10`.
//
// A row that edits a copy of a specimen covers a shape that no run gave.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type {
  CommitSource,
  FixEffectsAnswer,
  FixObservation,
  Tree,
} from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { type Envelope, failed, ok } from '#gh-security/lib/envelope.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'

type Json = Record<string, unknown>

const treeAt = (root: string): Tree<NodeDetection> => {
  const detection = node.detect(root, {})
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

/** The files of a specimen, as the last commit has them. */
const commitOf =
  (fixture: string): CommitSource =>
  async (file) =>
    ok(readFileSync(join(FIXTURES_ROOT, fixture, file), 'utf8'))

/** A scratch copy of `fixture`, after `edit`. */
const copyOf = (fixture: string, edit: (dir: string) => void = () => {}): string => {
  const copy = useFixture(fixture)
  onTestFinished(copy.cleanup)
  edit(copy.path)
  return copy.path
}

const editJson =
  (file: string, change: (document: Json) => void) =>
  (dir: string): void => {
    const document = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Json
    change(document)
    writeFileSync(join(dir, file), `${JSON.stringify(document, null, 2)}\n`)
  }

/** The answer for the tree at `dir`, against the last commit that `before` reads. */
const effects = (
  dir: string,
  before: CommitSource,
  pkg = 'nx',
): Promise<Envelope<FixEffectsAnswer>> => node.fixEffects(treeAt(dir), pkg, before)

/** The observations of an answer, or a throw that names the failure. */
const observationsOf = async (
  envelope: Promise<Envelope<FixEffectsAnswer>>,
): Promise<readonly FixObservation[]> => {
  const answer = await envelope
  if (answer.outcome !== 'ok') throw new Error(`fixEffects failed: ${answer.error}`)
  return answer.value.observations
}

const SPECIMEN = 'npm-stale-qualified-key'
const BEFORE = commitOf('npm-stale-qualified-key-before')

const stale = (key: string, installed: string[]): FixObservation => {
  const at = key.lastIndexOf('@')
  return {
    type: 'stale_qualified_override',
    key,
    parent: key.slice(0, at),
    selector: key.slice(at + 1),
    installed,
  }
}

const down = (pkg: string, path: string, before: string, after: string): FixObservation => ({
  type: 'untargeted_downgrade',
  package: pkg,
  path,
  before,
  after,
})

const AXIOS = down('axios', 'node_modules/axios', '1.20.0', '1.18.1')

describe('fixEffects on real npm runs', () => {
  it('names the stale key and both downgrades of the field fix', async () => {
    expect(await observationsOf(effects(join(FIXTURES_ROOT, SPECIMEN), BEFORE))).toEqual([
      stale('nx@22.7.7', ['22.7.10']),
      AXIOS,
      down('brace-expansion', 'node_modules/nx/node_modules/brace-expansion', '5.0.12', '5.0.8'),
    ])
  })

  it('answers the whole envelope for the field fix', async () => {
    const answer = await effects(join(FIXTURES_ROOT, SPECIMEN), BEFORE)
    expect(answer.outcome === 'ok' && { ...answer.value, observations: [] }).toEqual({
      pm: 'npm',
      package: 'nx',
      observations: [],
    })
  })

  // The exact root edge 22.7.10 is the only edge into nx.
  it('names the stale key and each downgrade of a direct bump', async () => {
    const dir = join(FIXTURES_ROOT, 'npm-stale-qualified-key-direct')
    expect(await observationsOf(effects(dir, BEFORE))).toEqual([
      stale('nx@22.7.7', ['22.7.10']),
      AXIOS,
      down('balanced-match', 'node_modules/balanced-match', '4.0.4', '4.0.3'),
      down('brace-expansion', 'node_modules/brace-expansion', '5.0.12', '5.0.8'),
    ])
  })

  it('names no stale key when a range edge still matches it', async () => {
    const dir = join(FIXTURES_ROOT, 'npm-qualified-key-range-edge')
    expect(await observationsOf(effects(dir, BEFORE))).toEqual([])
  })

  // The fix wrote the key `nx@22.7.10`, which the root edge matches.
  it('names nothing when the fix moves packages up and its new key matches', async () => {
    const dir = join(FIXTURES_ROOT, 'npm-qualified-key-rekeyed')
    expect(await observationsOf(effects(dir, commitOf('npm-stale-qualified-key-direct')))).toEqual(
      [],
    )
  })

  it('does not name the target of the fix', async () => {
    expect(await observationsOf(effects(join(FIXTURES_ROOT, SPECIMEN), BEFORE, 'axios'))).toEqual([
      stale('nx@22.7.7', ['22.7.10']),
      down('brace-expansion', 'node_modules/nx/node_modules/brace-expansion', '5.0.12', '5.0.8'),
    ])
  })

  // The key already matched nothing on the default branch.
  it('does not name a key that was stale before the fix', async () => {
    const dir = join(FIXTURES_ROOT, 'npm-stale-qualified-key-direct')
    expect(await observationsOf(effects(dir, commitOf('npm-stale-qualified-key-direct')))).toEqual(
      [],
    )
  })

  it('names nothing for a tree with no qualified key and no change', async () => {
    const dir = join(FIXTURES_ROOT, 'npm-v3')
    expect(await observationsOf(effects(dir, commitOf('npm-v3')))).toEqual([])
  })
})

/** The direct specimen, with the spec of the root edge into nx changed. */
const rootSpec = (spec: string) =>
  copyOf(
    'npm-stale-qualified-key-direct',
    editJson('package-lock.json', (lock) => {
      const root = (lock.packages as Record<string, Json>)[''] as Json
      ;(root.dependencies as Json).nx = spec
    }),
  )

/** The direct specimen, with the key `nx@22.7.7` renamed. */
const renamedKey = (key: string) =>
  copyOf(
    'npm-stale-qualified-key-direct',
    editJson('package.json', (manifest) => {
      const overrides = manifest.overrides as Json
      manifest.overrides = { [key]: overrides['nx@22.7.7'] }
    }),
  )

describe('fixEffects, the edge rule for each spec', () => {
  // npm matches a tag, a file or a directory edge by name, and a git edge by
  // its range when it has one. The verb does not decide those, so it names
  // no key.
  it.each(['latest', 'file:../nx', 'github:nrwl/nx', 'npm:nx@22.7.10'])(
    'names no stale key beside an edge of the spec %s',
    async (spec) => {
      expect(await observationsOf(effects(rootSpec(spec), BEFORE))).not.toContainEqual(
        expect.objectContaining({ type: 'stale_qualified_override' }),
      )
    },
  )

  it.each([
    ['^22.7.0', false],
    ['~22.7.8', true],
    ['>=22.7.8 <23', true],
  ])('a range edge %s beside the exact key: stale is %s', async (spec, isStale) => {
    const found = await observationsOf(effects(rootSpec(spec), BEFORE))
    expect(found.some(({ type }) => type === 'stale_qualified_override')).toBe(isStale)
  })

  it.each([
    ['an exact edge that the selector admits', '22.7.7', false],
    ['an exact edge with a v', 'v22.7.10', true],
  ])('%s', async (_name, spec, isStale) => {
    const found = await observationsOf(effects(rootSpec(spec), BEFORE))
    expect(found.some(({ type }) => type === 'stale_qualified_override')).toBe(isStale)
  })

  // A range selector beside a range edge needs `intersects`, which the
  // range rules do not have. A selector that they cannot read is the same.
  it.each([
    ['~22.7.0', '^22.7.0', false],
    ['~22.7.0', '22.7.10', false],
    ['~22.6.0', '22.7.10', true],
    ['latest', '22.7.10', false],
    ['>=', '22.7.10', false],
  ])('the key nx@%s beside an edge %s: stale is %s', async (selector, spec, isStale) => {
    const dir = renamedKey(`nx@${selector}`)
    editJson('package-lock.json', (lock) => {
      const root = (lock.packages as Record<string, Json>)[''] as Json
      ;(root.dependencies as Json).nx = spec
    })(dir)
    // The renamed key is not in the block of the last commit, so it counts
    // as a key that matched before the fix.
    const found = await observationsOf(effects(dir, commitOf('npm-stale-qualified-key-direct')))
    expect(found.some(({ type }) => type === 'stale_qualified_override')).toBe(isStale)
  })
})

/** The specimen before the fix, with `edit` on its manifest. */
const beforeWith =
  (edit: (manifest: Json) => void): CommitSource =>
  async (file) => {
    const text = await BEFORE(file)
    if (file !== 'package.json' || text.outcome !== 'ok') return text
    const manifest = JSON.parse(text.value) as Json
    edit(manifest)
    return ok(JSON.stringify(manifest))
  }

/** A manifest edit that adds one key to the block. */
const addKey =
  (key: string, value: unknown) =>
  (manifest: Json): void => {
    manifest.overrides = { ...(manifest.overrides as Json), [key]: value }
  }

describe('fixEffects, the keys of each side', () => {
  // The key matched the root edge into @nx/workspace before the fix, and the
  // tree after it has no copy of @nx/workspace.
  it('names a stale key for a parent that the fix removed', async () => {
    const edit = addKey('@nx/workspace@22.7.7', { chalk: '^4.1.0' })
    const dir = copyOf('npm-stale-qualified-key-direct', editJson('package.json', edit))
    const found = await observationsOf(effects(dir, beforeWith(edit)))
    expect(found.filter(({ type }) => type === 'stale_qualified_override')).toEqual([
      stale('nx@22.7.7', ['22.7.10']),
      stale('@nx/workspace@22.7.7', []),
    ])
  })

  // The fix wrote the key, so it counts as one that matched before.
  it('names a key that only the manifest after the fix has', async () => {
    const edit = addKey('left-pad@1.3.0', { axios: '1' })
    const found = await observationsOf(
      effects(copyOf(SPECIMEN, editJson('package.json', edit)), BEFORE),
    )
    expect(found.filter(({ type }) => type === 'stale_qualified_override')).toEqual([
      stale('nx@22.7.7', ['22.7.10']),
      stale('left-pad@1.3.0', []),
    ])
  })

  // A rule of lerna places nx 22.7.9. The copy 22.6.0 of zed is normal, and
  // the range edge ^22.0.0 matches the key `nx@22.6.0`.
  it('names no stale key that a normal copy beside a placed one matches', async () => {
    const zed = (dir: string): void => {
      editJson('package-lock.json', (lock) => {
        const packages = lock.packages as Record<string, Json>
        ;((packages[''] as Json).dependencies as Json).zed = '^1.0.0'
        packages['node_modules/zed'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
        packages['node_modules/zed/node_modules/nx'] = { version: '22.6.0' }
      })(dir)
      editJson('package.json', addKey('nx@22.6.0', { 'brace-expansion': '>=5.0.9 <6' }))(dir)
    }
    const dir = copyOf('npm-override-placed-parent', zed)
    const found = await observationsOf(
      effects(dir, commitOf('npm-override-placed-parent'), 'brace-expansion'),
    )
    expect(found).toEqual([])
  })

  it('does not name a key that matched nothing on either side', async () => {
    const edit = addKey('left-pad@1.3.0', { axios: '1' })
    const dir = copyOf(SPECIMEN, editJson('package.json', edit))
    const found = await observationsOf(effects(dir, beforeWith(edit)))
    expect(found.filter(({ type }) => type === 'stale_qualified_override')).toEqual([
      stale('nx@22.7.7', ['22.7.10']),
    ])
  })
})

describe('fixEffects, the versions it compares', () => {
  // The field fix moved axios down. With no version, or a version that does
  // not parse, on the copy after it, nothing is compared.
  it.each([
    ['no version', undefined],
    ['a version that does not parse', 'not-a-version'],
  ])('does not compare a copy with %s', async (_name, version) => {
    const dir = copyOf(
      SPECIMEN,
      editJson('package-lock.json', (lock) => {
        const axios = (lock.packages as Record<string, Json>)['node_modules/axios'] as Json
        if (version === undefined) delete axios.version
        else axios.version = version
      }),
    )
    const found = await observationsOf(effects(dir, BEFORE))
    expect(found.map((each) => ('package' in each ? each.package : each.type))).toEqual([
      'stale_qualified_override',
      'brace-expansion',
    ])
  })
})

describe('fixEffects, a read that fails', () => {
  it.each(['package-lock.json', 'package.json'])(
    'names %s when the last commit cannot give it',
    async (missing) => {
      const before: CommitSource = async (file) =>
        file === missing ? failed('fatal: path not in HEAD') : BEFORE(file)
      expect(await effects(join(FIXTURES_ROOT, SPECIMEN), before)).toEqual(
        failed(
          `fix_effects: cannot read ${missing} as the last commit has it: fatal: path not in HEAD`,
        ),
      )
    },
  )

  it.each([
    ['text that is not JSON', '{', 'is not JSON'],
    ['a lockfile with no packages', '{"lockfileVersion":3,"packages":{}}', 'holds no packages'],
    ['a lockfile of only white space', ' \n', 'is not JSON'],
  ])('names the lockfile of the last commit for %s', async (_name, text, words) => {
    const before: CommitSource = async (file) =>
      file === 'package-lock.json' ? ok(text) : BEFORE(file)
    const answer = await effects(join(FIXTURES_ROOT, SPECIMEN), before)
    expect(answer.outcome === 'failed' && answer.error).toBe(
      `fix_effects: the package-lock.json of the last commit ${words}.`,
    )
  })

  it('names the lockfile of the tree when it holds no packages', async () => {
    const dir = copyOf(
      SPECIMEN,
      editJson('package-lock.json', (lock) => {
        lock.packages = {}
      }),
    )
    const answer = await effects(dir, BEFORE)
    expect(answer.outcome === 'failed' && answer.error).toBe(
      'fix_effects: the package-lock.json of the tree holds no packages.',
    )
  })

  it('names a manifest of the tree that is not JSON', async () => {
    const dir = copyOf(SPECIMEN, (path) => writeFileSync(join(path, 'package.json'), '{'))
    const answer = await effects(dir, BEFORE)
    expect(answer.outcome === 'failed' && answer.error).toBe(
      'fix_effects: the package.json of the tree is not JSON.',
    )
  })

  it('names a manifest of the last commit that is not JSON', async () => {
    const before: CommitSource = async (file) => (file === 'package.json' ? ok('{') : BEFORE(file))
    const answer = await effects(join(FIXTURES_ROOT, SPECIMEN), before)
    expect(answer.outcome === 'failed' && answer.error).toBe(
      'fix_effects: the package.json of the last commit is not JSON.',
    )
  })

  it('is unsupported for a tree that is not npm', async () => {
    const answer = await node.fixEffects(treeAt(join(FIXTURES_ROOT, 'pnpm-v9')), 'nx', BEFORE)
    expect(answer.outcome).toBe('unsupported')
  })
})
