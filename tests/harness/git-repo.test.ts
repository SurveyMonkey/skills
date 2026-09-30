// The git repo builder's own examples. Git is never mocked (mocking.md), so
// what this asserts is that the pair the builder hands back is a real origin
// and a real clone of it: the remote is the temp origin, and a push arrives
// there.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { commitFile, createGitRepo, DEFAULT_BRANCH } from '#harness/git-repo.ts'

/** Real git, run in `dir`. The harness under test is never used to check
 *  itself, so this is a second, separate call. */
const git = (dir: string, args: readonly string[]) =>
  spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

/** git's stdout, trimmed. Throws when git failed. */
const out = (dir: string, args: readonly string[]): string => {
  const result = git(dir, args)
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

const revision = (dir: string, ref: string): string => out(dir, ['rev-parse', ref])

describe('createGitRepo', () => {
  // Mutant: a builder that hands back a clone whose remote is the machine's
  // own checkout, or a repository with no remote at all. Either passes an
  // example that only reads history, and the first push goes somewhere nobody
  // meant.
  it('clones from the temp origin it made', () => {
    const repo = createGitRepo()
    try {
      expect(out(repo.clone, ['remote', 'get-url', 'origin'])).toBe(repo.origin)
    } finally {
      repo.cleanup()
    }
  })

  it('starts the clone on a branch whose tip both sides carry', () => {
    const repo = createGitRepo()
    try {
      expect(revision(repo.clone, 'HEAD')).toBe(revision(repo.origin, DEFAULT_BRANCH))
    } finally {
      repo.cleanup()
    }
  })

  // The round trip: commit in the clone, push, and the origin carries the new
  // tip. A builder whose origin is not writable, or whose branch is not the
  // one the clone is on, fails here and nowhere else.
  it('round-trips a push to the origin', () => {
    const repo = createGitRepo()
    try {
      commitFile(repo.clone, 'fixed.txt', 'fixed\n', 'fix: something')
      out(repo.clone, ['push', '-q', 'origin', DEFAULT_BRANCH])
      expect(revision(repo.origin, DEFAULT_BRANCH)).toBe(revision(repo.clone, 'HEAD'))
    } finally {
      repo.cleanup()
    }
  })

  it('takes a branch name when the example needs one', () => {
    const repo = createGitRepo({ branch: 'trunk' })
    try {
      expect(out(repo.clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('trunk')
      expect(revision(repo.origin, 'trunk')).toBe(revision(repo.clone, 'HEAD'))
    } finally {
      repo.cleanup()
    }
  })

  it('removes both repositories on cleanup', () => {
    const repo = createGitRepo()
    repo.cleanup()
    expect(git(repo.clone, ['rev-parse', 'HEAD']).status).not.toBe(0)
  })

  it('tolerates a second cleanup', () => {
    const repo = createGitRepo()
    repo.cleanup()
    expect(() => repo.cleanup()).not.toThrow()
  })
})

describe('commitFile', () => {
  it('writes the file and commits it', () => {
    const repo = createGitRepo()
    try {
      commitFile(repo.clone, 'nested/deep.txt', 'contents\n', 'chore: nested')
      expect(readFileSync(join(repo.clone, 'nested', 'deep.txt'), 'utf8')).toBe('contents\n')
      expect(out(repo.clone, ['log', '-1', '--format=%s'])).toBe('chore: nested')
      // Nothing left behind: a builder that staged without committing would
      // leave every later example running against a dirty tree.
      expect(git(repo.clone, ['status', '--porcelain']).stdout).toBe('')
    } finally {
      repo.cleanup()
    }
  })
})
