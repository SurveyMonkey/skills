// `apply_constraint` of the node adapter (#222, layer 2). The seam is
// `node.applyConstraint`. Each table holds the examples of one describe of
// spec/node_apply_constraint_spec.sh, and each expected value is the
// literal of that example. The parity run holds the agreement with node.sh,
// byte for byte.
//
// Each example runs on a scratch copy of its fixture, with the pointer file
// of a linked worktree, as `use_fixture` makes it. A setup edits the copy as
// the jq of the spec example does. The verdict examples run `validate`,
// `resolved_versions` or `list_pins` on the tree that the call wrote. The
// testing skill says why ("Assert the verdict, not the parse").
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import type {
  ApplyConstraintAnswer,
  ConstraintRequest,
  Tree,
  ValidateOptions,
} from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import type { Envelope } from '#gh-security/lib/envelope.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'

type Json = Record<string, unknown>

const treeAt = (root: string): Tree<NodeDetection> => {
  const detection = node.detect(root, {})
  if (detection.outcome !== 'ok') throw new Error(`detect refused ${root}: ${detection.error}`)
  return { root, detection: detection.value }
}

/** The request for an argument list of the spec: `--tighten-bare` first, then the package, the range and the parents. */
const requestOf = (args: readonly string[]): ConstraintRequest => {
  const tightenBare = args[0] === '--tighten-bare'
  const [pkg = '', range = '', ...parents] = tightenBare ? args.slice(1) : args
  return { pkg, range, parents, tightenBare }
}

const textAt = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

const readJson = (dir: string, file: string): Json => JSON.parse(textAt(dir, file)) as Json

/** Edit a JSON file of the copy, as `jq '...' file > tmp && mv tmp file` does in the spec. */
const editJson = (dir: string, file: string, edit: (document: Json) => void): void => {
  const document = readJson(dir, file)
  edit(document)
  writeFileSync(join(dir, file), `${JSON.stringify(document, null, 2)}\n`)
}

type Setup = (dir: string) => void

const manifestEdit =
  (edit: (manifest: Json) => void): Setup =>
  (dir) =>
    editJson(dir, 'package.json', edit)

const lockEdit =
  (edit: (packages: Json, lock: Json) => void): Setup =>
  (dir) =>
    editJson(dir, 'package-lock.json', (lock) => edit(lock.packages as Json, lock))

const both =
  (...setups: Setup[]): Setup =>
  (dir) => {
    for (const setup of setups) setup(dir)
  }

const workspaceFile =
  (text: string): Setup =>
  (dir) =>
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), text)

/** A scratch copy of `fixture` in a linked worktree, after `setup`. */
const copyOf = (fixture: string, setup?: Setup): string => {
  const copy = useFixture(fixture, { gitShape: 'linked-worktree' })
  onTestFinished(copy.cleanup)
  setup?.(copy.path)
  return copy.path
}

/** The call on a copy of `fixture`, and the directory of the copy. */
const apply = (fixture: string, args: readonly string[], setup?: Setup) => {
  const dir = copyOf(fixture, setup)
  return { envelope: node.applyConstraint(treeAt(dir), requestOf(args)), dir }
}

/** The answer of the call, or a throw that names the failure. */
const answerOf = (envelope: Envelope<ApplyConstraintAnswer>): ApplyConstraintAnswer => {
  if (envelope.outcome !== 'ok') throw new Error(`apply_constraint failed: ${envelope.error}`)
  return envelope.value
}

/** The answer of the call on a copy of `fixture`. */
const answer = (fixture: string, args: readonly string[], setup?: Setup) =>
  answerOf(apply(fixture, args, setup).envelope)

/** The manifest that the call wrote. */
const manifestAfter = (fixture: string, args: readonly string[], setup?: Setup): Json => {
  const { envelope, dir } = apply(fixture, args, setup)
  answerOf(envelope)
  return readJson(dir, 'package.json')
}

/**
 * The error of a refusal that comes before the first write. The files after
 * it are the files before it.
 */
const refusalOf = (fixture: string, args: readonly string[], setup?: Setup): string => {
  const dir = copyOf(fixture, setup)
  const files = ['package.json', 'package-lock.json', 'pnpm-workspace.yaml']
  const before = files.map((file) => readOptional(dir, file))
  const envelope = node.applyConstraint(treeAt(dir), requestOf(args))
  if (envelope.outcome === 'ok') throw new Error('apply_constraint answered ok')
  expect(files.map((file) => readOptional(dir, file))).toEqual(before)
  return envelope.error
}

/**
 * The error of a pnpm refusal that comes before the first write: the manifest
 * and the lockfile after it are the files before it.
 */
const pnpmRefusalOf = (fixture: string, args: readonly string[], setup?: Setup): string => {
  const dir = copyOf(fixture, setup)
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
  const before = files.map((file) => readOptional(dir, file))
  const envelope = node.applyConstraint(treeAt(dir), requestOf(args))
  if (envelope.outcome === 'ok') throw new Error('apply_constraint answered ok')
  expect(files.map((file) => readOptional(dir, file))).toEqual(before)
  return envelope.error
}

/** The version of the git copy of `debug` in the pnpm-git-parent fixtures. */
const GIT_DEBUG =
  'git+ssh://git@git.example.com/example/debug.git#da66c86c5fd71ef570f36b5b1edfa4472149f1bc'

/** The refusal of #50, written by hand from ruling 2. */
const outsideRegistryRefusal = (
  pkg: string,
  parents: readonly (readonly [string, readonly string[]])[],
): string =>
  `apply_constraint: cannot scope '${pkg}' under a pnpm parent with a copy from outside the registry, such as a git copy. Each parent in the detail also resolves at two or more registry versions, so its keys must name a registry version ('<parent>@<version>>${pkg}'), and no such key matches the other copy (issue #50). Detail: ${JSON.stringify(parents.map(([parent, versions_outside_registry]) => ({ parent, versions_outside_registry })))}. Nothing was written. The remedy is a registry version for that dependency, or one registry copy of the parent, so that the plain '<parent>>${pkg}' key covers each copy.`

/** The second refusal of #50: the plain key would move a copy across its major line. */
const plainKeyRefusal = (
  pkg: string,
  parents: readonly (readonly [string, readonly string[]])[],
): string =>
  `apply_constraint: cannot scope '${pkg}' under a pnpm parent with a copy from outside the registry, such as a git copy. Each parent in the detail keeps the plain '<parent>>${pkg}' key, and pnpm applies that key to each copy of the parent. A copy of the parent has '${pkg}' on another major line, so the key would move that copy across its line (issue #50). Detail: ${JSON.stringify(parents.map(([parent, versions_outside_registry]) => ({ parent, versions_outside_registry })))}. Nothing was written. The remedy is a registry version for that dependency, so that a key can name each copy of the parent.`

const readOptional = (dir: string, file: string): string | null => {
  try {
    return textAt(dir, file)
  } catch {
    return null
  }
}

/** `mkdir -p packages/app && cp package.json yarn.lock packages/app/`, and the new directory. */
const appIn = (dir: string): string => {
  const app = join(dir, 'packages', 'app')
  mkdirSync(app, { recursive: true })
  for (const name of ['package.json', 'yarn.lock']) {
    writeFileSync(join(app, name), readFileSync(join(dir, name)))
  }
  return app
}

/** U+2014, which one refusal of node.sh holds. */
const DASH = String.fromCodePoint(0x2014)

const BRACE = ['brace-expansion', '>=5.0.9 <6'] as const

const LODASH = ['lodash', '>=4.17.21 <5'] as const

/** A call that writes package.json of yarn-berry, so a guard that comes too late shows. */
const LODASH_BUMP = ['lodash', '>=4.17.23 <5'] as const

const PLACED = 'npm-override-placed-parent'

const PNPM11 = 'pnpm11-workspace-overrides'

const sortedKeys = (block: unknown): string[] => Object.keys(block as Json).sort()

const pnpmOverrides = (manifest: Json): Json => (manifest.pnpm as Json).overrides as Json

describe('mutating verbs run only in a linked worktree', () => {
  const pointer =
    (gitdir: string): Setup =>
    (dir) =>
      writeFileSync(join(dir, '.git'), `gitdir: ${gitdir}\n`)

  it.each([
    ['/parent/.git/modules/vendor'],
    ['../.git/modules/vendor'],
    ['../../main/.git/worktrees/fix/modules/vendor'],
    ['../../.git/modules/worktrees/foo'],
  ])('refuses in a git submodule with the gitdir %s, and writes nothing', (gitdir) => {
    expect(refusalOf('yarn-berry', LODASH_BUMP, pointer(gitdir))).toContain('submodule')
  })

  it.each([
    ['primary-checkout', 'primary checkout'],
    ['none', 'no git repository at or above'],
  ] as const)('refuses where the git shape is %s, and writes nothing', (gitShape, words) => {
    const fixture = useFixture('yarn-berry', { gitShape })
    onTestFinished(fixture.cleanup)
    const before = textAt(fixture.path, 'package.json')
    const envelope = node.applyConstraint(treeAt(fixture.path), requestOf(LODASH_BUMP))
    expect(envelope.outcome === 'failed' && envelope.error).toContain(words)
    expect(textAt(fixture.path, 'package.json')).toBe(before)
  })

  it('refuses in a subdirectory of a primary checkout, and writes nothing', () => {
    const fixture = useFixture('yarn-berry', { gitShape: 'primary-checkout' })
    onTestFinished(fixture.cleanup)
    const app = appIn(fixture.path)
    const before = textAt(app, 'package.json')
    const envelope = node.applyConstraint(treeAt(app), requestOf(LODASH_BUMP))
    expect(envelope.outcome === 'failed' && envelope.error).toContain(
      'subdirectory of the primary checkout',
    )
    expect(textAt(app, 'package.json')).toBe(before)
  })

  it.each([
    ['a linked worktree', undefined],
    [
      'a linked worktree of a repository under modules/',
      // A real gitdir with a `commondir` file (#304), beside the copy, where
      // the cleanup of the fixture removes it.
      (dir: string) => {
        const gitdir = join(`${dir}.main`, 'src', 'modules', 'app', '.git', 'worktrees', 'fix')
        mkdirSync(gitdir, { recursive: true })
        writeFileSync(join(gitdir, 'commondir'), '../..\n')
        pointer(gitdir)(dir)
      },
    ],
  ])('proceeds in %s', (_where, setup) => {
    const { package: pkg, pm } = answer('yarn-berry', LODASH, setup)
    expect({ package: pkg, pm }).toEqual({ package: 'lodash', pm: 'yarn' })
  })

  it('proceeds in a subdirectory of a linked worktree', () => {
    const app = appIn(copyOf('yarn-berry'))
    const { package: pkg, pm } = answerOf(node.applyConstraint(treeAt(app), requestOf(LODASH)))
    expect({ package: pkg, pm }).toEqual({ package: 'lodash', pm: 'yarn' })
  })
})

describe('the refusals of the request', () => {
  it.each([
    [['', '>=1.0.0'], 'apply_constraint requires a package name'],
    [['lodash'], 'apply_constraint requires a range'],
    [['--tighten-bare'], 'apply_constraint requires a package name'],
  ])('refuses %j', (args, error) => {
    expect(apply('pnpm-v9', args).envelope).toEqual({ outcome: 'failed', error })
  })

  // node.sh joins the parents with line feeds and splits them again.
  it('reads a parent with a line feed as two parents, and drops an empty parent', () => {
    expect(answer('pnpm-v9', [...LODASH, '', 'express\nkoa']).parents).toEqual(['express', 'koa'])
  })
})

describe('transitive dependencies get parent-scoped entries', () => {
  it('uses parent>dep for pnpm', () => {
    const manifest = manifestAfter('pnpm-v9', ['undici', '>=6.19.0 <7', 'express', 'koa'])
    expect(sortedKeys(pnpmOverrides(manifest)).filter((key) => key.includes('undici'))).toEqual([
      'express>undici',
      'koa>undici',
    ])
  })

  it('uses parent/dep for yarn', () => {
    const manifest = manifestAfter('yarn-berry', ['undici', '>=6.19.0 <7', '@vercel/fun'])
    expect((manifest.resolutions as Json)['@vercel/fun/undici']).toBe('>=6.19.0 <7')
  })

  it('uses nested objects for npm', () => {
    const manifest = manifestAfter('npm-v3', ['undici', '>=6.19.0 <7', 'glob', 'rimraf'])
    const overrides = manifest.overrides as Json
    expect({ glob: overrides.glob, rimraf: overrides.rimraf }).toEqual({
      glob: { undici: '>=6.19.0 <7' },
      rimraf: { undici: '>=6.19.0 <7' },
    })
  })
})

describe('pnpm parent keys are version-qualified across major lines', () => {
  it.each([
    [
      'one qualified key per parent version on the target line',
      'pnpm-cross-line',
      [...BRACE, 'minimatch'],
      ['minimatch@10.0.3>brace-expansion', 'minimatch@10.2.5>brace-expansion'],
    ],
    [
      'a different target line with that line parent version only',
      'pnpm-cross-line',
      ['brace-expansion', '>=1.1.12 <2', 'minimatch'],
      ['minimatch@3.1.5>brace-expansion'],
    ],
    [
      'the bare key for a parent resolved at a single version',
      'pnpm-cross-line',
      ['minimatch', '>=5.1.6 <6', 'filelist'],
      ['filelist>minimatch'],
    ],
    [
      'the bare key when no parent version qualifies',
      'pnpm-cross-line',
      ['brace-expansion', '>=9.0.0 <10', 'minimatch'],
      ['minimatch>brace-expansion'],
    ],
    [
      'a parent version whose child resolution has no readable major',
      'pnpm-peer-variant',
      ['minimist', '>=0.0.9 <0.1', 'optimist'],
      ['optimist@0.5.2>minimist', 'optimist@0.6.1>minimist'],
    ],
  ])('writes %s', (_title, fixture, args, keys) => {
    expect(sortedKeys(pnpmOverrides(manifestAfter(fixture, args)))).toEqual(keys)
  })

  // node.sh names this git copy `debug@git+ssh://git`, so no parent `debug`
  // reads it. The port drops its edge too (#50). Each expected key is the
  // answer of node.sh on the same copy. Ruling 2 on #50: where the keys of
  // `debug` must be version-qualified, the port refuses instead, because no
  // qualified key matches the git copy.
  /**
   * Copies of `debug` beside the git copy, each with its version of `ms`. A
   * copy with the version '' has the snapshot key `debug`, with no version.
   */
  const registryCopies =
    (...copies: (readonly [string, string])[]): Setup =>
    (dir) => {
      const keyOf = (debug: string) => (debug === '' ? 'debug' : `debug@${debug}`)
      const packages = copies.map(
        ([debug]) => `  ${keyOf(debug)}:\n    resolution: {integrity: x}\n\n`,
      )
      const snapshots = copies.map(
        ([debug, ms]) => `  ${keyOf(debug)}:\n    dependencies:\n      ms: ${ms}\n\n`,
      )
      const text = textAt(dir, 'pnpm-lock.yaml')
        .replace('packages:\n\n', `packages:\n\n${packages.join('')}`)
        .replace('snapshots:\n\n', `snapshots:\n\n${snapshots.join('')}`)
      writeFileSync(join(dir, 'pnpm-lock.yaml'), text)
    }

  it.each([
    ['one registry copy', [['4.3.4', '2.1.3']], { 'debug>ms': '^2.1.3' }],
    [
      'two registry copies and a copy with no version',
      [
        ['4.3.4', '2.1.2'],
        ['2.6.9', '2.0.0'],
        ['', '2.0.0'],
      ],
      { 'debug>ms': '^2.1.3' },
    ],
  ] as const)('reads no edge from a git copy of the parent, beside %s', (_, copies, keys) => {
    const manifest = manifestAfter(
      'pnpm-git-parent',
      ['ms', '^2.1.3', 'debug'],
      registryCopies(...copies),
    )
    expect(pnpmOverrides(manifest)).toEqual(keys)
  })

  // #50 asks for the git parent through `why` and then `apply_constraint`.
  // `why` names the parent; the call scopes `ms` to the parents it names.
  const parentsByWhy = async (fixture: string): Promise<readonly string[]> => {
    const answered = await node.why(treeAt(join(FIXTURES_ROOT, fixture)), 'ms', { raw: '' })
    if (answered.outcome !== 'ok') throw new Error(`why failed: ${answered.error}`)
    return answered.value.parents
  }

  it('scopes through the parent that why names, with one registry copy, by the plain key', async () => {
    const parents = await parentsByWhy('pnpm-git-parent')
    expect(parents).toEqual(['debug'])
    const manifest = manifestAfter('pnpm-git-parent', ['ms', '^2.1.3', ...parents])
    expect(pnpmOverrides(manifest)).toEqual({ 'debug>ms': '^2.1.3' })
  })

  it('refuses the parent that why names, beside two registry copies, and writes nothing (#50)', async () => {
    const parents = await parentsByWhy('pnpm-git-parent-copies')
    expect(parents).toEqual(['debug'])
    expect(pnpmRefusalOf('pnpm-git-parent-copies', ['ms', '>=2.1.3 <3', ...parents])).toBe(
      outsideRegistryRefusal('ms', [['debug', [GIT_DEBUG]]]),
    )
  })

  it('names each refused parent, and only the parents with a git copy (#50)', () => {
    expect(
      pnpmRefusalOf('pnpm-git-parent-copies', ['ms', '>=2.1.3 <3', 'finalhandler', 'debug']),
    ).toBe(outsideRegistryRefusal('ms', [['debug', [GIT_DEBUG]]]))
  })

  /** Copies of `parent` at the start of each section, each with its version of `ms`. */
  const parentCopies =
    (parent: string, ...copies: (readonly [string, string])[]): Setup =>
    (dir) => {
      const packages = copies.map(([pver]) => `  ${parent}@${pver}:\n    resolution: {}\n\n`)
      const snapshots = copies.map(
        ([pver, ms]) => `  ${parent}@${pver}:\n    dependencies:\n      ms: ${ms}\n\n`,
      )
      const text = textAt(dir, 'pnpm-lock.yaml')
      const edited = text
        .replace('packages:\n\n', `packages:\n\n${packages.join('')}`)
        .replace('snapshots:\n\n', `snapshots:\n\n${snapshots.join('')}`)
      if (edited === text) throw new Error('the lockfile has no packages or snapshots section')
      writeFileSync(join(dir, 'pnpm-lock.yaml'), edited)
    }

  // `send` gets qualified keys too, but it has no git copy.
  it('leaves a qualified parent with no git copy out of the detail (#50)', () => {
    const send = parentCopies('send', ['0.16.2', '2.0.0'], ['0.18.0', '2.1.3'])
    expect(
      pnpmRefusalOf('pnpm-git-parent-copies', ['ms', '>=2.1.3 <3', 'send', 'debug'], send),
    ).toBe(outsideRegistryRefusal('ms', [['debug', [GIT_DEBUG]]]))
  })

  it('gives each refused parent its own git copies, in the order of the file (#50)', () => {
    const debugGit = 'git+ssh://git@git.example.com/example/debug.git#1111111'
    const sendGit = 'git+ssh://git@git.example.com/example/send.git#2222222'
    const setup = both(
      parentCopies('debug', [debugGit, '2.1.2']),
      parentCopies('send', ['0.16.2', '2.0.0'], ['0.18.0', '2.1.3'], [sendGit, '2.1.3']),
    )
    expect(
      pnpmRefusalOf('pnpm-git-parent-copies', ['ms', '>=2.1.3 <3', 'send', 'debug'], setup),
    ).toBe(
      outsideRegistryRefusal('ms', [
        ['send', [sendGit]],
        ['debug', [debugGit, GIT_DEBUG]],
      ]),
    )
  })

  it('refuses a git copy of the parent beside two registry copies (#50)', () => {
    const error = pnpmRefusalOf(
      'pnpm-git-parent',
      ['ms', '^2.1.3', 'debug'],
      registryCopies(['4.3.4', '2.1.2'], ['2.6.9', '2.0.0']),
    )
    expect(error).toBe(outsideRegistryRefusal('ms', [['debug', [GIT_DEBUG]]]))
  })

  // Ruling 2 on #50 names each git copy, and a git URL can have no `@`. For
  // a GitHub host, pnpm writes a codeload tarball (see the header of the
  // pnpm-git-parent lockfile). For another host, it writes the `git+https`
  // URL. A `file:` copy is also outside the registry.
  const OTHER_COPIES = [
    'git+https://git.example.com/example/debug.git#da66c86c5fd71ef570f36b5b1edfa4472149f1bc',
    'https://codeload.github.com/example/debug/tar.gz/da66c86c5fd71ef570f36b5b1edfa4472149f1bc',
    'file:vendor/debug-4.3.4.tgz',
  ]

  /** The git copy of `debug` in the lockfile, moved to `version`. */
  const gitCopyAt =
    (version: string): Setup =>
    (dir) => {
      const text = textAt(dir, 'pnpm-lock.yaml')
      const moved = text.replaceAll(GIT_DEBUG, version)
      if (moved === text) throw new Error('the lockfile has no git copy of debug')
      writeFileSync(join(dir, 'pnpm-lock.yaml'), moved)
    }

  it.each(OTHER_COPIES)('refuses a copy at %s beside two registry copies (#50)', (version) => {
    const setup = gitCopyAt(version)
    expect(pnpmRefusalOf('pnpm-git-parent-copies', ['ms', '>=2.1.3 <3', 'debug'], setup)).toBe(
      outsideRegistryRefusal('ms', [['debug', [version]]]),
    )
  })

  it.each(OTHER_COPIES)(
    'writes the plain key for a copy at %s beside one registry copy (#50)',
    (version) => {
      const setup = both(gitCopyAt(version), registryCopies(['4.3.4', '2.1.3']))
      const manifest = manifestAfter('pnpm-git-parent', ['ms', '^2.1.3', 'debug'], setup)
      expect(pnpmOverrides(manifest)).toEqual({ 'debug>ms': '^2.1.3' })
    },
  )

  /** The `ms` of the git copy of `debug`, moved to `version`. Run it before `gitCopyAt`. */
  const gitChildAt =
    (version: string): Setup =>
    (dir) => {
      const text = textAt(dir, 'pnpm-lock.yaml')
      const from = `  debug@${GIT_DEBUG}:\n    dependencies:\n      ms: 2.1.2\n`
      const moved = text.replace(
        from,
        `  debug@${GIT_DEBUG}:\n    dependencies:\n      ms: ${version}\n`,
      )
      if (moved === text) throw new Error('the lockfile has no git copy of debug with ms 2.1.2')
      writeFileSync(join(dir, 'pnpm-lock.yaml'), moved)
    }

  /** The git copy of `debug` at `version`, or as the fixture has it. */
  const copyAt = (version: string): Setup =>
    version === GIT_DEBUG ? () => undefined : gitCopyAt(version)

  // The plain key reaches each copy of the parent. A real pnpm 10.34.5 run
  // gave this: with `debug>ms` in the overrides, `pnpm install
  // --lockfile-only` moved the `ms` of a codeload copy of `debug`. So where a
  // copy of the parent has `ms` on another major line, the plain key moves
  // that copy across its line. node.sh writes `debug@4.3.4>ms` here for a
  // URL with no `@`, and the plain key for a URL with an `@` (#50).
  it.fails.each([GIT_DEBUG, ...OTHER_COPIES])(
    'refuses the plain key when a copy at %s has ms on another line (#50)',
    (version) => {
      const setup = both(gitChildAt('1.0.0'), copyAt(version), registryCopies(['4.3.4', '2.1.3']))
      expect(pnpmRefusalOf('pnpm-git-parent', ['ms', '^2.1.3', 'debug'], setup)).toBe(
        plainKeyRefusal('ms', [['debug', [version]]]),
      )
    },
  )

  // Here the copy from outside the registry is on the line, and each registry
  // copy is not. No registry copy is on the line, so no key is qualified, and
  // the plain key would move both registry copies. node.sh writes a key that
  // names the URL, or the plain key for a URL with an `@` (#50).
  it.fails.each([GIT_DEBUG, ...OTHER_COPIES])(
    'refuses the plain key when a copy at %s is the one copy on the line (#50)',
    (version) => {
      const setup = both(copyAt(version), registryCopies(['2.6.9', '1.0.0'], ['3.0.0', '1.1.0']))
      expect(pnpmRefusalOf('pnpm-git-parent', ['ms', '^2.1.3', 'debug'], setup)).toBe(
        plainKeyRefusal('ms', [['debug', [version]]]),
      )
    },
  )

  // The multiplicity gate reads the snapshot edges, not `packages:`.
  it('still writes qualified keys when the packages section is unreadable', () => {
    const dropPackages: Setup = (dir) => {
      const lines = textAt(dir, 'pnpm-lock.yaml').split('\n')
      let skip = false
      const kept = lines.filter((line) => {
        if (line.startsWith('packages:')) {
          skip = true
          return false
        }
        if (/^[a-zA-Z]/.test(line)) skip = false
        return !skip
      })
      writeFileSync(join(dir, 'pnpm-lock.yaml'), kept.join('\n'))
    }
    const manifest = manifestAfter('pnpm-cross-line', [...BRACE, 'minimatch'], dropPackages)
    expect(sortedKeys(pnpmOverrides(manifest))).toEqual([
      'minimatch@10.0.3>brace-expansion',
      'minimatch@10.2.5>brace-expansion',
    ])
  })

  it('reports the qualified keys it wrote', () => {
    expect(answer('pnpm-cross-line', [...BRACE, 'minimatch']).written).toEqual([
      {
        parent: 'minimatch',
        path: ['pnpm', 'overrides', 'minimatch@10.0.3>brace-expansion'],
        value: '>=5.0.9 <6',
      },
      {
        parent: 'minimatch',
        path: ['pnpm', 'overrides', 'minimatch@10.2.5>brace-expansion'],
        value: '>=5.0.9 <6',
      },
    ])
  })

  it.each([
    ['pnpm-optional-parent', 'jspdf>dompurify'],
    ['pnpm-optional-qualified', 'jspdf@4.2.1>dompurify'],
  ])('scopes through optionalDependencies on %s', (fixture, key) => {
    expect(answer(fixture, ['dompurify', '>=3.4.13 <4', 'jspdf']).written).toEqual([
      { parent: 'jspdf', path: ['pnpm', 'overrides', key], value: '>=3.4.13 <4' },
    ])
  })

  it('writes the same override state the intact post-install specimen carries', () => {
    const specimen = readJson(join(FIXTURES_ROOT, 'pnpm-cross-line-qualified'), 'package.json')
    expect(pnpmOverrides(manifestAfter('pnpm-cross-line', [...BRACE, 'minimatch']))).toEqual(
      pnpmOverrides(specimen),
    )
  })
})

describe('npm parent keys are version-qualified across major lines', () => {
  const minimatch = [...BRACE, 'minimatch']

  it.each([
    [
      'one qualified key per parent copy, root spec verbatim for the direct dependency',
      undefined,
      ['minimatch@10.0.3', 'minimatch@^10.2.5'],
    ],
    [
      'the qualified keys when the root spec is in devDependencies',
      manifestEdit((manifest) => {
        manifest.devDependencies = { minimatch: (manifest.dependencies as Json).minimatch }
        delete (manifest.dependencies as Json).minimatch
      }),
      ['minimatch@10.0.3', 'minimatch@^10.2.5'],
    ],
    [
      'a prerelease copy its own exact key rather than counting it covered',
      lockEdit((packages) => {
        ;(packages['node_modules/minimatch'] as Json).version = '10.3.0-beta.1'
      }),
      ['minimatch@10.0.3', 'minimatch@10.3.0-beta.1'],
    ],
  ])('writes %s', (_title, setup, keys) => {
    expect(sortedKeys(manifestAfter('npm-cross-line', minimatch, setup).overrides)).toEqual(keys)
  })

  it.each([
    [
      'a different target line with that line parent copy only',
      ['brace-expansion', '>=1.1.12 <2', 'minimatch'],
      undefined,
      { 'minimatch@3.1.5': { 'brace-expansion': '>=1.1.12 <2' } },
    ],
    [
      'the bare nested key for a parent resolved at a single version',
      ['minimatch', '>=5.1.6 <6', 'filelist'],
      undefined,
      { filelist: { minimatch: '>=5.1.6 <6' } },
    ],
    [
      'the bare nested key when no parent copy qualifies',
      ['brace-expansion', '>=9.0.0 <10', 'minimatch'],
      undefined,
      { minimatch: { 'brace-expansion': '>=9.0.0 <10' } },
    ],
    [
      'the bare nested key when the lockfile has no packages object',
      minimatch,
      lockEdit((_packages, lock) => {
        delete lock.packages
      }),
      { minimatch: { 'brace-expansion': '>=5.0.9 <6' } },
    ],
    [
      'the bare nested key when the root spec is a dist-tag',
      minimatch,
      manifestEdit((manifest) => {
        ;(manifest.dependencies as Json).minimatch = 'latest'
      }),
      { minimatch: { 'brace-expansion': '>=5.0.9 <6' } },
    ],
    [
      'the bare nested key when a parent copy has no readable version',
      minimatch,
      lockEdit((packages) => {
        delete (packages['node_modules/@ts-morph/common/node_modules/minimatch'] as Json).version
      }),
      { minimatch: { 'brace-expansion': '>=5.0.9 <6' } },
    ],
    [
      'the bare nested key when a parent copy version is not plain semver',
      minimatch,
      lockEdit((packages) => {
        ;(packages['node_modules/@ts-morph/common/node_modules/minimatch'] as Json).version =
          '10.x-bogus'
      }),
      { minimatch: { 'brace-expansion': '>=5.0.9 <6' } },
    ],
  ])('writes %s', (_title, args, setup, overrides) => {
    expect(manifestAfter('npm-cross-line', args, setup).overrides).toEqual(overrides)
  })

  it('reports the qualified keys it wrote, the root spec first', () => {
    expect(answer('npm-cross-line', minimatch).written).toEqual([
      {
        parent: 'minimatch',
        path: ['overrides', 'minimatch@^10.2.5', 'brace-expansion'],
        value: '>=5.0.9 <6',
      },
      {
        parent: 'minimatch',
        path: ['overrides', 'minimatch@10.0.3', 'brace-expansion'],
        value: '>=5.0.9 <6',
      },
    ])
  })

  it('writes the same override state the intact post-install specimen carries', () => {
    const specimen = readJson(join(FIXTURES_ROOT, 'npm-cross-line-qualified'), 'package.json')
    expect(manifestAfter('npm-cross-line', minimatch).overrides).toEqual(specimen.overrides)
  })

  it('still invalidates exactly the stale target-line lockfile entries', () => {
    expect(answer('npm-cross-line', minimatch).lockfile_invalidated).toEqual({
      performed: true,
      keys: ['node_modules/brace-expansion'],
    })
  })

  it('refuses a root spec that also admits an off-line parent copy, writing nothing', () => {
    const error = refusalOf(
      'npm-cross-line',
      minimatch,
      manifestEdit((manifest) => {
        ;(manifest.dependencies as Json).minimatch = '>=3.0.0'
      }),
    )
    expect(error).toContain('copies on other major lines')
    expect(error).toContain(
      'Detail: [{"parent":"minimatch","root_spec":">=3.0.0","other_line_versions":["3.1.5","5.1.6"]}]',
    )
  })

  const bareKey = (range: string): Setup =>
    manifestEdit((manifest) => {
      manifest.overrides = { minimatch: { 'brace-expansion': range } }
    })

  it('supersedes a same-line bare nested key and reports it', () => {
    const { superseded_keys, written } = answer('npm-cross-line', minimatch, bareKey('>=5.0.6 <6'))
    expect({ superseded: superseded_keys, keys: written.map(({ path }) => path[1]) }).toEqual({
      superseded: [
        {
          parent: 'minimatch',
          path: ['overrides', 'minimatch', 'brace-expansion'],
          value: '>=5.0.6 <6',
        },
      ],
      keys: ['minimatch@^10.2.5', 'minimatch@10.0.3'],
    })
  })

  it('leaves no bare pair behind after superseding it', () => {
    const specimen = readJson(join(FIXTURES_ROOT, 'npm-cross-line-qualified'), 'package.json')
    expect(manifestAfter('npm-cross-line', minimatch, bareKey('>=5.0.6 <6')).overrides).toEqual(
      specimen.overrides,
    )
  })

  it('refuses to write beside a bare pair that pins a different line', () => {
    const error = refusalOf('npm-cross-line', minimatch, bareKey('>=1.1.18 <2'))
    expect(error).toContain('reconcile the existing override by hand')
    expect(error).toContain(
      '{"parent":"minimatch","value":">=1.1.18 <2","parent_also_override_placed":false}',
    )
  })

  it('qualifies a scoped parent resolved at several versions', () => {
    const { written } = answer('npm-scoped-cross-line', [
      'minimatch',
      '>=10.0.5 <11',
      '@npmcli/map-workspaces',
    ])
    expect(written.map(({ path }) => path)).toEqual([
      ['overrides', '@npmcli/map-workspaces@4.0.2', 'minimatch'],
    ])
  })
})

const secondNxLine = lockEdit((packages) => {
  packages['node_modules/foo'] = { version: '1.0.0', dependencies: { nx: '^21.0.0' } }
  packages['node_modules/foo/node_modules/nx'] = {
    version: '21.5.0',
    dependencies: { 'brace-expansion': '^1.1.7' },
  }
  packages['node_modules/foo/node_modules/brace-expansion'] = { version: '1.1.12' }
})

const rule = (overrides: Json): Setup =>
  manifestEdit((manifest) => {
    manifest.overrides = overrides
  })

const nx = [...BRACE, 'nx']

const NESTED = { '.': '>=22.7.7 <23', 'brace-expansion': '>=5.0.9 <6' }

describe('npm constraint nests inside a pre-existing override that places the parent', () => {
  it('nests inside the placing rule, "." carrying the parent range', () => {
    expect(((manifestAfter(PLACED, nx).overrides as Json).lerna as Json).nx).toEqual(NESTED)
  })

  it('writes no top-level key for the placed parent and preserves every sibling', () => {
    expect(manifestAfter(PLACED, nx).overrides).toEqual({
      lerna: { nx: NESTED, chalk: '^6.0.0' },
      glob: '^13.0.0',
    })
  })

  it('reports the "." coercion, marked preserved, and the nested key it wrote', () => {
    expect(answer(PLACED, nx).written).toEqual([
      {
        parent: 'nx',
        path: ['overrides', 'lerna', 'nx', '.'],
        value: '>=22.7.7 <23',
        preserved: true,
      },
      { parent: 'nx', path: ['overrides', 'lerna', 'nx', 'brace-expansion'], value: '>=5.0.9 <6' },
    ])
  })

  it('adds to an already-object rule, keeping its "." and siblings', () => {
    const objectRule = manifestEdit((manifest) => {
      ;((manifest.overrides as Json).lerna as Json).nx = { '.': '>=22.7.7 <23', minimist: '^1.2.8' }
    })
    const { envelope, dir } = apply(PLACED, nx, objectRule)
    expect({
      rule: ((readJson(dir, 'package.json').overrides as Json).lerna as Json).nx,
      written: answerOf(envelope).written.map(({ path }) => path),
    }).toEqual({
      rule: { '.': '>=22.7.7 <23', minimist: '^1.2.8', 'brace-expansion': '>=5.0.9 <6' },
      written: [['overrides', 'lerna', 'nx', 'brace-expansion']],
    })
  })

  it('round-trips through list_pins with the real nested paths', () => {
    const { dir } = apply(PLACED, nx)
    const pins = node.listPins(treeAt(dir))
    expect(
      pins.outcome === 'ok' &&
        pins.value.pins.map(({ package: name, parents, range }) => ({
          package: name,
          parents,
          range,
        })),
    ).toEqual([
      { package: 'nx', parents: ['lerna'], range: '>=22.7.7 <23' },
      { package: 'brace-expansion', parents: ['lerna', 'nx'], range: '>=5.0.9 <6' },
      { package: 'chalk', parents: ['lerna'], range: '^6.0.0' },
      { package: 'glob', parents: [], range: '^13.0.0' },
    ])
  })

  it('still invalidates the stale target-line lockfile entry', () => {
    expect(answer(PLACED, nx).lockfile_invalidated).toEqual({
      performed: true,
      keys: ['node_modules/brace-expansion'],
    })
  })

  it('treats a top-level rule for the parent as the ordinary merge, not placement', () => {
    expect(manifestAfter(PLACED, nx, rule({ nx: { minimist: '^1.2.8' } })).overrides).toEqual({
      nx: { minimist: '^1.2.8', 'brace-expansion': '>=5.0.9 <6' },
    })
  })

  it('nests without refusing when a second major line resolves outside the placing rule', () => {
    const { envelope, dir } = apply(PLACED, nx, secondNxLine)
    expect({
      overrides: readJson(dir, 'package.json').overrides,
      invalidated: answerOf(envelope).lockfile_invalidated.keys,
    }).toEqual({
      overrides: { lerna: { nx: NESTED, chalk: '^6.0.0' }, glob: '^13.0.0' },
      invalidated: ['node_modules/brace-expansion'],
    })
  })
})

describe('npm placement detection is grounded in the lockfile', () => {
  it.each([
    ['the rule root is absent from the lockfile', { 'unrelated-pkg': { nx: '^22' } }],
    ['nx never resolves under the root', { chalk: { nx: '^22' } }],
  ])('writes the ordinary top-level key when %s', (_why, overrides) => {
    expect(manifestAfter(PLACED, nx, rule(overrides)).overrides).toEqual({
      ...overrides,
      nx: { 'brace-expansion': '>=5.0.9 <6' },
    })
  })

  it('keeps the qualified-key path working beside an uncorroborated rule', () => {
    const setup = both(rule({ 'unrelated-pkg': { nx: '^22' } }), secondNxLine)
    expect(manifestAfter(PLACED, nx, setup).overrides).toEqual({
      'unrelated-pkg': { nx: '^22' },
      'nx@22.7.9': { 'brace-expansion': '>=5.0.9 <6' },
    })
  })

  it('writes both shapes for a parent with placed and normally-resolved copies', () => {
    const zed = lockEdit((packages) => {
      ;((packages[''] as Json).dependencies as Json).zed = '^1.0.0'
      packages['node_modules/zed'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
      packages['node_modules/zed/node_modules/nx'] = {
        version: '22.6.0',
        dependencies: { 'brace-expansion': '^5.0.4' },
      }
    })
    const { envelope, dir } = apply(PLACED, nx, zed)
    expect({
      paths: answerOf(envelope).written.map(({ path }) => path),
      overrides: readJson(dir, 'package.json').overrides,
    }).toEqual({
      paths: [
        ['overrides', 'lerna', 'nx', '.'],
        ['overrides', 'lerna', 'nx', 'brace-expansion'],
        ['overrides', 'nx@22.6.0', 'brace-expansion'],
      ],
      overrides: {
        lerna: { nx: NESTED, chalk: '^6.0.0' },
        glob: '^13.0.0',
        'nx@22.6.0': { 'brace-expansion': '>=5.0.9 <6' },
      },
    })
  })
})

describe('npm placement refusals', () => {
  const lernaBaz = lockEdit((packages) => {
    ;((packages['node_modules/lerna'] as Json).dependencies as Json).baz = '^1.0.0'
    packages['node_modules/baz'] = { version: '1.0.0', dependencies: { nx: '^21.0.0' } }
    packages['node_modules/baz/node_modules/nx'] = {
      version: '21.5.0',
      dependencies: { 'brace-expansion': '^1.1.7' },
    }
    packages['node_modules/baz/node_modules/brace-expansion'] = { version: '1.1.12' }
  })
  const aliasRule = both(
    rule({ lerna: { 'nx-tools': 'npm:nx@>=22.7.7 <23' }, glob: '^13.0.0' }),
    lockEdit((packages) => {
      delete packages['node_modules/nx']
      packages['node_modules/nx-tools'] = {
        name: 'nx',
        version: '22.7.9',
        dependencies: { 'brace-expansion': '^5.0.4' },
      }
      ;(packages['node_modules/lerna'] as Json).dependencies = {
        'nx-tools': 'npm:nx@22.7.7',
        chalk: '^6.0.0',
      }
    }),
  )

  it.each([
    [
      'a rule that places the parent through an alias child key',
      aliasRule,
      'npm: ALIAS child key',
      '[{"parent":"nx","rule":"overrides.lerna.nx-tools"}]',
    ],
    [
      'a version-qualified placing rule key',
      rule({ lerna: { 'nx@^22.0.0': '>=22.7.7 <23' }, glob: '^13.0.0' }),
      'version-qualified child key',
      '[{"parent":"nx","rule":"overrides.lerna.nx@^22.0.0"}]',
    ],
    [
      'a placing rule that reaches parent copies on another child line',
      lernaBaz,
      'sits on other major line(s)',
      '[{"parent":"nx","rules":["overrides.lerna.nx"],"other_line_majors":["1"]}]',
    ],
    [
      'a different-line dead top-level pair',
      manifestEdit((manifest) => {
        ;(manifest.overrides as Json).nx = { 'brace-expansion': '^1.1.11' }
      }),
      'override-placed parent pins a DIFFERENT major line',
      '[{"parent":"nx","key":"overrides.nx.brace-expansion","value":"^1.1.11"}]',
    ],
    [
      'a different-line pin inside the placing rule',
      manifestEdit((manifest) => {
        ;((manifest.overrides as Json).lerna as Json).nx = {
          '.': '>=22.7.7 <23',
          'brace-expansion': '^1.1.11',
        }
      }),
      'INSIDE the override rule',
      '[{"parent":"nx","rule":"overrides.lerna.nx","value":"^1.1.11"}]',
    ],
  ])('refuses %s, writing nothing', (_title, setup, words, detail) => {
    const error = refusalOf(PLACED, nx, setup)
    expect(error).toContain(words)
    expect(error).toContain(detail)
  })
})

describe('npm placement supersession and composition', () => {
  const report = (setup: Setup) => {
    const { envelope, dir } = apply(PLACED, nx, setup)
    return {
      superseded: answerOf(envelope).superseded_keys,
      overrides: readJson(dir, 'package.json').overrides,
    }
  }
  const PLACED_STATE = { lerna: { nx: NESTED, chalk: '^6.0.0' }, glob: '^13.0.0' }

  it('supersedes the dead same-line top-level pair a pre-fix run left', () => {
    const deadPair = manifestEdit((manifest) => {
      ;(manifest.overrides as Json).nx = { 'brace-expansion': '>=5.0.9 <6' }
    })
    expect(report(deadPair)).toEqual({
      superseded: [
        { parent: 'nx', path: ['overrides', 'nx', 'brace-expansion'], value: '>=5.0.9 <6' },
      ],
      overrides: PLACED_STATE,
    })
  })

  it('supersedes a same-line pin inside the placing rule', () => {
    const rulePin = manifestEdit((manifest) => {
      ;((manifest.overrides as Json).lerna as Json).nx = {
        '.': '>=22.7.7 <23',
        'brace-expansion': '^5.0.4',
      }
    })
    expect(report(rulePin)).toEqual({
      superseded: [
        { parent: 'nx', path: ['overrides', 'lerna', 'nx', 'brace-expansion'], value: '^5.0.4' },
      ],
      overrides: PLACED_STATE,
    })
  })

  it('nests and keeps a top-level pair that still protects a normal off-line copy', () => {
    const pair = manifestEdit((manifest) => {
      ;(manifest.overrides as Json).nx = { 'brace-expansion': '^1.1.11' }
    })
    expect(report(both(pair, secondNxLine))).toEqual({
      superseded: [],
      overrides: { ...PLACED_STATE, nx: { 'brace-expansion': '^1.1.11' } },
    })
  })

  it('marks a preserved alias value under "." rather than reporting it as a new write', () => {
    const aliasValue = manifestEdit((manifest) => {
      ;((manifest.overrides as Json).lerna as Json).nx = 'npm:nx@22.7.7'
    })
    expect(answer(PLACED, nx, aliasValue).written).toEqual([
      {
        parent: 'nx',
        path: ['overrides', 'lerna', 'nx', '.'],
        value: 'npm:nx@22.7.7',
        preserved: true,
      },
      { parent: 'nx', path: ['overrides', 'lerna', 'nx', 'brace-expansion'], value: '>=5.0.9 <6' },
    ])
  })
})

describe('npm placement rule shapes', () => {
  const shape = (subject: string, setup: Setup) => {
    const { envelope, dir } = apply(PLACED, [...BRACE, subject], setup)
    return {
      paths: answerOf(envelope).written.map(({ path }) => path),
      overrides: readJson(dir, 'package.json').overrides,
    }
  }

  it('nests inside every rule when two rules place the same parent', () => {
    const twoRules = both(
      rule({ lerna: { nx: '>=22.7.7 <23' }, top: { nx: '>=22.7.7 <23' } }),
      lockEdit((packages) => {
        ;((packages[''] as Json).dependencies as Json).top = '^1.0.0'
        packages['node_modules/top'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
      }),
    )
    expect(shape('nx', twoRules)).toEqual({
      paths: [
        ['overrides', 'lerna', 'nx', '.'],
        ['overrides', 'lerna', 'nx', 'brace-expansion'],
        ['overrides', 'top', 'nx', '.'],
        ['overrides', 'top', 'nx', 'brace-expansion'],
      ],
      overrides: { lerna: { nx: NESTED }, top: { nx: NESTED } },
    })
  })

  it('nests at the full path of a depth-3 placing rule', () => {
    const depthThree = both(rule({ top: { lerna: { nx: '>=22.7.7 <23' } } }), topOverLerna)
    expect(shape('nx', depthThree)).toEqual({
      paths: [
        ['overrides', 'top', 'lerna', 'nx', '.'],
        ['overrides', 'top', 'lerna', 'nx', 'brace-expansion'],
      ],
      overrides: { top: { lerna: { nx: NESTED } } },
    })
  })

  it('places a scoped package parent', () => {
    const scoped = both(
      rule({ lerna: { '@nx/devkit': '>=17.0.0 <18' } }),
      lockEdit((packages) => {
        ;(packages['node_modules/lerna'] as Json).dependencies = {
          '@nx/devkit': '^17.0.0',
          chalk: '^6.0.0',
        }
        delete packages['node_modules/nx']
        packages['node_modules/@nx/devkit'] = {
          version: '17.2.0',
          dependencies: { 'brace-expansion': '^5.0.4' },
        }
      }),
    )
    expect(shape('@nx/devkit', scoped)).toEqual({
      paths: [
        ['overrides', 'lerna', '@nx/devkit', '.'],
        ['overrides', 'lerna', '@nx/devkit', 'brace-expansion'],
      ],
      overrides: {
        lerna: { '@nx/devkit': { '.': '>=17.0.0 <18', 'brace-expansion': '>=5.0.9 <6' } },
      },
    })
  })
})

const topOverLerna = lockEdit((packages) => {
  ;((packages[''] as Json).dependencies as Json).top = '^1.0.0'
  packages['node_modules/top'] = { version: '1.0.0', dependencies: { lerna: '^9.0.0' } }
})

describe('npm placement corroboration respects rule selectors', () => {
  const TOP_LEVEL = { nx: { 'brace-expansion': '>=5.0.9 <6' } }

  it.each([
    [
      'the root selector cannot match',
      { 'lerna@^8.0.0': { nx: '>=22.7.7 <23' } },
      undefined,
      { 'lerna@^8.0.0': { nx: '>=22.7.7 <23' }, ...TOP_LEVEL },
    ],
    [
      'the root selector admits the installed copy',
      { 'lerna@^9.0.0': { nx: '>=22.7.7 <23' } },
      undefined,
      { 'lerna@^9.0.0': { nx: NESTED } },
    ],
    [
      'a depth-3 intermediate selector cannot match',
      { top: { 'lerna@^8.0.0': { nx: '>=22.7.7 <23' } } },
      topOverLerna,
      { top: { 'lerna@^8.0.0': { nx: '>=22.7.7 <23' } }, ...TOP_LEVEL },
    ],
    [
      'the child rule key selector matches no installed copy',
      { lerna: { 'nx@^21.0.0': '>=21.7.7 <22' } },
      undefined,
      { lerna: { 'nx@^21.0.0': '>=21.7.7 <22' }, ...TOP_LEVEL },
    ],
  ])('writes the expected block when %s', (_title, overrides, setup, expected) => {
    const setups = setup === undefined ? rule(overrides) : both(setup, rule(overrides))
    expect(manifestAfter(PLACED, nx, setups).overrides).toEqual(expected)
  })
})

describe('npm placement corroboration on a branching graph', () => {
  it('exhausts a non-corroborating branching graph without hanging', () => {
    const ladder = both(
      rule({ webpack: { nx: '^22' } }),
      lockEdit((_packages, lock) => {
        const packages: Json = {
          '': {
            name: 'demo',
            version: '1.0.0',
            dependencies: { 'lib-a-0': '^1.0.0', 'lib-b-0': '^1.0.0' },
          },
          'node_modules/nx': { version: '22.7.9', dependencies: { 'brace-expansion': '^5.0.4' } },
          'node_modules/brace-expansion': { version: '5.0.5' },
        }
        for (let level = 0; level < 22; level += 1) {
          for (const side of ['a', 'b']) {
            packages[`node_modules/lib-${side}-${level}`] = {
              version: '1.0.0',
              dependencies:
                level === 21
                  ? { nx: '^22.0.0' }
                  : { [`lib-a-${level + 1}`]: '^1.0.0', [`lib-b-${level + 1}`]: '^1.0.0' },
            }
          }
        }
        lock.packages = packages
      }),
    )
    expect(manifestAfter(PLACED, nx, ladder).overrides).toEqual({
      webpack: { nx: '^22' },
      nx: { 'brace-expansion': '>=5.0.9 <6' },
    })
  })
})

describe('npm --tighten-bare and placed packages', () => {
  const tighten = ['--tighten-bare', 'nx', '>=22.7.9 <23']

  it('tightens the placing rule pin in place instead of writing a bare key', () => {
    expect(manifestAfter(PLACED, tighten).overrides).toEqual({
      lerna: { nx: '>=22.7.9 <23', chalk: '^6.0.0' },
      glob: '^13.0.0',
    })
  })

  it('tightens the "." pin of an object rule in place', () => {
    const objectRule = manifestEdit((manifest) => {
      ;((manifest.overrides as Json).lerna as Json).nx = { '.': '>=22.7.7 <23', minimist: '^1' }
    })
    expect(answer(PLACED, tighten, objectRule).written).toEqual([
      { parent: null, path: ['overrides', 'lerna', 'nx', '.'], value: '>=22.7.9 <23' },
    ])
  })

  it('refuses when the placing rule carries no pin on this line', () => {
    const offLine = manifestEdit((manifest) => {
      ;((manifest.overrides as Json).lerna as Json).nx = '>=21.0.0 <22'
    })
    expect(refusalOf(PLACED, tighten, offLine)).toBe(
      `apply_constraint: --tighten-bare cannot reach 'nx': its copies are placed by pre-existing override rule(s) ["overrides.lerna.nx"], none of which carries a pin on this line to tighten, and a top-level bare key never matches an override-placed copy (issue #147) ${DASH} writing one would be silently inert. Nothing was written; reconcile the existing override by hand.`,
    )
  })

  it('also writes the covering top-level key when normal copies exist', () => {
    const foo = lockEdit((packages) => {
      ;((packages[''] as Json).dependencies as Json).foo = '^1.0.0'
      packages['node_modules/foo'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
      packages['node_modules/foo/node_modules/nx'] = {
        version: '22.7.5',
        dependencies: { 'brace-expansion': '^5.0.4' },
      }
    })
    const { envelope, dir } = apply(PLACED, tighten, foo)
    expect({
      paths: answerOf(envelope).written.map(({ path }) => path),
      overrides: readJson(dir, 'package.json').overrides,
    }).toEqual({
      paths: [
        ['overrides', 'lerna', 'nx'],
        ['overrides', 'nx'],
      ],
      overrides: {
        lerna: { nx: '>=22.7.9 <23', chalk: '^6.0.0' },
        glob: '^13.0.0',
        nx: '>=22.7.9 <23',
      },
    })
  })
})

describe('the override block that the call cannot read', () => {
  it.each([
    [
      'npm overrides that is a text',
      PLACED,
      nx,
      manifestEdit((manifest) => {
        manifest.overrides = 'oops'
      }),
      "apply_constraint: 'overrides' in package.json is a string, not an object of override entries. Refusing to merge a constraint into a block this script cannot read.",
    ],
    [
      'resolutions that is a list',
      'yarn-berry',
      LODASH,
      manifestEdit((manifest) => {
        manifest.resolutions = []
      }),
      "apply_constraint: 'resolutions' in package.json is a array, not an object of override entries. Refusing to merge a constraint into a block this script cannot read.",
    ],
    [
      'a pnpm field that is a text',
      'pnpm-v9',
      LODASH,
      manifestEdit((manifest) => {
        manifest.pnpm = 'x'
      }),
      "apply_constraint: the container holding 'pnpm.overrides' in package.json is not an object, so the override block cannot be read. Refusing to merge a constraint into a manifest this script cannot read.",
    ],
    [
      'a manifest that holds no document',
      'npm-v3',
      LODASH,
      (dir: string) => writeFileSync(join(dir, 'package.json'), '\n'),
      "apply_constraint: 'overrides' in package.json is a , not an object of override entries. Refusing to merge a constraint into a block this script cannot read.",
    ],
    [
      'a manifest that is not JSON',
      'npm-v3',
      LODASH,
      (dir: string) => writeFileSync(join(dir, 'package.json'), '{ not json\n'),
      'apply_constraint: cannot read package.json',
    ],
  ])('refuses %s, writing nothing', (_title, fixture, args, setup, error) => {
    expect(refusalOf(fixture, args, setup)).toBe(error)
  })
})

describe('a dependency reached through an npm: alias', () => {
  const lodash = ['lodash', '>=4.18.2 <5']
  const vulnerable: ValidateOptions = {
    line: '4',
    vulnerable: ['>= 4.18.0, < 4.18.2'],
    baseline: null,
    siblingAlerts: null,
  }
  const stillVulnerable = (dir: string): string[] => {
    const verdict = node.validate(treeAt(dir), 'lodash', '>=4.18.2 <5', vulnerable)
    if (verdict.outcome !== 'ok') throw new Error(verdict.error)
    return verdict.value.unresolved_alerts.map(({ path }) => path)
  }
  const aliasPaths = ({ written }: ApplyConstraintAnswer) =>
    written
      .filter(({ value }) => typeof value === 'string' && value.startsWith('npm:'))
      .map(({ path }) => path)

  it('writes the alias key, with the protocol, under the parent that declared it', () => {
    const overrides = manifestAfter('npm-alias', [...lodash, 'alias-parent', 'dupe-parent'])
      .overrides as Json
    expect({ aliased: overrides['alias-parent'], plain: overrides['dupe-parent'] }).toEqual({
      aliased: { 'lodash-alias': 'npm:lodash@>=4.18.2 <5' },
      plain: { lodash: '>=4.18.2 <5' },
    })
  })

  // The chain of the spec: the copy that validate flags is the copy that
  // the alias key governs, and the stale pass removes it.
  it('governs the aliased copy validate flags, with no node_modules to read', () => {
    const dir = copyOf('npm-alias')
    const flagged = stillVulnerable(dir)
    const result = answerOf(
      node.applyConstraint(treeAt(dir), requestOf([...lodash, 'alias-parent', 'dupe-parent'])),
    )
    expect({
      flagged,
      wrote: aliasPaths(result),
      invalidated: result.lockfile_invalidated.keys,
    }).toEqual({
      flagged: ['node_modules/lodash-alias'],
      wrote: [['overrides', 'alias-parent', 'lodash-alias']],
      invalidated: [
        'node_modules/dupe-parent/node_modules/lodash',
        'node_modules/lodash',
        'node_modules/lodash-alias',
      ],
    })
  })

  it('does the same for a Yarn Berry parent that declares through npm:', () => {
    const dir = copyOf('yarn-berry-alias-parent')
    const result = answerOf(node.applyConstraint(treeAt(dir), requestOf([...lodash, 'express'])))
    expect({ wrote: aliasPaths(result), still_vulnerable: stillVulnerable(dir) }).toEqual({
      wrote: [['resolutions', 'express/lodash-alias']],
      still_vulnerable: ['lodash-alias@npm:lodash@4.18.1'],
    })
  })

  it('reports the key and value it actually wrote', () => {
    expect(answer('npm-alias', [...lodash, 'alias-parent']).written).toEqual([
      {
        parent: 'alias-parent',
        path: ['overrides', 'alias-parent', 'lodash-alias'],
        value: 'npm:lodash@>=4.18.2 <5',
      },
    ])
  })

  it.each([
    [
      'names every parent whose declaration it could not read, and why',
      'pnpm-v9',
      ['lodash', '>=4.17.25 <5', 'express', 'koa'],
      { source: 'unsupported', parents_unresolved: ['express', 'koa'] },
    ],
    [
      'resolves every parent where a declaration source exists',
      'npm-alias',
      [...lodash, 'alias-parent'],
      { source: 'lockfile', parents_unresolved: [] },
    ],
    [
      'names a parent that the lockfile holds no declaration for',
      'npm-alias',
      [...lodash, 'nobody'],
      { source: 'lockfile', parents_unresolved: ['nobody'] },
    ],
  ])('%s', (_title, fixture, args, lookup) => {
    expect(answer(fixture, args).alias_lookup).toEqual(lookup)
  })

  it('scopes to a Yarn Berry parent that declares the package as a peer', () => {
    expect(
      answer('yarn-berry-peer-parent', ['sha.js', '>=2.4.12 <3', 'serve-static']).written,
    ).toEqual([
      {
        parent: 'serve-static',
        path: ['resolutions', 'serve-static/sha.js'],
        value: '>=2.4.12 <3',
      },
    ])
  })

  // ADR 001: the write path cannot tell the two senses of the name apart.
  it('writes an npm: value naming a different package when the name collides', () => {
    expect(aliasPaths(answer('npm-dual-name', LODASH))).toEqual([['dependencies', 'lodash']])
    expect(answer('npm-dual-name', LODASH).written[0]?.value).toBe('npm:underscore@^4.17.21')
  })

  it('retargets a root alias declaration without dropping the protocol', () => {
    const dependencies = manifestAfter('npm-alias', lodash).dependencies as Json
    expect({ plain: dependencies.lodash, aliased: dependencies['lodash-alias'] }).toEqual({
      plain: '^4.18.2',
      aliased: 'npm:lodash@^4.18.2',
    })
  })

  it('keeps the protocol when the alias key itself is the named package', () => {
    expect(
      (manifestAfter('npm-alias', ['lodash-alias', '>=4.18.2 <5']).dependencies as Json)[
        'lodash-alias'
      ],
    ).toBe('npm:lodash@^4.18.2')
  })
})

describe('existing entries are merged, never replaced', () => {
  it('preserves unrelated pnpm overrides', () => {
    const overrides = pnpmOverrides(manifestAfter('pnpm-v9', ['undici', '>=6.19.0 <7', 'express']))
    expect({
      lodash: overrides.lodash,
      scoped: overrides['express>sha.js'],
      versioned: overrides['handlebars@4'],
    }).toEqual({ lodash: '>=4.17.21', scoped: '>=2.4.11 <3', versioned: '^4.7.9' })
  })

  it('preserves both flat and nested npm overrides', () => {
    const overrides = manifestAfter('npm-v3', ['undici', '>=6.19.0 <7', 'glob']).overrides as Json
    expect({ flat: overrides.lodash, nested: overrides['test-exclude'] }).toEqual({
      flat: '^4.17.21',
      nested: { lodash: '3.10.1' },
    })
  })
})

describe('direct dependencies match the manifest version style', () => {
  it.each([
    ['yarn-berry', 'vitest', '4.1.0'],
    ['pnpm-v9', 'vitest', '^4.1.0'],
  ])('writes the style of %s', (fixture, pkg, value) => {
    expect((manifestAfter(fixture, [pkg, '>=4.1.0 <5']).devDependencies as Json)[pkg]).toBe(value)
  })

  it('updates a direct runtime dependency in place', () => {
    expect((manifestAfter('npm-v3', ['express', '>=4.19.0 <5']).dependencies as Json).express).toBe(
      '^4.19.0',
    )
  })

  it.each([
    ['~4.17.0', '>=4.17.21 <5', '~4.17.21'],
    ['>=4', '>=4.17.21 <5', '>=4.17.21 <5'],
    ['4.17.0', '>=', null],
    ['^4.17.0', '>=', '^'],
    ['npm:lodash', '>=4.17.21 <5', 'npm:lodash@>=4.17.21 <5'],
  ])('retargets %j for the range %j as %j', (declared, range, value) => {
    const declare = manifestEdit((manifest) => {
      ;(manifest.dependencies as Json).lodash = declared
    })
    expect((manifestAfter('npm-v3', ['lodash', range], declare).dependencies as Json).lodash).toBe(
      value,
    )
  })

  it('reports the mode it took', () => {
    const { mode, parents } = answer('pnpm-v9', ['undici', '>=6.19.0 <7', 'express'])
    expect({ mode, parents }).toEqual({ mode: 'scoped', parents: ['express'] })
  })
})

describe('observations flag pre-existing unscoped overrides', () => {
  const keys = (fixture: string, args: readonly string[]) =>
    answer(fixture, args)
      .observations.flatMap((each) => (each.type === 'unscoped_override' ? [each.key] : []))
      .sort()

  it.each([
    [
      'lists bare pnpm overrides and ignores scoped ones',
      'pnpm-v9',
      'express',
      ['handlebars@4', 'lodash'],
    ],
    [
      'treats a scoped package name as bare, not as parent/dep',
      'yarn-berry',
      'express',
      ['@babel/core'],
    ],
    ['ignores npm nested overrides, whose values are objects', 'npm-v3', 'glob', ['lodash']],
  ])('%s', (_title, fixture, parent, expected) => {
    expect(keys(fixture, ['undici', '>=6.19.0 <7', parent])).toEqual(expected)
  })

  it('marks an override that targets the package being fixed', () => {
    const { observations } = answer('pnpm-v9', [...LODASH, 'express'])
    expect(
      observations.flatMap((each) =>
        each.type === 'unscoped_override' && each.targets_this_package ? [each.key] : [],
      ),
    ).toEqual(['lodash'])
  })
})

describe('--tighten-bare escalation', () => {
  it('raises the bare entry to satisfy the constraint, in its own mode', () => {
    const { envelope, dir } = apply('pnpm-v9', ['--tighten-bare', 'lodash', '>=4.17.25 <5'])
    const { mode, parents, written } = answerOf(envelope)
    expect({
      lodash: pnpmOverrides(readJson(dir, 'package.json')).lodash,
      mode,
      parents,
      written,
    }).toEqual({
      lodash: '>=4.17.25 <5',
      mode: 'tighten-bare',
      parents: [],
      written: [{ parent: null, path: ['pnpm', 'overrides', 'lodash'], value: '>=4.17.25 <5' }],
    })
  })

  it.each([
    [
      'tightens every qualified key on the target line, leaving other lines alone',
      ['protobufjs', '>=8.6.6 <9'],
      {
        'protobufjs@7': '^7.5.5',
        'protobufjs@8': '>=8.6.6 <9',
        'protobufjs@^8.0.0': '>=8.6.6 <9',
        tar: '^5.0.0',
        'tar@6': '^6.2.0',
      },
    ],
    [
      'tightens a coexisting plain key together with its qualified sibling',
      ['tar', '>=6.2.4 <7'],
      {
        'protobufjs@7': '^7.5.5',
        'protobufjs@8': '^8.0.1',
        'protobufjs@^8.0.0': '^8.0.0',
        tar: '>=6.2.4 <7',
        'tar@6': '>=6.2.4 <7',
      },
    ],
  ])('%s', (_title, args, overrides) => {
    expect(
      pnpmOverrides(manifestAfter('pnpm-major-qualified', ['--tighten-bare', ...args])),
    ).toEqual(overrides)
  })

  it('reports every key it tightened, and adds no plain key', () => {
    const { envelope, dir } = apply('pnpm-major-qualified', [
      '--tighten-bare',
      'protobufjs',
      '>=8.6.6 <9',
    ])
    expect({
      written: answerOf(envelope).written,
      plain: Object.hasOwn(pnpmOverrides(readJson(dir, 'package.json')), 'protobufjs'),
    }).toEqual({
      written: [
        { parent: null, path: ['pnpm', 'overrides', 'protobufjs@8'], value: '>=8.6.6 <9' },
        { parent: null, path: ['pnpm', 'overrides', 'protobufjs@^8.0.0'], value: '>=8.6.6 <9' },
      ],
      plain: false,
    })
  })

  it('tightens a lone major-qualified key (handlebars@4) in place', () => {
    const overrides = pnpmOverrides(
      manifestAfter('pnpm-v9', ['--tighten-bare', 'handlebars', '>=4.7.10 <5']),
    )
    expect({
      qualified: overrides['handlebars@4'],
      has_plain: Object.hasOwn(overrides, 'handlebars'),
    }).toEqual({
      qualified: '>=4.7.10 <5',
      has_plain: false,
    })
  })

  describe('parent-scoped pnpm keys are never matched', () => {
    it('leaves vite@7>rollup alone and writes the plain vite key', () => {
      const { envelope, dir } = apply('pnpm-pins', ['--tighten-bare', 'vite', '>=7.1.5 <8'])
      expect({
        overrides: pnpmOverrides(readJson(dir, 'package.json')),
        written: answerOf(envelope).written,
      }).toEqual({
        overrides: {
          '@babel/core': '^7.24.0',
          'vite@7>rollup': '^4.20.0',
          'webpack>terser-webpack-plugin>terser': '^5.31.6',
          '@vercel/fun>undici': '>=6.19.0 <7',
          esbuild: 'npm:esbuild-wasm@0.21.5',
          'protobufjs@^8.0.0>lodash': '^4.17.21',
          vite: '>=7.1.5 <8',
        },
        written: [{ parent: null, path: ['pnpm', 'overrides', 'vite'], value: '>=7.1.5 <8' }],
      })
    })

    it('excludes a dotted-selector parent key (protobufjs@^8.0.0>lodash) too', () => {
      const overrides = pnpmOverrides(
        manifestAfter('pnpm-pins', ['--tighten-bare', 'protobufjs', '>=8.6.6 <9']),
      )
      expect({
        scoped: overrides['protobufjs@^8.0.0>lodash'],
        plain: overrides.protobufjs,
      }).toEqual({
        scoped: '^4.17.21',
        plain: '>=8.6.6 <9',
      })
    })
  })

  describe('yarn resolutions', () => {
    const YARN = 'yarn-major-qualified'

    it('tightens a descriptor-qualified bare key in place, and reports it', () => {
      const { envelope, dir } = apply(YARN, ['--tighten-bare', 'protobufjs', '>=8.6.6 <9'])
      expect({
        resolutions: readJson(dir, 'package.json').resolutions,
        written: answerOf(envelope).written,
      }).toEqual({
        resolutions: {
          'protobufjs@^8': '>=8.6.6 <9',
          'protobufjs@7': '^7.5.5',
          'lodash@^3/minimist': '^1.2.6',
          '@grpc/grpc-js@1': '^1.8.0',
        },
        written: [{ parent: null, path: ['resolutions', 'protobufjs@^8'], value: '>=8.6.6 <9' }],
      })
    })

    it('matches a qualified key on a scoped package name', () => {
      const resolutions = manifestAfter(YARN, ['--tighten-bare', '@grpc/grpc-js', '>=1.8.22 <2'])
        .resolutions as Json
      expect({
        qualified: resolutions['@grpc/grpc-js@1'],
        has_plain: Object.hasOwn(resolutions, '@grpc/grpc-js'),
      }).toEqual({ qualified: '>=1.8.22 <2', has_plain: false })
    })

    it('never matches a path-scoped key, writing the plain key instead', () => {
      const resolutions = manifestAfter(YARN, ['--tighten-bare', 'minimist', '>=1.2.8 <2'])
        .resolutions as Json
      expect({ scoped: resolutions['lodash@^3/minimist'], plain: resolutions.minimist }).toEqual({
        scoped: '^1.2.6',
        plain: '>=1.2.8 <2',
      })
    })

    it('still writes the plain key when nothing covers the package', () => {
      expect(answer(YARN, ['--tighten-bare', 'left-pad', '>=1.3.1 <2']).written).toEqual([
        { parent: null, path: ['resolutions', 'left-pad'], value: '>=1.3.1 <2' },
      ])
    })
  })

  describe('npm overrides', () => {
    const NPM = 'npm-major-qualified'

    it('tightens the qualified key on the target line only, and reports it', () => {
      const { envelope, dir } = apply(NPM, ['--tighten-bare', 'minimist', '>=1.2.8 <2'])
      expect({
        overrides: readJson(dir, 'package.json').overrides,
        written: answerOf(envelope).written,
      }).toEqual({
        overrides: {
          'minimist@1': '>=1.2.8 <2',
          'minimist@0': '^0.2.4',
          glob: { minimatch: '^9.0.5' },
        },
        written: [{ parent: null, path: ['overrides', 'minimist@1'], value: '>=1.2.8 <2' }],
      })
    })

    it('still writes the plain key when nothing covers the package', () => {
      expect(manifestAfter(NPM, ['--tighten-bare', 'lodash', '>=4.17.21 <5']).overrides).toEqual({
        'minimist@1': '^1.2.5',
        'minimist@0': '^0.2.4',
        glob: { minimatch: '^9.0.5' },
        lodash: '>=4.17.21 <5',
      })
    })

    it.each([
      [
        'a bare major',
        'protobufjs@8',
        '^8.0.0',
        'protobufjs',
        '>=8.6.6 <9',
        { 'protobufjs@8': '>=8.6.6 <9' },
      ],
      [
        'a caret',
        'protobufjs@^8.0.1',
        '^8.0.1',
        'protobufjs',
        '>=8.6.6 <9',
        { 'protobufjs@^8.0.1': '>=8.6.6 <9' },
      ],
      [
        'a spaced range',
        'protobufjs@>=8 <9',
        '>=8 <9',
        'protobufjs',
        '>=8.6.6 <9',
        { 'protobufjs@>=8 <9': '>=8.6.6 <9' },
      ],
      [
        'a dist-tag',
        'protobufjs@beta',
        'beta',
        'protobufjs',
        '>=8.6.6 <9',
        { 'protobufjs@beta': 'beta', protobufjs: '>=8.6.6 <9' },
      ],
      [
        'a scoped name',
        '@grpc/grpc-js@1',
        '^1.7.0',
        '@grpc/grpc-js',
        '>=1.8.22 <2',
        { '@grpc/grpc-js@1': '>=1.8.22 <2' },
      ],
      [
        'a name that a later @ splits',
        'protobufjs@8@x',
        '^8.0.0',
        'protobufjs',
        '>=8.6.6 <9',
        { 'protobufjs@8@x': '^8.0.0', protobufjs: '>=8.6.6 <9' },
      ],
    ])('handles %s selector', (_shape, key, value, pkg, range, overrides) => {
      const seed = rule({ [key]: value })
      expect(manifestAfter(NPM, ['--tighten-bare', pkg, range], seed).overrides).toEqual(overrides)
    })
  })
})

describe('a stale npm lockfile entry is invalidated with the override', () => {
  const STALE = 'npm-stale-nested'
  const line1: ValidateOptions = {
    line: '1',
    vulnerable: ['< 1.18.0'],
    baseline: null,
    siblingAlerts: null,
  }
  const verdict = (dir: string) => {
    const result = node.validate(treeAt(dir), 'axios', '>=1.18.0 <2', line1)
    if (result.outcome !== 'ok') throw new Error(result.error)
    return {
      ok: result.value.ok,
      unresolved: result.value.unresolved_alerts.map(({ path }) => path),
    }
  }
  const versions = (dir: string): string[] => {
    const result = node.resolvedVersions(treeAt(dir), 'axios')
    if (result.outcome !== 'ok') throw new Error(result.error)
    return result.value.versions.map(({ version }) => version).sort()
  }
  const lockBytes = (fixture: string) => textAt(join(FIXTURES_ROOT, fixture), 'package-lock.json')

  it.each([
    [
      'deletes the locked stale copy on the target line, and only it',
      ['axios', '>=1.18.0 <2', 'nx'],
      {
        performed: true,
        keys: ['node_modules/nx/node_modules/axios'],
      },
    ],
    [
      'reports the pass ran and found nothing stale when the copy satisfies',
      ['axios', '>=1.16.0 <2', 'nx'],
      {
        performed: true,
        keys: [],
      },
    ],
    [
      'performs no invalidation for a direct dependency bump',
      ['axios', '>=1.18.0 <2'],
      { performed: false, keys: [] },
    ],
    [
      'scopes the deletion to the range floor major: a 0.x fix touches no 1.x copy',
      ['axios', '>=0.21.7 <1', 'localtunnel'],
      {
        performed: true,
        keys: ['node_modules/localtunnel/node_modules/axios'],
      },
    ],
    [
      'fails closed with a reason on a range whose floor it cannot read',
      ['axios', 'latest', 'nx'],
      {
        performed: false,
        keys: [],
        reason: 'unreadable_range_floor',
      },
    ],
  ])('%s', (_title, args, invalidated) => {
    expect(answer(STALE, args).lockfile_invalidated).toEqual(invalidated)
  })

  it('fails validate on the stale locked copy before the fix, and passes after it', () => {
    const dir = copyOf(STALE)
    const before = verdict(dir)
    answerOf(node.applyConstraint(treeAt(dir), requestOf(['axios', '>=1.18.0 <2', 'nx'])))
    expect({ before, after: verdict(dir), versions: versions(dir) }).toEqual({
      before: { ok: false, unresolved: ['node_modules/nx/node_modules/axios'] },
      after: { ok: true, unresolved: [] },
      versions: ['0.21.4', '1.18.1'],
    })
  })

  it('retains both 1.x resolutions after the 0.x fix', () => {
    const { dir } = apply(STALE, ['axios', '>=0.21.7 <1', 'localtunnel'])
    expect(versions(dir)).toEqual(['1.16.0', '1.18.1'])
  })

  it.each([
    ['nothing is stale', ['axios', '>=1.16.0 <2', 'nx']],
    ['the call is a direct dependency bump', ['axios', '>=1.18.0 <2']],
    ['the floor is unreadable', ['axios', 'latest', 'nx']],
  ])('leaves the lockfile byte-identical when %s', (_when, args) => {
    const { dir } = apply(STALE, args)
    expect(textAt(dir, 'package-lock.json')).toBe(lockBytes(STALE))
  })

  it('still writes the override the reason declares inert on an unreadable floor', () => {
    expect((manifestAfter(STALE, ['axios', 'latest', 'nx']).overrides as Json).nx).toEqual({
      axios: 'latest',
    })
  })

  it('fails closed with a reason on a v1 lockfile, writes the override, and keeps the lockfile', () => {
    const { envelope, dir } = apply('npm-v1', ['axios', '>=0.21.7 <1', 'localtunnel'])
    expect({
      invalidated: answerOf(envelope).lockfile_invalidated,
      override: (readJson(dir, 'package.json').overrides as Json).localtunnel,
      lockfile: textAt(dir, 'package-lock.json') === lockBytes('npm-v1'),
    }).toEqual({
      invalidated: { performed: false, keys: [], reason: 'no_packages_object' },
      override: { axios: '>=0.21.7 <1' },
      lockfile: true,
    })
  })

  it('leaves workspace link entries in place and out of keys[]', () => {
    const { envelope, dir } = apply('npm-workspaces', ['lodash', '>=4.18.0 <5', 'express'])
    const packages = readJson(dir, 'package-lock.json').packages as Json
    expect({
      invalidated: answerOf(envelope).lockfile_invalidated,
      links: Object.entries(packages)
        .filter(([, entry]) => (entry as Json).link === true)
        .map(([key]) => key)
        .sort(),
    }).toEqual({
      invalidated: { performed: true, keys: ['node_modules/lodash'] },
      links: [
        'node_modules/@demo/alpha',
        'node_modules/@demo/beta',
        'node_modules/@demo/delta',
        'node_modules/@demo/epsilon',
        'node_modules/@demo/gamma',
        'node_modules/@demo/zeta',
      ],
    })
  })

  it.each([
    ['pnpm-v9', ['undici', '>=6.19.0 <7', 'express']],
    ['yarn-berry', ['undici', '>=6.19.0 <7', '@vercel/fun']],
  ])('reports not-performed for %s', (fixture, args) => {
    expect(answer(fixture, args).lockfile_invalidated).toEqual({ performed: false, keys: [] })
  })
})

describe('the override block of a manifest that has none', () => {
  it('does not create an empty override block for a direct update', () => {
    const manifest = manifestAfter('no-overrides', LODASH)
    expect({
      has: Object.hasOwn(manifest, 'resolutions'),
      lodash: (manifest.dependencies as Json).lodash,
    }).toEqual({
      has: false,
      lodash: '^4.17.21',
    })
  })

  it('creates the override block when the manifest has none', () => {
    const manifest = manifestAfter('yarn-berry', ['brand-new-pkg', '>=1.0.0 <2', 'some-parent'])
    expect((manifest.resolutions as Json)['some-parent/brand-new-pkg']).toBe('>=1.0.0 <2')
  })
})

describe('apply_constraint pnpm override file routing (issue #159)', () => {
  const workspaceText = (dir: string) => textAt(dir, 'pnpm-workspace.yaml')
  const pinKeys = (dir: string): string[] => {
    const pins = node.listPins(treeAt(dir))
    if (pins.outcome !== 'ok') throw new Error(pins.error)
    return pins.value.pins.map(({ key }) => key).sort()
  }
  const pnpm11 = manifestEdit((manifest) => {
    manifest.packageManager = 'pnpm@11.9.0'
  })

  it('writes the scoped keys into the workspace overrides block on pnpm 11, and reports the file', () => {
    const { envelope, dir } = apply(PNPM11, [...BRACE, 'minimatch'])
    const result = answerOf(envelope)
    expect({
      line: workspaceText(dir)
        .split('\n')
        .filter((line) => line === "  'minimatch@10.2.5>brace-expansion': '>=5.0.9 <6'").length,
      override_file: result.override_file,
      keys: result.written.map(({ path }) => path.join('.')).sort(),
      pins: pinKeys(dir),
      pnpm: Object.hasOwn(readJson(dir, 'package.json'), 'pnpm'),
    }).toEqual({
      line: 1,
      override_file: 'pnpm-workspace.yaml',
      keys: [
        'pnpm.overrides.minimatch@10.0.3>brace-expansion',
        'pnpm.overrides.minimatch@10.2.5>brace-expansion',
      ],
      pins: [
        'form-data',
        'js-yaml',
        'minimatch@10.0.3>brace-expansion',
        'minimatch@10.2.5>brace-expansion',
        'undici',
        'ws',
      ],
      pnpm: false,
    })
  })

  it('creates pnpm-workspace.yaml with the block on a pnpm 11 repo that has none', () => {
    const { dir } = apply('pnpm-cross-line', [...BRACE, 'minimatch'], pnpm11)
    expect({ text: workspaceText(dir), pins: pinKeys(dir) }).toEqual({
      text: "overrides:\n  'minimatch@10.0.3>brace-expansion': '>=5.0.9 <6'\n  'minimatch@10.2.5>brace-expansion': '>=5.0.9 <6'\n",
      pins: ['minimatch@10.0.3>brace-expansion', 'minimatch@10.2.5>brace-expansion'],
    })
  })

  it('still writes package.json pnpm.overrides on pnpm 10 with no workspace block', () => {
    const { dir } = apply('pnpm-cross-line', [...BRACE, 'minimatch'])
    expect({
      keys: sortedKeys(pnpmOverrides(readJson(dir, 'package.json'))),
      workspace: readOptional(dir, 'pnpm-workspace.yaml'),
    }).toEqual({
      keys: ['minimatch@10.0.3>brace-expansion', 'minimatch@10.2.5>brace-expansion'],
      workspace: null,
    })
  })

  it('passes every untouched workspace line through byte for byte, and leaves package.json as it is', () => {
    const { dir } = apply(PNPM11, [...BRACE, 'minimatch'])
    const fixture = join(FIXTURES_ROOT, PNPM11)
    expect({
      rest: workspaceText(dir)
        .split('\n')
        .filter((line) => !line.includes('brace-expansion'))
        .join('\n'),
      manifest: textAt(dir, 'package.json'),
    }).toEqual({
      rest: textAt(fixture, 'pnpm-workspace.yaml'),
      manifest: textAt(fixture, 'package.json'),
    })
  })

  it.each([
    ['a nested map', 'overrides:\n  jest:\n    ws: 1\n', 'cannot safely read the block'],
    ['duplicate keys', 'overrides:\n  ws: 1\n  ws: 2\n', 'duplicate keys'],
    [
      'adjacent duplicate top-level blocks',
      'overrides:\n  ws: 1\noverrides:\n  undici: 2\n',
      'duplicate top-level overrides',
    ],
    ['a quoted top-level key', "'overrides':\n  ws: '1'\n", 'quoted top-level overrides'],
    [
      'an inline comment',
      "overrides:\n  undici: '>=6.23.0' # keep until the bump\n",
      'inline comment',
    ],
    ['a flow-style overrides value', 'overrides: {ws: 1}\n', 'flow-style'],
    ['a block-scalar value', 'overrides:\n  ws: |\n    x\n', 'block-scalar'],
    ['an anchor value', 'overrides:\n  ws: &a x\n', 'anchor'],
    ['an alias value', 'overrides:\n  ws: *a\n', 'anchor'],
    ['an unclosed quoted key', "overrides:\n  'ws: 1\n", 'never closes'],
    ['a deeper-indented line', "overrides:\n    ws: '1'\n", 'two spaces'],
    ['a backslash-escaped scalar', 'overrides:\n  ws: ">=1\\.0"\n', 'backslash'],
    ['an offending line 3', "overrides:\n  ws: '1'\n  jest:\n    x: 1\n", 'line 3'],
  ])('refuses %s, writing nothing', (_title, text, words) => {
    const error = refusalOf(PNPM11, [...BRACE, 'minimatch'], workspaceFile(text))
    expect(error).toContain(words)
    expect(error).not.toContain('cannot merge')
  })

  it('tolerates a tab outside the overrides block', () => {
    const tab = workspaceFile(
      "packages:\n  - packages/*\t# tab here\noverrides:\n  ws: '>=8.17.1'\n",
    )
    const { dir } = apply(PNPM11, [...BRACE, 'minimatch'], tab)
    expect(workspaceText(dir)).toContain("  'minimatch@10.2.5>brace-expansion': '>=5.0.9 <6'\n")
  })

  // The expected text is the file that node.sh wrote for the same copy.
  it('leaves a key of the same name outside the overrides block as it is', () => {
    const catalog = workspaceFile(
      "catalog:\n  undici: ^6.0.0\n\npackages:\n  - packages/*\n\noverrides:\n  undici: '>=6.23.0'\n  ws: '>=8.17.1'\n",
    )
    const { dir } = apply(PNPM11, ['undici', '>=6.24.0 <7'], catalog)
    expect(workspaceText(dir)).toBe(
      "catalog:\n  undici: ^6.0.0\n\npackages:\n  - packages/*\n\noverrides:\n  'undici': '>=6.24.0 <7'\n  ws: '>=8.17.1'\n",
    )
  })

  it('tightens a pre-existing workspace key for the same package in place, exactly once', () => {
    const seeded = workspaceFile("overrides:\n  'minimatch@10.2.5>brace-expansion': '>=5.0.0'\n")
    const { dir } = apply(PNPM11, [...BRACE, 'minimatch'], seeded)
    expect(workspaceText(dir)).toBe(
      "overrides:\n  'minimatch@10.2.5>brace-expansion': '>=5.0.9 <6'\n  'minimatch@10.0.3>brace-expansion': '>=5.0.9 <6'\n",
    )
  })

  it('does not copy dead manifest pnpm.overrides, and restores the pnpm field with its siblings', () => {
    const dead = manifestEdit((manifest) => {
      manifest.pnpm = {
        overrides: { 'brace-expansion': '>=1.0.0' },
        onlyBuiltDependencies: ['esbuild'],
      }
    })
    const { envelope, dir } = apply(PNPM11, [...BRACE, 'minimatch'], dead)
    expect({
      copied: workspaceText(dir).includes("  'brace-expansion':"),
      pnpm: readJson(dir, 'package.json').pnpm,
      observations: answerOf(envelope).observations.filter(
        ({ type }) => type === 'manifest_pnpm_overrides_ignored',
      ),
    }).toEqual({
      copied: false,
      pnpm: { overrides: { 'brace-expansion': '>=1.0.0' }, onlyBuiltDependencies: ['esbuild'] },
      observations: [
        { type: 'manifest_pnpm_overrides_ignored', keys: ['brace-expansion'], pnpm_major: 11 },
      ],
    })
  })

  it('observes dual live override sources on pnpm 10 with a workspace block', () => {
    const pnpm10 = manifestEdit((manifest) => {
      manifest.packageManager = 'pnpm@10.33.2'
      manifest.pnpm = { overrides: { undici: '<5' } }
    })
    expect(
      answer(PNPM11, [...BRACE, 'minimatch'], pnpm10).observations.filter(
        ({ type }) => type === 'manifest_pnpm_overrides_ignored',
      ),
    ).toEqual([{ type: 'manifest_pnpm_overrides_ignored', keys: ['undici'], pnpm_major: 10 }])
  })

  it('observes an unknown pnpm major when packageManager does not pin pnpm', () => {
    const unpinned = manifestEdit((manifest) => {
      delete manifest.packageManager
    })
    const { override_file, observations } = answer(
      'pnpm-cross-line',
      [...BRACE, 'minimatch'],
      unpinned,
    )
    expect({
      override_file,
      unknown: observations.filter(({ type }) => type === 'pnpm_major_unknown').length,
    }).toEqual({
      override_file: 'package.json',
      unknown: 1,
    })
  })

  it('appends the block to a workspace file lacking a trailing newline', () => {
    const { dir } = apply(
      PNPM11,
      [...BRACE, 'minimatch'],
      workspaceFile('packages:\n  - packages/*'),
    )
    expect({ text: workspaceText(dir), pins: pinKeys(dir) }).toEqual({
      text: "packages:\n  - packages/*\noverrides:\n  'minimatch@10.0.3>brace-expansion': '>=5.0.9 <6'\n  'minimatch@10.2.5>brace-expansion': '>=5.0.9 <6'\n",
      pins: ['minimatch@10.0.3>brace-expansion', 'minimatch@10.2.5>brace-expansion'],
    })
  })
})

// Routes of the bash that no spec example takes. Each expected value is the
// answer of node.sh on the same copy, read by hand from its output.
describe('the routes that no spec example takes', () => {
  it('writes a bare override for a root key that only optionalDependencies declares', () => {
    const optional = manifestEdit((manifest) => {
      manifest.optionalDependencies = { lodash: '^4.17.0' }
      delete (manifest.dependencies as Json).lodash
    })
    expect(answer('npm-v3', LODASH, optional).written).toEqual([
      { parent: null, path: ['overrides', 'lodash'], value: '>=4.17.21 <5' },
    ])
  })

  it('writes the alias value for an alias key that only peerDependencies declares', () => {
    const peer = manifestEdit((manifest) => {
      manifest.peerDependencies = { 'l-alias': 'npm:lodash@^4.17.0' }
    })
    expect(answer('npm-v3', LODASH, peer).written).toEqual([
      { parent: null, path: ['overrides', 'l-alias'], value: 'npm:lodash@>=4.17.21 <5' },
      { parent: null, path: ['dependencies', 'lodash'], value: '^4.17.21' },
    ])
  })

  it('writes a bare override for a package that the root does not declare', () => {
    expect(answer('npm-v3', ['undici', '>=6.19.0 <7']).written).toEqual([
      { parent: null, path: ['overrides', 'undici'], value: '>=6.19.0 <7' },
    ])
  })

  it('replaces a text override of the parent with the nested object', () => {
    const text = manifestEdit((manifest) => {
      ;(manifest.overrides as Json).glob = '^1'
    })
    expect(
      (manifestAfter('npm-v3', ['undici', '>=6.19.0 <7', 'glob'], text).overrides as Json).glob,
    ).toEqual({ undici: '>=6.19.0 <7' })
  })

  it('refuses a number override of the parent, where jq cannot add the nested object', () => {
    const number = manifestEdit((manifest) => {
      ;(manifest.overrides as Json).glob = 5
    })
    expect(refusalOf('npm-v3', ['undici', '>=6.19.0 <7', 'glob'], number)).toBe(
      'apply_constraint: failed to rewrite package.json',
    )
  })

  it('keeps the other keys of a superseded bare pair', () => {
    const pair = manifestEdit((manifest) => {
      manifest.overrides = { minimatch: { 'brace-expansion': '>=5.0.6 <6', other: '1' } }
    })
    expect(manifestAfter('npm-cross-line', [...BRACE, 'minimatch'], pair).overrides).toEqual({
      minimatch: { other: '1' },
      'minimatch@^10.2.5': { 'brace-expansion': '>=5.0.9 <6' },
      'minimatch@10.0.3': { 'brace-expansion': '>=5.0.9 <6' },
    })
  })

  it('places past a declaration that is not a text, and one that resolves to no entry', () => {
    const odd = lockEdit((packages) => {
      const nxEntry = packages['node_modules/nx'] as Json
      nxEntry.dependencies = { ...(nxEntry.dependencies as Json), weird: 5, ghost: '^1' }
    })
    expect(answer(PLACED, nx, odd).written.map(({ path }) => path)).toEqual([
      ['overrides', 'lerna', 'nx', '.'],
      ['overrides', 'lerna', 'nx', 'brace-expansion'],
    ])
  })

  it('refuses a child copy with an empty version, where jq stops', () => {
    const empty = lockEdit((packages) => {
      ;(packages['node_modules/brace-expansion'] as Json).version = ''
    })
    expect(refusalOf(PLACED, nx, empty)).toBe('apply_constraint: cannot read package-lock.json')
  })

  it('reads no major from a child version that does not start with digits', () => {
    const odd = lockEdit((packages) => {
      ;(packages['node_modules/brace-expansion'] as Json).version = 'x.1'
    })
    expect(answer(PLACED, nx, odd).lockfile_invalidated).toEqual({ performed: true, keys: [] })
  })

  it('answers a direct bump on a lockfile that holds no document', () => {
    const empty: Setup = (dir) => writeFileSync(join(dir, 'package-lock.json'), '')
    expect(answer('npm-stale-nested', ['axios', '>=1.18.0 <2'], empty).written).toEqual([
      { parent: null, path: ['dependencies', 'axios'], value: '^1.18.0' },
    ])
  })

  // bash stops with jq's exit 2 there, on an empty `--argjson`: a declared
  // divergence of the exit status. Both sides write nothing.
  it('refuses a scoped call on a lockfile that holds no document, and writes nothing', () => {
    const empty: Setup = (dir) => writeFileSync(join(dir, 'package-lock.json'), '')
    expect(refusalOf('npm-stale-nested', ['axios', '>=1.18.0 <2', 'nx'], empty)).toBe(
      'apply_constraint: cannot read package-lock.json',
    )
  })
})

describe('more routes that no spec example takes', () => {
  const minimatch = [...BRACE, 'minimatch']

  it.each([
    [
      'a pnpm field that is a text, with a workspace block',
      manifestEdit((manifest) => {
        manifest.pnpm = 'x'
      }),
      "workspace_manifest_view: cannot merge the pnpm-workspace.yaml overrides into package.json's view (is package.json valid JSON?)",
    ],
    [
      'a manifest that holds no document, with a workspace block',
      (dir: string) => writeFileSync(join(dir, 'package.json'), '\n'),
      "apply_constraint: 'pnpm.overrides' in package.json is a , not an object of override entries. Refusing to merge a constraint into a block this script cannot read.",
    ],
    [
      'pnpm.overrides of package.json that is a text, with a workspace block',
      manifestEdit((manifest) => {
        manifest.pnpm = { overrides: 'x' }
      }),
      'apply_constraint: cannot read package.json',
    ],
  ])('refuses %s, writing nothing', (_title, setup, error) => {
    expect(refusalOf(PNPM11, minimatch, setup)).toBe(error)
  })

  it('refuses a parent copy whose child copy has no version, where jq stops', () => {
    const noVersion = lockEdit((packages) => {
      delete (packages['node_modules/nx/node_modules/axios'] as Json).version
    })
    expect(refusalOf('npm-stale-nested', ['axios', '>=1.18.0 <2', 'nx'], noVersion)).toBe(
      'apply_constraint: cannot read package-lock.json',
    )
  })

  it('never counts an entry with no version, or with no major, as stale', () => {
    const odd = lockEdit((packages) => {
      delete (packages['node_modules/nx/node_modules/axios'] as Json).version
      ;(packages['node_modules/localtunnel/node_modules/axios'] as Json).version = '-1'
    })
    const { written, lockfile_invalidated } = answer(
      'npm-stale-nested',
      ['--tighten-bare', 'axios', '>=1.18.0 <2'],
      odd,
    )
    expect({ written, lockfile_invalidated }).toEqual({
      written: [{ parent: null, path: ['overrides', 'axios'], value: '>=1.18.0 <2' }],
      lockfile_invalidated: { performed: true, keys: [] },
    })
  })

  // bash writes package.json, and then stops with jq's exit 2 on the empty
  // `--argjson` of its answer: a declared divergence of the exit status.
  // Both sides keep that write. A range with no floor major stops too.
  it.each([['>=6.19.0 <7'], ['<7']])(
    'writes the override %s, then refuses the stale pass on a lockfile that holds no document',
    (range) => {
      const { envelope, dir } = apply('npm-stale-nested', ['undici', range], (copy) =>
        writeFileSync(join(copy, 'package-lock.json'), ''),
      )
      expect({
        envelope,
        override: (readJson(dir, 'package.json').overrides as Json).undici,
      }).toEqual({
        envelope: { outcome: 'failed', error: 'apply_constraint: cannot read package-lock.json' },
        override: range,
      })
    },
  )

  it('walks a graph where two paths reach one copy', () => {
    const diamond = lockEdit((packages) => {
      ;((packages['node_modules/lerna'] as Json).dependencies as Json).baz = '^1.0.0'
      packages['node_modules/baz'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
    })
    expect(answer(PLACED, nx, diamond).written.map(({ path }) => path)).toEqual([
      ['overrides', 'lerna', 'nx', '.'],
      ['overrides', 'lerna', 'nx', 'brace-expansion'],
    ])
  })

  it('places a parent whose declaration of the package resolves to no entry', () => {
    const noChild = lockEdit((packages) => {
      delete packages['node_modules/brace-expansion']
    })
    expect(answer(PLACED, nx, noChild).lockfile_invalidated).toEqual({ performed: true, keys: [] })
  })

  it('stops where jq stops on a parent version that is a number', () => {
    const number = lockEdit((packages) => {
      ;(packages['node_modules/minimatch'] as Json).version = 10
    })
    expect(refusalOf('npm-cross-line', minimatch, number)).toBe(
      'cannot test a value that is not a text',
    )
  })

  // The expected values below are the answers of node.sh on the same
  // copies, read once by hand.
  const paths = ({ written }: ApplyConstraintAnswer) => written.map(({ path }) => path)

  /** A root dependency `zed`, with its own copy of nx at `version`. */
  const zedWithNx = (version: string, child?: Json) =>
    lockEdit((packages) => {
      ;((packages[''] as Json).dependencies as Json).zed = '^1.0.0'
      packages['node_modules/zed'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
      packages['node_modules/zed/node_modules/nx'] = {
        version,
        dependencies: { 'brace-expansion': '^5.0.4' },
      }
      if (child !== undefined) {
        packages['node_modules/zed/node_modules/nx/node_modules/brace-expansion'] = child
      }
    })

  it('keeps the qualifier of a version that a placed copy and a normal copy share', () => {
    expect(paths(answer(PLACED, nx, both(secondNxLine, zedWithNx('22.7.9'))))).toEqual([
      ['overrides', 'lerna', 'nx', '.'],
      ['overrides', 'lerna', 'nx', 'brace-expansion'],
      ['overrides', 'nx@22.7.9', 'brace-expansion'],
    ])
  })

  it('writes the top-level key for a normal copy whose child has no major', () => {
    expect(paths(answer(PLACED, nx, zedWithNx('22.6.0', { version: 'x.1' })))).toEqual([
      ['overrides', 'lerna', 'nx', '.'],
      ['overrides', 'lerna', 'nx', 'brace-expansion'],
      ['overrides', 'nx@22.6.0', 'brace-expansion'],
    ])
  })

  it('counts a copy whose child has no major on the line, not off it', () => {
    const noMajor = lockEdit((packages) => {
      packages['node_modules/minimatch/node_modules/brace-expansion'] = { version: 'x.1' }
    })
    expect(paths(answer('npm-cross-line', minimatch, noMajor))).toEqual([
      ['overrides', 'minimatch@^10.2.5', 'brace-expansion'],
      ['overrides', 'minimatch@10.0.3', 'brace-expansion'],
    ])
  })

  it('reads two equal parent versions that are objects as one version', () => {
    const objects = lockEdit((packages) => {
      for (const [key, entry] of Object.entries(packages)) {
        if (key.endsWith('node_modules/minimatch')) (entry as Json).version = { a: 1 }
      }
    })
    expect(paths(answer('npm-cross-line', minimatch, objects))).toEqual([
      ['overrides', 'minimatch', 'brace-expansion'],
    ])
  })

  it('skips a lockfile entry of the package that is not an object', () => {
    const nullEntry = lockEdit((packages) => {
      packages['node_modules/undici'] = null
    })
    expect(answer('npm-stale-nested', ['undici', '>=6.19.0 <7'], nullEntry)).toMatchObject({
      written: [{ parent: null, path: ['overrides', 'undici'], value: '>=6.19.0 <7' }],
      lockfile_invalidated: { performed: true, keys: [] },
    })
  })

  it('reads an entry whose name is false by its path, as jq `//` does', () => {
    const falseName = lockEdit((packages) => {
      ;(packages['node_modules/nx/node_modules/axios'] as Json).name = false
    })
    const args = ['axios', '>=1.18.0 <2', 'nx']
    expect(answer('npm-stale-nested', args, falseName).lockfile_invalidated).toEqual({
      performed: true,
      keys: ['node_modules/nx/node_modules/axios'],
    })
  })

  it('reads no pnpm field for npm', () => {
    const textField = manifestEdit((manifest) => {
      manifest.pnpm = 'x'
    })
    const result = answer('npm-stale-nested', ['axios', '>=1.18.0 <2', 'nx'], textField)
    expect({
      written: paths(result),
      observations: result.observations.map(({ type }) => type),
    }).toEqual({
      written: [['overrides', 'nx', 'axios']],
      observations: ['unscoped_override', 'unscoped_override'],
    })
  })

  it('looks for no bare npm pair beside the qualified keys of pnpm', () => {
    const npmPair = manifestEdit((manifest) => {
      manifest.overrides = { minimatch: { 'brace-expansion': '^1.1.12' } }
    })
    expect(paths(answer('pnpm-cross-line', minimatch, npmPair))).toEqual([
      ['pnpm', 'overrides', 'minimatch@10.0.3>brace-expansion'],
      ['pnpm', 'overrides', 'minimatch@10.2.5>brace-expansion'],
    ])
  })

  it('takes the direct mode for a call with no parents', () => {
    expect(answer('npm-stale-nested', ['axios', '>=1.18.0 <2']).mode).toBe('direct')
  })

  it('reads no dependent edge from a declaration that is not a text', () => {
    const zedRule = both(
      rule({ zed: { nx: '^22' } }),
      lockEdit((packages) => {
        ;((packages[''] as Json).dependencies as Json).zed = '^1.0.0'
        packages['node_modules/zed'] = { version: '1.0.0', dependencies: { nx: 5 } }
      }),
    )
    expect(manifestAfter(PLACED, nx, zedRule).overrides).toEqual({
      zed: { nx: '^22' },
      nx: { 'brace-expansion': '>=5.0.9 <6' },
    })
  })

  it('tightens no pnpm key with a `>`, even one that starts with the package', () => {
    const scoped = manifestEdit((manifest) => {
      manifest.pnpm = { overrides: { 'brace-expansion@>=5.0.0': '^5.0.0' } }
    })
    const tighten = ['--tighten-bare', ...BRACE]
    expect(pnpmOverrides(manifestAfter('pnpm-cross-line', tighten, scoped))).toEqual({
      'brace-expansion@>=5.0.0': '^5.0.0',
      'brace-expansion': '>=5.0.9 <6',
    })
  })

  it('qualifies the parents that no rule places beside one that a rule places', () => {
    const twoParents = lockEdit((packages) => {
      const declares = { 'brace-expansion': '^5.0.4' }
      packages['node_modules/foo'] = { version: '1.0.0', dependencies: declares }
      packages['node_modules/bar'] = {
        version: '1.0.0',
        dependencies: { foo: '^2.0.0', baz: '^2.0.0' },
      }
      packages['node_modules/bar/node_modules/foo'] = { version: '2.0.0', dependencies: declares }
      packages['node_modules/baz'] = { version: '1.0.0', dependencies: declares }
      packages['node_modules/bar/node_modules/baz'] = { version: '2.0.0', dependencies: declares }
    })
    const pinned = { 'brace-expansion': '>=5.0.9 <6' }
    expect(manifestAfter(PLACED, [...BRACE, 'nx', 'foo', 'baz'], twoParents).overrides).toEqual({
      lerna: { nx: NESTED, chalk: '^6.0.0' },
      glob: '^13.0.0',
      'foo@1.0.0': pinned,
      'foo@2.0.0': pinned,
      'baz@1.0.0': pinned,
      'baz@2.0.0': pinned,
    })
  })

  it('refuses the shared parent when a placed parent also has a normal copy on the line', () => {
    const lines = both(
      lockEdit((packages) => {
        packages['node_modules/foo'] = { version: '1.0.0', dependencies: { nx: '^21.0.0' } }
        packages['node_modules/foo/node_modules/nx'] = {
          version: '21.5.0',
          dependencies: { 'brace-expansion': '^1.1.7' },
        }
        packages['node_modules/foo/node_modules/brace-expansion'] = { version: '1.1.12' }
        packages['node_modules/zed'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
        packages['node_modules/zed/node_modules/nx'] = {
          version: '22.6.0',
          dependencies: { 'brace-expansion': '^5.0.4' },
        }
      }),
      manifestEdit((manifest) => {
        ;(manifest.dependencies as Json).nx = '>=21.0.0'
      }),
    )
    expect(refusalOf(PLACED, nx, lines)).toContain(
      'Detail: [{"parent":"nx","root_spec":">=21.0.0","other_line_versions":["21.5.0"]}]',
    )
  })

  it('keeps the bare key for a pnpm parent whose only other snapshot has no version', () => {
    const weird: Setup = (dir) => {
      const text = textAt(dir, 'pnpm-lock.yaml').replace(
        /^snapshots:\n/m,
        'snapshots:\n  weird:\n    dependencies:\n      brace-expansion: 5.0.5\n  weird@1.0.0:\n    dependencies:\n      brace-expansion: 5.0.5\n',
      )
      writeFileSync(join(dir, 'pnpm-lock.yaml'), text)
    }
    expect(answer('pnpm-cross-line', [...BRACE, 'weird'], weird).written).toEqual([
      {
        parent: 'weird',
        path: ['pnpm', 'overrides', 'weird>brace-expansion'],
        value: '>=5.0.9 <6',
      },
    ])
  })
})

describe('the writer of the workspace block', () => {
  const minimatch = [...BRACE, 'minimatch']
  const NEW_KEYS =
    "  'minimatch@10.0.3>brace-expansion': '>=5.0.9 <6'\n  'minimatch@10.2.5>brace-expansion': '>=5.0.9 <6'\n"
  const written = (text: string) =>
    textAt(apply(PNPM11, minimatch, workspaceFile(text)).dir, 'pnpm-workspace.yaml')

  it.each([
    [
      'puts new keys before the next top-level key, after comments and blank lines',
      "overrides:\n  # pinned\n  ws: '1'\n\ncatalog:\n  x: 1\n",
      `overrides:\n  # pinned\n  ws: '1'\n\n${NEW_KEYS}catalog:\n  x: 1\n`,
    ],
    [
      'ends a block with no newline at the end',
      "overrides:\n  ws: '1'",
      `overrides:\n  ws: '1'\n${NEW_KEYS}`,
    ],
    ['adds the block to an empty file', '', `overrides:\n${NEW_KEYS}`],
  ])('%s', (_title, text, expected) => {
    expect(written(text)).toBe(expected)
  })

  it('writes nothing when each key already holds its value', () => {
    const text = `overrides:\n${NEW_KEYS}`
    expect(written(text)).toBe(text)
  })

  // node.sh writes the changed entries as lines of `key<TAB>value`. A key
  // with a line feed breaks that line, and the read back shows it.
  it('refuses a key that the block cannot keep, after the write', () => {
    const { envelope, dir } = apply(PNPM11, ['a\nb', '>=1.0.0 <2'])
    expect({ envelope, last: textAt(dir, 'pnpm-workspace.yaml').split('\n').at(-2) }).toEqual({
      envelope: {
        outcome: 'failed',
        error:
          'pnpm-workspace.yaml overrides: the block read back after writing does not match what was written. The file was left as rewritten for inspection, but treat the apply as failed.',
      },
      last: "  'b': '>=1.0.0 <2'",
    })
  })
})

// The chain to the verdict (#222 acceptance). The keys that the call writes
// are the override state of the `-qualified` specimen, whose installed
// lockfile keeps the sibling lines and passes `validate --baseline`. The bare
// key of the old write is the state of the `-collapsed` specimen, which
// fails closed. The baselines and the expected values are the literals of
// spec/node_validate_spec.sh.
describe('the verdict of validate on the tree that the written keys produce', () => {
  const PNPM_BASELINE =
    '{"pm":"pnpm","package":"brace-expansion","present":true,"count":3,"versions":[{"version":"1.1.11","path":"brace-expansion@1.1.11"},{"version":"2.0.2","path":"brace-expansion@2.0.2"},{"version":"5.0.5","path":"brace-expansion@5.0.5"}],"lockfile_entries":14}'
  const NPM_BASELINE =
    '{"pm":"npm","package":"brace-expansion","present":true,"count":3,"versions":[{"version":"5.0.5","path":"node_modules/brace-expansion"},{"version":"2.0.2","path":"node_modules/filelist/node_modules/brace-expansion"},{"version":"1.1.11","path":"node_modules/glob/node_modules/brace-expansion"}],"lockfile_entries":14}'
  const VANISHED = [
    { major: 1, before: ['1.1.11'], after: [], status: 'vanished', class: 'fatal' },
    { major: 2, before: ['2.0.2'], after: [], status: 'vanished', class: 'fatal' },
  ]
  const verdictOn = (specimen: string, baseline: string) => {
    const result = node.validate(treeAt(join(FIXTURES_ROOT, specimen)), ...BRACE, {
      line: '5',
      vulnerable: ['< 5.0.9'],
      baseline,
      siblingAlerts: null,
    })
    if (result.outcome !== 'ok') throw new Error(result.error)
    return { ok: result.value.ok, other_line_moves: result.value.other_line_moves }
  }
  const blockOf = (manifest: Json, pm: string): unknown =>
    pm === 'pnpm' ? pnpmOverrides(manifest) : manifest.overrides

  it.each([
    ['pnpm', 'pnpm-cross-line', PNPM_BASELINE, { 'minimatch>brace-expansion': '>=5.0.9 <6' }],
    ['npm', 'npm-cross-line', NPM_BASELINE, { minimatch: { 'brace-expansion': '>=5.0.9 <6' } }],
  ])(
    'passes for the keys that the %s call writes, and fails for the bare key',
    (pm, fixture, baseline, bare) => {
      const written = blockOf(manifestAfter(fixture, [...BRACE, 'minimatch']), pm)
      const qualified = readJson(join(FIXTURES_ROOT, `${fixture}-qualified`), 'package.json')
      const collapsed = readJson(join(FIXTURES_ROOT, `${fixture}-collapsed`), 'package.json')
      expect({
        written: written,
        collapsed: blockOf(collapsed, pm),
        pass: verdictOn(`${fixture}-qualified`, baseline),
        fail: verdictOn(`${fixture}-collapsed`, baseline),
      }).toEqual({
        written: blockOf(qualified, pm),
        collapsed: bare,
        pass: { ok: true, other_line_moves: [] },
        fail: { ok: false, other_line_moves: VANISHED },
      })
    },
  )
})

// Rows that a revert of one guard fails. Each expected value is the answer
// of node.sh on the same copy, read by hand from its output.
describe('the guards of the passes', () => {
  it('keeps the bytes of a manifest that the call does not change', () => {
    const { dir } = apply('npm-v3', LODASH)
    expect(textAt(dir, 'package.json')).toBe(textAt(join(FIXTURES_ROOT, 'npm-v3'), 'package.json'))
  })

  it('marks a qualified bare key that targets the package', () => {
    const { observations } = answer('pnpm-v9', ['handlebars', '>=4.7.10 <5', 'express'])
    expect(
      observations.flatMap((each) =>
        each.type === 'unscoped_override' && each.targets_this_package ? [each.key] : [],
      ),
    ).toEqual(['handlebars@4'])
  })

  it.each([
    ['no pnpm.overrides in package.json', undefined],
    [
      'a workspace block and no pnpm pin',
      manifestEdit((manifest) => {
        delete manifest.packageManager
      }),
    ],
  ])('adds no pnpm observation for %s', (_title, setup) => {
    expect(
      answer(PNPM11, [...BRACE, 'minimatch'], setup).observations.map(({ type }) => type),
    ).toEqual(Array(4).fill('unscoped_override'))
  })

  it('retargets a root key that aliases the package with no version', () => {
    const bare = manifestEdit((manifest) => {
      ;(manifest.dependencies as Json).l = 'npm:lodash'
    })
    expect(answer('npm-v3', LODASH, bare).written).toEqual([
      { parent: null, path: ['dependencies', 'l'], value: 'npm:lodash@>=4.17.21 <5' },
      { parent: null, path: ['dependencies', 'lodash'], value: '^4.17.21' },
    ])
  })

  it('places nothing through a rule whose outer segment is not in the lockfile', () => {
    expect(
      manifestAfter(PLACED, nx, rule({ absent: { lerna: { nx: '>=22.7.7 <23' } } })).overrides,
    ).toEqual({
      absent: { lerna: { nx: '>=22.7.7 <23' } },
      nx: { 'brace-expansion': '>=5.0.9 <6' },
    })
  })

  it('places a parent that declares the package through an npm: alias', () => {
    const aliased = lockEdit((packages) => {
      ;(packages['node_modules/nx'] as Json).dependencies = {
        'be-alias': 'npm:brace-expansion@^5.0.4',
      }
      packages['node_modules/be-alias'] = { name: 'brace-expansion', version: '5.0.5' }
    })
    expect(manifestAfter(PLACED, nx, aliased).overrides).toEqual({
      lerna: {
        nx: { '.': '>=22.7.7 <23', 'be-alias': 'npm:brace-expansion@>=5.0.9 <6' },
        chalk: '^6.0.0',
      },
      glob: '^13.0.0',
    })
  })

  it('refuses no alias rule whose value names another package', () => {
    const other = both(
      manifestEdit((manifest) => {
        ;((manifest.overrides as Json).lerna as Json)['x-tools'] = 'npm:other@1'
      }),
      lockEdit((packages) => {
        packages['node_modules/x-tools'] = { name: 'nx', version: '22.7.9' }
      }),
    )
    expect(((manifestAfter(PLACED, nx, other).overrides as Json).lerna as Json).nx).toEqual(NESTED)
  })

  it('keeps a normal copy on the line when the range has no floor', () => {
    expect(manifestAfter(PLACED, [BRACE[0], 'latest', 'nx'], secondNxLine).overrides).toEqual({
      lerna: { nx: { '.': '>=22.7.7 <23', 'brace-expansion': 'latest' }, chalk: '^6.0.0' },
      glob: '^13.0.0',
      'nx@21.5.0': { 'brace-expansion': 'latest' },
    })
  })

  it('tightens a version-qualified placing rule, which a tighten does not refuse', () => {
    const qualified = rule({ lerna: { 'nx@^22.0.0': '>=22.7.7 <23' } })
    expect(
      manifestAfter(PLACED, ['--tighten-bare', 'nx', '>=22.7.9 <23'], qualified).overrides,
    ).toEqual({
      lerna: { 'nx@^22.0.0': '>=22.7.9 <23' },
    })
  })

  it('refuses a dead pair with no floor, for a range with no floor', () => {
    const dead = manifestEdit((manifest) => {
      ;(manifest.overrides as Json).nx = { 'brace-expansion': 'latest' }
    })
    expect(refusalOf(PLACED, [BRACE[0], 'latest', 'nx'], dead)).toContain(
      '[{"parent":"nx","key":"overrides.nx.brace-expansion","value":"latest"}]',
    )
  })

  it('refuses a bare pair with no floor beside qualified keys, for a range with no floor', () => {
    const bare = rule({ minimatch: { 'brace-expansion': 'latest' } })
    expect(refusalOf('npm-cross-line', [BRACE[0], 'latest', 'minimatch'], bare)).toContain(
      '{"parent":"minimatch","value":"latest","parent_also_override_placed":false}',
    )
  })

  it('refuses a tighten for a range with no floor, though the rule pin has none either', () => {
    const latest = manifestEdit((manifest) => {
      ;((manifest.overrides as Json).lerna as Json).nx = 'latest'
    })
    expect(refusalOf(PLACED, ['--tighten-bare', 'nx', 'latest'], latest)).toContain(
      "--tighten-bare cannot reach 'nx'",
    )
  })

  it('writes the nested key for a refused shared parent whose copies on the line are all placed', () => {
    const lines = both(
      secondNxLine,
      manifestEdit((manifest) => {
        ;(manifest.dependencies as Json).nx = '>=21.0.0'
      }),
    )
    expect(manifestAfter(PLACED, nx, lines).overrides).toEqual({
      lerna: { nx: NESTED, chalk: '^6.0.0' },
      glob: '^13.0.0',
    })
  })
})

describe('more guards of the passes', () => {
  it('retargets a root key that aliases a scoped package with no version', () => {
    const scoped = manifestEdit((manifest) => {
      ;(manifest.dependencies as Json).b = 'npm:@babel/core'
    })
    expect(answer('npm-v3', ['@babel/core', '>=7.25.0 <8'], scoped).written).toEqual([
      { parent: null, path: ['dependencies', 'b'], value: 'npm:@babel/core@>=7.25.0 <8' },
    ])
  })

  it('supersedes no pin inside the rule that already holds the new value', () => {
    const same = manifestEdit((manifest) => {
      ;((manifest.overrides as Json).lerna as Json).nx = NESTED
    })
    expect(answer(PLACED, nx, same).superseded_keys).toEqual([])
  })

  it('keeps a top-level pair of a placed parent that does not pin the package', () => {
    const other = manifestEdit((manifest) => {
      ;(manifest.overrides as Json).nx = { minimist: '1' }
    })
    const { envelope, dir } = apply(PLACED, nx, other)
    expect({
      superseded: answerOf(envelope).superseded_keys,
      pair: (readJson(dir, 'package.json').overrides as Json).nx,
    }).toEqual({ superseded: [], pair: { minimist: '1' } })
  })

  it.each([
    [
      'a yarn key with a parent',
      'yarn-major-qualified',
      manifestEdit((manifest) => {
        ;(manifest.resolutions as Json)['@grpc/grpc-js@0/foo'] = '^1.0.0'
      }),
      ['@grpc/grpc-js', '>=0.5.0 <1'],
      ['resolutions', '@grpc/grpc-js'],
    ],
    [
      'a key whose name is another package',
      'npm-major-qualified',
      rule({ 'protobufjs@x@8': '^8.0.0' }),
      ['protobufjs', '>=8.6.6 <9'],
      ['overrides', 'protobufjs'],
    ],
    [
      'a key with no floor, for a range with no floor',
      'npm-major-qualified',
      rule({ 'protobufjs@beta': 'beta' }),
      ['protobufjs', 'latest'],
      ['overrides', 'protobufjs'],
    ],
    [
      'a key whose value is an object',
      'npm-major-qualified',
      rule({ 'glob@9': { minimatch: '1' } }),
      ['glob', '>=9.3.5 <10'],
      ['overrides', 'glob'],
    ],
  ])(
    'tightens no bare key that is %s, and writes the plain key',
    (_title, fixture, setup, args, path) => {
      expect(
        answer(fixture, ['--tighten-bare', ...args], setup).written.map((entry) => entry.path),
      ).toEqual([path])
    },
  )

  it('writes no plain key beside a covering key and a rule pin', () => {
    const mixed = both(
      lockEdit((packages) => {
        ;((packages[''] as Json).dependencies as Json).foo = '^1.0.0'
        packages['node_modules/foo'] = { version: '1.0.0', dependencies: { nx: '^22.0.0' } }
        packages['node_modules/foo/node_modules/nx'] = {
          version: '22.7.5',
          dependencies: { 'brace-expansion': '^5.0.4' },
        }
      }),
      manifestEdit((manifest) => {
        ;(manifest.overrides as Json)['nx@22'] = '^22.7.5'
      }),
    )
    expect(answer(PLACED, ['--tighten-bare', 'nx', '>=22.7.9 <23'], mixed).written).toEqual([
      { parent: null, path: ['overrides', 'nx@22'], value: '>=22.7.9 <23' },
      { parent: null, path: ['overrides', 'lerna', 'nx'], value: '>=22.7.9 <23' },
    ])
  })

  it('leaves a workspace file with no newline at the end as it is when no key changes', () => {
    const text =
      "overrides:\n  'minimatch@10.0.3>brace-expansion': '>=5.0.9 <6'\n  'minimatch@10.2.5>brace-expansion': '>=5.0.9 <6'"
    const { dir } = apply(PNPM11, [...BRACE, 'minimatch'], workspaceFile(text))
    expect(textAt(dir, 'pnpm-workspace.yaml')).toBe(text)
  })

  it('quotes a key with a single quote', () => {
    const { dir } = apply(PNPM11, ["it's", '>=1.0.0 <2'])
    expect(textAt(dir, 'pnpm-workspace.yaml').split('\n').at(-2)).toBe("  'it''s': '>=1.0.0 <2'")
  })

  it('counts no entry outside node_modules/ as stale', () => {
    const workspace = lockEdit((packages) => {
      packages['packages/axios'] = { name: 'axios', version: '1.0.0' }
    })
    expect(
      answer('npm-stale-nested', ['axios', '>=1.18.0 <2', 'nx'], workspace).lockfile_invalidated,
    ).toEqual({
      performed: true,
      keys: ['node_modules/nx/node_modules/axios'],
    })
  })
})

describe('the refusal of the root keys', () => {
  it('refuses a dependency block that is a text, writing nothing', () => {
    const text = manifestEdit((manifest) => {
      manifest.devDependencies = 'x'
    })
    expect(refusalOf('npm-v3', LODASH, text)).toBe('apply_constraint: cannot read package.json')
  })
})

describe('the write of each file, through a temporary file and a rename', () => {
  const STALE = ['axios', '>=1.18.0 <2', 'nx'] as const
  const WRITES = [
    ['package.json', 'npm-stale-nested', STALE],
    ['package-lock.json', 'npm-stale-nested', STALE],
    ['pnpm-workspace.yaml', PNPM11, [...BRACE, 'minimatch']],
  ] as const

  /** A scratch directory outside the copy, removed after the test. */
  const outsideDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-constraint-outside-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  it.each(WRITES)(
    'replaces a symlink at %s, and leaves the file that it points to as it was',
    (file, fixture, args) => {
      const outside = outsideDir()
      const { envelope, dir } = apply(fixture, args, (copy) => {
        renameSync(join(copy, file), join(outside, file))
        symlinkSync(join(outside, file), join(copy, file))
      })
      answerOf(envelope)
      const specimen = textAt(join(FIXTURES_ROOT, fixture), file)
      expect({
        link: lstatSync(join(dir, file)).isSymbolicLink(),
        changed: textAt(dir, file) !== specimen,
        target: textAt(outside, file) === specimen,
      }).toEqual({ link: false, changed: true, target: true })
    },
  )

  it('adds the block to the copy, not to the file that a symlink points to', () => {
    const outside = outsideDir()
    const text = 'packages:\n  - packages/*\n'
    writeFileSync(join(outside, 'pnpm-workspace.yaml'), text)
    const { envelope, dir } = apply(PNPM11, [...BRACE], (copy) => {
      rmSync(join(copy, 'pnpm-workspace.yaml'))
      symlinkSync(join(outside, 'pnpm-workspace.yaml'), join(copy, 'pnpm-workspace.yaml'))
    })
    answerOf(envelope)
    expect({
      written: textAt(dir, 'pnpm-workspace.yaml'),
      target: textAt(outside, 'pnpm-workspace.yaml'),
    }).toEqual({ written: `${text}overrides:\n  'brace-expansion': '>=5.0.9 <6'\n`, target: text })
  })

  it('replaces a dangling symlink, and makes no file where it points', () => {
    const outside = outsideDir()
    const { envelope, dir } = apply(PNPM11, [...BRACE], (copy) => {
      rmSync(join(copy, 'pnpm-workspace.yaml'))
      symlinkSync(join(outside, 'pnpm-workspace.yaml'), join(copy, 'pnpm-workspace.yaml'))
    })
    answerOf(envelope)
    expect({
      written: textAt(dir, 'pnpm-workspace.yaml'),
      outside: readdirSync(outside),
    }).toEqual({ written: "overrides:\n  'brace-expansion': '>=5.0.9 <6'\n", outside: [] })
  })

  // node.sh refuses this file with `cannot append`. A rename needs only the
  // directory, so the port writes it: a declared divergence.
  it('replaces a workspace file with no block that cannot be written', () => {
    const text = 'packages:\n  - packages/*\n'
    const { envelope, dir } = apply(PNPM11, [...BRACE], (copy) => {
      writeFileSync(join(copy, 'pnpm-workspace.yaml'), text)
      chmodSync(join(copy, 'pnpm-workspace.yaml'), 0o444)
    })
    answerOf(envelope)
    expect({
      written: textAt(dir, 'pnpm-workspace.yaml'),
      mode: statSync(join(dir, 'pnpm-workspace.yaml')).mode & 0o7777,
    }).toEqual({ written: `${text}overrides:\n  'brace-expansion': '>=5.0.9 <6'\n`, mode: 0o444 })
  })

  it.each(WRITES)('keeps the mode of %s', (file, fixture, args) => {
    // A mode that no umask makes from the 0o666 of a new file.
    const { envelope, dir } = apply(fixture, args, (copy) => chmodSync(join(copy, file), 0o766))
    answerOf(envelope)
    expect(statSync(join(dir, file)).mode & 0o7777).toBe(0o766)
  })

  /** The call on a copy, and each file of the copy before and after it. */
  const failedCall = (dir: string, args: readonly string[]) => {
    const files = () => readdirSync(dir).map((name) => [name, readOptional(dir, name)])
    const before = files()
    return { envelope: node.applyConstraint(treeAt(dir), requestOf(args)), before, after: files() }
  }

  // Each text is the text of node.sh on the same copy.
  it.skipIf(process.getuid?.() === 0).each([
    [
      'package.json',
      'npm-stale-nested',
      undefined,
      STALE,
      'apply_constraint: cannot replace package.json',
    ],
    [
      'pnpm-workspace.yaml',
      PNPM11,
      undefined,
      [...BRACE, 'minimatch'],
      'pnpm-workspace.yaml overrides: cannot replace pnpm-workspace.yaml',
    ],
    [
      'a new pnpm-workspace.yaml',
      PNPM11,
      (copy: string) => rmSync(join(copy, 'pnpm-workspace.yaml')),
      [...BRACE],
      'pnpm-workspace.yaml overrides: cannot create pnpm-workspace.yaml',
    ],
  ] as const)(
    'fails at the write of %s in a directory that cannot be written, and changes no file',
    (_, fixture, setup, args, error) => {
      const dir = copyOf(fixture, setup)
      chmodSync(dir, 0o555)
      try {
        const { envelope, before, after } = failedCall(dir, args)
        expect({ envelope, after }).toEqual({
          envelope: { outcome: 'failed', error: `${error} in ${dir}` },
          after: before,
        })
      } finally {
        chmodSync(dir, 0o755)
      }
    },
  )

  it('fails with the text of node.sh for a directory at pnpm-workspace.yaml', () => {
    const dir = copyOf(PNPM11, (copy) => {
      rmSync(join(copy, 'pnpm-workspace.yaml'))
      mkdirSync(join(copy, 'pnpm-workspace.yaml'))
    })
    const { envelope, before, after } = failedCall(dir, [...BRACE])
    expect({ envelope, after }).toEqual({
      envelope: {
        outcome: 'failed',
        error: `pnpm-workspace.yaml overrides: cannot create pnpm-workspace.yaml in ${dir}`,
      },
      after: before,
    })
  })

  // node.sh has no `die` for this move. The text is the text of the port.
  it.skipIf(process.getuid?.() === 0)(
    'fails at the write of package-lock.json in a directory that cannot be written',
    () => {
      const dir = copyOf('npm-stale-nested')
      const lock = textAt(dir, 'package-lock.json')
      answerOf(node.applyConstraint(treeAt(dir), requestOf(STALE)))
      // package.json has the rule now, so the second call writes only the lockfile.
      writeFileSync(join(dir, 'package-lock.json'), lock)
      chmodSync(dir, 0o555)
      try {
        const { envelope, before, after } = failedCall(dir, STALE)
        expect({ envelope, after }).toEqual({
          envelope: {
            outcome: 'failed',
            error: `apply_constraint: cannot replace package-lock.json in ${dir}`,
          },
          after: before,
        })
      } finally {
        chmodSync(dir, 0o755)
      }
    },
  )
})
