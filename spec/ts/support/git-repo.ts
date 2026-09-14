// The git repo builder: a temp origin and a clone of it, both real
// repositories driven through the #217 git helpers, which run real `git`
// through the process runner's default spawn.
//
// Git is never mocked (mocking.md): `spec/discover_repos_spec.sh` builds real
// `git init` repositories in scratch directories, including the shapes that
// are supposed to fail, and the TypeScript side keeps that rule. What this
// module adds is the one shape those specs build by hand every time: a
// writable origin with a clone pointed at it, for the handlers that push.
//
// Identity and default branch are set per repository rather than read from
// the machine, so an example does not depend on whoever is running it.
//
// This is test infrastructure: it is not under `src/` and not in the coverage
// include.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { git } from '../../../plugins/gh-security/src/lib/git.ts'

/** The branch both repositories start on unless an example names another. */
export const DEFAULT_BRANCH = 'main'

export interface GitRepoOptions {
  readonly branch?: string
}

export interface GitRepo {
  /** The bare repository the clone pushes to. */
  readonly origin: string
  /** The working checkout an example acts in. */
  readonly clone: string
  /** The branch both are on. */
  readonly branch: string
  /** Remove both. Safe to call twice, so a `finally` can always run it. */
  readonly cleanup: () => void
}

/**
 * Run git, or throw with the envelope's own message.
 *
 * A failure here is the harness failing, not the code under test, and it has
 * to say so loudly: a builder that swallowed one would hand back a repository
 * missing the very shape the example is about.
 */
const must = (dir: string, args: readonly string[]): string => {
  const envelope = git(dir, args)
  // `outcome` rather than `isOk`: the helper's predicate narrows the success
  // arm, and it is the failure arm this needs the message from.
  if (envelope.outcome !== 'ok') throw new Error(`git repo builder: ${envelope.error}`)
  return envelope.value.stdout
}

/** Write a file, stage it and commit it, creating parent directories. */
export const commitFile = (dir: string, path: string, contents: string, message: string): void => {
  const target = join(dir, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
  must(dir, ['add', '--', path])
  must(dir, ['commit', '-q', '-m', message])
}

/**
 * A bare origin, a clone of it, and one commit on the branch, pushed.
 *
 * The origin is bare because that is what a repository that accepts a push
 * is: pushing the checked-out branch of a non-bare repository is refused, and
 * a builder that hit that would fail in the example rather than here.
 */
export const createGitRepo = (options: GitRepoOptions = {}): GitRepo => {
  const branch = options.branch ?? DEFAULT_BRANCH
  // Resolved physically on creation: on macOS `/var` really is `/private/var`,
  // and an example comparing the unresolved spelling of the remote URL would
  // pass on Linux and fail here for a reason that has nothing to do with the
  // code.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gh-security-repo-')))
  const origin = join(root, 'origin')
  const clone = join(root, 'clone')

  must(root, ['init', '-q', '--bare', origin])
  must(root, ['clone', '-q', origin, clone])
  must(clone, ['config', 'user.email', 'suite@example.test'])
  must(clone, ['config', 'user.name', 'Suite'])
  // The clone of an empty repository is on whatever branch the machine's
  // `init.defaultBranch` names, which is the one machine-dependent fact left
  // in this builder. `symbolic-ref` sets it on the unborn branch, which
  // `checkout -B` cannot do.
  must(clone, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  commitFile(clone, 'README.md', 'fixture repository\n', 'chore: root')
  must(clone, ['push', '-q', '-u', 'origin', branch])

  return {
    origin,
    clone,
    branch,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
