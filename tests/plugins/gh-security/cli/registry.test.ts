// The registry's one structural promise: a command nobody asked for is never
// loaded (#273). Every loader is covered by run.test.ts, but a registry that
// imported every handler statically and wrapped it in `async () => handler`
// would pass all of those examples, so this pins the source shape the same
// way the entry point's floor-check placement is pinned.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GH_SECURITY_ROOT } from '#harness/paths.ts'

const source = readFileSync(join(GH_SECURITY_ROOT, 'src', 'cli', 'registry.ts'), 'utf8')

describe('the registry', () => {
  it('imports no handler statically, only types', () => {
    const imports = source.split('\n').filter((line) => /^import\s/.test(line))
    expect(imports.filter((line) => !/^import type\s/.test(line))).toEqual([])
  })

  it('reaches each handler through a dynamic import of its own subcommand module', () => {
    expect(source.match(/import\('\.\.\/subcommands\/[a-z-]+\.ts'\)/g)).toEqual([
      "import('../subcommands/allow-own-commands.ts')",
      "import('../subcommands/version.ts')",
    ])
  })
})
