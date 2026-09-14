// The git helpers. Git is never mocked (the testing skill's mocking.md), so
// every query example below runs real `git` through the default spawn against
// real repositories built with `git init` in scratch directories, exactly as
// `spec/discover_repos_spec.sh` does.
//
// Two things a real repository cannot show are covered through the runner's
// documented spawn parameter instead: that the empty-directory guard runs
// NOTHING, and that a configured `env_prefix` reaches the argv. Both are
// claims about the invocation rather than about git's answer.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseEnvPrefix } from '../../plugins/gh-security/src/lib/env-prefix.ts'
import { isOk, unwrap } from '../../plugins/gh-security/src/lib/envelope.ts'
import {
  AGENT_WORKTREE_SEGMENT,
  containsDotDot,
  git,
  gitCommonDir,
  gitRun,
  isGitRepository,
  isWorktreeRegistered,
  listWorktrees,
  readRef,
  resolveExistingAncestor,
  topLevel,
  validateBranchName,
  withinAgentWorktrees,
} from '../../plugins/gh-security/src/lib/git.ts'
import type { RunRequest } from '../../plugins/gh-security/src/lib/process-runner.ts'

// Scratch roots are resolved physically on creation: on macOS `/var` really
// is `/private/var`, and a fixture that compared the unresolved spelling
// would pass on Linux and fail here for a reason that has nothing to do with
// the code.
const scratches: string[] = []
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gh-security-git-')))
  scratches.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true })
})

// A real repository with one commit. The identity and the default branch are
// set per invocation rather than read from the machine, so the examples do
// not depend on whoever is running them.
const repository = (): string => {
  const root = scratch()
  const gitArgs = [
    ['-c', 'init.defaultBranch=main', 'init', '-q'],
    ['config', 'user.email', 'suite@example.test'],
    ['config', 'user.name', 'Suite'],
    ['commit', '-q', '--allow-empty', '-m', 'root'],
  ]
  for (const args of gitArgs) {
    const envelope = git(root, args)
    if (!isOk(envelope)) throw new Error(JSON.stringify(envelope))
  }
  return root
}

const recordingSpawn = () => {
  const seen: RunRequest[] = []
  const spawn = (request: RunRequest) => {
    seen.push(request)
    return { command: request.command, args: request.args, status: 0, stdout: 'ok\n', stderr: '' }
  }
  return { spawn, seen }
}

describe('gitRun', () => {
  // `git -C ""` is not an error and it is not a no-op: git silently operates
  // on the current directory, so one empty path would put a
  // `worktree remove --force` or a `branch -D` in the user's own checkout
  // (issue #18). The assertion is that nothing ran at all.
  it('refuses an empty directory without running anything', () => {
    const { spawn, seen } = recordingSpawn()
    const envelope = gitRun('', ['branch', '-D', 'fix/lodash-4'], { spawn })
    expect(envelope).toEqual({
      outcome: 'error',
      error:
        "refusing to run 'git branch -D fix/lodash-4' with an empty directory: " +
        "git -C '' operates on the current directory, which is how a " +
        "repo-targeted write lands in the user's checkout (#18).",
    })
    expect(seen).toEqual([])
  })

  it('answers with the result whatever the exit status', () => {
    const root = repository()
    const envelope = gitRun(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'])
    expect(isOk(envelope)).toBe(true)
    expect(unwrap(envelope).status).toBe(1)
  })

  // The prefix reaches the argv, composed after git's own `-C` locator: it
  // injects environment, it does not chdir.
  it('runs git under a configured env_prefix', () => {
    const { spawn, seen } = recordingSpawn()
    gitRun('/w/fix', ['status', '--porcelain'], {
      spawn,
      envPrefix: parseEnvPrefix('run-in exec /src/app'),
    })
    expect(seen).toEqual([
      {
        command: 'run-in',
        args: ['exec', '/src/app', 'git', '-C', '/w/fix', 'status', '--porcelain'],
      },
    ])
  })
})

describe('git', () => {
  it('carries the empty-directory refusal through, so no caller can miss it', () => {
    const { spawn, seen } = recordingSpawn()
    expect(git('', ['worktree', 'remove', '--force', '/w/fix'], { spawn }).outcome).toBe('error')
    expect(seen).toEqual([])
  })

  // Quoting git means git's own words, not only the frame around them: a
  // `describeRun` that always rendered `no output` would still carry
  // `failed (exit`, so the assertion reaches for what git wrote.
  it('is a failure quoting git when the command exits non-zero', () => {
    const root = repository()
    const envelope = git(root, ['rev-parse', '--verify', 'refs/heads/nope'])
    expect(envelope.outcome).toBe('error')
    const error = envelope.outcome === 'error' && envelope.error
    expect(error).toContain('git -C')
    expect(error).toContain('failed (exit 128): fatal: Needed a single revision')
  })
})

describe('isGitRepository', () => {
  it('is true inside a repository and false outside one', () => {
    expect(isGitRepository(repository())).toBe(true)
    expect(isGitRepository(scratch())).toBe(false)
  })
})

describe('topLevel', () => {
  it('answers the repository root from a subdirectory of it', () => {
    const root = repository()
    mkdirSync(join(root, 'packages', 'app'), { recursive: true })
    expect(unwrap(topLevel(join(root, 'packages', 'app')))).toBe(root)
  })

  it('is a failure outside a repository', () => {
    expect(topLevel(scratch()).outcome).toBe('error')
  })
})

describe('gitCommonDir', () => {
  // git answers `.git` for a primary checkout and an absolute path for a
  // linked worktree. The scripts that read it re-anchor the relative answer
  // themselves; a caller that forgot to would look for
  // `<cwd>/.git/worktrees/` and find nothing, which reads as no worktree
  // registered rather than as a path it never checked.
  it('is absolute for a primary checkout, where git answers relatively', () => {
    const root = repository()
    expect(unwrap(gitCommonDir(root))).toBe(join(root, '.git'))
  })

  it('is the same directory seen from a linked worktree', () => {
    const root = repository()
    const worktree = join(root, AGENT_WORKTREE_SEGMENT, 'fix')
    unwrap(git(root, ['worktree', 'add', '-q', '-b', 'fix/lodash-4', worktree]))
    expect(unwrap(gitCommonDir(worktree))).toBe(join(root, '.git'))
  })

  it('is a failure outside a repository', () => {
    expect(gitCommonDir(scratch()).outcome).toBe('error')
  })
})

describe('readRef', () => {
  it('answers the tip of a ref that exists', () => {
    const root = repository()
    const head = unwrap(readRef(root, 'refs/heads/main'))
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(head).toBe(unwrap(readRef(root, 'HEAD')))
  })

  // The distinction this helper exists for. `rev-parse --verify --quiet`
  // answers a missing ref with empty stdout, exit 1 and no stderr; a real
  // failure writes stderr. Folding them together reports a branch as absent
  // on a repository the read never managed to reach, which is how a
  // stale-branch guard passes on a repository it never read.
  it('answers null for a ref that does not exist', () => {
    expect(unwrap(readRef(repository(), 'refs/heads/never-created'))).toBeNull()
  })

  it('carries the empty-directory refusal rather than answering null', () => {
    const { spawn, seen } = recordingSpawn()
    expect(readRef('', 'refs/heads/main', { spawn }).outcome).toBe('error')
    expect(seen).toEqual([])
  })

  it('is a failure, not a null, when the read itself failed', () => {
    const envelope = readRef(scratch(), 'refs/heads/main')
    expect(envelope.outcome).toBe('error')
    expect(envelope.outcome === 'error' && envelope.error).toContain('not a git repository')
  })
})

describe('listWorktrees', () => {
  it('lists the checkout itself and every linked worktree', () => {
    const root = repository()
    const worktree = join(root, AGENT_WORKTREE_SEGMENT, 'fix')
    unwrap(git(root, ['worktree', 'add', '-q', '-b', 'fix/lodash-4', worktree]))
    expect(unwrap(listWorktrees(root))).toEqual([root, worktree])
  })

  it('is a failure outside a repository', () => {
    expect(listWorktrees(scratch()).outcome).toBe('error')
  })
})

describe('isWorktreeRegistered', () => {
  // A live registration must come off through git; a plain leftover
  // directory is a `rm -rf`. Reading a leftover directory as a registration,
  // or the reverse, leaves the registration under
  // `<git-common-dir>/worktrees/` behind, which blocks a later
  // `worktree add` and `branch -D`.
  it('tells a live registration from a directory of the same name', () => {
    const root = repository()
    const live = join(root, AGENT_WORKTREE_SEGMENT, 'fix')
    const leftover = join(root, AGENT_WORKTREE_SEGMENT, 'stale')
    unwrap(git(root, ['worktree', 'add', '-q', '-b', 'fix/lodash-4', live]))
    mkdirSync(leftover, { recursive: true })
    expect(unwrap(isWorktreeRegistered(root, live))).toBe(true)
    expect(unwrap(isWorktreeRegistered(root, leftover))).toBe(false)
  })

  it('is a failure outside a repository', () => {
    expect(isWorktreeRegistered(scratch(), '/w/fix').outcome).toBe('error')
  })
})

describe('validateBranchName', () => {
  it('returns the name git would accept', () => {
    expect(unwrap(validateBranchName('fix/lodash-4', repository()))).toBe('fix/lodash-4')
  })

  // Separate from the format check because `check-ref-format` accepts
  // `refs/heads/-D` happily, and that name reaches `git branch -D <name>` as
  // an option rather than as a ref.
  it('refuses a leading dash, which check-ref-format accepts', () => {
    const root = repository()
    expect(validateBranchName('-D', root)).toEqual({
      outcome: 'error',
      error: 'branch name must not begin with a dash: -D',
    })
    expect(unwrap(git(root, ['check-ref-format', 'refs/heads/-D'])).status).toBe(0)
  })

  it.each([['fix/'], ['fix..4'], ['fix branch'], ['fix~1']])(
    'refuses %s, which git rejects',
    (name) => {
      expect(validateBranchName(name, repository())).toEqual({
        outcome: 'error',
        error: `not a valid branch name: ${name}`,
      })
    },
  )
})

// A git that exits 0 having printed nothing has answered nothing, and reading
// that as a value is the found-nothing-is-a-pass shape this repository refuses
// everywhere (ADR 001). No real git produces it, so the only way to reach the
// guard is through the runner's documented spawn parameter, which is what
// stands in for the process boundary here.
describe('a git that answers nothing', () => {
  const silentGit = (request: RunRequest) => ({
    command: request.command,
    args: request.args,
    status: 0,
    stdout: '\n',
    stderr: '',
  })

  it('is a failure from topLevel rather than an empty repository root', () => {
    expect(topLevel('/src/app', { spawn: silentGit })).toEqual({
      outcome: 'error',
      error: 'git rev-parse --show-toplevel answered nothing',
    })
  })

  it('is a failure from gitCommonDir rather than a path resolved from nothing', () => {
    expect(gitCommonDir('/src/app', { spawn: silentGit }).outcome).toBe('error')
  })

  it('is a failure from readRef rather than a tip of the empty string', () => {
    expect(readRef('/src/app', 'HEAD', { spawn: silentGit }).outcome).toBe('error')
  })

  // `worktree list` always reports at least the checkout it was asked about,
  // so an empty list is a parse that found nothing. Read as an answer, it
  // says no worktree is registered, and the registration under
  // `<git-common-dir>/worktrees/` survives the delete that follows.
  it('is a failure from listWorktrees rather than a repository with none', () => {
    expect(listWorktrees('/src/app', { spawn: silentGit })).toEqual({
      outcome: 'error',
      error: 'git worktree list answered nothing',
    })
  })
})

describe('resolveExistingAncestor', () => {
  it('resolves a path that exists', () => {
    const root = scratch()
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    expect(resolveExistingAncestor(join(root, 'a', 'b'))).toBe(join(root, 'a', 'b'))
  })

  // The idempotent case: a reap that runs twice finds the worktree gone, and
  // resolving only the immediate parent would fail the containment guard on
  // the second run because `.claude/worktrees/` is gone too.
  it('resolves the deepest ancestor that exists and re-appends the rest', () => {
    const root = scratch()
    expect(resolveExistingAncestor(join(root, AGENT_WORKTREE_SEGMENT, 'fix'))).toBe(
      join(root, AGENT_WORKTREE_SEGMENT, 'fix'),
    )
  })

  // The load-bearing case: a link is followed before the prefix test sees the
  // path, so a worktree path that really lives elsewhere cannot be smuggled
  // past containment. The link points at a directory OUTSIDE the repository,
  // because a link into the repository would resolve to a path the guard
  // accepts anyway and the example would prove nothing.
  it('follows a symlink out of the tree, so containment sees where it lands', () => {
    const root = scratch()
    const elsewhere = scratch()
    mkdirSync(join(root, AGENT_WORKTREE_SEGMENT), { recursive: true })
    symlinkSync(elsewhere, join(root, AGENT_WORKTREE_SEGMENT, 'fix'))
    const resolved = resolveExistingAncestor(join(root, AGENT_WORKTREE_SEGMENT, 'fix', 'pkg'))
    expect(resolved).toBe(join(elsewhere, 'pkg'))
    expect(withinAgentWorktrees(root, resolved)).toBe(false)
  })

  it('resolves a path with no existing ancestor below the root', () => {
    expect(resolveExistingAncestor('/gh-security-no-such-top/fix')).toBe(
      '/gh-security-no-such-top/fix',
    )
  })
})

describe('containsDotDot', () => {
  it.each([['/a/../b'], ['/a/..'], ['../a'], ['..']])('is true for %s', (path) => {
    expect(containsDotDot(path)).toBe(true)
  })

  // A segment that merely starts with dots is not a traversal. Refusing
  // `..hidden` would refuse a legitimate directory name.
  it.each([['/a/..b'], ['/a/b..'], ['/a/...'], ['/a/b']])('is false for %s', (path) => {
    expect(containsDotDot(path)).toBe(false)
  })
})

describe('withinAgentWorktrees', () => {
  const root = '/src/app'
  const worktrees = `${root}/${AGENT_WORKTREE_SEGMENT}`

  it('accepts a directory under this repository agent worktree root', () => {
    expect(withinAgentWorktrees(root, `${worktrees}/fix`)).toBe(true)
    expect(withinAgentWorktrees(root, `${worktrees}/fix/packages/app`)).toBe(true)
  })

  // The root itself is never accepted: the operation behind this guard is
  // `rm -rf`, and accepting the root deletes every agent's worktree at once.
  it('refuses the worktree root itself', () => {
    expect(withinAgentWorktrees(root, worktrees)).toBe(false)
    expect(withinAgentWorktrees(root, `${worktrees}/`)).toBe(false)
  })

  it.each([
    ['/src/app/packages/app'],
    ['/src/other/.claude/worktrees/fix'],
    ['/src'],
    ['/src/app-other/.claude/worktrees/fix'],
  ])('refuses %s, which is outside it', (candidate) => {
    expect(withinAgentWorktrees(root, candidate)).toBe(false)
  })

  it.each([
    [root, `${worktrees}/fix/../../../etc`],
    ['/src/app/..', `${worktrees}/fix`],
  ])('refuses a path carrying a .. segment', (repoRoot, candidate) => {
    expect(withinAgentWorktrees(repoRoot, candidate)).toBe(false)
  })
})

// One end-to-end shape, because the guard and the resolver are only ever
// correct together: the reap's own question, asked of a real repository.
describe('the containment guard over a real worktree', () => {
  it('accepts this repository own worktree and refuses a link out of it', () => {
    const root = repository()
    const worktree = join(root, AGENT_WORKTREE_SEGMENT, 'fix')
    unwrap(git(root, ['worktree', 'add', '-q', '-b', 'fix/lodash-4', worktree]))
    writeFileSync(join(worktree, 'note.txt'), 'x')
    expect(withinAgentWorktrees(root, resolveExistingAncestor(worktree))).toBe(true)

    const elsewhere = scratch()
    symlinkSync(elsewhere, join(root, AGENT_WORKTREE_SEGMENT, 'smuggled'))
    expect(
      withinAgentWorktrees(
        root,
        resolveExistingAncestor(join(root, AGENT_WORKTREE_SEGMENT, 'smuggled')),
      ),
    ).toBe(false)
  })
})
