// The sandbox's own claims. A sandbox that quietly stopped isolating HOME,
// or a pathWithout that quietly stopped removing anything, would make every
// test built on it pass for the wrong reason.
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { COMMON_TOOLS, createSandbox, ESSENTIAL_TOOLS, sandboxEnv } from '#harness/sandbox.ts'

/** A bin directory that holds only the essential tools, as symlinks to
 *  this very node binary. `pathWithout` only asks whether a name is
 *  executable, so the target need not be the tool it stands in for. This
 *  is the one way to reach "a non-essential tool is missing," whatever
 *  tools the machine that runs the suite happens to have.
 */
function essentialsOnly(sandbox: { join(...parts: string[]): string }): string {
  const directory = sandbox.join('essentials-bin')
  mkdirSync(directory, { recursive: true })
  for (const tool of ESSENTIAL_TOOLS) {
    symlinkSync(process.execPath, path.join(directory, tool))
  }
  return directory
}

it('puts HOME inside the sandbox and leaves no plugin data directory set', () => {
  const sandbox = createSandbox()

  expect(sandbox.env.HOME).toBe(path.join(sandbox.path, 'home'))
  expect(existsSync(path.join(sandbox.path, 'home'))).toBe(true)
  expect('CLAUDE_PLUGIN_DATA' in sandbox.env).toBe(false)
})

it('gives each sandbox its own directory under the system temp directory', () => {
  const first = createSandbox()
  const second = createSandbox()

  expect(first.path).not.toBe(second.path)
  expect(first.path.startsWith(path.join(tmpdir(), 'skills-harness-'))).toBe(true)
  expect(first.join('a', 'b')).toBe(path.join(first.path, 'a', 'b'))
})

it('removes the sandbox directory on cleanup', () => {
  const sandbox = createSandbox()
  expect(existsSync(sandbox.path)).toBe(true)

  sandbox.cleanup()

  expect(existsSync(sandbox.path)).toBe(false)
})

// This is one claim proved across two tests, the only order that can
// prove it. A test cannot watch its own `onTestFinished` run. So the
// first test records the path, and the second, which runs once the first
// has finished, reads it back. Without this pair, a `createSandbox` that
// registered nothing at all would go unnoticed, because the test above
// calls `cleanup()` itself.
let autoCleaned = ''

it('registers its own cleanup, so a test need not call it', () => {
  const sandbox = createSandbox()
  autoCleaned = sandbox.path

  expect(existsSync(autoCleaned)).toBe(true)
})

it('has removed the previous test sandbox by the time the next test runs', () => {
  expect(autoCleaned).not.toBe('')
  expect(existsSync(autoCleaned)).toBe(false)
})

it('holds git config lookup inside the sandbox, whatever the base env said', () => {
  // A move of HOME alone does not do it. GIT_CONFIG_GLOBAL overrides the
  // HOME lookup, and this repository's own workspace exports it. Without
  // this fix, a fixture would read the developer's real global config,
  // while CI read none.
  const env = sandboxEnv({ GIT_CONFIG_GLOBAL: '/developer/config/git' }, '/sandbox/home')

  expect(env.GIT_CONFIG_GLOBAL).toBe(path.join('/sandbox/home', '.gitconfig'))
  expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
})

it('drops the git and gh environment a hook or a workspace exports', () => {
  // A pin on GIT_CONFIG_GLOBAL alone pins one variable. GIT_DIR would
  // replace the repository that `-C` chose. GIT_CONFIG_COUNT would carry
  // configuration that neither pin displaces. GIT_AUTHOR_NAME would beat
  // the `-c user.name` the git builders pass, and a git hook exports the
  // last of those. GH_TOKEN and GH_CONFIG_DIR are the developer's own
  // credentials; an injected mock means nothing here may reach them.
  //
  // This test checks the whole environment, not one key at a time. So a
  // variable that the sweep stops catching is a failure, not an omission.
  const env = sandboxEnv(
    {
      GIT_DIR: '/developer/repo/.git',
      GIT_AUTHOR_NAME: 'Outer',
      GIT_CONFIG_COUNT: '1',
      GH_TOKEN: 'secret',
      GH_CONFIG_DIR: '/developer/.config/gh',
      GITHUB_TOKEN: 'secret',
      PATH: '/usr/bin',
    },
    '/sandbox/home',
  )

  expect(Object.keys(env).sort()).toEqual([
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'HOME',
    'PATH',
  ])
})

it('drops the TypeSafe API key, so no spawned test can reach the real API', () => {
  // A developer's shell may export a model API key. Without this sweep, a
  // spawned test would bill a real account, and answer differently on that
  // machine than in CI. This is the same reason the sweep removes GH_TOKEN.
  const env = sandboxEnv({ TYPESAFE_API_KEY: 'secret', PATH: '/usr/bin' }, '/sandbox/home')

  expect(Object.keys(env).sort()).toEqual([
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'HOME',
    'PATH',
  ])
})

it('never mutates the environment it was built from', () => {
  // The property vitest makes load-bearing: several test files share one
  // worker process, so an env rewritten in place would outlive this test.
  const base = { HOME: '/original/home', CLAUDE_PLUGIN_DATA: '/original/data' }

  const env = sandboxEnv(base, '/sandbox/home')

  expect(env.HOME).toBe('/sandbox/home')
  expect('CLAUDE_PLUGIN_DATA' in env).toBe(false)
  expect(base).toEqual({ HOME: '/original/home', CLAUDE_PLUGIN_DATA: '/original/data' })

  const sandbox = createSandbox()
  sandbox.env.HOME = '/somewhere/else'
  expect(process.env.HOME).not.toBe('/somewhere/else')
})

it('puts a stub directory ahead of everything on the PATH it hands out', () => {
  const sandbox = createSandbox()
  const before = process.env.PATH

  const directory = sandbox.stubPath(sandbox.join('stub', 'bin'))

  expect(existsSync(directory)).toBe(true)
  expect(sandbox.env.PATH?.split(path.delimiter)[0]).toBe(directory)
  expect(sandbox.env.PATH).toContain(before)
  expect(process.env.PATH).toBe(before)
})

it('makes a stub directory the whole PATH when there was none', () => {
  const sandbox = createSandbox()
  delete sandbox.env.PATH

  const directory = sandbox.stubPath(sandbox.join('only', 'bin'))

  expect(sandbox.env.PATH).toBe(directory)
})

it('builds a PATH holding the real tools minus the named ones', () => {
  const sandbox = createSandbox()

  const directory = sandbox.pathWithout('git')

  const linked = readdirSync(directory)
  expect(linked).not.toContain('git')
  expect(linked).toContain('sh')
  expect(lstatSync(path.join(directory, 'sh')).isSymbolicLink()).toBe(true)
  expect(linked.every((tool) => COMMON_TOOLS.includes(tool))).toBe(true)
})

it('builds a fresh bin directory on every call', () => {
  // If a second call inherited the first one's links, it would hand back
  // a PATH that still holds the tool the test wants to remove.
  const sandbox = createSandbox()

  const first = sandbox.pathWithout('git')
  const second = sandbox.pathWithout()

  expect(first).not.toBe(second)
  expect(readdirSync(first)).not.toContain('git')
  expect(readdirSync(second)).toContain('git')
})

it('refuses a tool name it does not know', () => {
  // A typo removes nothing, and the test then passes for the wrong reason.
  const sandbox = createSandbox()

  expect(() => sandbox.pathWithout('pyhton3', 'gti')).toThrow(
    /not tools pathWithout knows about: gti, pyhton3; add them to COMMON_TOOLS/,
  )
})

it('skips a non-essential tool that is not installed', () => {
  const sandbox = createSandbox()
  sandbox.env.PATH = essentialsOnly(sandbox)

  const directory = sandbox.pathWithout()

  expect(readdirSync(directory).sort()).toEqual([...ESSENTIAL_TOOLS].sort())
})

it('does not mistake a directory for the tool it is named after', () => {
  // A directory that has the traverse bit passes the executable check.
  // So one named after a tool would be linked in as that tool, and the
  // "not installed" branch it stands for would never fire. `which`
  // excludes directories; `accessSync` alone does not.
  const sandbox = createSandbox()
  const bin = essentialsOnly(sandbox)
  mkdirSync(path.join(bin, 'jq'))
  sandbox.env.PATH = bin

  expect(readdirSync(sandbox.pathWithout()).sort()).toEqual([...ESSENTIAL_TOOLS].sort())
})

it('refuses to build a PATH with an essential tool missing', () => {
  // A PATH silently returned without a shell would fail a later test,
  // for a reason that test never meant to test.
  const sandbox = createSandbox()
  delete sandbox.env.PATH

  expect(() => sandbox.pathWithout()).toThrow(/bash is not on PATH; cannot build a usable PATH/)
})
