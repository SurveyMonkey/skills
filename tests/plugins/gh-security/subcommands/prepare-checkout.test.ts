// `gh-security prepare-checkout`. The seam is the exported handler, with the
// `gh` client factory, the process runner, the adapter registry, the current
// directory and the signals as parameters.
//
// Git is real (`mocking.md`). Each checkout is a repository from
// `harness/git.ts`, with its bare origin on disk and the npm lockfile of
// `spec/fixtures/npm-v3`. The node adapter is the real one. `gh` is the one
// mock boundary: an example registers the default branch, the alerts and the
// pull request search.
//
// The `origin` of each checkout is `git@github.com:octo/<name>.git`, so that
// `detect-scope` reads an nwo. The network is the boundary here, so a stand-in
// for ssh (`GIT_SSH_COMMAND`) serves that URL from the bare origin on disk.
// Git itself still runs the probe, the fetch and the worktree for real.
//
// A recording runner stands in only where the example is about the argv that
// reaches a child (the `--env-prefix` wrap), or about a child that fails on
// demand (the probe retry, a failed fetch). It runs the real git for each
// other call.
//
// The expected values are written by hand from the contract on #227. The
// repository names are fictitious, and the package names are public.
//
// Each example that retires a prose pin (#197, ruling 7 of round 5) names
// the pin in a `pin:` comment above it, with the `It` title of the pin.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { commandNames } from '#gh-security/cli/registry.ts'
import { failed } from '#gh-security/lib/envelope.ts'
import { createGhClient } from '#gh-security/lib/gh.ts'
import { type Runner, type RunResult, run } from '#gh-security/lib/process.ts'
import { allowOwnCommands, ENTRY } from '#gh-security/subcommands/allow-own-commands.ts'
import {
  prepareCheckout,
  prepareCheckoutCommand,
} from '#gh-security/subcommands/prepare-checkout.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock, type GhReplies, ghFails } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

/**
 * Each example builds real repositories and runs about ten git children, and
 * some build two checkouts. The default limit of five seconds is too short
 * for that on a loaded machine.
 */
const SLOW = { timeout: 60_000 }

const USAGE = 'usage: gh-security prepare-checkout [--env-prefix <prefix>] <root>'

interface World {
  readonly sandbox: Sandbox
  readonly fixtures: GitFixtures
  readonly root: string
}

/**
 * The stand-in for ssh. Git runs it as `<command> <host> <remote command>`
 * (`GIT_SSH_VARIANT=simple`). The remote command is `git-upload-pack
 * '<owner>/<name>.git'`, and the stand-in serves the bare origin
 * `<origins>/<name>.git` in its place.
 */
const SSH_STAND_IN = `#!/bin/sh
for last; do :; done
name=\${last##*/}
name=\${name%\\'}
exec git upload-pack "$ORIGINS/$name"
`

const world = (): World => {
  const sandbox = createSandbox()
  const root = join(realpathSync(sandbox.path), 'w')
  mkdirSync(root)
  const ssh = join(sandbox.path, 'ssh-stand-in')
  writeFileSync(ssh, SSH_STAND_IN)
  chmodSync(ssh, 0o755)
  sandbox.env.GIT_SSH_COMMAND = ssh
  sandbox.env.GIT_SSH_VARIANT = 'simple'
  sandbox.env.ORIGINS = join(root, '.origins')
  // `classify-lines` makes its temporary worktree here, so an example can
  // see that nothing stays.
  sandbox.env.TMPDIR = join(sandbox.path, 'tmp')
  mkdirSync(sandbox.env.TMPDIR)
  return { sandbox, fixtures: createGitFixtures(sandbox), root }
}

/** The options of one checkout. */
interface Shape {
  /** Branches to push to origin, such as `fix`. */
  readonly remoteBranches?: readonly string[]
  /** The URL of `origin`, or null for no `origin`. Absent means `git@github.com:octo/<name>.git`. */
  readonly origin?: string | null
  /** A directory name that is not the repository name. */
  readonly dir?: string
}

/** A checkout with the npm-v3 lockfile on its default branch. */
const checkout = (w: World, name: string, shape: Shape = {}): string => {
  const work = w.fixtures.createAt(w.root, name)
  w.fixtures.importTree(work, join(FIXTURES_ROOT, 'npm-v3'))
  w.fixtures.push(work)
  for (const branch of shape.remoteBranches ?? []) {
    w.fixtures.branch(work, branch)
    w.fixtures.push(work, branch)
  }
  if (shape.origin === null) w.fixtures.removeOrigin(work)
  else {
    const url = shape.origin ?? `git@github.com:octo/${name}.git`
    w.fixtures.git(work, 'remote', 'set-url', 'origin', url)
  }
  if (shape.dir === undefined) return work
  const moved = join(w.root, shape.dir)
  renameSync(work, moved)
  return moved
}

/** One open alert, in the shape of the alerts endpoint. */
const alert = (
  number: number,
  name: string,
  fixed: string,
  severity: string,
  epss: number,
  ecosystem = 'npm',
) => ({
  number,
  dependency: {
    package: { ecosystem, name },
    manifest_path: 'package-lock.json',
    relationship: 'transitive',
  },
  security_advisory: {
    ghsa_id: `GHSA-${number}`,
    cve_id: `CVE-2000-${number}`,
    severity,
    summary: `advisory ${number}`,
    epss: { percentile: epss },
  },
  security_vulnerability: {
    vulnerable_version_range: `< ${fixed}`,
    first_patched_version: { identifier: fixed },
  },
})

/**
 * sha.js resolves at 2.4.11, so its 2.x line is resolved. express resolves
 * at 4.18.2, so its 5.x fix crosses a major. requests is not npm.
 */
const ALERTS = [
  alert(1, 'sha.js', '2.4.12', 'high', 0.4),
  alert(2, 'express', '5.0.0', 'critical', 0.9),
  alert(3, 'requests', '2.32.0', 'medium', 0.1, 'pip'),
]

const REPLIES: GhReplies = {
  viewDefaultBranch: { name: 'main' },
  listDependabotAlerts: ALERTS,
  searchOpenPullRequests: [],
}

const context = (w: World, args: readonly string[]): CommandContext => ({
  args,
  env: w.sandbox.env,
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

/** The answer of the command, with `gh` answering from `replies`. */
const prepare = (
  w: World,
  args: readonly string[],
  replies: GhReplies = REPLIES,
  spawn: Runner = run,
): Promise<CommandResult> =>
  prepareCheckout(context(w, args), () => createGhMock(replies), spawn, selectAdapter, w.root)

const value = (result: CommandResult): Record<string, unknown> => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value as Record<string, unknown>
}

type Group = Record<string, unknown>

/** The groups of one list, as `[package, branch_name, reason or line_status]`. */
const rows = (answer: Record<string, unknown>, list: 'actionable' | 'skipped') =>
  (answer[list] as Group[]).map((group) => [
    group.package,
    group.branch_name,
    list === 'skipped' ? group.reason : group.line_status,
  ])

/** The answer of a child, for a stand-in runner. */
const answer = (fields: Partial<RunResult>): RunResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
  ...fields,
})

const isProbe = (args: readonly string[]): boolean => args.includes('ls-remote')

/**
 * A runner that gives each answer in `probes` to one probe attempt, in order,
 * and runs the real git for every other call and for a probe after the list.
 */
const probing = (...probes: RunResult[]): Runner => {
  const left = [...probes]
  return async (command, args = [], options) => {
    if (isProbe(args)) {
      const next = left.shift()
      if (next !== undefined) return next
    }
    return run(command, args, options)
  }
}

describe('a checkout that is kept', SLOW, () => {
  // pin: pipes phase 2 discovery through classify-lines.sh at one venue
  // pin: withdraws a requires_major_bump group in phase 2, before the question is asked
  it('answers with its identity, its branch style and its classified groups', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const result = value(await prepare(w, [work]))
    expect({
      checkout: result.checkout,
      nwo: result.nwo,
      default_branch: result.default_branch,
      branch_style: result.branch_style,
      actionable: rows(result, 'actionable'),
      adapters: (result.actionable as Group[]).map((group) => group.adapter),
      skipped: rows(result, 'skipped'),
      classify_errors: result.classify_errors,
    }).toEqual({
      checkout: work,
      nwo: 'octo/app',
      default_branch: 'main',
      branch_style: 'slash',
      actionable: [['sha.js', 'fix/dependabot-sha.js-2x', 'resolved']],
      adapters: ['node'],
      skipped: [
        ['requests', 'fix/dependabot-requests-2x', 'ecosystem not supported yet'],
        ['express', 'fix/dependabot-express-5x', 'requires major version bump'],
      ],
      classify_errors: [],
    })
  })

  // pin: makes origin the only source of nwo
  // pin: no longer tiebreaks git_remote against nwo
  it('takes the nwo from origin alone, and gives no other identity to compare', async () => {
    const w = world()
    // The directory name is a plausible repository name that is not origin's.
    const work = checkout(w, 'app', { dir: 'other-repo' })
    const result = value(await prepare(w, [work]))
    expect([result.checkout, result.nwo]).toEqual([join(w.root, 'other-repo'), 'octo/app'])
    expect(Object.keys(result).sort()).toEqual([
      'actionable',
      'branch_style',
      'checkout',
      'classify_errors',
      'default_branch',
      'nwo',
      'skipped',
    ])
  })

  // pin: pins classification to origin/<default_branch>
  it('classifies the tree of origin/<default_branch>, not the working tree', async () => {
    const w = world()
    const work = checkout(w, 'app')
    // An edit in the working tree that would make the express 5.x line
    // resolved. A classification of the working tree reads it.
    const lockfile = join(work, 'package-lock.json')
    writeFileSync(
      lockfile,
      readFileSync(lockfile, 'utf8').replace('"version": "4.18.2"', '"version": "5.1.0"'),
    )
    const result = value(await prepare(w, [work]))
    expect(rows(result, 'skipped')).toContainEqual([
      'express',
      'fix/dependabot-express-5x',
      'requires major version bump',
    ])
  })
})

describe('the branch namespace probe', SLOW, () => {
  // pin: prescribes one fully-qualified ls-remote probe at the one resolution point
  // pin: maps a refs/heads/fix hit onto --branch-style flat at every consuming site
  it('gives the flat style, and flat names in both lists, when origin has a branch fix', async () => {
    const w = world()
    const work = checkout(w, 'app', { remoteBranches: ['fix'] })
    const result = value(await prepare(w, [work]))
    expect({
      style: result.branch_style,
      actionable: rows(result, 'actionable'),
      skipped: rows(result, 'skipped'),
    }).toEqual({
      style: 'flat',
      actionable: [['sha.js', 'fix-dependabot-sha.js-2x', 'resolved']],
      skipped: [
        ['requests', 'fix-dependabot-requests-2x', 'ecosystem not supported yet'],
        ['express', 'fix-dependabot-express-5x', 'requires major version bump'],
      ],
    })
  })

  // pin: prescribes one fully-qualified ls-remote probe at the one resolution point
  // pin: names the unprobed inverse collision instead of claiming coverage
  it.each([
    ['a branch that ends in fix', ['topic/fix']],
    ['the inverse collision, which is not probed', ['fix-later', 'fix/dependabot-sha.js-2x/old']],
  ])('keeps the slash style for %s', async (_name, branches) => {
    const w = world()
    // A remote cannot hold `fix` beside `fix/...`, so `fix-later` stands
    // beside the inverse collision only to show that a prefix is not a hit.
    const work = checkout(w, 'app', { remoteBranches: branches })
    const result = value(await prepare(w, [work]))
    expect({ style: result.branch_style, actionable: rows(result, 'actionable') }).toEqual({
      style: 'slash',
      actionable: [['sha.js', 'fix/dependabot-sha.js-2x', 'resolved']],
    })
  })

  // pin: keeps the branch-style verdict per checkout
  // pin: applies the flat flag to the checkout whose probe hit, not to the batch
  it('gives each checkout its own style', async () => {
    const w = world()
    const hit = checkout(w, 'app', { remoteBranches: ['fix'] })
    const clear = checkout(w, 'api')
    const styles = []
    for (const work of [hit, clear]) {
      const result = value(await prepare(w, [work]))
      styles.push([result.nwo, result.branch_style, rows(result, 'actionable')[0]?.[1]])
    }
    expect(styles).toEqual([
      ['octo/app', 'flat', 'fix-dependabot-sha.js-2x'],
      ['octo/api', 'slash', 'fix/dependabot-sha.js-2x'],
    ])
  })

  // pin: gives the probe the registry preflight retry
  it.each([
    ['a non-zero exit', answer({ status: 128, stderr: 'fatal: first\n' })],
    ['an exit 0 with output that is not the ref', answer({ stdout: 'not a ref line\n' })],
  ])(
    'tries again after %s, and keeps the checkout when the retry answers',
    async (_name, first) => {
      const w = world()
      const work = checkout(w, 'app')
      const result = value(await prepare(w, [work], REPLIES, probing(first)))
      expect([result.branch_style, rows(result, 'actionable')]).toEqual([
        'slash',
        [['sha.js', 'fix/dependabot-sha.js-2x', 'resolved']],
      ])
    },
  )

  it('reads two hit lines in the shape of a sha-256 repository as a hit', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const line = `${'a'.repeat(64)}\trefs/heads/fix\n`
    const result = value(await prepare(w, [work], REPLIES, probing(answer({ stdout: line }))))
    expect(result.branch_style).toBe('flat')
  })

  // pin: excludes a checkout whose probe fails twice, reporting the probe stderr rather than a diagnosis
  // pin: excludes the checkout on a twice-failed probe, with its stderr
  // pin: never turns a failed probe into an origin-unreachable diagnosis
  // pin: no longer diagnoses a failed probe as an unreachable origin
  it.each([
    [
      'the stderr of the second attempt, as git wrote it',
      [
        answer({ status: 128, stderr: 'fatal: one\n' }),
        answer({ status: 128, stderr: 'fatal: two\n' }),
      ],
      'fatal: two\n',
    ],
    [
      'the exit status, when git wrote nothing',
      [answer({ status: 2 }), answer({ status: 2 })],
      'git exited 2',
    ],
    [
      'the signal, when a signal stopped git',
      [answer({ status: null, signal: 'SIGKILL' }), answer({ status: null, signal: 'SIGTERM' })],
      'git exited on SIGTERM',
    ],
    [
      'the start failure, when git did not start',
      [
        answer({ status: 127 }),
        answer({ status: 127, startFailure: { code: 'ENOENT', message: 'spawn git ENOENT' } }),
      ],
      'spawn git ENOENT',
    ],
    [
      'the output, when git answered with a line that is not the ref',
      [answer({ stdout: 'odd\n' }), answer({ stdout: 'odd\n' })],
      'git ls-remote gave output that is not a refs/heads/fix line: odd\n',
    ],
  ])('excludes the checkout after two failed attempts, with %s', async (_name, probes, stderr) => {
    const w = world()
    const work = checkout(w, 'app')
    expect(await prepare(w, [work], REPLIES, probing(...probes))).toEqual({
      outcome: 'ok',
      value: {
        checkout: work,
        excluded: true,
        reason: 'branch namespace probe failed twice',
        stderr,
      },
    })
  })

  it('excludes a checkout whose origin answers no repository, with the words of git', async () => {
    const w = world()
    const work = checkout(w, 'app', { origin: 'git@github.com:octo/gone.git' })
    const result = value(await prepare(w, [work]))
    expect([result.reason, result.stderr]).toEqual([
      'branch namespace probe failed twice',
      expect.stringContaining('does not appear to be a git repository'),
    ])
  })
})

describe('the exclusion causes', SLOW, () => {
  // pin: excludes a checkout with no usable origin
  it.each([
    ['no origin', null],
    ['an origin with no host', '/srv/git/app.git'],
  ])('excludes a checkout with %s', async (_name, origin) => {
    const w = world()
    const work = checkout(w, 'app', { origin })
    expect(await prepare(w, [work], {})).toEqual({
      outcome: 'ok',
      value: { checkout: work, excluded: true, reason: 'no usable origin', stderr: '' },
    })
  })

  // pin: excludes a checkout whose default branch is null
  it('excludes a checkout whose default branch is null', async () => {
    const w = world()
    const work = checkout(w, 'app')
    expect(await prepare(w, [work], { viewDefaultBranch: { name: null } })).toEqual({
      outcome: 'ok',
      value: { checkout: work, excluded: true, reason: 'no resolvable default branch', stderr: '' },
    })
  })

  it('excludes a checkout whose default branch GitHub did not give, with the error', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const replies = { viewDefaultBranch: ghFails('HTTP 404: Not Found') }
    expect(await prepare(w, [work], replies)).toEqual({
      outcome: 'ok',
      value: {
        checkout: work,
        excluded: true,
        reason: 'no resolvable default branch',
        stderr: 'could not read the default branch of octo/app from GitHub: HTTP 404: Not Found',
      },
    })
  })

  // pin: lists the discovery and routing scripts among the exclusion causes
  it('excludes a checkout whose alerts cannot be read, with the error of discover-alerts', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const replies = { ...REPLIES, listDependabotAlerts: ghFails('gh: Not Found (HTTP 404)') }
    expect(await prepare(w, [work], replies)).toEqual({
      outcome: 'ok',
      value: {
        checkout: work,
        excluded: true,
        reason: 'discover-alerts failed',
        stderr: 'Failed to fetch alerts for octo/app: gh: Not Found (HTTP 404)',
      },
    })
  })

  // pin: makes a classify failure a stop for the repo, not the run
  // pin: names a classify failure a stop, never a cue to drop --base-ref
  it('excludes a checkout whose classification failed, and gives no group from another tree', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const refuseFetch: Runner = (command, args = [], options) =>
      args.includes('fetch')
        ? Promise.resolve(answer({ status: 128, stderr: 'fatal: refused\n' }))
        : run(command, args, options)
    expect(await prepare(w, [work], REPLIES, refuseFetch)).toEqual({
      outcome: 'ok',
      value: {
        checkout: work,
        excluded: true,
        reason: 'classify-lines failed',
        stderr: 'git fetch for --base-ref origin/main failed: fatal: refused',
      },
    })
  })
})

describe('the prefix', SLOW, () => {
  /**
   * A runner that records each call. Under the prefix `envwrap --flag`, it
   * runs the real git after the prefix words, and answers each `gh` call as
   * GitHub would.
   */
  const recording = () => {
    const calls: string[][] = []
    const runner: Runner = (command, args = [], options) => {
      calls.push([command, ...args])
      const [tool, ...rest] = command === 'envwrap' ? args.slice(1) : [command, ...args]
      if (tool !== 'gh') return run(tool as string, rest, options)
      let stdout = '[]'
      if (rest[0] === 'repo') stdout = '{"defaultBranchRef":{"name":"main"}}'
      if (rest[0] === 'api') stdout = JSON.stringify([ALERTS])
      return Promise.resolve(answer({ stdout }))
    }
    return { calls, runner }
  }

  const prepareWith = (w: World, args: readonly string[], runner: Runner) =>
    prepareCheckout(context(w, args), createGhClient, runner, selectAdapter, w.root)

  /** A call as its tool and the first word that names what it does. */
  const verb = (call: readonly string[]): string => {
    const words = call[0] === 'envwrap' ? call.slice(2) : call
    const tool = words[0] as string
    return tool === 'git' ? `git ${words[3]}` : `gh ${words[1]}`
  }

  // pin: resolves env_prefix before detect-scope.sh
  // pin: runs detect-scope.sh under the prefix and says why
  // pin: wraps every stage of the phase 2 pipeline, not only the first
  it('runs every child of every step under the prefix', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const { calls, runner } = recording()
    const result = value(await prepareWith(w, ['--env-prefix', 'envwrap --flag', work], runner))
    expect(result.nwo).toBe('octo/app')
    expect(calls.filter((call) => call[0] !== 'envwrap' || call[1] !== '--flag')).toEqual([])
    expect(new Set(calls.map(verb))).toEqual(
      new Set([
        'git rev-parse',
        'git remote',
        'gh repo',
        'git ls-remote',
        'gh api',
        'gh pr',
        'git fetch',
        'git worktree',
      ]),
    )
  })

  it('runs every child bare with no prefix', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const { calls, runner } = recording()
    value(await prepareWith(w, [work], runner))
    expect(new Set(calls.map((call) => call[0]))).toEqual(new Set(['git', 'gh']))
  })

  // pin: grants no $1
  it('clones nothing, and leaves no temporary directory', async () => {
    const w = world()
    const work = checkout(w, 'app')
    const { calls, runner } = recording()
    value(await prepareWith(w, [work], runner))
    expect({
      clones: calls.filter((call) => call.includes('clone')),
      left: readdirSync(w.sandbox.env.TMPDIR as string),
    }).toEqual({ clones: [], left: [] })
  })
})

describe('the command line', SLOW, () => {
  // pin: no longer offers a scope override
  it.each([
    ['--nwo', 'octo/app'],
    ['--scope', 'org'],
  ])('refuses %s, which no step reads', async (option, setting) => {
    const w = world()
    const result = await prepare(w, [option, setting, w.root], {})
    expect(result?.outcome === 'failed' && result.error).toMatch(/^Unknown option/)
  })

  // pin: runs the phase 2 pipeline once per checkout
  it.each([
    ['no checkout', []],
    ['two checkouts', ['/work/app', '/work/api']],
  ])('refuses %s, because one call is one checkout', async (_name, roots) => {
    expect(await prepare(world(), roots, {})).toEqual(failed(USAGE))
  })

  it('refuses a root that is not a directory', async () => {
    expect(await prepare(world(), ['missing'], {})).toEqual(
      failed('prepare-checkout: not a directory: missing'),
    )
  })

  it('refuses a root in no git repository', async () => {
    const w = world()
    expect(await prepare(w, ['.'], {})).toEqual(failed('prepare-checkout: not a git checkout: .'))
  })

  // pin: grants discover-repos.sh
  // pin: grants the ls-remote namespace probe
  it.each([
    'discover-repos /work',
    'prepare-checkout /work/app',
    'merge-envelopes /tmp/app.json /tmp/api.json',
  ])('lets the allow hook approve the phase 1 and 2 command %s', (command) => {
    const input = { tool_name: 'Bash', tool_input: { command: `node ${ENTRY} ${command}` } }
    expect(allowOwnCommands(input, ENTRY, commandNames)?.hookSpecificOutput).toMatchObject({
      permissionDecision: 'allow',
    })
  })
})

describe('the registered handler', () => {
  it('refuses a root that is not a directory before any child starts', async () => {
    const result = await prepareCheckoutCommand({
      ...context(world(), ['/nowhere/at/all']),
      env: {},
    })
    expect(result).toEqual(failed('prepare-checkout: not a directory: /nowhere/at/all'))
  })
})
