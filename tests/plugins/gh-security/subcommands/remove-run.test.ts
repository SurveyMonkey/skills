// `gh-security remove-run <dir>` (#346, ruling 4). The seam is the exported
// handler. Each directory is real, in a scratch tree that has the shape of
// `~/.claude/plugins/data/<id>/runs/<run>/`. Each expected value is written by
// hand from the contract in the header of the command.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CommandContext } from '#gh-security/cli/command.ts'
import { removeRunCommand } from '#gh-security/subcommands/remove-run.ts'

const contextFor = (args: readonly string[]): CommandContext => ({
  args,
  env: {},
  io: {
    stdout: () => {
      throw new Error('remove-run answers through its return value')
    },
    stderr: () => {
      throw new Error('remove-run answers through its return value')
    },
    readStdin: () => '',
  },
  commandNames: [],
})

let scratch = ''
let runs = ''

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gh-security-remove-run-')))
  runs = join(scratch, '.claude', 'plugins', 'data', 'gh-security-example', 'runs')
  mkdirSync(runs, { recursive: true })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A run directory with a file and a nested directory in it. */
const makeRun = (name: string): string => {
  const run = join(runs, name)
  mkdirSync(join(run, 'nested'), { recursive: true })
  writeFileSync(join(run, 'merged.json'), '{}\n')
  writeFileSync(join(run, 'nested', 'reports.json'), '[]\n')
  return run
}

describe('remove-run', () => {
  it('removes a run directory and all that it holds, and names it', () => {
    const run = makeRun('20261026T190000Z')
    const sibling = makeRun('20261026T180000Z')
    expect(removeRunCommand(contextFor([run]))).toEqual({
      outcome: 'ok',
      value: { removed: run },
    })
    expect({ run: existsSync(run), sibling: existsSync(sibling), runs: existsSync(runs) }).toEqual({
      run: false,
      sibling: true,
      runs: true,
    })
  })

  it('removes a link in the run, and not what the link points at', () => {
    const run = makeRun('20261026T190000Z')
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep\n')
    symlinkSync(outside, join(run, 'a-link'))
    expect(removeRunCommand(contextFor([run]))).toEqual({ outcome: 'ok', value: { removed: run } })
    expect({ run: existsSync(run), kept: existsSync(join(outside, 'keep.txt')) }).toEqual({
      run: false,
      kept: true,
    })
  })

  it.each([
    ['no argument', []],
    ['two arguments', ['/a', '/b']],
    ['a flag', ['--force']],
  ])('refuses %s with its usage', (_case, args) => {
    expect(removeRunCommand(contextFor(args))).toEqual({
      outcome: 'failed',
      error: 'usage: gh-security remove-run <dir>',
    })
  })

  it('refuses a path that is not absolute', () => {
    expect(removeRunCommand(contextFor(['runs/20261026T190000Z']))).toEqual({
      outcome: 'failed',
      error: 'remove-run: not an absolute path: runs/20261026T190000Z',
    })
  })

  it('refuses a path with a .. segment, even one that resolves to a run', () => {
    const run = makeRun('20261026T190000Z')
    const literal = `${runs}/x/../20261026T190000Z`
    expect(removeRunCommand(contextFor([literal]))).toEqual({
      outcome: 'failed',
      error: `remove-run: the path has a .. segment: ${literal}`,
    })
    expect(existsSync(run)).toBe(true)
  })

  it('refuses a path with a .. segment that leads out of the runs', () => {
    const literal = `${runs}/../../../../../outside`
    mkdirSync(join(scratch, 'outside'))
    expect(removeRunCommand(contextFor([literal]))).toEqual({
      outcome: 'failed',
      error: `remove-run: the path has a .. segment: ${literal}`,
    })
    expect(existsSync(join(scratch, 'outside'))).toBe(true)
  })

  it('refuses a path that does not exist', () => {
    const gone = join(runs, 'gone')
    expect(removeRunCommand(contextFor([gone]))).toEqual({
      outcome: 'failed',
      error: `remove-run: no such directory: ${gone}`,
    })
  })

  it('refuses a file', () => {
    const file = join(runs, 'a-file')
    writeFileSync(file, '')
    expect(removeRunCommand(contextFor([file]))).toEqual({
      outcome: 'failed',
      error: `remove-run: not a directory: ${file}`,
    })
    expect(existsSync(file)).toBe(true)
  })

  it('refuses a run path that is a symbolic link to a directory outside', () => {
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    const link = join(runs, '20261026T190000Z')
    symlinkSync(outside, link)
    expect(removeRunCommand(contextFor([link]))).toEqual({
      outcome: 'failed',
      error: `remove-run: a symbolic link, not a run directory: ${link}`,
    })
    expect(existsSync(outside)).toBe(true)
  })

  it('refuses a run whose runs directory is a symbolic link that leads outside', () => {
    const elsewhere = join(scratch, 'elsewhere')
    mkdirSync(join(elsewhere, '20261026T190000Z'), { recursive: true })
    const data = join(scratch, 'home', 'plugins', 'data', 'gh-security-example')
    mkdirSync(data, { recursive: true })
    symlinkSync(elsewhere, join(data, 'runs'))
    const given = join(data, 'runs', '20261026T190000Z')
    expect(removeRunCommand(contextFor([given]))).toEqual({
      outcome: 'failed',
      error: `remove-run: not a run directory, plugins/data/<id>/runs/<run>: ${join(elsewhere, '20261026T190000Z')}`,
    })
    expect(existsSync(join(elsewhere, '20261026T190000Z'))).toBe(true)
  })

  it.each([
    ['the runs directory itself', () => runs],
    ['the data directory of the plugin', () => dirname(runs)],
    ['a directory inside a run', () => join(makeRun('20261026T190000Z'), 'nested')],
    ['a directory outside the plugin data', () => scratch],
    [
      'a runs directory under data that is not under plugins',
      () => {
        const other = join(scratch, 'other', 'data', 'x', 'runs', 'r1')
        mkdirSync(other, { recursive: true })
        return other
      },
    ],
    [
      'a runs directory under plugins that is not under data',
      () => {
        const other = join(scratch, 'plugins', 'cache', 'x', 'runs', 'r1')
        mkdirSync(other, { recursive: true })
        return other
      },
    ],
  ])('refuses %s', (_case, pathOf) => {
    const given = pathOf()
    expect(removeRunCommand(contextFor([given]))).toEqual({
      outcome: 'failed',
      error: `remove-run: not a run directory, plugins/data/<id>/runs/<run>: ${given}`,
    })
    expect(existsSync(given)).toBe(true)
  })

  it('refuses a path at the root of the file system', () => {
    expect(removeRunCommand(contextFor(['/']))).toEqual({
      outcome: 'failed',
      error: 'remove-run: not a run directory, plugins/data/<id>/runs/<run>: /',
    })
  })
})

describe('remove-run on a run that cannot be removed', () => {
  // A directory with no write permission keeps its entries. Root ignores the
  // mode, so the example asks only where it can hold.
  it.runIf(process.getuid?.() !== 0)('fails with the reason of the removal', () => {
    const run = makeRun('20261026T190000Z')
    chmodSync(join(run, 'nested'), 0o500)
    try {
      const answer = removeRunCommand(contextFor([run]))
      expect(answer).toEqual({ outcome: 'failed', error: expect.stringMatching(/^remove-run: E/) })
    } finally {
      chmodSync(join(run, 'nested'), 0o700)
    }
  })
})
