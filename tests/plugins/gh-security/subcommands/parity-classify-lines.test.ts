// Parity for `classify-lines` (RFC 002, "Parity is the migration strategy").
// The bash side is the pipeline that the skill runs,
// `select-adapter.sh --from-discovery | classify-lines.sh`, under
// `pipefail`, so a failure of either stage is the exit status. The TypeScript
// side is the one command, which routes each group itself. Both get the same
// discovery JSON, and the exit status and the whole answer are compared.
//
// Nothing is mocked. The adapter is the real node adapter on both sides:
// `node.sh` for bash, and the registry for the port. The trees are the
// lockfile specimens under `spec/fixtures/`, copied for each row. The
// `--base-ref` rows run in a repository with a bare origin that
// `harness/git.ts` builds in a sandbox, never in this checkout.
//
// The script's own spec (`spec/classify_lines_spec.sh`) uses a stand-in
// adapter that it writes. The port calls the adapter in process, so those
// shapes are unit tests of the port, with a stand-in registry.
//
// The bash answer is normalized in three declared ways before the compare:
//   - `adapter_path` is dropped from each group. The route of the port is in
//     process and has no path.
//   - `classify_errors[].adapter` is the path of `node.sh` in bash, and the
//     name `node` in the port.
//   - `classify_errors[].error` is the first stderr line of `node.sh` in bash,
//     which is `{"error": ...}`. The port gives the message itself.
//
// Declared differences, not compared:
//   - The script writes a failure as JSON on stderr. The CLI renders a failure
//     as JSON on stdout and prose on stderr (`cli.md`). The exit status is the
//     same, and the rows compare it.
//   - Empty stdin gives exit 0 and no JSON in the pipeline. The port refuses
//     it. A row below shows the two answers.
//   - The own-range check of the port (#168). A row at the end shows the two
//     answers.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, type JsonValue } from '#gh-security/lib/envelope.ts'
import { run } from '#gh-security/lib/process.ts'
import { classifyLines } from '#gh-security/subcommands/classify-lines.ts'
import { FIXTURES_ROOT, useFixture } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

// Each row starts the bash side as real processes, which is slow on a CI
// runner. The time limit is for that, and not for a hang.
vi.setConfig({ testTimeout: 60_000 })

const COMMON = pluginFile('gh-security', 'scripts', 'common')
const SELECT = join(COMMON, 'select-adapter.sh')
const CLASSIFY = join(COMMON, 'classify-lines.sh')

type Group = Record<string, JsonValue>

/** One discovery group, as `discover-alerts` gives it, before the route. */
const group = (name: string, line: string, fields: Group = {}): Group => ({
  package: name,
  ecosystem: 'npm',
  major_line: line,
  repo: 'octo/app',
  branch_name: `fix/dependabot-${name}-${line === 'none' ? 'unfixed' : `${line}x`}`,
  ...fields,
})

const envelope = (actionable: readonly Group[], skipped: readonly Group[] = []): string =>
  JSON.stringify({ actionable, skipped })

/** The groups that reach every status on the cross-line specimens. */
const CROSS_LINE = envelope(
  [
    group('brace-expansion', '1'),
    group('brace-expansion', '2'),
    group('brace-expansion', '5'),
    group('minimatch', '3'),
    group('minimatch', '9'),
    group('minimatch', '11'),
    group('left-pad', '1'),
    group('balanced-match', 'none'),
  ],
  [group('old', 'none', { reason: 'no fix available' })],
)

/** git's own settings for both sides, from the sandbox. */
const gitEnv = (sandbox: Sandbox | null): string[] =>
  sandbox === null
    ? []
    : ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(
        (name) => `${name}=${sandbox.env[name] ?? ''}`,
      )

const bashSide = (input: string, args: readonly string[], sandbox: Sandbox | null = null) =>
  runBash({
    command: 'env',
    args: [
      ...gitEnv(sandbox),
      'bash',
      '-o',
      'pipefail',
      '-c',
      'input=$1; select=$2; classify=$3; shift 3; ' +
        'printf "%s" "$input" | "$select" --from-discovery | "$classify" "$@"',
      'pipeline',
      input,
      SELECT,
      CLASSIFY,
      ...args,
    ],
  })

const typescriptSide = (
  input: string,
  args: readonly string[],
  sandbox: Sandbox | null = null,
): Promise<CommandResult> => {
  const context: CommandContext = {
    args,
    env: sandbox === null ? process.env : sandbox.env,
    io: { stdout: () => {}, stderr: () => {}, readStdin: () => input },
    commandNames: [],
  }
  return classifyLines(context, run, selectAdapter, process.cwd())
}

const answerOf = (result: CommandResult): { status: number; json: JsonValue | undefined } => {
  if (result === undefined) throw new Error('classify-lines answered with silence')
  if (result.outcome === 'ok') return { status: 0, json: result.value }
  return { status: exitCodeFor(result), json: undefined }
}

const isObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The three declared normalizations of the bash answer, in the header. */
const normalized = (answer: JsonValue): JsonValue => {
  if (!isObject(answer)) return answer
  const groups = (list: JsonValue | undefined): JsonValue | undefined =>
    Array.isArray(list)
      ? list.map((entry) => {
          if (!isObject(entry)) return entry
          const { adapter_path: _path, ...rest } = entry
          return rest
        })
      : list
  const errors = Array.isArray(answer.classify_errors)
    ? answer.classify_errors.map((entry) => {
        if (!isObject(entry)) return entry
        let error = entry.error
        try {
          const said = JSON.parse(String(error)) as JsonValue
          if (isObject(said) && typeof said.error === 'string') error = said.error
        } catch {
          // A line that is not JSON stays as it is.
        }
        return { ...entry, adapter: 'node', error: error ?? null }
      })
    : answer.classify_errors
  const out: { [key: string]: JsonValue } = { ...answer }
  for (const key of ['actionable', 'skipped'] as const) {
    const list = groups(answer[key])
    if (list !== undefined) out[key] = list
  }
  if (errors !== undefined) out.classify_errors = errors
  return out
}

const expectSame = async (
  input: string,
  args: readonly string[],
  sandbox: Sandbox | null = null,
): Promise<{ [key: string]: JsonValue }> => {
  const bash = bashSide(input, args, sandbox)
  expect(bash.status).toBe(0)
  const answer = normalized(JSON.parse(bash.stdout) as JsonValue)
  const port = answerOf(await typescriptSide(input, args, sandbox))
  expect(port.status).toBe(0)
  expect(firstDifference(answer, port.json as JsonValue)).toBeNull()
  return answer as { [key: string]: JsonValue }
}

const expectBothRefuse = async (
  input: string,
  args: readonly string[],
  sandbox: Sandbox | null = null,
): Promise<void> => {
  const bash = bashSide(input, args, sandbox)
  expect(bash.status).toBe(1)
  // A failed first stage leaves the second stage an empty input, and it
  // writes one empty line for it.
  expect(bash.stdout.trim()).toBe('')
  expect(answerOf(await typescriptSide(input, args, sandbox)).status).toBe(1)
}

/** The status of each group, as `<package>@<line>:<status>`. */
const statuses = (answer: { [key: string]: JsonValue }): string[] =>
  [...(answer.actionable as Group[]), ...(answer.skipped as Group[])]
    .filter((entry) => 'line_status' in entry)
    .map((entry) => `${entry.package}@${entry.major_line}:${entry.line_status}`)

const withFixture = async <T>(name: string, body: (root: string) => Promise<T>): Promise<T> => {
  const copy = useFixture(name)
  try {
    return await body(copy.path)
  } finally {
    copy.cleanup()
  }
}

describe('classify-lines parity: the line statuses on real lockfiles', () => {
  it.each([
    ['npm-cross-line'],
    ['npm-cross-line-collapsed'],
    ['npm-cross-line-qualified'],
    ['npm-scoped-cross-line'],
    ['pnpm-cross-line'],
    ['pnpm-cross-line-collapsed'],
    ['pnpm-cross-line-qualified'],
    ['yarn-cross-line'],
    ['yarn-cross-line-collapsed'],
  ])('classifies the cross-line groups on %s', async (name) => {
    await withFixture(name, (root) => expectSame(CROSS_LINE, ['--repo-root', root]))
  })

  it('reaches every status on the specimens, so the rows above prove each one', async () => {
    const seen = new Set<string>()
    for (const name of ['npm-cross-line', 'yarn-cross-line']) {
      const answer = await withFixture(name, (root) =>
        expectSame(CROSS_LINE, ['--repo-root', root]),
      )
      for (const entry of statuses(answer)) seen.add(entry.split(':')[1] as string)
    }
    expect([...seen].sort()).toEqual([
      'cross_line_collision',
      'line_absent',
      'requires_major_bump',
      'resolved',
      'unknown',
    ])
  })

  it.each([
    ['npm-v3', ['lodash', 'express']],
    ['pnpm-v9', ['lodash', 'express']],
    ['yarn-berry', ['lodash', 'express']],
    ['yarn-multi-major', ['undici', 'legacy-client']],
  ])('classifies the groups of %s', async (name, packages) => {
    const groups = packages.flatMap((pkg) => ['1', '4', '5', '6'].map((line) => group(pkg, line)))
    await withFixture(name, (root) => expectSame(envelope(groups), ['--repo-root', root]))
  })

  it.each([['no-lockfile'], ['yarn-classic'], ['bun']])(
    'names the adapter failure on %s, and keeps the group as unknown',
    async (name) => {
      const answer = await withFixture(name, (root) =>
        expectSame(envelope([group('lodash', '4')]), ['--repo-root', root]),
      )
      expect(answer.classify_errors).toHaveLength(1)
    },
  )
})

describe('classify-lines parity: the route and the envelope', () => {
  it('moves an ecosystem with no adapter into skipped, after the groups already there', async () => {
    const input = envelope(
      [
        group('lodash', '4'),
        group('flask', '2', { ecosystem: 'pip' }),
        group('rails', '7', { ecosystem: 'rubygems' }),
        group('ghost', '1', { ecosystem: null }),
      ],
      [group('old', 'none', { reason: 'no fix available' })],
    )
    await withFixture('npm-v3', (root) => expectSame(input, ['--repo-root', root]))
  })

  it('keeps a top-level key it does not know', async () => {
    const input = JSON.stringify({
      actionable: [group('lodash', '4')],
      skipped: [],
      extra: [{ note: 'carried by the caller' }],
    })
    await withFixture('npm-v3', (root) => expectSame(input, ['--repo-root', root]))
  })

  it.each([
    ['no skipped list', JSON.stringify({ actionable: [group('lodash', '4')] })],
    ['no actionable list', JSON.stringify({ skipped: [group('old', 'none')] })],
    ['an empty envelope', '{}'],
    ['a group with no package', envelope([{ ecosystem: 'npm', major_line: '4' }])],
    ['a group with no line', envelope([{ ecosystem: 'npm', package: 'lodash' }])],
    ['a numeric line', envelope([group('lodash', '4', { major_line: 4 })])],
    [
      'a classify_errors key from an earlier run',
      JSON.stringify({ actionable: [], classify_errors: [1] }),
    ],
  ])('reads %s as the script does', async (_case, input) => {
    await withFixture('npm-v3', (root) => expectSame(input, ['--repo-root', root]))
  })

  it.each([[['--branch-style', 'flat']], [['--branch-style=flat']], [['--branch-style', 'slash']]])(
    'renames the plugin branches of both lists, and no other name (%j)',
    async (style) => {
      const input = envelope(
        [group('lodash', '4'), group('express', '4', { branch_name: 'sec/express-4' })],
        [group('left-pad', 'none', { reason: 'no fix available' }), { package: 'bare' }],
      )
      await withFixture('npm-v3', (root) => expectSame(input, ['--repo-root', root, ...style]))
    },
  )
})

describe('classify-lines parity: the refusals', () => {
  it.each([
    ['no --repo-root', []],
    ['an unknown branch style', ['--repo-root', FIXTURES_ROOT, '--branch-style', 'diagonal']],
    ['an unknown argument', ['--repo-root', FIXTURES_ROOT, '--nope']],
    ['a base ref with no origin prefix', ['--repo-root', FIXTURES_ROOT, '--base-ref', 'main']],
    ['a base ref of origin/ alone', ['--repo-root', FIXTURES_ROOT, '--base-ref', 'origin/']],
  ])('refuses %s', async (_case, args) => {
    await expectBothRefuse(envelope([]), args)
  })

  it('refuses a --repo-root that is not a directory', async () => {
    await expectBothRefuse(envelope([]), ['--repo-root', join(FIXTURES_ROOT, 'no-such-dir')])
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['an actionable that is not a list', '{"actionable":"oops","skipped":[]}'],
    ['a skipped that is not a list', '{"actionable":[],"skipped":"oops"}'],
  ])('refuses %s on stdin', async (_case, input) => {
    await expectBothRefuse(input, ['--repo-root', FIXTURES_ROOT])
  })

  it('refuses groups of more than one repository', async () => {
    const input = envelope([group('lodash', '4'), group('express', '4', { repo: 'octo/other' })])
    await withFixture('npm-v3', (root) => expectBothRefuse(input, ['--repo-root', root]))
  })

  it('answers nothing for empty stdin in the pipeline, where the port refuses it', async () => {
    const bash = bashSide('', ['--repo-root', FIXTURES_ROOT])
    // The second stage writes one empty line, and no JSON.
    expect({ status: bash.status, stdout: bash.stdout }).toEqual({ status: 0, stdout: '\n' })
    expect(answerOf(await typescriptSide('', ['--repo-root', FIXTURES_ROOT])).status).toBe(1)
  })
})

describe('classify-lines parity: --base-ref', () => {
  /**
   * A repository whose `main` on origin holds the npm-cross-line lockfile,
   * checked out on a feature branch that holds the collapsed one. So the
   * answer says which tree was read: on `main`, brace-expansion 1 is resolved,
   * and on the feature branch it is not.
   */
  const repository = () => {
    const sandbox = createSandbox()
    const fixtures = createGitFixtures(sandbox)
    const work = fixtures.create(sandbox.join('repo'))
    fixtures.importTree(work, join(FIXTURES_ROOT, 'npm-cross-line'))
    fixtures.push(work)
    fixtures.git(work, 'checkout', '-q', '-b', 'feature')
    copyFileSync(
      join(FIXTURES_ROOT, 'npm-cross-line-collapsed', 'package-lock.json'),
      join(work, 'package-lock.json'),
    )
    fixtures.git(work, 'commit', '-qam', 'feature')
    const worktrees = () =>
      fixtures
        .git(work, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length
    /** Push the collapsed lockfile to origin's main from a second clone. */
    const advanceOrigin = () => {
      const other = sandbox.join('other')
      fixtures.git(sandbox.path, 'clone', '-q', join(sandbox.join('repo'), 'origin.git'), other)
      copyFileSync(
        join(FIXTURES_ROOT, 'npm-cross-line-collapsed', 'package-lock.json'),
        join(other, 'package-lock.json'),
      )
      fixtures.git(other, 'commit', '-qam', 'advance')
      fixtures.git(other, 'push', '-q', 'origin', 'HEAD:main')
    }
    return { sandbox, fixtures, work, worktrees, advanceOrigin }
  }

  const ONE = envelope([group('brace-expansion', '1'), group('brace-expansion', '5')])

  it('judges against origin/main, not the checkout, and removes its worktree', async () => {
    const { sandbox, work, worktrees } = repository()
    const answer = await expectSame(
      ONE,
      ['--repo-root', work, '--base-ref', 'origin/main'],
      sandbox,
    )
    expect(statuses(answer)).toEqual(['brace-expansion@1:resolved', 'brace-expansion@5:resolved'])
    expect(worktrees()).toBe(1)
  })

  it('judges the checkout as it is without --base-ref', async () => {
    const { sandbox, work } = repository()
    const answer = await expectSame(ONE, ['--repo-root', work], sandbox)
    expect(statuses(answer)).toEqual([
      'brace-expansion@1:line_absent',
      'brace-expansion@5:resolved',
    ])
  })

  it('fetches first, so a stale remote-tracking ref cannot answer', async () => {
    const { sandbox, work, advanceOrigin } = repository()
    advanceOrigin()
    const answer = await expectSame(ONE, ['--repo-root', work, '--base-ref=origin/main'], sandbox)
    expect(statuses(answer)).toEqual([
      'brace-expansion@1:line_absent',
      'brace-expansion@5:resolved',
    ])
  })

  it('fetches under a narrowed fetch refspec', async () => {
    const { sandbox, fixtures, work, advanceOrigin } = repository()
    fixtures.git(
      work,
      'config',
      'remote.origin.fetch',
      '+refs/heads/other:refs/remotes/origin/other',
    )
    advanceOrigin()
    const answer = await expectSame(
      ONE,
      ['--repo-root', work, '--base-ref', 'origin/main'],
      sandbox,
    )
    expect(statuses(answer)).toEqual([
      'brace-expansion@1:line_absent',
      'brace-expansion@5:resolved',
    ])
  })

  it('ignores an edit in the work tree that is not committed', async () => {
    const { sandbox, work } = repository()
    writeFileSync(join(work, 'package-lock.json'), '{"broken": true}\n')
    const answer = await expectSame(
      ONE,
      ['--repo-root', work, '--base-ref', 'origin/main'],
      sandbox,
    )
    expect(statuses(answer)).toEqual(['brace-expansion@1:resolved', 'brace-expansion@5:resolved'])
  })

  it('accepts a linked worktree root as the top level', async () => {
    const { sandbox, fixtures, work } = repository()
    const linked = sandbox.join('linked')
    fixtures.git(work, 'worktree', 'add', '-q', linked, 'main')
    await expectSame(ONE, ['--repo-root', linked, '--base-ref', 'origin/main'], sandbox)
  })

  it('refuses a subdirectory of the repository', async () => {
    const { sandbox, work } = repository()
    mkdirSync(join(work, 'subdir'))
    await expectBothRefuse(
      ONE,
      ['--repo-root', join(work, 'subdir'), '--base-ref', 'origin/main'],
      sandbox,
    )
  })

  it('refuses a directory outside any repository', async () => {
    const { sandbox } = repository()
    const plain = mkdtempSync(sandbox.join('plain-'))
    await expectBothRefuse(ONE, ['--repo-root', plain, '--base-ref', 'origin/main'], sandbox)
  })

  it('refuses a branch that origin does not have, and leaves no worktree', async () => {
    const { sandbox, work, worktrees } = repository()
    await expectBothRefuse(ONE, ['--repo-root', work, '--base-ref', 'origin/nope'], sandbox)
    expect(worktrees()).toBe(1)
  })

  it('refuses a base ref with a quote in it, and leaves no worktree', async () => {
    const { sandbox, work, worktrees } = repository()
    await expectBothRefuse(ONE, ['--repo-root', work, '--base-ref', 'origin/we"ird'], sandbox)
    expect(worktrees()).toBe(1)
  })
})

// The declared exception of #168 (ruling 3). On the lockfile, got
// 9.6.0 is below line 11, got 12.6.1 is above it, and the alert range covers
// 9.6.0. The script answers `line_absent`. The port moves the group into
// skipped, because its only fix crosses a major. Where every copy is below the
// line, the two agree.
describe('classify-lines: the declared exception of #168', () => {
  const GOT_11 = envelope([
    group('got', '11', {
      alerts: [{ vulnerable_range: '< 11.8.5' }],
      sibling_alerts: [],
    }),
  ])

  it('gives line_absent in the script and requires_major_bump in the port', async () => {
    const answers = await withFixture('npm-major-bump-below-above', async (root) => {
      const bash = bashSide(GOT_11, ['--repo-root', root])
      const port = answerOf(await typescriptSide(GOT_11, ['--repo-root', root]))
      return { bash: JSON.parse(bash.stdout) as { [key: string]: JsonValue }, port: port.json }
    })
    expect({
      bash: statuses(answers.bash),
      port: statuses(answers.port as { [key: string]: JsonValue }),
    }).toEqual({
      bash: ['got@11:line_absent'],
      port: ['got@11:requires_major_bump'],
    })
  })

  it('agrees where every copy is below the line', async () => {
    const input = envelope([
      group('got', '11', { alerts: [{ vulnerable_range: '< 11.8.5' }], sibling_alerts: [] }),
      group('marked', '4', { alerts: [{ vulnerable_range: '< 4.0.10' }], sibling_alerts: [] }),
    ])
    await withFixture('npm-major-bump-sole', (root) => expectSame(input, ['--repo-root', root]))
  })
})
