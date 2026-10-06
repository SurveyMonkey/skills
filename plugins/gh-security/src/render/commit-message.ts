// The commit message of one fix group (#233): the port of `commit-msg` of
// `render-pr.sh`. It is a template over the inputs that `pr-inputs.ts` read.
// It makes no decision, and fails for no input: every check is already done.
//
// This file ships. It imports nothing outside the plugin.

import { inline } from './markdown.ts'
import type { CommitInputs } from './pr-inputs.ts'

/** The message: a subject, the fix, the alerts, and one `Refs:` trailer for each. */
export const commitMessage = (inputs: CommitInputs, repo: string): string => {
  const alerts = inputs.alerts.map(
    (alert) => `- #${alert.number}: ${inline(alert.id)} (${inline(alert.severity)})`,
  )
  const refs = inputs.alerts.map(
    (alert) => `Refs: https://github.com/${repo}/security/dependabot/${alert.number}`,
  )
  return [
    `fix(deps): resolve ${inputs.alerts.length} Dependabot alert(s) for ${inputs.package} ${inputs.majorLine}.x`,
    '',
    `${inputs.kind} to >=${inputs.highestFixedVersion} via ${inputs.location}.`,
    '',
    'Alerts resolved:',
    ...alerts,
    '',
    ...refs,
    '',
  ].join('\n')
}
