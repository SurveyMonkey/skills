// Real git repositories in known states.
//
// Git is not mocked (mocking.md). Every fixture here is an actual repository
// with an actual (local, bare) origin. So `git fetch`, `git merge
// --ff-only`, ancestry checks, and worktree operations all behave exactly
// as they do in production. A test checks a command that deletes a branch
// or removes a worktree against what it actually did. Nothing here reaches
// the network.
//
// The package-manager builders are not here. A build before anything
// consumes them would be a horizontal slice.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { findOnPath, type Sandbox } from './sandbox.ts'

export const DEFAULT_BRANCH = 'main'

/** The result of a git command that was allowed to fail. */
export interface GitRun {
  /** null when a signal killed git, which is what spawnSync reports. */
  status: number | null
  stdout: string
  stderr: string
}

// A shim that forwards to the real git, except for the subcommands it is
// told to fail. This lets a test provoke the branches that guard an
// unreadable ref or worktree list, without damage to a repository. It uses
// `sh`, so a plugin's tests need no second runtime.
const GIT_SHIM = `#!/bin/sh
# Walk past git's own options so the comparison below sees the subcommand and
# its arguments, the way "git -C dir -c key=value fetch origin" hides "fetch".
real=__REAL_GIT__
tail=''
started=''
skip=''
for arg in "$@"; do
  if [ -n "$started" ]; then
    tail="$tail $arg"
    continue
  fi
  if [ -n "$skip" ]; then
    skip=''
    continue
  fi
  case "$arg" in
    -C|-c) skip=1 ;;
    -*) ;;
    *) started=1; tail="$arg" ;;
  esac
done
IFS=,
for failing in \${GIT_STUB_FAIL:-}; do
  [ -n "$failing" ] || continue
  case "$tail " in
    "$failing "*)
      echo "git stub: refusing $failing" >&2
      exit 1
      ;;
  esac
done
# GIT_STUB_SILENT is the other shape a git on PATH can take: exit 0 and print
# nothing. Real git answers most questions with a status, but a caller must
# survive an empty answer. It is separate from GIT_STUB_FAIL because a refusal
# and a silent success send a caller to different arms.
for silent in \${GIT_STUB_SILENT:-}; do
  [ -n "$silent" ] || continue
  case "$tail " in
    "$silent "*)
      exit 0
      ;;
  esac
done
exec "$real" "$@"
`

const FIXTURE_SUFFIX = '.fixture.md'

/** A fixture file's real name. Two names cannot be stored as themselves
 *  inside this repository. A committed `.gitignore` would apply to the
 *  fixture directory it sits in. A committed `CLAUDE.md` under `fixtures/`
 *  would be read as guidance for this repository, by every session that
 *  opened it. */
const undisguise = (name: string): string => {
  if (name === '_gitignore') return '.gitignore'
  if (!name.endsWith(FIXTURE_SUFFIX)) return name
  return `${name.slice(0, -FIXTURE_SUFFIX.length)}.md`
}

export interface GitFixtures {
  /** git in `directory`, isolated from the developer's config. Throws on a
   *  non-zero exit, and names the command and git's own stderr. */
  git(directory: string, ...args: string[]): string
  /** The same, for a command that is allowed to fail. */
  tryGit(directory: string, ...args: string[]): GitRun
  /** A work tree at `<root>/work` with the bare origin at `<root>/origin.git`. */
  create(root: string): string
  /** A work tree at `<parent>/<name>`, origin parked in `<parent>/.origins`. */
  createAt(parent: string, name: string): string
  /** One commit that adds to a tracked file. */
  commit(work: string, message: string, file?: string, content?: string): void
  /** Copy a fixture directory into `work` and commit it. This undoes the two
   *  disguises a committed fixture tree needs: `_gitignore` becomes
   *  `.gitignore`, and a `.fixture.md` suffix becomes `.md`. */
  importTree(work: string, fromDir: string): void
  /** Push a branch to origin. */
  push(work: string, branch?: string): void
  /** Create a branch and leave the checkout on the default branch. */
  branch(work: string, name: string, start?: string): void
  /** A branch that carries one real commit. */
  branchWithWork(work: string, name: string): void
  /** Fast-forward into the default branch. The branch stays AT the tip. */
  mergeFf(work: string, name: string): void
  /** Merge with a merge commit. The branch stays strictly BEHIND the tip. */
  mergeCommit(work: string, name: string): void
  /** Squash into the default branch. This leaves NO ancestry. */
  mergeSquash(work: string, name: string): void
  /** An uncommitted change to a TRACKED file, which blocks a sync. */
  dirty(work: string, file?: string): void
  /** An untracked file, which must NOT block a sync. */
  untracked(work: string, file?: string): void
  /** `git status` then exits non-zero with empty stdout. */
  corruptIndex(work: string): void
  /** Leave a git operation marker, e.g. `rebase-merge` or `MERGE_HEAD`. */
  inProgress(work: string, marker: string): void
  /** A linked worktree at `at`, checked out on `branch`. */
  worktree(work: string, at: string, branch: string): void
  /** A local-only commit plus an origin-only commit, so no fast-forward. */
  diverge(work: string): void
  /** Commit a lock file and its package.json, and push them. */
  lockfile(work: string, name: string, content?: string): void
  /** Origin gains a commit the clone lacks, so the branch can fast-forward. */
  remoteAdvance(work: string, file?: string): void
  /** Drop the `origin` remote. */
  removeOrigin(work: string): void
  /** An index lock. `git status` tolerates it; anything that writes refs refuses it. */
  lockIndex(work: string): void
  /** The remote exists but is unreachable, so fetch fails and preflight passes. */
  breakOrigin(work: string): void
  /** Drop the cached `origin/HEAD`. This forces the later resolution strategies. */
  forgetOriginHead(work: string): void
  /** Remove every remote-tracking branch, so no default branch resolves. */
  dropRemoteBranches(work: string): void
  /** The commit a revision names. */
  sha(work: string, rev: string): string
  /** The local branch names. */
  branches(work: string): string[]
  /** The commit HEAD points at. */
  headSha(work: string): string
  /** The branch HEAD is on. */
  currentBranch(work: string): string
  /** A directory whose `git` refuses the named subcommands, and the value to
   *  pass as `GIT_STUB_FAIL` beside it. Both are needed. If the directory is
   *  missing from PATH, or `GIT_STUB_FAIL` is unset, or a subcommand has a
   *  typo, the shim forwards to the real git and says nothing. Assert on the
   *  `git stub: refusing ` line, not only on a non-zero status. Otherwise a
   *  test that meant to exercise the failure passes on the success path.
   *
   *  The same shim also reads `GIT_STUB_SILENT`, a comma-separated list of
   *  subcommands. For these, it answers with exit 0 and no output at all.
   *  This is the other shape a `git` on PATH can take, and a caller must
   *  survive it. Pass it in the
   *  environment beside the directory, with or without `GIT_STUB_FAIL`.
   *  Assert on the report line the guard produces, never only on a status. */
  gitShim(...failing: string[]): { directory: string; failing: string }
}

/** The seeded origin and work tree that `create` and `createAt` copy, built
 *  once per test file. vitest loads this module again for each test file, so
 *  the template does not go from one file to the next. A new repository
 *  starts as a copy of it and one `git remote set-url`, not the ten git
 *  commands `seed` runs. No caller gets a path into it, so no test can
 *  change it. */
let template: string | undefined

/** Every template directory this module made, the template that is in use
 *  and also one that a failed build left. All of them go at the end of the
 *  file. */
const templateDirs: string[] = []

afterAll(() => {
  for (const directory of templateDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  template = undefined
})

export interface GitFixturesOptions {
  /** Seed each repository with git, and do not copy the template. Only the
   *  test that proves a copy and a seeded repository agree needs this. */
  readonly fresh?: boolean
}

/** Builders for repositories in known states, all inside one sandbox.
 *
 *  Every git call is isolated from the developer's own configuration. That
 *  configuration may set a different default branch, sign commits, install
 *  hooks, or hide untracked files. Any of these would change what a fixture
 *  actually produces. This function pins identity, signing, and hooks per
 *  command below. It pins the rest with `sandbox.env`, which holds git's
 *  config lookup inside the sandbox, instead of leaving it to HOME alone
 *  (see `sandboxEnv`).
 */
export function createGitFixtures(sandbox: Sandbox, options: GitFixturesOptions = {}): GitFixtures {
  function run(directory: string, args: string[], allowFailure: boolean): GitRun {
    const result = spawnSync(
      'git',
      [
        '-C',
        directory,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { env: sandbox.env },
    )
    // The decode happens after this check. A child that never started leaves
    // `stdout` and `stderr` undefined, not empty. Reading them first would
    // turn a missing git on PATH into a TypeError that names neither git nor
    // the PATH. This check also runs through `tryGit`, whose whole contract
    // is to hand back a result, not to throw. `spawn.ts` guards the same way.
    if (result.error) {
      throw result.error
    }
    const stdout = result.stdout.toString('utf8')
    const stderr = result.stderr.toString('utf8')
    if (!allowFailure && result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${directory}: ${stderr}`)
    }
    return { status: result.status, stdout, stderr }
  }

  /** git's output as a list of lines. No output gives an empty list, not a
   *  list that holds one empty string. */
  function lines(text: string): string[] {
    return text.split('\n').filter((line) => line !== '')
  }

  const git = (directory: string, ...args: string[]): string =>
    run(directory, args, false).stdout.trim()
  const tryGit = (directory: string, ...args: string[]): GitRun => run(directory, args, true)

  /** Turns one repository's background housekeeping off. Every repository
   *  this harness creates goes through it, including the throwaway clones
   *  {@link cloneOrigin} makes. These clones are removed soonest after a
   *  commit and a push, so they race the removal hardest. */
  function quiesce(repo: string): void {
    git(repo, 'config', 'gc.auto', '0')
    git(repo, 'config', 'maintenance.auto', 'false')
  }

  /** A bare origin, a clone of it, and one commit pushed to the default branch.
   *
   *  This uses `--initial-branch`, not a fallback for an older git. The flag
   *  has been there since git 2.28. A fixture that silently seeds `master`,
   *  where the tests say `main`, is the kind of quiet wrong answer this
   *  harness exists to refuse. An older git fails here instead, and names
   *  the command.
   */
  function seed(bare: string, work: string): string {
    const parent = path.dirname(bare)
    git(parent, 'init', '-q', '--bare', `--initial-branch=${DEFAULT_BRANCH}`, bare)
    git(parent, 'clone', '-q', bare, work)
    // This turns off background housekeeping. It is written into each
    // repository's own config, not passed with `-c`. The git processes that
    // matter here are not this harness's own; the command under test spawns
    // its own, and those would still inherit the default.
    //
    // Git spawns both settings' processes detached, and they can outlive the
    // git command that started them. They finish by writing `info/refs` and
    // `objects/info/packs`. If that write lands after the sandbox has walked
    // the tree, the removal fails with `ENOTEMPTY`, and a test that had
    // already passed then fails.
    //
    // A retry does not help, because node retries the `rmdir` call, not the
    // tree walk. `maintenance.auto` is the setting that actually fires on
    // git 2.54. `gc.auto` is its older name, set beside it so an older git
    // is covered too. A fixture repository holds a handful of objects and
    // gains nothing from a repack.
    quiesce(bare)
    quiesce(work)
    git(work, 'checkout', '-q', '-B', DEFAULT_BRANCH)
    writeFileSync(path.join(work, 'file.txt'), 'base\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'base')
    git(work, 'push', '-q', '-u', 'origin', DEFAULT_BRANCH)
    // This call is tolerated. A repository whose origin has no HEAD to
    // resolve is a state some tests want, and this is the only step that
    // would refuse it.
    tryGit(work, 'remote', 'set-head', 'origin', '--auto')
    return work
  }

  /** The template, seeded on first use with this sandbox's git. When the
   *  seed fails, `template` stays unset, so the next call tries again. */
  function templateDir(): string {
    if (template === undefined) {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'git-fixture-template-'))
      templateDirs.push(directory)
      seed(path.join(directory, 'origin.git'), path.join(directory, 'work'))
      template = directory
    }
    return template
  }

  /** A repository at `bare` and `work`: a copy of the template, with origin
   *  moved to its own `bare`. The copy has the template's config, branches,
   *  upstream and `origin/HEAD`, because `seed` made all of them before the
   *  copy. `set-url` runs with this sandbox's environment, so a git that
   *  cannot start still fails here as it does in `seed`. */
  function place(bare: string, work: string): string {
    if (options.fresh === true) return seed(bare, work)
    const from = templateDir()
    cpSync(path.join(from, 'origin.git'), bare, { recursive: true })
    cpSync(path.join(from, 'work'), work, { recursive: true })
    git(work, 'remote', 'set-url', 'origin', bare)
    return work
  }

  /** A throwaway clone of the same origin, for builders that must move
   *  origin without a change to the work tree under test. */
  function cloneOrigin(work: string): string {
    const origin = git(work, 'remote', 'get-url', 'origin')
    const scratch = mkdtempSync(path.join(sandbox.path, 'scratch-'))
    git(scratch, 'clone', '-q', origin, path.join(scratch, 'c'))
    quiesce(path.join(scratch, 'c'))
    return path.join(scratch, 'c')
  }

  /** Removes the scratch directory a {@link cloneOrigin} clone lives in.
   *  This uses the same retries that `sandbox.ts` gives its own cleanup.
   *  `force` forgives only a directory that is already gone, and this one
   *  is removed within milliseconds of a commit and a push. */
  function dropScratch(clone: string): void {
    rmSync(path.dirname(clone), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }

  const fixtures: GitFixtures = {
    git,
    tryGit,

    create(root: string): string {
      mkdirSync(root, { recursive: true })
      return place(path.join(root, 'origin.git'), path.join(root, 'work'))
    },

    createAt(parent: string, name: string): string {
      // The origins directory is hidden, so a non-recursive scan of `parent`
      // finds work trees and nothing else.
      mkdirSync(path.join(parent, '.origins'), { recursive: true })
      return place(path.join(parent, '.origins', `${name}.git`), path.join(parent, name))
    },

    commit(work: string, message: string, file = 'file.txt', content = message): void {
      const target = path.join(work, file)
      writeFileSync(target, `${content}\n`, { flag: 'a' })
      git(work, 'add', '-A')
      git(work, 'commit', '-qm', message)
    },

    importTree(work: string, fromDir: string): void {
      for (const entry of readdirSync(fromDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const from = path.join(entry.parentPath, entry.name)
        const under = path.relative(fromDir, entry.parentPath)
        const target = path.join(work, under, undisguise(entry.name))
        mkdirSync(path.dirname(target), { recursive: true })
        copyFileSync(from, target)
      }
      git(work, 'add', '-A')
      git(work, 'commit', '-qm', `import ${path.basename(fromDir)}`)
    },

    push(work: string, branch = DEFAULT_BRANCH): void {
      git(work, 'push', '-q', 'origin', branch)
    },

    branch(work: string, name: string, start = DEFAULT_BRANCH): void {
      git(work, 'branch', name, start)
    },

    branchWithWork(work: string, name: string): void {
      git(work, 'checkout', '-q', '-b', name)
      fixtures.commit(work, `work on ${name}`, `${name}.txt`, name)
      git(work, 'checkout', '-q', DEFAULT_BRANCH)
    },

    mergeFf(work: string, name: string): void {
      // Ancestry finds it, but the tip guard takes over before ancestry
      // matters.
      git(work, 'merge', '-q', '--ff-only', name)
      fixtures.push(work)
    },

    mergeCommit(work: string, name: string): void {
      // This is what a "merge commit" merge leaves behind. Ancestry is the
      // interesting signal in this state.
      git(work, 'merge', '-q', '--no-ff', '-m', `Merge ${name}`, name)
      fixtures.push(work)
    },

    mergeSquash(work: string, name: string): void {
      // Only a pull-request signal can prove this one.
      git(work, 'merge', '-q', '--squash', name)
      git(work, 'commit', '-qm', `squash ${name}`)
      fixtures.push(work)
    },

    dirty(work: string, file = 'file.txt'): void {
      writeFileSync(path.join(work, file), 'dirty\n', { flag: 'a' })
    },

    untracked(work: string, file = 'untracked.txt'): void {
      writeFileSync(path.join(work, file), 'untracked\n')
    },

    corruptIndex(work: string): void {
      // This resolves the real git dir. It does not assume `<work>/.git` is
      // a directory, which is not true in a linked worktree.
      const gitdir = git(work, 'rev-parse', '--absolute-git-dir')
      writeFileSync(path.join(gitdir, 'index'), 'GARBAGE')
    },

    inProgress(work: string, marker: string): void {
      const gitdir = git(work, 'rev-parse', '--absolute-git-dir')
      if (marker.includes('-')) {
        // rebase-merge and rebase-apply are directories. MERGE_HEAD and
        // CHERRY_PICK_HEAD are files that hold a commit.
        mkdirSync(path.join(gitdir, marker), { recursive: true })
        return
      }
      writeFileSync(path.join(gitdir, marker), `${git(work, 'rev-parse', 'HEAD')}\n`)
    },

    worktree(work: string, at: string, branch: string): void {
      git(work, 'worktree', 'add', '-q', at, branch)
    },

    diverge(work: string): void {
      const clone = cloneOrigin(work)
      fixtures.commit(clone, 'origin side')
      fixtures.push(clone)
      dropScratch(clone)
      fixtures.commit(work, 'local side', 'local.txt', 'local')
    },

    lockfile(work: string, name: string, content = '{"lockfileVersion":3}'): void {
      writeFileSync(path.join(work, name), `${content}\n`)
      writeFileSync(path.join(work, 'package.json'), '{"name":"fixture"}\n')
      git(work, 'add', '-A')
      git(work, 'commit', '-qm', `add ${name}`)
      fixtures.push(work)
    },

    remoteAdvance(work: string, file = 'file.txt'): void {
      const clone = cloneOrigin(work)
      fixtures.commit(clone, 'remote advance', file, 'advanced')
      fixtures.push(clone)
      dropScratch(clone)
    },

    removeOrigin(work: string): void {
      git(work, 'remote', 'remove', 'origin')
    },

    lockIndex(work: string): void {
      // This lets a test provoke a mid-run git failure without damage to
      // anything.
      const gitdir = git(work, 'rev-parse', '--absolute-git-dir')
      writeFileSync(path.join(gitdir, 'index.lock'), '')
    },

    breakOrigin(work: string): void {
      git(work, 'remote', 'set-url', 'origin', '/nonexistent/gone.git')
    },

    forgetOriginHead(work: string): void {
      // This ref is *symbolic*, so it must be deleted as one. `update-ref -d`
      // would leave it resolvable, and the resolution would never fall
      // through. The call is tolerated when the ref is already gone, so a
      // test can ask for the state, not for the deletion.
      tryGit(work, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    },

    dropRemoteBranches(work: string): void {
      // origin/HEAD goes first, and as a symbolic ref. `update-ref -d` is a
      // silent no-op on a symbolic ref. A loop alone would empty
      // `for-each-ref` (it skips a symref whose target is gone), while
      // `symbolic-ref refs/remotes/origin/HEAD` would still answer with the
      // branch just deleted. A command that resolves the default branch
      // that way would then read a default branch out of a repository that
      // has none. That is the state this builder exists to produce.
      fixtures.forgetOriginHead(work)
      const refs = git(work, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')
      for (const ref of lines(refs)) {
        git(work, 'update-ref', '-d', ref)
      }
    },

    sha: (work: string, rev: string) => git(work, 'rev-parse', rev),

    branches: (work: string) =>
      lines(git(work, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')),

    headSha: (work: string) => git(work, 'rev-parse', 'HEAD'),

    currentBranch: (work: string) => git(work, 'rev-parse', '--abbrev-ref', 'HEAD'),

    gitShim(...failing: string[]): { directory: string; failing: string } {
      const real = findOnPath('git', sandbox.env.PATH)
      if (real === undefined) {
        throw new Error('git is not on PATH; cannot build a shim that forwards to it')
      }
      const directory = mkdtempSync(path.join(sandbox.path, 'git-shim-'))
      // This is a shell literal, not a bare interpolation, and both halves
      // matter. The quoting protects a path that holds a space or an
      // apostrophe: without it, the literal would end early and break the
      // script. The replacer function protects a `$&` in the path: without
      // it, `$&` would act as a replacement pattern and rewrite itself.
      const quoted = `'${real.replaceAll("'", `'\\''`)}'`
      writeFileSync(
        path.join(directory, 'git'),
        GIT_SHIM.replace('__REAL_GIT__', () => quoted),
        {
          mode: 0o755,
        },
      )
      return { directory, failing: failing.join(',') }
    },
  }

  return fixtures
}
