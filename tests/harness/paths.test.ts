// The paths that `harness/paths.ts` gives are real files in this repository.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { pluginFile, ROOT } from '#harness/paths.ts'

it('names the repository root', () => {
  expect(existsSync(path.join(ROOT, 'package.json'))).toBe(true)
  expect(existsSync(path.join(ROOT, 'plugins'))).toBe(true)
})

it('names a file inside a plugin', () => {
  expect(pluginFile('gh-security', 'scripts', 'gh-security.ts')).toBe(
    path.join(ROOT, 'plugins', 'gh-security', 'scripts', 'gh-security.ts'),
  )
  expect(existsSync(pluginFile('gh-security', 'scripts', 'gh-security.ts'))).toBe(true)
})
