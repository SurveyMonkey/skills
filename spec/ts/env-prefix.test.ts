// The `env_prefix` seam. The whole rule is in the plugin guide's "`env_prefix`
// is an opaque, optional seam": a command prefix the environment requires,
// supplied by session context, never named or probed for by this plugin.
//
// So the examples use more than one prefix on purpose. A module that only
// ever worked for one shape would be naming an environment manager, which is
// exactly what the guide forbids; the prefixes below are data.
import { describe, expect, it } from 'vitest'

import { parseEnvPrefix, withEnvPrefix } from '../../plugins/gh-security/src/lib/env-prefix.ts'

describe('withEnvPrefix', () => {
  it('prepends the prefix verbatim, leaving the command as an argument to it', () => {
    expect(
      withEnvPrefix(parseEnvPrefix('direnv exec /src/app'), {
        command: 'gh',
        args: ['pr', 'list', '--repo', 'octo/app'],
        cwd: '/src/app',
      }),
    ).toEqual({
      command: 'direnv',
      args: ['exec', '/src/app', 'gh', 'pr', 'list', '--repo', 'octo/app'],
      cwd: '/src/app',
    })
  })
})
