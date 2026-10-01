// Parity for `discover-repos` (RFC 002, "Parity is the migration strategy").
// It runs `scripts/common/discover-repos.sh` and the TypeScript command on the
// same real directories, and compares the exit status and the whole answer.
// `git` is never mocked (`mocking.md`): every fixture is a real repository in
// a scratch directory, built the way `spec/discover_repos_spec.sh` builds it.
//
// An error is compared as a class. Both sides exit 1, and the script writes
// nothing to stdout. The words differ where the script prints the shell's
// own text, so each row names the phrase that both sides must carry.
//
// Declared differences, none of them compared here:
//   - The script writes its error as JSON on stderr and leaves stdout empty.
//     The CLI renders every failure as JSON on stdout and prose on stderr
//     (`cli.md`), so the port does the same. The exit status is the same.
//   - The script needs `jq` and answers `jq is required` without it. The port
//     needs no `jq`.
//   - The script prints the shell's text for a child it cannot enter. The port
//     prints node's text. The phrase `could not enter` is the same.
//   - The script splits a resolved path that holds a newline into two list
//     entries. The port keeps the path whole. This is a fault of the script.
//   - The port refuses a child whose name holds U+FFFD, the mark that node
//     writes for a byte that is not UTF-8. The script keeps the bytes, and
//     `jq` writes the same mark. The unit tests hold this refusal.
//   - The script runs `--` and a leading dash as a path. The port reads them
//     as options. The unit tests hold the refusal.
//   - The mount boundary needs a real mount. The script's own suite mounts a
//     disk image on macOS. The unit tests hold the walk with a device seam.
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { discoverRepos, nodeDeps } from '#gh-security/subcommands/discover-repos.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

const SCRIPT = pluginFile('gh-security', 'scripts', 'common', 'discover-repos.sh')

const isRoot = process.getuid?.() === 0

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  /** The resolved scratch directory. */
  readonly root: string
}

const world = (): World => {
  const sandbox = createSandbox()
  const root = join(realpathSync(sandbox.path), 'w')
  mkdirSync(root)
  return { sandbox, fixtures: createGitFixtures(sandbox), root }
}

const initRepo = ({ fixtures }: World, directory: string, ...extra: string[]): void => {
  mkdirSync(directory, { recursive: true })
  fixtures.git(directory, 'init', '-q', ...extra)
}

interface Run {
  readonly cwd?: string
  /** Variables set for both sides. */
  readonly env?: Readonly<Record<string, string>>
}

const bashSide = (args: readonly string[], run: Run) =>
  runBash({
    command: 'env',
    args: Object.entries(run.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .concat(SCRIPT, ...args),
    cwd: run.cwd,
  })

const typescriptSide = async (
  world_: World,
  args: readonly string[],
  run: Run,
): Promise<CommandResult> => {
  const context: CommandContext = {
    args,
    env: { ...world_.sandbox.env, ...run.env },
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
    commandNames: [],
  }
  return discoverRepos(context, nodeDeps, run.cwd ?? process.cwd())
}

const answerOf = (result: CommandResult): { status: number; json: JsonValue | undefined } => {
  if (result === undefined) throw new Error('discover-repos answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  return { status: exitCodeFor(result), json: undefined }
}

const errorText = (result: CommandResult): string =>
  result !== undefined && result.outcome !== 'ok' ? result.error : ''

/** Both sides succeed with the same answer. */
const expectSame = async (w: World, args: readonly string[], run: Run = {}): Promise<JsonValue> => {
  const bash = bashSide(args, run)
  const typescript = answerOf(await typescriptSide(w, args, run))
  expect(bash.stderr).toBe('')
  expect(bash.status).toBe(0)
  expect(typescript.status).toBe(0)
  expect(firstDifference(JSON.parse(bash.stdout) as JsonValue, typescript.json as JsonValue)).toBe(
    null,
  )
  return typescript.json as JsonValue
}

/** Both sides fail with exit 1, and both messages carry every phrase. */
const expectBothRefuse = async (
  w: World,
  args: readonly string[],
  phrases: readonly string[],
  run: Run = {},
): Promise<void> => {
  const bash = bashSide(args, run)
  const result = await typescriptSide(w, args, run)
  expect(bash.status).toBe(1)
  expect(bash.stdout).toBe('')
  expect(answerOf(result).status).toBe(1)
  const bashMessage = (JSON.parse(bash.stderr) as { error: string }).error
  for (const phrase of phrases) {
    expect(bashMessage).toContain(phrase)
    expect(errorText(result)).toContain(phrase)
  }
}

/** The scratch workspace of the script's spec: every shape, listed or skipped. */
const workspace = (w: World) => {
  const work = join(w.root, 'workspace')
  for (const name of ['app/src', 'lib', 'scratch', 'nested/deep', 'Zeta', 'alpha', 'my app']) {
    mkdirSync(join(work, name), { recursive: true })
  }
  mkdirSync(join(work, 'bare'))
  mkdirSync(join(work, '.hidden'))
  mkdirSync(join(w.root, 'outside'))
  mkdirSync(join(w.root, 'elsewhere', 'sub'), { recursive: true })
  for (const name of ['app', 'lib', '.hidden', 'nested/deep', 'Zeta', 'alpha', 'my app']) {
    initRepo(w, join(work, name))
  }
  initRepo(w, join(w.root, 'outside'))
  initRepo(w, join(w.root, 'elsewhere'))
  initRepo(w, join(work, 'bare'), '--bare')
  symlinkSync('app', join(work, 'app-link'))
  symlinkSync('../elsewhere/sub', join(work, 'into-elsewhere'))
  symlinkSync('../outside', join(work, 'outside-link'))
  writeFileSync(join(work, 'notes.txt'), '')
  return work
}

describe('discover-repos parity: a target inside a checkout', () => {
  it.each([
    ['the root itself', '', 'app'],
    ['a subdirectory', 'src/deep', 'app'],
    ['a path with a space', '', 'my app'],
  ])('answers the checkout root from %s', async (_name, below, repo) => {
    const w = world()
    const work = workspace(w)
    if (below !== '') mkdirSync(join(work, repo, below), { recursive: true })
    const answer = await expectSame(w, [join(work, repo, below)])
    expect(answer).toEqual({ target: join(work, repo, below), repos: [join(work, repo)] })
  })
})

describe('discover-repos parity: a target that holds checkouts', () => {
  it('lists every immediate checkout root, sorted, deduplicated, and nothing else', async () => {
    const w = world()
    const work = workspace(w)
    const answer = (await expectSame(w, [work])) as { repos: string[] }
    expect(answer.repos).toEqual([
      join(w.root, 'outside'),
      join(work, 'Zeta'),
      join(work, 'alpha'),
      join(work, 'app'),
      join(work, 'lib'),
      join(work, 'my app'),
    ])
  })

  it('resolves a symlinked target', async () => {
    const w = world()
    const work = workspace(w)
    symlinkSync(work, join(w.root, 'link'))
    await expectSame(w, [join(w.root, 'link')])
  })

  it('accepts a relative path argument, resolved against the working directory', async () => {
    const w = world()
    const work = workspace(w)
    await expectSame(w, ['app'], { cwd: work })
  })

  it('defaults to the working directory', async () => {
    const w = world()
    const work = workspace(w)
    await expectSame(w, [], { cwd: work })
  })

  it('ignores an ambient GIT_DIR', async () => {
    const w = world()
    const work = workspace(w)
    await expectSame(w, [work], { env: { GIT_DIR: join(work, 'app', '.git') } })
  })

  it('ignores an ambient GIT_CEILING_DIRECTORIES', async () => {
    const w = world()
    const work = workspace(w)
    await expectSame(w, [join(work, 'app', 'src')], {
      env: { GIT_CEILING_DIRECTORIES: join(work, 'app') },
    })
  })

  it('answers an empty list for a directory with no repositories', async () => {
    const w = world()
    mkdirSync(join(w.root, 'empty'))
    const answer = await expectSame(w, [join(w.root, 'empty')])
    expect(answer).toEqual({ target: join(w.root, 'empty'), repos: [] })
  })

  it('skips a bare child under safe.bareRepository=explicit', async () => {
    const w = world()
    const work = join(w.root, 'holder')
    initRepo(w, join(work, 'app'))
    initRepo(w, join(work, 'bare'), '--bare')
    await expectSame(w, [work], {
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.bareRepository',
        GIT_CONFIG_VALUE_0: 'explicit',
      },
    })
  })

  it('answers the on-disk spelling for a target spelled in another case', async () => {
    const w = world()
    initRepo(w, join(w.root, 'Holder', 'RepoOne'))
    writeFileSync(join(w.root, 'CaseProbe'), '')
    const insensitive = (() => {
      try {
        realpathSync(join(w.root, 'caseprobe'))
        return true
      } catch {
        return false
      }
    })()
    if (!insensitive) return
    await expectSame(w, [join(w.root, 'holder')])
  })
})

describe('discover-repos parity: a linked worktree', () => {
  const linked = (w: World) => {
    const primary = join(w.root, 'primary')
    initRepo(w, primary)
    w.fixtures.git(primary, 'commit', '-q', '--allow-empty', '-m', 'init')
    const work = join(w.root, 'workspace')
    mkdirSync(work)
    w.fixtures.git(primary, 'worktree', 'add', '-q', '-b', 'wktr-spec', join(work, 'wt'))
    return { primary, work }
  }

  it('lists one held as an immediate child', async () => {
    const w = world()
    await expectSame(w, [linked(w).work])
  })

  it('answers its own root when it is the target', async () => {
    const w = world()
    await expectSame(w, [join(linked(w).work, 'wt')])
  })

  it('refuses one whose primary checkout was removed', async () => {
    const w = world()
    const { primary, work } = linked(w)
    rmSync(join(primary, '.git'), { recursive: true, force: true })
    await expectBothRefuse(w, [work], ['git failed'])
  })
})

describe('discover-repos parity: a target that is not a directory', () => {
  it.each([
    ['a missing path', 'no-such-path-here'],
    ['a regular file', 'regular-file'],
    ['a quoted name', 'we"ird-name'],
  ])('refuses %s', async (_name, name) => {
    const w = world()
    writeFileSync(join(w.root, 'regular-file'), '')
    await expectBothRefuse(w, [join(w.root, name)], ['not a directory'])
  })
})

describe.skipIf(isRoot)('discover-repos parity: a directory that cannot be read', () => {
  it('refuses a target it cannot read', async () => {
    const w = world()
    mkdirSync(join(w.root, 'locked'))
    chmodSync(join(w.root, 'locked'), 0o000)
    try {
      await expectBothRefuse(w, [join(w.root, 'locked')], ['could not read'])
    } finally {
      chmodSync(join(w.root, 'locked'), 0o755)
    }
  })

  it('refuses a child it cannot enter, naming the cause', async () => {
    const w = world()
    initRepo(w, join(w.root, 'workspace', 'app'))
    mkdirSync(join(w.root, 'workspace', 'locked'))
    chmodSync(join(w.root, 'workspace', 'locked'), 0o000)
    try {
      await expectBothRefuse(w, [join(w.root, 'workspace')], ['could not enter'])
    } finally {
      chmodSync(join(w.root, 'workspace', 'locked'), 0o755)
    }
  })

  it('refuses a checkout whose .git cannot be traversed', async () => {
    const w = world()
    const work = join(w.root, 'workspace')
    initRepo(w, join(work, 'ok'))
    initRepo(w, join(work, 'broken'))
    chmodSync(join(work, 'broken', '.git'), 0o000)
    try {
      await expectBothRefuse(w, [work], ['git failed'])
    } finally {
      chmodSync(join(work, 'broken', '.git'), 0o755)
    }
  })
})

describe('discover-repos parity: a child whose git state is broken', () => {
  const broken = (w: World) => {
    const work = join(w.root, 'workspace')
    initRepo(w, join(work, 'ok'))
    initRepo(w, join(work, 'broken'))
    return work
  }

  it('refuses a checkout missing HEAD', async () => {
    const w = world()
    const work = broken(w)
    rmSync(join(work, 'broken', '.git', 'HEAD'))
    await expectBothRefuse(w, [work], ['git failed'])
  })

  it('refuses a child whose .git is a dangling symlink', async () => {
    const w = world()
    const work = broken(w)
    mkdirSync(join(work, 'dangling'))
    symlinkSync('/no-such-git-dir', join(work, 'dangling', '.git'))
    await expectBothRefuse(w, [work], ['git failed'])
  })

  it('refuses a git directory handed in as the target', async () => {
    const w = world()
    const work = broken(w)
    await expectBothRefuse(w, [join(work, 'ok', '.git')], ['git failed'])
  })

  it('refuses a target below a broken checkout, naming the checkout', async () => {
    const w = world()
    const work = join(w.root, 'holder')
    initRepo(w, join(work, 'nohead'))
    mkdirSync(join(work, 'nohead', 'src'))
    rmSync(join(work, 'nohead', '.git', 'HEAD'))
    await expectBothRefuse(
      w,
      [join(work, 'nohead', 'src')],
      ['git failed in', join(work, 'nohead')],
    )
  })
})

describe('discover-repos parity: git itself failing', () => {
  /** A directory holding a `git` that is a script. */
  const stubGit = (w: World, name: string, body: string): string => {
    const directory = join(w.root, name)
    mkdirSync(directory)
    writeFileSync(join(directory, 'git'), `#!/bin/sh\n${body}\n`)
    chmodSync(join(directory, 'git'), 0o755)
    return directory
  }

  const holder = (w: World) => {
    const work = join(w.root, 'workspace')
    initRepo(w, join(work, 'app'))
    return work
  }

  it('refuses to run without git on PATH', async () => {
    const w = world()
    const work = holder(w)
    const bin = w.sandbox.pathWithout('git')
    await expectBothRefuse(w, [work], ['git is required'], { env: { PATH: bin } })
  })

  it('refuses a dubious-ownership failure instead of reporting no repositories', async () => {
    const w = world()
    const work = holder(w)
    const stub = stubGit(
      w,
      'stub',
      'printf "fatal: detected dubious ownership in repository at %s\\n" "$2" >&2\nexit 128',
    )
    await expectBothRefuse(w, [work], ['git failed'], {
      env: { PATH: `${stub}:${process.env.PATH}` },
    })
  })

  it('reads a capitalized not-a-git-repository as the ordinary answer', async () => {
    const w = world()
    mkdirSync(join(w.root, 'plain', 'kid'), { recursive: true })
    const stub = stubGit(
      w,
      'caps',
      'printf "fatal: Not a git repository (or any of the parent directories): .git\\n" >&2\nexit 128',
    )
    const answer = (await expectSame(w, [join(w.root, 'plain')], {
      env: { PATH: `${stub}:${process.env.PATH}` },
    })) as { repos: string[] }
    expect(answer.repos).toEqual([])
  })

  it('names the exit status when git fails with nothing on stderr', async () => {
    const w = world()
    mkdirSync(join(w.root, 'plain', 'kid'), { recursive: true })
    const stub = stubGit(w, 'silent', 'exit 128')
    await expectBothRefuse(w, [join(w.root, 'plain')], ['git failed', '(exit 128)'], {
      env: { PATH: `${stub}:${process.env.PATH}` },
    })
  })
})

describe('discover-repos parity: a child whose name holds a newline', () => {
  it.each([
    ['embedded', 'a\nb'],
    ['trailing', 'repo\n'],
  ])('refuses a %s newline rather than emitting garbage', async (_name, name) => {
    const w = world()
    initRepo(w, join(w.root, 'workspace', name))
    await expectBothRefuse(w, [join(w.root, 'workspace')], ['newline'])
  })
})
