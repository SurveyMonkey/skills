// The git helpers. Git is never mocked (the testing skill's mocking.md), so
// every example runs real `git` against real repositories made with
// `git init` in scratch directories. The one exception is a stand-in `git`
// script put first on PATH, for the answers a real git does not give: an
// empty answer with status 0, a hang past the time limit, and output whose
// exact bytes the example must control.
//
// Every call names its environment. `cleanEnv` drops each `GIT_*` variable,
// because git exports `GIT_DIR` and `GIT_INDEX_FILE` into a hook's children
// and the pre-commit hook runs this suite. It also points git at no global
// or system configuration, so a developer's own settings stay out.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  currentBranch,
  defaultBranch,
  gitLines,
  gitOk,
  gitOut,
  hasRef,
  runGit,
  toplevel,
} from '#gh-security/lib/git.ts'

// Scratch roots are resolved physically on creation: on macOS `/var` really
// is `/private/var`, and git prints the physical path.
const scratches: string[] = []
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gh-security-git-')))
  scratches.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true })
})

const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra }
}

/** Real git, the setup path. It is a separate call from the code under test. */
const setup = (dir: string, ...args: string[]): string => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: cleanEnv() })
  if (result.status !== 0) throw new Error(`setup: git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

interface Repository {
  readonly work: string
  readonly origin: string
  readonly env: NodeJS.ProcessEnv
}

/** A checkout on `main` with one commit, and a bare origin that has it. */
const repository = (): Repository => {
  const root = scratch()
  const work = join(root, 'work')
  const origin = join(root, 'origin')
  mkdirSync(work)
  setup(root, 'init', '-q', '--bare', origin)
  setup(work, 'init', '-q', '-b', 'main')
  setup(work, 'config', 'user.email', 'suite@example.test')
  setup(work, 'config', 'user.name', 'Suite')
  setup(work, 'commit', '-q', '--allow-empty', '-m', 'root')
  setup(work, 'remote', 'add', 'origin', origin)
  setup(work, 'push', '-q', 'origin', 'main')
  return { work, origin, env: cleanEnv() }
}

/** A directory that is not inside any repository. */
const plainDirectory = (): string => scratch()

/** An environment whose first `git` is a script with this body. */
const stubGit = (body: string): NodeJS.ProcessEnv => {
  const bin = scratch()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, 'git'), 0o755)
  return cleanEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` })
}

describe('runGit', () => {
  it('answers a successful run with its whole result', async () => {
    const { work, env } = repository()

    const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: work, env })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('main\n')
    expect(result.timedOut).toBe(false)
    expect(result.startFailure).toBeNull()
  })

  it('runs git in the directory it is given', async () => {
    const { work, env } = repository()
    const inside = join(work, 'nested')
    mkdirSync(inside)

    const result = await runGit(['rev-parse', '--show-prefix'], { cwd: inside, env })

    expect(result.stdout).toBe('nested/\n')
  })

  it('gives git the environment it is given, and no other', async () => {
    const env = stubGit('printf "%s" "$MARKER"')

    const result = await runGit(['anything'], { env: { ...env, MARKER: 'from-the-caller' } })

    expect(result.stdout).toBe('from-the-caller')
  })

  it('runs git in this checkout, with this environment, when it is given no options', async () => {
    const result = await runGit(['--version'])

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^git version /)
  })

  // The preflight check reports three facts apart: git is not there, git ran
  // and said no, and git was killed. Each is a field, never a throw.
  it('reports a git that is not on PATH as a start failure', async () => {
    const result = await runGit(['--version'], { env: cleanEnv({ PATH: scratch() }) })

    expect(result.startFailure?.code).toBe('ENOENT')
    expect(result.status).toBe(127)
  })

  it('reports a git that ran and said no as a non-zero status', async () => {
    const { env } = repository()

    const result = await runGit(['rev-parse', '--show-toplevel'], { cwd: plainDirectory(), env })

    expect(result.startFailure).toBeNull()
    expect(result.status).toBe(128)
    expect(result.stderr).toContain('not a git repository')
  })

  it('kills git at the time limit and reports it', async () => {
    const env = stubGit('exec sleep 30')

    const result = await runGit(['fetch'], { env, timeoutMs: 100 })

    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    expect(result.elapsedMs).toBeLessThan(10_000)
  })

  it('waits for git when it sets no time limit', async () => {
    const env = stubGit('sleep 0.2; printf done')

    const result = await runGit(['fetch'], { env })

    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('done')
  })
})

describe('gitOut', () => {
  it('strips every trailing newline, not only the last', async () => {
    const env = stubGit('printf "line\\n\\n\\n"')

    await expect(gitOut(['x'], { env })).resolves.toBe('line')
  })

  it('keeps leading space, which status --porcelain encodes', async () => {
    const { work, env } = repository()
    writeFileSync(join(work, 'file.txt'), 'one\n')
    setup(work, 'add', 'file.txt')
    setup(work, 'commit', '-q', '-m', 'add file')
    writeFileSync(join(work, 'file.txt'), 'two\n')

    await expect(
      gitOut(['status', '--porcelain', '--untracked-files=no'], { cwd: work, env }),
    ).resolves.toBe(' M file.txt')
  })

  it('keeps a newline inside the answer', async () => {
    const env = stubGit('printf "a\\nb\\n"')

    await expect(gitOut(['x'], { env })).resolves.toBe('a\nb')
  })

  // `null` and `""` are different facts: "the probe could not run" against
  // "the tree is clean".
  it('answers the empty string when git succeeded and said nothing', async () => {
    const { work, env } = repository()

    await expect(gitOut(['status', '--porcelain'], { cwd: work, env })).resolves.toBe('')
  })

  it('answers a falsy but real payload as itself', async () => {
    const env = stubGit('printf 0')

    await expect(gitOut(['x'], { env })).resolves.toBe('0')
  })

  it('answers null when git said no', async () => {
    const { env } = repository()

    await expect(
      gitOut(['rev-parse', '--show-toplevel'], { cwd: plainDirectory(), env }),
    ).resolves.toBeNull()
  })

  it('answers null, with the output dropped, when git said no after it printed', async () => {
    const env = stubGit('printf out; exit 3')

    await expect(gitOut(['x'], { env })).resolves.toBeNull()
  })

  it('answers null when git is not on PATH', async () => {
    await expect(gitOut(['--version'], { env: cleanEnv({ PATH: scratch() }) })).resolves.toBeNull()
  })

  it('answers null rather than rejecting when node refuses the argument list', async () => {
    const { work, env } = repository()

    await expect(gitOut(['rev-parse\u0000--show-toplevel'], { cwd: work, env })).resolves.toBeNull()
  })

  it('runs git in this checkout when it is given no options', async () => {
    await expect(gitOut(['--version'])).resolves.toMatch(/^git version /)
  })
})

describe('gitOk', () => {
  it('is true for status 0, whatever git printed', async () => {
    const { work, env } = repository()

    await expect(gitOk(['status', '--porcelain'], { cwd: work, env })).resolves.toBe(true)
  })

  it('is false for a non-zero status', async () => {
    const { work, env } = repository()

    await expect(
      gitOk(['show-ref', '--verify', '--quiet', 'refs/heads/absent'], { cwd: work, env }),
    ).resolves.toBe(false)
  })

  it('is false when git did not start', async () => {
    await expect(gitOk(['--version'], { env: cleanEnv({ PATH: scratch() }) })).resolves.toBe(false)
  })

  it('runs git in this checkout when it is given no options', async () => {
    await expect(gitOk(['--version'])).resolves.toBe(true)
  })
})

describe('gitLines', () => {
  it('answers the non-empty lines of a listing', async () => {
    const { work, env } = repository()
    setup(work, 'branch', 'feature')

    await expect(
      gitLines(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: work, env }),
    ).resolves.toEqual(['feature', 'main'])
  })

  it('drops blank lines inside the listing', async () => {
    const env = stubGit('printf "a\\n\\nb\\n\\n"')

    await expect(gitLines(['x'], { env })).resolves.toEqual(['a', 'b'])
  })

  it('keeps a line that is falsy but not empty', async () => {
    const env = stubGit('printf "0\\n"')

    await expect(gitLines(['x'], { env })).resolves.toEqual(['0'])
  })

  // "No branches" and "the list could not be read" must differ.
  it('answers an empty list for a listing with no lines', async () => {
    const { work, env } = repository()

    await expect(gitLines(['status', '--porcelain'], { cwd: work, env })).resolves.toEqual([])
  })

  it('answers null for a listing that could not be read', async () => {
    const { env } = repository()

    await expect(gitLines(['for-each-ref'], { cwd: plainDirectory(), env })).resolves.toBeNull()
  })

  it('runs git in this checkout when it is given no options', async () => {
    await expect(gitLines(['--version'])).resolves.toHaveLength(1)
  })
})

describe('toplevel', () => {
  it('finds the checkout root from inside it', async () => {
    const { work, env } = repository()
    const inside = join(work, 'nested')
    mkdirSync(inside)

    await expect(toplevel({ cwd: inside, env })).resolves.toBe(work)
  })

  it('answers null outside a checkout', async () => {
    const { env } = repository()

    await expect(toplevel({ cwd: plainDirectory(), env })).resolves.toBeNull()
  })

  it('reads an empty answer as no answer', async () => {
    await expect(toplevel({ cwd: plainDirectory(), env: stubGit('exit 0') })).resolves.toBeNull()
  })
})

describe('currentBranch', () => {
  it('names the branch HEAD is on', async () => {
    const { work, env } = repository()

    await expect(currentBranch({ cwd: work, env })).resolves.toBe('main')
  })

  it('says HEAD when HEAD is detached', async () => {
    const { work, env } = repository()
    setup(work, 'checkout', '-q', '--detach')

    await expect(currentBranch({ cwd: work, env })).resolves.toBe('HEAD')
  })

  it('answers null outside a repository', async () => {
    const { env } = repository()

    await expect(currentBranch({ cwd: plainDirectory(), env })).resolves.toBeNull()
  })

  it('reads an empty answer as no answer', async () => {
    await expect(
      currentBranch({ cwd: plainDirectory(), env: stubGit('exit 0') }),
    ).resolves.toBeNull()
  })
})

describe('defaultBranch', () => {
  it('reads the default branch from the cached origin/HEAD', async () => {
    const { work, env } = repository()
    setup(work, 'remote', 'set-head', 'origin', 'main')

    await expect(defaultBranch({ cwd: work, env })).resolves.toBe('main')
  })

  it('keeps a slash inside the branch name', async () => {
    const { work, env } = repository()
    setup(work, 'branch', 'release/1')
    setup(work, 'push', '-q', 'origin', 'release/1')
    setup(work, 'remote', 'set-head', 'origin', 'release/1')

    await expect(defaultBranch({ cwd: work, env })).resolves.toBe('release/1')
  })

  it('answers null when no origin/HEAD is cached', async () => {
    const { work, env } = repository()

    await expect(defaultBranch({ cwd: work, env })).resolves.toBeNull()
  })

  it('passes a ref that does not carry the origin prefix through unchanged', async () => {
    const { work, env } = repository()
    setup(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    setup(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main')

    await expect(defaultBranch({ cwd: work, env })).resolves.toBe('refs/heads/main')
  })

  it('reads an empty answer as no answer', async () => {
    await expect(
      defaultBranch({ cwd: plainDirectory(), env: stubGit('exit 0') }),
    ).resolves.toBeNull()
  })
})

describe('hasRef', () => {
  it('says whether a ref exists, in either namespace', async () => {
    const { work, env } = repository()

    await expect(hasRef('refs/heads/main', { cwd: work, env })).resolves.toBe(true)
    await expect(hasRef('refs/remotes/origin/main', { cwd: work, env })).resolves.toBe(true)
    await expect(hasRef('refs/heads/never-created', { cwd: work, env })).resolves.toBe(false)
  })

  it('does not take a short name for a full one', async () => {
    const { work, env } = repository()

    await expect(hasRef('main', { cwd: work, env })).resolves.toBe(false)
  })

  // `GIT_DIR` outranks `cwd` and `git -C`, which is why `RepoOptions`
  // requires `env`. Two real checkouts differ only in the environment.
  it('reads the refs of the repository GIT_DIR names, not the one the call named', async () => {
    const { work, env } = repository()
    const other = repository()
    setup(other.work, 'branch', 'only-over-there')

    await expect(hasRef('refs/heads/only-over-there', { cwd: work, env })).resolves.toBe(false)
    await expect(
      hasRef('refs/heads/only-over-there', {
        cwd: work,
        env: { ...env, GIT_DIR: join(other.work, '.git') },
      }),
    ).resolves.toBe(true)
  })
})
