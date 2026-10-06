// `render-pr`: the commit message, the PR body, the labels and the PR of one
// fix group (#233). The seam is the exported handler. `commit-msg` and `body`
// run no child, so they read real files. `labels` and `create` run `gh`
// through the real client over a runner that records its argv, so the argv
// is what the client builds and not what the command meant. A failure of
// `gh` comes from the mock client.
//
// The expected text is the reviewed fixtures of `spec/fixtures/render-pr/`
// and strings written by hand. Parity against the script is in
// `parity-render-pr.test.ts`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { CommandContext, CommandResult } from '#gh-security/cli/command.ts'
import { createGhClient, type GhClient, GhError } from '#gh-security/lib/gh.ts'
import type { Runner, RunResult } from '#gh-security/lib/process.ts'
import { renderPr, renderPrCommand } from '#gh-security/subcommands/render-pr.ts'
import { FIXTURES_ROOT } from '#harness/fixtures.ts'
import { createGhMock, ghFails } from '#harness/gh.ts'

const FX = join(FIXTURES_ROOT, 'render-pr')
const REPO = 'octo/app'
// The dash of three messages of the script. The source holds its code point.
const DASH = String.fromCodePoint(0x2014)
const fixture = (name: string): string => join(FX, name)
const textOf = (name: string): string => readFileSync(fixture(name), 'utf8')
const jsonOf = (name: string) => JSON.parse(textOf(name))

const scratch = mkdtempSync(join(tmpdir(), 'render-pr-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
/** A new directory with the files written into it, and the path of each. */
const place = (files: Record<string, string>): Record<string, string> => {
  counter += 1
  const dir = join(scratch, `d${counter}`)
  mkdirSync(dir)
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => {
      writeFileSync(join(dir, name), text)
      return [name, join(dir, name)]
    }),
  )
}

const noChild: Runner = () => Promise.reject(new Error('this example starts no child'))
const noClient = (): GhClient => createGhMock()

interface Ran {
  /** Everything that the command wrote on stdout. */
  readonly out: string
  readonly result: CommandResult
}

const run = async (
  args: readonly string[],
  makeClient: Parameters<typeof renderPr>[1] = noClient,
  spawn: Runner = noChild,
): Promise<Ran> => {
  const written: string[] = []
  const context: CommandContext = {
    args,
    env: {},
    io: {
      stdout: (text) => {
        written.push(text)
      },
      stderr: () => {},
      readStdin: () => '',
    },
    commandNames: [],
  }
  const result = await renderPr(context, makeClient, spawn)
  return { out: written.join(''), result }
}

const failure = (error: string): CommandResult => ({ outcome: 'failed', error })

/** Nothing was written, and the command failed with this message. */
const refused = (ran: Ran, error: string): void => {
  expect(ran.result).toEqual(failure(error))
  expect(ran.out).toBe('')
}

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

/** A body or a commit message run over inputs that the example gives as values. */
const render = async (
  verb: 'body' | 'commit-msg',
  state: unknown,
  group: unknown,
  extra: readonly string[] = [],
): Promise<Ran & { files: Record<string, string> }> => {
  const files = place({ 'state.json': text(state), 'group.json': text(group) })
  const ran = await run([
    verb,
    '--state',
    files['state.json'] as string,
    '--group-json',
    files['group.json'] as string,
    '--repo',
    REPO,
    ...extra,
  ])
  return { ...ran, files }
}

/** A parsed document, which an example edits by key. */
type Doc = ReturnType<typeof jsonOf>

const STATE = jsonOf('state-scoped.json')
const GROUP = jsonOf('group.json')
const edit = <T>(base: T, change: (copy: T) => void): T => {
  const copy = structuredClone(base)
  change(copy)
  return copy
}

const missing = (where: string, path: string): string =>
  `${where} has no usable '.${path}'. The driver's contract promises this field; an absent or null value here is never rendered as a default.`
const wrong = (where: string, path: string, expected: string): string =>
  `${where} has a '.${path}' that is not ${expected}. The driver's contract promises ${expected}; a value of another type is never rendered as text.`

// ---------------------------------------------------------------------------
// commit-msg
// ---------------------------------------------------------------------------

describe('commit-msg', () => {
  const commit = (state: string, group = 'group.json') =>
    run(['commit-msg', '--state', fixture(state), '--group-json', fixture(group), '--repo', REPO])

  it.each([
    ['scoped-override', 'state-scoped.json', 'expected-commit-msg-scoped.txt'],
    [
      'direct-update, with the GHSA when cve is null',
      'state-direct.json',
      'expected-commit-msg-direct.txt',
    ],
    ['bare-override', 'state-bare-added.json', 'expected-commit-msg-bare-added.txt'],
  ])(
    'writes the %s template byte for byte, and returns nothing else',
    async (_name, state, expected) => {
      const ran = await commit(state)
      expect(ran.result).toBeUndefined()
      expect(ran.out).toBe(textOf(expected))
    },
  )

  it('writes one Refs line for each alert, in the order of the alerts', async () => {
    expect((await commit('state-scoped.json')).out).toContain(
      'Refs: https://github.com/octo/app/security/dependabot/42\nRefs: https://github.com/octo/app/security/dependabot/55\n',
    )
  })

  it('refuses a lockfile refresh: nothing is left to commit', async () => {
    refused(
      await commit('state-lockfile-refresh.json'),
      `commit-msg: action is lockfile-refresh ${DASH} there is nothing to commit beyond phase 3's drift commit, which is already on the branch. Skip straight to push.`,
    )
  })

  it.each([
    ['an unknown action', 'weird', "commit-msg: unrecognized action 'weird'"],
    ['an action that is a number', 5, "commit-msg: unrecognized action '5'"],
    ['an action that is a list', ['a'], 'commit-msg: unrecognized action \'["a"]\''],
    [
      'an action that is the name of a built-in',
      'constructor',
      "commit-msg: unrecognized action 'constructor'",
    ],
  ])('refuses %s', async (_name, action, error) => {
    refused(
      await render(
        'commit-msg',
        edit(STATE, (s) => {
          s.action = action
        }),
        GROUP,
      ),
      error,
    )
  })

  it('refuses a state without an action', async () => {
    const ran = await render(
      'commit-msg',
      edit(STATE, (s) => {
        delete s.action
      }),
      GROUP,
    )
    refused(ran, missing(`commit-msg: --state ${ran.files['state.json']}`, 'action'))
  })

  it.each(['scoped-override', 'bare-override'])(
    'refuses a %s with no override_file',
    async (action) => {
      const ran = await render(
        'commit-msg',
        edit(STATE, (s) => {
          s.action = action
          delete s.override_file
        }),
        GROUP,
      )
      refused(
        ran,
        missing(
          `commit-msg: --state ${ran.files['state.json']} (action '${action}')`,
          'override_file',
        ),
      )
    },
  )

  it('refuses an override_file that is not text', async () => {
    const ran = await render(
      'commit-msg',
      edit(STATE, (s) => {
        s.override_file = 7
      }),
      GROUP,
    )
    refused(
      ran,
      wrong(
        `commit-msg: --state ${ran.files['state.json']} (action 'scoped-override')`,
        'override_file',
        'text',
      ),
    )
  })

  it('needs no override_file for a direct update, and names package.json', async () => {
    const ran = await render(
      'commit-msg',
      edit(STATE, (s) => {
        s.action = 'direct-update'
        delete s.override_file
      }),
      GROUP,
    )
    expect(ran.out).toContain('Direct update to >=4.17.21 via package.json.\n')
  })

  it.each([
    ['package', 'package'],
    ['highest_fixed_version', 'highest_fixed_version'],
    ['major_line', 'major_line'],
  ])('refuses a group without %s', async (_name, key) => {
    const ran = await render(
      'commit-msg',
      STATE,
      edit(GROUP, (g) => {
        delete g[key]
      }),
    )
    refused(ran, missing(`commit-msg: --group-json ${ran.files['group.json']}`, key))
  })

  it.each([
    ['package', 7],
    ['highest_fixed_version', ['4']],
  ])('refuses a group whose %s is not text', async (key, value) => {
    const ran = await render(
      'commit-msg',
      STATE,
      edit(GROUP, (g) => {
        g[key] = value
      }),
    )
    refused(ran, wrong(`commit-msg: --group-json ${ran.files['group.json']}`, key, 'text'))
  })

  it.each([['abc'], [''], ['4.5'], [-4], [4.5], [true], ['4\n'], ['04x']])(
    'refuses a major_line that is %j',
    async (value) => {
      const ran = await render(
        'commit-msg',
        STATE,
        edit(GROUP, (g) => {
          g.major_line = value
        }),
      )
      refused(
        ran,
        `commit-msg: --group-json ${ran.files['group.json']}'s major_line is not a plain non-negative integer, as a number or a string.`,
      )
    },
  )

  it('takes a major_line that is a number', async () => {
    const ran = await render(
      'commit-msg',
      STATE,
      edit(GROUP, (g) => {
        g.major_line = 4
      }),
    )
    expect(ran.out.split('\n')[0]).toBe('fix(deps): resolve 2 Dependabot alert(s) for lodash 4.x')
  })

  it('refuses a state or a group that is not a JSON object', async () => {
    const group = await render('commit-msg', STATE, 'null')
    refused(
      group,
      `commit-msg: --group-json ${group.files['group.json']} is not readable JSON, or not a JSON object.`,
    )
    const state = await render('commit-msg', '[]', GROUP)
    refused(
      state,
      `commit-msg: --state ${state.files['state.json']} is not readable JSON, or not a JSON object.`,
    )
  })

  it.each([
    ['malformed.txt', 'state'],
    ['malformed.txt', 'group'],
  ])('refuses a %s that does not parse, as the %s', async (name, which) => {
    const state = which === 'state' ? name : 'state-scoped.json'
    const group = which === 'state' ? 'group.json' : name
    const flag = which === 'state' ? '--state' : '--group-json'
    refused(
      await commit(state, group),
      `commit-msg: ${flag} ${fixture(name)} is not readable JSON, or not a JSON object.`,
    )
  })

  it.each([['an empty list', 'group-empty-alerts.json']])(
    'refuses %s of alerts',
    async (_name, group) => {
      refused(
        await commit('state-scoped.json', group),
        `commit-msg: --group-json ${fixture(group)} carries no non-empty alerts[]. A dispatched group is never empty; rendering a count and an alert list from zero alerts is a false claim, not a legitimate empty state.`,
      )
    },
  )

  it.each([
    ['alerts that are text', 'x'],
    ['alerts that are an object', {}],
    ['no alerts', undefined],
  ])('refuses %s', async (_name, alerts) => {
    const ran = await render(
      'commit-msg',
      STATE,
      edit(GROUP, (g) => {
        g.alerts = alerts
      }),
    )
    refused(
      ran,
      `commit-msg: --group-json ${ran.files['group.json']} carries no non-empty alerts[]. A dispatched group is never empty; rendering a count and an alert list from zero alerts is a false claim, not a legitimate empty state.`,
    )
  })

  it.each([
    ['an alert that is a number', () => 5],
    ['an alert that is null', () => null],
    ['an alert with no cve and no ghsa', (a: Doc) => ({ ...a, cve: null, ghsa: null })],
    ['an alert with an empty cve', (a: Doc) => ({ ...a, cve: '' })],
    ['an alert with an empty ghsa', (a: Doc) => ({ ...a, ghsa: '' })],
    ['an alert whose cve is a number', (a: Doc) => ({ ...a, cve: 5 })],
    ['an alert whose number is text', (a: Doc) => ({ ...a, number: '42' })],
    ['an alert whose number is a fraction', (a: Doc) => ({ ...a, number: 4.5 })],
    ['an alert with no number', (a: Doc) => ({ ...a, number: undefined })],
    ['an alert with no severity', (a: Doc) => ({ ...a, severity: undefined })],
    ['an alert with an empty severity', (a: Doc) => ({ ...a, severity: '' })],
  ])('refuses %s', async (_name, change) => {
    const ran = await render(
      'commit-msg',
      STATE,
      edit(GROUP, (g) => {
        g.alerts[1] = change(g.alerts[1])
      }),
    )
    refused(
      ran,
      `commit-msg: --group-json ${ran.files['group.json']} has an alert missing 'number', both of 'cve' and 'ghsa', or 'severity'. Every alert line and Refs: trailer needs all three.`,
    )
  })

  // `commit-msg` reads `epss_percentile` and `summary` of no alert.
  it('takes an alert with no epss_percentile and no summary', async () => {
    const ran = await render(
      'commit-msg',
      STATE,
      edit(GROUP, (g) => {
        for (const alert of g.alerts) {
          delete alert.epss_percentile
          delete alert.summary
        }
      }),
    )
    expect(ran.out).toContain('- #42: CVE-2021-23337 (high)\n- #55: GHSA-p6mc-m468-83gw (medium)\n')
  })

  it('reads files as UTF-8 text, ignores a byte order mark, and keeps non-ASCII names', async () => {
    const group = edit(GROUP, (g) => {
      g.package = 'ünï-日本'
    })
    const ran = await render('commit-msg', `﻿${JSON.stringify(STATE)}`, `﻿${JSON.stringify(group)}`)
    expect(ran.out.split('\n')[0]).toBe('fix(deps): resolve 2 Dependabot alert(s) for ünï-日本 4.x')
  })

  // `$(...)` of the script dropped the final line feeds of a value.
  it('drops the final line feeds of a value, and puts one space for an inner break', async () => {
    const ran = await render(
      'commit-msg',
      edit(STATE, (s) => {
        s.override_file = 'package.json\n\n'
      }),
      edit(GROUP, (g) => {
        g.package = 'lo\ndash\n'
        g.highest_fixed_version = '4.17.21\n'
      }),
    )
    expect(ran.out).toContain('for lo dash 4.x\n')
    expect(ran.out).toContain('Scoped override to >=4.17.21 via package.json.\n')
  })

  it('puts one space for a line break of an id or a severity', async () => {
    const ran = await render(
      'commit-msg',
      STATE,
      edit(GROUP, (g) => {
        g.alerts[0].cve = 'CVE\r\n1'
        g.alerts[0].severity = 'hi\ngh'
      }),
    )
    expect(ran.out).toContain('- #42: CVE 1 (hi gh)\n')
  })

  it('names a missing file, and a directory', async () => {
    const group = fixture('group.json')
    expect(
      (
        await run([
          'commit-msg',
          '--state',
          fixture('no-such-file.json'),
          '--group-json',
          group,
          '--repo',
          REPO,
        ])
      ).result,
    ).toEqual(failure(`--state: no such file: ${fixture('no-such-file.json')}`))
    expect(
      (await run(['commit-msg', '--state', FX, '--group-json', group, '--repo', REPO])).result,
    ).toEqual(failure(`--state: no such file: ${FX}`))
    expect(
      (
        await run([
          'commit-msg',
          '--state',
          group,
          '--group-json',
          fixture('no-such-file.json'),
          '--repo',
          REPO,
        ])
      ).result,
    ).toEqual(failure(`--group-json: no such file: ${fixture('no-such-file.json')}`))
  })
})

// ---------------------------------------------------------------------------
// body
// ---------------------------------------------------------------------------

describe('body', () => {
  const NOTES = [
    '--global-override-note',
    fixture('global-override-note.txt'),
    '--collateral-note',
    fixture('collateral-note.txt'),
  ]
  const body = (state: string, group = 'group.json', extra: readonly string[] = []) =>
    run([
      'body',
      '--state',
      fixture(state),
      '--group-json',
      fixture(group),
      '--repo',
      REPO,
      ...extra,
    ])

  describe('every variant, byte for byte', () => {
    it.each([
      ['state-scoped.json', 'expected-body-scoped.md'],
      ['state-direct.json', 'expected-body-direct.md'],
      ['state-lockfile-refresh.json', 'expected-body-lockfile-refresh.md'],
      ['state-drift.json', 'expected-body-drift.md'],
      ['state-pnpm.json', 'expected-body-pnpm.md'],
      ['state-major-bump.json', 'expected-body-major-bump.md'],
      ['state-major-bump-pnpm.json', 'expected-body-major-bump-pnpm.md'],
      ['state-major-bump-yarn.json', 'expected-body-major-bump-yarn.md'],
      ['state-collateral-null.json', 'expected-body-collateral-null.md'],
      ['state-collateral-benign.json', 'expected-body-collateral-benign.md'],
    ])('renders %s as %s', async (state, expected) => {
      const ran = await body(state)
      expect(ran.result).toBeUndefined()
      expect(ran.out).toBe(textOf(expected))
    })

    it.each([
      ['state-bare-added.json', 'expected-body-bare-added.md'],
      ['state-bare-tightened.json', 'expected-body-bare-tightened.md'],
    ])('renders %s with the override note as %s', async (state, expected) => {
      const ran = await body(state, 'group.json', [
        '--global-override-note',
        fixture('global-override-note.txt'),
      ])
      expect(ran.out).toBe(textOf(expected))
    })

    it('renders the fatal collateral table, and the note, with a (gone) for an empty After', async () => {
      const ran = await body('state-collateral-fatal.json', 'group.json', [
        '--collateral-note',
        fixture('collateral-note.txt'),
      ])
      expect(ran.out).toBe(textOf('expected-body-collateral-fatal.md'))
      expect(ran.out).toContain('| 1.x | 1.1.18 | (gone) |')
    })

    it('renders a group whose major_line is a number as the same body', async () => {
      expect((await body('state-scoped.json', 'group-numeric-major-line.json')).out).toBe(
        textOf('expected-body-scoped.md'),
      )
    })

    it('renders a direct update with no override_file as the direct body', async () => {
      expect((await body('state-direct-no-override-file.json')).out).toBe(
        textOf('expected-body-direct.md'),
      )
    })

    it('renders a null before, and an EPSS of exactly 0', async () => {
      expect((await body('state-before-null.json')).out).toContain('## Summary')
      expect((await body('state-scoped.json', 'group-zero-epss.json')).out).toContain('| 0.0% |')
    })

    it('ignores a note that the state does not need', async () => {
      expect((await body('state-scoped.json', 'group.json', NOTES)).out).toBe(
        textOf('expected-body-scoped.md'),
      )
    })

    it('says "not fixed" only when a copy has no patched release', async () => {
      expect((await body('state-scoped.json')).out).not.toContain('## Not fixed by this PR')
      expect((await body('state-major-bump.json')).out).toContain(
        '| 3.18.1 | GHSA-p6mc-m468-83gw | no patched release in the 3.x line; needs a major bump of `some-tool` or dropping it |',
      )
    })

    it('names a scoped npm parent with its scope, and no parent for a pnpm or yarn path', async () => {
      expect((await body('state-major-bump-npm-scoped.json')).out).toContain(
        'needs a major bump of `@nestjs/core` or dropping it',
      )
      for (const state of [
        'state-major-bump-pnpm-scoped.json',
        'state-major-bump-yarn-scoped.json',
      ]) {
        expect((await body(state)).out).toContain(
          'needs a major bump of the dependent that pins it (not derivable from this report) or dropping it',
        )
      }
    })

    it('puts a parenthesis, and not a blank cell, where no alert matches the entry', async () => {
      const ran = await body('state-major-bump-no-alert-match.json')
      expect(ran.out).toContain("| (no alert's vulnerable_range matched this entry) |")
    })

    it('says that nothing was resolved before a refresh with no before', async () => {
      expect((await body('state-lockfile-refresh-no-before.json')).out).toContain(
        'had no comparable version on the 4.x line before this change',
      )
    })
  })

  describe('a note that was not supplied', () => {
    it('refuses a bare override with no --global-override-note, and writes nothing', async () => {
      refused(
        await body('state-bare-added.json'),
        "body: bare_override is 'added', so the PR needs a ## Global override section, and its reasoning (why no scoped form covered every path, and which resolved copies it pins) is evidence only the agent has. Pass --global-override-note <file>.",
      )
    })

    it('refuses a fatal move with no --collateral-note', async () => {
      refused(
        await body('state-collateral-fatal.json'),
        'body: other_line_moves carries a fatal entry, which only happens on a human re-dispatch, and the narrative explaining why the move was accepted is evidence only the agent has. Pass --collateral-note <file>.',
      )
    })

    it('refuses a note flag that names no file, an empty value, and a note file that is a directory', async () => {
      const state = fixture('state-scoped.json')
      const group = fixture('group.json')
      const gone = fixture('no-such-note.txt')
      expect(
        (
          await run([
            'body',
            '--state',
            state,
            '--group-json',
            group,
            '--repo',
            REPO,
            '--collateral-note',
            gone,
          ])
        ).result,
      ).toEqual(failure(`--collateral-note: no such file: ${gone}`))
      expect(
        (
          await run([
            'body',
            '--state',
            state,
            '--group-json',
            group,
            '--repo',
            REPO,
            '--global-override-note',
            gone,
          ])
        ).result,
      ).toEqual(failure(`--global-override-note: no such file: ${gone}`))
      expect(
        (
          await run([
            'body',
            '--state',
            state,
            '--group-json',
            group,
            '--repo',
            REPO,
            '--global-override-note',
            FX,
          ])
        ).result,
      ).toEqual(failure(`--global-override-note: no such file: ${FX}`))
    })

    it('refuses a note that cannot be read, and names the file', async () => {
      const files = place({ 'note.txt': 'x' })
      const path = files['note.txt'] as string
      chmodSync(path, 0)
      try {
        const ran = await body('state-scoped.json', 'group.json', ['--collateral-note', path])
        expect(ran.result).toMatchObject({ outcome: 'failed' })
        expect(
          (ran.result as { error: string }).error.startsWith(
            `--collateral-note: cannot read ${path}: EACCES`,
          ),
        ).toBe(true)
        expect(ran.out).toBe('')
      } finally {
        chmodSync(path, 0o644)
      }
    })

    it('writes a note as it is, with its own line breaks and no final line feed added', async () => {
      const files = place({ 'note.txt': 'one\r\ntwo' })
      const ran = await body('state-bare-added.json', 'group.json', [
        '--global-override-note',
        files['note.txt'] as string,
      ])
      expect(ran.out).toContain('\none\r\ntwo\n\n## Verification')
    })
  })

  describe('a field of the state that is promised', () => {
    it.each([
      ['state-missing-action.json', '.action', 'action', ''],
      ['state-missing-resolved-version.json', '.resolved_version', 'resolved_version', ''],
      ['state-missing-drift-commit.json', '.drift_commit', 'drift_commit', ''],
      ['state-missing-bare-override.json', '.bare_override', 'bare_override', ''],
      ['state-missing-risk-markdown.json', '.risk.markdown', 'risk.markdown', ''],
      ['state-missing-why-raw.json', '.why_raw', 'why_raw', ''],
      ['state-missing-validate-checked.json', '.validate.checked', 'validate.checked', ''],
      ['state-missing-written.json', '.written', 'written', " (action 'scoped-override')"],
      [
        'state-missing-override-file.json',
        '.override_file',
        'override_file',
        " (action 'scoped-override')",
      ],
    ])('refuses %s: no usable %s', async (state, _label, path, action) => {
      const ran = await body(state, 'group.json', NOTES)
      refused(ran, missing(`body: --state ${fixture(state)}${action}`, path))
    })

    it.each([
      [
        'action',
        (s: Doc) => {
          s.action = 5
        },
        'text',
      ],
      [
        'resolved_version',
        (s: Doc) => {
          s.resolved_version = 4
        },
        'text',
      ],
      [
        'drift_commit',
        (s: Doc) => {
          s.drift_commit = 'true'
        },
        'true or false',
      ],
      [
        'bare_override',
        (s: Doc) => {
          s.bare_override = 'weird'
        },
        'one of none, added or tightened',
      ],
      [
        'bare_override',
        (s: Doc) => {
          s.bare_override = 'none\n'
        },
        'one of none, added or tightened',
      ],
      [
        'risk.markdown',
        (s: Doc) => {
          s.risk.markdown = 5
        },
        'text',
      ],
      [
        'why_raw',
        (s: Doc) => {
          s.why_raw = 7
        },
        'text',
      ],
      [
        'validate.checked',
        (s: Doc) => {
          s.validate.checked = '3'
        },
        'a whole number',
      ],
      [
        'validate.checked',
        (s: Doc) => {
          s.validate.checked = -2
        },
        'a whole number',
      ],
      [
        'validate.checked',
        (s: Doc) => {
          s.validate.checked = 1.5
        },
        'a whole number',
      ],
    ])('refuses a %s of the wrong type', async (path, change, expected) => {
      const ran = await render('body', edit(STATE, change), GROUP)
      refused(ran, wrong(`body: --state ${ran.files['state.json']}`, path, expected))
    })

    it('refuses an action that is not one of the four, and a before that is not text', async () => {
      const unknown = await render(
        'body',
        edit(STATE, (s) => {
          s.action = 'weird'
        }),
        GROUP,
      )
      refused(unknown, "body: unrecognized action 'weird'")
      const before = await render(
        'body',
        edit(STATE, (s) => {
          s.before = 4
        }),
        GROUP,
      )
      refused(
        before,
        wrong(`body: --state ${before.files['state.json']}`, 'before', 'text or null'),
      )
    })

    it('refuses a validate that is not an object, with the field named', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.validate = 'x'
        }),
        GROUP,
      )
      refused(ran, missing(`body: --state ${ran.files['state.json']}`, 'validate.checked'))
    })

    it.each([
      [
        'state-missing-other-line-moves.json',
        'other_line_moves',
        '(no baseline was available); an absent key is not, and rendering the null-case text for it would be a specific factual claim made from a hole in the data.',
      ],
      [
        'state-missing-before.json',
        'before',
        '(nothing to report pre-fix on this line); an absent key is not.',
      ],
    ])('refuses %s: no %s key at all', async (state, key, rest) => {
      const answer =
        key === 'other_line_moves'
          ? `body: --state ${fixture(state)} has no 'other_line_moves' key at all. \`null\` there is a real, checked answer ${rest}`
          : `body: --state ${fixture(state)} has no 'before' key at all. \`null\` there is a real, checked answer ${rest}`
      refused(await body(state), answer)
    })

    it('refuses a state that reports zero checked, and says so', async () => {
      refused(
        await body('state-zero-checked.json'),
        `body: --state ${fixture('state-zero-checked.json')} reports validate.checked: 0. Zero resolved versions checked on the 4.x line is never a legitimate 'Lockfile validated' claim, whether the field was genuinely zero or silently defaulted from an absent one.`,
      )
    })
  })

  describe('the group', () => {
    it.each([
      ['package', 'text'],
      ['highest_fixed_version', 'text'],
    ])('refuses a %s that is not %s', async (key, expected) => {
      const ran = await render(
        'body',
        STATE,
        edit(GROUP, (g) => {
          g[key] = 7
        }),
      )
      refused(ran, wrong(`body: --group-json ${ran.files['group.json']}`, key, expected))
    })

    it.each(['package', 'major_line', 'highest_fixed_version'])(
      'refuses a group without %s',
      async (key) => {
        const ran = await render(
          'body',
          STATE,
          edit(GROUP, (g) => {
            g[key] = null
          }),
        )
        refused(ran, missing(`body: --group-json ${ran.files['group.json']}`, key))
      },
    )

    it('refuses a major_line that is not a plain non-negative integer', async () => {
      refused(
        await body('state-scoped.json', 'group-bad-major-line.json'),
        `body: --group-json ${fixture('group-bad-major-line.json')}'s major_line is not a plain non-negative integer, as a number or a string.`,
      )
    })

    it('computes the next major exactly, for a major_line above 2^53', async () => {
      const ran = await render(
        'body',
        STATE,
        edit(GROUP, (g) => {
          g.major_line = '12345678901234567890'
        }),
      )
      expect(ran.out).toContain('`>=4.17.21 <12345678901234567891`')
    })

    it.each([
      ['malformed.txt', 'state', '--state'],
      ['malformed.txt', 'group', '--group-json'],
    ])('refuses a %s that does not parse, as the %s', async (name, which, flag) => {
      const ran = await body(
        which === 'state' ? name : 'state-scoped.json',
        which === 'state' ? 'group.json' : name,
      )
      refused(ran, `body: ${flag} ${fixture(name)} is not readable JSON, or not a JSON object.`)
    })

    it('refuses an empty list of alerts, and the rest of the bad alerts', async () => {
      refused(
        await body('state-scoped.json', 'group-empty-alerts.json'),
        `body: --group-json ${fixture('group-empty-alerts.json')} carries no non-empty alerts[]. A dispatched group is never empty; a Summary and an Alerts resolved table rendered from zero alerts is a false claim, not a legitimate empty state.`,
      )
      const message = (file: string): string =>
        `body: --group-json ${file} has an alert missing 'number', both of 'cve' and 'ghsa', 'severity', or a numeric 'epss_percentile'. Every alerts-table row and Refs: line needs all four.`
      for (const group of [
        'group-missing-epss.json',
        'group-missing-severity.json',
        'group-nonnumeric-epss.json',
      ]) {
        refused(await body('state-scoped.json', group), message(fixture(group)))
      }
      for (const bad of [-0.1, 1.1, '0.5', null]) {
        const ran = await render(
          'body',
          STATE,
          edit(GROUP, (g) => {
            g.alerts[0].epss_percentile = bad
          }),
        )
        refused(ran, message(ran.files['group.json'] as string))
      }
      for (const bad of [7, false, []]) {
        const ran = await render(
          'body',
          STATE,
          edit(GROUP, (g) => {
            g.alerts[0].summary = bad
          }),
        )
        refused(ran, message(ran.files['group.json'] as string))
      }
    })

    it('takes an EPSS of exactly 1 as 100.0%', async () => {
      const ran = await render(
        'body',
        STATE,
        edit(GROUP, (g) => {
          g.alerts[0].epss_percentile = 1
        }),
      )
      expect(ran.out).toContain('| 100.0% |')
    })

    it('reads a summary that is null, absent or empty as an empty cell', async () => {
      for (const summary of [null, undefined, '']) {
        const ran = await render(
          'body',
          STATE,
          edit(GROUP, (g) => {
            g.alerts[0].summary = summary
          }),
        )
        expect(ran.out).toContain('| 84.2% |  |')
      }
    })
  })

  describe('the order of the checks', () => {
    // The script checked in this order, so a state with two defects gives the same first message.
    it('checks the state objects before the alerts, and the alerts before the fields', async () => {
      const both = await render('body', '[]', 'null')
      refused(
        both,
        `body: --state ${both.files['state.json']} is not readable JSON, or not a JSON object.`,
      )
      const alerts = await render(
        'body',
        edit(STATE, (s) => {
          delete s.action
        }),
        edit(GROUP, (g) => {
          g.alerts = []
        }),
      )
      expect(alerts.result).toMatchObject({
        error: expect.stringContaining('carries no non-empty alerts[]'),
      })
    })

    it('checks both notes before the zero count, and the zero count before the written list', async () => {
      const state = edit(jsonOf('state-bare-added.json'), (s) => {
        s.validate.checked = 0
        delete s.written
      })
      const note = await render('body', state, GROUP)
      expect(note.result).toMatchObject({
        error: expect.stringContaining('Pass --global-override-note'),
      })
      const zero = await render('body', state, GROUP, [
        '--global-override-note',
        fixture('global-override-note.txt'),
      ])
      expect(zero.result).toMatchObject({
        error: expect.stringContaining('reports validate.checked: 0'),
      })
    })
  })

  describe('the written list and the override file', () => {
    it('refuses a written that is not a list', async () => {
      for (const written of ['x', { a: 1 }]) {
        const ran = await render(
          'body',
          edit(STATE, (s) => {
            s.written = written
          }),
          GROUP,
        )
        refused(
          ran,
          wrong(
            `body: --state ${ran.files['state.json']} (action 'scoped-override')`,
            'written',
            'a list',
          ),
        )
      }
    })

    it('does not read written for a lockfile refresh', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.action = 'lockfile-refresh'
          s.written = 'x'
        }),
        GROUP,
      )
      expect(ran.out).toContain('The fix is a no-change lockfile refresh')
    })

    it('refuses an override_file that is not text, for any action', async () => {
      for (const action of ['scoped-override', 'direct-update']) {
        const ran = await render(
          'body',
          edit(STATE, (s) => {
            s.action = action
            s.override_file = 7
          }),
          GROUP,
        )
        const where =
          action === 'scoped-override'
            ? `body: --state ${ran.files['state.json']} (action 'scoped-override')`
            : `body: --state ${ran.files['state.json']}`
        refused(ran, wrong(where, 'override_file', 'text'))
      }
    })

    it('names the YAML file of a pnpm workspace, for a direct update as well', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.action = 'direct-update'
          s.override_file = 'pnpm-workspace.yaml\n'
        }),
        GROUP,
      )
      expect(ran.out).toContain('The override lives in `pnpm-workspace.yaml`;')
    })

    it('reads a before that is empty as no version', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.action = 'lockfile-refresh'
          s.before = ''
        }),
        GROUP,
      )
      expect(ran.out).toContain('had no comparable version')
    })

    it('puts the fixed before into the refresh sentence, without its final line feed', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.action = 'lockfile-refresh'
          s.before = '4.17.18\n'
        }),
        GROUP,
      )
      expect(ran.out).toContain('the committed lockfile pinned `4.17.18` on the 4.x line.')
    })
  })

  describe('a bare override', () => {
    const bare = (change: (state: Doc) => void = () => {}) =>
      edit(jsonOf('state-bare-added.json'), change)
    const note = ['--global-override-note', fixture('global-override-note.txt')]
    const RANGE = (file: string): string =>
      `body: bare_override is 'added' but --state ${file}'s written[] carries no top-level (parent: null) entry with a string value to report the range from. The state file contradicts its own classification; nothing is rendered rather than a fabricated range.`

    it.each([['state-bare-no-range.json'], ['state-bare-no-value.json']])(
      'refuses %s: no range to report',
      async (state) => {
        refused(await body(state, 'group.json', note), RANGE(fixture(state)))
      },
    )

    it.each([
      [
        'an entry that is not an object',
        (s: Doc) => {
          s.written.push(5)
        },
      ],
      [
        'a parent that is not null',
        (s: Doc) => {
          s.written = [{ parent: '', value: '>=2' }]
        },
      ],
      [
        'a value that is not text',
        (s: Doc) => {
          s.written = [{ parent: null, value: 5 }]
        },
      ],
    ])('refuses written with %s', async (_name, change) => {
      const ran = await render('body', bare(change), GROUP, note)
      refused(ran, RANGE(ran.files['state.json'] as string))
    })

    it('takes the range of the first top-level entry that has a text value', async () => {
      const ran = await render(
        'body',
        bare((s) => {
          s.written = [{ parent: null, value: null }, { parent: null }, { value: '>=2 <3' }]
        }),
        GROUP,
        note,
      )
      expect(ran.out).toContain('Added an unscoped override `lodash: ">=2 <3"`.')
    })

    it.each([
      ['state-bare-bad-applied-parents.json', 'applied_parents'],
      ['state-bare-bad-resolved-versions.json', 'validate.resolved_versions'],
    ])('refuses %s: %s is not an array of strings', async (state, name) => {
      refused(
        await body(state, 'group.json', note),
        `body: --state ${fixture(state)}'s ${name} is not an array of strings.`,
      )
    })

    it.each([
      [
        'applied_parents',
        'a string',
        (s: Doc) => {
          s.applied_parents = 'express'
        },
      ],
      [
        'applied_parents',
        'a number among the texts',
        (s: Doc) => {
          s.applied_parents = ['a', 1]
        },
      ],
      [
        'validate.resolved_versions',
        'false',
        (s: Doc) => {
          s.validate.resolved_versions = false
        },
      ],
    ])('refuses %s that is %s', async (name, _what, change) => {
      const ran = await render('body', bare(change), GROUP, note)
      refused(ran, `body: --state ${ran.files['state.json']}'s ${name} is not an array of strings.`)
    })

    it('leaves out each sentence that has nothing to say, and says Tightened for a tightened range', async () => {
      const ran = await render(
        'body',
        bare((s) => {
          s.bare_override = 'tightened'
          s.applied_parents = null
          delete s.validate.resolved_versions
        }),
        GROUP,
        note,
      )
      expect(ran.out).toContain('Tightened an unscoped override `lodash: ">=4.17.21 <5"`.\n')
      const only = await render(
        'body',
        bare((s) => {
          s.applied_parents = ['a\n', 'b']
          s.validate.resolved_versions = []
        }),
        GROUP,
        note,
      )
      expect(only.out).toContain('Scoped entries were tried on: a , b.\n')
      expect(only.out).not.toContain('Resolved copies after the fix')
      const survived = await render(
        'body',
        bare((s) => {
          s.applied_parents = []
        }),
        GROUP,
        note,
      )
      expect(survived.out).not.toContain('Scoped entries were tried on')
      expect(survived.out).toContain(' Resolved copies after the fix: 4.17.21.\n')
    })
  })

  describe('the not-fixed table', () => {
    const bump = (items: unknown, group = GROUP) =>
      render(
        'body',
        edit(STATE, (s) => {
          s.requires_major_bump = items
        }),
        edit(group, (g) => {
          g.alerts[0].vulnerable_range = '<4.17.21'
          g.alerts[1].vulnerable_range = '<4.17.19'
        }),
      )
    const entry = (
      version: string,
      path = 'node_modules/a/node_modules/lodash',
      ranges: unknown = ['<4.17.19'],
    ) => ({ version, path, vulnerable_ranges: ranges })
    const BAD = (file: string): string =>
      `body: --state ${file} has a requires_major_bump entry missing 'version' or 'path' as a string, or an unreadable vulnerable_ranges[]. Rendering the table's header with no rows from this would read as "nothing left open" ${DASH} the opposite of the truth ${DASH} so nothing is rendered instead.`

    it.each([[false], [0], ['']])(
      'refuses a requires_major_bump that is %j, where the script read false as empty',
      async (value) => {
        const ran = await bump(value)
        refused(
          ran,
          `body: --state ${ran.files['state.json']}'s requires_major_bump is not an array.`,
        )
      },
    )

    it('refuses ranges that are false, where the script read false as empty', async () => {
      const ran = await bump([{ version: '3.0.0', path: 'p', vulnerable_ranges: false }])
      refused(ran, BAD(ran.files['state.json'] as string))
    })

    it('refuses a state whose list is not an array', async () => {
      const ran = await bump({ a: 1 })
      refused(
        ran,
        `body: --state ${ran.files['state.json']}'s requires_major_bump is not an array.`,
      )
    })

    it('refuses a path that is missing', async () => {
      refused(
        await body('state-major-bump-missing-path.json'),
        BAD(fixture('state-major-bump-missing-path.json')),
      )
    })

    it.each([
      ['an entry that is a number', 5],
      ['an entry that is null', null],
      ['a version that is a number', { version: 3, path: 'p', vulnerable_ranges: [] }],
      ['a path that is a number', { version: '3.0.0', path: 3, vulnerable_ranges: [] }],
      ['ranges that are a string', { version: '3.0.0', path: 'p', vulnerable_ranges: '<1' }],
    ])('refuses %s', async (_name, entryValue) => {
      const ran = await bump([entryValue])
      refused(ran, BAD(ran.files['state.json'] as string))
    })

    it.each([['latest'], [''], ['=v']])(
      'refuses a version, %j, that names no major line',
      async (version) => {
        const ran = await bump([entry(version)])
        refused(
          ran,
          `body: --state ${ran.files['state.json']} has a requires_major_bump entry whose version '${version}' names no major line, so its row cannot say which line has no patched release.`,
        )
      },
    )

    it.each([
      ['v3.18.1', '3'],
      ['=v3.18.1', '3'],
      ['3.0.0-beta.1', '3'],
      ['12', '12'],
    ])('reads the major of %s as %s', async (version, major) => {
      const ran = await bump([entry(version)])
      expect(ran.out).toContain(
        `| ${version} | GHSA-p6mc-m468-83gw | no patched release in the ${major}.x line;`,
      )
    })

    it('reads entries with absent or null ranges as no ranges, and null requires_major_bump as none', async () => {
      const a = await bump([
        { version: '3.0.0', path: 'p' },
        { version: '3.0.1', path: 'p', vulnerable_ranges: null },
      ])
      expect(a.out).toContain("| 3.0.0 | (no alert's vulnerable_range matched this entry) |")
      expect(a.out).toContain("| 3.0.1 | (no alert's vulnerable_range matched this entry) |")
      expect((await bump(null)).out).not.toContain('## Not fixed by this PR')
      const absent = await render(
        'body',
        edit(STATE, (s) => {
          delete s.requires_major_bump
        }),
        GROUP,
      )
      expect(absent.out).not.toContain('## Not fixed by this PR')
    })

    it('lists every alert that an entry leaves open, by GHSA first, then CVE, in the order of the alerts', async () => {
      const ran = await bump([entry('3.18.1', 'node_modules/lodash', ['<4.17.19', '<4.17.21'])])
      expect(ran.out).toContain('| 3.18.1 | GHSA-35jh-r3h4-6jhm, GHSA-p6mc-m468-83gw |')
      const cve = await render(
        'body',
        edit(STATE, (s) => {
          s.requires_major_bump = [entry('3.18.1', 'node_modules/lodash', ['<4.17.21'])]
        }),
        edit(GROUP, (g) => {
          g.alerts[0].vulnerable_range = '<4.17.21'
          g.alerts[0].ghsa = null
        }),
      )
      expect(cve.out).toContain('| 3.18.1 | CVE-2021-23337 |')
    })

    it('matches an empty range only to an alert with no range', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.requires_major_bump = [entry('3.18.1', 'node_modules/lodash', [''])]
        }),
        edit(GROUP, (g) => {
          g.alerts[0].vulnerable_range = null
          g.alerts[1].vulnerable_range = '<4.17.19'
        }),
      )
      expect(ran.out).toContain('| 3.18.1 | GHSA-35jh-r3h4-6jhm |')
    })

    it.each([
      ['node_modules/a/node_modules/lodash', 'a'],
      ['node_modules/@s/a/node_modules/lodash', '@s/a'],
      ['node_modules/@s/a@1.0.0/node_modules/lodash', '@s/a'],
      ['node_modules/a@1.0.0/node_modules/lodash', 'a'],
      ['node_modules/@s/node_modules/lodash', '@s'],
      ['node_modules/@/node_modules/lodash', '@'],
      ['node_modules/a/node_modules/b/node_modules/lodash', 'b'],
      ['a/node_modules/lodash', 'a'],
      ['@s/a/node_modules/lodash', '@s/a'],
      ['packages/web/node_modules/lodash', 'web'],
      ['node_modules/ünï-日本/node_modules/lodash', 'ünï-日本'],
    ])('names the parent of %s as %s', async (path, parent) => {
      const ran = await bump([entry('3.18.1', path)])
      expect(ran.out).toContain(`needs a major bump of \`${parent}\` or dropping it |`)
    })

    it.each([['node_modules/lodash'], ['lodash'], [''], ['lodash@3.18.1']])(
      'names no parent for the path %j',
      async (path) => {
        const ran = await bump([entry('3.18.1', path)])
        expect(ran.out).toContain(
          'needs a major bump of the dependent that pins it (not derivable from this report) or dropping it |',
        )
      },
    )

    it('refuses an alert with no range key, ghsa key or cve key, when a copy is left open', async () => {
      const message = (file: string): string =>
        `body: --group-json ${file} has an alert missing 'vulnerable_range', 'ghsa' or 'cve', needed to say which alerts stay open in the Not-fixed-by-this-PR table.`
      for (const change of [
        (g: Doc) => {
          delete g.alerts[0].vulnerable_range
        },
        (g: Doc) => {
          delete g.alerts[0].ghsa
        },
        (g: Doc) => {
          delete g.alerts[0].cve
        },
        (g: Doc) => {
          g.alerts[0].vulnerable_range = 7
        },
      ]) {
        const ran = await render(
          'body',
          edit(STATE, (s) => {
            s.requires_major_bump = [entry('3.18.1')]
          }),
          edit(GROUP, (g) => {
            g.alerts[0].vulnerable_range = '<1'
            change(g)
          }),
        )
        refused(ran, message(ran.files['group.json'] as string))
      }
    })

    it('does not ask for those keys when nothing is left open', async () => {
      const ran = await render(
        'body',
        STATE,
        edit(GROUP, (g) => {
          delete g.alerts[0].ghsa
        }),
      )
      expect(ran.out).toContain('## Summary')
    })
  })

  describe('the collateral section', () => {
    const moves = (items: unknown, extra: readonly string[] = []) =>
      render(
        'body',
        edit(STATE, (s) => {
          s.other_line_moves = items
        }),
        GROUP,
        extra,
      )
    const MOVES = (file: string): string =>
      `body: --state ${file}'s other_line_moves does not parse as an array of {class: fatal|benign_dedup, major, before: [], after: []} entries.`
    const move = (cls: string, major: unknown, before: unknown, after: unknown) => ({
      class: cls,
      major,
      before,
      after,
    })

    it.each([['state-collateral-bad-class.json'], ['state-collateral-before-null.json']])(
      'refuses %s',
      async (state) => {
        refused(await body(state), MOVES(fixture(state)))
      },
    )

    it.each([
      ['an object', {}],
      ['text', 'x'],
      ['false', false],
      ['an entry that is a number', [5]],
      ['an entry that is null', [null]],
      ['a third class', [move('other', 1, [], [])]],
      ['a class that is absent', [{ major: 1, before: [], after: [] }]],
      ['a major that is null', [move('benign_dedup', null, [], [])]],
      ['a major that is false', [move('benign_dedup', false, [], [])]],
      ['a major that is absent', [{ class: 'benign_dedup', before: [], after: [] }]],
      ['a before that is absent', [{ class: 'fatal', major: 1, after: [] }]],
      ['an after that is null', [move('fatal', 1, [], null)]],
      ['a number among the versions', [move('benign_dedup', 1, [2], [])]],
      ['a null among the versions', [move('benign_dedup', 1, [], [null])]],
    ])('refuses other_line_moves that is %s', async (_name, items) => {
      const ran = await moves(items)
      refused(ran, MOVES(ran.files['state.json'] as string))
    })

    it('writes the table of a benign move, with a number or a text for the major, and each version', async () => {
      const ran = await moves([
        move('benign_dedup', 2, ['2.0.0', '2.0.1'], ['2.0.2']),
        move('benign_dedup', '3', [], ['3.0.0']),
      ])
      expect(ran.out).toContain(
        '| Line | Before | After |\n|---|---|---|\n| 2.x | 2.0.0, 2.0.1 | 2.0.2 |\n| 3.x |  | 3.0.0 |\n\nThese are within-major dedups',
      )
      expect(ran.out).not.toContain('No collateral')
    })

    it('needs the note for a fatal move among benign ones, and writes every row', async () => {
      const entries = [
        move('benign_dedup', 2, ['2.0.0'], ['2.0.1']),
        move('fatal', 1, ['1.0.0'], []),
      ]
      refused(
        await moves(entries),
        'body: other_line_moves carries a fatal entry, which only happens on a human re-dispatch, and the narrative explaining why the move was accepted is evidence only the agent has. Pass --collateral-note <file>.',
      )
      const files = place({ 'note.txt': 'because\n' })
      const ran = await moves(entries, ['--collateral-note', files['note.txt'] as string])
      expect(ran.out).toContain(
        '| 2.x | 2.0.0 | 2.0.1 |\n| 1.x | 1.0.0 | (gone) |\n\nbecause\n\n\n## Verification',
      )
    })

    it('writes the no-baseline sentence for null, and no claim of "no collateral"', async () => {
      const ran = await moves(null)
      expect(ran.out).toContain(
        'No baseline was available to check other major lines of `lodash` against, so this PR makes no claim about them.\n\n## Verification',
      )
      expect(ran.out).not.toContain('No collateral')
    })
  })

  describe('text from input', () => {
    it('escapes a pipe, a backslash and a line break in a cell, and keeps non-ASCII text', async () => {
      const ran = await render(
        'body',
        STATE,
        edit(GROUP, (g) => {
          g.alerts[0].summary = 'a|b \\ c\r\nd\re\nf Überlauf 日本 🚀'
          g.alerts[1].summary = '\\|'
        }),
      )
      expect(ran.out).toContain('| 84.2% | a\\|b \\\\ c d e f Überlauf 日本 🚀 |')
      expect(ran.out).toContain('| 5.0% | \\\\\\| |')
    })

    it('escapes the cells of the other tables the same way', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.requires_major_bump = [{ version: '3.0|0', path: 'p', vulnerable_ranges: [] }]
          s.other_line_moves = [
            { class: 'benign_dedup', major: 'a|b', before: ['1\n|2'], after: ['3\\4'] },
          ]
        }),
        GROUP,
      )
      expect(ran.out).toContain('| 3.0\\|0 |')
      expect(ran.out).toContain('| a\\|b.x | 1 \\|2 | 3\\\\4 |')
    })

    it('puts one space for a line break in a value of a line, and drops its final line feeds', async () => {
      const ran = await render(
        'body',
        edit(STATE, (s) => {
          s.resolved_version = '4.17.21\n'
          s.override_file = 'package.json\n'
        }),
        edit(GROUP, (g) => {
          g.package = 'lo\ndash\n'
        }),
      )
      expect(ran.out).toContain('for `lo dash` in the 4.x line')
      expect(ran.out).toContain('- Resolved version: 4.17.21\n')
    })

    it('makes a fence longer than any run of backticks in the chain or the written block', async () => {
      const chain = await render(
        'body',
        edit(STATE, (s) => {
          s.why_raw = 'a\n```\nb'
        }),
        GROUP,
      )
      expect(chain.out).toContain('## Dependency chain\n\n````\na\n```\nb\n````\n\n')
      const written = await render(
        'body',
        edit(STATE, (s) => {
          s.written = [{ value: '```x' }]
        }),
        GROUP,
      )
      expect(written.out).toContain('````json\n[\n')
      expect(written.out).toContain('\n]\n````\n\n')
    })

    it('writes the scorer Markdown as it is, with one blank line more than its own end', async () => {
      const one = await render(
        'body',
        edit(STATE, (s) => {
          s.risk.markdown = '## Merge risk: x'
        }),
        GROUP,
      )
      expect(one.out).toContain('\n## Merge risk: x\n\n## Dependency chain')
      const empty = await render(
        'body',
        edit(STATE, (s) => {
          s.risk.markdown = ''
        }),
        GROUP,
      )
      expect(empty.out).toContain('\n\n\n## Dependency chain')
    })

    it('reads a BOM, and each file as UTF-8', async () => {
      const group = edit(GROUP, (g) => {
        g.alerts[0].summary = 'ñandú'
      })
      const ran = await render('body', `﻿${JSON.stringify(STATE)}`, `﻿${JSON.stringify(group)}`)
      expect(ran.out).toContain('| ñandú |')
    })
  })

  it('writes the whole body at once, and never part of one, for a defect found late', async () => {
    const ran = await render(
      'body',
      STATE,
      edit(GROUP, (g) => {
        g.alerts[1].summary = 5
      }),
    )
    expect(ran.out).toBe('')
  })

  it('names the flag for a missing file, or a missing repo', async () => {
    const state = fixture('state-scoped.json')
    const group = fixture('group.json')
    expect((await run(['body', '--group-json', group, '--repo', REPO])).result).toEqual(
      failure('--state requires a file'),
    )
    expect((await run(['body', '--state', state, '--repo', REPO])).result).toEqual(
      failure('--group-json requires a file'),
    )
    expect((await run(['body', '--state', state, '--group-json', group])).result).toEqual(
      failure('body requires --repo'),
    )
    expect(
      (await run(['body', '--state', fixture('nope.json'), '--group-json', group, '--repo', REPO]))
        .result,
    ).toEqual(failure(`--state: no such file: ${fixture('nope.json')}`))
  })
})

// ---------------------------------------------------------------------------
// the command line
// ---------------------------------------------------------------------------

describe('the command line', () => {
  it.each([
    ['no verb', [], 'usage: gh-security render-pr <commit-msg|body|labels|create> [options]'],
    [
      'an empty verb',
      [''],
      'usage: gh-security render-pr <commit-msg|body|labels|create> [options]',
    ],
    ['an unknown verb', ['frobnicate'], "render-pr: unknown subcommand 'frobnicate'"],
    [
      'a verb that is a built-in name',
      ['constructor'],
      "render-pr: unknown subcommand 'constructor'",
    ],
    [
      'an unknown option of commit-msg',
      ['commit-msg', '--bogus'],
      "commit-msg: unknown option '--bogus'",
    ],
    [
      'a flag of another verb',
      ['commit-msg', '--band', 'low'],
      "commit-msg: unknown option '--band'",
    ],
    [
      'a flag of another verb for labels',
      ['labels', '--head', 'x'],
      "labels: unknown option '--head'",
    ],
    ['a word that is no flag', ['create', 'x'], "create: unknown option 'x'"],
    ['a body flag in create', ['body', '--title', 't'], "body: unknown option '--title'"],
    ['a flag with no value', ['commit-msg', '--state'], '--state requires a value'],
    ['a flag with an empty value', ['commit-msg', '--state', ''], '--state requires a value'],
    ['an env prefix with no value', ['labels', '--env-prefix'], '--env-prefix requires a value'],
    ['a label with no value', ['labels', '--label'], '--label requires a value'],
  ])('refuses %s', async (_name, args, error) => {
    refused(await run(args), error)
  })

  it('takes the last of a repeated flag', async () => {
    const ran = await run([
      'commit-msg',
      '--repo',
      'a/b',
      '--state',
      fixture('state-scoped.json'),
      '--group-json',
      fixture('group.json'),
      '--repo',
      REPO,
    ])
    expect(ran.out).toContain('Refs: https://github.com/octo/app/security/dependabot/42\n')
  })

  it('is the handler that the registry loads, over the real client and runner', async () => {
    let out = ''
    const result = await renderPrCommand({
      args: [
        'commit-msg',
        '--state',
        fixture('state-scoped.json'),
        '--group-json',
        fixture('group.json'),
        '--repo',
        REPO,
      ],
      env: {},
      io: {
        stdout: (t) => {
          out += t
        },
        stderr: () => {},
        readStdin: () => '',
      },
      commandNames: [],
    })
    expect(result).toBeUndefined()
    expect(out).toBe(textOf('expected-commit-msg-scoped.txt'))
  })
})

// ---------------------------------------------------------------------------
// labels and create
// ---------------------------------------------------------------------------

interface Call {
  readonly command: string
  readonly args: readonly string[]
}

/** A runner that records each call, and answers from `reply`. */
const recording = (reply: (call: Call) => Partial<RunResult> = () => ({})) => {
  const calls: Call[] = []
  const spawn: Runner = async (command, args = []) => {
    const call = { command, args }
    calls.push(call)
    const given = reply(call)
    return {
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      combined: `${given.stdout ?? ''}${given.stderr ?? ''}`,
      timedOut: false,
      elapsedMs: 0,
      startFailure: null,
      streamErrors: [],
      ...given,
    }
  }
  return { calls, spawn }
}

const URL = 'https://github.com/octo/app/pull/99'

describe('labels', () => {
  const labels = (args: readonly string[], reply?: (call: Call) => Partial<RunResult>) => {
    const { calls, spawn } = recording(reply)
    return run(['labels', ...args], createGhClient, spawn).then((ran) => ({ ...ran, calls }))
  }
  const create = (name: string, color: string, description: string, repo = REPO): Call => ({
    command: 'gh',
    args: ['label', 'create', name, '--repo', repo, '--color', color, '--description', description],
  })

  it('makes security, dependencies and the band label, with the color and text of each', async () => {
    const ran = await labels(['--repo', REPO, '--band', 'low'])
    expect(ran.result).toEqual({
      outcome: 'ok',
      value: { status: 'ok', labels: ['security', 'dependencies', 'merge-risk:low'] },
    })
    expect(ran.calls).toEqual([
      create('security', 'D93F0B', 'Security fix'),
      create('dependencies', '0366d6', 'Pull requests that update a dependency file'),
      create('merge-risk:low', '2da44e', 'Low merge risk'),
    ])
    expect(ran.out).toBe('')
  })

  it.each([
    ['low', '2da44e', 'Low merge risk'],
    ['medium', 'd4a72c', 'Medium merge risk'],
    ['high', 'cf222e', 'High merge risk'],
    ['LOW', '2da44e', 'Low merge risk'],
    ['MeDiUm', 'd4a72c', 'Medium merge risk'],
  ])('uses the color and text of the band %s', async (band, color, description) => {
    const ran = await labels(['--repo', REPO, '--band', band])
    const name = `merge-risk:${band.toLowerCase()}`
    expect(ran.calls[2]).toEqual(create(name, color, description))
    expect(ran.result).toMatchObject({ value: { labels: ['security', 'dependencies', name] } })
  })

  it('makes each extra label with a neutral color, after the three, in the order given', async () => {
    const ran = await labels([
      '--repo',
      REPO,
      '--band',
      'low',
      '--label',
      'needs-review',
      '--label',
      'revisión 日本',
    ])
    expect(ran.calls.slice(3)).toEqual([
      create('needs-review', 'ededed', "Required by this repository's own conventions"),
      create('revisión 日本', 'ededed', "Required by this repository's own conventions"),
    ])
    expect(ran.result).toMatchObject({
      value: {
        labels: ['security', 'dependencies', 'merge-risk:low', 'needs-review', 'revisión 日本'],
      },
    })
  })

  it('treats a label that exists as made, and goes on', async () => {
    const ran = await labels(['--repo', REPO, '--band', 'medium'], () => ({
      status: 1,
      stderr: 'HTTP 422: Validation Failed: name already exists',
    }))
    expect(ran.result).toMatchObject({ outcome: 'ok' })
    expect(ran.calls).toHaveLength(3)
  })

  it.each([
    ['security', 'security'],
    ['dependencies', 'dependencies'],
    ['merge-risk:high', 'the band label'],
    ['needs-review', 'an extra label'],
  ])('stops at the first failure, and quotes gh: %s', async (name) => {
    const ran = await labels(
      ['--repo', REPO, '--band', 'high', '--label', 'needs-review'],
      (call) =>
        call.args[2] === name ? { status: 1, stderr: 'HTTP 403: Resource not accessible\n' } : {},
    )
    expect(ran.result).toEqual(
      failure(`gh label create ${name} failed: HTTP 403: Resource not accessible`),
    )
    expect(ran.calls.at(-1)?.args[2]).toBe(name)
  })

  it('names the exit status of a failure that has no stderr', async () => {
    const ran = await labels(['--repo', REPO, '--band', 'low'], () => ({
      status: 1,
      stdout: 'only on stdout',
    }))
    expect(ran.result).toEqual(failure('gh label create security failed: gh exited 1'))
  })

  it('rethrows what is not a failure of gh', async () => {
    const defect = new Error('a defect')
    const client = createGhMock({ createLabel: defect })
    await expect(run(['labels', '--repo', REPO, '--band', 'low'], () => client)).rejects.toBe(
      defect,
    )
  })

  it('turns a failure of the client into its detail', async () => {
    const client = createGhMock({ createLabel: ghFails('HTTP 403: nope') })
    expect((await run(['labels', '--repo', REPO, '--band', 'low'], () => client)).result).toEqual(
      failure('gh label create security failed: HTTP 403: nope'),
    )
  })

  it.each([
    ['no repo', ['--band', 'low'], 'labels requires --repo'],
    ['no repo and a bad band', ['--band', 'zzz'], 'labels requires --repo'],
    [
      'an unknown band',
      ['--repo', REPO, '--band', 'critical'],
      "labels: --band must be low, medium, or high, got 'critical'",
    ],
    ['no band', ['--repo', REPO], "labels: --band must be low, medium, or high, got ''"],
    [
      'a band that is a built-in name',
      ['--repo', REPO, '--band', 'constructor'],
      "labels: --band must be low, medium, or high, got 'constructor'",
    ],
    [
      'an unknown band that has a capital',
      ['--repo', REPO, '--band', 'Critical'],
      "labels: --band must be low, medium, or high, got 'Critical'",
    ],
  ])('refuses %s, and starts no child', async (_name, args, error) => {
    const ran = await labels(args)
    expect(ran.result).toEqual(failure(error))
    expect(ran.calls).toEqual([])
  })

  it('does not lower a letter that is not A to Z', async () => {
    const ran = await labels(['--repo', REPO, '--band', 'LOWİ'])
    expect(ran.result).toEqual(failure("labels: --band must be low, medium, or high, got 'LOWİ'"))
  })

  it('puts the env prefix and its words in front of each gh call', async () => {
    const ran = await labels([
      '--repo',
      REPO,
      '--band',
      'low',
      '--env-prefix',
      '  direnv   exec /w  ',
    ])
    expect(ran.calls.map((call) => call.command)).toEqual(['direnv', 'direnv', 'direnv'])
    expect(ran.calls[0]?.args).toEqual([
      'exec',
      '/w',
      'gh',
      'label',
      'create',
      'security',
      '--repo',
      REPO,
      '--color',
      'D93F0B',
      '--description',
      'Security fix',
    ])
  })

  it.each([[''], ['null'], ['   ']])('runs gh bare for the env prefix %j', async (prefix) => {
    const ran = await labels(['--repo', REPO, '--band', 'low', '--env-prefix', prefix])
    expect(ran.calls[0]?.command).toBe('gh')
  })

  it('gives the client the environment of the command', async () => {
    let seen: unknown
    await run(['labels', '--repo', REPO, '--band', 'low'], (options) => {
      seen = (options as { env?: unknown }).env
      return createGhMock({ createLabel: { created: true } })
    })
    expect(seen).toEqual({})
  })
})

describe('create', () => {
  const body = fixture('expected-body-scoped.md')
  const base = [
    '--repo',
    REPO,
    '--head',
    'fix/dependabot-lodash-4x',
    '--title',
    'fix(deps): resolve 2 Dependabot alert(s) for lodash 4.x',
    '--body-file',
    body,
    '--band',
    'low',
  ]
  const create = (args: readonly string[], reply?: (call: Call) => Partial<RunResult>) => {
    const { calls, spawn } = recording(reply ?? (() => ({ stdout: `${URL}\n` })))
    return run(['create', ...args], createGhClient, spawn).then((ran) => ({ ...ran, calls }))
  }

  it('opens the PR with the three labels, the title and the body file, and no draft flag', async () => {
    const ran = await create(base)
    expect(ran.result).toEqual({ outcome: 'ok', value: { status: 'ok', pr_url: URL } })
    expect(ran.calls).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'create',
          '--repo',
          REPO,
          '--head',
          'fix/dependabot-lodash-4x',
          '--label',
          'security',
          '--label',
          'dependencies',
          '--label',
          'merge-risk:low',
          '--title',
          'fix(deps): resolve 2 Dependabot alert(s) for lodash 4.x',
          '--body-file',
          body,
        ],
      },
    ])
    expect(ran.calls[0]?.args).not.toContain('--draft')
  })

  it.each([
    ['low', 'merge-risk:low'],
    ['medium', 'merge-risk:medium'],
    ['high', 'merge-risk:high'],
    ['HIGH', 'merge-risk:high'],
  ])('labels a PR of the band %s with %s', async (band, label) => {
    const ran = await create([...base.slice(0, -1), band])
    expect(ran.calls[0]?.args.slice(6, 12)).toEqual([
      '--label',
      'security',
      '--label',
      'dependencies',
      '--label',
      label,
    ])
  })

  it('puts each extra label after the three, and before the title', async () => {
    const ran = await create([...base, '--label', 'needs-review', '--label', 'breaking-change'])
    expect(ran.calls[0]?.args.slice(12, 16)).toEqual([
      '--label',
      'needs-review',
      '--label',
      'breaking-change',
    ])
    expect(ran.calls[0]?.args.slice(16, 18)).toEqual([
      '--title',
      'fix(deps): resolve 2 Dependabot alert(s) for lodash 4.x',
    ])
  })

  it('passes a title and a head that have non-ASCII text, a leading dash and a line break, as one word each', async () => {
    const ran = await create([
      '--repo',
      REPO,
      '--head',
      'fix/ünï-日本',
      '--title',
      '--x\nrésolu 🚀',
      '--body-file',
      body,
      '--band',
      'low',
    ])
    expect(ran.calls[0]?.args).toContain('fix/ünï-日本')
    expect(ran.calls[0]?.args).toContain('--x\nrésolu 🚀')
  })

  it('puts the env prefix in front of gh', async () => {
    const ran = await create([...base, '--env-prefix', 'direnv exec /w'])
    expect(ran.calls[0]?.command).toBe('direnv')
    expect(ran.calls[0]?.args.slice(0, 5)).toEqual(['exec', '/w', 'gh', 'pr', 'create'])
  })

  it('quotes gh for a failure, and reads no URL in it', async () => {
    const ran = await create(base, () => ({ status: 1, stderr: `a label does not exist ${URL}\n` }))
    expect(ran.result).toEqual(failure(`gh pr create failed: a label does not exist ${URL}`))
  })

  it('names the exit status of a failure that has no stderr', async () => {
    expect((await create(base, () => ({ status: 1, stdout: 'only on stdout' }))).result).toEqual(
      failure('gh pr create failed: gh exited 1'),
    )
  })

  it('fails for a success that has no URL, and shows what gh wrote', async () => {
    expect((await create(base, () => ({ stdout: 'done\n' }))).result).toEqual(
      failure('gh pr create failed: gh answered gh pr create with no pull request URL: done'),
    )
  })

  it('rethrows what is not a failure of gh', async () => {
    const defect = new Error('a defect')
    const client = createGhMock({ createPullRequest: defect })
    await expect(run(['create', ...base], () => client)).rejects.toBe(defect)
  })

  it('turns a failure of the client into its detail', async () => {
    const client = createGhMock({
      createPullRequest: new GhError('x', 1, { cause: 'x', detail: 'HTTP 422' }),
    })
    expect((await run(['create', ...base], () => client)).result).toEqual(
      failure('gh pr create failed: HTTP 422'),
    )
  })

  it.each([
    [
      'no repo',
      ['--head', 'h', '--title', 't', '--body-file', body, '--band', 'low'],
      'create requires --repo',
    ],
    [
      'no head',
      ['--repo', REPO, '--title', 't', '--body-file', body, '--band', 'low'],
      'create requires --head',
    ],
    [
      'no title',
      ['--repo', REPO, '--head', 'h', '--body-file', body, '--band', 'low'],
      'create requires --title',
    ],
    [
      'an empty title',
      ['--repo', REPO, '--head', 'h', '--title', '', '--body-file', body, '--band', 'low'],
      '--title requires a value',
    ],
    [
      'no body file',
      ['--repo', REPO, '--head', 'h', '--title', 't', '--band', 'low'],
      '--body-file requires a file',
    ],
    [
      'a body file that is missing',
      [
        '--repo',
        REPO,
        '--head',
        'h',
        '--title',
        't',
        '--body-file',
        fixture('nope.md'),
        '--band',
        'low',
      ],
      `--body-file: no such file: ${fixture('nope.md')}`,
    ],
    [
      'a body file that is a directory',
      ['--repo', REPO, '--head', 'h', '--title', 't', '--body-file', FX, '--band', 'low'],
      `--body-file: no such file: ${FX}`,
    ],
    [
      'no band',
      ['--repo', REPO, '--head', 'h', '--title', 't', '--body-file', body],
      "create: --band must be low, medium, or high, got ''",
    ],
    [
      'an unknown band',
      ['--repo', REPO, '--head', 'h', '--title', 't', '--body-file', body, '--band', 'critical'],
      "create: --band must be low, medium, or high, got 'critical'",
    ],
    [
      'a band that is a built-in name',
      ['--repo', REPO, '--head', 'h', '--title', 't', '--body-file', body, '--band', 'toString'],
      "create: --band must be low, medium, or high, got 'toString'",
    ],
  ])('refuses %s, and starts no child', async (_name, args, error) => {
    const ran = await create(args)
    expect(ran.result).toEqual(failure(error))
    expect(ran.calls).toEqual([])
  })

  it('asks for the repo before the head, the head before the title, and the title before the file', async () => {
    expect((await create(['--band', 'low'])).result).toEqual(failure('create requires --repo'))
    expect((await create(['--repo', REPO, '--band', 'low'])).result).toEqual(
      failure('create requires --head'),
    )
    expect((await create(['--repo', REPO, '--head', 'h', '--band', 'low'])).result).toEqual(
      failure('create requires --title'),
    )
    expect(
      (await create(['--repo', REPO, '--head', 'h', '--title', 't', '--band', 'nope'])).result,
    ).toEqual(failure('--body-file requires a file'))
  })
})
