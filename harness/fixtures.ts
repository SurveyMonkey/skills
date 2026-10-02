// The fixture loader: the vitest twin of `use_fixture` in spec/spec_helper.sh.
//
// `spec/fixtures/` is the contract. Its trees are specimens trimmed from real
// runs, never hand-authored and never re-authored (the testing skill), so an
// example that needs to write gets its own copy and the committed tree is
// read-only for the life of the suite.
//
// The filesystem is not mocked (mocking.md): these are real directories, real
// files and real copies, the same way `use_fixture` makes them.
//
// One divergence from `use_fixture`, stated because it is deliberate: that
// helper always faked a linked worktree, because every shellspec example
// drives a cwd-sensitive script through its CLI. A TypeScript example calls a
// handler instead, so the git shape is opt-in and appears only where it is
// part of what the example is testing.
//
// This is test infrastructure: it is not under `src/` and not in the coverage
// include.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The committed specimens, resolved from this file rather than from a cwd. */
export const FIXTURES_ROOT = resolve(import.meta.dirname, '..', 'spec', 'fixtures')

/**
 * The gitdir that `fakeLinkedWorktree` makes for `dir` by default. It is
 * beside `dir`, not in it. `fake_linked_worktree` writes a pointer to a path
 * that does not exist, but the TypeScript guard also requires the
 * `commondir` file that git writes into the gitdir of a linked worktree
 * (#304). So this gitdir is real.
 */
export const defaultWorktreeGitdir = (dir: string): string =>
  join(`${dir}.main`, '.git', 'worktrees', 'fix')

/**
 * Which `.git` a copy is given, if any.
 *
 *   `linked-worktree`   what `git worktree add` writes: a file carrying a
 *                       gitdir pointer. This is where a fix runs.
 *   `primary-checkout`  a directory, which is the user's own checkout and
 *                       what every cwd-sensitive script must refuse.
 *   `none`              nothing, the default.
 */
export type GitShape = 'none' | 'linked-worktree' | 'primary-checkout'

export interface FixtureOptions {
  readonly gitShape?: GitShape
  /** The gitdir a `linked-worktree` pointer names. */
  readonly gitdir?: string
}

export interface Fixture {
  /** The scratch copy. Examples read and write here, never in FIXTURES_ROOT. */
  readonly path: string
  /** Remove the copy. Safe to call twice, so a `finally` can always run it. */
  readonly cleanup: () => void
}

/**
 * Write the pointer file `git worktree add` leaves at a linked worktree root.
 * With no `gitdir`, also make the default gitdir, with its `commondir` file.
 * A named `gitdir` is written as the pointer only.
 */
export const fakeLinkedWorktree = (dir: string, gitdir?: string): void => {
  if (gitdir === undefined) {
    const made = defaultWorktreeGitdir(dir)
    mkdirSync(made, { recursive: true })
    writeFileSync(join(made, 'commondir'), '../..\n')
    writeFileSync(join(dir, '.git'), `gitdir: ${made}\n`)
    return
  }
  writeFileSync(join(dir, '.git'), `gitdir: ${gitdir}\n`)
}

/** The opposite shape: the user's own checkout, where `.git` is a directory. */
export const fakePrimaryCheckout = (dir: string): void => {
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  mkdirSync(join(dir, '.git'))
}

/**
 * Copy one committed fixture into a fresh scratch directory.
 *
 * A name no fixture carries is refused rather than answered with an empty
 * directory: that is a typo, and an example reading nothing is the
 * found-nothing-is-a-pass shape this repository refuses everywhere.
 */
export const useFixture = (name: string, options: FixtureOptions = {}): Fixture => {
  const source = join(FIXTURES_ROOT, name)
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`no fixture named ${name} under ${FIXTURES_ROOT}`)
  }
  const path = mkdtempSync(join(tmpdir(), 'gh-security-fixture-'))
  // A real recursive copy, dereferencing nothing a fixture did not itself
  // spell as a link: the specimen's own symlinks are part of what it is.
  cpSync(source, path, { recursive: true, verbatimSymlinks: true })
  const shape = options.gitShape ?? 'none'
  if (shape === 'linked-worktree') fakeLinkedWorktree(path, options.gitdir)
  if (shape === 'primary-checkout') fakePrimaryCheckout(path)
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true })
      rmSync(`${path}.main`, { recursive: true, force: true })
    },
  }
}
