// `declared_ranges` of the node adapter (#221). The seam is the `node`
// adapter. Each expected value is written by hand from the fixture that it
// names, and was checked against `node.sh declared_ranges` on the same
// tree. The parity run holds the agreement on every fixture.
//
// The installed manifests are the ones that the fixtures carry: npm-v3,
// npm-alias-installed and yarn-line-scoped. An example that needs another
// shape changes a manifest of a scratch copy, as the shellspec suite does. It
// never types a manifest of its own.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { DeclaredRangesAnswer, Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'

/** One empty PATH entry, the tree root, which holds no tool. `declared_ranges` starts no process. */
const NO_PATH = { PATH: '' }

const treeAt = (root: string): Tree<NodeDetection> => {
  const detection = node.detect(root, NO_PATH)
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

const tree = (name: string): Tree<NodeDetection> => treeAt(join(FIXTURES_ROOT, name))

/** A scratch copy of a fixture, and its tree as `detect` answers before a change. */
const copyOf = (name: string): Tree<NodeDetection> => {
  const fixture = useFixture(name)
  onTestFinished(fixture.cleanup)
  return treeAt(fixture.path)
}

/** Change the JSON file at `path` in the copy. */
const edit = (root: string, path: string, change: (json: Record<string, unknown>) => unknown) => {
  const file = join(root, path)
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8')))))
}

/** The answer, without the two fields that echo the call. */
const body = (answer: ReturnType<typeof node.declaredRanges>) => {
  if (answer.outcome !== 'ok') throw new Error(`declared_ranges refused: ${answer.error}`)
  const { pm: _pm, package: _package, ...rest } = answer.value
  return rest
}

const NONE = {
  parents_without_range: [],
  parents_unreadable: [],
  parents_malformed: [],
  parents_other_lines: [],
} as const

describe('declared_ranges with no line', () => {
  it('reads an installed manifest, a nested copy from the lockfile, and the root', () => {
    expect(node.declaredRanges(tree('npm-v3'), 'lodash', null)).toEqual({
      outcome: 'ok',
      value: {
        pm: 'npm',
        package: 'lodash',
        line: null,
        ranges: ['^3.0.0', '^4.17.20', '^4.17.21'],
        root_range: '^4.17.21',
        parents_read: ['express', 'test-exclude'],
        ...NONE,
      } satisfies DeclaredRangesAnswer,
    })
  })

  // #48: the range of an alias declaration is read under both names.
  it.each([
    ['lodash', ['^4.17.21', '^4.18.0'], '^4.17.21', ['alias-parent', 'dupe-parent']],
    ['lodash-alias', ['npm:lodash@^4.18.0'], 'npm:lodash@^4.18.0', ['alias-parent']],
  ])('reads the installed alias declarations of %s', (pkg, ranges, root, read) => {
    expect(body(node.declaredRanges(tree('npm-alias-installed'), pkg, null))).toEqual({
      line: null,
      ranges,
      root_range: root,
      parents_read: read,
      ...NONE,
    })
  })

  // pnpm snapshots record no declared range (#100).
  it('names each pnpm parent unreadable, and keeps the root range', () => {
    expect(body(node.declaredRanges(tree('pnpm-cross-line'), 'minimatch', null))).toEqual({
      line: null,
      ranges: ['^10.2.5'],
      root_range: '^10.2.5',
      parents_read: [],
      ...NONE,
      parents_unreadable: ['@ts-morph/common', 'filelist', 'glob'],
    })
  })

  // #50: bash names this parent `debug@git+ssh://git`.
  it('names a pnpm git parent by the name before its first @', () => {
    expect(body(node.declaredRanges(tree('pnpm-git-parent'), 'ms', null))).toEqual({
      line: null,
      ranges: [],
      root_range: null,
      parents_read: [],
      ...NONE,
      parents_unreadable: ['debug'],
    })
  })

  // The key is the package, so the range is the whole value, alias and all.
  it('reads the root range from devDependencies, as the value declares it', () => {
    const { root, detection } = copyOf('yarn-line-scoped')
    edit(root, 'package.json', (json) => ({
      ...json,
      devDependencies: { undici: 'npm:undici@^6.1.0' },
    }))
    expect(body(node.declaredRanges({ root, detection }, 'undici', null)).root_range).toBe(
      'npm:undici@^6.1.0',
    )
  })

  it('reads an empty root range as none', () => {
    const { root, detection } = copyOf('yarn-line-scoped')
    edit(root, 'package.json', (json) => ({ ...json, dependencies: { undici: '' } }))
    expect(body(node.declaredRanges({ root, detection }, 'undici', null)).root_range).toBeNull()
  })

  it('reads no root range from a root manifest of no document', () => {
    const { root, detection } = copyOf('npm-v3')
    writeFileSync(join(root, 'package.json'), '')
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^3.0.0', '^4.17.20'],
      root_range: null,
    })
  })
})

describe('declared_ranges of an installed manifest', () => {
  const express = 'node_modules/express/package.json'

  it('reads a manifest that is on disk but does not parse as malformed', () => {
    const { root, detection } = copyOf('npm-v3')
    writeFileSync(join(root, express), '{')
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^3.0.0', '^4.17.21'],
      parents_read: ['test-exclude'],
      parents_unreadable: ['express'],
      parents_malformed: ['express'],
    })
  })

  it('reads a block that is not an object as malformed', () => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, express, (json) => ({ ...json, dependencies: 'x' }))
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      parents_unreadable: ['express'],
      parents_malformed: ['express'],
    })
  })

  it('reads a block that is a list, as jq does', () => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, express, (json) => ({ ...json, dependencies: ['npm:lodash@^1'] }))
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^1', '^3.0.0', '^4.17.21'],
      parents_read: ['express', 'test-exclude'],
    })
  })

  it.each([
    ['no declaration', (json: Record<string, unknown>) => ({ ...json, dependencies: {} })],
    [
      'a range that is not text',
      (json: Record<string, unknown>) => ({ ...json, dependencies: { lodash: 4 } }),
    ],
    [
      'only empty ranges',
      (json: Record<string, unknown>) => ({
        ...json,
        dependencies: { lodash: '' },
        peerDependencies: { lodash: '' },
      }),
    ],
  ])('reads a parent with %s as read, and without a range', (_shape, change) => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, express, change)
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^3.0.0', '^4.17.21'],
      parents_read: ['express', 'test-exclude'],
      parents_without_range: ['express'],
    })
  })

  it('reads a manifest of no document as read, and without a range', () => {
    const { root, detection } = copyOf('npm-v3')
    writeFileSync(join(root, express), '')
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      parents_without_range: ['express'],
    })
  })

  // #85: with no manifest on disk, the lockfile answers for the one copy.
  it('reads the lockfile for a parent whose manifest is not installed', () => {
    const { root, detection } = copyOf('npm-v3')
    rmSync(join(root, express))
    mkdirSync(join(root, express))
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^3.0.0', '^4.17.20', '^4.17.21'],
      parents_read: ['express', 'test-exclude'],
      parents_unreadable: [],
    })
  })

  // An aliasing parent with no `npm:<pkg>@` row, and no manifest: nothing reads it.
  it('names a parent with no row and no installed manifest unreadable', () => {
    const { root, detection } = copyOf('npm-alias')
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      parents_read: ['alias-parent', 'dupe-parent'],
      parents_unreadable: [],
    })
    edit(root, 'package-lock.json', (json) => {
      const packages = json.packages as Record<string, Record<string, unknown>>
      packages['node_modules/alias-parent'] = {
        ...packages['node_modules/alias-parent'],
        dependencies: { 'lodash-alias': 'npm:lodash' },
      }
      return json
    })
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      parents_read: ['dupe-parent'],
      parents_unreadable: ['alias-parent'],
      parents_malformed: [],
    })
  })
})

describe('declared_ranges of lockfile rows', () => {
  const lockfile = 'package-lock.json'
  type Lock = { packages: Record<string, Record<string, unknown>> }

  // npm writes a bare `""` specifier as it is. It is no range. node.sh
  // writes `-` for no range in its rows, so a `-` range is none too.
  it.each([[''], ['-']])('reads a copy that declares the range %j as unreadable', (range) => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, lockfile, (json) => {
      const { packages } = json as unknown as Lock
      ;(packages['node_modules/test-exclude']?.dependencies as Record<string, string>).lodash =
        range
      return json
    })
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^4.17.20', '^4.17.21'],
      parents_read: ['express'],
      parents_unreadable: ['test-exclude'],
    })
  })

  it('names a parent read when one copy has a range and one has none', () => {
    const { root, detection } = copyOf('npm-scoped-parents')
    edit(root, lockfile, (json) => {
      const { packages } = json as unknown as Lock
      ;(packages['node_modules/minimatch']?.dependencies as Record<string, string>)[
        'brace-expansion'
      ] = ''
      return json
    })
    expect(body(node.declaredRanges({ root, detection }, 'brace-expansion', null))).toMatchObject({
      ranges: ['^2.0.2', '^5.0.5'],
      parents_read: ['minimatch', 'packages/tool'],
      parents_unreadable: [],
    })
  })

  // A parent at two versions answers from the lockfile, even with a manifest on disk (#85).
  it('reads each copy of a parent at two versions, and not its installed manifest', () => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, lockfile, (json) => {
      const { packages } = json as unknown as Lock
      packages['node_modules/test-exclude/node_modules/express'] = {
        version: '4.17.0',
        dependencies: { lodash: '^4.0.0' },
      }
      return json
    })
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^3.0.0', '^4.0.0', '^4.17.20', '^4.17.21'],
      parents_read: ['express', 'test-exclude'],
    })
  })

  it('drops an empty range of a manifest that also declares a range', () => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, 'node_modules/express/package.json', (json) => ({
      ...json,
      dependencies: { lodash: '' },
      peerDependencies: { lodash: '^4.1.0' },
    }))
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null))).toMatchObject({
      ranges: ['^3.0.0', '^4.1.0', '^4.17.21'],
      parents_without_range: [],
    })
  })

  // node.sh reads the ranges of a manifest as lines of text.
  it('reads a manifest range that holds a newline as two ranges', () => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, 'node_modules/express/package.json', (json) => ({
      ...json,
      dependencies: { lodash: '^4.17.20\n^4.0.0' },
    }))
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null)).ranges).toEqual([
      '^3.0.0',
      '^4.0.0',
      '^4.17.20',
      '^4.17.21',
    ])
  })

  it('reads a root block of false as no block', () => {
    const { root, detection } = copyOf('npm-v3')
    edit(root, 'package.json', (json) => ({ ...json, optionalDependencies: false }))
    expect(body(node.declaredRanges({ root, detection }, 'lodash', null)).root_range).toBe(
      '^4.17.21',
    )
  })
})

describe('declared_ranges on one line', () => {
  it('files the nested copy of a parent on another line with its version', () => {
    expect(body(node.declaredRanges(tree('npm-v3'), 'lodash', 4))).toEqual({
      line: 4,
      ranges: ['^4.17.20', '^4.17.21'],
      root_range: '^4.17.21',
      parents_read: ['express'],
      ...NONE,
      parents_other_lines: ['test-exclude@6.0.0'],
    })
  })

  // No copy of lodash is installed for express or for the root, so both stay.
  it('keeps a dependent whose line is unknown', () => {
    expect(body(node.declaredRanges(tree('npm-v3'), 'lodash', 3))).toMatchObject({
      ranges: ['^3.0.0', '^4.17.20', '^4.17.21'],
      parents_read: ['express', 'test-exclude'],
      parents_other_lines: [],
    })
  })

  // The walk up node_modules: a nested copy first, then the hoisted one.
  it.each([
    [
      6,
      ['5.28.4', '^6.22.0', '^6.23.0'],
      ['@sentry/cli', '@vercel/blob', '@vercel/node'],
      ['@vercel/sandbox', 'vercel'],
    ],
    [5, ['5.29.0'], ['vercel'], ['@sentry/cli', '@vercel/blob', '@vercel/node', '@vercel/sandbox']],
  ])('walks up node_modules for line %i', (line, ranges, read, other) => {
    expect(body(node.declaredRanges(tree('yarn-line-scoped'), 'undici', line))).toEqual({
      line,
      ranges,
      root_range: null,
      parents_read: read,
      ...NONE,
      parents_other_lines: other,
    })
  })

  const nested = 'node_modules/vercel/node_modules/undici/package.json'

  // On line 5, the hoisted copy (6.x) files vercel on another line. A search
  // that stopped at the nested manifest would keep vercel as unknown.
  const ALL_OFF = {
    ranges: [],
    parents_read: [],
    parents_other_lines: [
      '@sentry/cli',
      '@vercel/blob',
      '@vercel/node',
      '@vercel/sandbox',
      'vercel',
    ],
  }

  it.each([
    ['no version', (json: Record<string, unknown>) => ({ ...json, version: undefined })],
    ['a version that is a number', (json: Record<string, unknown>) => ({ ...json, version: 7 })],
  ])('goes on to the hoisted copy past a nested manifest with %s', (_shape, change) => {
    const { root, detection } = copyOf('yarn-line-scoped')
    edit(root, nested, change)
    expect(body(node.declaredRanges({ root, detection }, 'undici', 5))).toMatchObject(ALL_OFF)
  })

  it.each([['{'], ['[1]']])('goes on to the hoisted copy past a nested manifest of %j', (text) => {
    const { root, detection } = copyOf('yarn-line-scoped')
    writeFileSync(join(root, nested), text)
    expect(body(node.declaredRanges({ root, detection }, 'undici', 5))).toMatchObject(ALL_OFF)
  })

  it('reads a nested version with a leading v', () => {
    const { root, detection } = copyOf('yarn-line-scoped')
    edit(root, nested, (json) => ({ ...json, version: 'v7.0.0' }))
    expect(body(node.declaredRanges({ root, detection }, 'undici', 7))).toMatchObject({
      parents_read: ['@vercel/sandbox', 'vercel'],
    })
  })

  it.each([
    [5, null, ['__root__', '@sentry/cli', '@vercel/blob', '@vercel/node', '@vercel/sandbox']],
    [6, '^6.0.0', ['@vercel/sandbox', 'vercel']],
  ])('files the root by its hoisted copy on line %i', (line, rootRange, other) => {
    const { root, detection } = copyOf('yarn-line-scoped')
    edit(root, 'package.json', (json) => ({ ...json, dependencies: { undici: '^6.0.0' } }))
    expect(body(node.declaredRanges({ root, detection }, 'undici', line))).toMatchObject({
      root_range: rootRange,
      parents_other_lines: other,
    })
  })

  // #85: each copy of a multi-copy parent answers from the lockfile.
  it('files each copy of a yarn parent by the line that it resolves', () => {
    expect(body(node.declaredRanges(tree('yarn-cross-line'), 'brace-expansion', 5))).toEqual({
      line: 5,
      ranges: ['^5.0.5'],
      root_range: null,
      parents_read: ['minimatch'],
      ...NONE,
      parents_other_lines: ['minimatch@3.1.5'],
    })
  })

  // #121: the walk up past a scoped path segment.
  it('files npm copies under scoped paths by the copy that each resolves', () => {
    expect(
      body(node.declaredRanges(tree('npm-scoped-parents'), 'brace-expansion', 2)),
    ).toMatchObject({
      ranges: ['^2.0.2'],
      parents_read: ['minimatch', 'packages/tool'],
      parents_other_lines: ['minimatch@10.0.3', 'minimatch@10.2.5'],
    })
  })

  // #100: pnpm answers the line of the root from `importers:`, and of each parent from its edges.
  it('files the pnpm root and each pnpm parent by the lockfile', () => {
    expect(body(node.declaredRanges(tree('pnpm-cross-line'), 'minimatch', 4))).toEqual({
      line: 4,
      ranges: [],
      root_range: null,
      parents_read: [],
      ...NONE,
      parents_other_lines: ['__root__', '@ts-morph/common@0.26.1', 'filelist@1.0.4', 'glob@7.2.3'],
    })
  })

  it.each([
    [4, { parents_unreadable: ['express'], parents_other_lines: [] }],
    [3, { parents_unreadable: [], parents_other_lines: ['express@4.18.2'] }],
  ])('files a pnpm parent with one copy on line %i', (line, lists) => {
    expect(body(node.declaredRanges(tree('pnpm-v9'), 'lodash', line))).toMatchObject(lists)
  })

  // Any edge on the line keeps the parent. A URL edge has no line, so it stays.
  it.each([
    [18, '^18.2.0', ['react-redux@8.1.3']],
    [17, null, ['__root__', 'react-redux@8.1.3']],
  ])('keeps a pnpm parent with an edge on line %i', (line, rootRange, other) => {
    expect(body(node.declaredRanges(tree('pnpm-peer-variant'), 'react', line))).toMatchObject({
      root_range: rootRange,
      parents_unreadable: ['react-redux'],
      parents_other_lines: other,
    })
  })

  it('keeps a pnpm parent whose edge has no registry version', () => {
    expect(body(node.declaredRanges(tree('pnpm-peer-variant'), 'minimist', 0))).toMatchObject({
      parents_unreadable: ['optimist'],
      parents_other_lines: [],
    })
  })
})

describe('declared_ranges of an installed pnpm parent', () => {
  // A pnpm install links each direct dependency into node_modules. The copy
  // takes the real manifest of express 4.18.2 from npm-v3: pnpm-v9 resolves
  // that same release.
  const installed = (): Tree<NodeDetection> => {
    const detected = copyOf('pnpm-v9')
    mkdirSync(join(detected.root, 'node_modules', 'express'), { recursive: true })
    copyFileSync(
      join(FIXTURES_ROOT, 'npm-v3', 'node_modules', 'express', 'package.json'),
      join(detected.root, 'node_modules', 'express', 'package.json'),
    )
    return detected
  }

  it.each([
    [4, { ranges: ['^4.17.20'], parents_read: ['express'], parents_other_lines: [] }],
    [3, { ranges: [], parents_read: [], parents_other_lines: ['express'] }],
  ])('reads the manifest, and files it by its edges, on line %i', (line, lists) => {
    expect(body(node.declaredRanges(installed(), 'lodash', line))).toMatchObject(lists)
  })

  // Two peer variants of one release: the first edge is off the line, the second is on it.
  it('keeps a parent when any of its edges is on the line', () => {
    const detected = installed()
    const path = join(detected.root, 'pnpm-lock.yaml')
    const snapshot = '  express@4.18.2:\n    dependencies:\n      lodash: 4.17.21'
    const variant = '  express@4.18.2(react@18.2.0):\n    dependencies:\n      lodash: 3.10.1\n\n'
    writeFileSync(path, readFileSync(path, 'utf8').replace(snapshot, `${variant}${snapshot}`))
    expect(body(node.declaredRanges(detected, 'lodash', 4))).toMatchObject({
      ranges: ['^4.17.20'],
      parents_read: ['express'],
      parents_other_lines: [],
    })
  })

  it('keeps a parent whose edges have no registry version', () => {
    const detected = installed()
    const path = join(detected.root, 'pnpm-lock.yaml')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '      lodash: 4.17.21',
        '      lodash: https://example.com/lodash.tgz',
      ),
    )
    expect(body(node.declaredRanges(detected, 'lodash', 3))).toMatchObject({
      ranges: ['^4.17.20'],
      parents_read: ['express'],
    })
  })

  // #50: the name ends at the first `@`. The rest of the key is the version
  // of the copy, as node.sh writes it: the two sides give the same text here.
  it('files a pnpm git parent on another line by its name and the rest of its key', () => {
    expect(body(node.declaredRanges(tree('pnpm-git-parent'), 'ms', 3))).toMatchObject({
      parents_other_lines: [
        'debug@git+ssh://git@git.example.com/example/debug.git#da66c86c5fd71ef570f36b5b1edfa4472149f1bc',
      ],
    })
  })

  // Two `file:` copies of one parent, each on lodash 3. node.sh names each
  // copy by the text after the `@` of its key.
  it('files each file: copy of a parent on another line by its version text', () => {
    const detected = copyOf('pnpm-local')
    const path = join(detected.root, 'pnpm-lock.yaml')
    const edges = '    dependencies:\n      lodash: 3.10.1\n'
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '  local-lib@file:vendor/local-lib: {}\n',
        `  local-lib@file:vendor/local-lib:\n${edges}\n  local-lib@file:vendor/other-lib:\n${edges}`,
      ),
    )
    expect(body(node.declaredRanges(detected, 'lodash', 4)).parents_other_lines).toEqual([
      'local-lib@file:vendor/local-lib',
      'local-lib@file:vendor/other-lib',
    ])
  })

  it('keeps the root range when importers records no version for it', () => {
    const { root, detection } = copyOf('pnpm-v9')
    edit(root, 'package.json', (json) => ({ ...json, dependencies: { lodash: '^4' } }))
    expect(body(node.declaredRanges({ root, detection }, 'lodash', 3))).toMatchObject({
      ranges: ['^4'],
      root_range: '^4',
      parents_other_lines: ['express@4.18.2'],
    })
  })
})

describe('declared_ranges refusals', () => {
  it('fails with no package name, before the line', () => {
    expect(node.declaredRanges(tree('npm-v3'), '', -1)).toEqual({
      outcome: 'failed',
      error: 'declared_ranges requires a package name',
    })
  })

  it.each([
    [-1, "declared_ranges: --line must be a major number, got '-1'"],
    [1.5, "declared_ranges: --line must be a major number, got '1.5'"],
    [Number.NaN, "declared_ranges: --line must be a major number, got 'NaN'"],
  ])('fails for line %s', (line, error) => {
    expect(node.declaredRanges(tree('npm-v3'), 'lodash', line)).toEqual({
      outcome: 'failed',
      error,
    })
  })

  // bash answers no parents here (the parity file declares it).
  it('fails for a lockfile that the reader refuses', () => {
    expect(node.declaredRanges(tree('npm-v1'), 'lodash', null)).toEqual({
      outcome: 'failed',
      error: 'package-lock.json has no .packages object (lockfileVersion 1 is unsupported)',
    })
  })

  it('fails for a root block that is not an object', () => {
    const { root, detection } = copyOf('npm-v3')
    writeFileSync(join(root, 'package.json'), '{"dependencies": "x"}')
    expect(node.declaredRanges({ root, detection }, 'lodash', null)).toEqual({
      outcome: 'failed',
      error: 'declared_ranges: dependencies in a manifest is not an object',
    })
  })

  it('fails for a tree with no root manifest', () => {
    const { root, detection } = copyOf('npm-v3')
    rmSync(join(root, 'package.json'))
    const answer = node.declaredRanges({ root, detection }, 'lodash', null)
    expect(answer.outcome === 'failed' && answer.error).toMatch(/^ENOENT: /)
  })

  // The tree has both lockfiles, and `detect` names pnpm. The verb reads the
  // npm lockfile that the given detection names.
  it('reads the lockfile of the detection that it is given, and does not detect again', () => {
    const { root, detection } = copyOf('npm-v3')
    copyFileSync(join(FIXTURES_ROOT, 'pnpm-v9', 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'))
    expect(treeAt(root).detection.pm).toBe('pnpm')
    const answer = node.declaredRanges({ root, detection }, 'lodash', null)
    expect(answer.outcome === 'ok' && [answer.value.pm, answer.value.parents_read]).toEqual([
      'npm',
      ['express', 'test-exclude'],
    ])
  })
})
