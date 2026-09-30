// One test's private world: a temp directory, a HOME inside it, and an
// environment the test can rewrite.
//
// Nothing here touches `process.env`. Vitest runs several test files
// through one worker process, so a mutated `process.env` would outlive the
// test that set it, and reach whatever ran next in that worker. Instead,
// the sandbox hands out an `env` object. The git builder takes this object
// as the child's environment, and a test may edit it freely, because no
// other test can see it.
//
// Git's whole environment, and gh's, is held inside the sandbox, not left
// to HOME alone. `sandboxEnv` says why.
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

// The tools a plugin script may reach for. `pathWithout` links all of
// these into a fresh bin directory, except the ones it is asked to leave
// out. This is how a test provokes the "tool is not installed" branches,
// without a change to the real PATH. `node` is the interpreter the
// TypeScript entry points run under, and the one whose absence they must
// survive.
//
// This is `as const` so the names survive as a type. `pathWithout` only
// ever walks this list. If an essential tool were missing from it, the
// list would never test for that tool, and the guarantee below would
// quietly stop holding. `CommonTool` makes that a compile error instead.
const COMMON_TOOL_NAMES = [
  'bash',
  'sh',
  'jq',
  'git',
  'gh',
  'grep',
  'sed',
  'awk',
  'tr',
  'cat',
  'cut',
  'head',
  'mkdir',
  'mv',
  'rm',
  'date',
  'find',
  'dirname',
  'basename',
  'env',
  'id',
  'chmod',
  'node',
] as const

/** A name `pathWithout` knows how to link. */
export type CommonTool = (typeof COMMON_TOOL_NAMES)[number]

// This is exported as `readonly string[]`, so a caller may still ask
// about a name that is not one of these. `pathWithout` refuses a typo at
// run time. `tests/harness/sandbox.test.ts` proves this with one such name.
export const COMMON_TOOLS: readonly string[] = COMMON_TOOL_NAMES

// Without these tools, a returned PATH is not a usable shell environment
// at all, and a script would fail for a reason the test never meant to
// test. This is typed as `CommonTool`, so none of these can ever be a name
// `pathWithout` does not walk.
export const ESSENTIAL_TOOLS: readonly CommonTool[] = ['bash', 'sh', 'node']

export interface Sandbox {
  /** The private temp directory. Everything the test writes goes under here. */
  readonly path: string
  /** The child environment: `process.env` with HOME moved, no plugin data
   *  directory, git's config lookup held inside the sandbox, and git's and
   *  gh's own variables swept out of it. Mutable, and private to this
   *  sandbox. */
  readonly env: NodeJS.ProcessEnv
  /** `path.join` rooted at the sandbox, for building fixture paths. */
  join(...parts: string[]): string
  /** Put `directory` ahead of everything on the sandbox's PATH. */
  stubPath(directory: string): string
  /** A bin directory of symlinks to the real tools, minus the named ones. */
  pathWithout(...tools: string[]): string
  /** Remove the sandbox directory. Registered with `onTestFinished` too. */
  cleanup(): void
}

/** The environment a sandbox hands out: `base`, with HOME pointed at
 *  `home`, CLAUDE_PLUGIN_DATA removed, git's config lookup held inside the
 *  sandbox, and git's and gh's own variables swept out of it.
 *
 *  Moving HOME is not enough to keep the developer's git configuration
 *  out. `GIT_CONFIG_GLOBAL` overrides the HOME lookup entirely, and this
 *  repository's own workspace exports it from direnv. Without this fix, a
 *  fixture reads the developer's real global config, while CI reads none.
 *  With `status.showUntrackedFiles = no` and `merge.ff = false` in that
 *  file, two of tests/harness/git.test.ts's own assertions fail locally and pass in CI.
 *
 *  Pointing `GIT_CONFIG_GLOBAL` inside the sandbox restores the plain
 *  meaning of moving HOME, and leaves a test free to write that file
 *  itself. `GIT_CONFIG_NOSYSTEM` makes the same argument for the
 *  machine's system config, which sets `init.defaultBranch` on a stock
 *  macOS git. This function uses it, not `GIT_CONFIG_SYSTEM`, because
 *  Apple's build reads its own system file, whatever that variable names.
 *
 *  This returns a copy, never the object it was given. The point of the
 *  sandbox is that a test cannot change what another test sees. This
 *  function is exported so its own claims can be checked against a base
 *  environment this process does not have.
 */
export function sandboxEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  // This removes the whole prefix, because pinning one variable pins one
  // variable. Git takes a repository, a configuration, and an author
  // identity from its environment, and each of those outranks what this
  // function pins below. `GIT_DIR` and `GIT_WORK_TREE` would replace the
  // repository that `-C` chose, whatever `-C` said. `GIT_CONFIG_COUNT` and
  // `GIT_CONFIG_PARAMETERS` would carry configuration that neither
  // `GIT_CONFIG_GLOBAL` nor `GIT_CONFIG_NOSYSTEM` displaces.
  //
  // `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` would beat the `-c user.name`
  // the git builders pass, so the identity they claim to pin would not be
  // pinned at all. A git hook runs with the author variables and
  // `GIT_INDEX_FILE` exported, and a pre-commit hook is one place this
  // suite runs. So that is the ordinary case, not a contrived one.
  // `git rev-parse --local-env-vars` names fifteen of these, and none of
  // the author ones. This is why the sandbox sweeps the whole prefix,
  // instead of keeping a list that would have to stay right.
  //
  // `GH_` variables go with it. `gh` is an injected mock (mocking.md), so
  // nothing the suite runs may reach the real one. A child that holds
  // `GH_TOKEN` or `GH_CONFIG_DIR` would turn that mistake into a live API
  // call as the developer, instead of a failure. `GITHUB_TOKEN` is the
  // same credential under gh's other name. A test that wants any of these
  // back sets it on the sandbox's own `env`, which is private to it.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('GH_')) delete env[key]
  }
  delete env.GITHUB_TOKEN
  // A developer's shell may export a model API key. A spawned test would
  // then call the real API, bill a real account, and answer differently
  // there than in CI. This is the same argument as `GH_` above, for the
  // other credential the suite must not reach.
  delete env.TYPESAFE_API_KEY
  env.HOME = home
  env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  delete env.CLAUDE_PLUGIN_DATA
  return env
}

/** Look `tool` up on a PATH value, the way a shell does. The first
 *  executable match wins. A directory is not a match. Nothing is found
 *  when the value is empty. This is exported for the git shim, which
 *  needs the real git's absolute path; a shim named `git` would otherwise
 *  resolve to itself.
 */
export function findOnPath(tool: string, pathValue: string | undefined): string | undefined {
  for (const directory of (pathValue ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, tool)
    try {
      accessSync(candidate, constants.X_OK)
      // A directory that has the traverse bit also passes the executable
      // check. So a PATH entry that has one named after a tool would be
      // linked in as that tool, and the "not installed" branch it stands
      // for would never fire. `which` excludes directories for the same
      // reason; `accessSync` alone does not.
      if (statSync(candidate).isDirectory()) continue
      return candidate
    } catch {
      // Not here, or not executable. Keep walking: a tool genuinely missing
      // from every entry is the case `pathWithout` has to report on.
    }
  }
  return undefined
}

/** A private temp directory, a HOME inside it, and no plugin data
 *  directory.
 *
 *  Call it from inside a test. This registers cleanup with vitest's
 *  `onTestFinished`, so a test that throws still removes its directory.
 *  `cleanup()` is there for a caller that wants to remove the directory
 *  sooner.
 */
export function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'skills-harness-'))
  const home = path.join(root, 'home')
  mkdirSync(home)
  const env = sandboxEnv(process.env, home)

  const cleanup = () => {
    // `force` only forgives a directory that is already gone. A sandbox
    // that holds a real repository can still be mid-write when the test
    // ends (git's own `gc --auto` outlives the commit that triggered it).
    // The removal then fails with ENOTEMPTY, and the test that had already
    // passed then fails too. `maxRetries` is node's own answer to exactly
    // that race. Without it, the suite's flake rate rises with the number
    // of repositories a file builds. That is why it surfaced as more
    // fixtures were added.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  onTestFinished(cleanup)

  return {
    path: root,
    env,
    join: (...parts: string[]) => path.join(root, ...parts),

    stubPath(directory: string): string {
      // The rewrite lands on the sandbox's own env, not on the process's.
      mkdirSync(directory, { recursive: true })
      const existing = env.PATH
      env.PATH = existing ? `${directory}${path.delimiter}${existing}` : directory
      return directory
    },

    pathWithout(...tools: string[]): string {
      // A typo here would remove nothing and the test would pass for the wrong
      // reason, which is exactly the failure the suite must not have.
      const unknown = tools.filter((tool) => !COMMON_TOOLS.includes(tool))
      if (unknown.length > 0) {
        throw new Error(
          `not tools pathWithout knows about: ${[...unknown].sort().join(', ')}; ` +
            'add them to COMMON_TOOLS',
        )
      }
      // This uses a fresh directory per call. So a second call cannot
      // silently inherit the first one's links, and hand back a PATH that
      // still holds the tool the test wants to remove.
      const directory = mkdtempSync(path.join(root, 'bin-without-'))
      // This walks the `as const` list, not the exported one. So `tool`
      // carries the literal type the ESSENTIAL_TOOLS check below needs.
      for (const tool of COMMON_TOOL_NAMES) {
        if (tools.includes(tool)) continue
        const real = findOnPath(tool, env.PATH)
        if (real === undefined) {
          if (ESSENTIAL_TOOLS.includes(tool)) {
            throw new Error(`${tool} is not on PATH; cannot build a usable PATH`)
          }
          continue
        }
        symlinkSync(real, path.join(directory, tool))
      }
      return directory
    },

    cleanup,
  }
}
