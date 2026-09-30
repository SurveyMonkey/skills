// Runs before every test file (vitest.config.ts `setupFiles`).
//
// A git hook runs with GIT_DIR and GIT_INDEX_FILE, and in a linked worktree
// more, pointing at the repository being committed to; `git -c` adds
// GIT_CONFIG_PARAMETERS. The runners in `lib/` give the inherited environment
// to a child by default. So under a hook, each git call an example makes,
// including the calls on the scratch repositories that harness/git-repo.ts
// builds, would act on this repository instead. On #273 that wrote
// `core.bare = true` and a test identity into the real `.git/config`, and
// moved a worktree's HEAD.
//
// The names come from git itself (`rev-parse --local-env-vars`), so the list
// cannot fall behind a newer git, plus the numbered GIT_CONFIG_KEY_<n> and
// GIT_CONFIG_VALUE_<n> pairs that GIT_CONFIG_COUNT refers to. With these gone,
// an example sees what it sees in CI, whatever started the suite.

import { execFileSync } from 'node:child_process'

export const scrubGitEnvironment = (env: NodeJS.ProcessEnv): void => {
  const local = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  })
  const names = new Set(local.split('\n').filter((name) => name !== ''))
  for (const name of Object.keys(env)) {
    if (names.has(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete env[name]
  }
}

scrubGitEnvironment(process.env)
