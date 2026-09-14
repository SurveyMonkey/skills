// The git repo builder's own examples. Git is never mocked (mocking.md), so
// what this asserts is that the pair the builder hands back is a real origin
// and a real clone of it: the remote is the temp origin, and a push arrives
// there.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { unwrap } from '../../plugins/gh-security/src/lib/envelope.ts'
import { git } from '../../plugins/gh-security/src/lib/git.ts'
import { commitFile, createGitRepo, DEFAULT_BRANCH } from './support/git-repo.ts'

const revision = (dir: string, ref: string): string =>
  unwrap(git(dir, ['rev-parse', ref])).stdout.trim()

describe('createGitRepo', () => {
  // Mutant: a builder that hands back a clone whose remote is the machine's
  // own checkout, or a repository with no remote at all. Either passes an
  // example that only reads history, and the first push goes somewhere nobody
  // meant.
  it('clones from the temp origin it made', () => {
    const repo = createGitRepo()
    try {
      expect(unwrap(git(repo.clone, ['remote', 'get-url', 'origin'])).stdout.trim()).toBe(
        repo.origin,
      )
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
      unwrap(git(repo.clone, ['push', '-q', 'origin', DEFAULT_BRANCH]))
      expect(revision(repo.origin, DEFAULT_BRANCH)).toBe(revision(repo.clone, 'HEAD'))
    } finally {
      repo.cleanup()
    }
  })

  it('takes a branch name when the example needs one', () => {
    const repo = createGitRepo({ branch: 'trunk' })
    try {
      expect(unwrap(git(repo.clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe(
        'trunk',
      )
      expect(revision(repo.origin, 'trunk')).toBe(revision(repo.clone, 'HEAD'))
    } finally {
      repo.cleanup()
    }
  })

  it('removes both repositories on cleanup', () => {
    const repo = createGitRepo()
    repo.cleanup()
    expect(git(repo.clone, ['rev-parse', 'HEAD']).outcome).toBe('error')
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
      expect(unwrap(git(repo.clone, ['log', '-1', '--format=%s'])).stdout.trim()).toBe(
        'chore: nested',
      )
      // Nothing left behind: a builder that staged without committing would
      // leave every later example running against a dirty tree.
      expect(unwrap(git(repo.clone, ['status', '--porcelain'])).stdout).toBe('')
    } finally {
      repo.cleanup()
    }
  })
})
