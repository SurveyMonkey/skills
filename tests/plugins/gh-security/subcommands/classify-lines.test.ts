// `gh-security classify-lines`. The seam is the exported handler, with the
// process runner, the registry and the working directory as parameters.
//
// The adapter is a stand-in, given through the registry parameter (`mocking.md`,
// "The injected collaborator"). It stands in for the node adapter, and answers
// `resolved_versions` and `declared_ranges` with fixed replies for each
// package. Those replies are the ones that `spec/classify_lines_spec.sh` gives
// its stand-in adapter, and that spec drew them from the specs of `node.sh`.
// `compare_versions` is the real semver of the node adapter, except for a
// version that the stand-in refuses on purpose. Git is real: the `--base-ref`
// examples run in repositories with a bare origin from `harness/git.ts`, and
// a stand-in runner refuses one git call where an example needs a git
// failure. The expected values are written by hand from the contract in the
// header of the command. The pipeline of bash scripts is compared in
// `parity-classify-lines.test.ts`.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Adapter, ResolvedVersionsAnswer } from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { type Envelope, failed, ok } from '#gh-security/lib/envelope.ts'
import { type Runner, type RunResult, run } from '#gh-security/lib/process.ts'
import { classifyLines, classifyLinesCommand } from '#gh-security/subcommands/classify-lines.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

const ENTRY = pluginFile('gh-security', 'scripts', 'gh-security.ts')

const USAGE =
  'usage: gh-security classify-lines [--env-prefix <prefix>] --repo-root <path> ' +
  '[--base-ref origin/<branch>] [--branch-style slash|flat] < discovery.json'

const DETECTION = {
  pm: 'npm',
  lockfile: 'package-lock.json',
  override_location: 'overrides',
  override_file: 'package.json',
  override_syntax: 'nested',
  pm_exec: 'npm',
  install_cmd: 'npm install',
  why_cmd: 'npm explain',
  supports_scoping: true,
} as NodeDetection

const copies = (pkg: string, versions: readonly unknown[], present = true) =>
  ok({
    pm: 'npm',
    package: pkg,
    present,
    count: versions.length,
    versions: versions.map((version) => ({ version, path: `node_modules/${pkg}` })),
    lockfile_entries: 10,
  } as ResolvedVersionsAnswer)

/** The `resolved_versions` replies, for each package. */
const RESOLVED: Record<string, Envelope<unknown>> = {
  'path-to-regexp': copies('path-to-regexp', ['0.2.5']),
  lodash: copies('lodash', ['4.17.21']),
  express: copies('express', ['5.1.0']),
  minimatch: copies('minimatch', ['3.1.2', '5.1.6']),
  ghost: copies('ghost', [], false),
  hollow: copies('hollow', []),
  vbuild: copies('vbuild', ['v6.2.0+build.99']),
  numeric: copies('numeric', [5]),
  duped: copies('duped', ['1.5.0', '2.5.0']),
  'sep-ok': copies('sep-ok', ['1.1.11', '5.0.5']),
  'same-copy': copies('same-copy', ['1.1.11', '5.0.5']),
  'dr-broken': copies('dr-broken', ['1.1.11', '5.0.5']),
  'dr-not-text': copies('dr-not-text', ['1.1.11', '5.0.5']),
  'scoped-copy': copies('scoped-copy', ['5.1.6', '10.0.3']),
  'null-copy': copies('null-copy', ['1.1.11', '5.0.5']),
  disjoint: copies('disjoint', ['1.5.0', '2.5.0']),
  'partial-a': copies('partial-a', ['1.0.0', '9.9.9-badcompare']),
  'partial-b': copies('partial-b', ['9.9.9-badcompare', '10.0.0']),
  'odd-compare': copies('odd-compare', ['1.0.0-odd']),
  'empty-version': copies('empty-version', ['', '1.0.0']),
  'empty-last': copies('empty-last', ['1.0.0', '']),
  'split-version': copies('split-version', ['1.0.0\n9.0.0']),
  boom: failed('resolved_versions: parser refused the lockfile'),
  sparse: ok({ pm: 'npm', present: true }),
  'not-an-object': ok('nothing'),
  'versions-not-a-list': ok({ present: true, versions: 'x' }),
  'present-not-a-boolean': ok({ present: 'true', versions: [{ version: '1.0.0' }] }),
  'version-missing': ok({ present: true, versions: [{ path: 'x' }] }),
  'version-not-an-object': ok({ present: true, versions: ['1.0.0'] }),
}

const ranges = (fields: Record<string, readonly unknown[]>) =>
  ok({
    pm: 'npm',
    package: 'x',
    line: 1,
    ranges: [],
    root_range: null,
    parents_read: [],
    parents_without_range: [],
    parents_unreadable: [],
    parents_malformed: [],
    parents_other_lines: [],
    ...fields,
  })

/** The `declared_ranges --line` replies, for each package and major. */
const DECLARED: Record<string, Envelope<unknown>> = {
  'duped 1': ranges({ parents_read: ['alpha'], parents_other_lines: ['beta'] }),
  'duped 2': ranges({ parents_read: ['beta'], parents_other_lines: ['alpha'] }),
  'sep-ok 5': ranges({ parents_read: ['minimatch'], parents_other_lines: ['minimatch@3.1.5'] }),
  'sep-ok 1': ranges({
    parents_unreadable: ['minimatch'],
    parents_other_lines: ['minimatch@10.2.5'],
  }),
  'same-copy 5': ranges({ parents_read: ['minimatch'], parents_other_lines: ['minimatch@3.1.5'] }),
  'same-copy 1': ranges({ parents_read: ['minimatch'], parents_other_lines: ['minimatch@3.1.5'] }),
  'scoped-copy 5': ranges({
    parents_read: ['@npmcli/map-workspaces'],
    parents_other_lines: ['@npmcli/map-workspaces@2.0.4'],
  }),
  'scoped-copy 10': ranges({
    parents_read: ['@npmcli/map-workspaces'],
    parents_other_lines: ['@npmcli/map-workspaces@2.0.4'],
  }),
  'null-copy 5': ranges({ parents_read: ['minimatch'], parents_other_lines: ['minimatch'] }),
  'null-copy 1': ranges({ parents_read: ['minimatch'], parents_other_lines: ['minimatch'] }),
  'disjoint 1': ranges({ parents_read: ['solo-1'], parents_without_range: ['shared-name'] }),
  'disjoint 2': ranges({ parents_read: ['solo-2'] }),
  'dr-broken 1': failed('declared_ranges: parser refused the lockfile'),
  'dr-broken 5': failed('declared_ranges: parser refused the lockfile'),
  'dr-not-text 1': ranges({ parents_read: ['a'], parents_other_lines: [5] }),
  'dr-not-text 5': ranges({ parents_read: ['a'] }),
}

interface StandInSpec {
  /** The answer of `detect`. */
  readonly detect?: Envelope<unknown>
  readonly location?: unknown
  /** Read each answer from files in the tree that the verb reads. */
  readonly fromTree?: boolean
  /** Throw from `resolved_versions`, as a defect would. */
  readonly throws?: boolean
}

/**
 * A registry whose `npm` adapter is the stand-in, and the log of its calls.
 * The log is the claim of the cache examples: a verb with a cache key runs
 * once for each key.
 */
const standIn = (spec: StandInSpec = {}) => {
  const calls: string[] = []
  const adapter: Adapter<NodeDetection> = {
    ...node,
    detect: (root) => {
      calls.push('detect')
      if (spec.detect !== undefined) return spec.detect as Envelope<NodeDetection>
      let location = 'location' in spec ? spec.location : 'overrides'
      const file = join(root, 'override-location')
      if (spec.fromTree === true && existsSync(file)) location = readFileSync(file, 'utf8').trim()
      return ok({ ...DETECTION, override_location: location } as NodeDetection)
    },
    resolvedVersions: (tree, pkg) => {
      calls.push(`resolved_versions ${pkg}`)
      if (spec.throws === true) throw new Error('a defect in the adapter')
      if (spec.fromTree === true && pkg === 'treecoll') return copies(pkg, ['1.5.0', '2.5.0'])
      if (spec.fromTree === true) {
        const file = join(tree.root, 'resolved-version')
        const version = existsSync(file) ? readFileSync(file, 'utf8').trim() : 'absent'
        return copies(pkg, [version])
      }
      return (RESOLVED[pkg] ??
        failed(`unexpected package ${pkg}`)) as Envelope<ResolvedVersionsAnswer>
    },
    declaredRanges: (tree, pkg, line) => {
      calls.push(`declared_ranges --line ${line} ${pkg}`)
      if (spec.fromTree === true) {
        const shared = existsSync(join(tree.root, 'dr-shared'))
        return ranges({ parents_read: [shared ? 'shared' : `solo-${line}`] }) as never
      }
      return (DECLARED[`${pkg} ${line}`] ??
        failed(`unexpected declared_ranges ${pkg} ${line}`)) as never
    },
    compareVersions: (a, b) => {
      calls.push(`compare_versions ${a} ${b}`)
      if (a.includes('badcompare')) return failed('compare_versions: unversionable input')
      if (a === '1.0.0-odd') return ok({} as never)
      return node.compareVersions(a, b)
    },
  }
  const route: typeof selectAdapter = (ecosystem, manifest = null) => {
    const real = selectAdapter(ecosystem, manifest)
    return real.supported ? { ...real, adapter } : real
  }
  return { route, calls }
}

type Group = Record<string, unknown>

const group = (pkg: string, line: unknown, fields: Group = {}): Group => ({
  package: pkg,
  major_line: line,
  ecosystem: 'npm',
  branch_name: `sec/${pkg}-${String(line)}`,
  ...fields,
})

const envelope = (actionable: readonly Group[], skipped: readonly Group[] = []): string =>
  JSON.stringify({ actionable, skipped })

const OLD = { package: 'old', reason: 'no fix available' }

const context = (
  args: readonly string[],
  stdin: string,
  env: Readonly<Record<string, string | undefined>> = { PATH: '/bin' },
  stderr: (text: string) => void = () => {},
): CommandContext => ({
  args,
  env,
  io: { stdout: () => {}, stderr, readStdin: () => stdin },
  commandNames: [],
})

/** A directory for `--repo-root` that the stand-in adapter never reads. */
const SOME_ROOT = FIXTURES_ROOT

const classify = (
  stdin: string,
  args: readonly string[] = ['--repo-root', SOME_ROOT],
  spec: StandInSpec = {},
): Promise<CommandResult> => classifyLines(context(args, stdin), run, standIn(spec).route, '/')

type Answer = { actionable: Group[]; skipped: Group[]; classify_errors: Group[] } & Group

const answer = async (
  stdin: string,
  args: readonly string[] = ['--repo-root', SOME_ROOT],
  spec: StandInSpec = {},
): Promise<Answer> => {
  const result = await classify(stdin, args, spec)
  if (result?.outcome !== 'ok') throw new Error(`expected an answer: ${JSON.stringify(result)}`)
  return result.value as Answer
}

/** The answer of a result that the example knows to be a success. */
const answerIn = (result: CommandResult): Answer => (result as unknown as { value: Answer }).value

/** The status of one group of one package, on its own in the envelope. */
const statusOf = async (pkg: string, line: unknown) => {
  const out = await answer(envelope([group(pkg, line)], [OLD]))
  const all = [...out.actionable, ...out.skipped.slice(1)]
  return {
    where: out.actionable.length === 1 ? 'actionable' : 'skipped',
    status: all[0]?.line_status,
    majors: all[0]?.resolved_majors,
    reason: all[0]?.reason,
    errors: out.classify_errors,
  }
}

describe('the line statuses', () => {
  it('moves a group whose every copy is below the line into skipped (#101)', async () => {
    expect(await statusOf('path-to-regexp', '1')).toEqual({
      where: 'skipped',
      status: 'requires_major_bump',
      majors: ['0'],
      reason: 'requires major version bump',
      errors: [],
    })
  })

  it('keeps a group with a copy on the line as resolved', async () => {
    expect(await statusOf('lodash', '4')).toMatchObject({
      where: 'actionable',
      status: 'resolved',
      majors: ['4'],
    })
  })

  it.each([
    ['one copy above the line', 'express', '4', ['5']],
    ['one copy below and one above', 'minimatch', '4', ['3', '5']],
  ])('keeps a group with %s as line_absent', async (_case, pkg, line, majors) => {
    expect(await statusOf(pkg, line)).toMatchObject({
      where: 'actionable',
      status: 'line_absent',
      majors,
    })
  })

  it.each([
    ['a package the lockfile does not have', 'ghost', '2'],
    ['a group with no usable line', 'lodash', 'none'],
    ['a group with no line at all', 'lodash', null],
  ])('keeps %s actionable as unknown, with no error', async (_case, pkg, line) => {
    expect(await statusOf(pkg, line)).toEqual({
      where: 'actionable',
      status: 'unknown',
      majors: pkg === 'ghost' ? [] : ['4'],
      reason: undefined,
      errors: [],
    })
  })

  it('names the error of a resolved_versions that fails, and keeps the group as unknown', async () => {
    expect(await statusOf('boom', '2')).toEqual({
      where: 'actionable',
      status: 'unknown',
      majors: [],
      reason: undefined,
      errors: [
        {
          adapter: 'node',
          package: 'boom',
          error: 'resolved_versions: parser refused the lockfile',
        },
      ],
    })
  })

  it.each([
    ['a reply with no versions', 'sparse', '{"pm":"npm","present":true}'],
    ['present with zero versions', 'hollow', undefined],
    ['a reply that is not an object', 'not-an-object', '"nothing"'],
    ['versions that are not a list', 'versions-not-a-list', undefined],
    ['a present that is not true or false', 'present-not-a-boolean', undefined],
    ['a copy with no version', 'version-missing', undefined],
    ['a copy that is not an object', 'version-not-an-object', undefined],
  ])('reads %s as a broken read: unknown, and named', async (_case, pkg, shown) => {
    const found = await statusOf(pkg, '2')
    expect(found).toMatchObject({ where: 'actionable', status: 'unknown', majors: [] })
    expect(found.errors).toHaveLength(1)
    expect(found.errors[0]).toMatchObject({ adapter: 'node', package: pkg })
    expect(String(found.errors[0]?.error)).toMatch(
      /^resolved_versions broke its contract \(ADR 001\): /,
    )
    if (shown !== undefined) {
      expect(found.errors[0]?.error).toBe(
        `resolved_versions broke its contract (ADR 001): ${shown}`,
      )
    }
  })

  it('trims a v prefix and build metadata to a plain major', async () => {
    expect(await statusOf('vbuild', '6')).toMatchObject({ status: 'resolved', majors: ['6'] })
  })

  it('reads a version that is a number as its text', async () => {
    expect(await statusOf('numeric', '5')).toMatchObject({ status: 'resolved', majors: ['5'] })
  })

  it('reads a numeric line as its text', async () => {
    expect(await statusOf('lodash', 4)).toMatchObject({ status: 'resolved' })
  })

  it.each([
    ['a below copy and then a compare that fails', 'partial-a', ['1', '9']],
    ['a compare that fails and then an above copy', 'partial-b', ['10', '9']],
  ])('stays unknown after %s', async (_case, pkg, majors) => {
    const found = await statusOf(pkg, '5')
    expect(found).toMatchObject({ where: 'actionable', status: 'unknown', majors })
    expect(found.errors).toEqual([
      { adapter: 'node', package: pkg, error: 'compare_versions: unversionable input' },
    ])
  })

  it('reads a compare_versions with no result as a broken read', async () => {
    const found = await statusOf('odd-compare', '2')
    expect(found).toMatchObject({ status: 'unknown' })
    expect(found.errors).toEqual([
      {
        adapter: 'node',
        package: 'odd-compare',
        error: 'compare_versions broke its contract (ADR 001): {}',
      },
    ])
  })

  it('compares the copy that has an empty version, and fails it', async () => {
    const found = await statusOf('empty-version', '2')
    expect(found).toMatchObject({ status: 'unknown' })
    expect(found.errors.map((entry) => entry.error)).toEqual([
      'compare_versions requires two versions',
    ])
  })

  it('drops an empty version at the end, as the script reads it', async () => {
    expect(await statusOf('empty-last', '2')).toMatchObject({
      status: 'requires_major_bump',
      errors: [],
    })
  })

  it('compares each line of a version as its own copy, as the script reads it', async () => {
    const { route, calls } = standIn()
    await classifyLines(
      context(['--repo-root', SOME_ROOT], envelope([group('split-version', '5')])),
      run,
      route,
      '/',
    )
    expect(calls.filter((call) => call.startsWith('compare_versions'))).toEqual([
      'compare_versions 1.0.0 5.0.0',
      'compare_versions 9.0.0 5.0.0',
    ])
  })

  it('names the failure of detect for each package, and keeps the groups as unknown', async () => {
    const out = await answer(
      envelope([group('lodash', '4'), group('express', '4')]),
      ['--repo-root', SOME_ROOT],
      { detect: failed('No supported lockfile found in /x.') },
    )
    expect(out.actionable.map((entry) => entry.line_status)).toEqual(['unknown', 'unknown'])
    expect(out.classify_errors).toEqual([
      { adapter: 'node', package: 'express', error: 'No supported lockfile found in /x.' },
      { adapter: 'node', package: 'lodash', error: 'No supported lockfile found in /x.' },
    ])
  })

  it('classifies each group of an envelope on its own facts, in order', async () => {
    const out = await answer(
      envelope([group('path-to-regexp', '1'), group('lodash', '4'), group('express', '4')], [OLD]),
    )
    expect(out.actionable.map((entry) => [entry.package, entry.line_status])).toEqual([
      ['lodash', 'resolved'],
      ['express', 'line_absent'],
    ])
    expect(out.skipped.map((entry) => entry.package)).toEqual(['old', 'path-to-regexp'])
    expect(out.classify_errors).toEqual([])
  })
})

describe('the collision check (#132)', () => {
  const check = async (pkg: string, line: string, spec: StandInSpec = {}) => {
    const out = await answer(envelope([group(pkg, line)]), ['--repo-root', SOME_ROOT], spec)
    const all = [...out.actionable, ...out.skipped]
    return {
      where: out.actionable.length === 1 ? 'actionable' : 'skipped',
      status: all[0]?.line_status,
      parents: all[0]?.collision_parents,
      reason: all[0]?.reason,
      errors: out.classify_errors,
    }
  }

  it('keeps a shared parent that a qualified key can separate', async () => {
    expect(await check('sep-ok', '5')).toEqual({
      where: 'actionable',
      status: 'resolved',
      parents: undefined,
      reason: undefined,
      errors: [],
    })
  })

  it('keeps lines with no shared parent', async () => {
    expect(await check('disjoint', '1')).toMatchObject({ where: 'actionable', status: 'resolved' })
    expect(await check('duped', '1')).toMatchObject({ where: 'actionable', status: 'resolved' })
  })

  it('moves the shape of one copy on two majors, and names the parent', async () => {
    expect(await check('same-copy', '5')).toEqual({
      where: 'skipped',
      status: 'cross_line_collision',
      parents: ['minimatch'],
      reason: 'shared parent across major lines',
      errors: [],
    })
  })

  it('moves any shared parent name under Yarn resolutions', async () => {
    expect(await check('sep-ok', '5', { location: 'resolutions' })).toMatchObject({
      where: 'skipped',
      status: 'cross_line_collision',
      parents: ['minimatch'],
    })
  })

  it('names a scoped parent without its version', async () => {
    expect(await check('scoped-copy', '5')).toMatchObject({
      status: 'cross_line_collision',
      parents: ['@npmcli/map-workspaces'],
    })
  })

  it('moves a shared entry with no version, to be safe', async () => {
    expect(await check('null-copy', '5')).toMatchObject({
      status: 'cross_line_collision',
      parents: ['minimatch'],
    })
  })

  it('keeps the group and names the error when declared_ranges fails', async () => {
    expect(await check('dr-broken', '5')).toEqual({
      where: 'actionable',
      status: 'resolved',
      parents: undefined,
      reason: undefined,
      errors: [
        {
          adapter: 'node',
          package: 'dr-broken',
          error: 'declared_ranges: parser refused the lockfile',
        },
      ],
    })
  })

  it('keeps the group when declared_ranges gives an entry that is not text', async () => {
    expect(await check('dr-not-text', '5')).toMatchObject({
      where: 'actionable',
      status: 'resolved',
      errors: [
        {
          package: 'dr-not-text',
          error: 'declared_ranges --line 1 failed or broke its contract; collision check skipped',
        },
      ],
    })
  })

  it.each([
    ['no override location', undefined],
    ['an empty override location', ''],
  ])('keeps the group and names the error when detect gives %s', async (_case, location) => {
    expect(await check('sep-ok', '5', { location })).toMatchObject({
      where: 'actionable',
      status: 'resolved',
      errors: [
        {
          package: 'sep-ok',
          error: 'detect failed or broke its contract; collision check skipped',
        },
      ],
    })
  })

  it('never runs for a package with one major', async () => {
    const { route, calls } = standIn()
    await classifyLines(
      context(['--repo-root', SOME_ROOT], envelope([group('lodash', '4')])),
      run,
      route,
      '/',
    )
    expect(calls.some((call) => call.startsWith('declared_ranges'))).toBe(false)
  })
})

describe('each verb runs once for each key, and not once for each group', () => {
  const callsFor = async (groups: readonly Group[]) => {
    const { route, calls } = standIn()
    await classifyLines(context(['--repo-root', SOME_ROOT], envelope(groups)), run, route, '/')
    return calls
  }

  it('reads detect once for the adapter, and resolved_versions once for each package', async () => {
    const calls = await callsFor([
      group('duped', '1'),
      group('duped', '2'),
      group('lodash', '4'),
      group('lodash', '4'),
    ])
    expect(calls.filter((call) => !call.startsWith('declared_ranges'))).toEqual([
      'detect',
      'resolved_versions duped',
      'resolved_versions lodash',
    ])
  })

  it('reads declared_ranges once for each package and major', async () => {
    const calls = await callsFor([group('sep-ok', '1'), group('sep-ok', '5')])
    expect(calls.filter((call) => call.startsWith('declared_ranges'))).toEqual([
      'declared_ranges --line 1 sep-ok',
      'declared_ranges --line 5 sep-ok',
    ])
  })

  it('still classifies each line of the shared package on its own', async () => {
    const out = await answer(envelope([group('duped', '1'), group('duped', '2')]))
    expect(out.actionable.map((entry) => [entry.major_line, entry.line_status])).toEqual([
      ['1', 'resolved'],
      ['2', 'resolved'],
    ])
  })
})

describe('the route', () => {
  it('moves a group with no adapter into skipped, after the groups that were there', async () => {
    const { route, calls } = standIn()
    const result = await classifyLines(
      context(
        ['--repo-root', SOME_ROOT],
        envelope(
          [
            group('lodash', '4', { adapter_path: '/old/node.sh' }),
            group('flask', '2', { ecosystem: 'pip', adapter_path: null }),
            group('rails', '7', { ecosystem: 'rubygems' }),
            group('ghost', '1', { ecosystem: null }),
            group('five', '1', { ecosystem: 5 }),
          ],
          [OLD],
        ),
      ),
      run,
      route,
      '/',
    )
    const out = answerIn(result)
    expect(out.actionable).toEqual([
      {
        ...group('lodash', '4'),
        adapter: 'node',
        supported: true,
        resolved_majors: ['4'],
        line_status: 'resolved',
      },
    ])
    expect(out.skipped).toEqual([
      OLD,
      ...[
        group('flask', '2', { ecosystem: 'pip' }),
        group('rails', '7', { ecosystem: 'rubygems' }),
        group('ghost', '1', { ecosystem: null }),
        group('five', '1', { ecosystem: 5 }),
      ].map((entry) => ({
        ...entry,
        adapter: null,
        supported: false,
        reason: 'ecosystem not supported yet',
      })),
    ])
    expect(calls).toEqual(['detect', 'resolved_versions lodash'])
  })

  it('asks the adapter nothing for a group with no package, and calls it unknown', async () => {
    const { route, calls } = standIn()
    const result = await classifyLines(
      context(['--repo-root', SOME_ROOT], envelope([{ ecosystem: 'npm', major_line: '4' }])),
      run,
      route,
      '/',
    )
    expect(answerIn(result).actionable[0]?.line_status).toBe('unknown')
    expect(calls).toEqual([])
  })
})

describe('the envelope', () => {
  it('passes a top-level key it does not know, and replaces classify_errors', async () => {
    const out = await answer(
      JSON.stringify({
        classify_errors: ['from an earlier run'],
        extra: [{ note: 'carried by the caller' }],
        actionable: [group('lodash', '4')],
        skipped: [OLD],
      }),
    )
    expect(Object.keys(out)).toEqual(['extra', 'actionable', 'skipped', 'classify_errors'])
    expect(out.extra).toEqual([{ note: 'carried by the caller' }])
    expect(out.classify_errors).toEqual([])
  })

  it.each([
    ['no lists at all', '{}'],
    ['null lists', '{"actionable":null,"skipped":null}'],
    ['false lists', '{"actionable":false,"skipped":false}'],
  ])('reads %s as empty lists', async (_case, stdin) => {
    expect(await answer(stdin)).toMatchObject({ actionable: [], skipped: [], classify_errors: [] })
  })

  it('reads the repositories of the routed groups only, and no repo as no repo', async () => {
    const out = await answer(
      envelope([
        group('lodash', '4', { repo: 'octo/app' }),
        group('express', '4', { repo: null }),
        group('minimatch', '4', { repo: false }),
        group('flask', '2', { ecosystem: 'pip', repo: 'octo/other' }),
      ]),
    )
    expect(out.actionable).toHaveLength(3)
  })

  it.each([
    ['text that is not JSON', 'not json', 'classify-lines expects discovery JSON on stdin'],
    ['empty stdin', '', 'classify-lines expects discovery JSON on stdin'],
    ['a list', '[]', 'classify-lines expects a discovery JSON object on stdin'],
    ['null', 'null', 'classify-lines expects a discovery JSON object on stdin'],
    [
      'an actionable that is not a list',
      '{"actionable":"oops","skipped":[]}',
      'Failed to read actionable groups: actionable is not a list of objects',
    ],
    [
      'an actionable group that is not an object',
      '{"actionable":[1]}',
      'Failed to read actionable groups: actionable is not a list of objects',
    ],
    [
      'a skipped that is not a list',
      '{"actionable":[],"skipped":{}}',
      'Failed to read skipped groups: skipped is not a list of objects',
    ],
    [
      'a skipped entry that is not an object',
      '{"skipped":["x"]}',
      'Failed to read skipped groups: skipped is not a list of objects',
    ],
    [
      'a package that is not text',
      envelope([group('x', '1', { package: 5 })]),
      'Failed to read actionable groups: a package is not text: 5',
    ],
    [
      'groups of two repositories',
      envelope([
        group('lodash', '4', { repo: 'octo/app' }),
        group('express', '4', { repo: 'octo/other' }),
      ]),
      "classify-lines: actionable groups span more than one repo (octo/app, octo/other); pass one repo's groups per invocation",
    ],
  ])('refuses %s', async (_case, stdin, said) => {
    expect(await classify(stdin)).toEqual(failed(said))
  })
})

describe('the flat rewrite (#123)', () => {
  const STDIN = envelope(
    [
      group('lodash', '4', { branch_name: 'fix/dependabot-lodash-4x' }),
      group('express', '4', { branch_name: 'sec/express-4' }),
      group('minimatch', '4', { branch_name: 'fix-dependabot-minimatch-4x' }),
    ],
    [
      { package: 'left-pad', branch_name: 'fix/dependabot-left-pad-unfixed' },
      { package: 'bare' },
      { package: 'odd', branch_name: 7 },
    ],
  )

  const names = (out: Answer) => ({
    a: out.actionable.map((entry) => entry.branch_name),
    s: out.skipped.map((entry) => entry.branch_name),
  })

  it.each([[['--branch-style', 'flat']], [['--branch-style=flat']]])(
    'renames the plugin branches of both lists, and no other name (%j)',
    async (style) => {
      expect(names(await answer(STDIN, ['--repo-root', SOME_ROOT, ...style]))).toEqual({
        a: ['fix-dependabot-lodash-4x', 'sec/express-4', 'fix-dependabot-minimatch-4x'],
        s: ['fix-dependabot-left-pad-unfixed', undefined, 7],
      })
    },
  )

  it('renames nothing under the slash style', async () => {
    expect(
      names(await answer(STDIN, ['--repo-root', SOME_ROOT, '--branch-style', 'slash'])),
    ).toEqual({
      a: ['fix/dependabot-lodash-4x', 'sec/express-4', 'fix-dependabot-minimatch-4x'],
      s: ['fix/dependabot-left-pad-unfixed', undefined, 7],
    })
  })
})

describe('the refusals of the command line', () => {
  it.each([
    ['no --repo-root', []],
    ['an empty --repo-root', ['--repo-root', '']],
    ['a word that is not an option', ['--repo-root', SOME_ROOT, 'extra']],
  ])('refuses %s with the usage line', async (_case, args) => {
    expect(await classify(envelope([]), args)).toEqual(failed(USAGE))
  })

  it.each([
    ['a path that is not there', join(SOME_ROOT, 'no-such-dir')],
    ['a file', join(SOME_ROOT, 'alerts', 'multi-major.json')],
  ])('refuses a --repo-root that is %s', async (_case, path) => {
    expect(await classify(envelope([]), ['--repo-root', path])).toEqual(
      failed(`--repo-root is not a directory: ${path}`),
    )
  })

  it('reads a relative --repo-root from the working directory', async () => {
    const result = await classifyLines(
      context(['--repo-root', 'alerts'], envelope([])),
      run,
      standIn().route,
      SOME_ROOT,
    )
    expect(result?.outcome).toBe('ok')
  })

  it.each([['main'], ['origin/'], ['refs/remotes/origin/main']])(
    'refuses the base ref %s, which is not origin/<branch>',
    async (ref) => {
      expect(await classify(envelope([]), ['--repo-root', SOME_ROOT, '--base-ref', ref])).toEqual(
        failed(`--base-ref must name a remote-tracking ref as origin/<branch>: ${ref}`),
      )
    },
  )

  it('refuses an unknown branch style, and an unknown option', async () => {
    expect(
      await classify(envelope([]), ['--repo-root', SOME_ROOT, '--branch-style', 'diagonal']),
    ).toEqual(failed('--branch-style must be one of slash, flat, not "diagonal"'))
    expect((await classify(envelope([]), ['--repo-root', SOME_ROOT, '--nope']))?.outcome).toBe(
      'failed',
    )
  })
})

/** A runner that refuses the git calls whose words start with `refuse`, and runs the rest. */
const refusing =
  (refuse: string, calls: string[][] = []): Runner =>
  (command, args = [], options) => {
    calls.push([command, ...args])
    // Each call here is `git -C <root> <words>`.
    const words = args.slice(2).join(' ')
    if (command === 'git' && words.startsWith(refuse)) {
      return Promise.resolve({
        status: 1,
        signal: null,
        stdout: '',
        stderr: `git stub: refusing ${refuse}\nsecond line\n`,
        combined: '',
        timedOut: false,
        elapsedMs: 0,
        startFailure: null,
        streamErrors: [],
      } satisfies RunResult)
    }
    return run(command, args, options)
  }

describe('--base-ref', () => {
  /**
   * A repository whose origin `main` has the version 0.2.5 in
   * `resolved-version`, with the collision files, checked out on a branch
   * that says 1.9.0 and has neither collision file. The stand-in adapter
   * reads these files from the tree that it is given, so the answer says
   * which tree was read.
   */
  const repository = () => {
    const sandbox = createSandbox()
    const fixtures = createGitFixtures(sandbox)
    const work = fixtures.create(sandbox.join('repo'))
    writeFileSync(join(work, 'resolved-version'), '0.2.5\n')
    writeFileSync(join(work, 'override-location'), 'resolutions\n')
    writeFileSync(join(work, 'dr-shared'), 'shared\n')
    fixtures.git(work, 'add', '-A')
    fixtures.git(work, 'commit', '-qm', 'base')
    fixtures.push(work)
    fixtures.git(work, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(work, 'resolved-version'), '1.9.0\n')
    writeFileSync(join(work, 'override-location'), 'overrides\n')
    fixtures.git(work, 'rm', '-q', 'dr-shared')
    fixtures.git(work, 'commit', '-qam', 'feature')
    const temp = sandbox.join('tmp')
    mkdirSync(temp)
    const worktrees = () =>
      fixtures
        .git(work, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length
    return { sandbox, fixtures, work, temp, worktrees }
  }

  const envOf = (sandbox: Sandbox, temp: string) => ({ ...sandbox.env, TMPDIR: temp })

  const ONE = envelope([group('treeread', '1')])

  const at = async (
    repo: ReturnType<typeof repository>,
    args: readonly string[],
    options: { runner?: Runner; stdin?: string; spec?: StandInSpec; stderr?: string[] } = {},
  ): Promise<CommandResult> =>
    classifyLines(
      context(args, options.stdin ?? ONE, envOf(repo.sandbox, repo.temp), (text) => {
        options.stderr?.push(text)
      }),
      options.runner ?? run,
      standIn({ fromTree: true, ...options.spec }).route,
      '/',
    )

  const statusesOf = (result: CommandResult) => {
    const out = answerIn(result)
    return [...out.actionable, ...out.skipped].map((entry) => entry.line_status)
  }

  it('reads origin/main, and removes its worktree and its temporary directory', async () => {
    const repo = repository()
    const result = await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'])
    expect(statusesOf(result)).toEqual(['requires_major_bump'])
    expect(repo.worktrees()).toBe(1)
    expect(readdirSync(repo.temp)).toEqual([])
  })

  it('reads the checkout as it is without --base-ref', async () => {
    const repo = repository()
    expect(statusesOf(await at(repo, ['--repo-root', repo.work]))).toEqual(['resolved'])
  })

  it('reads detect and declared_ranges from the detached tree too', async () => {
    // On main, the tree says `resolutions` and a shared parent: a collision.
    // The checkout says `overrides`, and its parents differ by line.
    const repo = repository()
    const stdin = envelope([group('treecoll', '1')])
    const base = await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], { stdin })
    expect(answerIn(base).skipped).toMatchObject([
      { line_status: 'cross_line_collision', collision_parents: ['shared'] },
    ])
    expect(statusesOf(await at(repo, ['--repo-root', repo.work], { stdin }))).toEqual(['resolved'])
  })

  it('fetches first, so a stale remote-tracking ref cannot answer', async () => {
    const repo = repository()
    const other = repo.sandbox.join('other')
    repo.fixtures.git(
      repo.sandbox.path,
      'clone',
      '-q',
      join(repo.sandbox.join('repo'), 'origin.git'),
      other,
    )
    writeFileSync(join(other, 'resolved-version'), '3.0.0\n')
    repo.fixtures.git(other, 'commit', '-qam', 'advance')
    repo.fixtures.git(other, 'push', '-q', 'origin', 'HEAD:main')
    const result = await at(repo, ['--repo-root', repo.work, '--base-ref=origin/main'])
    expect(statusesOf(result)).toEqual(['line_absent'])
  })

  it('adds base_ref to each classify_errors entry', async () => {
    const repo = repository()
    const result = await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], {
      stdin: envelope([group('boom', '1')]),
      spec: { fromTree: false },
    })
    expect(answerIn(result).classify_errors).toEqual([
      {
        adapter: 'node',
        package: 'boom',
        error: 'resolved_versions: parser refused the lockfile',
        base_ref: 'origin/main',
      },
    ])
  })

  it('accepts the root of a linked worktree as the top level', async () => {
    const repo = repository()
    const linked = repo.sandbox.join('linked')
    repo.fixtures.git(repo.work, 'worktree', 'add', '-q', linked, 'main')
    const result = await at(repo, ['--repo-root', linked, '--base-ref', 'origin/main'])
    expect(statusesOf(result)).toEqual(['requires_major_bump'])
  })

  it('refuses a subdirectory of the repository, and names the top level', async () => {
    const repo = repository()
    const sub = join(repo.work, 'sub')
    mkdirSync(sub)
    expect(await at(repo, ['--repo-root', sub, '--base-ref', 'origin/main'])).toEqual(
      failed(
        `--base-ref requires --repo-root to be the repository top level, not a subdirectory: ${sub} (top level: ${realpathSync(repo.work)})`,
      ),
    )
  })

  it('refuses a directory in no repository', async () => {
    const repo = repository()
    expect(await at(repo, ['--repo-root', repo.temp, '--base-ref', 'origin/main'])).toEqual(
      failed(`--base-ref requires --repo-root to be a git repository: ${repo.temp}`),
    )
  })

  it('refuses a top level that git gives as empty', async () => {
    const repo = repository()
    const silent: Runner = (command, args = [], options) =>
      args.includes('--show-toplevel') ? run('true', [], options) : run(command, args, options)
    expect(
      await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], { runner: silent }),
    ).toEqual(failed(`--base-ref requires --repo-root to be a git repository: ${repo.work}`))
  })

  it('refuses a branch that origin does not have, with the first line of git', async () => {
    const repo = repository()
    const result = await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/nope'])
    expect(result?.outcome).toBe('failed')
    expect((result as { error: string }).error).toMatch(
      /^git fetch for --base-ref origin\/nope failed: fatal: couldn't find remote ref/,
    )
    expect(readdirSync(repo.temp)).toEqual([])
  })

  it.each([
    [
      'the check after the fetch',
      'rev-parse --verify',
      '--base-ref not found after fetch: origin/main',
    ],
    [
      'the worktree',
      'worktree add',
      'git worktree add for origin/main failed: git stub: refusing worktree add',
    ],
  ])(
    'fails when git refuses %s, and leaves no worktree and no directory',
    async (_case, words, said) => {
      const repo = repository()
      const result = await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], {
        runner: refusing(words),
      })
      expect(result).toEqual(failed(said))
      expect(repo.worktrees()).toBe(1)
      expect(readdirSync(repo.temp)).toEqual([])
    },
  )

  it('names the fetch error of git, cut to its first line', async () => {
    const repo = repository()
    expect(
      await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], {
        runner: refusing('fetch'),
      }),
    ).toEqual(failed('git fetch for --base-ref origin/main failed: git stub: refusing fetch'))
  })

  it('fails when it cannot make the temporary directory, and adds no worktree', async () => {
    const repo = repository()
    const result = await classifyLines(
      context(['--repo-root', repo.work, '--base-ref', 'origin/main'], ONE, {
        ...repo.sandbox.env,
        TMPDIR: join(repo.temp, 'missing'),
      }),
      run,
      standIn({ fromTree: true }).route,
      '/',
    )
    expect(result).toEqual(
      failed(
        '--base-ref could not create a temporary directory for the detached worktree (mktemp -d failed)',
      ),
    )
    expect(repo.worktrees()).toBe(1)
  })

  it('reads an empty TMPDIR as no TMPDIR, as mktemp does', async () => {
    const repo = repository()
    const calls: string[][] = []
    await classifyLines(
      context(['--repo-root', repo.work, '--base-ref', 'origin/main'], ONE, {
        ...repo.sandbox.env,
        TMPDIR: '',
      }),
      refusing('no such words', calls),
      standIn({ fromTree: true }).route,
      '/',
    )
    const added = calls.find((call) => call.slice(3, 5).join(' ') === 'worktree add')
    expect(added?.[7]?.startsWith(join(tmpdir(), 'classify-lines-'))).toBe(true)
    expect(repo.worktrees()).toBe(1)
  })

  it('keeps the worktree and says how to remove it when the removal fails', async () => {
    const repo = repository()
    const stderr: string[] = []
    const result = await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], {
      runner: refusing('worktree remove'),
      stderr,
    })
    expect(statusesOf(result)).toEqual(['requires_major_bump'])
    const [dir] = readdirSync(repo.temp)
    const tree = join(repo.temp, dir as string, 'tree')
    expect(stderr).toEqual([
      `classify-lines: could not remove base-ref worktree ${tree}; remove it with: git -C ${repo.work} worktree remove --force ${tree}\n`,
    ])
    expect(repo.worktrees()).toBe(2)
    repo.fixtures.git(repo.work, 'worktree', 'remove', '--force', tree)
  })

  it('removes its worktree when the classification throws', async () => {
    const repo = repository()
    await expect(
      at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], { spec: { throws: true } }),
    ).rejects.toThrow('a defect in the adapter')
    expect(repo.worktrees()).toBe(1)
    expect(readdirSync(repo.temp)).toEqual([])
  })

  it('checks the input before any git call', async () => {
    const repo = repository()
    const calls: string[][] = []
    const result = await at(repo, ['--repo-root', repo.work, '--base-ref', 'origin/main'], {
      runner: refusing('no such words', calls),
      stdin: '{"actionable":"oops"}',
    })
    expect(result?.outcome).toBe('failed')
    expect(calls).toEqual([])
  })
})

describe('--env-prefix', () => {
  it('wraps every git call, and the wrapped calls do the work', async () => {
    const sandbox = createSandbox()
    const fixtures = createGitFixtures(sandbox)
    const work = fixtures.create(sandbox.join('repo'))
    const temp = sandbox.join('tmp')
    mkdirSync(temp)
    const calls: string[][] = []
    // The stand-in for the prefix: it records the call, then runs the command
    // after the prefix words, so the run is real.
    const prefixRunner: Runner = (command, args = [], options) => {
      calls.push([command, ...args])
      const [, real, ...rest] = args
      return run(real as string, rest, options)
    }
    const result = await classifyLines(
      context(
        ['--env-prefix', 'envwrap --flag', '--repo-root', work, '--base-ref', 'origin/main'],
        envelope([]),
        { ...sandbox.env, TMPDIR: temp },
      ),
      prefixRunner,
      standIn().route,
      '/',
    )
    expect(result?.outcome).toBe('ok')
    expect(calls.map((call) => call.slice(0, 7).join(' '))).toEqual([
      `envwrap --flag git -C ${work} rev-parse --show-toplevel`,
      `envwrap --flag git -C ${work} fetch -q`,
      `envwrap --flag git -C ${work} rev-parse --verify`,
      `envwrap --flag git -C ${work} worktree add`,
      `envwrap --flag git -C ${work} worktree remove`,
    ])
    expect(readdirSync(temp)).toEqual([])
  })
})

describe('the registered handler', () => {
  it('runs with the real runner and the real registry', async () => {
    const root = join(FIXTURES_ROOT, 'npm-v3')
    const result = await classifyLinesCommand(
      context(['--repo-root', root], envelope([group('lodash', '4')])),
    )
    expect(answerIn(result).actionable.map((entry) => entry.line_status)).toEqual(['resolved'])
  })
})

describe('the process', () => {
  const spawnCli = (args: readonly string[], stdin: string) => {
    const sandbox = createSandbox()
    return run(process.execPath, [ENTRY, 'classify-lines', ...args], { env: sandbox.env, stdin })
  }

  it('reads the discovery JSON on stdin and writes the answer', async () => {
    const result = await spawnCli(
      ['--repo-root', join(FIXTURES_ROOT, 'npm-v3')],
      envelope([group('lodash', '4')]),
    )
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as Answer).actionable[0]?.line_status).toBe('resolved')
  })

  it('exits 1 with the error as JSON on stdout and as prose on stderr', async () => {
    const result = await spawnCli(['--repo-root', FIXTURES_ROOT], 'not json')
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      error: 'classify-lines expects discovery JSON on stdin',
    })
    expect(result.stderr).toBe('classify-lines expects discovery JSON on stdin\n')
  })
})
