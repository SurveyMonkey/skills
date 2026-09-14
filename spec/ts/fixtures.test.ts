// The fixture loader's own examples. The claim that has to hold, and the one
// the shellspec helper this replaces exists for, is that a mutating example
// never touches the committed specimen: `spec/fixtures/` is the contract, and
// an example that edited it in place would move the contract under every
// other example that reads it.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_WORKTREE_GITDIR, FIXTURES_ROOT, useFixture } from './support/fixtures.ts'

// A committed specimen with a manifest worth reading back, used here for its
// name only: nothing in this file is about what npm-cross-line contains.
const FIXTURE = 'npm-cross-line'
const COMMITTED = join(FIXTURES_ROOT, FIXTURE, 'package.json')

describe('useFixture', () => {
  it('answers a directory carrying the fixture contents', () => {
    const fixture = useFixture(FIXTURE)
    try {
      expect(readFileSync(join(fixture.path, 'package.json'), 'utf8')).toBe(
        readFileSync(COMMITTED, 'utf8'),
      )
    } finally {
      fixture.cleanup()
    }
  })

  it('answers a different directory each time, so two examples cannot collide', () => {
    const first = useFixture(FIXTURE)
    const second = useFixture(FIXTURE)
    try {
      expect(first.path).not.toBe(second.path)
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  // Mutant: a loader that hands back the committed directory itself, or that
  // copies by symlink. Either passes every read-only example and destroys the
  // specimen the first time a verb writes a manifest. The committed bytes are
  // read back after the write, and a second load answers them too.
  it('hands back a copy: a write to it leaves the committed specimen untouched', () => {
    const before = readFileSync(COMMITTED, 'utf8')
    const fixture = useFixture(FIXTURE)
    try {
      writeFileSync(join(fixture.path, 'package.json'), '{"name":"mutated"}')
      expect(readFileSync(COMMITTED, 'utf8')).toBe(before)
      const reloaded = useFixture(FIXTURE)
      try {
        expect(readFileSync(join(reloaded.path, 'package.json'), 'utf8')).toBe(before)
      } finally {
        reloaded.cleanup()
      }
    } finally {
      fixture.cleanup()
    }
  })

  // Mutant: a loader that creates the scratch directory and copies whatever
  // it finds. A fixture name nobody committed is a typo, and an empty
  // directory is the answer that lets an example pass having read nothing.
  it('refuses a name no fixture carries, naming it', () => {
    expect(() => useFixture('no-such-fixture')).toThrow(/no-such-fixture/)
  })

  it('removes the copy on cleanup', () => {
    const fixture = useFixture(FIXTURE)
    fixture.cleanup()
    expect(() => statSync(fixture.path)).toThrow()
  })

  // Cleanup is what every example runs in a `finally`, so a second call has
  // to be a no-op rather than a failure that masks the example's own.
  it('tolerates a second cleanup', () => {
    const fixture = useFixture(FIXTURE)
    fixture.cleanup()
    expect(() => fixture.cleanup()).not.toThrow()
  })
})

describe('the git shape a fixture can be given', () => {
  // The twin of `fake_linked_worktree`: the cwd guard classifies by
  // inspecting the enclosing repository's `.git`, and what `git worktree add`
  // writes at the root of a linked worktree is a FILE carrying a gitdir
  // pointer. A scratch directory is otherwise outside any repository, which
  // the guard refuses.
  it('writes the pointer file git worktree add writes', () => {
    const fixture = useFixture(FIXTURE, { gitShape: 'linked-worktree' })
    try {
      const dotGit = join(fixture.path, '.git')
      expect(statSync(dotGit).isFile()).toBe(true)
      expect(readFileSync(dotGit, 'utf8')).toBe(`gitdir: ${DEFAULT_WORKTREE_GITDIR}\n`)
    } finally {
      fixture.cleanup()
    }
  })

  it('points the worktree at a named gitdir when the example supplies one', () => {
    const fixture = useFixture(FIXTURE, {
      gitShape: 'linked-worktree',
      gitdir: '/elsewhere/.git/worktrees/other',
    })
    try {
      expect(readFileSync(join(fixture.path, '.git'), 'utf8')).toBe(
        'gitdir: /elsewhere/.git/worktrees/other\n',
      )
    } finally {
      fixture.cleanup()
    }
  })

  // The twin of `fake_primary_checkout`: the user's own checkout, which every
  // cwd-sensitive script must refuse to touch. A directory, not a file, and
  // the difference is the whole classification.
  it('writes a directory for the primary checkout the scripts must refuse', () => {
    const fixture = useFixture(FIXTURE, { gitShape: 'primary-checkout' })
    try {
      expect(statSync(join(fixture.path, '.git')).isDirectory()).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  // The default is no shape at all, which is the divergence from
  // `use_fixture` worth stating: that helper always faked a linked worktree
  // because every shellspec example drove a cwd-sensitive script. A
  // TypeScript example calls a handler, so the shape is added where it is
  // part of what is being tested and nowhere else.
  it('adds nothing when no shape is asked for', () => {
    const fixture = useFixture(FIXTURE)
    try {
      expect(() => statSync(join(fixture.path, '.git'))).toThrow()
    } finally {
      fixture.cleanup()
    }
  })
})
