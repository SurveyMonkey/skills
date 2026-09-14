// The `env_prefix` seam. The whole rule is in the plugin guide's "`env_prefix`
// is an opaque, optional seam": a command prefix the environment requires,
// supplied by session context, never named or probed for by this plugin.
//
// So the examples use more than one prefix on purpose. A module that only
// ever worked for one shape would be naming an environment manager, which is
// exactly what the guide forbids; the prefixes below are data.
import { describe, expect, it } from 'vitest'

import {
  NO_ENV_PREFIX,
  parseEnvPrefix,
  withEnvPrefix,
} from '../../plugins/gh-security/src/lib/env-prefix.ts'

describe('withEnvPrefix', () => {
  it('prepends the prefix verbatim, leaving the command as an argument to it', () => {
    expect(
      withEnvPrefix(parseEnvPrefix('run-in exec /src/app'), {
        command: 'gh',
        args: ['pr', 'list', '--repo', 'octo/app'],
        cwd: '/src/app',
      }),
    ).toEqual({
      command: 'run-in',
      args: ['exec', '/src/app', 'gh', 'pr', 'list', '--repo', 'octo/app'],
      cwd: '/src/app',
    })
  })

  // A second shape, because the seam is opaque: the plugin never names an
  // environment manager, so a module that worked only for the first prefix
  // in this file would be a module that knew one.
  it('works for a prefix that is not a directory-scoped launcher at all', () => {
    expect(
      withEnvPrefix(parseEnvPrefix('env NPM_CONFIG_REGISTRY=https://example.test/'), {
        command: 'git',
        args: ['-C', '/w/fix', 'status', '--porcelain'],
      }),
    ).toEqual({
      command: 'env',
      args: [
        'NPM_CONFIG_REGISTRY=https://example.test/',
        'git',
        '-C',
        '/w/fix',
        'status',
        '--porcelain',
      ],
    })
  })

  // Composed after the command's own locator, never instead of it: the prefix
  // injects environment and does not chdir, so a request that named a
  // directory still names it.
  it('leaves cwd, stdin and the added environment alone', () => {
    const wrapped = withEnvPrefix(parseEnvPrefix('run-in exec /src/app'), {
      command: 'gh',
      args: ['pr', 'create'],
      cwd: '/src/app/.claude/worktrees/fix',
      input: 'body text',
      env: { GH_PROMPT_DISABLED: '1' },
    })
    expect(wrapped.cwd).toBe('/src/app/.claude/worktrees/fix')
    expect(wrapped.input).toBe('body text')
    expect(wrapped.env).toEqual({ GH_PROMPT_DISABLED: '1' })
  })

  // Absent means bare, and bare means untouched: the same request object,
  // not a rebuilt one that happens to look like it.
  it('returns the request itself when there is no prefix', () => {
    const request = { command: 'gh', args: ['api', 'advisories'] }
    expect(withEnvPrefix(NO_ENV_PREFIX, request)).toBe(request)
    expect(withEnvPrefix(parseEnvPrefix(undefined), request)).toBe(request)
  })
})

describe('parseEnvPrefix', () => {
  // One row per spelling a dispatch payload has produced. `null` is the
  // string a JSON null becomes on the way through a state file, and the bash
  // seam matched it as a literal for the same reason: read as a command, it
  // would send every `gh` call to a program that does not exist.
  it.each([[undefined], [null], [''], ['   '], ['null']])('reads %j as no prefix at all', (raw) => {
    expect(parseEnvPrefix(raw)).toEqual([])
  })

  it('splits on whitespace, the way the bash seam it replaces did', () => {
    expect(parseEnvPrefix('  run-in   exec\t/src/app  ')).toEqual(['run-in', 'exec', '/src/app'])
  })

  // `null` is only the empty answer when it is the whole prefix. A path that
  // happens to contain the word is a path.
  it('keeps a prefix whose arguments merely contain the word null', () => {
    expect(parseEnvPrefix('run-in exec /src/null')).toEqual(['run-in', 'exec', '/src/null'])
  })
})
