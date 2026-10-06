// The PR body of one fix group (#233): the port of `body` of `render-pr.sh`.
// It is a template over the inputs that `pr-inputs.ts` read. Each section is
// one function, and the body is the sections in order. It makes no decision
// that the inputs did not already settle, and it fails for no input.
//
// Every value that comes from input reaches a line through `shown`, a table
// cell through `cell`, and a code block through `fence` (`markdown.ts`).
//
// Declared differences from the script, each with #233:
//   - A table cell is escaped for Markdown. The script escaped a pipe, and
//     the tsv step then doubled its backslash, which left a cell that a pipe
//     ended. A tab in a cell stays a tab, where the script printed `\t`.
//   - A code block has a fence longer than any run of backticks in it.
//   - A line break in a value of a line is one space.
//   - The `written` block has the key order of JavaScript: a key that is a
//     whole number goes first.
//
// This file ships. It imports nothing outside the plugin.

import { cell, DASH, fence, percent, shown } from './markdown.ts'
import type { Action, BodyAlert, BodyInputs, Bump, GlobalOverride, Move } from './pr-inputs.ts'

const VERBS: Readonly<Record<Action, string>> = {
  'direct-update': 'updating the direct dependency',
  'scoped-override': 'adding scoped overrides',
  'bare-override': 'adding an unscoped override',
  'lockfile-refresh': 'refreshing the lockfile',
}

const summary = (inputs: BodyInputs): string[] => [
  '## Summary',
  '',
  `- Resolves ${inputs.alerts.length} Dependabot alert(s) for \`${inputs.package}\` in the ${inputs.majorLine}.x line by ${VERBS[inputs.action]}`,
  `- Target version: >=${inputs.highestFixedVersion}`,
  `- Resolved version: ${inputs.resolvedVersion}`,
  '- Other major lines of this package, if any, are fixed by their own PRs',
  '',
]

const alertRow = (alert: BodyAlert, repo: string): string =>
  `| [#${alert.number}](https://github.com/${repo}/security/dependabot/${alert.number}) | ${cell(alert.id)} | ${cell(alert.severity)} | ${percent(alert.epss)}% | ${cell(alert.summary)} |`

const alertsResolved = (inputs: BodyInputs, repo: string): string[] => [
  '## Alerts resolved',
  '',
  '| # | CVE | Severity | EPSS | Summary |',
  '|---|---|---|---|---|',
  ...inputs.alerts.map((alert) => alertRow(alert, repo)),
  '',
]

/** The scorer's Markdown goes in as it is. Its own final line feed, the one that ends this line, and a blank line follow. */
const mergeRisk = (inputs: BodyInputs): string[] => [inputs.riskMarkdown, '']

const dependencyChain = (inputs: BodyInputs): string[] => {
  const marks = fence(inputs.whyRaw)
  return ['## Dependency chain', '', marks, inputs.whyRaw, marks, '']
}

/** The sentence of a lockfile refresh, which names the version before the fix when there was one. */
const refreshSentence = (inputs: BodyInputs): string =>
  inputs.before === null
    ? `The fix is a no-change lockfile refresh: the manifest already admits the fixed version, and the committed lockfile had no comparable version on the ${inputs.majorLine}.x line before this change. Re-resolving it against the unchanged manifests resolves it to \`${inputs.resolvedVersion}\`.`
    : `The fix is a no-change lockfile refresh: the manifest already admits the fixed version, but the committed lockfile pinned \`${inputs.before}\` on the ${inputs.majorLine}.x line. Re-resolving it against the unchanged manifests moves it to \`${inputs.resolvedVersion}\`.`

const changes = (inputs: BodyInputs): string[] => {
  if (inputs.action === 'lockfile-refresh') return ['## Changes', '', refreshSentence(inputs), '']
  const written = JSON.stringify(inputs.written, null, 2)
  const marks = fence(written)
  return [
    '## Changes',
    '',
    `${marks}json`,
    written,
    marks,
    '',
    ...(inputs.overrideFile === 'pnpm-workspace.yaml'
      ? [
          'The override lives in `pnpm-workspace.yaml`; the block above quotes the entries `apply_constraint` wrote even though the file itself is YAML.',
          '',
        ]
      : []),
    ...(inputs.drift
      ? [
          `The first commit is a no-change lockfile refresh ${DASH} the default branch's lockfile is stale relative to its manifests, so any install re-resolves these entries; the second commit is the fix.`,
          '',
        ]
      : []),
  ]
}

const globalOverride = (inputs: BodyInputs, override: GlobalOverride): string[] => {
  const tried = shown(override.appliedParents.join(', '))
  const survived = shown(override.resolvedVersions.join(', '))
  return [
    '## Global override',
    '',
    `${override.verb} an unscoped override \`${inputs.package}: "${override.range}"\`.` +
      (tried === '' ? '' : ` Scoped entries were tried on: ${tried}.`) +
      (survived === '' ? '' : ` Resolved copies after the fix: ${survived}.`),
    '',
    `${override.note}\n`,
  ]
}

/** The name of the parent in the path of a copy, or null when the path names none. */
const bareName = (key: string): string => {
  const at = key.lastIndexOf('@')
  return at <= 0 ? key : key.slice(0, at)
}

/**
 * The package that holds the copy: only an npm install path names it, as the
 * segment before the last `node_modules`, and with its `@scope` when it has
 * one. A pnpm or Yarn Berry path names the copy and no parent, and none is
 * invented.
 */
const parentOf = (path: string): string | null => {
  const segments = path.split('/')
  const last = segments.lastIndexOf('node_modules')
  if (last <= 0) return null
  const name = segments[last - 1] as string
  const scope = last >= 2 ? (segments[last - 2] as string) : ''
  return bareName(scope.startsWith('@') ? `${scope}/${name}` : name)
}

const bumpRow = (bump: Bump, alerts: readonly BodyAlert[]): string => {
  const open = alerts
    .filter((alert) => bump.ranges.includes(alert.vulnerableRange ?? ''))
    .map((alert) => alert.ghsaFirst)
    .join(', ')
  const parent = parentOf(bump.path)
  const remedy =
    parent === null
      ? 'needs a major bump of the dependent that pins it (not derivable from this report) or dropping it'
      : `needs a major bump of \`${parent}\` or dropping it`
  const alertsOpen = open === '' ? "(no alert's vulnerable_range matched this entry)" : open
  return `| ${cell(bump.version)} | ${cell(alertsOpen)} | ${cell(`no patched release in the ${bump.major}.x line; ${remedy}`)} |`
}

const notFixed = (inputs: BodyInputs): string[] =>
  inputs.bumps.length === 0
    ? []
    : [
        '## Not fixed by this PR',
        '',
        '| Version | Alerts still open | Remediation |',
        '|---|---|---|',
        ...inputs.bumps.map((bump) => bumpRow(bump, inputs.alerts)),
        '',
      ]

const moveRow = (move: Move): string =>
  `| ${cell(move.major)}.x | ${cell(move.before.join(', '))} | ${cell(move.after.length === 0 ? '(gone)' : move.after.join(', '))} |`

const collateral = (inputs: BodyInputs): string[] => {
  const { moves } = inputs
  if (moves.kind === 'clean') return []
  const head = ['## Collateral', '']
  if (moves.kind === 'no-baseline') {
    return [
      ...head,
      `No baseline was available to check other major lines of \`${inputs.package}\` against, so this PR makes no claim about them.`,
      '',
    ]
  }
  const table = ['| Line | Before | After |', '|---|---|---|', ...moves.moves.map(moveRow), '']
  return moves.kind === 'benign'
    ? [
        ...head,
        ...table,
        'These are within-major dedups by the package manager onto a version each line already resolved before this change, and none of these lines carries an open Dependabot alert.',
        '',
      ]
    : [...head, ...table, `${inputs.collateralNote}\n`]
}

const verification = (inputs: BodyInputs): string[] => [
  '## Verification',
  '',
  `- [x] Lockfile validated: ${inputs.checked} resolved version(s) in the ${inputs.majorLine}.x line satisfy`,
  `      \`>=${inputs.highestFixedVersion} <${BigInt(inputs.majorLine) + 1n}\`, and no resolved copy still matches any alert's vulnerable range`,
  ...(inputs.moves.kind === 'clean'
    ? [
        `- [x] No collateral: every copy of \`${inputs.package}\` on the other major lines resolves exactly as it did`,
        '      before this change (`other_line_moves: []`, against the baseline recorded after a no-change',
        '      control install, so the comparison excludes stale-lockfile drift and measures only this',
        '      change)',
      ]
    : []),
  '- CI on this PR is the verifier; coverage and CI presence are scored above',
  '',
]

const references = (inputs: BodyInputs, repo: string): string[] => [
  '## References',
  '',
  ...inputs.alerts.map(
    (alert) => `- https://github.com/${repo}/security/dependabot/${alert.number}`,
  ),
]

/** The whole body: each section in order, and a line feed at the end. */
export const prBody = (inputs: BodyInputs, repo: string): string =>
  [
    ...summary(inputs),
    ...alertsResolved(inputs, repo),
    ...mergeRisk(inputs),
    ...dependencyChain(inputs),
    ...changes(inputs),
    ...(inputs.globalOverride === null ? [] : globalOverride(inputs, inputs.globalOverride)),
    ...notFixed(inputs),
    ...collateral(inputs),
    ...verification(inputs),
    ...references(inputs, repo),
    '',
  ].join('\n')
