// `list_pins` of the node adapter (#221). The seam is the `node` adapter.
// Each expected value is written by hand from the fixture that it names, and
// each refusal from the words of node.sh. Each changed shape was run on a
// scratch copy through node.sh first, as spec/node_list_pins_spec.sh does
// for the same shapes. The parity run holds the agreement on the fixtures.
//
// A tree is detected before the example changes its copy. A caller detects
// once, so the verb reads the file that the detection named at that time.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { Pin, Tree } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'

/** One empty PATH entry, the tree root, which holds no tool. `list_pins` starts no process. */
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

const manifestOf = (root: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>

const writeManifest = (root: string, manifest: unknown): void => {
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Put `value` at `path` in the package.json of the copy. */
const put = (root: string, path: readonly string[], value: unknown): void => {
  const manifest = manifestOf(root)
  let node: Record<string, unknown> = manifest
  for (const key of path.slice(0, -1)) {
    node[key] ??= {}
    node = node[key] as Record<string, unknown>
  }
  node[path.at(-1) as string] = value
  writeManifest(root, manifest)
}

/** The pins of an answer that must be `ok`. */
const pinsOf = (answer: ReturnType<typeof node.listPins>): readonly Pin[] => {
  if (answer.outcome !== 'ok') throw new Error(`list_pins refused: ${answer.error}`)
  return answer.value.pins
}

describe('list_pins on each override location', () => {
  it('reads the resolutions of yarn: a scoped name is bare, and `/` scopes', () => {
    expect(node.listPins(tree('yarn-berry'))).toEqual({
      outcome: 'ok',
      value: {
        pm: 'yarn',
        override_location: 'resolutions',
        override_file: 'package.json',
        block_present: true,
        count: 2,
        bare_count: 1,
        manifest_pnpm_overrides: [],
        pins: [
          {
            key: '@babel/core',
            path: ['@babel/core'],
            package: '@babel/core',
            selector: null,
            parents: [],
            scope: 'bare',
            value: '^7.24.0',
            kind: 'range',
            range: '^7.24.0',
            alias_package: null,
            alias_range: null,
          },
          {
            key: 'express/sha.js',
            path: ['express', 'sha.js'],
            package: 'sha.js',
            selector: null,
            parents: ['express'],
            scope: 'scoped',
            value: '^2.4.11',
            kind: 'range',
            range: '^2.4.11',
            alias_package: null,
            alias_range: null,
          },
        ],
      },
    })
  })

  // A `.` key names the parent itself, so it is a bare pin of that parent.
  it('walks the nested overrides of npm to each leaf', () => {
    const pins = pinsOf(node.listPins(tree('npm-pins')))
    expect(
      pins.map(({ key, path, package: name, parents, scope, kind }) => ({
        key,
        path,
        name,
        parents,
        scope,
        kind,
      })),
    ).toEqual([
      {
        key: 'lodash',
        path: ['lodash'],
        name: 'lodash',
        parents: [],
        scope: 'bare',
        kind: 'reference',
      },
      {
        key: 'test-exclude',
        path: ['test-exclude', 'lodash'],
        name: 'lodash',
        parents: ['test-exclude'],
        scope: 'scoped',
        kind: 'range',
      },
      {
        key: 'glob',
        path: ['glob', 'minimatch', 'brace-expansion'],
        name: 'brace-expansion',
        parents: ['glob', 'minimatch'],
        scope: 'scoped',
        kind: 'range',
      },
      {
        key: 'rimraf',
        path: ['rimraf', '.'],
        name: 'rimraf',
        parents: [],
        scope: 'bare',
        kind: 'range',
      },
      {
        key: 'rimraf',
        path: ['rimraf', 'glob'],
        name: 'glob',
        parents: ['rimraf'],
        scope: 'scoped',
        kind: 'range',
      },
      {
        key: '@babel/core',
        path: ['@babel/core', 'semver'],
        name: 'semver',
        parents: ['@babel/core'],
        scope: 'scoped',
        kind: 'range',
      },
    ])
  })

  it('reads the pnpm.overrides of package.json: `>` scopes, and a selector follows the last @', () => {
    const answer = node.listPins(tree('pnpm-v9'))
    expect(
      answer.outcome === 'ok' && {
        file: answer.value.override_file,
        manifest: answer.value.manifest_pnpm_overrides,
        counts: [answer.value.count, answer.value.bare_count],
        pins: answer.value.pins.map(({ key, package: name, selector, parents }) => ({
          key,
          name,
          selector,
          parents,
        })),
      },
    ).toEqual({
      file: 'package.json',
      manifest: [],
      counts: [3, 2],
      pins: [
        { key: 'lodash', name: 'lodash', selector: null, parents: [] },
        { key: 'express>sha.js', name: 'sha.js', selector: null, parents: ['express'] },
        { key: 'handlebars@4', name: 'handlebars', selector: '4', parents: [] },
      ],
    })
  })

  it('reads the block of pnpm-workspace.yaml, in the order of the file', () => {
    const answer = node.listPins(tree('pnpm11-workspace-overrides'))
    expect(
      answer.outcome === 'ok' && {
        file: answer.value.override_file,
        present: answer.value.block_present,
        keys: answer.value.pins.map(({ key }) => key),
        manifest: answer.value.manifest_pnpm_overrides,
      },
    ).toEqual({
      file: 'pnpm-workspace.yaml',
      present: true,
      keys: ['undici', 'form-data', 'js-yaml', 'ws'],
      manifest: [],
    })
  })

  // pnpm 11 does not read them, so they are not pins. They are named.
  it('names the keys of pnpm.overrides in package.json, sorted, and reads them as no pins', () => {
    const { root, detection } = copyOf('pnpm11-workspace-overrides')
    put(root, ['pnpm', 'overrides'], { 'left-pad': '>=1.3.0', 'b-pkg': '1' })
    const answer = node.listPins({ root, detection })
    expect(
      answer.outcome === 'ok' && {
        manifest: answer.value.manifest_pnpm_overrides,
        keys: answer.value.pins.map(({ key }) => key),
      },
    ).toEqual({ manifest: ['b-pkg', 'left-pad'], keys: ['undici', 'form-data', 'js-yaml', 'ws'] })
  })

  // The detection names pnpm-workspace.yaml (pnpm 11), and the file has no block.
  it('reads no block, and drops pnpm.overrides of package.json, when the workspace file has none', () => {
    const { root } = copyOf('pnpm-cross-line')
    put(root, ['packageManager'], 'pnpm@11.9.0')
    put(root, ['pnpm', 'overrides'], { 'left-pad': '>=1.3.0' })
    put(root, ['pnpm', 'other'], true)
    const answer = node.listPins(treeAt(root))
    expect(
      answer.outcome === 'ok' && {
        file: answer.value.override_file,
        present: answer.value.block_present,
        count: answer.value.count,
        manifest: answer.value.manifest_pnpm_overrides,
      },
    ).toEqual({ file: 'pnpm-workspace.yaml', present: false, count: 0, manifest: ['left-pad'] })
  })

  // The detection names pnpm-workspace.yaml. `detect` again would name package.json.
  it('reads the file that the detection names, and does not detect again', () => {
    const { root, detection } = copyOf('pnpm-v9')
    const answer = node.listPins({
      root,
      detection: { ...detection, override_file: 'pnpm-workspace.yaml' } as NodeDetection,
    })
    expect(answer.outcome === 'ok' && [answer.value.override_file, answer.value.count]).toEqual([
      'pnpm-workspace.yaml',
      0,
    ])
  })
})

describe('list_pins with no pins', () => {
  it.each([
    ['yarn-berry', 'no-overrides'],
    ['npm', 'empty-npm'],
    ['pnpm', 'pnpm-no-overrides'],
  ])('reports no block in a %s manifest with none', (_pm, fixture) => {
    const answer = node.listPins(tree(fixture))
    expect(answer.outcome === 'ok' && [answer.value.block_present, answer.value.count]).toEqual([
      false,
      0,
    ])
  })

  it.each([
    ['npm-v3', ['overrides'], {}, true],
    ['pnpm-v9', ['pnpm', 'overrides'], {}, true],
    ['yarn-berry', ['resolutions'], {}, true],
    ['npm-v3', ['overrides'], null, false],
    ['yarn-berry', ['resolutions'], false, false],
  ])('reads %s with %j = %j as a block that is present: %s', (fixture, path, value, present) => {
    const { root, detection } = copyOf(fixture)
    put(root, path, value)
    const answer = node.listPins({ root, detection })
    expect(answer.outcome === 'ok' && [answer.value.block_present, answer.value.count]).toEqual([
      present,
      0,
    ])
  })

  it('reads a top level of null as no block', () => {
    const { root, detection } = copyOf('npm-v3')
    writeFileSync(join(root, 'package.json'), 'null\n')
    const answer = node.listPins({ root, detection })
    expect(answer).toMatchObject({ outcome: 'ok', value: { block_present: false } })
  })

  it('reads a manifest with a byte order mark', () => {
    const { root, detection } = copyOf('npm-v3')
    writeFileSync(
      join(root, 'package.json'),
      `\uFEFF${readFileSync(join(root, 'package.json'), 'utf8')}`,
    )
    const answer = node.listPins({ root, detection })
    expect(answer.outcome === 'ok' && answer.value.count).toBe(2)
  })
})

describe('list_pins values', () => {
  it.each([
    ['a number', 1, { kind: 'unparseable', range: null, alias_package: null, alias_range: null }],
    ['a list', [1], { kind: 'unparseable', range: null, alias_package: null, alias_range: null }],
    [
      'a reference',
      '$lodash',
      { kind: 'reference', range: null, alias_package: null, alias_range: null },
    ],
    [
      'an alias',
      'npm:@s/y@1.2.3',
      { kind: 'alias', range: null, alias_package: '@s/y', alias_range: '1.2.3' },
    ],
    [
      'an alias with no version',
      'npm:@s/y',
      { kind: 'alias', range: null, alias_package: '@s/y', alias_range: null },
    ],
    [
      'an alias with nothing',
      'npm:',
      { kind: 'alias', range: null, alias_package: '', alias_range: null },
    ],
    [
      'a protocol',
      'file:../x',
      { kind: 'protocol', range: null, alias_package: null, alias_range: null },
    ],
    [
      'a range',
      '>=1 <2',
      { kind: 'range', range: '>=1 <2', alias_package: null, alias_range: null },
    ],
    [
      'a dist-tag',
      'latest',
      { kind: 'unparseable', range: null, alias_package: null, alias_range: null },
    ],
  ])('classifies %s', (_shape, value, facts) => {
    const { root, detection } = copyOf('yarn-berry')
    put(root, ['resolutions'], { x: value })
    expect(pinsOf(node.listPins({ root, detection }))).toMatchObject([{ value, ...facts }])
  })

  it.each([
    ['pnpm-v9', ['pnpm', 'overrides'], '>foo', { package: 'foo', parents: [], path: ['foo'] }],
    [
      'pnpm-v9',
      ['pnpm', 'overrides'],
      'a>>b',
      { package: 'b', parents: ['a', ''], path: ['a', '', 'b'] },
    ],
    [
      'pnpm-v9',
      ['pnpm', 'overrides'],
      '@s/p@1>q@2',
      { package: 'q', selector: '2', parents: ['@s/p@1'] },
    ],
    ['yarn-berry', ['resolutions'], '@scope', { package: '@scope', parents: [], scope: 'bare' }],
    ['yarn-berry', ['resolutions'], '', { package: '', parents: [], scope: 'bare' }],
    ['yarn-berry', ['resolutions'], 'a/b/c', { package: 'b/c', parents: ['a'] }],
    ['yarn-berry', ['resolutions'], '@s/a/b/c', { package: 'b/c', parents: ['@s/a'] }],
  ])('reads the %s key %j', (fixture, path, key, fields) => {
    const { root, detection } = copyOf(fixture)
    put(root, path, { [key]: '^1' })
    const [pin] = pinsOf(node.listPins({ root, detection }))
    expect(pin).toMatchObject({ key, ...fields })
  })

  // Only a `.` under a parent names that parent. A `.` at the top is a key.
  it('reads a `.` key at the top of npm overrides as a bare pin of that key', () => {
    const { root, detection } = copyOf('npm-v3')
    put(root, ['overrides'], { '.': '^1', a: { '.': '^2' } })
    expect(pinsOf(node.listPins({ root, detection }))).toMatchObject([
      { key: '.', path: ['.'], package: '.', parents: [], scope: 'bare' },
      { key: 'a', path: ['a', '.'], package: 'a', parents: [], scope: 'bare' },
    ])
  })

  it('reads an empty object in npm overrides as no pin', () => {
    const { root, detection } = copyOf('npm-v3')
    put(root, ['overrides'], { a: {}, b: { '.': '^1' } })
    expect(pinsOf(node.listPins({ root, detection }))).toMatchObject([
      { key: 'b', path: ['b', '.'], package: 'b', parents: [], scope: 'bare' },
    ])
  })
})

describe('list_pins refusals', () => {
  const notAnObject = (location: string, type: string) =>
    `list_pins: '${location}' in package.json is a ${type}, not an object of override entries. Refusing to report a manifest this script cannot read as a repository with no pins.`
  const container = (location: string) =>
    `list_pins: the container holding '${location}' in package.json is not an object, so the override block cannot be read. Refusing to report a manifest this script cannot read as a repository with no pins.`

  it.each([
    ['npm-v3', ['overrides'], 'oops', notAnObject('overrides', 'string')],
    ['pnpm-v9', ['pnpm', 'overrides'], ['oops'], notAnObject('pnpm.overrides', 'array')],
    ['yarn-berry', ['resolutions'], 42, notAnObject('resolutions', 'number')],
    ['yarn-berry', ['resolutions'], true, notAnObject('resolutions', 'boolean')],
    ['pnpm-v9', ['pnpm'], 'oops', container('pnpm.overrides')],
  ])('refuses %s with %j = %j', (fixture, path, value, error) => {
    const { root, detection } = copyOf(fixture)
    put(root, path, value)
    expect(node.listPins({ root, detection })).toEqual({ outcome: 'failed', error })
  })

  it.each([
    ['a top level that is a list', '[1]\n', container('overrides')],
    ['no document', ' \n\t\r\n', notAnObject('overrides', '')],
    ['text that is not JSON', '{\n', 'list_pins: cannot read package.json'],
  ])('refuses a manifest of %s', (_shape, text, error) => {
    const { root, detection } = copyOf('npm-v3')
    writeFileSync(join(root, 'package.json'), text)
    expect(node.listPins({ root, detection })).toEqual({ outcome: 'failed', error })
  })

  it('refuses a tree with no manifest', () => {
    const { root, detection } = copyOf('yarn-berry')
    rmSync(join(root, 'package.json'))
    expect(node.listPins({ root, detection })).toEqual({
      outcome: 'failed',
      error: 'list_pins: cannot read package.json',
    })
  })
})

describe('list_pins through pnpm-workspace.yaml', () => {
  const MERGE =
    "workspace_manifest_view: cannot merge the pnpm-workspace.yaml overrides into package.json's view (is package.json valid JSON?)"
  const refusal = (shape: string, line: number) =>
    `pnpm-workspace.yaml overrides: cannot safely read the block: it contains ${shape} (pnpm-workspace.yaml line ${line}). Refusing to route overrides through a block this script cannot round-trip; simplify it to flat 'key: value' entries or edit it by hand.`

  const withWorkspace = (text: string): Tree<NodeDetection> => {
    const detected = copyOf('pnpm11-workspace-overrides')
    writeFileSync(join(detected.root, 'pnpm-workspace.yaml'), text)
    return detected
  }

  it.each([
    [
      'a quoted key, single',
      "'overrides':\n  a: '1'\n",
      'a quoted top-level overrides: key (write it unquoted so every reader of this file agrees on where the block is)',
      1,
    ],
    [
      'a quoted key, double',
      '"overrides":\n  a: "1"\n',
      'a quoted top-level overrides: key (write it unquoted so every reader of this file agrees on where the block is)',
      1,
    ],
    [
      'two blocks',
      'overrides:\n  ws: 1\noverrides:\n  undici: 2\n',
      'a duplicate top-level overrides: key',
      3,
    ],
    [
      'two blocks apart',
      'overrides:\n  ws: 1\npackages:\n  - x\noverrides:\n  undici: 2\n',
      'a duplicate top-level overrides: key',
      5,
    ],
    [
      'a flow block',
      'overrides: {a: 1}\n',
      'an overrides: key carrying an inline (flow-style) value',
      1,
    ],
    [
      'a tab',
      'overrides:\n\ta: 1\n',
      'a tab character on a line of the overrides block (this reader handles space-indented YAML only)',
      2,
    ],
    [
      'a tab in a value',
      'overrides:\n  a: 1\t\n',
      'a tab character on a line of the overrides block (this reader handles space-indented YAML only)',
      2,
    ],
    [
      'four spaces',
      'overrides:\n    a: 1\n',
      'a line of the overrides block not indented with exactly two spaces (the form pnpm emits and the only one this reader accepts)',
      2,
    ],
    [
      'one space',
      'overrides:\n a: 1\n',
      'a line of the overrides block not indented with exactly two spaces (the form pnpm emits and the only one this reader accepts)',
      2,
    ],
    ['no colon', 'overrides:\n  a\n', 'a line inside the block that is not a key: value entry', 2],
    [
      'a quoted key that never closes',
      "overrides:\n  'a: 1\n",
      'an entry whose quoted key never closes',
      2,
    ],
    [
      'a quote with no key after it',
      "overrides:\n  ': 1\n",
      'an entry whose quoted key never closes',
      2,
    ],
    [
      'a backslash in a key',
      'overrides:\n  "a\\\\b": 1\n',
      'a double-quoted scalar with backslash escapes',
      2,
    ],
    [
      'a backslash in a value',
      'overrides:\n  a: "x\\\\y"\n',
      'a double-quoted scalar with backslash escapes',
      2,
    ],
    [
      'a backslash in a key, and a comment',
      'overrides:\n  "a\\\\b": 1 # c\n',
      'an entry carrying an inline comment',
      2,
    ],
    ['an inline comment', 'overrides:\n  a: 1 # c\n', 'an entry carrying an inline comment', 2],
    ['a comment for a value', 'overrides:\n  a: #c\n', 'an entry carrying an inline comment', 2],
    [
      'no value',
      'overrides:\n  a:\n',
      'an entry with no scalar value (a nested map or sequence)',
      2,
    ],
    [
      'an empty quoted value',
      "overrides:\n  a: ''\n",
      'an entry with no scalar value (a nested map or sequence)',
      2,
    ],
    [
      'a nested map',
      'overrides:\n  a:\n    b: 1\n',
      'an entry with no scalar value (a nested map or sequence)',
      2,
    ],
    ['an anchor', 'overrides:\n  a: &x 1\n', 'an anchor, alias, tag or flow-style value', 2],
    ['an alias', 'overrides:\n  a: *x\n', 'an anchor, alias, tag or flow-style value', 2],
    ['a flow map', 'overrides:\n  a: {b: 1}\n', 'an anchor, alias, tag or flow-style value', 2],
    ['a flow list', 'overrides:\n  a: [1]\n', 'an anchor, alias, tag or flow-style value', 2],
    ['a tag', 'overrides:\n  a: !!str 1\n', 'an anchor, alias, tag or flow-style value', 2],
    ['a block scalar', 'overrides:\n  a: |\n', 'a block-scalar value', 2],
    ['a folded block scalar', 'overrides:\n  a: >-\n', 'a block-scalar value', 2],
    ['a kept block scalar', 'overrides:\n  a: |+\n', 'a block-scalar value', 2],
    ['an empty key', 'overrides:\n  : 1\n', 'an entry with an empty key', 2],
    ['an empty quoted key', "overrides:\n  '': 1\n", 'an entry with an empty key', 2],
    [
      'a key twice',
      'overrides:\n  a: 1\n  a: 2\n',
      "duplicate keys in the block ('a'), which YAML readers resolve inconsistently",
      3,
    ],
    [
      'a key twice, once quoted',
      "overrides:\n  a: 1\n  'a': 2\n",
      "duplicate keys in the block ('a'), which YAML readers resolve inconsistently",
      3,
    ],
  ])('refuses %s', (_shape, text, shape, line) => {
    expect(node.listPins(withWorkspace(text))).toEqual({
      outcome: 'failed',
      error: refusal(shape, line),
    })
  })

  it.each([
    ['a comment after the block key', 'overrides: # c\n  a: 1\n', [['a', '1']]],
    [
      'blank and comment lines',
      'overrides:\n\n  # c\n  a: 1\n   \n  b: 2\n',
      [
        ['a', '1'],
        ['b', '2'],
      ],
    ],
    [
      'quoted keys and values',
      "overrides:\n  \"a>b\": \"^1\"\n  'it''s': 'a''b'\n",
      [
        ['a>b', '^1'],
        ["it's", "a'b"],
      ],
    ],
    ['a # with no space before it', 'overrides:\n  a: 1#c\n', [['a', '1#c']]],
    ['CRLF line ends', 'overrides:\r\n  a: 1\r\n', [['a', '1']]],
    ['no last newline', 'overrides:\n  a: 1', [['a', '1']]],
    ['a space inside quotes', "overrides:\n  a: '1 '  \n", [['a', '1 ']]],
    ['a space in a plain key', 'overrides:\n  a b : 1\n', [['a b ', '1']]],
    ['a block that ends', 'overrides:\n  a: 1\npackages:\n  - x\n', [['a', '1']]],
  ])('reads %s', (_shape, text, entries) => {
    const pins = pinsOf(node.listPins(withWorkspace(text)))
    expect(pins.map(({ key, value }) => [key, value])).toEqual(entries)
  })

  // The detection check matches a quote on one side only. The reader finds no
  // block there, so the view has an empty block that is present.
  it.each([["'overrides:\n  a: 1\n"], ["overrides':\n  a: 1\n"]])(
    'reads a key with one quote, %j, as an empty block',
    (text) => {
      const answer = node.listPins(withWorkspace(text))
      expect(answer.outcome === 'ok' && [answer.value.block_present, answer.value.count]).toEqual([
        true,
        0,
      ])
    },
  )

  it('reads a workspace file with no block, or no file, as no block', () => {
    for (const text of ['packages:\n  - x\n', null]) {
      const detected = copyOf('pnpm11-workspace-overrides')
      const path = join(detected.root, 'pnpm-workspace.yaml')
      if (text === null) {
        rmSync(path)
        mkdirSync(path)
      } else {
        writeFileSync(path, text)
      }
      const answer = node.listPins(detected)
      expect(answer).toMatchObject({ outcome: 'ok', value: { block_present: false } })
    }
  })

  it('reads an empty block as a block that is present', () => {
    const answer = node.listPins(withWorkspace('overrides:\npackages:\n  - x\n'))
    expect(answer.outcome === 'ok' && [answer.value.block_present, answer.value.count]).toEqual([
      true,
      0,
    ])
  })

  it.skipIf(process.getuid?.() === 0)('refuses a workspace file that it cannot read', () => {
    const detected = withWorkspace('overrides:\n  a: 1\n')
    chmodSync(join(detected.root, 'pnpm-workspace.yaml'), 0)
    expect(node.listPins(detected)).toEqual({
      outcome: 'failed',
      error: `pnpm-workspace.yaml overrides: cannot read the file at all (not a shape problem; check that it exists and is readable from ${detected.root}).`,
    })
  })

  it.each([
    ['a top level that is a list', '[1]\n'],
    ['text that is not JSON', '{'],
    ['a pnpm field that is text', '{"pnpm": "x"}\n'],
  ])('refuses a manifest of %s, with the words of the view', (_shape, text) => {
    const detected = copyOf('pnpm11-workspace-overrides')
    writeFileSync(join(detected.root, 'package.json'), text)
    expect(node.listPins(detected)).toEqual({ outcome: 'failed', error: MERGE })
  })

  it('refuses a tree with no manifest, with the words of the view', () => {
    const detected = copyOf('pnpm11-workspace-overrides')
    rmSync(join(detected.root, 'package.json'))
    expect(node.listPins(detected)).toEqual({ outcome: 'failed', error: MERGE })
  })

  it('refuses a workspace file before the manifest', () => {
    const detected = withWorkspace('overrides:\n  a\n')
    writeFileSync(join(detected.root, 'package.json'), '{')
    expect(node.listPins(detected)).toEqual({
      outcome: 'failed',
      error: refusal('a line inside the block that is not a key: value entry', 2),
    })
  })

  it('reads a manifest of null as no pnpm field', () => {
    const detected = copyOf('pnpm11-workspace-overrides')
    writeFileSync(join(detected.root, 'package.json'), 'null\n')
    const answer = node.listPins(detected)
    expect(
      answer.outcome === 'ok' && [answer.value.count, answer.value.manifest_pnpm_overrides],
    ).toEqual([4, []])
  })

  it('refuses a manifest of no document', () => {
    const detected = copyOf('pnpm11-workspace-overrides')
    writeFileSync(join(detected.root, 'package.json'), '')
    expect(node.listPins(detected)).toEqual({
      outcome: 'failed',
      error: notAnObjectOfNoType,
    })
  })

  // `(.pnpm //= {})` makes the view, but the keys of package.json cannot be read.
  it('refuses a pnpm field of false, where the keys of package.json are read', () => {
    const detected = copyOf('pnpm11-workspace-overrides')
    put(detected.root, ['pnpm'], false)
    expect(node.listPins(detected)).toEqual({
      outcome: 'failed',
      error: 'list_pins: cannot read package.json',
    })
  })

  it('reads pnpm.overrides of false in package.json as no keys', () => {
    const detected = copyOf('pnpm11-workspace-overrides')
    put(detected.root, ['pnpm', 'overrides'], false)
    const answer = node.listPins(detected)
    expect(
      answer.outcome === 'ok' && [answer.value.count, answer.value.manifest_pnpm_overrides],
    ).toEqual([4, []])
  })

  // The detection names pnpm-workspace.yaml (pnpm 11), and the file has no block.
  it('refuses a pnpm field that is text when the workspace file has no block', () => {
    const { root } = copyOf('pnpm-cross-line')
    put(root, ['packageManager'], 'pnpm@11.9.0')
    put(root, ['pnpm'], 'x')
    expect(node.listPins(treeAt(root))).toEqual({
      outcome: 'failed',
      error:
        "list_pins: the container holding 'pnpm.overrides' in package.json is not an object, so the override block cannot be read. Refusing to report a manifest this script cannot read as a repository with no pins.",
    })
  })

  // jq answers the indexes of a list here. This port refuses it: a declared divergence.
  it.each([
    ['text', 'x'],
    ['a list', ['a']],
  ])('refuses pnpm.overrides of package.json that is %s', (_shape, value) => {
    const detected = copyOf('pnpm11-workspace-overrides')
    put(detected.root, ['pnpm', 'overrides'], value)
    expect(node.listPins(detected)).toEqual({
      outcome: 'failed',
      error: 'list_pins: cannot read package.json',
    })
  })
})

const notAnObjectOfNoType =
  "list_pins: 'pnpm.overrides' in package.json is a , not an object of override entries. Refusing to report a manifest this script cannot read as a repository with no pins."
