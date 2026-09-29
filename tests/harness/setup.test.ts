// harness/setup.ts, which clears the git variables a hook exports before any
// example runs. CI never runs under a hook, so this example is what keeps the
// scrub from being deleted or narrowed without a red run: it hands the
// function an environment carrying what a hook under `git -c` exports.
import { describe, expect, it } from 'vitest'

import { scrubGitEnvironment } from '#harness/setup.ts'

import config from '../../vitest.config.ts'

describe('scrubGitEnvironment', () => {
  it('removes every repository-locating and config-override variable, and nothing else', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: '/repo/.git',
      GIT_WORK_TREE: '/repo',
      GIT_INDEX_FILE: '/repo/.git/index',
      GIT_COMMON_DIR: '/repo/.git',
      GIT_PREFIX: 'sub/',
      GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Someone',
      GIT_OBJECT_DIRECTORY: '/repo/.git/objects',
      GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
      GIT_EDITOR: 'true',
      PATH: '/usr/bin',
    }
    scrubGitEnvironment(env)
    expect(env).toEqual({
      GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
      GIT_EDITOR: 'true',
      PATH: '/usr/bin',
    })
  })

  it('runs before every test file, as a vitest.config.ts setupFiles entry', () => {
    expect(config.test.setupFiles).toContain('harness/setup.ts')
  })
})
