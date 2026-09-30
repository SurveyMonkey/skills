// Parity for `ensure-worktree-exclude`. Both sides run against real repositories
// built by `harness/git.ts`, one copy of the same layout each, and the report and
// the resulting file are compared. Nothing is mocked: git is real, and so is the
// file system.
//
// The two sides write into two copies of one layout, so the paths in the report
// differ by the directory name only. The comparison replaces that directory with
// a marker before it compares.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { JsonValue } from '#gh-security/lib/envelope.ts'
import {
  ensureWorktreeExclude,
  LOCK_TIMING,
} from '#gh-security/subcommands/ensure-worktree-exclude.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'ensure-worktree-exclude.sh')

/** What a layout gives back: the directory that the command is run on, and the
 *  repository whose shared git directory holds the exclude file. */
interface Built {
  readonly target: string
  readonly primary: string
}

/** One layout, built twice: once under each side's root. */
type Layout = (fixtures: GitFixtures, root: string) => Built

const primaryCheckout: Layout = (fixtures, root) => {
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  fixtures.git(repo, 'init', '--quiet', '--initial-branch=main')
  return { target: repo, primary: repo }
}

const linkedWorktree: Layout = (fixtures, root) => {
  mkdirSync(root, { recursive: true })
  const repo = fixtures.createAt(root, 'repo')
  fixtures.branch(repo, 'wt-branch')
  fixtures.worktree(repo, join(root, 'wt'), 'wt-branch')
  return { target: join(root, 'wt'), primary: repo }
}

const excludeOf = (built: Built): string => join(built.primary, '.git', 'info', 'exclude')

interface Case {
  readonly name: string
  readonly layout: Layout
  /** Runs after the layout and before both sides. */
  readonly prepare?: (built: Built) => void
}

const CASES: readonly Case[] = [
  {
    name: 'a repository with an exclude file that lacks the line',
    layout: primaryCheckout,
    prepare: (built) => writeFileSync(excludeOf(built), '# user rules\nbuild/\n'),
  },
  {
    name: 'a repository with no exclude file',
    layout: primaryCheckout,
    prepare: (built) => rmSync(excludeOf(built), { force: true }),
  },
  {
    name: 'a repository with no info directory',
    layout: primaryCheckout,
    prepare: (built) =>
      rmSync(join(built.primary, '.git', 'info'), { recursive: true, force: true }),
  },
  {
    name: 'an exclude file whose last line has no newline',
    layout: primaryCheckout,
    prepare: (built) => writeFileSync(excludeOf(built), 'build/'),
  },
  {
    name: 'an exclude file that already has the line',
    layout: primaryCheckout,
    prepare: (built) => writeFileSync(excludeOf(built), 'build/\n.claude/worktrees/\n'),
  },
  {
    name: 'an empty exclude file',
    layout: primaryCheckout,
    prepare: (built) => writeFileSync(excludeOf(built), ''),
  },
  {
    name: 'a linked worktree, which resolves to the shared git directory',
    layout: linkedWorktree,
  },
]

const normalise = (value: JsonValue, root: string): JsonValue =>
  JSON.parse(JSON.stringify(value).split(root).join('<root>')) as JsonValue

describe('ensure-worktree-exclude parity', () => {
  it.each(CASES)('agrees on $name', async ({ layout, prepare }) => {
    const sandbox = createSandbox()
    const fixtures = createGitFixtures(sandbox)
    // The real path: git prints a resolved path for a linked worktree.
    const bashRoot = join(realpathSync(sandbox.path), 'bash')
    const tsRoot = join(realpathSync(sandbox.path), 'ts')
    const bashSide = layout(fixtures, bashRoot)
    const tsSide = layout(fixtures, tsRoot)
    prepare?.(bashSide)
    prepare?.(tsSide)

    const bash = runBash({ command: SCRIPT, args: [bashSide.target] })
    const typescript = await ensureWorktreeExclude(tsSide.target, sandbox.env, LOCK_TIMING)

    expect(bash.status).toBe(0)
    expect(typescript.outcome).toBe('ok')
    if (typescript.outcome !== 'ok') return
    const difference = firstDifference(
      normalise(JSON.parse(bash.stdout) as JsonValue, bashRoot),
      normalise(typescript.value, tsRoot),
    )
    expect(difference).toBeNull()
    expect(readFileSync(excludeOf(tsSide), 'utf8')).toBe(readFileSync(excludeOf(bashSide), 'utf8'))
  })

  it('refuses a directory that is not a repository with the same message', async () => {
    const sandbox = createSandbox()
    const bashDir = sandbox.join('bash')
    const tsDir = sandbox.join('ts')
    mkdirSync(bashDir)
    mkdirSync(tsDir)
    const bash = runBash({ command: SCRIPT, args: [bashDir] })
    const typescript = await ensureWorktreeExclude(tsDir, sandbox.env, LOCK_TIMING)
    expect(bash.status).toBe(1)
    expect(typescript).toEqual({
      outcome: 'failed',
      error: (JSON.parse(bash.stderr) as { error: string }).error.replace(bashDir, tsDir),
    })
  })

  it('refuses a directory that does not exist with the same message', async () => {
    const sandbox = createSandbox()
    const bash = runBash({ command: SCRIPT, args: [sandbox.join('bash-gone')] })
    const typescript = await ensureWorktreeExclude(
      sandbox.join('ts-gone'),
      sandbox.env,
      LOCK_TIMING,
    )
    expect(bash.status).toBe(1)
    expect(typescript).toEqual({
      outcome: 'failed',
      error: (JSON.parse(bash.stderr) as { error: string }).error.replace('bash-gone', 'ts-gone'),
    })
  })
})
