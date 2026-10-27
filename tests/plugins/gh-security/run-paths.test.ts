// The two roots of a file flag (ruling 16 on #346). The seam is the exported
// rule. The shape checks are read as text. `confinementProblem` runs on real
// files in a scratch tree, with `resolvePhysical` of `reap.ts`, as the
// commands give it. Each expected value is written by hand from the header
// of `src/run-paths.ts`.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolvePhysical } from '#gh-security/reap.ts'
import {
  confinementProblem,
  isPlainPath,
  isRunDirectory,
  isUnderRunOrWork,
  isWorkDirectory,
} from '#gh-security/run-paths.ts'

const ROOTS =
  'a run directory (plugins/data/<id>/runs/<run>/) or a work directory (<repo>/.claude/worktrees/<leaf>/)'

describe('the shapes, read as text', () => {
  it.each([
    ['/h/.claude/plugins/data/gh-security-x/runs/r1', true, false],
    ['/h/plugins/data/x/runs', false, false],
    ['/h/plugins/data/x/other/r1', false, false],
    ['/h/plugins/cache/x/runs/r1', false, false],
    ['/h/other/data/x/runs/r1', false, false],
    ['/src/app/.claude/worktrees/fix-x', false, true],
    ['/src/app/.claude/other/fix-x', false, false],
    ['/src/app/claude/worktrees/fix-x', false, false],
    ['/', false, false],
  ])('reads %s as a run directory %s and a work directory %s', (path, run, work) => {
    expect([isRunDirectory(path), isWorkDirectory(path)]).toEqual([run, work])
  })

  it.each([
    ['/a/b.json', true],
    ['a/b.json', false],
    ['/a/../b.json', false],
    ['/a/./b.json', false],
    ['/a//b.json', false],
    ['/a/b/', false],
    ['/', false],
    ['', false],
  ])('reads %j as a plain absolute path: %s', (path, plain) => {
    expect(isPlainPath(path)).toBe(plain)
  })

  it.each([
    ['/h/plugins/data/x/runs/r1/merged.json', true],
    ['/h/plugins/data/x/runs/r1/a/b.json', true],
    ['/src/app/.claude/worktrees/fix-x/commit-msg.txt', true],
    ['/h/plugins/data/x/runs/r1', false],
    ['/src/app/.claude/worktrees/fix-x', false],
    ['/h/.claude/settings.json', false],
    ['/etc/hosts', false],
    // A relative path ends at `.`, which is its own parent. The walk must end
    // there: a mutant that lets a relative path past `isPlainPath` hung the
    // suite in an endless walk.
    ['merged.json', false],
    ['runs/r1/a.json', false],
  ])('reads %s as under a run or work directory: %s', (path, under) => {
    expect(isUnderRunOrWork(path)).toBe(under)
  })
})

describe('confinementProblem, on real files', () => {
  let scratch = ''
  let run = ''
  let work = ''

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gh-security-run-paths-')))
    run = join(scratch, 'home', '.claude', 'plugins', 'data', 'gh-security-x', 'runs', 'r1')
    work = join(scratch, 'repo', '.claude', 'worktrees', 'fix-dependabot-x-1x')
    mkdirSync(run, { recursive: true })
    mkdirSync(work, { recursive: true })
    mkdirSync(join(scratch, 'outside'))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const problem = (given: string) => confinementProblem('--out', given, resolvePhysical)

  it.each([
    ['a new file in a run', () => join(run, 'merged.json')],
    [
      'a file that is there in a run',
      () => {
        writeFileSync(join(run, 'merged.json'), '{}')
        return join(run, 'merged.json')
      },
    ],
    [
      'a file in a run that is not made yet',
      () =>
        join(
          scratch,
          'home',
          '.claude',
          'plugins',
          'data',
          'gh-security-x',
          'runs',
          'r2',
          'a.json',
        ),
    ],
    ['a file in a work directory', () => join(work, 'commit-msg.txt')],
  ])('allows %s', (_case, pathOf) => {
    expect(problem(pathOf())).toBeNull()
  })

  it.each([
    ['a file outside', () => join(scratch, 'outside', 'x.json')],
    ['the run directory itself', () => run],
    ['a .. segment that resolves into the run', () => `${run}/x/../merged.json`],
    ['a relative path', () => 'merged.json'],
    ['a / at the end', () => `${run}/sub/`],
    [
      'a parent that is a link that leads outside',
      () => {
        symlinkSync(join(scratch, 'outside'), join(run, 'linked'))
        return join(run, 'linked', 'x.json')
      },
    ],
    [
      'a file that is a link that leads outside',
      () => {
        writeFileSync(join(scratch, 'outside', 'settings.json'), '{}')
        symlinkSync(join(scratch, 'outside', 'settings.json'), join(run, 'a.json'))
        return join(run, 'a.json')
      },
    ],
  ])('refuses %s', (_case, pathOf) => {
    const given = pathOf()
    expect(problem(given)).toBe(`--out ${given} is not under ${ROOTS}`)
  })

  it('refuses a link at the end that leads nowhere, because a write would follow it', () => {
    const given = join(run, 'a.json')
    symlinkSync(join(scratch, 'outside', 'gone.json'), given)
    expect(problem(given)).toBe(`--out ${given} is a link that leads nowhere`)
  })
})
