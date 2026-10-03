// The decisions of `fix-group apply`, as pure functions, with no git
// repository (#232). Each expected value is written by hand from the jq
// filter or the shell test in `scripts/common/fix-group.sh` that the
// function ports, and the rows that read a path or a version list were
// checked against that jq. `fix-group-apply.test.ts` runs the same rules
// through the command.
import { describe, expect, it } from 'vitest'

import {
  bareName,
  budgetSpent,
  emptyDiff,
  FIX_INSTALL_BUDGET,
  invalidationOf,
  LOCKFILE_REFRESH,
  labelsOf,
  lineVersions,
  movesOf,
  nextRung,
  parentDerivation,
  parentOf,
  rangeOf,
  retargetOf,
  staleLockfile,
  uncheckedAlerts,
  widestShape,
} from '#gh-security/subcommands/fix-group-ladder.ts'

describe('the range of the fix', () => {
  it.each([
    ['4.17.21', '>=4.17.21 <5'],
    ['3.1.2', '>=3.1.2 <4'],
    ['0.5.3', '>=0.5.3 <1'],
    ['v4.1.0', '>=v4.1.0 <5'],
    // The bash puts the whole text after `>=`, prefix and all.
    ['=10.0.0', '>==10.0.0 <11'],
    ['4', '>=4 <5'],
    ['4-beta', '>=4-beta <5'],
  ])('reads %s as %s', (fixed, range) => {
    expect(rangeOf(fixed)).toBe(range)
  })

  it.each(['', 'x4.1.0', 'v.1', '.4'])('reads no major in %j', (fixed) => {
    expect(rangeOf(fixed)).toBeNull()
  })
})

describe('the alerts with no range', () => {
  it('names each alert whose range is absent, null, empty or not text', () => {
    expect(
      uncheckedAlerts([
        { number: 1, vulnerable_range: '< 4.17.21' },
        { number: 2, vulnerable_range: null },
        { number: 3 },
        { number: 4, vulnerable_range: '' },
        { number: 5, vulnerable_range: ['< 1'] },
      ]),
    ).toEqual([2, 3, 4, 5])
  })

  it('names an alert with no number <unnumbered>, as jq `//` reads it', () => {
    expect(
      uncheckedAlerts([{ vulnerable_range: null }, { number: null }, { number: false }]),
    ).toEqual(['<unnumbered>', '<unnumbered>', '<unnumbered>'])
  })

  it('counts an alert that is not an object as one with no range', () => {
    expect(uncheckedAlerts(['< 1', null, 7])).toEqual([
      '<unnumbered>',
      '<unnumbered>',
      '<unnumbered>',
    ])
  })

  it('names nothing when each alert has a range', () => {
    expect(uncheckedAlerts([{ number: 1, vulnerable_range: '< 2' }])).toEqual([])
  })
})

describe('a written npm: value for another package (#49)', () => {
  const entry = (value: unknown, extra: Record<string, unknown> = {}) => ({
    parent: 'express',
    path: ['overrides', 'express', 'lodash'],
    value,
    ...extra,
  })

  it('finds the first entry that names another package', () => {
    const first = entry('npm:underscore@>=4.17.21 <5')
    expect(retargetOf([entry('>=4.17.21 <5'), first, entry('npm:other@1')], 'lodash')).toBe(first)
  })

  it.each([
    ['the same package', 'npm:lodash@^4.17.21'],
    ['the same package with no version', 'npm:lodash'],
    ['a range', '>=4.17.21 <5'],
  ])('passes %s', (_name, value) => {
    expect(retargetOf([entry(value)], 'lodash')).toBeNull()
  })

  it('reads a scoped name up to the last @', () => {
    expect(retargetOf([entry('npm:@scope/pkg@^1')], '@scope/pkg')).toBeNull()
    expect(retargetOf([entry('npm:@scope/pkg')], '@scope/pkg')).toBeNull()
    expect(retargetOf([entry('npm:@scope/other@^1')], '@scope/pkg')).not.toBeNull()
  })

  // A preserved entry quotes a value that was there before (#147).
  it('skips a preserved entry, and checks one whose preserved is not true', () => {
    expect(retargetOf([entry('npm:underscore@^1', { preserved: true })], 'lodash')).toBeNull()
    expect(retargetOf([entry('npm:underscore@^1', { preserved: 'true' })], 'lodash')).not.toBeNull()
  })

  it('skips an entry that is not an object, and a value that is not text', () => {
    expect(retargetOf(['npm:underscore@1', null, entry(5)], 'lodash')).toBeNull()
  })
})

describe('the parent that a violation path names', () => {
  it.each([
    ['node_modules/koa/node_modules/lodash', 'koa'],
    ['node_modules/@nestjs/core/node_modules/lodash', '@nestjs/core'],
    ['node_modules/a/node_modules/@types/node/node_modules/lodash', '@types/node'],
    ['node_modules/a/node_modules/koa/node_modules/lodash', 'koa'],
    ['node_modules/koa/node_modules/@scope/pkg', 'koa'],
    ['packages/app/node_modules/lodash', 'app'],
    // A scoped parent at the start of a path that is not an npm install path.
    ['@a/b/node_modules/lodash', '@a/b'],
  ])('reads %s as %s', (path, parent) => {
    expect(parentOf(path)).toBe(parent)
  })

  it.each(['node_modules/lodash', 'lodash@4.17.20', 'lodash@npm:4.17.20'])(
    'reads no parent in %s',
    (path) => {
      expect(parentOf(path)).toBeNull()
    },
  )

  it.each([
    ['koa', 'koa'],
    ['koa@1.4.0', 'koa'],
    ['@nestjs/core', '@nestjs/core'],
    ['@nestjs/core@10.4.1', '@nestjs/core'],
  ])('takes the name of %s as %s', (key, name) => {
    expect(bareName(key)).toBe(name)
  })
})

describe('step 1: the parents of the copies that violate', () => {
  const REASON =
    "no violating copy's path names its enclosing parent: pnpm reports <name>@<version> and " +
    'Yarn Berry the resolution locator <name>@npm:<version>, both of which name the copy ' +
    'itself. No parent can be derived from this report, and none was invented.'

  it('derives the parents of npm paths, sorted and once each', () => {
    expect(
      parentDerivation(
        [
          'node_modules/koa/node_modules/lodash',
          'node_modules/@nestjs/core/node_modules/lodash',
          'node_modules/koa/node_modules/lodash',
          'node_modules/lodash',
        ],
        [],
        [],
        'lodash',
      ),
    ).toEqual({
      parents: ['@nestjs/core', 'koa'],
      paths_naming_a_parent: 4,
      paths_naming_only_the_copy: 0,
      opaque_paths: [],
      possible: true,
      reason: null,
    })
  })

  // A sibling agent owns another line (#83).
  it('never derives a parent on another major line, by name', () => {
    const derived = parentDerivation(
      ['node_modules/koa/node_modules/lodash', 'node_modules/express/node_modules/lodash'],
      ['koa@1.4.0', '__root__'],
      [],
      'lodash',
    )
    expect(derived.parents).toEqual(['express'])
  })

  it('never derives a parent that already has an entry', () => {
    const derived = parentDerivation(
      ['node_modules/@nestjs/core/node_modules/lodash'],
      [],
      ['@nestjs/core'],
      'lodash',
    )
    expect(derived.parents).toEqual([])
  })

  it('never derives the package itself, or the node_modules segment', () => {
    const derived = parentDerivation(
      ['node_modules/lodash/node_modules/lodash', 'node_modules/node_modules/node_modules/lodash'],
      [],
      [],
      'lodash',
    )
    expect(derived.parents).toEqual([])
  })

  it.each([
    [
      'pnpm',
      ['lodash@4.17.20', '@babel/traverse@7.23.0', 'lodash@4.17.20'],
      ['@babel/traverse@7.23.0', 'lodash@4.17.20'],
    ],
    [
      'Yarn Berry',
      ['lodash@npm:4.17.20', '@babel/traverse@npm:7.23.0', 'lodash@npm:4.17.20'],
      ['@babel/traverse@npm:7.23.0', 'lodash@npm:4.17.20'],
    ],
  ])('says that step 1 cannot run on %s paths, which name the copy', (_pm, paths, unique) => {
    expect(parentDerivation(paths, [], [], 'lodash')).toEqual({
      parents: [],
      paths_naming_a_parent: 0,
      paths_naming_only_the_copy: 3,
      opaque_paths: unique,
      possible: false,
      reason: REASON,
    })
  })

  it('counts each kind of path when the two are mixed', () => {
    expect(
      parentDerivation(
        ['node_modules/koa/node_modules/lodash', 'lodash@4.17.20'],
        [],
        [],
        'lodash',
      ),
    ).toMatchObject({ paths_naming_a_parent: 1, paths_naming_only_the_copy: 1, possible: true })
  })

  // jq `test("(^|/)node_modules/")`: the segment must start the path or follow a slash.
  it('reads a path where node_modules is part of a longer name as one that names the copy', () => {
    expect(parentDerivation(['foonode_modules/lodash'], [], [], 'lodash')).toMatchObject({
      paths_naming_a_parent: 0,
      paths_naming_only_the_copy: 1,
      possible: false,
    })
  })
})

describe('the ladder', () => {
  const STALE = { performed: true, keys: [] }
  const CLEARED = { performed: true, keys: ['node_modules/lodash'] }

  it('runs step 1 first when it found parents', () => {
    expect(nextRung(0, ['koa'], CLEARED)).toEqual({ kind: 'add_parents', parents: ['koa'] })
  })

  it('goes to step 2 when step 1 found no parent', () => {
    expect(nextRung(0, [], STALE)).toEqual({ kind: 'tighten_bare' })
  })

  it('goes to step 2 after step 1, and never runs step 1 again', () => {
    expect(nextRung(1, ['koa'], STALE)).toEqual({ kind: 'tighten_bare' })
  })

  it('stops for a stale lockfile after step 2', () => {
    expect(nextRung(2, [], STALE)).toEqual({ kind: 'stale_lockfile' })
  })

  it('gives a judgment after step 2 when the lockfile is not the cause', () => {
    expect(nextRung(2, ['koa'], CLEARED)).toEqual({ kind: 'judgment' })
  })
})

describe('the stale-lockfile stop', () => {
  it.each([
    ['a pass that did not run, with a reason', { performed: false, reason: 'npm only' }, true],
    ['a pass that did not run, with a null reason', { performed: false, reason: null }, true],
    ['a pass that removed no entry', { performed: true, keys: [] }, true],
    ['a pass that removed no entry, with keys null', { performed: true, keys: null }, true],
    ['a pass that removed no entry, with no keys', { performed: true }, true],
    ['a pass that removed an entry', { performed: true, keys: ['node_modules/lodash'] }, false],
    ['a pass that did not run, with no reason', { performed: false, keys: [] }, false],
    ['a performed that is not a boolean', { performed: 'true', keys: [] }, false],
    ['keys that are not a list', { performed: true, keys: 'none' }, false],
    ['an empty object', {}, false],
    ['a value that is not an object', 'stale', false],
  ])('reads %s as %s', (_name, invalidated, stop) => {
    expect(staleLockfile(invalidated)).toBe(stop)
  })

  it('gives {} for an absent, null or false lockfile_invalidated, as jq `//` does', () => {
    expect(invalidationOf({})).toEqual({})
    expect(invalidationOf({ lockfile_invalidated: null })).toEqual({})
    expect(invalidationOf({ lockfile_invalidated: false })).toEqual({})
    expect(invalidationOf({ lockfile_invalidated: { performed: true, keys: [] } })).toEqual({
      performed: true,
      keys: [],
    })
  })
})

describe('the install budget', () => {
  it('is four fix installs', () => {
    expect(FIX_INSTALL_BUDGET).toBe(4)
  })

  // The edge: the fourth install is the last one, and a fifth is never run.
  it.each([
    [3, false],
    [4, true],
    [5, true],
  ])('with %i installs spent, is spent: %s', (installs, spent) => {
    expect(budgetSpent(installs)).toBe(spent)
  })
})

describe('the moves on other lines', () => {
  const fatal = { major: 1, class: 'fatal' }
  const benign = { major: 2, class: 'benign_dedup' }

  it('selects each class', () => {
    expect(movesOf([fatal, benign, { major: 3 }], 'fatal')).toEqual([fatal])
    expect(movesOf([fatal, benign, { major: 3 }], 'benign_dedup')).toEqual([benign])
  })

  // jq stops on such an entry, and the bash then fails the phase.
  it('reads an entry that is not an object as fatal, never as benign', () => {
    expect(movesOf(['x', null, benign], 'fatal')).toEqual(['x', null])
    expect(movesOf(['x', null, benign], 'benign_dedup')).toEqual([benign])
  })

  it('reads null, as with no baseline, and an absent value as no move', () => {
    expect(movesOf(null, 'fatal')).toEqual([])
    expect(movesOf(undefined, 'fatal')).toEqual([])
  })

  // jq `.other_line_moves[]?` walks the values of an object, so the bash
  // stopped on an object that holds a fatal move.
  it('reads a value that is neither a list nor null as one fatal move', () => {
    const moves = { x: fatal }
    expect(movesOf(moves, 'fatal')).toEqual([moves])
    expect(movesOf('x', 'fatal')).toEqual(['x'])
    expect(movesOf(moves, 'benign_dedup')).toEqual([])
  })
})

describe('the widest shape written', () => {
  const at = (path: unknown, parent: unknown = null, extra: Record<string, unknown> = {}) => ({
    parent,
    path,
    value: '>=4.17.21 <5',
    ...extra,
  })

  it.each([
    ['a top-level overrides key', [at(['overrides', 'lodash'])], 'bare'],
    ['a top-level resolutions key', [at(['resolutions', 'lodash'])], 'bare'],
    ['a top-level pnpm.overrides key', [at(['pnpm', 'overrides', 'lodash'])], 'bare'],
    ['a dependencies retarget', [at(['dependencies', 'lodash'])], 'direct'],
    ['a devDependencies retarget', [at(['devDependencies', 'lodash'])], 'direct'],
    ['a nested key', [at(['overrides', 'express', 'lodash'], 'express')], 'scoped'],
    ['a nested key with no parent', [at(['overrides', 'express', 'lodash'])], 'scoped'],
    ['a top-level key with a parent', [at(['overrides', 'lodash'], 'express')], 'scoped'],
    ['a pnpm key outside overrides', [at(['pnpm', 'other', 'lodash'])], 'scoped'],
    ['a pnpm key of another depth', [at(['pnpm', 'overrides'])], 'scoped'],
    ['an entry with no path', [{ value: 'x' }], 'scoped'],
    // jq `.parent == null` is false for the empty text and for false.
    ['a top-level key whose parent is empty text', [at(['overrides', 'lodash'], '')], 'scoped'],
    ['a top-level key whose parent is false', [at(['overrides', 'lodash'], false)], 'scoped'],
    ['nothing', [], 'none'],
    [
      'a bare key beside a nested key',
      [at(['overrides', 'express', 'lodash'], 'express'), at(['overrides', 'lodash'])],
      'bare',
    ],
    [
      'a retarget beside a nested key',
      [at(['overrides', 'express', 'lodash'], 'express'), at(['dependencies', 'lodash'])],
      'direct',
    ],
  ])('reads %s as %s', (_name, written, shape) => {
    expect(widestShape(written)).toBe(shape)
  })

  it('does not count a preserved entry', () => {
    expect(widestShape([at(['overrides', 'lodash'], null, { preserved: true })])).toBe('none')
    expect(widestShape([at(['overrides', 'lodash'], null, { preserved: 'true' })])).toBe('bare')
  })

  it.each([
    ['an entry that is not an object', ['x']],
    ['a path that is text', [at('overrides.lodash')]],
    ['a path that is an object', [at({ 0: 'overrides' })]],
    // jq `.path[0]` stops on false.
    ['a path that is false', [at(false)]],
  ])('cannot classify %s', (_name, written) => {
    expect(widestShape(written)).toBeNull()
  })
})

describe('the labels of a shape', () => {
  const TARGETS = [{ type: 'unscoped_override', key: 'lodash', targets_this_package: true }]
  const OTHER = [{ type: 'unscoped_override', key: 'sharp', targets_this_package: false }]

  it.each([
    ['bare', false, [], 'bare-override', 'bare-added', 'added'],
    ['bare', false, OTHER, 'bare-override', 'bare-added', 'added'],
    ['bare', false, TARGETS, 'bare-override', 'bare-tightened', 'tightened'],
    ['scoped', true, [], 'bare-override', 'bare-added', 'added'],
    ['none', true, TARGETS, 'bare-override', 'bare-tightened', 'tightened'],
    ['direct', false, TARGETS, 'direct-update', 'none', 'none'],
    ['scoped', false, TARGETS, 'scoped-override', 'scoped', 'none'],
    ['none', false, [], 'scoped-override', 'scoped', 'none'],
  ] as const)('labels %s with step 2 %s', (shape, tighten, observations, action, scope, bare) => {
    expect(labelsOf(shape, tighten, observations)).toEqual({
      action,
      override_scope: scope,
      bare_override: bare,
    })
  })

  it('reads targets_this_package only as the boolean true', () => {
    expect(
      labelsOf('bare', false, [{ targets_this_package: 'true' }, 'x', null]).bare_override,
    ).toBe('added')
  })

  it('labels a lockfile refresh with no override', () => {
    expect(LOCKFILE_REFRESH).toEqual({
      action: 'lockfile-refresh',
      override_scope: 'none',
      bare_override: 'none',
    })
  })
})

describe('the versions of the line', () => {
  const answer = (versions: unknown) => ({ pm: 'npm', package: 'lodash', present: true, versions })

  it('selects the line, sorted as jq sorts text, each once', () => {
    expect(
      lineVersions(
        answer([
          { version: '4.17.9' },
          { version: '4.17.10' },
          { version: '3.10.1' },
          { version: '4.17.9' },
          { version: '40.0.0' },
          { version: '4' },
        ]),
        '4',
      ),
    ).toEqual(['4', '4.17.10', '4.17.9'])
  })

  // The line must start the version: 14.0.0 and 3.4.1 are not on the line 4.
  it('selects only a version that starts with the line', () => {
    expect(
      lineVersions(
        answer([
          { version: '14.0.0' },
          { version: '3.4.1' },
          { version: '4.0.0' },
          { version: '24.1.0' },
        ]),
        '4',
      ),
    ).toEqual(['4.0.0'])
  })

  it('gives the empty list for a line with no copy', () => {
    expect(lineVersions(answer([{ version: '3.10.1' }]), '4')).toEqual([])
  })

  it.each([
    ['an answer that is not an object', ['4.17.21']],
    ['no versions key', { present: true }],
    ['a versions value that is not a list', answer({ version: '4.17.21' })],
    ['a null version', answer([{ version: null }])],
    ['an entry that is not an object', answer(['4.17.21'])],
    ['a version that is a number', answer([{ version: 4 }])],
  ])('cannot read %s, which is never the empty list', (_name, payload) => {
    expect(lineVersions(payload, '4')).toBeNull()
  })
})

describe('the empty diff (#146)', () => {
  it.each([
    [false, ['4.17.21'], ['4.17.21'], 'no_op'],
    [false, ['4.17.20'], ['4.17.21'], 'no_op'],
    [true, ['4.17.21'], ['4.17.21'], 'no_op'],
    [true, ['4.17.20'], ['4.17.21'], 'lockfile_refresh'],
    [true, ['4.17.15', '4.17.20'], ['4.17.21'], 'lockfile_refresh'],
    [true, ['4.17.21'], ['4.17.20', '4.17.21'], 'lockfile_refresh'],
    // The bash compares the two lists as whole texts, so a longer one differs.
    [true, ['4.17.21'], ['4.17.21', '4.17.22'], 'lockfile_refresh'],
    [true, ['4.17.20', '4.17.21'], ['4.17.20', '4.17.21'], 'no_op'],
    [true, [], ['4.17.21'], 'disagree'],
    [false, ['4.17.21'], [], 'disagree'],
  ] as const)('with drift %s, %j then %j, is %s', (drift, pre, base, verdict) => {
    expect(emptyDiff(drift, pre, base)).toBe(verdict)
  })
})
