// `fix-group cleanup`: the Cleanup of `agents/fix-dependency.md`, the port of
// `cmd_cleanup` in `scripts/common/fix-group.sh` (#234). The reap itself is
// `src/reap.ts`. This file reads the state, gives the reap its paths and the
// branch rule of the driver, and writes the report of the bash. The contract
// and each declared difference are in the header of `fix-group.ts`.
//
// This file ships. It imports nothing outside the plugin.

import type { CommandResult } from '../cli/command.ts'
import { failedReport } from '../cli/command.ts'
import { parseArguments } from '../lib/args.ts'
import { parseEnvPrefix } from '../lib/env-prefix.ts'
import { failed, type JsonObject, ok } from '../lib/envelope.ts'
import {
  type BranchReason,
  contain,
  type Reaped,
  reap,
  type WorkDirAction,
  type WorktreeAction,
} from '../reap.ts'
import { loadDriverState, readString } from '../state.ts'
import { type FixGroupDeps, runners } from './fix-group-common.ts'
import { onlyDriftCommit } from './fix-group-setup.ts'

/** The words of the bash for each action. A new action keeps its own word. */
const WORKTREE_WORDS: Readonly<Record<WorktreeAction, string>> = {
  absent: 'absent',
  removed: 'removed',
  failed: 'removal-failed',
  'stale-registration-removed': 'stale-registration-removed',
  'stale-registration': 'stale-registration',
  'not-a-worktree': 'not-a-worktree',
}

const WORK_DIR_WORDS: Readonly<Record<WorkDirAction, string>> = {
  absent: 'absent',
  removed: 'removed',
  failed: 'removal-failed',
  skipped: 'kept-registration-live',
  'not-a-directory': 'not-a-directory',
}

const LEFT =
  "left in place: the tip is not on origin and is not this flow's own leftover, and a commit " +
  'that never reached the remote is the one thing here that cannot be recreated'

/** The `reason` of the report for each reason of the reap. */
const reasonText = (reason: BranchReason, defaultBranch: string): string | null =>
  ({
    'no-local-branch': null,
    'tip-on-origin': 'pushed: the remote carries the same commits, so the local ref is a duplicate',
    'tip-on-default': `tip still equals origin/${defaultBranch}: there is nothing on the branch to lose`,
    'own-leftover':
      "the only commit is this flow's drift commit, which a rerun's control install regenerates " +
      'equivalently from the same manifests',
    'tip-read-failed':
      'left in place: a ref could not be read, so whether the tip is a duplicate of pushed work ' +
      'is unknown, and a branch is never deleted on an unknown',
    'delete-failed': 'left in place: git branch -D failed',
    'no-remote-tracking-ref': LEFT,
    'tip-not-on-origin': LEFT,
    'push-not-confirmed': LEFT,
  })[reason]

/**
 * The `detail` of the report: each error, in order, with the reason the work
 * directory stayed after a failed worktree step, and the tip of a branch
 * that stays.
 */
const detailOf = (reaped: Reaped): string | null => {
  const kept = reaped.work_dir.action === 'skipped'
  const parts = [
    ...reaped.errors.slice(0, kept ? 1 : 0),
    kept
      ? `${reaped.work} was left on disk: deleting it while the worktree registration survives ` +
        'is the state that blocks a later worktree add on this path and any branch -D of ' +
        `${reaped.branch}, and git worktree remove refuses to clean it up afterwards. Remove ` +
        'the registration first, by hand.'
      : null,
    ...reaped.errors.slice(kept ? 1 : 0),
    reaped.branch_ref.action === 'left' && reaped.branch_ref.local_tip !== null
      ? `branch ${reaped.branch} left in place at ${reaped.branch_ref.local_tip}`
      : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join('; ')
}

/** The cleanup phase. `args` are the words after `cleanup`. */
export const cleanup = async (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: FixGroupDeps,
): Promise<CommandResult> => {
  const parsed = parseArguments(args, {
    work: { type: 'string', default: '' },
    pushed: { type: 'boolean' },
  })
  if (parsed.outcome !== 'ok') return parsed
  const { work, pushed } = parsed.value
  if (work === '') return failed('cleanup: --work is required')
  const loaded = loadDriverState(work)
  if (loaded.outcome !== 'ok') return loaded
  const driver = loaded.value
  const recorded = readString(driver.state, 'work')
  if (recorded.outcome !== 'ok') return recorded
  const { git } = runners(deps.spawn, parseEnvPrefix(driver.envPrefix), env)
  const target = await contain(
    {
      repoRoot: driver.repoRoot,
      work,
      worktree: driver.worktree,
      branch: driver.branchName,
      recordedWork: recorded.value,
    },
    git,
  )
  if (target.outcome !== 'ok') return failed(`cleanup: ${target.error}`)
  const { defaultBranch } = driver
  const reaped = await reap(
    target.value,
    {
      pushed,
      defaultBranch,
      leftover: (run, at) => onlyDriftCommit(run, at.repoRoot, defaultBranch, at.branch),
    },
    git,
  )
  const detail = detailOf(reaped)
  const failure = reaped.errors.length > 0
  const report: JsonObject = {
    status: failure ? 'failure' : 'ok',
    step: 'cleanup',
    ...(failure ? { phase: 'worktree' } : {}),
    worktree_removed: reaped.worktree.action === 'removed',
    worktree: { path: reaped.worktree.path, action: WORKTREE_WORDS[reaped.worktree.action] },
    work_dir: { path: reaped.work_dir.path, action: WORK_DIR_WORDS[reaped.work_dir.action] },
    branch: reaped.branch,
    branch_deleted: reaped.branch_ref.action === 'deleted',
    branch_tip: reaped.branch_ref.local_tip,
    reason: reasonText(reaped.branch_ref.reason, defaultBranch),
    detail,
    errors: reaped.errors,
    left_behind: reaped.left_behind,
  }
  return failure ? failedReport(`fix-group: cleanup failure: ${detail}`, report, 3) : ok(report)
}
