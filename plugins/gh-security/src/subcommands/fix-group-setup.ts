// `fix-group setup`: phase 1, the port of `cmd_setup` in
// `scripts/common/fix-group.sh`. It checks the group, makes the work
// directory and its worktree on a new branch, and writes the state file. The
// contract and each declared difference are in the header of `fix-group.ts`.
//
// This file ships. It imports nothing outside the plugin.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CommandResult } from '../cli/command.ts'
import { tostring } from '../jq.ts'
import { parseArguments } from '../lib/args.ts'
import { parseEnvPrefix } from '../lib/env-prefix.ts'
import { failed, type JsonObject, type JsonValue, ok } from '../lib/envelope.ts'
import { createState } from '../state.ts'
import {
  chomp,
  DRIFT_SUBJECT,
  driftPathAllowed,
  type FixGroupDeps,
  failPhase,
  type Git,
  outputOf,
  runners,
} from './fix-group-common.ts'

/** The scorer that `score` runs when `--scorer` does not name one: the bash one, until #233. */
export const DEFAULT_SCORER = fileURLToPath(
  new URL('../../scripts/common/score-merge-risk.sh', import.meta.url),
)

/**
 * The keys a group must carry, in the order of the bash, then `ecosystem`,
 * which only the port requires.
 */
const REQUIRED = [
  'package',
  'major_line',
  'branch_name',
  'highest_fixed_version',
  'alerts',
  'ecosystem',
] as const

/** Not a string, or the empty string: jq's `blank_string` of the bash. */
const blank = (value: JsonValue | undefined): boolean => typeof value !== 'string' || value === ''

/** The keys of a group that carry no usable value, in the order of the bash, then `ecosystem`. */
const unusable = (group: JsonObject): string[] =>
  [
    blank(group.package) && 'package',
    typeof group.major_line !== 'number' && blank(group.major_line) && 'major_line',
    blank(group.branch_name) && 'branch_name',
    blank(group.highest_fixed_version) && 'highest_fixed_version',
    (!Array.isArray(group.alerts) || group.alerts.length === 0) && 'alerts',
    blank(group.ecosystem) && 'ecosystem',
  ].filter((key): key is string => key !== false)

/** Read and check the group file. The text of the failure is the bash `die`. */
const readGroup = (file: string): { readonly group: JsonObject } | { readonly error: string } => {
  let group: unknown
  try {
    group = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { error: 'setup: --group-json is not readable JSON' }
  }
  if (typeof group !== 'object' || group === null || Array.isArray(group)) {
    return { error: 'setup: --group-json is not a JSON object' }
  }
  const object = group as JsonObject
  const missing = REQUIRED.filter((key) => !Object.hasOwn(object, key))
  if (missing.length > 0) {
    return { error: `setup: the group payload is missing: ${missing.join(', ')}` }
  }
  const bad = unusable(object)
  if (bad.length > 0) {
    return { error: `setup: the group payload carries no usable value for: ${bad.join(', ')}` }
  }
  // `major_line` goes into a regex that selects the line of this group out
  // of the lockfile. Anything but digits is a pattern that matches lines
  // this group does not own.
  const line = tostring(object.major_line)
  if (!/^[0-9]+$/.test(line)) {
    return {
      error:
        `setup: major_line '${line}' is not a number. It is interpolated into a regex that ` +
        "selects this group's line out of the lockfile, so anything else is a pattern matching " +
        'lines this group does not own.',
    }
  }
  return { group: object }
}

/** The text of a failed fetch that says the remote has no such branch. */
const NO_REMOTE_REF = /couldn't find remote ref/i

/**
 * The stale-branch guard. A local branch of the name is deleted only when it
 * is this flow's own leftover. The answer is null when the branch is gone or
 * was never there, or the failure of the phase.
 */
const clearStaleBranch = async (
  git: Git,
  repoRoot: string,
  defaultBranch: string,
  branch: string,
): Promise<CommandResult | null> => {
  const fetched = await git(repoRoot, ['fetch', 'origin', defaultBranch])
  if (fetched.status !== 0) {
    return failPhase('worktree', `git fetch origin ${defaultBranch} failed: ${outputOf(fetched)}`)
  }
  // No remote branch of the name is the usual case. A fetch that failed for
  // another reason leaves `origin/<branch>` old, and the guard below must
  // not judge a local branch against an old ref.
  const branchFetch = await git(repoRoot, ['fetch', 'origin', branch])
  if (branchFetch.status !== 0 && !NO_REMOTE_REF.test(outputOf(branchFetch))) {
    return failPhase(
      'worktree',
      `git fetch origin ${branch} failed, so origin/${branch} may be stale and cannot be used ` +
        `to judge whether a local branch of that name is a duplicate of pushed work: ${outputOf(branchFetch)}`,
    )
  }
  const listed = await git(repoRoot, ['branch', '--list', branch])
  if (listed.status !== 0) {
    return failPhase('worktree', `git branch --list ${branch} failed: ${outputOf(listed)}`)
  }
  const base = await git(repoRoot, ['rev-parse', `origin/${defaultBranch}`])
  if (base.status !== 0) {
    return failPhase('worktree', `git rev-parse origin/${defaultBranch} failed: ${outputOf(base)}`)
  }
  if (outputOf(listed) === '') return null
  const dflt = outputOf(base)
  const tipRead = await git(repoRoot, ['rev-parse', branch])
  if (tipRead.status !== 0) {
    return failPhase('worktree', `git rev-parse ${branch} failed: ${outputOf(tipRead)}`)
  }
  const tip = outputOf(tipRead)
  const remoteRead = await git(repoRoot, ['rev-parse', `origin/${branch}`])
  const remote = remoteRead.status === 0 ? chomp(remoteRead.stdout) : ''

  let reason: string | null = null
  if (tip === dflt) {
    reason = `tip equals origin/${defaultBranch}: a previous run created the branch and committed nothing to it`
  } else if (remote !== '' && tip === remote) {
    reason = `tip equals origin/${branch}: a previous run pushed it and the remote still carries the same commits`
  } else if (await onlyDriftCommit(git, repoRoot, defaultBranch, branch)) {
    reason = `the only commit beyond origin/${defaultBranch} is this flow's drift commit, over the lockfile and tracked install artifacts alone`
  }
  if (reason === null) {
    return failPhase(
      'worktree',
      `the local branch ${branch} is not this flow's own leftover, so it may hold unpushed work. ` +
        `Inspect it before rerunning; it was not deleted. tip=${tip} origin/${defaultBranch}=${dflt} ` +
        `origin/${branch}=${remote === '' ? '<none>' : remote}`,
    )
  }
  const deleted = await git(repoRoot, ['branch', '-D', branch])
  if (deleted.status !== 0) {
    return failPhase('worktree', `git branch -D ${branch} failed (${reason}): ${outputOf(deleted)}`)
  }
  return null
}

/**
 * The third tip that the guard knows: one commit with the drift subject, over
 * the drift paths alone. Both checks, never one of them (#152). A read that
 * fails gives no subject or no path, so the answer is no.
 */
const onlyDriftCommit = async (
  git: Git,
  repoRoot: string,
  defaultBranch: string,
  branch: string,
): Promise<boolean> => {
  const log = await git(repoRoot, ['log', '--format=%s', `origin/${defaultBranch}..${branch}`])
  const subjects = chomp(log.stdout)
  if (subjects !== DRIFT_SUBJECT) return false
  const diff = await git(repoRoot, ['diff', '--name-only', `origin/${defaultBranch}`, branch])
  const names = chomp(diff.stdout)
    .split('\n')
    .filter((name) => name !== '')
  return names.length > 0 && names.every(driftPathAllowed)
}

/** The setup phase. `args` are the words after `setup`. */
export const setup = async (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: FixGroupDeps,
): Promise<CommandResult> => {
  const parsed = parseArguments(args, {
    'group-json': { type: 'string', default: '' },
    'repo-root': { type: 'string', default: '' },
    'default-branch': { type: 'string', default: '' },
    'env-prefix': { type: 'string', default: '' },
    scorer: { type: 'string', default: '' },
  })
  if (parsed.outcome !== 'ok') return parsed
  const options = parsed.value
  for (const name of ['group-json', 'repo-root', 'default-branch'] as const) {
    if (options[name] === '') return failed(`setup requires --${name}`)
  }
  const groupFile = options['group-json']
  const repoRoot = options['repo-root']
  const defaultBranch = options['default-branch']
  if (!statSync(groupFile, { throwIfNoEntry: false })?.isFile()) {
    return failed(`setup: no such group file: ${groupFile}`)
  }
  if (!statSync(repoRoot, { throwIfNoEntry: false })?.isDirectory()) {
    return failed(`setup: no such repo root: ${repoRoot}`)
  }
  const scorer = options.scorer === '' ? DEFAULT_SCORER : options.scorer

  const read = readGroup(groupFile)
  if ('error' in read) return failed(read.error)
  const group = read.group
  const ecosystem = group.ecosystem as string
  const route = deps.route(ecosystem)
  if (!route.supported) {
    return failed(`setup: the group's ecosystem '${ecosystem}' has no adapter: ${route.reason}`)
  }
  const pkg = group.package as string
  const majorLine = tostring(group.major_line)
  const branch = group.branch_name as string

  // The `/` goes to `-`. A scoped name kept as it is makes a directory level,
  // and the reap, given the leaf, leaves that level behind (#161).
  const packagePath = pkg.replaceAll('/', '-')
  const work = `${repoRoot}/.claude/worktrees/fix-dependabot-${packagePath}-${majorLine}x`
  const worktree = `${work}/fix`
  const { git } = runners(deps.spawn, parseEnvPrefix(options['env-prefix']), env)

  // 1. The guard for a crashed run. A work directory that is there is a
  //    failed or crashed run, or not this flow at all. It is not ours to clear.
  if (existsSync(work)) {
    return failPhase(
      'worktree',
      `a previous run's workspace already exists at ${work}. A run that completed removes it, ` +
        "so this is a crashed or failed run's leftover. Inspect it, then remove it by hand: " +
        `git -C ${repoRoot} worktree remove --force ${worktree}, then delete the directory. ` +
        'Never reuse or silently delete it.',
    )
  }

  // 2. The stale-branch guard. It checks, and does not stop on sight: a stop
  //    for each local branch blocked the flow on its own leftovers (#84).
  const stale = await clearStaleBranch(git, repoRoot, defaultBranch, branch)
  if (stale !== null) return stale

  const parent = join(repoRoot, '.claude', 'worktrees')
  try {
    mkdirSync(parent, { recursive: true })
  } catch (error) {
    return failPhase('worktree', `cannot create ${repoRoot}/.claude/worktrees: ${String(error)}`)
  }
  const added = await git(repoRoot, [
    'worktree',
    'add',
    worktree,
    '-b',
    branch,
    `origin/${defaultBranch}`,
  ])
  if (added.status !== 0) {
    return failPhase('worktree', `git worktree add ${worktree} failed: ${outputOf(added)}`)
  }

  const created = createState(work, {
    group,
    repo_root: repoRoot,
    default_branch: defaultBranch,
    adapter: route.name,
    ecosystem,
    scorer,
    env_prefix: options['env-prefix'],
    work,
    worktree,
    branch_name: branch,
    package: pkg,
    package_path: packagePath,
    major_line: majorLine,
    drift_commit: false,
    fix_installs: 0,
    install_signals: [],
  })
  if (created.outcome !== 'ok') return failed(`setup: ${created.error}`)
  return ok({
    status: 'ok',
    step: 'setup',
    work,
    worktree,
    branch,
    package: pkg,
    major_line: majorLine,
  })
}
