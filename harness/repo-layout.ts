// The layout rules of .claude/rules/path-plugins.md, type-ts.md and
// file-skill-md.md, as functions over a checkout. Each one answers the
// violations it found, one entry each (the offending path, or a line naming
// it), so an empty list is the pass. They judge what git tracks, never the
// whole directory, because what ships is what is committed: an untracked
// scratch file is neither a defect nor a fix.
//
// These are functions of a root rather than of this repository, so an example
// can prove each one red against a scratch tree before it is trusted green on
// the real one (tests/repo/).

import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

import { onTestFinished } from 'vitest'

/** Every tracked path under `root`, relative to it. */
export const trackedFiles = (root: string): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '')

const PLUGIN_FILE = /^plugins\/([^/]+)\/(.+)$/

/** A top-level `bin/` in a plugin. claude.ai org sync rejects the whole plugin. */
export const binDirectories = (files: readonly string[]): string[] =>
  files.filter((path) => /^plugins\/[^/]+\/bin\//.test(path))

/** A legacy `commands/` directory in a plugin. New work uses `skills/`. */
export const commandDirectories = (files: readonly string[]): string[] =>
  files.filter((path) => /^plugins\/[^/]+\/commands\//.test(path))

/** A file an installed plugin never runs: tests, fixtures, docs, a CLAUDE.md, a package.json. */
export const developmentFiles = (files: readonly string[]): string[] =>
  files.filter((path) => {
    const match = PLUGIN_FILE.exec(path)
    if (match === null) return false
    const inner = match[2] ?? ''
    return (
      /\.test\.[cm]?[jt]s$/.test(inner) ||
      /(^|\/)fixtures\//.test(inner) ||
      /^docs\//.test(inner) ||
      /(^|\/)CLAUDE\.md$/.test(inner) ||
      /(^|\/)package\.json$/.test(inner)
    )
  })

/** A `plugins/<p>/src/lib` that is not the exact committed link `../../../lib`. */
export const libLinkViolations = (root: string, files: readonly string[]): string[] => {
  const links = new Set<string>()
  for (const path of files) {
    const match = /^(plugins\/[^/]+\/src\/lib)(\/|$)/.exec(path)
    if (match?.[1] !== undefined) links.add(match[1])
  }
  const violations: string[] = []
  for (const link of links) {
    const full = join(root, link)
    if (!lstatSync(full).isSymbolicLink()) {
      violations.push(`${link} is a directory, not the symlink ../../../lib`)
    } else if (readlinkSync(full) !== '../../../lib') {
      violations.push(`${link} points at ${readlinkSync(full)}, not ../../../lib`)
    }
  }
  return violations
}

const HASH_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]#/

/** A `#` import in shipped code. Only the root package.json resolves it, and it does not ship. */
export const packageImports = (root: string, files: readonly string[]): string[] =>
  files
    .filter((path) => /^(lib|plugins)\/.*\.[cm]?[jt]s$/.test(path))
    .filter((path) => {
      const full = join(root, path)
      return !lstatSync(full).isSymbolicLink() && HASH_IMPORT.test(readFileSync(full, 'utf8'))
    })

/** A SKILL.md that holds a command in a shell variable and expands it later. */
export const commandVariables = (root: string, files: readonly string[]): string[] => {
  const violations: string[] = []
  for (const path of files.filter((p) => /^plugins\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(p))) {
    const text = readFileSync(join(root, path), 'utf8')
    const assignments = text.matchAll(
      /^\s*(?:(?:export|local|readonly|declare(?:\s+-\S+)*)\s+)?([A-Za-z_][A-Za-z0-9_]*)=(["'(]?)(.*)$/gm,
    )
    for (const assignment of assignments) {
      const value = assignment[3] ?? ''
      if (!/^node\s/.test(value) && !value.includes('CLAUDE_PLUGIN_ROOT}/scripts/')) continue
      const name = assignment[1] ?? ''
      if (new RegExp(`\\$\\{?${name}\\b`).test(text)) violations.push(`${path}: $${name}`)
    }
  }
  return violations
}

/** Every plugin skill, as `plugins/<plugin>/skills/<skill>/SKILL.md`. */
export const pluginSkills = (files: readonly string[]): string[] =>
  files.filter((path) => /^plugins\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(path))

/** A plugin skill with no tracked `docs/flows/<plugin>/<skill>/_skill-flow.md`. */
export const missingFlows = (files: readonly string[]): string[] => {
  const tracked = new Set(files)
  return pluginSkills(files)
    .map((path) => path.split('/'))
    .map(([, plugin, , skill]) => `docs/flows/${plugin}/${skill}/_skill-flow.md`)
    .filter((flow) => !tracked.has(flow))
}

// A static import or re-export (its clause is identifiers, braces, commas,
// `*` and whitespace only, so a `from '...'` inside a message is not one), a
// side-effect import, or a dynamic import of a string literal.
const SPECIFIER =
  /^\s*(?:import|export)\s[\w\s{},*$]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm

/**
 * An import in shipped code that leaves its own tree: a relative path out of
 * `plugins/<p>/` (a plugin file reaching the root `lib/` around its
 * `src/lib` link) or out of `lib/`, or a bare package specifier. Each
 * resolves in this checkout, and none resolves for someone who installed the
 * plugin. `node:` built-ins and `#` imports (`packageImports`) are left out.
 */
export const escapingImports = (root: string, files: readonly string[]): string[] => {
  const violations: string[] = []
  for (const path of files.filter((p) => /^(lib|plugins\/[^/]+)\/.*\.[cm]?[jt]s$/.test(p))) {
    const full = join(root, path)
    if (lstatSync(full).isSymbolicLink()) continue
    const tree = path.startsWith('lib/') ? 'lib' : path.split('/').slice(0, 2).join('/')
    for (const match of readFileSync(full, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? ''
      if (specifier.startsWith('node:') || specifier.startsWith('#')) continue
      const inside =
        specifier.startsWith('.') &&
        `${normalize(join(dirname(path), specifier))}/`.startsWith(`${tree}/`)
      if (!inside) violations.push(`${path}: ${specifier}`)
    }
  }
  return violations
}

/**
 * A git repository holding exactly these files and links, all staged, and
 * removed when the calling test finishes. Call it inside a test.
 */
export const scratchTree = (
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
): string => {
  const root = mkdtempSync(join(tmpdir(), 'repo-layout-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    symlinkSync(target, join(root, path))
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}
