// The git helpers. Git is never mocked (the testing skill's mocking.md), so
// every example below runs real `git` against real repositories built with
// `git init` in scratch directories, exactly as `spec/discover_repos_spec.sh`
// does. The one exception is the empty-directory guard, which exists to
// prove a command is NEVER run: its whole verdict is that the spawn was not
// reached, which only a substituted spawn can observe.
import { describe, expect, it } from 'vitest'
import { git } from '../../plugins/gh-security/src/lib/git.ts'
import type { RunRequest } from '../../plugins/gh-security/src/lib/process-runner.ts'

describe('git', () => {
  // `git -C ""` is not an error and it is not a no-op: git silently operates
  // on the current directory, so one empty path would put a
  // `worktree remove --force` or a `branch -D` in the user's own checkout
  // (issue #18). The assertion is that nothing ran at all.
  it('refuses an empty directory without running anything', () => {
    const seen: RunRequest[] = []
    const spawn = (request: RunRequest) => {
      seen.push(request)
      return { command: request.command, args: request.args, status: 0, stdout: '', stderr: '' }
    }
    const envelope = git('', ['branch', '-D', 'fix/lodash-4'], { spawn })
    expect(envelope.outcome).toBe('error')
    expect(seen).toEqual([])
  })
})
