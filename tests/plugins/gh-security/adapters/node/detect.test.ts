// `detect` of the node adapter (#221). The seam is `node.detect`, the
// function that its callers reach. Each expected value is written by hand
// from the fixture that it names and from `verb_detect` in node.sh. The
// parity run holds the agreement with node.sh.
//
// The PATH is the parameter that `detect` takes (#221, round 3 ruling 9).
// Each example gives a directory that holds an empty file for each tool that
// it puts on PATH. `detect` only looks for the name, and never runs it, so
// the file stands in for the tool. The test gives the tools through that
// parameter (`mocking.md`, "The injected collaborator").
//
// Where no fixture carries a branch, the example changes a copy of the
// nearest specimen, as spec/node_lockfiles_spec.sh and
// spec/node_apply_constraint_spec.sh do for the same branches.
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import { node } from '#gh-security/adapters/node.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'
import { createSandbox } from '#harness/sandbox.ts'

/** A PATH of one directory, with an empty file for each tool named. */
const pathWith = (...tools: string[]): string => {
  const sandbox = createSandbox()
  const bin = sandbox.join('bin')
  mkdirSync(bin)
  for (const tool of tools) writeFileSync(join(bin, tool), '', { mode: 0o755 })
  return bin
}

/** A scratch copy of a fixture, removed when the example ends. */
const copyOf = (name: string): string => {
  const fixture = useFixture(name)
  onTestFinished(fixture.cleanup)
  return fixture.path
}

/** Change one field of the copy's package.json. */
const setManifestField = (root: string, field: string, value: unknown): void => {
  const path = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...manifest, [field]: value }))
}

const fixture = (name: string): string => join(FIXTURES_ROOT, name)

describe('the three supported managers', () => {
  it('detects pnpm, with the override file and major that packageManager pins', () => {
    expect(node.detect(fixture('pnpm-v9'), { PATH: pathWith('pnpm') })).toEqual({
      outcome: 'ok',
      value: {
        pm: 'pnpm',
        pm_exec: 'pnpm',
        lockfile: 'pnpm-lock.yaml',
        install_cmd: 'pnpm install',
        why_cmd: 'pnpm why',
        override_location: 'pnpm.overrides',
        override_file: 'package.json',
        pnpm_major: 10,
        override_syntax: 'parent>dep',
        supports_scoping: true,
      },
    })
  })

  it('detects Yarn Berry by its __metadata block', () => {
    expect(node.detect(fixture('yarn-berry'), { PATH: pathWith('yarn') })).toEqual({
      outcome: 'ok',
      value: {
        pm: 'yarn',
        pm_exec: 'yarn',
        lockfile: 'yarn.lock',
        install_cmd: 'yarn install',
        why_cmd: 'yarn why',
        override_location: 'resolutions',
        override_file: 'package.json',
        override_syntax: 'parent/dep',
        supports_scoping: true,
      },
    })
  })

  it('detects npm, whose why command is explain', () => {
    expect(node.detect(fixture('npm-v3'), { PATH: pathWith('npm') })).toEqual({
      outcome: 'ok',
      value: {
        pm: 'npm',
        pm_exec: 'npm',
        lockfile: 'package-lock.json',
        install_cmd: 'npm install',
        why_cmd: 'npm explain',
        override_location: 'overrides',
        override_file: 'package.json',
        override_syntax: 'nested',
        supports_scoping: true,
      },
    })
  })
})

describe('lockfile precedence', () => {
  // A copy of `base`, with the lockfile of `source` added beside its own.
  it.each([
    ['pnpm over npm', 'npm-v3', 'pnpm-v9', 'pnpm-lock.yaml', 'pnpm'],
    ['pnpm over yarn', 'yarn-berry', 'pnpm-v9', 'pnpm-lock.yaml', 'pnpm'],
    ['yarn over npm', 'npm-v3', 'yarn-berry', 'yarn.lock', 'yarn'],
    ['npm over bun', 'bun', 'npm-v3', 'package-lock.json', 'npm'],
  ])('picks %s', (_case, base, source, lockfile, pm) => {
    const root = copyOf(base)
    copyFileSync(join(fixture(source), lockfile), join(root, lockfile))
    const detection = node.detect(root, { PATH: pathWith() })
    expect(detection.outcome === 'ok' && detection.value.pm).toBe(pm)
  })

  it('does not read a directory as a lockfile', () => {
    const root = copyOf('npm-v3')
    mkdirSync(join(root, 'pnpm-lock.yaml'))
    const detection = node.detect(root, { PATH: pathWith() })
    expect(detection.outcome === 'ok' && detection.value.pm).toBe('npm')
  })

  it('refuses Yarn Classic before it reads the npm lockfile', () => {
    const root = copyOf('yarn-classic')
    copyFileSync(join(fixture('npm-v3'), 'package-lock.json'), join(root, 'package-lock.json'))
    expect(node.detect(root, { PATH: pathWith() })).toMatchObject({
      outcome: 'unsupported',
      unsupported: 'yarn-classic',
    })
  })
})

describe('the pnpm override file and major', () => {
  const pnpmFacts = (root: string) => {
    const detection = node.detect(root, { PATH: pathWith('pnpm') })
    return detection.outcome === 'ok' && detection.value.pm === 'pnpm'
      ? { override_file: detection.value.override_file, pnpm_major: detection.value.pnpm_major }
      : detection
  }

  it('routes a pnpm 11 repo with a workspace overrides block to pnpm-workspace.yaml', () => {
    expect(pnpmFacts(fixture('pnpm11-workspace-overrides'))).toEqual({
      override_file: 'pnpm-workspace.yaml',
      pnpm_major: 11,
    })
  })

  it('keeps package.json for a workspace file that has no overrides block', () => {
    expect(pnpmFacts(fixture('pnpm-workspace-peer'))).toEqual({
      override_file: 'package.json',
      pnpm_major: 10,
    })
  })

  it('answers a null major when packageManager is absent', () => {
    expect(pnpmFacts(fixture('pnpm-v6'))).toEqual({
      override_file: 'package.json',
      pnpm_major: null,
    })
  })

  it('routes a pnpm 11 pin with no workspace file to pnpm-workspace.yaml', () => {
    const root = copyOf('pnpm-cross-line')
    setManifestField(root, 'packageManager', 'pnpm@11.9.0')
    expect(pnpmFacts(root)).toEqual({ override_file: 'pnpm-workspace.yaml', pnpm_major: 11 })
  })

  it('prefers a workspace overrides block on pnpm 10 too', () => {
    const root = copyOf('pnpm11-workspace-overrides')
    setManifestField(root, 'packageManager', 'pnpm@10.2.1')
    expect(pnpmFacts(root)).toEqual({ override_file: 'pnpm-workspace.yaml', pnpm_major: 10 })
  })

  it.each(["'overrides':", '"overrides":'])(
    'reads the quoted overrides key %s in pnpm-workspace.yaml',
    (key) => {
      const root = copyOf('pnpm-cross-line')
      writeFileSync(join(root, 'pnpm-workspace.yaml'), `${key}\n  foo: 1.0.0\n`)
      expect(pnpmFacts(root)).toEqual({ override_file: 'pnpm-workspace.yaml', pnpm_major: 10 })
    },
  )

  it('answers a null major for a packageManager that pins another manager', () => {
    const root = copyOf('pnpm-cross-line')
    setManifestField(root, 'packageManager', 'yarn@4.13.0')
    expect(pnpmFacts(root)).toEqual({ override_file: 'package.json', pnpm_major: null })
  })

  // jq's `.packageManager // ""` gives "" for null and false, and its
  // `capture` stops on anything that is not a string. jq reads no document
  // in a file that holds only JSON white space (space, tab, CR and LF), and
  // writes nothing.
  it.each([
    ['a null top level', 'null', { override_file: 'package.json', pnpm_major: null }],
    ['an empty manifest', '', { override_file: 'package.json', pnpm_major: null }],
    ['a manifest of white space', ' \n', { override_file: 'package.json', pnpm_major: null }],
    ['a manifest of tab, CR and LF', '\t\r\n', { override_file: 'package.json', pnpm_major: null }],
    [
      'a null packageManager',
      '{"packageManager":null}',
      { override_file: 'package.json', pnpm_major: null },
    ],
    [
      'a false packageManager',
      '{"packageManager":false}',
      { override_file: 'package.json', pnpm_major: null },
    ],
  ])('answers a null major for %s, as jq does', (_case, manifest, expected) => {
    const root = copyOf('pnpm-cross-line')
    writeFileSync(join(root, 'package.json'), manifest)
    expect(pnpmFacts(root)).toEqual(expected)
  })

  it.each([
    ['a manifest that is not JSON', '{ not json\n'],
    ['a top level that is an array', '[]'],
    ['a packageManager that is a number', '{"packageManager":11}'],
    ['a packageManager of zero', '{"packageManager":0}'],
    // jq reads only JSON white space as no document.
    ['a manifest of a form feed', '\f'],
    ['a manifest of a no-break space', '\u00a0'],
  ])('fails for %s, where jq stops', (_case, manifest) => {
    const root = copyOf('pnpm-cross-line')
    writeFileSync(join(root, 'package.json'), manifest)
    expect(pnpmFacts(root)).toEqual({
      outcome: 'failed',
      error: "detect: cannot read package.json's packageManager field",
    })
  })

  it('fails for a pnpm tree with no package.json, where jq stops', () => {
    const root = copyOf('pnpm-cross-line')
    rmSync(join(root, 'package.json'))
    expect(pnpmFacts(root)).toEqual({
      outcome: 'failed',
      error: "detect: cannot read package.json's packageManager field",
    })
  })
})

describe('the runner', () => {
  const runnerOf = (root: string, PATH: string | undefined) => {
    const detection = node.detect(root, { PATH })
    return detection.outcome === 'ok'
      ? {
          pm_exec: detection.value.pm_exec,
          install_cmd: detection.value.install_cmd,
          why_cmd: detection.value.why_cmd,
        }
      : detection
  }

  it('prefers the bare binary on PATH over corepack', () => {
    expect(runnerOf(fixture('yarn-berry'), pathWith('yarn', 'corepack'))).toEqual({
      pm_exec: 'yarn',
      install_cmd: 'yarn install',
      why_cmd: 'yarn why',
    })
  })

  it('falls back to corepack when the manifest names a packageManager', () => {
    expect(runnerOf(fixture('yarn-berry'), pathWith('corepack'))).toEqual({
      pm_exec: 'corepack yarn',
      install_cmd: 'corepack yarn install',
      why_cmd: 'corepack yarn why',
    })
  })

  it('keeps the bare name when corepack is not on PATH', () => {
    expect(runnerOf(fixture('yarn-berry'), pathWith())).toEqual({
      pm_exec: 'yarn',
      install_cmd: 'yarn install',
      why_cmd: 'yarn why',
    })
  })

  it('keeps the bare name when the manifest names no packageManager', () => {
    expect(runnerOf(fixture('npm-v3'), pathWith('corepack'))).toEqual({
      pm_exec: 'npm',
      install_cmd: 'npm install',
      why_cmd: 'npm explain',
    })
  })

  it('keeps the bare name for a packageManager of false, as jq -e does', () => {
    const root = copyOf('yarn-berry')
    setManifestField(root, 'packageManager', false)
    expect(runnerOf(root, pathWith('corepack'))).toMatchObject({ pm_exec: 'yarn' })
  })

  it('keeps the bare name for a null packageManager, as jq -e does', () => {
    const root = copyOf('yarn-berry')
    setManifestField(root, 'packageManager', null)
    expect(runnerOf(root, pathWith('corepack'))).toMatchObject({ pm_exec: 'yarn' })
  })

  it('uses corepack for an empty packageManager, which jq -e reads as present', () => {
    const root = copyOf('yarn-berry')
    setManifestField(root, 'packageManager', '')
    expect(runnerOf(root, pathWith('corepack'))).toMatchObject({ pm_exec: 'corepack yarn' })
  })

  // jq reads a byte order mark at the start of the file, so node.sh does too.
  it('reads a package.json that starts with a byte order mark', () => {
    const root = copyOf('yarn-berry')
    const path = join(root, 'package.json')
    writeFileSync(path, `\uFEFF${readFileSync(path, 'utf8')}`)
    expect(runnerOf(root, pathWith('corepack'))).toMatchObject({ pm_exec: 'corepack yarn' })
  })

  it('keeps the bare name when package.json is absent', () => {
    const root = copyOf('npm-v3')
    rmSync(join(root, 'package.json'))
    expect(runnerOf(root, pathWith('corepack'))).toMatchObject({ pm_exec: 'npm' })
  })

  describe('the release that .yarnrc.yml vendors', () => {
    const RELEASE = join('.yarn', 'releases', 'yarn-4.13.0.cjs')

    it('runs the vendored release with node when yarn is not on PATH', () => {
      expect(runnerOf(fixture('yarn-vendored'), pathWith('node', 'corepack'))).toEqual({
        pm_exec: 'node .yarn/releases/yarn-4.13.0.cjs',
        install_cmd: 'node .yarn/releases/yarn-4.13.0.cjs install',
        why_cmd: 'node .yarn/releases/yarn-4.13.0.cjs why',
      })
    })

    it('does not use it when node is not on PATH', () => {
      expect(runnerOf(fixture('yarn-vendored'), pathWith('corepack'))).toMatchObject({
        pm_exec: 'corepack yarn',
      })
    })

    it('does not use a release that is not in the tree', () => {
      const root = copyOf('yarn-vendored')
      rmSync(join(root, RELEASE))
      expect(runnerOf(root, pathWith('node', 'corepack'))).toMatchObject({
        pm_exec: 'corepack yarn',
      })
    })

    it('does not use a .yarnrc.yml that names no yarnPath', () => {
      const root = copyOf('yarn-vendored')
      writeFileSync(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
      expect(runnerOf(root, pathWith('node', 'corepack'))).toMatchObject({
        pm_exec: 'corepack yarn',
      })
    })

    it('reads the first yarnPath, as head -1 does', () => {
      const root = copyOf('yarn-vendored')
      writeFileSync(
        join(root, '.yarnrc.yml'),
        'yarnPath: .yarn/releases/yarn-4.13.0.cjs\nyarnPath: package.json\n',
      )
      expect(runnerOf(root, pathWith('node'))).toMatchObject({
        pm_exec: 'node .yarn/releases/yarn-4.13.0.cjs',
      })
    })

    // head -1 takes the first yarnPath before `[ -f ]` tests it, so a missing
    // first release does not fall through to the second.
    it('does not try a second yarnPath when the first names no file', () => {
      const root = copyOf('yarn-vendored')
      writeFileSync(
        join(root, '.yarnrc.yml'),
        'yarnPath: .yarn/releases/missing.cjs\nyarnPath: .yarn/releases/yarn-4.13.0.cjs\n',
      )
      expect(runnerOf(root, pathWith('node'))).toMatchObject({ pm_exec: 'yarn' })
    })

    it('reads a quoted yarnPath', () => {
      const root = copyOf('yarn-vendored')
      writeFileSync(join(root, '.yarnrc.yml'), 'yarnPath: ".yarn/releases/yarn-4.13.0.cjs"\n')
      expect(runnerOf(root, pathWith('node'))).toMatchObject({
        pm_exec: 'node .yarn/releases/yarn-4.13.0.cjs',
      })
    })
  })

  describe('the PATH lookup, as bash `command -v` does it', () => {
    it('reads an empty PATH entry as the tree root', () => {
      const root = copyOf('yarn-berry')
      writeFileSync(join(root, 'corepack'), '')
      expect(runnerOf(root, `${pathWith()}${delimiter}`)).toMatchObject({
        pm_exec: 'corepack yarn',
      })
    })

    it('reads a relative PATH entry from the tree root', () => {
      const root = copyOf('yarn-berry')
      mkdirSync(join(root, 'tools'))
      writeFileSync(join(root, 'tools', 'corepack'), '')
      expect(runnerOf(root, 'tools')).toMatchObject({ pm_exec: 'corepack yarn' })
    })

    it('finds a file that has no execute bit, as bash does', () => {
      const bin = pathWith()
      writeFileSync(join(bin, 'corepack'), '', { mode: 0o644 })
      expect(runnerOf(fixture('yarn-berry'), bin)).toMatchObject({ pm_exec: 'corepack yarn' })
    })

    it('does not find a directory', () => {
      const bin = pathWith()
      mkdirSync(join(bin, 'corepack'))
      expect(runnerOf(fixture('yarn-berry'), bin)).toMatchObject({ pm_exec: 'yarn' })
    })

    // bash uses its own default PATH here: a declared divergence (#221,
    // mid-round ruling 13).
    it('finds nothing on an absent PATH', () => {
      expect(runnerOf(fixture('yarn-berry'), undefined)).toMatchObject({ pm_exec: 'yarn' })
    })
  })
})

describe('the refusals', () => {
  const BUN = {
    outcome: 'unsupported',
    error:
      'bun is not a supported package manager. See .github/CONTRIBUTING.md to request support.',
    unsupported: 'bun',
  }

  const YARN_CLASSIC = {
    outcome: 'unsupported',
    error:
      'Yarn Classic (v1) is not supported; only Yarn Berry (v2+). See .github/CONTRIBUTING.md to request support.',
    unsupported: 'yarn-classic',
  }

  it('refuses bun as unsupported', () => {
    expect(node.detect(fixture('bun'), { PATH: pathWith() })).toEqual(BUN)
  })

  it('refuses a bun.lockb as bun too', () => {
    const root = copyOf('bun')
    renameSync(join(root, 'bun.lock'), join(root, 'bun.lockb'))
    expect(node.detect(root, { PATH: pathWith() })).toEqual(BUN)
  })

  it('refuses Yarn Classic as unsupported', () => {
    expect(node.detect(fixture('yarn-classic'), { PATH: pathWith() })).toEqual(YARN_CLASSIC)
  })

  // `grep -q '^__metadata:' yarn.lock 2>/dev/null` finds no match in a file
  // that it cannot read, so node.sh names the tree Yarn Classic.
  it.skipIf(process.getuid?.() === 0)(
    'refuses a yarn.lock that it cannot read as Yarn Classic',
    () => {
      const root = copyOf('yarn-berry')
      chmodSync(join(root, 'yarn.lock'), 0o000)
      expect(node.detect(root, { PATH: pathWith() })).toEqual(YARN_CLASSIC)
    },
  )

  it('fails for a tree with no lockfile, and names the root', () => {
    const root = fixture('no-lockfile')
    expect(node.detect(root, { PATH: pathWith() })).toEqual({
      outcome: 'failed',
      error: `No supported lockfile found in ${root}. Expected pnpm-lock.yaml, yarn.lock, or package-lock.json.`,
    })
  })
})
