// `detect` for the node adapter, ported from `verb_detect`, `detect_raw`,
// `pm_runner`, `pnpm_manifest_major`, `has_workspace_overrides_block` and
// `pnpm_override_file` in node.sh (#221). The bash there is the
// specification.
//
// The lockfile precedence is pnpm, then yarn, then npm. bun and Yarn Classic
// are unsupported (ADR 001, exit 3). A tree with none of these lockfiles is a
// failure.
//
// `detect` reads the tree at `root` and the `PATH` it is given. It never
// reads `process.env` (#221, round 3 ruling 9), and it starts no process: a
// PATH lookup is a scan of directories. The caller gives an absolute `root`.
// Only a relative `root` makes node read `process.cwd()`, to resolve it.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync, type Stats, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

import { type Envelope, failed, ok, unsupported } from '../../lib/envelope.ts'
import type { Environment } from '../adapter.ts'

/** The fields that every node detection carries. */
type Common = {
  /** How to run the package manager: a bare name, `node <yarnPath>`, or `corepack <name>`. */
  readonly pm_exec: string
  readonly install_cmd: string
  readonly why_cmd: string
  readonly supports_scoping: true
}

/** What `detect` finds in a tree that one of the three supported managers owns. */
export type NodeDetection =
  | (Common & {
      readonly pm: 'pnpm'
      readonly lockfile: 'pnpm-lock.yaml'
      readonly override_location: 'pnpm.overrides'
      readonly override_file: 'package.json' | 'pnpm-workspace.yaml'
      /** The major that `packageManager` pins, or null when it pins no pnpm major. */
      readonly pnpm_major: number | null
      readonly override_syntax: 'parent>dep'
    })
  | (Common & {
      readonly pm: 'yarn'
      readonly lockfile: 'yarn.lock'
      readonly override_location: 'resolutions'
      readonly override_file: 'package.json'
      readonly override_syntax: 'parent/dep'
    })
  | (Common & {
      readonly pm: 'npm'
      readonly lockfile: 'package-lock.json'
      readonly override_location: 'overrides'
      readonly override_file: 'package.json'
      readonly override_syntax: 'nested'
    })

/** The stat of `path`, after symlinks, or null when there is nothing there. */
const statOf = (path: string): Stats | null => {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** `[ -f path ]`: a regular file, after symlinks. */
const isFile = (path: string): boolean => statOf(path)?.isFile() === true

/**
 * The lines of a file, or none when this process cannot read it. `grep` and
 * `sed` find no match in a file that they cannot read, and node.sh reads
 * that as "no match".
 */
const linesOf = (path: string): readonly string[] => {
  try {
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return []
  }
}

/**
 * `command -v tool`, as bash answers it for a PATH that is set. Each PATH
 * entry is a directory. An empty entry is the current directory, which is
 * `root` here, and a relative entry is relative to `root`. Any `entry/tool`
 * that exists and is not a directory is a match, with or without its execute
 * bit. bash also names a file that it cannot run.
 *
 * An absent PATH has no entries here. bash uses its own default PATH for it.
 * That difference is a declared divergence (#221, mid-round ruling 13).
 */
const onPath = (tool: string, root: string, env: Environment): boolean =>
  env.PATH === undefined
    ? false
    : env.PATH.split(delimiter).some((entry) => {
        const stats = statOf(resolve(root, entry, tool))
        return stats !== null && !stats.isDirectory()
      })

// jq reads a byte order mark at the start of the file. `JSON.parse` does not.
const BYTE_ORDER_MARK = /^\uFEFF/

// jq reads a file that holds only JSON white space as no document, and
// writes nothing. For both of the jq programs below, that answer is the same
// as the answer for a top level of null. jq also reads a file of two or more
// documents, and `JSON.parse` refuses it. That difference is a declared
// divergence (#221, mid-round ruling 13).
const NO_DOCUMENT = /^[ \t\n\r]*$/

/** What {@link manifestOf} answers for a manifest that is absent or does not parse. */
const UNREADABLE = Symbol('unreadable')

/** `package.json` at `root`, parsed, null when it holds no document, or {@link UNREADABLE}. */
const manifestOf = (root: string): unknown => {
  try {
    const text = readFileSync(join(root, 'package.json'), 'utf8').replace(BYTE_ORDER_MARK, '')
    return NO_DOCUMENT.test(text) ? null : JSON.parse(text)
  } catch {
    return UNREADABLE
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `jq -e '.packageManager // empty' package.json`: the manifest is an object
 * whose `packageManager` is present, and is not null or false.
 */
const declaresPackageManager = (root: string): boolean => {
  const manifest = manifestOf(root)
  const field = isRecord(manifest) ? manifest.packageManager : undefined
  return field !== undefined && field !== null && field !== false
}

// `sed -n 's/^yarnPath:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p'`.
// `[[:space:]]` is spelled out: `\s` in JavaScript also matches Unicode space.
const YARN_PATH = /^yarnPath:[ \t\n\v\f\r]*"?([^"]*)"?[ \t\n\v\f\r]*$/

/** The first `yarnPath` of `.yarnrc.yml`, or '' when there is none. */
const yarnPathOf = (root: string): string =>
  linesOf(join(root, '.yarnrc.yml'))
    .map((line) => YARN_PATH.exec(line))
    .find((match) => match !== null)?.[1] ?? ''

/**
 * `pm_runner`: how to run `candidate`. A bare binary on PATH comes first.
 * For yarn, the release that `.yarnrc.yml` vendors comes next, when node is
 * on PATH. corepack is the last choice, and only when the manifest names a
 * `packageManager`.
 */
const runnerOf = (candidate: 'pnpm' | 'yarn' | 'npm', root: string, env: Environment): string => {
  if (onPath(candidate, root, env)) return candidate
  if (candidate === 'yarn' && isFile(join(root, '.yarnrc.yml')) && onPath('node', root, env)) {
    const yarnPath = yarnPathOf(root)
    if (yarnPath !== '' && isFile(resolve(root, yarnPath))) return `node ${yarnPath}`
  }
  return onPath('corepack', root, env) && declaresPackageManager(root)
    ? `corepack ${candidate}`
    : candidate
}

const PNPM_MAJOR = /^pnpm@([0-9]+)/

/**
 * `pnpm_manifest_major`: the digits of the pnpm major that `packageManager`
 * pins, '' when it pins no pnpm major, or null when jq stops. jq stops on a
 * manifest that is absent or that it cannot parse. It also stops on a top
 * level that is not an object or null, and on a `packageManager` that is not
 * a string, null or false.
 */
const pnpmMajorOf = (root: string): string | null => {
  const manifest = manifestOf(root)
  if (manifest === null) return ''
  if (!isRecord(manifest)) return null
  const field = manifest.packageManager ?? false
  if (field === false) return ''
  if (typeof field !== 'string') return null
  return PNPM_MAJOR.exec(field)?.[1] ?? ''
}

/** `has_workspace_overrides_block`: a top-level `overrides:` key, plain or quoted. */
export const hasWorkspaceOverrides = (root: string): boolean => {
  const path = join(root, 'pnpm-workspace.yaml')
  return isFile(path) && linesOf(path).some((line) => /^['"]?overrides['"]?:/.test(line))
}

/** `detect_raw`: which lockfile the tree has, in precedence order. */
const lockfileOf = (
  root: string,
): 'pnpm' | 'yarn-berry' | 'yarn-classic' | 'npm' | 'bun' | null => {
  if (isFile(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  const yarnLock = join(root, 'yarn.lock')
  if (isFile(yarnLock)) {
    // A Berry lockfile has a `__metadata` block. A Classic one does not.
    return linesOf(yarnLock).some((line) => line.startsWith('__metadata:'))
      ? 'yarn-berry'
      : 'yarn-classic'
  }
  if (isFile(join(root, 'package-lock.json'))) return 'npm'
  if (['bun.lock', 'bun.lockb'].some((name) => isFile(join(root, name)))) return 'bun'
  return null
}

/** `verb_detect`. */
export const detect = (root: string, env: Environment): Envelope<NodeDetection> => {
  switch (lockfileOf(root)) {
    case 'pnpm': {
      const run = runnerOf('pnpm', root, env)
      const major = pnpmMajorOf(root)
      if (major === null) return failed("detect: cannot read package.json's packageManager field")
      // `Number` does not keep a very long major exact. A major of more than
      // 18 digits is a declared divergence (#221, mid-round ruling 13).
      const pnpmMajor = major === '' ? null : Number(major)
      return ok({
        pm: 'pnpm',
        pm_exec: run,
        lockfile: 'pnpm-lock.yaml',
        install_cmd: `${run} install`,
        why_cmd: `${run} why`,
        override_location: 'pnpm.overrides',
        // pnpm 11 reads its overrides from pnpm-workspace.yaml only (#159).
        override_file:
          hasWorkspaceOverrides(root) || (pnpmMajor !== null && pnpmMajor >= 11)
            ? 'pnpm-workspace.yaml'
            : 'package.json',
        pnpm_major: pnpmMajor,
        override_syntax: 'parent>dep',
        supports_scoping: true,
      })
    }
    case 'yarn-berry': {
      const run = runnerOf('yarn', root, env)
      return ok({
        pm: 'yarn',
        pm_exec: run,
        lockfile: 'yarn.lock',
        install_cmd: `${run} install`,
        why_cmd: `${run} why`,
        override_location: 'resolutions',
        override_file: 'package.json',
        override_syntax: 'parent/dep',
        supports_scoping: true,
      })
    }
    case 'npm': {
      const run = runnerOf('npm', root, env)
      return ok({
        pm: 'npm',
        pm_exec: run,
        lockfile: 'package-lock.json',
        install_cmd: `${run} install`,
        why_cmd: `${run} explain`,
        override_location: 'overrides',
        override_file: 'package.json',
        override_syntax: 'nested',
        supports_scoping: true,
      })
    }
    case 'bun':
      return unsupported('bun', 'bun is not a supported package manager.')
    case 'yarn-classic':
      return unsupported(
        'yarn-classic',
        'Yarn Classic (v1) is not supported; only Yarn Berry (v2+).',
      )
    case null:
      return failed(
        `No supported lockfile found in ${root}. Expected pnpm-lock.yaml, yarn.lock, or package-lock.json.`,
      )
  }
}
