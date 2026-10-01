// `requireLinkedWorktree`. Every gitdir case in the header of the guard is a
// real repository built by `harness/git.ts`, and the expected verdict is written
// by hand from that header. A pointer that git never writes is a hand-made
// `.git` file. The bash script is compared in `parity-worktree.test.ts`.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, relative as relative_ } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONTEXT, requireLinkedWorktree } from '#gh-security/worktree.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ALLOW_FILE = ['-c', 'protocol.file.allow=always']

const HINT =
  'Create the fix worktree with git worktree add and run the command as: cd <worktree> && <command>.'

interface Scene {
  readonly fixtures: GitFixtures
  readonly root: string
}

const scene = (): Scene => {
  const sandbox = createSandbox()
  const root = join(realpathSync(sandbox.path), 'scene')
  mkdirSync(root)
  return { fixtures: createGitFixtures(sandbox), root }
}

const refusal = (reason: string, context = DEFAULT_CONTEXT) => ({
  outcome: 'failed',
  error: `${context}: ${reason}. ${HINT}`,
})

const linkedWorktree = (
  { fixtures, root }: Scene,
  at = 'wt',
): { main: string; worktree: string } => {
  const main = fixtures.createAt(root, 'main')
  fixtures.branch(main, 'fix')
  const worktree = join(root, at)
  fixtures.worktree(main, worktree, 'fix')
  return { main, worktree }
}

const withSubmodule = ({ fixtures, root }: Scene) => {
  const source = fixtures.create(join(root, 'source'))
  const main = fixtures.createAt(root, 'main')
  fixtures.git(main, ...ALLOW_FILE, 'submodule', 'add', '--quiet', source, 'sub')
  fixtures.git(main, 'commit', '--quiet', '-m', 'add the submodule')
  return main
}

/** A directory whose `.git` is a file that holds `content`. */
const pointerAt = ({ root }: Scene, content: string): string => {
  const directory = join(root, 'hand-written')
  mkdirSync(directory)
  writeFileSync(join(directory, '.git'), content)
  return directory
}

/** The gitdir that git wrote into a `.git` file, read for the message only. */
const gitdirOfPointer = (directory: string): string =>
  readFileSync(join(directory, '.git'), 'utf8').slice('gitdir: '.length).trim()

describe('requireLinkedWorktree: real repositories', () => {
  it('accepts a linked worktree, and answers with its top', () => {
    const built = scene()
    const { worktree } = linkedWorktree(built)
    expect(requireLinkedWorktree(worktree)).toEqual({ outcome: 'ok', value: worktree })
  })

  it('accepts a subdirectory of a linked worktree, and answers with the top', () => {
    const built = scene()
    const { worktree } = linkedWorktree(built)
    mkdirSync(join(worktree, 'packages', 'app'), { recursive: true })
    expect(requireLinkedWorktree(join(worktree, 'packages', 'app'))).toEqual({
      outcome: 'ok',
      value: worktree,
    })
  })

  it('accepts a linked worktree of a bare clone', () => {
    const { fixtures, root } = scene()
    const source = fixtures.create(join(root, 'source'))
    fixtures.git(root, 'clone', '--quiet', '--bare', source, join(root, 'bare.git'))
    const worktree = join(root, 'wtb')
    fixtures.git(join(root, 'bare.git'), 'worktree', 'add', '--quiet', '--detach', worktree, 'main')
    expect(requireLinkedWorktree(worktree)).toEqual({ outcome: 'ok', value: worktree })
  })

  it('accepts a worktree of a repository that lives under a directory named modules', () => {
    const { fixtures, root } = scene()
    mkdirSync(join(root, 'modules'))
    const app = fixtures.createAt(join(root, 'modules'), 'app')
    fixtures.branch(app, 'fix')
    const worktree = join(root, 'wt')
    fixtures.worktree(app, worktree, 'fix')
    expect(requireLinkedWorktree(worktree)).toEqual({ outcome: 'ok', value: worktree })
  })

  it('accepts a linked worktree that is itself named modules', () => {
    const built = scene()
    const { worktree } = linkedWorktree(built, 'modules')
    expect(requireLinkedWorktree(worktree)).toEqual({ outcome: 'ok', value: worktree })
  })

  it('refuses the root of a primary checkout', () => {
    const { fixtures, root } = scene()
    const main = fixtures.createAt(root, 'main')
    expect(requireLinkedWorktree(main)).toEqual(
      refusal(`this is a primary checkout (${main}/.git is a directory)`),
    )
  })

  it('refuses a subdirectory of a primary checkout, and names the checkout', () => {
    const { fixtures, root } = scene()
    const main = fixtures.createAt(root, 'main')
    mkdirSync(join(main, 'packages', 'app'), { recursive: true })
    expect(requireLinkedWorktree(join(main, 'packages', 'app'))).toEqual(
      refusal(`this is a subdirectory of the primary checkout at ${main}`),
    )
  })

  it('refuses a submodule, whose gitdir pointer is relative', () => {
    const built = scene()
    const main = withSubmodule(built)
    expect(requireLinkedWorktree(join(main, 'sub'))).toEqual(
      refusal('this is a git submodule (its gitdir is ../.git/modules/sub)'),
    )
  })

  it('refuses a submodule checked out inside a linked worktree', () => {
    const built = scene()
    const main = withSubmodule(built)
    built.fixtures.branch(main, 'fix')
    const worktree = join(built.root, 'wt')
    built.fixtures.worktree(main, worktree, 'fix')
    built.fixtures.git(worktree, ...ALLOW_FILE, 'submodule', 'update', '--init', '--quiet')
    const result = requireLinkedWorktree(join(worktree, 'sub'))
    expect(result).toEqual(
      refusal(`this is a git submodule (its gitdir is ${gitdirOfPointer(join(worktree, 'sub'))})`),
    )
    expect(gitdirOfPointer(join(worktree, 'sub'))).toContain('/worktrees/wt/modules/sub')
  })

  // Round 3 ruling 14 on #226. The gitdir ends in
  // `/worktrees/wt/modules/worktrees/foo`. So the last `/worktrees/` marker
  // is in the path of the submodule, with no `/modules/` after it.
  it('refuses a submodule under worktrees/ checked out inside a linked worktree', () => {
    const built = scene()
    const source = built.fixtures.create(join(built.root, 'source'))
    const main = built.fixtures.createAt(built.root, 'main')
    built.fixtures.git(main, ...ALLOW_FILE, 'submodule', 'add', '--quiet', source, 'worktrees/foo')
    built.fixtures.git(main, 'commit', '--quiet', '-m', 'add the submodule')
    built.fixtures.branch(main, 'fix')
    const worktree = join(built.root, 'wt')
    built.fixtures.worktree(main, worktree, 'fix')
    built.fixtures.git(worktree, ...ALLOW_FILE, 'submodule', 'update', '--init', '--quiet')
    const submodule = join(worktree, 'worktrees', 'foo')
    expect(gitdirOfPointer(submodule)).toContain('/worktrees/wt/modules/worktrees/foo')
    expect(requireLinkedWorktree(submodule)).toEqual(
      refusal(`this is a git submodule (its gitdir is ${gitdirOfPointer(submodule)})`),
    )
  })

  it('refuses a directory that is not in a repository, and names it', () => {
    const { root } = scene()
    mkdirSync(join(root, 'plain'))
    expect(requireLinkedWorktree(join(root, 'plain'))).toEqual(
      refusal(`no git repository at or above ${join(root, 'plain')}`),
    )
  })
})

describe('requireLinkedWorktree: pointers that are written by hand', () => {
  it.each([
    ['gitdir: ../.git/modules/worktrees/foo', 'this is a git submodule'],
    ['gitdir: ../../.git/modules/pkgs/deep', 'this is a git submodule'],
    ['gitdir: ../../main/.git/worktrees/wt/modules/sub', 'this is a git submodule'],
    ['gitdir: /somewhere/else', 'is not a linked worktree'],
    ['gitdir: ../main/.git/worktrees/wt', null],
    ['gitdir: /abs/bare.git/worktrees/wt', null],
    ['gitdir: /abs/modules/app/.git/worktrees/fix', null],
    ['gitdir: /abs/main/.git/worktrees/modules', null],
    ['gitdir: /abs/main/.git/worktrees/wt\nsecond line', null],
    ['gitdir: /abs/main/.git/worktrees/x/modules/app', 'this is a git submodule'],
    ['gitdir: /abs/worktrees/x/modules/app/.git/worktrees/fix', null],
    ['gitdir: /abs/main/.git/worktrees/wt/modules/worktrees/foo', 'this is a git submodule'],
    ['gitdir: ../../../main/.git/worktrees/wt/modules/worktrees/foo', 'this is a git submodule'],
    ['gitdir: /abs/bare.git/worktrees/wt/modules/worktrees/foo', 'this is a git submodule'],
    ['gitdir: worktrees/wt/modules/worktrees/foo', 'this is a git submodule'],
    [
      'gitdir: /abs/worktrees/x/modules/app/.git/worktrees/wt/modules/worktrees/foo',
      'this is a git submodule',
    ],
    ['gitdir: /abs/worktrees/wt/x/modules/app/.git/worktrees/fix', null],
  ])('reads %j', (content, refusedAs) => {
    const built = scene()
    const directory = pointerAt(built, content)
    const result = requireLinkedWorktree(directory)
    if (refusedAs === null) {
      expect(result).toEqual({ outcome: 'ok', value: directory })
    } else {
      expect(result.outcome).toBe('failed')
      expect(result.outcome === 'failed' && result.error).toContain(refusedAs)
    }
  })

  it('refuses a submodule with the gitdir in the message, word for word', () => {
    const directory = pointerAt(scene(), 'gitdir: ../../.git/modules/pkgs/deep\n')
    expect(requireLinkedWorktree(directory)).toEqual(
      refusal('this is a git submodule (its gitdir is ../../.git/modules/pkgs/deep)'),
    )
  })

  it('refuses a gitdir that is none of these, and names the top', () => {
    const directory = pointerAt(scene(), 'gitdir: /somewhere/else\n')
    expect(requireLinkedWorktree(directory)).toEqual(
      refusal(`${directory} is not a linked worktree (its gitdir is /somewhere/else)`),
    )
  })

  it.each([
    ['is empty', ''],
    ['is not a gitdir line', 'not a pointer\n'],
    ['has an empty gitdir', 'gitdir: \n'],
    ['names the gitdir on a second line', '\ngitdir: /abs/main/.git/worktrees/wt\n'],
  ])('refuses a .git file that %s as no readable pointer', (_name, content) => {
    const directory = pointerAt(scene(), content)
    expect(requireLinkedWorktree(directory)).toEqual(
      refusal(`${directory}/.git is not a readable git worktree pointer`),
    )
  })

  it.skipIf(process.getuid?.() === 0)('refuses a .git file that cannot be read', () => {
    const directory = pointerAt(scene(), 'gitdir: /abs/main/.git/worktrees/wt\n')
    chmodSync(join(directory, '.git'), 0o000)
    expect(requireLinkedWorktree(directory)).toEqual(
      refusal(`${directory}/.git is not a readable git worktree pointer`),
    )
  })

  it('walks past a .git that is a link to nothing, and finds none', () => {
    const { root } = scene()
    const directory = join(root, 'dangling')
    mkdirSync(directory)
    symlinkSync(join(root, 'nowhere'), join(directory, '.git'))
    expect(requireLinkedWorktree(directory)).toEqual(
      refusal(`no git repository at or above ${directory}`),
    )
  })
})

describe('requireLinkedWorktree: a relative directory', () => {
  it('walks up from a relative path, as from the absolute one', () => {
    const built = scene()
    const { worktree } = linkedWorktree(built)
    mkdirSync(join(worktree, 'sub'))
    const relative = join(relative_(process.cwd(), worktree), 'sub')
    expect(requireLinkedWorktree(relative)).toEqual({ outcome: 'ok', value: worktree })
  })

  // A vitest worker cannot change its cwd, so `.` needs a process of its own.
  const WORKTREE_MODULE = new URL('../../../plugins/gh-security/src/worktree.ts', import.meta.url)
  const guardFrom = (cwd: string, directory: string): unknown =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { requireLinkedWorktree } from ${JSON.stringify(WORKTREE_MODULE.href)}
console.log(JSON.stringify(requireLinkedWorktree(${JSON.stringify(directory)})))`,
        ],
        { cwd, encoding: 'utf8' },
      ),
    )

  it('walks up from the dot of a subdirectory of a linked worktree', () => {
    const built = scene()
    const { worktree } = linkedWorktree(built)
    mkdirSync(join(worktree, 'sub'))
    expect(guardFrom(join(worktree, 'sub'), '.')).toEqual({ outcome: 'ok', value: worktree })
  })

  it('names the primary checkout, and not a subdirectory, for the dot of its root', () => {
    const built = scene()
    const { main } = linkedWorktree(built)
    expect(guardFrom(main, '.')).toEqual(
      refusal(`this is a primary checkout (${join(main, '.git')} is a directory)`),
    )
  })

  it('names the absolute path in the refusal for a relative path with no repository', () => {
    const { root } = scene()
    expect(guardFrom(root, '.')).toEqual(refusal(`no git repository at or above ${root}`))
  })
})

describe('requireLinkedWorktree: the message', () => {
  it('starts with the context that the caller names', () => {
    const { root } = scene()
    mkdirSync(join(root, 'plain'))
    expect(requireLinkedWorktree(join(root, 'plain'), 'apply_constraint')).toEqual(
      refusal(`no git repository at or above ${join(root, 'plain')}`, 'apply_constraint'),
    )
  })
})
