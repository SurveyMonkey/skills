// The tree reads of the merge-risk scorer: the workflow trigger, the run
// steps, the test imports and the walks. Each expected value is written by
// hand from the grep, sed and awk lines of `score-merge-risk.sh`. The
// verdicts these reads feed are in `score.test.ts`.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ciStep,
  importPattern,
  packageTested,
  prTrigger,
  runCommands,
  siblingTested,
  sourceFiles,
  testImportBases,
  workflowDirUnreadable,
  workflowFiles,
} from '#gh-security/merge-risk/tree.ts'
import { createSandbox } from '#harness/sandbox.ts'

const tree = (files: Readonly<Record<string, string>>): string => {
  const root = createSandbox().join('tree')
  mkdirSync(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('prTrigger', () => {
  it.each([
    ['a scalar', 'on: pull_request\n', 'pull_request'],
    ['a list', 'on: [push, pull_request]\n', '[push, pull_request]'],
    ['a map', 'on: {pull_request: {branches: [main]}}  \n', '{pull_request: {branches: [main]}}'],
    ['a quoted key', '"on": pull_request_target\n', 'pull_request_target'],
    ['a line with a carriage return', 'on: pull_request\r\n', 'pull_request'],
    ['no newline at the end', 'on: pull_request', 'pull_request'],
    ['the block form', 'on:\n  push:\n  pull_request:\n    branches: [main]\n', 'pull_request'],
    [
      'a bare on with a comment',
      'on: # events\n        pull_request_target: {}\n',
      'pull_request_target',
    ],
  ])('reads %s', (_name, text, trigger) => {
    expect(prTrigger(text)).toBe(trigger)
  })

  it.each([
    ['a push trigger', 'on: push\n'],
    ['an event that only starts with the word', 'on: pull_requests\n'],
    ['a job named pull_request under a push trigger', 'on: push\njobs:\n  pull_request:\n'],
    ['an event nine spaces deep', 'on:\n         pull_request:\n'],
    ['no trigger at all', 'name: x\n'],
  ])('reads no trigger from %s', (_name, text) => {
    expect(prTrigger(text)).toBeNull()
  })
})

describe('runCommands and ciStep', () => {
  it('reads run scalars and the lines of a run block, and no comment', () => {
    const text = [
      'steps:',
      '  - run: npm ci',
      '  # - run: npm test',
      '  - name: build',
      '    run: |',
      '      npm run build',
      '',
      '      # a comment',
      '      tsc --noEmit',
      '    with:',
      '      cmd: npm test',
      '  - run: >',
      '      echo done',
    ].join('\n')
    expect(runCommands(text)).toEqual([
      'npm ci',
      '      npm run build',
      '      tsc --noEmit',
      '      echo done',
    ])
  })

  it.each([
    ['a scoped script', '- run: pnpm test:ci', 'pnpm test:ci'],
    ['a script after &&', '- run: cd a && yarn lint --fix', 'cd a && yarn lint --fix'],
    ['a runner by path', '- run: ./node_modules/.bin/vitest run', './node_modules/.bin/vitest run'],
    ['a typecheck', '- run: npx tsc', 'npx tsc'],
    ['a block line, trimmed', '- run: |\n    npm test   \n', 'npm test'],
  ])('finds %s', (_name, text, step) => {
    expect(ciStep(text)).toBe(step)
  })

  it.each([
    ['an echo', '- run: echo npm test'],
    ['another script', '- run: npm run deploy'],
    ['a runner inside a word', '- run: myjest'],
    ['no run step', '- uses: actions/checkout@v4'],
  ])('finds no step in %s', (_name, text) => {
    expect(ciStep(text)).toBeNull()
  })
})

describe('testImportBases', () => {
  it('reads the last segment of each quoted path on an import line, without one extension', () => {
    const root = tree({
      'tests/a.test.js': [
        "import a from '../src/a.js'",
        'import { b } from "@/lib/b.min.js"',
        "const c = require('./c')",
        "import d from 'd'",
        "const e = '../src/e'",
        "import x from 'x' + '/y.longext'",
      ].join('\n'),
    })
    expect([...testImportBases(root, ['./tests/a.test.js'])].sort()).toEqual([
      'a',
      'b.min',
      'c',
      'y.longext',
    ])
  })
})

describe('the walks', () => {
  it('skips a directory it cannot read when it is not strict, and throws when it is', () => {
    const root = tree({ 'a.js': '', 'locked/b.js': '' })
    chmodSync(join(root, 'locked'), 0)
    try {
      expect(sourceFiles(root, false)).toEqual(['./a.js'])
      expect(() => sourceFiles(root, true)).toThrow(expect.objectContaining({ code: 'EACCES' }))
    } finally {
      chmodSync(join(root, 'locked'), 0o755)
    }
  })

  it('does not count a sibling test that is a broken link', () => {
    const root = tree({ 'src/a.js': '' })
    symlinkSync(join(root, 'missing'), join(root, 'src', 'a.test.js'))
    expect(siblingTested(root, 'src/a.js')).toBe(false)
    writeFileSync(join(root, 'missing'), '')
    expect(siblingTested(root, 'src/a.js')).toBe(true)
  })

  it('reads no workflow directory from a file of that name', () => {
    const root = tree({ '.github/workflows': 'on: pull_request\n' })
    expect([workflowDirUnreadable(root), workflowFiles(root)]).toEqual([false, []])
  })
})

describe('ciStep, each command the bash takes as a check', () => {
  it.each([
    'bun test',
    'bunx lint',
    'pnpm typecheck',
    'yarn check',
    'npm run check-types',
    'cd a&&yarn lint',
    'jest',
    'playwright test',
    'cypress run',
  ])('takes %s', (command) => {
    expect(ciStep(`jobs:\n  t:\n    steps:\n      - run: ${command}\n`)).toBe(command)
  })
})

describe('packageTested', () => {
  it('skips a test file it cannot read: 2>/dev/null || true', () => {
    const root = tree({ 't.test.js': "import x from 'lodash'" })
    chmodSync(join(root, 't.test.js'), 0)
    expect(packageTested(root, ['./t.test.js'], importPattern(['lodash']))).toBe(false)
  })
})
