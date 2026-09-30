// One test per claim a builder makes. Each is checked against the
// repository it actually built. Every other test in the suite is only
// meaningful if these hold. A builder
// that quietly stopped producing its state would make them pass for the
// wrong reason.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createGitFixtures, DEFAULT_BRANCH, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

/** A sandbox, the builders, and one repository at `work`. */
function repository(): { sandbox: Sandbox; git: GitFixtures; work: string } {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  return { sandbox, git, work: git.create(sandbox.join('r')) }
}

/** Asserts that a repository will run no background housekeeping. Git
 *  spawns `gc` and `maintenance` detached, and they outlive the git that
 *  started them. If one lands after a sandbox has walked its tree, the
 *  removal fails with ENOTEMPTY, and a test that had already passed then
 *  fails too. The claim is per repository, so this asks every repository
 *  a builder leaves behind, the bare origin as much as the work tree.
 *
 *  The throwaway clones that `diverge` and `remoteAdvance` make are
 *  configured the same way, but cannot be asked here, because the
 *  builder removes them before it returns. */
function expectQuiet(git: GitFixtures, repo: string): void {
  expect(git.git(repo, 'config', '--get', 'gc.auto')).toBe('0')
  expect(git.git(repo, 'config', '--get', 'maintenance.auto')).toBe('false')
}

/** The branches git itself reports as merged into origin's default branch. */
function mergedInto(git: GitFixtures, work: string): string[] {
  return git
    .git(
      work,
      'branch',
      '--merged',
      `refs/remotes/origin/${DEFAULT_BRANCH}`,
      '--format=%(refname:short)',
    )
    .split('\n')
}

// --- the repositories ---------------------------------------------------------

it('creates a repo with a real origin and a resolvable default branch', () => {
  const { git, work, sandbox } = repository()

  expect(work).toBe(sandbox.join('r', 'work'))
  expect(existsSync(sandbox.join('r', 'origin.git', 'HEAD'))).toBe(true)
  expect(git.git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe(
    `refs/remotes/origin/${DEFAULT_BRANCH}`,
  )
  expect(git.currentBranch(work)).toBe(DEFAULT_BRANCH)
  expect(git.branches(work)).toEqual([DEFAULT_BRANCH])
  expect(git.headSha(work)).toBe(git.sha(work, `refs/remotes/origin/${DEFAULT_BRANCH}`))
  expectQuiet(git, work)
  expectQuiet(git, sandbox.join('r', 'origin.git'))
})

it('places fan-out repos directly under the scanned directory, origins hidden', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)

  const work = git.createAt(sandbox.join('fan'), 'one')

  expect(git.git(work, 'rev-parse', '--show-toplevel')).toBe(
    realpathSync(sandbox.join('fan', 'one')),
  )
  expect(readdirSync(sandbox.join('fan')).filter((name) => !name.startsWith('.'))).toEqual(['one'])
  expectQuiet(git, work)
  expectQuiet(git, sandbox.join('fan', '.origins', 'one.git'))
})

// --- the template copy ---------------------------------------------------

/** What a test can see of a repository and its origin. A commit hash contains
 *  its time, so this uses the tree and the message, not the hash. */
function shape(git: GitFixtures, work: string, bare: string) {
  const local = git
    .git(work, 'config', '--local', '--list')
    .split('\n')
    .map((line) => line.replace(bare, '<bare>'))
    .sort()
  return {
    branches: git.branches(work),
    current: git.currentBranch(work),
    originHead: git.git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD'),
    upstream: git.git(work, 'rev-parse', '--abbrev-ref', '@{upstream}'),
    tree: git.git(work, 'rev-parse', 'HEAD^{tree}'),
    log: git.git(work, 'log', '--format=%s'),
    status: git.git(work, 'status', '--porcelain'),
    config: local,
    bareRefs: git.git(bare, 'for-each-ref', '--format=%(refname)'),
    bareConfig: git.git(bare, 'config', '--local', '--list').split('\n').sort(),
  }
}

it('copies a repository that a test cannot tell from a seeded one', () => {
  const sandbox = createSandbox()
  const copied = createGitFixtures(sandbox)
  const seeded = createGitFixtures(sandbox, { fresh: true })

  const copy = copied.create(sandbox.join('copy'))
  const fresh = seeded.create(sandbox.join('fresh'))

  expect(copied.git(copy, 'remote', 'get-url', 'origin')).toBe(sandbox.join('copy', 'origin.git'))
  expect(seeded.git(fresh, 'remote', 'get-url', 'origin')).toBe(sandbox.join('fresh', 'origin.git'))
  expect(shape(copied, copy, sandbox.join('copy', 'origin.git'))).toEqual(
    shape(seeded, fresh, sandbox.join('fresh', 'origin.git')),
  )
})

it('pushes a copy to its own origin and to no other', () => {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const one = git.create(sandbox.join('one'))
  const two = git.create(sandbox.join('two'))

  git.commit(one, 'only in one')
  git.push(one)
  git.git(two, 'fetch', '-q', 'origin')

  expect(git.git(sandbox.join('one', 'origin.git'), 'log', '--format=%s', DEFAULT_BRANCH)).toBe(
    'only in one\nbase',
  )
  expect(git.git(two, 'log', '--format=%s', `origin/${DEFAULT_BRANCH}`)).toBe('base')
  // A repository made after the push still starts from the template, so the
  // push did not change the template.
  const three = git.create(sandbox.join('three'))
  expect(git.git(three, 'log', '--format=%s', `origin/${DEFAULT_BRANCH}`)).toBe('base')
})

it('fails a create when git cannot start, and does not break the next create', () => {
  // An earlier test in this file made the template, so the failure comes from
  // `set-url`. It runs with this sandbox's PATH. `git.template.test.ts` proves
  // the case where the seed fails.
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const saved = sandbox.env.PATH
  sandbox.env.PATH = sandbox.pathWithout('git')

  expect(() => git.create(sandbox.join('none'))).toThrow(/ENOENT/)

  sandbox.env.PATH = saved
  const work = git.create(sandbox.join('r'))
  expect(git.git(work, 'log', '--format=%s')).toBe('base')
})

// --- commits, branches and merges ---------------------------------------------

it('appends to a tracked file on every commit', () => {
  const { git, work } = repository()

  git.commit(work, 'second')
  git.commit(work, 'third', 'other.txt', 'contents')

  expect(readFileSync(path.join(work, 'file.txt'), 'utf8')).toBe('base\nsecond\n')
  expect(readFileSync(path.join(work, 'other.txt'), 'utf8')).toBe('contents\n')
  expect(git.git(work, 'log', '--format=%s')).toBe('third\nsecond\nbase')
})

it('pushes the branch it is asked for', () => {
  const { git, work } = repository()
  git.branchWithWork(work, 'feature')

  git.push(work, 'feature')

  expect(git.sha(work, 'refs/remotes/origin/feature')).toBe(git.sha(work, 'feature'))
})

it('creates a branch without moving the checkout', () => {
  const { git, work } = repository()
  git.branchWithWork(work, 'feature')

  git.branch(work, 'from-default')
  git.branch(work, 'from-feature', 'feature')

  expect(git.currentBranch(work)).toBe(DEFAULT_BRANCH)
  expect(git.sha(work, 'from-default')).toBe(git.headSha(work))
  expect(git.sha(work, 'from-feature')).toBe(git.sha(work, 'feature'))
})

it('gives a branch one real commit and returns to the default branch', () => {
  const { git, work } = repository()

  git.branchWithWork(work, 'feature')

  expect(git.currentBranch(work)).toBe(DEFAULT_BRANCH)
  expect(git.git(work, 'rev-list', '--count', `${DEFAULT_BRANCH}..feature`)).toBe('1')
  expect(existsSync(path.join(work, 'feature.txt'))).toBe(false)
  expect(git.git(work, 'show', 'feature:feature.txt')).toBe('feature')
})

it('leaves a fast-forwarded branch sitting exactly on the default tip', () => {
  // Ancestry finds it, but the tip guard takes over before ancestry matters.
  const { git, work } = repository()
  git.branchWithWork(work, 'ff')

  git.mergeFf(work, 'ff')

  expect(git.sha(work, 'ff')).toBe(git.sha(work, `refs/remotes/origin/${DEFAULT_BRANCH}`))
})

it('leaves a merge-committed branch in the ancestry set and strictly behind', () => {
  const { git, work } = repository()
  git.branchWithWork(work, 'mc')

  git.mergeCommit(work, 'mc')

  expect(mergedInto(git, work)).toContain('mc')
  // Strictly behind: the merge commit is the one commit the default branch has
  // that the branch does not, which is what makes ancestry the signal here and
  // the tip guard useless.
  expect(git.git(work, 'rev-list', '--count', `mc..refs/remotes/origin/${DEFAULT_BRANCH}`)).toBe(
    '1',
  )
  expect(git.sha(work, 'mc')).not.toBe(git.sha(work, `refs/remotes/origin/${DEFAULT_BRANCH}`))
})

it('leaves a squash-merged branch out of the ancestry set', () => {
  // The whole reason the pull-request signal exists.
  const { git, work } = repository()
  git.branchWithWork(work, 'sq')

  git.mergeSquash(work, 'sq')

  expect(mergedInto(git, work)).not.toContain('sq')
  expect(git.git(work, 'show', `refs/remotes/origin/${DEFAULT_BRANCH}:sq.txt`)).toBe('sq')
})

// --- work tree states ---------------------------------------------------------

it('tells a tracked modification apart from an untracked file', () => {
  const { git, work } = repository()

  git.dirty(work)
  git.untracked(work)

  // This is the runner's untrimmed stdout. So this checks the leading
  // status column exactly as git prints it.
  expect(git.tryGit(work, 'status', '--porcelain', '--untracked-files=no').stdout).toBe(
    ' M file.txt\n',
  )
  expect(git.git(work, 'status', '--porcelain')).toContain('?? untracked.txt')
})

it('dirties and leaves untracked the files it is given', () => {
  const { git, work } = repository()
  git.commit(work, 'add another', 'another.txt', 'another')

  git.dirty(work, 'another.txt')
  git.untracked(work, 'elsewhere.txt')

  expect(git.tryGit(work, 'status', '--porcelain', '--untracked-files=no').stdout).toBe(
    ' M another.txt\n',
  )
  expect(readFileSync(path.join(work, 'elsewhere.txt'), 'utf8')).toBe('untracked\n')
})

it('makes git status fail with empty stdout when the index is corrupt', () => {
  // The precise shape a fail-closed preflight guards against.
  const { git, work } = repository()

  git.corruptIndex(work)

  const status = git.tryGit(work, 'status', '--porcelain', '--untracked-files=no')
  expect(status.status).not.toBe(0)
  expect(status.stdout).toBe('')
  expect(status.stderr).not.toBe('')
})

it('leaves an in-progress marker as a directory or as a file', () => {
  const { git, work } = repository()
  const gitdir = git.git(work, 'rev-parse', '--absolute-git-dir')

  git.inProgress(work, 'rebase-merge')
  git.inProgress(work, 'MERGE_HEAD')

  // A directory, not merely something with that name: a command that reads
  // `rebase-merge/head-name` sees no rebase at all if the builder writes a
  // file, and `existsSync` alone cannot tell the two apart.
  expect(statSync(path.join(gitdir, 'rebase-merge')).isDirectory()).toBe(true)
  expect(statSync(path.join(gitdir, 'MERGE_HEAD')).isFile()).toBe(true)
  expect(readFileSync(path.join(gitdir, 'MERGE_HEAD'), 'utf8')).toBe(`${git.headSha(work)}\n`)
})

it('adds a linked worktree on a branch', () => {
  const { git, work, sandbox } = repository()
  git.branchWithWork(work, 'feature')

  git.worktree(work, sandbox.join('linked'), 'feature')

  expect(git.currentBranch(sandbox.join('linked'))).toBe('feature')
  expect(git.git(work, 'worktree', 'list')).toContain(sandbox.join('linked'))
})

// --- origin states ------------------------------------------------------------

it('produces a genuinely diverged branch', () => {
  const { git, work } = repository()

  git.diverge(work)

  git.git(work, 'fetch', '-q', 'origin')
  expect(
    git.git(
      work,
      'rev-list',
      '--count',
      '--left-right',
      `HEAD...refs/remotes/origin/${DEFAULT_BRANCH}`,
    ),
  ).toBe('1\t1')
})

it('leaves the default branch behind origin after a remote advance', () => {
  const { git, work } = repository()

  git.remoteAdvance(work)

  git.git(work, 'fetch', '-q', 'origin')
  expect(git.git(work, 'rev-list', '--count', `HEAD..refs/remotes/origin/${DEFAULT_BRANCH}`)).toBe(
    '1',
  )
})

it('advances origin through the file it is given', () => {
  const { git, work } = repository()

  git.remoteAdvance(work, 'touched.txt')

  git.git(work, 'fetch', '-q', 'origin')
  expect(git.git(work, 'show', `refs/remotes/origin/${DEFAULT_BRANCH}:touched.txt`)).toBe(
    'advanced',
  )
})

it('commits and pushes a lock file beside a package.json', () => {
  const { git, work } = repository()

  git.lockfile(work, 'pnpm-lock.yaml')

  expect(git.git(work, 'show', `refs/remotes/origin/${DEFAULT_BRANCH}:pnpm-lock.yaml`)).toBe(
    '{"lockfileVersion":3}',
  )
  expect(git.git(work, 'show', `refs/remotes/origin/${DEFAULT_BRANCH}:package.json`)).toBe(
    '{"name":"fixture"}',
  )
})

it('writes the lock file content it is given', () => {
  const { git, work } = repository()

  git.lockfile(work, 'yarn.lock', '__metadata:')

  expect(readFileSync(path.join(work, 'yarn.lock'), 'utf8')).toBe('__metadata:\n')
})

it('drops the origin remote', () => {
  const { git, work } = repository()

  git.removeOrigin(work)

  expect(git.git(work, 'remote')).toBe('')
})

it('locks the index without stopping git status', () => {
  // `git status` tolerates this; anything that writes refs refuses it.
  // So a test can provoke a mid-run failure without damage to anything.
  const { git, work } = repository()

  git.lockIndex(work)

  expect(git.tryGit(work, 'status', '--porcelain').status).toBe(0)
  expect(git.tryGit(work, 'commit', '--allow-empty', '-m', 'blocked').status).not.toBe(0)
})

it('makes origin unreachable while leaving the remote configured', () => {
  const { git, work } = repository()

  git.breakOrigin(work)

  expect(git.git(work, 'remote')).toBe('origin')
  expect(git.tryGit(work, 'fetch', 'origin').status).not.toBe(0)
})

it('forgets the cached origin HEAD, and tolerates it being gone already', () => {
  // This ref is *symbolic*, so it must be deleted as one. `update-ref
  // -d` would leave it resolvable, and the resolution would never fall
  // through.
  const { git, work } = repository()

  git.forgetOriginHead(work)
  git.forgetOriginHead(work)

  expect(git.tryGit(work, 'symbolic-ref', 'refs/remotes/origin/HEAD').status).not.toBe(0)
})

it('removes every remote-tracking branch, and tolerates there being none', () => {
  const { git, work } = repository()
  git.branchWithWork(work, 'feature')
  git.push(work, 'feature')

  git.dropRemoteBranches(work)
  git.dropRemoteBranches(work)

  expect(git.git(work, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')).toBe('')
  // for-each-ref alone is not the claim: it skips a symbolic ref whose target
  // is gone, so origin/HEAD can still answer with a branch this just deleted.
  expect(git.tryGit(work, 'symbolic-ref', 'refs/remotes/origin/HEAD').status).not.toBe(0)
  expect(git.branches(work)).toEqual(['feature', DEFAULT_BRANCH])
})

// --- the runner and the shim --------------------------------------------------

it('reports the command and git stderr when git fails', () => {
  // A builder that swallowed a failure would leave the next assertion to
  // explain a state nothing produced.
  const { git, sandbox } = repository()

  expect(() => git.git(sandbox.path, 'rev-parse', 'HEAD')).toThrow(
    /git rev-parse HEAD failed in .*not a git repository/s,
  )
})

it('reports git itself being unspawnable, rather than crashing on absent output', () => {
  // spawnSync leaves stdout and stderr undefined when the child never
  // started. So a decode of them first would raise a TypeError that
  // names neither git nor the PATH. This guard must reach `tryGit` too,
  // which promises a result, not a throw, for anything git itself
  // reports.
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  sandbox.env.PATH = sandbox.pathWithout('git')

  expect(() => git.git(sandbox.path, 'rev-parse', 'HEAD')).toThrow(/ENOENT/)
  expect(() => git.tryGit(sandbox.path, 'rev-parse', 'HEAD')).toThrow(/ENOENT/)
})

it('resolves global git config inside the sandbox, not on the developer machine', () => {
  // The three `-c` overrides cover identity, signing, and hooks.
  // Everything else in a global config still applies, so the file git
  // reads must be the sandbox's own. `status.showUntrackedFiles` is the
  // demonstration. If the developer's config reaches in instead, this
  // file's untracked assertion fails locally and passes in CI.
  const { git, work, sandbox } = repository()
  const home = sandbox.join('home')

  writeFileSync(path.join(home, '.gitconfig'), '[status]\n\tshowUntrackedFiles = no\n')

  expect(git.git(work, 'config', '--get', 'status.showUntrackedFiles')).toBe('no')
  expect(git.git(work, 'config', '--show-origin', '--get', 'status.showUntrackedFiles')).toBe(
    `file:${path.join(home, '.gitconfig')}\tno`,
  )
})

it('refuses the subcommands the shim is told to fail and forwards the rest', () => {
  const { git, work, sandbox } = repository()

  const shim = git.gitShim('worktree list', 'fetch')

  expect(shim.failing).toBe('worktree list,fetch')
  const env = {
    ...sandbox.env,
    GIT_STUB_FAIL: shim.failing,
    PATH: `${shim.directory}${path.delimiter}${sandbox.env.PATH}`,
  }
  const refused = spawnSync('git', ['-C', work, 'worktree', 'list'], { env, encoding: 'utf8' })
  expect(refused.status).toBe(1)
  expect(refused.stderr).toContain('git stub: refusing worktree list')

  const forwarded = spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' })
  expect(forwarded.status).toBe(0)
  expect(forwarded.stdout.trim()).toBe(git.headSha(work))
})

it('answers the subcommands the shim is told to silence with nothing at all', () => {
  // This is the other shape a `git` on PATH can take, the one CI
  // reached on Linux: exit 0 and print nothing. Real git answers these
  // questions with a status, so a port that only guards `null` reads the
  // silence as an answer. This is separate from GIT_STUB_FAIL, because a
  // refusal and a silent success send a caller to different arms, and
  // both must be reachable in the same run.
  const { git, work, sandbox } = repository()

  const shim = git.gitShim()

  const env = {
    ...sandbox.env,
    GIT_STUB_SILENT: 'symbolic-ref,rev-parse --short',
    PATH: `${shim.directory}${path.delimiter}${sandbox.env.PATH}`,
  }
  const silenced = spawnSync('git', ['-C', work, 'symbolic-ref', '--quiet', 'HEAD'], {
    env,
    encoding: 'utf8',
  })
  expect(silenced.status).toBe(0)
  expect(silenced.stdout).toBe('')
  expect(silenced.stderr).toBe('')

  // The prefix match is on the whole subcommand line, so the longer form is
  // silenced and the bare one still forwards.
  const alsoSilenced = spawnSync('git', ['-C', work, 'rev-parse', '--short', 'HEAD'], {
    env,
    encoding: 'utf8',
  })
  expect(alsoSilenced.stdout).toBe('')

  const forwarded = spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' })
  expect(forwarded.status).toBe(0)
  expect(forwarded.stdout.trim()).toBe(git.headSha(work))
})

it('walks past a -c option and its value before reading the subcommand', () => {
  // `-c key=value` carries its value in the next argument, so a shim
  // that read it as an ordinary option would take `key=value` for the
  // subcommand. Every refusal would stop, and every call would forward
  // silently. That is the failure `gitShim`'s own doc comment warns a
  // caller about. The test above covers `-C`; this covers the other
  // prefix the walker must skip, and the comment on GIT_SHIM names both.
  const { git, work, sandbox } = repository()

  const shim = git.gitShim('worktree list')

  const env = {
    ...sandbox.env,
    GIT_STUB_FAIL: shim.failing,
    PATH: `${shim.directory}${path.delimiter}${sandbox.env.PATH}`,
  }
  const refused = spawnSync('git', ['-c', 'core.pager=cat', '-C', work, 'worktree', 'list'], {
    env,
    encoding: 'utf8',
  })
  expect(refused.status).toBe(1)
  expect(refused.stderr).toContain('git stub: refusing worktree list')

  const forwarded = spawnSync('git', ['-C', work, '-c', 'core.pager=cat', 'rev-parse', 'HEAD'], {
    env,
    encoding: 'utf8',
  })
  expect(forwarded.status).toBe(0)
  expect(forwarded.stdout.trim()).toBe(git.headSha(work))
})

it('forwards to a real git whose path holds shell and replacement metacharacters', () => {
  // An apostrophe would end the shim's single-quoted literal, and leave
  // a script that does not parse. An unescaped `$&` would act as a
  // replacement pattern, and rewrite itself into the path.
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const odd = sandbox.join("o'brien $& bin")
  mkdirSync(odd, { recursive: true })
  writeFileSync(path.join(odd, 'git'), '#!/bin/sh\necho forwarded\n', { mode: 0o755 })
  sandbox.env.PATH = odd

  const shim = git.gitShim('fetch')

  const forwarded = spawnSync('git', ['status'], {
    env: {
      ...sandbox.env,
      GIT_STUB_FAIL: shim.failing,
      PATH: `${shim.directory}${path.delimiter}${odd}`,
    },
    encoding: 'utf8',
  })
  expect(forwarded.stderr).toBe('')
  expect(forwarded.stdout).toBe('forwarded\n')
})

it('refuses to build a shim when there is no real git to forward to', () => {
  // A shim named `git` that resolved `git` through PATH would find itself.
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  delete sandbox.env.PATH

  expect(() => git.gitShim('fetch')).toThrow(/git is not on PATH/)
})

it('imports a fixture tree, renaming the disguised names, and commits it', () => {
  // These are the two disguises a markdown fixture needs. A `.gitignore`
  // committed inside this repository would apply to the fixture
  // directory itself. An agent would pull a `CLAUDE.md` under
  // `fixtures/` into its context, as if it were guidance for this
  // repository.
  const { git, work, sandbox } = repository()
  const tree = sandbox.join('tree')
  mkdirSync(path.join(tree, 'docs'), { recursive: true })
  writeFileSync(path.join(tree, 'CLAUDE.fixture.md'), 'root text\n')
  writeFileSync(path.join(tree, '_gitignore'), 'build/\n')
  writeFileSync(path.join(tree, 'docs', 'note.fixture.md'), 'nested text\n')
  writeFileSync(path.join(tree, 'lib.ts'), 'export const x = 1\n')

  git.importTree(work, tree)

  expect(readFileSync(path.join(work, 'CLAUDE.md'), 'utf8')).toBe('root text\n')
  expect(readFileSync(path.join(work, '.gitignore'), 'utf8')).toBe('build/\n')
  expect(readFileSync(path.join(work, 'docs', 'note.md'), 'utf8')).toBe('nested text\n')
  expect(existsSync(path.join(work, 'CLAUDE.fixture.md'))).toBe(false)
  expect(existsSync(path.join(work, '_gitignore'))).toBe(false)
  // Tracked, not merely written: a reader of the tree uses `git ls-files`,
  // so a fixture left uncommitted would be invisible to it.
  expect(git.git(work, 'ls-files').split('\n').sort()).toEqual([
    '.gitignore',
    'CLAUDE.md',
    'docs/note.md',
    'file.txt',
    'lib.ts',
  ])
  expect(git.git(work, 'status', '--porcelain')).toBe('')
})
