// The template that `create` copies, when its seed fails. vitest loads
// `git.ts` again for each test file, so in this file no template is there
// before the test below. In `git.test.ts` an earlier test always makes one,
// and a failure there comes from `set-url`, not from the seed.
//
// Keep this test the first `create` in this file. A `create` above it makes
// the template, and then the test does not reach the seed.
import { expect, it } from 'vitest'
import { createGitFixtures } from '#harness/git.ts'
import { createSandbox } from '#harness/sandbox.ts'

it('seeds the template again after a seed that failed', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const saved = sandbox.env.PATH
  sandbox.env.PATH = sandbox.pathWithout('git')

  // No git, so the seed fails at its first command.
  expect(() => git.create(sandbox.join('none'))).toThrow(/ENOENT/)

  // A template that the failed seed left would have no repository in it,
  // and the copy would fail. The seed must run again.
  sandbox.env.PATH = saved
  const work = git.create(sandbox.join('r'))
  expect(git.git(work, 'log', '--format=%s')).toBe('base')
  expect(git.git(work, 'remote', 'get-url', 'origin')).toBe(sandbox.join('r', 'origin.git'))
})
