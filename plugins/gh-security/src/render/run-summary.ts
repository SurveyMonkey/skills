// The Markdown of `summarize-run`: `resolve-alerts` SKILL.md phase 7 as a
// template (#229). The inputs are checked before they get here
// (`run-inputs.ts`). The contract, the order of the sections and each
// difference from the prose of phase 7 are in the header of
// `subcommands/summarize-run.ts`.
//
// Each line of a section goes through `inline`, and each table cell through
// `cell` (`markdown.ts`), so a line break or a pipe from input cannot split a
// line or end a cell.
//
// This file ships. It imports nothing outside the plugin.

import { cell, inline } from './markdown.ts'
import {
  type Cleanup,
  type Discovery,
  type Group,
  type Preflight,
  REQUIRES_MAJOR,
  type Report,
  type Result,
  SHARED_PARENT,
  type Skipped,
} from './run-inputs.ts'

/** How the summary reads one group. */
export type Kind = 'read' | 'null' | 'mispaired' | 'unparsable' | 'unknown'

/** One group of the batch, with its entry, its result and its report. */
export interface Row {
  readonly group: Group
  readonly repoRoot: string
  readonly kind: Kind
  /** The result, when `kind` is `read`. */
  readonly result: Result | null
  readonly report: Report
  /** The violations that the Workflow log gave for the group, or null. */
  readonly warning: string | null
}

export interface Summary {
  readonly rows: readonly Row[]
  readonly discovery: Discovery
  readonly preflights: readonly Preflight[]
  /** The entries that the Workflow returned, when it returned fewer than it dispatched. */
  readonly interrupted: { readonly returned: number; readonly dispatched: number } | null
}

/** The line of a group as phase 3 shows it: `6.x`, or no fix line. */
const lineText = (line: string): string => (line === 'none' ? '(no fix line)' : `${line}.x`)

/** A group in a sentence: `` `nx` 22.x in `octo/app` ``. */
const who = (group: Pick<Group, 'package' | 'line' | 'repo'>): string =>
  `\`${group.package}\` ${lineText(group.line)} in \`${group.repo}\``

const code = (text: string): string => `\`${text}\``

/** A section: its heading, then its lines. */
const sectionOf = (heading: string, lines: readonly string[]): string =>
  [`## ${heading}`, '', ...lines.map(inline)].join('\n')

// Section 1: every alert that stays open because its only fix crosses a major.

const stillVulnerable = (summary: Summary): string[] => {
  const after = summary.rows.flatMap((row) =>
    (row.result?.requiresMajorBump ?? []).map(
      (bump) =>
        `- \`${row.group.package}\` ${bump.version} in \`${row.group.repo}\` stays vulnerable ` +
        `(${bump.ranges.map(code).join(', ')}): the fix of the ${row.group.line}.x line did not ` +
        'reach this copy. No override bounded to the line of this copy can fix it. It needs a ' +
        'major bump of the parent that pins it, or the removal of that parent.',
    ),
  )
  const before = summary.discovery.skipped
    .filter((group) => group.reason === REQUIRES_MAJOR)
    .map(
      (group) =>
        `- ${who(group)} was skipped before dispatch: the installed majors are ` +
        `${group.majors.join(', ')}, and the fix line is ${group.line}.x. It needs a major bump ` +
        'of the parent that holds it, or the removal of that parent.',
    )
  return [...after, ...before]
}

// Section 2: the table of the batch.

const ACTION_NOTES: Readonly<Record<string, string>> = {
  'direct-update': 'direct update',
  'scoped-override': 'scoped override',
  'lockfile-refresh': 'lockfile refresh, no manifest edit',
}

/** The Notes label of a failure: its own label for the shapes phase 7 names. */
const failureLabel = (phase: string, detail: string): string => {
  if (phase === 'baseline')
    return 'baseline could not be established (ambient, affects every group)'
  if (phase === 'classify' && detail.includes('peer_only_dependency')) {
    return 'peer-only dependency'
  }
  if (
    phase === 'apply' &&
    (detail.includes('shared-parent shape') || detail.includes('pins a DIFFERENT major line'))
  ) {
    return 'shared parent, no reachable override'
  }
  if (phase === 'push' && detail.includes('directory file conflict')) {
    return 'branch-namespace collision (preflight miss)'
  }
  return `failure: ${phase}`
}

const NO_OP_NOTE = 'no-op: already fixed (see Already fixed)'

const KIND_NOTES: Readonly<Record<Exclude<Kind, 'read'>, string>> = {
  null: 'no result',
  mispaired: 'unknown: mispaired result',
  unparsable: 'result not read',
  unknown: 'unknown: no entry',
}

const notesOf = (row: Row): string => {
  const { result } = row
  const notes =
    result === null
      ? [KIND_NOTES[row.kind as Exclude<Kind, 'read'>]]
      : result.status === 'success'
        ? [
            ACTION_NOTES[result.action] ?? `bare override ${result.bareOverride}`,
            ...(result.cleanup === null
              ? []
              : ['shipped, and its cleanup did not finish (see Reap)']),
          ]
        : result.status === 'failure'
          ? [
              failureLabel(result.phase, result.detail),
              ...(result.prUrl === null ? [] : ['gh opened this pull request before the failure']),
            ]
          : [NO_OP_NOTE]
  if (row.warning !== null) notes.push(`unverified bookkeeping: ${row.warning}`)
  return notes.join('; ')
}

const tableOf = (summary: Summary): string[] => {
  const oneCheckout = summary.discovery.checkouts.length + summary.discovery.excluded.length === 1
  const head = ['Package', 'Line', 'PR', 'Risk', 'F4/F5', 'Notes']
  const columns = oneCheckout ? head : ['Repo', ...head]
  const rows = summary.rows.map((row) => {
    const { result } = row
    const risk = result?.status === 'success' ? result.risk : null
    const cells = [
      row.group.package,
      lineText(row.group.line),
      result?.prUrl ?? 'none',
      risk === null ? 'n/a' : `${risk.band} (${risk.score})`,
      risk === null ? 'n/a' : `${risk.f4}/${risk.f5}`,
      notesOf(row),
    ]
    return `| ${(oneCheckout ? cells : [row.group.repo, ...cells]).map(cell).join(' | ')} |`
  })
  return [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...rows]
}

// Section 3: the no-op groups, on their own lines.

const alreadyFixed = (summary: Summary): string[] => {
  const lines = summary.rows.flatMap((row) =>
    row.result?.status === 'no-op'
      ? [
          `- ${who(row.group)}: ${row.result.reason}.` +
            (row.result.mergedPrUrl === null
              ? ''
              : ` The fix merged in ${row.result.mergedPrUrl}.`),
        ]
      : [],
  )
  return lines.length === 0
    ? []
    : [
        ...lines,
        '',
        'Validate confirms that the installed versions clear these alerts. Dependabot has not ' +
          'scanned again yet, so the alerts can still show as open.',
      ]
}

// Section 4: the failures, with the phase and the detail of each.

const failures = (summary: Summary): string[] =>
  summary.rows.flatMap((row) => {
    const { result } = row
    if (result?.status === 'failure') {
      const opened =
        result.prUrl === null
          ? ''
          : ` gh opened the pull request ${result.prUrl} before the failure.`
      return [
        `- ${who(row.group)}: ${failureLabel(result.phase, result.detail)}. ${result.detail}${opened}`,
      ]
    }
    if (row.kind === 'null') {
      return [
        `- ${who(row.group)}: no result. The agent stopped, or gave no result that matched its schema.`,
      ]
    }
    if (row.kind === 'unparsable') {
      return [`- ${who(row.group)}: the result was not read: ${String(row.report.reason)}.`]
    }
    return []
  })

// Section 5: the groups with no result that names them.

const unknown = (summary: Summary): string[] => {
  const lines = summary.rows.flatMap((row) => {
    if (row.kind === 'mispaired') {
      return [
        `- ${who(row.group)}: unknown. Its result named another group, so it was not read. ` +
          'This is a defect of the dispatch workflow, not of the repository.',
      ]
    }
    return row.kind === 'unknown'
      ? [
          `- ${who(row.group)}: unknown. The workflow returned no entry for it. It can have ` +
            'opened a pull request that nothing here read.',
        ]
      : []
  })
  const { interrupted } = summary
  return interrupted === null
    ? lines
    : [
        `The run was interrupted: the workflow returned ${interrupted.returned} of ` +
          `${interrupted.dispatched} entries.`,
        '',
        ...lines,
      ]
}

// Section 6: the checkouts and repositories that the batch never touched.

const CAUSES: Readonly<Record<string, (probe: string) => string>> = {
  auth: (probe) =>
    `The probe of ${probe} got an auth failure (HTTP 401 or 403): the registry credentials ` +
    'are dead. Run the login flow of that registry.',
  'not-found': (probe) =>
    `The probe of ${probe} got not-found (HTTP 404): the registry that the probe reached has ` +
    'no such package. Check the scope routing.',
  network: (probe) =>
    `The probe of ${probe} failed with a network problem, such as a time limit, DNS or a reset.`,
  start: (probe) => `The package manager did not start for the probe of ${probe}.`,
  detect: () => 'The adapter could not detect the package manager.',
}

const excluded = (summary: Summary): string[] => {
  const { checkouts } = summary.discovery
  const checkoutLines = summary.discovery.excluded.map(
    (entry) =>
      `- ${code(entry.checkout)}: ${entry.reason}.` +
      (entry.stderr === '' ? '' : ` Output: ${entry.stderr}`),
  )
  const preflightLines = summary.preflights.map((entry) => {
    const nwo = (
      checkouts.find((checkout) => checkout.checkout === entry.checkout) as {
        nwo: string
      }
    ).nwo
    const cause =
      entry.error === null
        ? `${(CAUSES[entry.cause] as (probe: string) => string)(entry.probe === null ? 'the package' : code(entry.probe))}` +
          (entry.stderr === null || entry.stderr === '' ? '' : ` Output: ${entry.stderr}`)
        : `preflight-repo failed: ${entry.error}.`
    return (
      `- \`${nwo}\` (${code(entry.checkout)}): the registry preflight excluded each group of ` +
      `this repository. ${cause} The failure can be transient. A new run of the skill probes again.`
    )
  })
  return [...checkoutLines, ...preflightLines]
}

const flat = (summary: Summary): string[] =>
  summary.discovery.checkouts
    .filter((checkout) => checkout.flat)
    .map(
      (checkout) =>
        `- \`${checkout.nwo}\`: a remote branch named \`fix\` takes the \`fix/*\` ref namespace, ` +
        'so the pull requests of this repository come from `fix-dependabot-...` branches.',
    )

// Sections 7 and 8: the skips of phase 2.

const sharedParent = (summary: Summary): string[] =>
  summary.discovery.skipped
    .filter((group) => group.reason === SHARED_PARENT)
    .map(
      (group) =>
        `- ${who(group)}: the line shares the parents ${group.parents.map(code).join(', ')} ` +
        'with another major line, and no override key can scope them apart. Bump the shared ' +
        'parent past the old line, or remove the dependent that pins it.',
    )

const otherSkips = (summary: Summary): string[] =>
  summary.discovery.skipped
    .filter((group) => group.reason !== REQUIRES_MAJOR && group.reason !== SHARED_PARENT)
    .map((group: Skipped) => {
      const more =
        group.more === null
          ? ''
          : group.reason === 'open PR exists'
            ? ` (${group.more})`
            : `: ${group.more}`
      return `- ${who(group)}: ${group.reason}${more}.`
    })

// Section 9: what the reap removed and what it left.

/** One path ends with the other at a `/`: the same directory, resolved or not. */
const samePath = (a: string, b: string): boolean => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return `/${long}`.endsWith(`/${short.replace(/^\/+/, '')}`)
}

const deletedText = (deleted: boolean | null): string =>
  deleted === null ? '' : deleted ? ' (deleted)' : ' (not deleted)'

/** What the agent's own cleanup reported, less what `shown` already names. */
const cleanupText = (cleanup: Cleanup, shown: readonly string[]): string => {
  const items = [
    ['worktree', cleanup.worktree],
    ['work directory', cleanup.workDir],
  ] as const
  const parts = items
    .filter(([, artifact]) => !shown.includes(artifact.path))
    .map(([name, artifact]) => `${name} ${code(artifact.path)} (${artifact.action})`)
  if (!shown.includes(cleanup.branch)) {
    parts.push(`branch ${code(cleanup.branch)}${deletedText(cleanup.branchDeleted)}`)
  }
  const why = cleanup.why.join('; ')
  if (parts.length === 0) return why === '' ? '' : ` The agent's cleanup: ${why}.`
  return ` The agent's cleanup: ${parts.join(', ')}${why === '' ? '' : `: ${why}`}.`
}

/** The line of one report that left something, or carries errors or a cleanup. */
const reapLine = (row: Row): string | null => {
  const { report } = row
  const cleanup = row.result?.cleanup ?? null
  if (report.leftBehind.length === 0 && report.errors.length === 0 && cleanup === null) return null
  const shown: string[] = []
  const items = report.leftBehind.map((left) => {
    if (left === report.branch) {
      shown.push(cleanup?.branch === left ? left : '')
      return `branch ${code(left)}`
    }
    const match = [cleanup?.worktree, cleanup?.workDir].find(
      (artifact) => artifact !== undefined && samePath(artifact.path, left),
    )
    if (match === undefined) return code(left)
    shown.push(match.path)
    return `${code(match.path)} (${match.action} in the agent's cleanup)`
  })
  const shipped =
    row.result?.status === 'success' && cleanup !== null
      ? ` shipped ${row.result.prUrl}, and its own cleanup did not finish`
      : ''
  const state =
    items.length > 0
      ? `left on disk: ${items.join(', ')}.` +
        (report.reason === null ? '' : ` Not reaped: ${report.reason}.`)
      : cleanup !== null && report.reaped
        ? 'the reap cleared what the agent could not.'
        : 'nothing is left on disk.'
  const errors = report.errors.length === 0 ? '' : ` Errors: ${report.errors.join('; ')}.`
  return `- ${who(row.group)}${shipped}: ${state}${errors}${cleanup === null ? '' : cleanupText(cleanup, shown)}`
}

const reapSection = (summary: Summary): string[] => {
  const total = summary.rows.length
  const clean = summary.rows.filter((row) => row.report.leftBehind.length === 0).length
  const lines = summary.rows.map(reapLine).filter((line): line is string => line !== null)
  const head =
    `${clean} of ${total} groups came back with an empty \`left_behind\`` +
    (clean === total ? ': nothing was left behind.' : '.')
  const hint =
    clean === total
      ? []
      : [
          '',
          'A leftover under `.claude/worktrees/` comes off by hand with ' +
            '`git -C <repo_root> worktree remove --force <path>` when no agent is in flight.',
        ]
  return [head, ...(lines.length === 0 ? [] : ['', ...lines]), ...hint]
}

// Section 10: the observations, deduplicated and split by type.

const observations = (summary: Summary): string[] => {
  const seen = new Set<string>()
  const found: { readonly row: Row; readonly observation: Result['observations'][number] }[] = []
  for (const row of summary.rows) {
    for (const observation of row.result?.observations ?? []) {
      const id = `${row.group.repo}\n${observation.canonical}`
      if (seen.has(id)) continue
      seen.add(id)
      found.push({ row, observation })
    }
  }
  const added = found.filter(({ observation }) => observation.type === 'unscoped_override_added')
  const addedLines =
    added.length === 0
      ? []
      : [
          `This batch added ${added.length} unscoped global override(s):`,
          '',
          ...added.map(({ row, observation }) => {
            const key = code(String(observation.key))
            return (
              `- ${key} ${code(String(observation.range))} in \`${row.group.repo}\` ` +
              `(${row.result?.prUrl ?? 'no pull request'}), because ${String(observation.reason)}. ` +
              `It pins ${key} for every consumer in that repository, including copies that were never vulnerable.`
            )
          }),
          '',
        ]
  const repos = [...new Set(found.map(({ row }) => row.group.repo))]
  const notes = repos.flatMap((repo) => {
    const keys = [
      ...new Set(
        found
          .filter(
            ({ row, observation }) =>
              row.group.repo === repo && observation.type === 'unscoped_override',
          )
          .map(({ observation }) => String(observation.key)),
      ),
    ]
    return keys.length === 0
      ? []
      : [
          `- Note: \`${repo}\` contains ${keys.length} unscoped global override(s): ` +
            `${keys.map(code).join(', ')}. These may be removable or convertible to scoped pins. ` +
            '`/gh-security:audit-pins` tests removability.',
        ]
  })
  const others = found.filter(
    ({ observation }) =>
      observation.type !== 'unscoped_override_added' && observation.type !== 'unscoped_override',
  )
  const otherLines = [
    ...new Set(others.map(({ row, observation }) => `${observation.type}\n${row.group.repo}`)),
  ].map((id) => {
    const [type, repo] = id.split('\n') as [string, string]
    const count = others.filter(
      ({ row, observation }) => observation.type === type && row.group.repo === repo,
    ).length
    return `- ${code(type)} in \`${repo}\`: ${count} observation(s).`
  })
  const lines = [...addedLines, ...notes, ...otherLines]
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

/** The whole summary. A section with nothing to say is left out, except the table and the reap. */
export const renderSummary = (summary: Summary): string => {
  const sections: [string, string[]][] = [
    ['Still vulnerable after this batch', stillVulnerable(summary)],
    ['Groups', tableOf(summary)],
    ['Already fixed', alreadyFixed(summary)],
    ['Failures', failures(summary)],
    ['Unknown groups', unknown(summary)],
    ['Excluded checkouts and repositories', excluded(summary)],
    ['Flat branch scheme', flat(summary)],
    ['Shared-parent skips', sharedParent(summary)],
    ['Other skips', otherSkips(summary)],
    ['Reap', reapSection(summary)],
    ['Observations', observations(summary)],
  ]
  return `${sections
    .filter(([, lines]) => lines.length > 0)
    .map(([heading, lines]) => sectionOf(heading, lines))
    .join('\n\n')}\n`
}
