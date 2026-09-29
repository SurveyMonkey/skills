// The layout rules of .claude/rules/path-plugins.md and type-ts.md. Each
// check is proven red on a scratch tree that breaks its rule, then held green
// on this repository. The expected values are the rule's own words: the
// offending path, never a count read back from the code.
import { describe, expect, it } from 'vitest'

import { REPO_ROOT } from '#harness/paths.ts'
import {
  binDirectories,
  commandDirectories,
  developmentFiles,
  libLinkViolations,
  packageImports,
  scratchTree,
  trackedFiles,
} from '#harness/repo-layout.ts'

const repo = trackedFiles(REPO_ROOT)

describe('no top-level bin/ in a plugin', () => {
  it('names a plugin that carries one', () => {
    const root = scratchTree({ 'plugins/p/bin/p.ts': '', 'plugins/p/scripts/p.ts': '' })
    expect(binDirectories(trackedFiles(root))).toEqual(['plugins/p/bin/p.ts'])
  })

  it('holds for this repository', () => {
    expect(binDirectories(repo)).toEqual([])
  })
})

describe('no commands/ in a plugin', () => {
  it('names a plugin that carries one', () => {
    const root = scratchTree({ 'plugins/p/commands/x.md': '' })
    expect(commandDirectories(trackedFiles(root))).toEqual(['plugins/p/commands/x.md'])
  })

  it('holds for this repository', () => {
    expect(commandDirectories(repo)).toEqual([])
  })
})

describe('a plugin holds only its run-time files', () => {
  it('names a test, a fixture, a doc, a CLAUDE.md and a package.json', () => {
    const root = scratchTree({
      'plugins/p/src/x.test.ts': '',
      'plugins/p/tests/fixtures/a.json': '',
      'plugins/p/scripts/CLAUDE.md': '',
      'plugins/p/docs/GUIDE.md': '',
      'plugins/p/package.json': '{}',
      'plugins/p/src/x.ts': '',
      'tests/plugins/p/x.test.ts': '',
    })
    expect(developmentFiles(trackedFiles(root)).sort()).toEqual([
      'plugins/p/docs/GUIDE.md',
      'plugins/p/package.json',
      'plugins/p/scripts/CLAUDE.md',
      'plugins/p/src/x.test.ts',
      'plugins/p/tests/fixtures/a.json',
    ])
  })

  it('holds for this repository', () => {
    expect(developmentFiles(repo)).toEqual([])
  })
})

describe('plugins/<p>/src/lib is the exact link ../../../lib', () => {
  it('names a link with another spelling that resolves to the same place', () => {
    const root = scratchTree({ 'lib/a.ts': '' }, { 'plugins/p/src/lib': '../../../lib/' })
    expect(libLinkViolations(root, trackedFiles(root))).toEqual([
      'plugins/p/src/lib points at ../../../lib/, not ../../../lib',
    ])
  })

  it('names a directory where the link belongs', () => {
    const root = scratchTree({ 'plugins/p/src/lib/a.ts': '' })
    expect(libLinkViolations(root, trackedFiles(root))).toEqual([
      'plugins/p/src/lib is a directory, not the symlink ../../../lib',
    ])
  })

  it('holds for this repository, which has the link', () => {
    expect(repo).toContain('plugins/gh-security/src/lib')
    expect(libLinkViolations(REPO_ROOT, repo)).toEqual([])
  })
})

describe('no # import in shipped code', () => {
  it('names a static and a dynamic # import, and not one in a test', () => {
    const root = scratchTree({
      'lib/a.ts': "import { x } from '#lib/b.ts'\n",
      'plugins/p/src/c.ts': "const m = await import('#p/d.ts')\n",
      'plugins/p/src/ok.ts': "import { y } from './lib/b.ts'\n",
      'tests/lib/a.test.ts': "import { x } from '#lib/a.ts'\n",
    })
    expect(packageImports(root, trackedFiles(root)).sort()).toEqual([
      'lib/a.ts',
      'plugins/p/src/c.ts',
    ])
  })

  it('holds for this repository', () => {
    expect(packageImports(REPO_ROOT, repo)).toEqual([])
  })
})
