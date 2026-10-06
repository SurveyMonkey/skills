// `gh-security build-dispatches`. The seam is the exported handler, with the
// current directory as a parameter. There is no bash script to compare with:
// this is a contract of #193, built here. I wrote each expected value by hand
// from `resolve-alerts` SKILL.md phase 6, the guard of
// `workflows/fix-groups.mjs` (`validateArgs`) and the contract comment on
// #228.
//
// The envelope is real: the answer of the real `merge-envelopes` on its own
// fixtures (`spec/fixtures/merge-envelopes/`), written to a scratch file. So
// an example also shows that the two commands agree on the shape between
// them. The names in the fixtures are fictitious.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { commandNames } from '#gh-security/cli/registry.ts'
import { run } from '#gh-security/lib/process.ts'
import { allowOwnCommands } from '#gh-security/subcommands/allow-own-commands.ts'
import {
  buildDispatches,
  buildDispatchesCommand,
} from '#gh-security/subcommands/build-dispatches.ts'
import { mergeEnvelopes } from '#gh-security/subcommands/merge-envelopes.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')
const MERGE_FIXTURES = join(FIXTURES_ROOT, 'merge-envelopes')
const ADAPTER_PATH = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')
const SCRIPTS_DIR = pluginFile('gh-security', 'scripts', 'common')

const context = (args: readonly string[]): CommandContext => ({
  args,
  env: {},
  io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
  commandNames: [],
})

const value = (result: CommandResult): Record<string, unknown> => {
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value as Record<string, unknown>
}

/** The merge of the named fixtures, as `merge-envelopes` gives it. */
const merged = (...files: string[]): Record<string, unknown> =>
  value(mergeEnvelopes(context(files), MERGE_FIXTURES))

/** A scratch directory with each entry as a JSON file. */
const filesOf = (entries: Record<string, unknown>): string => {
  const dir = createSandbox().path
  for (const [name, content] of Object.entries(entries)) {
    writeFileSync(
      join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    )
  }
  return dir
}

const group = (file: string, branch: string): Record<string, unknown> => {
  const answer = JSON.parse(readFileSync(join(MERGE_FIXTURES, file), 'utf8')) as {
    actionable: Record<string, unknown>[]
  }
  const found = answer.actionable.find((g) => g.branch_name === branch)
  if (found === undefined) throw new Error(`no group ${branch} in ${file}`)
  return found
}

describe('build-dispatches: the Workflow args', () => {
  it('gives cap and one payload for each approved group, in the order of actionable', () => {
    const dir = filesOf({
      'merged.json': merged('app.json', 'api.json', 'excluded.json'),
      'prefixes.json': { '/work/app': 'env-run --profile work' },
    })
    const answer = buildDispatches(
      context([
        '--envelope',
        'merged.json',
        '--cap',
        '3',
        '--env-prefixes',
        'prefixes.json',
        'octo/app:fix/dependabot-lodash-4x',
        'octo/api:fix/dependabot-qs-6x',
        'octo/api:fix/dependabot-lodash-4x',
      ]),
      dir,
    )
    expect(value(answer)).toEqual({
      cap: 3,
      dispatches: [
        {
          group: group('api.json', 'fix/dependabot-qs-6x'),
          adapter_path: ADAPTER_PATH,
          nwo: 'octo/api',
          default_branch: 'trunk',
          repo_root: '/work/api',
          scripts_dir: SCRIPTS_DIR,
        },
        {
          group: group('api.json', 'fix/dependabot-lodash-4x'),
          adapter_path: ADAPTER_PATH,
          nwo: 'octo/api',
          default_branch: 'trunk',
          repo_root: '/work/api',
          scripts_dir: SCRIPTS_DIR,
        },
        {
          group: group('app.json', 'fix/dependabot-lodash-4x'),
          adapter_path: ADAPTER_PATH,
          nwo: 'octo/app',
          default_branch: 'main',
          repo_root: '/work/app',
          scripts_dir: SCRIPTS_DIR,
          env_prefix: 'env-run --profile work',
        },
      ],
    })
  })
})

/** The merge of app.json, api.json and excluded.json, in a scratch directory. */
const scene = (extra: Record<string, unknown> = {}) =>
  filesOf({ 'merged.json': merged('app.json', 'api.json', 'excluded.json'), ...extra })

const build = (dir: string, ...args: string[]): CommandResult =>
  buildDispatches(context(['--envelope', 'merged.json', '--cap', '2', ...args]), dir)

const dispatchesOf = (result: CommandResult): Record<string, unknown>[] =>
  value(result).dispatches as Record<string, unknown>[]

describe('build-dispatches: the payload (pin: still carries $1)', () => {
  it.each([
    ['nwo', 'octo/web'],
    ['adapter_path', ADAPTER_PATH],
    ['default_branch', 'main'],
    ['repo_root', '/work/web'],
    ['scripts_dir', SCRIPTS_DIR],
  ])('carries %s', (key, expected) => {
    const dir = filesOf({ 'merged.json': merged('web.json') })
    const [dispatch] = dispatchesOf(build(dir, 'octo/web:fix/dependabot-tar-6x'))
    expect(dispatch?.[key]).toBe(expected)
  })

  it('carries the group verbatim, with each field that it has', () => {
    const [dispatch] = dispatchesOf(build(scene(), 'octo/app:fix/dependabot-minimist-1x'))
    expect(dispatch?.group).toEqual(group('app.json', 'fix/dependabot-minimist-1x'))
  })

  it('takes the adapter path from the ecosystem of the group, and the file is there', () => {
    const [dispatch] = dispatchesOf(build(scene(), 'octo/app:fix/dependabot-minimist-1x'))
    expect(readFileSync(dispatch?.adapter_path as string, 'utf8')).toMatch(/^#!/)
  })
})

describe('build-dispatches: env_prefix (pin: still omits env_prefix rather than sending null)', () => {
  it('omits the key, and never sends null, when there is no prefixes file', () => {
    const [dispatch] = dispatchesOf(build(scene(), 'octo/app:fix/dependabot-minimist-1x'))
    expect(Object.keys(dispatch ?? {}).sort()).toEqual([
      'adapter_path',
      'default_branch',
      'group',
      'nwo',
      'repo_root',
      'scripts_dir',
    ])
  })

  it('gives each repository its own prefix, and omits it for a checkout with none (pin: carries env_prefix into the fix-dependency Task payload)', () => {
    const dir = scene({ 'prefixes.json': { '/work/api': 'env-run api' } })
    const dispatches = dispatchesOf(
      build(
        dir,
        '--env-prefixes',
        'prefixes.json',
        'octo/app:fix/dependabot-minimist-1x',
        'octo/api:fix/dependabot-qs-6x',
      ),
    )
    expect(dispatches.map((d) => [d.nwo, Object.hasOwn(d, 'env_prefix'), d.env_prefix])).toEqual([
      ['octo/api', true, 'env-run api'],
      ['octo/app', false, undefined],
    ])
  })

  it('gives the prefix verbatim, spaces and all', () => {
    const dir = scene({ 'prefixes.json': { '/work/app': '  env-run   --dir /work/app ' } })
    const [dispatch] = dispatchesOf(
      build(dir, '--env-prefixes', 'prefixes.json', 'octo/app:fix/dependabot-minimist-1x'),
    )
    expect(dispatch?.env_prefix).toBe('  env-run   --dir /work/app ')
  })

  it.each([
    ['a list', ['env-run'], 'build-dispatches: prefixes.json is not a JSON object'],
    [
      'a path that is not a checkout',
      { '/work/elsewhere': 'env-run' },
      'build-dispatches: prefixes.json names /work/elsewhere, which is not a kept checkout',
    ],
    [
      'an excluded checkout',
      { '/work/old': 'env-run' },
      'build-dispatches: prefixes.json names /work/old, which is not a kept checkout',
    ],
    [
      'a null prefix',
      { '/work/app': null },
      'build-dispatches: prefixes.json gives /work/app a prefix with no word in it',
    ],
    [
      'an empty prefix',
      { '/work/app': ' ' },
      'build-dispatches: prefixes.json gives /work/app a prefix with no word in it',
    ],
    [
      'the word null as its prefix',
      { '/work/app': ' null ' },
      'build-dispatches: prefixes.json gives /work/app a prefix with no word in it',
    ],
  ])('refuses a prefixes file with %s', (_name, prefixes, error) => {
    const dir = scene({ 'prefixes.json': prefixes })
    expect(
      build(dir, '--env-prefixes', 'prefixes.json', 'octo/app:fix/dependabot-minimist-1x'),
    ).toEqual({ outcome: 'failed', error })
  })

  it.each([
    ['is not there', null, /^build-dispatches: cannot read prefixes\.json: ENOENT/],
    ['is not JSON', '{', /^build-dispatches: prefixes\.json is not JSON$/],
  ])('refuses a prefixes file that %s', (_name, text, error) => {
    const dir = scene(text === null ? {} : { 'prefixes.json': text })
    const answer = build(
      dir,
      '--env-prefixes',
      'prefixes.json',
      'octo/app:fix/dependabot-minimist-1x',
    )
    expect(answer?.outcome === 'failed' && answer.error).toMatch(error)
  })
})

describe('build-dispatches: the batch (pin: names the silent empty-batch inversion that guard prevents)', () => {
  it('refuses an empty batch, and gives no args', () => {
    expect(build(scene())).toEqual({
      outcome: 'failed',
      error:
        'usage: gh-security build-dispatches --envelope <merged.json> --cap <n> [--env-prefixes <prefixes.json>] <repo>:<branch_name>...',
    })
  })

  it.each(['0', '-1', '1.5', 'two', '', '01', ' 2', '99999999999999999999'])(
    'refuses the cap %j',
    (cap) => {
      const answer = buildDispatches(
        context([
          '--envelope',
          'merged.json',
          `--cap=${cap}`,
          'octo/app:fix/dependabot-minimist-1x',
        ]),
        scene(),
      )
      expect(answer).toEqual({
        outcome: 'failed',
        error: `build-dispatches: --cap is not a whole number of 1 or more: ${cap}`,
      })
    },
  )

  it('refuses a command line with no envelope', () => {
    const answer = buildDispatches(context(['--cap', '2', 'octo/app:fix/x']), scene())
    expect(answer?.outcome === 'failed' && answer.error).toMatch(/^usage: /)
  })

  it('refuses an option that it does not know', () => {
    expect(build(scene(), '--group-json', 'x', 'octo/app:fix/x')?.outcome).toBe('failed')
  })

  it('refuses an id given twice, which would start two agents on one branch', () => {
    const id = 'octo/app:fix/dependabot-minimist-1x'
    expect(build(scene(), id, id)).toEqual({
      outcome: 'failed',
      error: `build-dispatches: the id ${id} is given twice`,
    })
  })

  it.each([
    ['no group', 'octo/app:fix/dependabot-nothing-1x', 0],
    ['a skipped group', 'octo/api:fix-dependabot-debug-unfixed', 0],
    ['the branch of another repository', 'octo/web:fix/dependabot-lodash-4x', 0],
    ['a branch name with no repo', 'fix/dependabot-minimist-1x', 0],
    ['two groups', 'octo/app:fix/dependabot-cookie-0x', 2],
  ])('refuses an id that names %s', (_name, id, count) => {
    expect(build(scene(), id)).toEqual({
      outcome: 'failed',
      error: `build-dispatches: the id ${id} names ${count} actionable groups, not 1`,
    })
  })

  it('dispatches only the approved groups, and never one of a checkout the batch left out', () => {
    const dispatches = dispatchesOf(build(scene(), 'octo/api:fix/dependabot-lodash-4x'))
    expect(dispatches.map((d) => (d.group as Record<string, unknown>).branch_name)).toEqual([
      'fix/dependabot-lodash-4x',
    ])
    expect(dispatches.map((d) => d.repo_root)).toEqual(['/work/api'])
  })
})

describe('build-dispatches: the envelope', () => {
  const MERGED = merged('app.json', 'api.json', 'excluded.json') as {
    checkouts: Record<string, unknown>[]
    actionable: Record<string, unknown>[]
  }
  const ID = 'octo/app:fix/dependabot-minimist-1x'

  it.each([
    ['a list', []],
    ['a field that a merge does not give', { ...MERGED, groups: [] }],
    ['no skipped list', { ...MERGED, skipped: undefined }],
    ['a checkout that is not an object', { ...MERGED, checkouts: ['/work/app'] }],
    [
      'a checkout whose path is not text',
      { ...MERGED, checkouts: [{ checkout: 7, nwo: 'octo/app', default_branch: 'main' }] },
    ],
    [
      'a checkout with no default branch',
      { ...MERGED, checkouts: [{ checkout: '/work/app', nwo: 'octo/app' }] },
    ],
    [
      'a group with an empty branch name',
      { ...MERGED, actionable: [{ ...MERGED.actionable[0], branch_name: '' }] },
    ],
    [
      'a group whose major line is a number',
      { ...MERGED, actionable: [{ ...MERGED.actionable[0], major_line: 1 }] },
    ],
    [
      'a group with no repo',
      { ...MERGED, actionable: [{ ...MERGED.actionable[0], repo: undefined }] },
    ],
    [
      'a group with no ecosystem',
      { ...MERGED, actionable: [{ ...MERGED.actionable[0], ecosystem: undefined }] },
    ],
  ])('refuses an envelope that is %s', (_name, envelope) => {
    const answer = build(filesOf({ 'merged.json': envelope }), ID)
    expect(answer?.outcome === 'failed' && answer.error).toMatch(
      /^build-dispatches: merged\.json is not an answer of merge-envelopes: /,
    )
  })

  it('names the field that is wrong', () => {
    const envelope = { ...MERGED, actionable: [{ ...MERGED.actionable[0], package: 7 }] }
    expect(build(filesOf({ 'merged.json': envelope }), ID)).toEqual({
      outcome: 'failed',
      error:
        'build-dispatches: merged.json is not an answer of merge-envelopes: actionable[0].package is not a text that is not empty',
    })
  })

  it.each([
    ['is not there', {}, /^build-dispatches: cannot read merged\.json: ENOENT/],
    [
      'is not JSON',
      { 'merged.json': '{"checkouts": [' },
      /^build-dispatches: merged\.json is not JSON$/,
    ],
  ])('refuses an envelope that %s', (_name, files, error) => {
    const answer = build(filesOf(files), ID)
    expect(answer?.outcome === 'failed' && answer.error).toMatch(error)
  })

  it('refuses a group whose repo is the nwo of no checkout', () => {
    const envelope = { ...MERGED, checkouts: MERGED.checkouts.filter((c) => c.nwo !== 'octo/app') }
    expect(build(filesOf({ 'merged.json': envelope }), ID)).toEqual({
      outcome: 'failed',
      error: `build-dispatches: ${ID}: the repo octo/app is the nwo of 0 checkouts, not 1`,
    })
  })

  it('refuses a group whose repo is the nwo of two checkouts', () => {
    const app = MERGED.checkouts.find((c) => c.nwo === 'octo/app')
    const envelope = {
      ...MERGED,
      checkouts: [...MERGED.checkouts, { ...app, checkout: '/copy/app' }],
    }
    expect(build(filesOf({ 'merged.json': envelope }), ID)).toEqual({
      outcome: 'failed',
      error: `build-dispatches: ${ID}: the repo octo/app is the nwo of 2 checkouts, not 1`,
    })
  })

  it('refuses a group whose ecosystem has no adapter', () => {
    const groups = MERGED.actionable.map((g) =>
      g.branch_name === 'fix/dependabot-minimist-1x' ? { ...g, ecosystem: 'pip' } : g,
    )
    expect(build(filesOf({ 'merged.json': { ...MERGED, actionable: groups } }), ID)).toEqual({
      outcome: 'failed',
      error: `build-dispatches: ${ID}: the ecosystem pip has no adapter`,
    })
  })
})

describe('the allow hook', () => {
  it('approves the phase 6 command', () => {
    const command = `node ${ENTRY} build-dispatches --envelope /tmp/merged.json --cap 4 --env-prefixes /tmp/prefixes.json octo/app:fix/dependabot-lodash-4x octo/api:fix-dependabot-qs-6x`
    const input = { tool_name: 'Bash', tool_input: { command } }
    expect(allowOwnCommands(input, ENTRY, commandNames)?.hookSpecificOutput).toMatchObject({
      permissionDecision: 'allow',
    })
  })
})

describe('the registered handler', () => {
  it('reads the envelope from the current directory of the process', () => {
    const dir = scene()
    const answer = buildDispatchesCommand(
      context([
        '--envelope',
        join(dir, 'merged.json'),
        '--cap',
        '1',
        'octo/app:fix/dependabot-minimist-1x',
      ]),
    )
    expect(dispatchesOf(answer as CommandResult).map((d) => d.repo_root)).toEqual(['/work/app'])
  })
})

describe('the process (pin: tells the caller to pass args as JSON, never as a JSON-encoded string)', () => {
  it('writes the args as one JSON object on stdout, with exit 0', async () => {
    const dir = scene()
    const result = await run(
      process.execPath,
      [
        ENTRY,
        'build-dispatches',
        '--envelope',
        'merged.json',
        '--cap',
        '4',
        'octo/api:fix/dependabot-qs-6x',
      ],
      { cwd: dir, env: createSandbox().env },
    )
    const args = JSON.parse(result.stdout) as unknown
    expect({ status: result.status, args }).toEqual({
      status: 0,
      args: {
        cap: 4,
        dispatches: [
          {
            group: group('api.json', 'fix/dependabot-qs-6x'),
            adapter_path: ADAPTER_PATH,
            nwo: 'octo/api',
            default_branch: 'trunk',
            repo_root: '/work/api',
            scripts_dir: SCRIPTS_DIR,
          },
        ],
      },
    })
  })

  it('exits 1 on an empty batch, with the error as JSON on stdout and as prose on stderr', async () => {
    const result = await run(
      process.execPath,
      [ENTRY, 'build-dispatches', '--envelope', 'merged.json', '--cap', '4'],
      { cwd: scene(), env: createSandbox().env },
    )
    const usage =
      'usage: gh-security build-dispatches --envelope <merged.json> --cap <n> [--env-prefixes <prefixes.json>] <repo>:<branch_name>...'
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: `${JSON.stringify({ error: usage })}\n`,
      stderr: `${usage}\n`,
    })
  })
})
