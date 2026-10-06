// `gh-security score-merge-risk`, at its seam: the exported handler with the
// registry and the tree as parameters. The command line, the why payload and
// the refusals of the script are here. The factors are in
// `merge-risk/score.test.ts`, and `parity-score-merge-risk.test.ts` compares
// the command with the script.
import { chmodSync, cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { selectAdapter } from '#gh-security/adapters/registry.ts'
import type { CommandResult } from '#gh-security/cli/command.ts'
import { exitCodeFor, ok } from '#gh-security/lib/envelope.ts'
import { scoreMergeRisk, scoreMergeRiskCommand } from '#gh-security/subcommands/score-merge-risk.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createSandbox } from '#harness/sandbox.ts'

/** A copy of the tooling-only specimen, with a why payload for a direct dependency. */
const world = (): string => {
  const root = createSandbox().join('tree')
  cpSync(join(FIXTURES_ROOT, 'tooling-only'), root, { recursive: true })
  writeFileSync(join(root, 'why.json'), JSON.stringify({ relationship: 'direct', dev_only: true }))
  return root
}

const run = (
  root: string,
  args: readonly string[],
  stdin = '',
  route: typeof selectAdapter = selectAdapter,
): CommandResult =>
  scoreMergeRisk(
    {
      args,
      env: {},
      io: { stdout: () => {}, stderr: () => {}, readStdin: () => stdin },
      commandNames: [],
    },
    route,
    root,
  )

const ARGS = [
  '--package',
  'lodash',
  '--before',
  '1.0.0',
  '--after',
  '2.0.0',
  '--why-json',
  'why.json',
  '--override-scope',
  'none',
  '--declared-range',
  'none',
]

/** The arguments with one flag and its value taken out. */
const without = (flag: string): string[] => {
  const index = ARGS.indexOf(flag)
  return [...ARGS.slice(0, index), ...ARGS.slice(index + 2)]
}

const error = (result: CommandResult): { exit: number; error: string } => {
  if (result === undefined || result.outcome === 'ok' || 'report' in result) {
    throw new Error('expected a failure')
  }
  return { exit: exitCodeFor(result), error: result.error }
}

describe('the command line', () => {
  it('scores the tree it runs in', () => {
    const result = run(world(), ARGS)
    expect(result?.outcome).toBe('ok')
    expect(result).toMatchObject({
      value: { package: 'lodash', score: 2, band: 'Medium', delta: 'major' },
    })
  })

  it.each([
    ['an unknown argument', ['--adapter', 'node.sh', ...ARGS], 'Unknown argument: --adapter'],
    ['an empty value', ['--package', '', ...ARGS.slice(2)], '--package requires a value'],
    ['a flag at the end with no value', [...ARGS, '--before'], '--before requires a value'],
    ['no --package', without('--package'), 'Missing required argument: --package'],
    ['no --after', without('--after'), 'Missing required argument: --after'],
    ['no --why-json', without('--why-json'), 'Missing required argument: --why-json'],
    [
      'no --override-scope',
      without('--override-scope'),
      'Missing required argument: --override-scope',
    ],
    [
      'no --declared-range',
      without('--declared-range'),
      'Missing required argument: --declared-range. Pass one per distinct range a dependent declares, or --declared-range none if none could be read.',
    ],
    [
      'none beside a range',
      [...ARGS, '--declared-range', '^1'],
      '--declared-range none states that no ranges could be read; it cannot be combined with declared ranges',
    ],
    [
      'an unknown scope',
      [...without('--override-scope'), '--override-scope', 'global'],
      '--override-scope must be none, scoped, bare-tightened, or bare-added',
    ],
  ])('refuses %s', (_name, args, message) => {
    expect(error(run(world(), args))).toEqual({ exit: 1, error: message })
  })

  it('takes a flag as the value of the flag before it, as the script did', () => {
    const args = ['--package', '--after', ...without('--package')]
    expect(run(world(), args)).toMatchObject({ value: { package: '--after' } })
  })

  it('takes --before as optional, and scores no baseline as a major', () => {
    expect(run(world(), without('--before'))).toMatchObject({ value: { delta: 'unknown' } })
  })

  it('takes the last value of a repeated flag', () => {
    expect(run(world(), [...ARGS, '--package', 'react'])).toMatchObject({
      value: { package: 'react' },
    })
  })

  it('passes each declared range on, in its order', () => {
    const args = [
      ...without('--declared-range'),
      '--declared-range',
      '^2',
      '--declared-range',
      '~1.0.0',
    ]
    expect(run(world(), args)).toMatchObject({ value: { declared_ranges: ['^2', '~1.0.0'] } })
  })
})

describe('the why payload', () => {
  it('reads a relative path from the tree, and names it as it was given', () => {
    const root = world()
    writeFileSync(join(root, 'why.json'), '[]')
    expect(error(run(root, ARGS)).error).toMatch(
      /^--why-json why\.json did not contain a JSON object\./,
    )
  })

  it('refuses a path that is not a file', () => {
    expect(error(run(world(), [...without('--why-json'), '--why-json', 'nope.json']))).toEqual({
      exit: 1,
      error:
        '--why-json file not found: nope.json. The classification it carries decides F2 and the whole affected surface, so there is nothing to fall back to.',
    })
    expect(error(run(world(), [...without('--why-json'), '--why-json', '.'])).error).toMatch(
      /^--why-json file not found: \.\. /,
    )
  })

  // The capture row for tooling-only, direct, 1.0.0 -> 2.0.0 is Medium 4.
  it('reads stdin for -', () => {
    const args = [...without('--why-json'), '--why-json', '-']
    const why = JSON.stringify({ relationship: 'direct', dev_only: false })
    const result = run(world(), args, why)
    expect(result?.outcome === 'ok' && result.value).toMatchObject({ band: 'Medium', score: 4 })
    expect(run(world(), args, `\u{FEFF}${why}`)).toMatchObject({ outcome: 'ok' })
    expect(error(run(world(), args, '')).error).toMatch(
      /^--why-json - did not contain a JSON object\./,
    )
  })

  it('reads a file it cannot read as a payload with no JSON object', () => {
    const root = world()
    chmodSync(join(root, 'why.json'), 0)
    try {
      expect(error(run(root, ARGS)).error).toMatch(
        /^--why-json why\.json did not contain a JSON object\./,
      )
    } finally {
      chmodSync(join(root, 'why.json'), 0o644)
    }
  })
})

describe('the adapter', () => {
  it('is the one the registry routes npm to, named in a contract error', () => {
    const route: typeof selectAdapter = (ecosystem) => {
      const real = selectAdapter(ecosystem)
      if (!real.supported) return real
      return { ...real, adapter: { ...real.adapter, compareVersions: () => ok({} as never) } }
    }
    expect(error(run(world(), ARGS, '', route)).error).toMatch(
      /^adapter node: compare_versions '1\.0\.0' '2\.0\.0' emitted no usable 'delta'\./,
    )
  })
})

describe('the registry entry', () => {
  it('scores the directory of the process', () => {
    const result = scoreMergeRiskCommand({
      args: without('--package'),
      env: {},
      io: { stdout: () => {}, stderr: () => {}, readStdin: () => '' },
      commandNames: [],
    })
    expect(error(result as CommandResult).error).toBe('Missing required argument: --package')
  })
})

describe('the inputs, as the bash reads them', () => {
  it('reads a UTF-8 byte order mark at the start of the why file, as jq does', () => {
    const root = world()
    writeFileSync(join(root, 'why.json'), `\u{FEFF}${JSON.stringify({ relationship: 'direct' })}`)
    const result = run(root, ARGS)
    expect(result).toMatchObject({
      outcome: 'ok',
      value: { factors: expect.arrayContaining([expect.objectContaining({ id: 'F2', score: 2 })]) },
    })
  })

  it('fails with the reason when the registry routes npm to no adapter', () => {
    const none = selectAdapter('no-such-ecosystem')
    if (none.supported) throw new Error('the registry routes no-such-ecosystem')
    expect(error(run(world(), ARGS, '', () => none))).toEqual({ exit: 1, error: none.reason })
  })
})
