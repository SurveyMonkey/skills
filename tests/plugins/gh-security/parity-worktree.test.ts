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
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** A `.git` file that git itself never writes, in a directory of its own. */
const pointer = ({ root }: Scene, content: string): string => {
  const directory = join(root, 'hand-written')
  mkdirSync(directory)
  writeFileSync(join(directory, '.git'), content)
  return directory
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
