// Parity for `detect-scope` (RFC 002, "Parity is the migration strategy"). It
// runs `scripts/common/detect-scope.sh` and the TypeScript command on the same
// real repositories, and compares the exit status and the whole answer. `git`
// is never mocked (`mocking.md`): every fixture is a real repository in a
// scratch directory, with a literal `origin` URL. `gh` is the one mock
// boundary. The bash script never calls it.
//
// One difference is declared (rulings 5 and 11 on #225, the fix for #167).
// When the remote host is `github.com`, the port reads `default_branch` from
// GitHub, where the script reads the local `origin/HEAD` symref. The rows
// below give the mock the same branch that the symref names, so every field is
// compared. The stale-symref row gives a different branch, and asserts the
// difference. A remote on another host reads the symref in both, and the unit
// tests hold that.
//
// Three more differences are declared, and held by the unit tests:
//   - A failed read from GitHub is an error in the port. The script has no
//     such read.
//   - A remote whose `HEAD branch` is `(unknown)` gives a null `default_branch`
//     in the port. The script answers the text `(unknown)` as a branch name.
//   - The port reads an unknown option as an error. The script reads it as a
//     path.
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonObject, type JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { detectScope } from '#gh-security/subcommands/detect-scope.ts'
import { createGhMock, type GhReplies } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'detect-scope.sh')

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly root: string
}

const world = (): World => {
  const sandbox = createSandbox()
  const root = join(realpathSync(sandbox.path), 'w')
  mkdirSync(root)
  return { sandbox, fixtures: createGitFixtures(sandbox), root }
}

/** A repository in a directory with a plain name, and `origin` set to `remote`. */
const repoWith = (w: World, remote?: string, symref = 'main'): string => {
  const dir = join(w.root, 'plain-directory-name')
  mkdirSync(dir)
  w.fixtures.git(dir, 'init', '-q')
  if (remote !== undefined) {
    w.fixtures.git(dir, 'remote', 'add', 'origin', remote)
    w.fixtures.git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${symref}`)
  }
  return dir
}

const typescriptSide = async (
  w: World,
  args: readonly string[],
  replies: GhReplies,
  cwd: string,
): Promise<CommandResult> => {
  const context: CommandContext = {
    args,
    env: w.sandbox.env,
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
    commandNames: [],
  }
  return detectScope(context, () => createGhMock(replies), run, cwd)
}

const answerOf = (result: CommandResult): { status: number; json: JsonObject | undefined } => {
  if (result === undefined) throw new Error('detect-scope answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value as JsonObject }
  return { status: exitCodeFor(result), json: undefined }
}

/** The GitHub reply that agrees with the symref `main`. */
const MAIN: GhReplies = { viewDefaultBranch: { name: 'main' } }

/** Both sides answer exit 0 with the same fields. Returns the common answer. */
const expectSame = async (
  w: World,
  target: string | undefined,
  replies: GhReplies = MAIN,
  cwd = process.cwd(),
): Promise<JsonObject> => {
  const args = target === undefined ? [] : [target]
  const bash = runBash({ command: SCRIPT, args, cwd })
  const typescript = answerOf(await typescriptSide(w, args, replies, cwd))
  expect(bash.status).toBe(0)
  expect(typescript.status).toBe(0)
  expect(firstDifference(JSON.parse(bash.stdout) as JsonValue, typescript.json as JsonValue)).toBe(
    null,
  )
  return typescript.json as JsonObject
}

describe('detect-scope parity: the nwo of a host-bearing origin URL', () => {
  it.each([
    ['https://github.com/example-org/example-repo.git', 'example-org', 'example-repo'],
    ['https://github.com/example-org/example-repo', 'example-org', 'example-repo'],
    ['git@github.com:octo/app.git', 'octo', 'app'],
    ['ssh://git@github.com/octo/app.git', 'octo', 'app'],
    ['ssh://git@github.com:2222/octo/app.git', 'octo', 'app'],
    ['https://user:pass@github.com/octo/app.git', 'octo', 'app'],
    ['gh-alias:octo/app.git', 'octo', 'app'],
    ['https://github.com/Owner/My.Repo.git', 'Owner', 'My.Repo'],
    ['https://github.com/octo/app/', 'octo', 'app'],
  ])('parses %s', async (remote, owner, repo) => {
    const w = world()
    const answer = await expectSame(w, repoWith(w, remote))
    expect(answer).toMatchObject({ scope: 'repo', owner, repo, nwo: `${owner}/${repo}` })
  })
})

describe('detect-scope parity: a remote that names no GitHub repository', () => {
  it.each([
    ['/example/src/other-repo'],
    ['file:///example/src/other-repo'],
    ['../sibling'],
    ['https://gitlab.example.com/a/b/c.git'],
    ['git@github.com:owner'],
    ['https://github.com/'],
  ])('answers a null nwo for %s, and reads the symref', async (remote) => {
    const w = world()
    // No reply is registered for GitHub, so a call to it throws.
    const answer = await expectSame(w, repoWith(w, remote), {})
    expect(answer).toMatchObject({
      scope: 'repo',
      owner: null,
      repo: null,
      nwo: null,
      git_remote: remote,
      default_branch: 'main',
    })
  })
})

describe('detect-scope parity: the scope', () => {
  it('answers repo scope from inside a subdirectory of the checkout', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    mkdirSync(join(dir, 'src', 'components'), { recursive: true })
    const answer = await expectSame(w, join(dir, 'src', 'components'))
    expect(answer).toMatchObject({ scope: 'repo', nwo: 'octo/app' })
  })

  it('stays repo scope with a null nwo when the repository has no origin', async () => {
    const w = world()
    const answer = await expectSame(w, repoWith(w), {})
    expect(answer).toMatchObject({
      scope: 'repo',
      owner: null,
      repo: null,
      nwo: null,
      git_remote: null,
      default_branch: null,
    })
  })

  it('answers a null scope outside any repository, echoing the path', async () => {
    const w = world()
    const plain = join(w.root, '@example-org', 'example-repo')
    mkdirSync(plain, { recursive: true })
    const answer = await expectSame(w, plain, {})
    expect(answer).toEqual({
      scope: null,
      owner: null,
      repo: null,
      nwo: null,
      path: plain,
      git_remote: null,
      default_branch: null,
    })
  })

  it('answers a null scope for a path that does not exist', async () => {
    const w = world()
    expect(await expectSame(w, '/no/such/directory/anywhere', {})).toMatchObject({ scope: null })
  })

  it('accepts a relative path argument, resolved against the working directory', async () => {
    const w = world()
    repoWith(w, 'https://github.com/octo/app.git')
    const answer = await expectSame(w, 'plain-directory-name', MAIN, w.root)
    expect(answer).toMatchObject({ nwo: 'octo/app', path: join(w.root, 'plain-directory-name') })
  })

  it('defaults to the working directory', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    expect(await expectSame(w, undefined, MAIN, dir)).toMatchObject({ nwo: 'octo/app', path: dir })
  })

  it('reports a null scope for a bare repository', async () => {
    const w = world()
    const bare = join(w.root, 'origin.git')
    w.fixtures.git(w.root, 'init', '-q', '--bare', bare)
    expect(await expectSame(w, bare, {})).toMatchObject({ scope: null, nwo: null })
  })

  it('answers repo scope from inside a linked worktree', async () => {
    const w = world()
    const dir = repoWith(w, 'https://github.com/octo/app.git')
    w.fixtures.git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    w.fixtures.git(dir, 'worktree', 'add', '-q', join(w.root, 'linked'), '-b', 'topic')
    expect(await expectSame(w, join(w.root, 'linked'))).toMatchObject({
      scope: 'repo',
      nwo: 'octo/app',
    })
  })
})

describe('detect-scope parity: default_branch with no nwo', () => {
  it('falls back to remote show when origin/HEAD was never recorded', async () => {
    const w = world()
    const work = w.fixtures.createAt(w.root, 'checkout')
    w.fixtures.forgetOriginHead(work)
    expect(await expectSame(w, work, {})).toMatchObject({ nwo: null, default_branch: 'main' })
  })

  it('answers null when the fallback cannot answer either', async () => {
    const w = world()
    const work = w.fixtures.createAt(w.root, 'checkout')
    w.fixtures.forgetOriginHead(work)
    w.fixtures.git(work, 'remote', 'set-url', 'origin', join(w.root, 'absent.git'))
    expect(await expectSame(w, work, {})).toMatchObject({ nwo: null, default_branch: null })
  })
})

describe('detect-scope parity: the declared exception, default_branch from GitHub (#167)', () => {
  it('answers the branch GitHub names where the script answers a stale symref', async () => {
    const w = world()
    // The checkout was cloned when the default branch was `main`. GitHub now
    // names `develop`, and `git fetch` never refreshed the symref.
    const dir = repoWith(w, 'https://github.com/octo/app.git', 'main')
    const bash = JSON.parse(runBash({ command: SCRIPT, args: [dir] }).stdout) as JsonObject
    const typescript = answerOf(
      await typescriptSide(w, [dir], { viewDefaultBranch: { name: 'develop' } }, process.cwd()),
    )
    expect(bash.default_branch).toBe('main')
    expect(typescript.json?.default_branch).toBe('develop')
    const { default_branch: _bash, ...bashRest } = bash
    const { default_branch: _typescript, ...typescriptRest } = typescript.json as JsonObject
    expect(firstDifference(bashRest, typescriptRest)).toBeNull()
  })
})
