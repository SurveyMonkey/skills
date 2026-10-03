// Parity for `requireLinkedWorktree` against `require-linked-worktree.sh`.
// The script answers with an exit status and a JSON error on stderr. The
// function answers with an envelope. This file compares the verdict, and the
// message word for word.
//
// Every gitdir case in the header of the script is a real repository built by
// `harness/git.ts`. The pointers that git never writes, but that the script
// must still refuse, are written by hand and named as such.
//
// The script reads `$PWD`. The paths here are real paths, so `$PWD` and the
// directory that the function is given are the same string.
//
// Declared exception (#304 item 1): the function also requires a `commondir`
// file in the gitdir of a linked worktree, and the script does not. So a
// submodule at a `worktrees/` path of a superproject cloned with
// `--separate-git-dir`, which the script passes, is refused by the function.
// A hand-written pointer that reads as a worktree gets a `commondir`. So that
// row compares only how each side reads the pointer text.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { requireLinkedWorktree } from '#gh-security/worktree.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'require-linked-worktree.sh')

const ALLOW_FILE = ['-c', 'protocol.file.allow=always']

interface Scene {
  readonly fixtures: GitFixtures
  /** A real, empty directory in the sandbox. */
  readonly root: string
}

const scene = (): Scene => {
  const sandbox = createSandbox()
  const root = join(realpathSync(sandbox.path), 'scene')
  mkdirSync(root)
  return { fixtures: createGitFixtures(sandbox), root }
}

/** A repository with one committed submodule, and the path of that submodule. */
const withSubmodule = ({ fixtures, root }: Scene, name = 'main') => {
  const source = fixtures.create(join(root, `${name}-source`))
  const main = fixtures.createAt(root, name)
  fixtures.git(main, ...ALLOW_FILE, 'submodule', 'add', '--quiet', source, 'sub')
  fixtures.git(main, 'commit', '--quiet', '-m', 'add the submodule')
  return { main, submodule: join(main, 'sub') }
}

/**
 * A `.git` file that git itself never writes, in a directory of its own.
 * `/abs` goes under the scene, and a gitdir in the scene gets a `commondir`
 * file, as git writes for a linked worktree (#304).
 */
const pointer = ({ root }: Scene, content: string): string => {
  const directory = join(root, 'hand-written')
  mkdirSync(directory)
  const text = content.replaceAll('gitdir: /abs', `gitdir: ${root}/abs`)
  writeFileSync(join(directory, '.git'), text)
  const gitdir = resolve(directory, text.slice('gitdir: '.length).split('\n', 1).join(''))
  if (text.startsWith('gitdir: ') && gitdir.startsWith(`${root}/`)) {
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'commondir'), '../..\n')
  }
  return directory
}

/**
 * A submodule at `worktrees/foo` of a superproject cloned with
 * `--separate-git-dir`. Its gitdir has no `/.git/` (#304 item 1).
 */
const separateGitDirSubmodule = ({ fixtures, root }: Scene): string => {
  const source = fixtures.create(join(root, 'source'))
  const origin = fixtures.createAt(root, 'origin')
  fixtures.git(origin, ...ALLOW_FILE, 'submodule', 'add', '--quiet', source, 'worktrees/foo')
  fixtures.git(origin, 'commit', '--quiet', '-m', 'add the submodule')
  const superproject = join(root, 'super')
  fixtures.git(
    root,
    'clone',
    '--quiet',
    '--separate-git-dir',
    join(root, 'sepgit'),
    origin,
    superproject,
  )
  fixtures.git(superproject, ...ALLOW_FILE, 'submodule', 'update', '--init', '--quiet')
  return join(superproject, 'worktrees', 'foo')
}

type Build = (scene: Scene) => string

const CASES: readonly (readonly [string, Build])[] = [
  ['the root of a primary checkout', ({ fixtures, root }) => fixtures.createAt(root, 'main')],
  [
    'a subdirectory of a primary checkout',
    ({ fixtures, root }) => {
      const main = fixtures.createAt(root, 'main')
      mkdirSync(join(main, 'packages', 'app'), { recursive: true })
      return join(main, 'packages', 'app')
    },
  ],
  [
    'a linked worktree',
    ({ fixtures, root }) => {
      const main = fixtures.createAt(root, 'main')
      fixtures.branch(main, 'fix')
      fixtures.worktree(main, join(root, 'wt'), 'fix')
      return join(root, 'wt')
    },
  ],
  [
    'a subdirectory of a linked worktree',
    ({ fixtures, root }) => {
      const main = fixtures.createAt(root, 'main')
      fixtures.branch(main, 'fix')
      fixtures.worktree(main, join(root, 'wt'), 'fix')
      mkdirSync(join(root, 'wt', 'packages', 'app'), { recursive: true })
      return join(root, 'wt', 'packages', 'app')
    },
  ],
  [
    'a linked worktree of a bare clone',
    ({ fixtures, root }) => {
      const source = fixtures.create(join(root, 'source'))
      fixtures.git(root, 'clone', '--quiet', '--bare', source, join(root, 'bare.git'))
      fixtures.git(
        join(root, 'bare.git'),
        'worktree',
        'add',
        '--quiet',
        '--detach',
        join(root, 'wtb'),
        'main',
      )
      return join(root, 'wtb')
    },
  ],
  ['a submodule', (built) => withSubmodule(built).submodule],
  [
    'a submodule checked out inside a linked worktree',
    (built) => {
      const { fixtures, root } = built
      const { main } = withSubmodule(built)
      fixtures.branch(main, 'fix')
      fixtures.worktree(main, join(root, 'wt'), 'fix')
      fixtures.git(join(root, 'wt'), ...ALLOW_FILE, 'submodule', 'update', '--init', '--quiet')
      return join(root, 'wt', 'sub')
    },
  ],
  [
    'a linked worktree of a repository under a directory named modules',
    ({ fixtures, root }) => {
      mkdirSync(join(root, 'modules'))
      const app = fixtures.createAt(join(root, 'modules'), 'app')
      fixtures.branch(app, 'fix')
      fixtures.worktree(app, join(root, 'wt'), 'fix')
      return join(root, 'wt')
    },
  ],
  [
    'a linked worktree that is itself named modules',
    ({ fixtures, root }) => {
      const main = fixtures.createAt(root, 'main')
      fixtures.branch(main, 'fix')
      fixtures.worktree(main, join(root, 'modules'), 'fix')
      return join(root, 'modules')
    },
  ],
  [
    'a directory that is not in a repository',
    ({ root }) => {
      const directory = join(root, 'plain')
      mkdirSync(directory)
      return directory
    },
  ],
  // The pointers below are written by hand: git never writes them.
  [
    'a pointer with a submodule whose path starts with worktrees',
    (built) => pointer(built, 'gitdir: ../.git/modules/worktrees/foo\n'),
  ],
  [
    'a pointer with a relative worktree gitdir',
    (built) => pointer(built, 'gitdir: ../main/.git/worktrees/wt\n'),
  ],
  [
    'a pointer with a submodule nested deep',
    (built) => pointer(built, 'gitdir: ../../.git/modules/pkgs/deep\n'),
  ],
  [
    'a pointer to a gitdir that is none of these',
    (built) => pointer(built, 'gitdir: /somewhere/else\n'),
  ],
  [
    'a pointer with a submodule under worktrees/ inside a worktree',
    (built) => pointer(built, 'gitdir: /abs/main/.git/worktrees/wt/modules/worktrees/foo\n'),
  ],
  [
    'a pointer with a line separator in the name of the worktree',
    (built) => pointer(built, 'gitdir: /abs/main/.git/worktrees/wt x/modules/worktrees/foo\n'),
  ],
  [
    'a pointer with a common dir under worktrees/ and modules/',
    (built) => pointer(built, 'gitdir: /abs/worktrees/wt/x/modules/app/.git/worktrees/fix\n'),
  ],
  [
    'a pointer with two .git/ directories',
    (built) => pointer(built, 'gitdir: /abs/.git/worktrees/x/modules/app/.git/worktrees/fix\n'),
  ],
  [
    'a pointer with a bare common dir under worktrees/ and modules/',
    (built) => pointer(built, 'gitdir: /abs/worktrees/x/modules/repo.git/worktrees/fix\n'),
  ],
  ['a pointer with no newline', (built) => pointer(built, 'gitdir: /abs/main/.git/worktrees/wt')],
  ['a pointer that is not a gitdir line', (built) => pointer(built, 'not a pointer\n')],
  ['an empty pointer', (built) => pointer(built, '')],
  ['a pointer with an empty gitdir', (built) => pointer(built, 'gitdir: \n')],
]

const verdicts = (directory: string, context?: string) => {
  const bash = runBash({
    command: SCRIPT,
    args: context === undefined ? [] : [context],
    cwd: directory,
  })
  const typescript = requireLinkedWorktree(directory, context)
  return { bash, typescript }
}

/**
 * A submodule whose path starts with `worktrees/`, checked out inside a
 * linked worktree. Its gitdir ends in `/worktrees/wt/modules/worktrees/foo`.
 * So the last `/worktrees/` marker is in the path of the submodule (round 3
 * ruling 14 on #226).
 */
const submoduleUnderWorktreesInWorktree = (built: Scene): string => {
  const { fixtures, root } = built
  const source = fixtures.create(join(root, 'main-source'))
  const main = fixtures.createAt(root, 'main')
  fixtures.git(main, ...ALLOW_FILE, 'submodule', 'add', '--quiet', source, 'worktrees/foo')
  fixtures.git(main, 'commit', '--quiet', '-m', 'add the submodule')
  fixtures.branch(main, 'fix')
  fixtures.worktree(main, join(root, 'wt'), 'fix')
  fixtures.git(join(root, 'wt'), ...ALLOW_FILE, 'submodule', 'update', '--init', '--quiet')
  return join(root, 'wt', 'worktrees', 'foo')
}

describe('requireLinkedWorktree parity', () => {
  it.each(CASES)('agrees on %s', (_name, build) => {
    const { bash, typescript } = verdicts(build(scene()))
    if (bash.status === 0) {
      expect(typescript.outcome).toBe('ok')
      return
    }
    expect(bash.status).toBe(1)
    expect(typescript).toEqual({
      outcome: 'failed',
      error: (JSON.parse(bash.stderr) as { error: string }).error,
    })
  })

  it('refuses on both sides a submodule under worktrees/ inside a linked worktree', () => {
    const { bash, typescript } = verdicts(submoduleUnderWorktreesInWorktree(scene()))
    expect(bash.status).toBe(1)
    expect(typescript).toEqual({
      outcome: 'failed',
      error: (JSON.parse(bash.stderr) as { error: string }).error,
    })
    expect(typescript.outcome === 'failed' && typescript.error).toContain(
      '/worktrees/wt/modules/worktrees/foo)',
    )
  })

  // Declared exception, #304 item 1: the script passes this submodule.
  it('differs on a submodule of a --separate-git-dir superproject (#304)', () => {
    const submodule = separateGitDirSubmodule(scene())
    const { bash, typescript } = verdicts(submodule)
    expect(bash.status).toBe(0)
    expect(typescript).toEqual({
      outcome: 'failed',
      error: `refusing to run here: ${submodule} is not a linked worktree (its gitdir ../../../sepgit/modules/worktrees/foo has no commondir file). Create the fix worktree with git worktree add and run the command as: cd <worktree> && <command>.`,
    })
  })

  it('agrees on the message when the caller names a context', () => {
    const { bash, typescript } = verdicts(scene().root, 'apply_constraint')
    expect(bash.status).toBe(1)
    expect(typescript).toEqual({
      outcome: 'failed',
      error: (JSON.parse(bash.stderr) as { error: string }).error,
    })
    expect(
      typescript.outcome === 'failed' && typescript.error.startsWith('apply_constraint: '),
    ).toBe(true)
  })
})
