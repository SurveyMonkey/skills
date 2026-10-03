// Parity for `apply_constraint` against node.sh (RFC 002, "Parity is the
// migration strategy"), #222 layer 2. Each example runs the verb of node.sh
// and `node.applyConstraint` on one input. Then it compares three things:
//
//   - the outcome, and the refusal text of a refusal;
//   - the JSON answer of a success;
//   - the bytes of every file in the tree after the call.
//
// The third check is the main one. A write verb gives its result as the
// tree: package.json, pnpm-workspace.yaml and the npm lockfile.
//
// Both sides run in the same directory, one after the other. A pristine copy
// restores the tree between the two runs. So a refusal that names a path
// names the same path on each side.
//
// The directory is a scratch copy of a fixture. `fakeLinkedWorktree` gives it
// the `.git` pointer file of a linked worktree. It also makes a real gitdir
// beside it, with a `commondir` file. The guard of each side reads these
// files and runs no git. Only the TypeScript guard reads `commondir` (#304
// item 1). A second describe runs the guard cases in real repositories that
// harness/git.ts builds.
//
// Three kinds of case run:
//
//   - SPEC_CASES: each example of spec/node_apply_constraint_spec.sh that
//     runs the verb. Each has the setup of its example, copied from the spec
//     as shell text, and the argument list of the example.
//   - Generated cases: for each package of each fixture, a direct call, a
//     call scoped to its parents, and a `--tighten-bare` call.
//   - Odd cases: arguments and file formats that no spec example uses.
//
// The TypeScript side gets the same argument list, read into the typed
// request by `requestOf`. That function reads the list as
// `verb_apply_constraint` does: `--tighten-bare` only in the first place.
//
// Declared out, each with its reason:
//
//   - `yarn-vendored`: the spec uses it for a `shim` example only.
//   - The examples that run `detect`, `list_pins`, `validate` or
//     `resolved_versions` without `apply_constraint`. Other parity files
//     cover those verbs.
//
// Declared exception (#50, ruling 2), a case of its own below: a pnpm parent
// with a git copy beside two registry copies. bash writes keys qualified by
// the registry versions, which miss the git copy. The port refuses, and
// writes nothing. Beside one registry copy, both sides write the plain key.
// That is true for a git URL with an `@`. For another copy from outside the
// registry, such as a `git+https` URL, bash keeps the edge. Beside two
// registry copies, the port refuses it in the same way. Beside one registry
// copy, the port writes the plain key, and bash writes a qualified key for
// each copy. Where a copy has the package on another major line, the port
// refuses the plain key too (#50). No fixture has such a copy as a parent,
// so the unit tests hold these cases.
//
// Declared divergence in the exit status, as in parity-node.test.ts: where
// jq itself stops, bash exits 5. The TypeScript side answers `failed`. There
// the check is the refusal alone.
import { execFile } from 'node:child_process'
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  ApplyConstraintAnswer,
  ConstraintRequest,
  Tree,
} from '#gh-security/adapters/adapter.ts'
import type { NodeDetection } from '#gh-security/adapters/node/detect.ts'
import { node } from '#gh-security/adapters/node.ts'
import {
  type Envelope,
  exitCodeFor,
  type Failure,
  type JsonValue,
  renderJson,
} from '#gh-security/lib/envelope.ts'
import { FIXTURES_ROOT, fakeLinkedWorktree } from '#harness/fixtures.ts'
import { createGitFixtures } from '#harness/git.ts'
import { type BashResult, firstDifference, runBash } from '#harness/parity.ts'
import { pluginFile, ROOT } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'

const ADAPTER = pluginFile('gh-security', 'scripts', 'ecosystems', 'node.sh')

const SPEC = join(ROOT, 'spec', 'node_apply_constraint_spec.sh')

const ENV = { PATH: process.env.PATH }

/** The status jq exits with when its program stops with an error. */
const JQ_ERROR = 5

/** The time limit of the TypeScript side of one example. */
const CASE_TIMEOUT_MS = 60_000

/** The fixtures of the spec that no `apply_constraint` example uses. */
const NOT_APPLY_FIXTURES = ['yarn-vendored']

/** A fresh copy that `JsonValue` admits: it has no readonly arrays. */
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

/** The tree that the TypeScript side reads, from its own `detect`. */
const treeOf = (dir: string): Tree<NodeDetection> => {
  const detection = node.detect(dir, ENV)
  if (detection.outcome !== 'ok') {
    throw new Error(`TypeScript detect refused ${dir}: ${detection.error}`)
  }
  return { root: dir, detection: detection.value }
}

/**
 * The typed request for one argument list, read as `verb_apply_constraint`
 * reads it. An absent package or range is empty: `${1:?}` refuses both
 * with one message.
 */
const requestOf = (args: readonly string[]): ConstraintRequest => {
  const tightenBare = args[0] === '--tighten-bare'
  const rest = tightenBare ? args.slice(1) : args
  return {
    pkg: rest[0] ?? '',
    range: rest[1] ?? '',
    parents: rest.slice(2),
    tightenBare,
  }
}

/**
 * 'agree', or the first disagreement in words, for a refusal on both sides.
 *
 * bash writes a refusal to stderr, and nothing to stdout. `die` and the
 * guard write one line of JSON last, which must equal the body that the
 * entry point renders from the TypeScript envelope. The `${1:?}` usage guard
 * writes prose, which must contain the TypeScript message. Where jq stops,
 * only the refusal counts.
 */
const refusalAgreement = (answer: BashResult, failure: Failure): string => {
  if (answer.status === 0) return `bash answered: ${answer.stdout.trim()}`
  if (answer.stdout !== '') return `bash wrote an answer: ${answer.stdout.trim()}`
  const status = exitCodeFor(failure)
  if (answer.status === JQ_ERROR && status === 1) return 'agree'
  if (answer.status !== status) {
    return `bash exits ${answer.status} with "${answer.stderr.trim()}", TypeScript exits ${status} with "${failure.error}"`
  }
  const last = answer.stderr.trim().split('\n').at(-1) ?? ''
  if (last.startsWith('{')) {
    const difference = firstDifference(
      JSON.parse(last) as JsonValue,
      JSON.parse(renderJson(failure).stdout) as JsonValue,
    )
    return difference === null ? 'agree' : `the refusals differ at ${difference}`
  }
  return answer.stderr.includes(failure.error)
    ? 'agree'
    : `bash stderr does not name "${failure.error}": ${answer.stderr.trim()}`
}

/** 'agree', or the first disagreement in words, for the outcome and the answer. */
const answerAgreement = (answer: BashResult, envelope: Envelope<ApplyConstraintAnswer>): string => {
  if (envelope.outcome !== 'ok') return refusalAgreement(answer, envelope)
  if (answer.status !== 0) {
    return `bash exits ${answer.status} with "${answer.stderr.trim()}", TypeScript answers ok`
  }
  const difference = firstDifference(JSON.parse(answer.stdout) as JsonValue, asJson(envelope.value))
  return difference === null ? 'agree' : `they differ at ${difference}`
}

/** Each file under `dir`, by its relative path: its bytes, or the target of a link. */
const filesOf = (dir: string): Map<string, string> => {
  const files = new Map<string, string>()
  const walk = (relative: string): void => {
    const path = join(dir, relative)
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      files.set(relative, `link:${readlinkSync(path)}`)
    } else if (stats.isDirectory()) {
      files.set(`${relative}/`, 'directory')
      for (const name of readdirSync(path).sort())
        walk(relative === '' ? name : join(relative, name))
    } else {
      files.set(relative, `file:${readFileSync(path).toString('base64')}`)
    }
  }
  walk('')
  return files
}

/** The first file that differs between two trees, in words, or null. */
const treeDifference = (
  bash: Map<string, string>,
  typescript: Map<string, string>,
): string | null => {
  for (const path of [...new Set([...bash.keys(), ...typescript.keys()])].sort()) {
    const left = bash.get(path)
    const right = typescript.get(path)
    if (left === right) continue
    if (left === undefined) return `only TypeScript has ${path}`
    if (right === undefined) return `only bash has ${path}`
    const show = (entry: string): string =>
      entry.startsWith('file:')
        ? JSON.stringify(Buffer.from(entry.slice(5), 'base64').toString('utf8'))
        : entry
    return `${path} differs: bash ${show(left)}, TypeScript ${show(right)}`
  }
  return null
}

/** One call of the verb: its fixture, the setup shell text, the directory, and the arguments. */
type Case = {
  readonly title: string
  readonly fixture: string
  /** Shell text that `/bin/sh -c` runs in the copy before the call, or null. */
  readonly setup: string | null
  /** The directory of the call, relative to the copy. */
  readonly cwd: string
  readonly args: readonly string[]
}

/** What one case gives: the agreement of the answers, the first file that differs, and a change. */
type Outcome = {
  readonly answer: string
  readonly tree: string | null
  /** The TypeScript side changed the tree. */
  readonly wrote: boolean
}

/** Copy `source` to `target`, after `target` is removed. */
const restore = (source: string, target: string): void => {
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true, verbatimSymlinks: true })
}

/** 64 MiB, so that a large bash answer is not cut short. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * Run a command as a real process, with no shell, and resolve its status and
 * output. The statuses are those of a shell: 127 for a command that never
 * started, and 128 plus the signal number for a signal death. This is the
 * async twin of `runBash`, so that the bash sides of the cases can run at the
 * same time.
 */
const runAsync = (command: string, args: readonly string[], cwd: string): Promise<BashResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ status: 0, stdout, stderr })
          return
        }
        const status =
          typeof error.code === 'number'
            ? error.code
            : error.signal
              ? 128 + constants.signals[error.signal]
              : 127
        resolve({ status, stdout, stderr })
      },
    )
  })

/** The bash side of one case, and the directories that the TypeScript side needs. */
type Prepared = {
  readonly base: string
  readonly work: string
  readonly pristine: string
  readonly dir: string
  readonly before: Map<string, string>
  readonly bash: BashResult
  readonly bashTree: Map<string, string>
}

/**
 * The bash side of one case, in a scratch directory. The fixture is copied,
 * the pointer file is written, and the setup runs. A pristine copy of that
 * state is kept for the TypeScript side.
 */
const prepare = async (testCase: Case): Promise<Prepared> => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'apply-parity-')))
  const work = join(base, 'work')
  const pristine = join(base, 'pristine')
  cpSync(join(FIXTURES_ROOT, testCase.fixture), work, { recursive: true, verbatimSymlinks: true })
  fakeLinkedWorktree(work)
  if (testCase.setup !== null) {
    const setup = await runAsync('/bin/sh', ['-c', testCase.setup], work)
    if (setup.status !== 0) throw new Error(`setup of ${testCase.title} failed: ${setup.stderr}`)
  }
  restore(work, pristine)
  const before = filesOf(work)
  const dir = join(work, testCase.cwd)
  const bash = await runAsync(ADAPTER, ['apply_constraint', ...testCase.args], dir)
  return { base, work, pristine, dir, before, bash, bashTree: filesOf(work) }
}

/**
 * The TypeScript side of one case, in the same directory as the bash side.
 * The pristine copy restores the directory first. So a refusal that names a
 * path names the same path on each side.
 */
const finish = (prepared: Prepared, testCase: Case): Outcome => {
  restore(prepared.pristine, prepared.work)
  const envelope = node.applyConstraint(treeOf(prepared.dir), requestOf(testCase.args))
  const tsTree = filesOf(prepared.work)
  return {
    answer: answerAgreement(prepared.bash, envelope),
    tree: treeDifference(prepared.bashTree, tsTree),
    wrote: treeDifference(prepared.before, tsTree) !== null,
  }
}

/** Run `task` on each item, with at most `limit` tasks at one time, in the order of the items. */
const pool = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = []
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: limit }, lane))
  return results
}

/** The bash side of each case, which the `beforeAll` below fills. */
const prepared = new Map<Case, Prepared>()

/** The outcome of one case, after its bash side ran. */
const outcomeOf = (testCase: Case): Outcome => {
  const found = prepared.get(testCase)
  if (found === undefined) throw new Error(`no bash side for ${testCase.title}`)
  return finish(found, testCase)
}

const AGREE = { answer: 'agree', tree: null }

/** A case with no setup, in the root of the copy. */
const call = (title: string, fixture: string, ...args: string[]): Case => ({
  title,
  fixture,
  setup: null,
  cwd: '.',
  args,
})

/** A case with a setup, in the root of the copy. */
const after = (title: string, fixture: string, setup: string, ...args: string[]): Case => ({
  title,
  fixture,
  setup,
  cwd: '.',
  args,
})

/** `printf 'gitdir: %s\n' "$1" > .git`, as `fake_linked_worktree` writes it. */
const pointer = (gitdir: string): string => `printf 'gitdir: %s\\n' '${gitdir}' > .git`

const PRIMARY = 'rm -f .git && mkdir -p .git'

const APP_COPY = 'mkdir -p packages/app && cp package.json yarn.lock packages/app/'

const LODASH = ['lodash', '>=4.17.21 <5'] as const

const BRACE = ['brace-expansion', '>=5.0.9 <6'] as const

/** The jq edit of package.json that the spec spells as `jq '...' package.json > p.tmp && mv`. */
const manifestEdit = (program: string): string =>
  `jq '${program}' package.json > p.tmp && mv p.tmp package.json`

/** The same edit of package-lock.json. */
const lockEdit = (program: string): string =>
  `jq '${program}' package-lock.json > lock.tmp && mv lock.tmp package-lock.json`

const SECOND_NX_LINE = lockEdit(
  '.packages["node_modules/foo"] = {version: "1.0.0", dependencies: {nx: "^21.0.0"}} | .packages["node_modules/foo/node_modules/nx"] = {version: "21.5.0", dependencies: {"brace-expansion": "^1.1.7"}} | .packages["node_modules/foo/node_modules/brace-expansion"] = {version: "1.1.12"}',
)

const TOP_OVER_LERNA = lockEdit(
  '.packages[""].dependencies.top = "^1.0.0" | .packages["node_modules/top"] = {version: "1.0.0", dependencies: {lerna: "^9.0.0"}}',
)

/** `set_rule` and `selector_write` of the spec: the whole override block. */
const rule = (json: string): string =>
  `jq --argjson r '${json}' '.overrides = $r' package.json > p.tmp && mv p.tmp package.json`

const LADDER = `${manifestEdit('.overrides = {"webpack": {"nx": "^22"}}')} && ${lockEdit(
  '.packages = ({"": {name: "demo", version: "1.0.0", dependencies: {"lib-a-0": "^1.0.0", "lib-b-0": "^1.0.0"}}, "node_modules/nx": {version: "22.7.9", dependencies: {"brace-expansion": "^5.0.4"}}, "node_modules/brace-expansion": {version: "5.0.5"}} + ([ range(0; 22) as $i | ["a", "b"][] as $w | {("node_modules/lib-\\($w)-\\($i)"): {version: "1.0.0", dependencies: (if $i == 21 then {nx: "^22.0.0"} else {("lib-a-\\($i+1)"): "^1.0.0", ("lib-b-\\($i+1)"): "^1.0.0"} end)}} ] | add))',
)}`

/** A shell word that holds `text` exactly: single quotes, with each inner quote spelled `'"'"'`. */
const quoted = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`

/** `printf` of `text` into pnpm-workspace.yaml. `text` holds printf escapes, such as a backslash and `n`. */
const WORKSPACE = (text: string): string => `printf ${quoted(text)} > pnpm-workspace.yaml`

/** `printf '%b\n' "$2"` of the refused shapes, with the text of each row. */
const WORKSPACE_B = (text: string): string => `printf '%b\\n' ${quoted(text)} > pnpm-workspace.yaml`

const PNPM11 = 'pnpm11-workspace-overrides'

const PLACED = 'npm-override-placed-parent'

const SPEC_CASES: readonly Case[] = [
  // Describe 'mutating verbs run only in a linked worktree'
  after('a primary checkout', 'yarn-berry', PRIMARY, ...LODASH),
  {
    title: 'a subdirectory of a primary checkout',
    fixture: 'yarn-berry',
    setup: `${PRIMARY} && ${APP_COPY}`,
    cwd: 'packages/app',
    args: LODASH,
  },
  after('a submodule', 'yarn-berry', pointer('/parent/.git/modules/vendor'), ...LODASH),
  after('a relative submodule', 'yarn-berry', pointer('../.git/modules/vendor'), ...LODASH),
  after(
    'a submodule in a linked worktree',
    'yarn-berry',
    pointer('../../main/.git/worktrees/fix/modules/vendor'),
    ...LODASH,
  ),
  after(
    'a submodule under worktrees/',
    'yarn-berry',
    pointer('../../.git/modules/worktrees/foo'),
    ...LODASH,
  ),
  after(
    'a worktree of a repository under modules/',
    'yarn-berry',
    // A real gitdir with a `commondir` file, beside the copy: the
    // TypeScript guard reads it (#304).
    `mkdir -p ../src/modules/app/.git/worktrees/fix && printf '../..\\n' > ../src/modules/app/.git/worktrees/fix/commondir && ${pointer('../src/modules/app/.git/worktrees/fix')}`,
    ...LODASH,
  ),
  call('a linked worktree', 'yarn-berry', ...LODASH),
  {
    title: 'a subdirectory of a linked worktree',
    fixture: 'yarn-berry',
    setup: APP_COPY,
    cwd: 'packages/app',
    args: LODASH,
  },
  // Describe 'transitive dependencies get parent-scoped entries'
  call('parent>dep for pnpm', 'pnpm-v9', 'undici', '>=6.19.0 <7', 'express', 'koa'),
  call('parent/dep for yarn', 'yarn-berry', 'undici', '>=6.19.0 <7', '@vercel/fun'),
  call('nested objects for npm', 'npm-v3', 'undici', '>=6.19.0 <7', 'glob', 'rimraf'),
  // Describe 'pnpm parent keys are version-qualified across major lines'
  call('pnpm qualified keys', 'pnpm-cross-line', ...BRACE, 'minimatch'),
  call('pnpm 1.x line', 'pnpm-cross-line', 'brace-expansion', '>=1.1.12 <2', 'minimatch'),
  call('pnpm single-version parent', 'pnpm-cross-line', 'minimatch', '>=5.1.6 <6', 'filelist'),
  call('pnpm optional parent', 'pnpm-optional-parent', 'dompurify', '>=3.4.13 <4', 'jspdf'),
  call('pnpm optional qualified', 'pnpm-optional-qualified', 'dompurify', '>=3.4.13 <4', 'jspdf'),
  after(
    'pnpm with no packages section',
    'pnpm-cross-line',
    "awk '/^packages:/ {skip = 1; next} /^[a-zA-Z]/ {skip = 0} !skip' pnpm-lock.yaml > lock.tmp && mv lock.tmp pnpm-lock.yaml",
    ...BRACE,
    'minimatch',
  ),
  call(
    'pnpm no qualifying version',
    'pnpm-cross-line',
    'brace-expansion',
    '>=9.0.0 <10',
    'minimatch',
  ),
  call('pnpm unreadable child major', 'pnpm-peer-variant', 'minimist', '>=0.0.9 <0.1', 'optimist'),
  // Describe 'npm parent keys are version-qualified across major lines'
  call('npm qualified keys', 'npm-cross-line', ...BRACE, 'minimatch'),
  call('npm 1.x line', 'npm-cross-line', 'brace-expansion', '>=1.1.12 <2', 'minimatch'),
  call('npm single-version parent', 'npm-cross-line', 'minimatch', '>=5.1.6 <6', 'filelist'),
  call('npm no qualifying copy', 'npm-cross-line', 'brace-expansion', '>=9.0.0 <10', 'minimatch'),
  after(
    'npm with no packages object',
    'npm-cross-line',
    "jq 'del(.packages)' package-lock.json > lock.tmp && mv lock.tmp package-lock.json",
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm root spec in devDependencies',
    'npm-cross-line',
    manifestEdit(
      '.devDependencies = {minimatch: .dependencies.minimatch} | del(.dependencies.minimatch)',
    ),
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm root spec that admits an off-line copy',
    'npm-cross-line',
    manifestEdit('.dependencies.minimatch = ">=3.0.0"'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm root spec that is a dist-tag',
    'npm-cross-line',
    manifestEdit('.dependencies.minimatch = "latest"'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm parent copy with no version',
    'npm-cross-line',
    lockEdit('del(.packages["node_modules/@ts-morph/common/node_modules/minimatch"].version)'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm prerelease parent copy',
    'npm-cross-line',
    lockEdit('.packages["node_modules/minimatch"].version = "10.3.0-beta.1"'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm parent copy that is not plain semver',
    'npm-cross-line',
    lockEdit(
      '.packages["node_modules/@ts-morph/common/node_modules/minimatch"].version = "10.x-bogus"',
    ),
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm same-line bare nested key',
    'npm-cross-line',
    manifestEdit('.overrides = {minimatch: {"brace-expansion": ">=5.0.6 <6"}}'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'npm different-line bare nested key',
    'npm-cross-line',
    manifestEdit('.overrides = {minimatch: {"brace-expansion": ">=1.1.18 <2"}}'),
    ...BRACE,
    'minimatch',
  ),
  call(
    'npm scoped parent',
    'npm-scoped-cross-line',
    'minimatch',
    '>=10.0.5 <11',
    '@npmcli/map-workspaces',
  ),
  // Describe 'npm constraint nests inside a pre-existing override that places the parent'
  call('npm placed parent', PLACED, ...BRACE, 'nx'),
  after(
    'npm object rule',
    PLACED,
    manifestEdit('.overrides.lerna.nx = {".": ">=22.7.7 <23", "minimist": "^1.2.8"}'),
    ...BRACE,
    'nx',
  ),
  after(
    'npm top-level rule',
    PLACED,
    manifestEdit('.overrides = {nx: {minimist: "^1.2.8"}}'),
    ...BRACE,
    'nx',
  ),
  after('npm second nx line outside the rule', PLACED, SECOND_NX_LINE, ...BRACE, 'nx'),
  // Describe 'npm placement detection is grounded in the lockfile'
  after('npm rule root absent', PLACED, rule('{"unrelated-pkg":{"nx":"^22"}}'), ...BRACE, 'nx'),
  after('npm rule never reaches nx', PLACED, rule('{"chalk":{"nx":"^22"}}'), ...BRACE, 'nx'),
  after(
    'npm uncorroborated rule and a second line',
    PLACED,
    `${rule('{"unrelated-pkg":{"nx":"^22"}}')} && ${SECOND_NX_LINE}`,
    ...BRACE,
    'nx',
  ),
  after(
    'npm placed and normal copies',
    PLACED,
    lockEdit(
      '.packages[""].dependencies.zed = "^1.0.0" | .packages["node_modules/zed"] = {version: "1.0.0", dependencies: {nx: "^22.0.0"}} | .packages["node_modules/zed/node_modules/nx"] = {version: "22.6.0", dependencies: {"brace-expansion": "^5.0.4"}}',
    ),
    ...BRACE,
    'nx',
  ),
  // Describe 'npm placement refusals'
  after(
    'npm alias child key',
    PLACED,
    `${manifestEdit('.overrides = {"lerna": {"nx-tools": "npm:nx@>=22.7.7 <23"}, "glob": "^13.0.0"}')} && ${lockEdit(
      'del(.packages["node_modules/nx"]) | .packages["node_modules/nx-tools"] = {name: "nx", version: "22.7.9", dependencies: {"brace-expansion": "^5.0.4"}} | .packages["node_modules/lerna"].dependencies = {"nx-tools": "npm:nx@22.7.7", chalk: "^6.0.0"}',
    )}`,
    ...BRACE,
    'nx',
  ),
  after(
    'npm version-qualified placing rule',
    PLACED,
    manifestEdit('.overrides = {"lerna": {"nx@^22.0.0": ">=22.7.7 <23"}, "glob": "^13.0.0"}'),
    ...BRACE,
    'nx',
  ),
  after(
    'npm placing rule over two child lines',
    PLACED,
    lockEdit(
      '.packages["node_modules/lerna"].dependencies.baz = "^1.0.0" | .packages["node_modules/baz"] = {version: "1.0.0", dependencies: {nx: "^21.0.0"}} | .packages["node_modules/baz/node_modules/nx"] = {version: "21.5.0", dependencies: {"brace-expansion": "^1.1.7"}} | .packages["node_modules/baz/node_modules/brace-expansion"] = {version: "1.1.12"}',
    ),
    ...BRACE,
    'nx',
  ),
  after(
    'npm different-line dead top-level pair',
    PLACED,
    manifestEdit('.overrides.nx = {"brace-expansion": "^1.1.11"}'),
    ...BRACE,
    'nx',
  ),
  after(
    'npm different-line pin inside the rule',
    PLACED,
    manifestEdit('.overrides.lerna.nx = {".": ">=22.7.7 <23", "brace-expansion": "^1.1.11"}'),
    ...BRACE,
    'nx',
  ),
  // Describe 'npm placement supersession and composition'
  after(
    'npm same-line dead top-level pair',
    PLACED,
    manifestEdit('.overrides.nx = {"brace-expansion": ">=5.0.9 <6"}'),
    ...BRACE,
    'nx',
  ),
  after(
    'npm same-line pin inside the rule',
    PLACED,
    manifestEdit('.overrides.lerna.nx = {".": ">=22.7.7 <23", "brace-expansion": "^5.0.4"}'),
    ...BRACE,
    'nx',
  ),
  after(
    'npm pair that protects a normal off-line copy',
    PLACED,
    `${manifestEdit('.overrides.nx = {"brace-expansion": "^1.1.11"}')} && ${SECOND_NX_LINE}`,
    ...BRACE,
    'nx',
  ),
  after(
    'npm preserved alias value',
    PLACED,
    manifestEdit('.overrides.lerna.nx = "npm:nx@22.7.7"'),
    ...BRACE,
    'nx',
  ),
  // Describe 'npm placement rule shapes'
  after(
    'npm two placing rules',
    PLACED,
    `${manifestEdit('.overrides = {"lerna": {nx: ">=22.7.7 <23"}, "top": {nx: ">=22.7.7 <23"}}')} && ${lockEdit(
      '.packages[""].dependencies.top = "^1.0.0" | .packages["node_modules/top"] = {version: "1.0.0", dependencies: {nx: "^22.0.0"}}',
    )}`,
    ...BRACE,
    'nx',
  ),
  after(
    'npm depth-3 rule',
    PLACED,
    `${manifestEdit('.overrides = {"top": {"lerna": {nx: ">=22.7.7 <23"}}}')} && ${TOP_OVER_LERNA}`,
    ...BRACE,
    'nx',
  ),
  after(
    'npm scoped placed parent',
    PLACED,
    `${manifestEdit('.overrides = {"lerna": {"@nx/devkit": ">=17.0.0 <18"}}')} && ${lockEdit(
      '.packages["node_modules/lerna"].dependencies = {"@nx/devkit": "^17.0.0", chalk: "^6.0.0"} | del(.packages["node_modules/nx"]) | .packages["node_modules/@nx/devkit"] = {version: "17.2.0", dependencies: {"brace-expansion": "^5.0.4"}}',
    )}`,
    ...BRACE,
    '@nx/devkit',
  ),
  // Describe 'npm placement corroboration respects rule selectors'
  after(
    'npm dead root selector',
    PLACED,
    rule('{"lerna@^8.0.0": {"nx": ">=22.7.7 <23"}}'),
    ...BRACE,
    'nx',
  ),
  after(
    'npm live root selector',
    PLACED,
    rule('{"lerna@^9.0.0": {"nx": ">=22.7.7 <23"}}'),
    ...BRACE,
    'nx',
  ),
  after(
    'npm dead intermediate selector',
    PLACED,
    `${TOP_OVER_LERNA} && ${rule('{"top": {"lerna@^8.0.0": {"nx": ">=22.7.7 <23"}}}')}`,
    ...BRACE,
    'nx',
  ),
  after(
    'npm dead child selector',
    PLACED,
    rule('{"lerna": {"nx@^21.0.0": ">=21.7.7 <22"}}'),
    ...BRACE,
    'nx',
  ),
  // Describe 'npm placement corroboration on a branching graph'
  after('npm branching ladder', PLACED, LADDER, ...BRACE, 'nx'),
  // Describe 'npm --tighten-bare and placed packages'
  call('npm tighten a placing rule pin', PLACED, '--tighten-bare', 'nx', '>=22.7.9 <23'),
  after(
    'npm tighten with no pin on the line',
    PLACED,
    manifestEdit('.overrides.lerna.nx = ">=21.0.0 <22"'),
    '--tighten-bare',
    'nx',
    '>=22.7.9 <23',
  ),
  after(
    'npm tighten with normal copies too',
    PLACED,
    lockEdit(
      '.packages[""].dependencies.foo = "^1.0.0" | .packages["node_modules/foo"] = {version: "1.0.0", dependencies: {nx: "^22.0.0"}} | .packages["node_modules/foo/node_modules/nx"] = {version: "22.7.5", dependencies: {"brace-expansion": "^5.0.4"}}',
    ),
    '--tighten-bare',
    'nx',
    '>=22.7.9 <23',
  ),
  // Describe 'npm malformed override block'
  after(
    'npm overrides that is a string',
    PLACED,
    manifestEdit('.overrides = "oops"'),
    ...BRACE,
    'nx',
  ),
  // Describe 'a dependency reached through an npm: alias'
  call('npm alias key', 'npm-alias', 'lodash', '>=4.18.2 <5', 'alias-parent', 'dupe-parent'),
  call('yarn alias key', 'yarn-berry-alias-parent', 'lodash', '>=4.18.2 <5', 'express'),
  call('npm alias report', 'npm-alias', 'lodash', '>=4.18.2 <5', 'alias-parent'),
  call('pnpm unresolved parents', 'pnpm-v9', 'lodash', '>=4.17.25 <5', 'express', 'koa'),
  call('yarn peer parent', 'yarn-berry-peer-parent', 'sha.js', '>=2.4.12 <3', 'serve-static'),
  call('npm colliding name', 'npm-dual-name', 'lodash', '>=4.17.21 <5'),
  call('npm root alias declaration', 'npm-alias', 'lodash', '>=4.18.2 <5'),
  call('npm alias key as the package', 'npm-alias', 'lodash-alias', '>=4.18.2 <5'),
  // Describe 'existing entries are merged, never replaced'
  call('pnpm merge', 'pnpm-v9', 'undici', '>=6.19.0 <7', 'express'),
  call('npm merge', 'npm-v3', 'undici', '>=6.19.0 <7', 'glob'),
  // Describe 'direct dependencies match the manifest version style'
  call('yarn exact pin style', 'yarn-berry', 'vitest', '>=4.1.0 <5'),
  call('pnpm caret style', 'pnpm-v9', 'vitest', '>=4.1.0 <5'),
  call('npm direct runtime dependency', 'npm-v3', 'express', '>=4.19.0 <5'),
  // Describe 'observations flag pre-existing unscoped overrides'
  call('yarn scoped name observation', 'yarn-berry', 'undici', '>=6.19.0 <7', 'express'),
  call('pnpm targets this package', 'pnpm-v9', 'lodash', '>=4.17.21 <5', 'express'),
  // Describe '--tighten-bare escalation'
  call('pnpm tighten', 'pnpm-v9', '--tighten-bare', 'lodash', '>=4.17.25 <5'),
  call(
    'pnpm tighten qualified keys',
    'pnpm-major-qualified',
    '--tighten-bare',
    'protobufjs',
    '>=8.6.6 <9',
  ),
  call(
    'pnpm tighten plain and qualified',
    'pnpm-major-qualified',
    '--tighten-bare',
    'tar',
    '>=6.2.4 <7',
  ),
  call(
    'pnpm tighten a lone qualified key',
    'pnpm-v9',
    '--tighten-bare',
    'handlebars',
    '>=4.7.10 <5',
  ),
  call('pnpm tighten beside a scoped key', 'pnpm-pins', '--tighten-bare', 'vite', '>=7.1.5 <8'),
  call(
    'pnpm tighten beside a dotted scoped key',
    'pnpm-pins',
    '--tighten-bare',
    'protobufjs',
    '>=8.6.6 <9',
  ),
  call(
    'yarn tighten a qualified key',
    'yarn-major-qualified',
    '--tighten-bare',
    'protobufjs',
    '>=8.6.6 <9',
  ),
  call(
    'yarn tighten a scoped name',
    'yarn-major-qualified',
    '--tighten-bare',
    '@grpc/grpc-js',
    '>=1.8.22 <2',
  ),
  call(
    'yarn tighten beside a path key',
    'yarn-major-qualified',
    '--tighten-bare',
    'minimist',
    '>=1.2.8 <2',
  ),
  call(
    'yarn tighten with no cover',
    'yarn-major-qualified',
    '--tighten-bare',
    'left-pad',
    '>=1.3.1 <2',
  ),
  call(
    'npm tighten a qualified key',
    'npm-major-qualified',
    '--tighten-bare',
    'minimist',
    '>=1.2.8 <2',
  ),
  call(
    'npm tighten with no cover',
    'npm-major-qualified',
    '--tighten-bare',
    'lodash',
    '>=4.17.21 <5',
  ),
  ...(
    [
      ['bare major', 'protobufjs@8', '^8.0.0', 'protobufjs', '>=8.6.6 <9'],
      ['caret', 'protobufjs@^8.0.1', '^8.0.1', 'protobufjs', '>=8.6.6 <9'],
      ['spaced range', 'protobufjs@>=8 <9', '>=8 <9', 'protobufjs', '>=8.6.6 <9'],
      ['dist-tag', 'protobufjs@beta', 'beta', 'protobufjs', '>=8.6.6 <9'],
      ['scoped name', '@grpc/grpc-js@1', '^1.7.0', '@grpc/grpc-js', '>=1.8.22 <2'],
    ] as const
  ).map(([shape, key, value, pkg, range]) =>
    after(
      `npm selector shape: ${shape}`,
      'npm-major-qualified',
      `jq --arg k '${key}' --arg v '${value}' '.overrides = {($k): $v}' package.json > pkg.tmp && mv pkg.tmp package.json`,
      '--tighten-bare',
      pkg,
      range,
    ),
  ),
  // Describe 'a stale npm lockfile entry is invalidated with the override'
  call('npm stale copy', 'npm-stale-nested', 'axios', '>=1.18.0 <2', 'nx'),
  call('npm nothing stale', 'npm-stale-nested', 'axios', '>=1.16.0 <2', 'nx'),
  call('npm direct bump', 'npm-stale-nested', 'axios', '>=1.18.0 <2'),
  call('npm 0.x line', 'npm-stale-nested', 'axios', '>=0.21.7 <1', 'localtunnel'),
  call('npm unreadable floor', 'npm-stale-nested', 'axios', 'latest', 'nx'),
  call('npm v1 lockfile', 'npm-v1', 'axios', '>=0.21.7 <1', 'localtunnel'),
  call('npm workspace links', 'npm-workspaces', 'lodash', '>=4.18.0 <5', 'express'),
  call('yarn not performed', 'yarn-berry', 'undici', '>=6.19.0 <7', '@vercel/fun'),
  call('a direct update with no override block', 'no-overrides', ...LODASH),
  call('a new override block', 'yarn-berry', 'brand-new-pkg', '>=1.0.0 <2', 'some-parent'),
  call('a package with no range', 'pnpm-v9', 'lodash'),
  // Describe 'apply_constraint pnpm override file routing (issue #159)'
  call('pnpm 11 workspace block', PNPM11, ...BRACE, 'minimatch'),
  after(
    'pnpm 11 with no workspace file',
    'pnpm-cross-line',
    `jq '.packageManager = "pnpm@11.9.0"' package.json > p.json && mv p.json package.json`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'a nested map in the block',
    PNPM11,
    WORKSPACE('overrides:\\n  jest:\\n    ws: 1\\n'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'duplicate keys in the block',
    PNPM11,
    WORKSPACE('overrides:\\n  ws: 1\\n  ws: 2\\n'),
    ...BRACE,
    'minimatch',
  ),
  // Describe 'apply_constraint pnpm workspace overrides hardening (issue #159 review)'
  after(
    'adjacent duplicate blocks',
    PNPM11,
    WORKSPACE('overrides:\\n  ws: 1\\noverrides:\\n  undici: 2\\n'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'a quoted top-level key',
    PNPM11,
    `printf "'overrides':\\n  ws: '1'\\n" > pnpm-workspace.yaml`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'an inline comment',
    PNPM11,
    `printf "overrides:\\n  undici: '>=6.23.0' # keep until the bump\\n" > pnpm-workspace.yaml`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'a tab outside the block',
    PNPM11,
    `printf 'packages:\\n  - packages/*\\t# tab here\\noverrides:\\n  ws: '"'"'>=8.17.1'"'"'\\n' > pnpm-workspace.yaml`,
    ...BRACE,
    'minimatch',
  ),
  after('a flow-style value', PNPM11, WORKSPACE_B('overrides: {ws: 1}'), ...BRACE, 'minimatch'),
  after(
    'a block scalar',
    PNPM11,
    WORKSPACE_B('overrides:\\n  ws: |\\n    x'),
    ...BRACE,
    'minimatch',
  ),
  after('an anchor', PNPM11, WORKSPACE_B('overrides:\\n  ws: &a x'), ...BRACE, 'minimatch'),
  after('an alias', PNPM11, WORKSPACE_B('overrides:\\n  ws: *a'), ...BRACE, 'minimatch'),
  after(
    'an unclosed quoted key',
    PNPM11,
    `printf '%b\\n' "overrides:\\n  'ws: 1" > pnpm-workspace.yaml`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'a deeper indent',
    PNPM11,
    `printf '%b\\n' "overrides:\\n    ws: '1'" > pnpm-workspace.yaml`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'a backslash escape',
    PNPM11,
    WORKSPACE_B('overrides:\\n  ws: ">=1\\\\\\\\.0"'),
    ...BRACE,
    'minimatch',
  ),
  after(
    'the refusal names its line',
    PNPM11,
    `printf "overrides:\\n  ws: '1'\\n  jest:\\n    x: 1\\n" > pnpm-workspace.yaml`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'a pre-existing workspace key',
    PNPM11,
    `printf "overrides:\\n  'minimatch@10.2.5>brace-expansion': '>=5.0.0'\\n" > pnpm-workspace.yaml`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'dead manifest overrides with a sibling key',
    PNPM11,
    `jq '.pnpm = {overrides: {"brace-expansion": ">=1.0.0"}, onlyBuiltDependencies: ["esbuild"]}' package.json > p.json && mv p.json package.json`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'dead manifest overrides',
    PNPM11,
    `jq '.pnpm = {overrides: {"brace-expansion": ">=1.0.0"}}' package.json > p.json && mv p.json package.json`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'pnpm 10 with a workspace block',
    PNPM11,
    `jq '.packageManager = "pnpm@10.33.2" | .pnpm = {overrides: {undici: "<5"}}' package.json > p.json && mv p.json package.json`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'no packageManager pin',
    'pnpm-cross-line',
    `jq 'del(.packageManager)' package.json > p.json && mv p.json package.json`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'a workspace file with no newline at the end',
    PNPM11,
    WORKSPACE('packages:\\n  - packages/*'),
    ...BRACE,
    'minimatch',
  ),
]

/** The spec cases where the guard refuses. */
const GUARD_REFUSALS: readonly string[] = [
  'a primary checkout',
  'a subdirectory of a primary checkout',
  'a submodule',
  'a relative submodule',
  'a submodule in a linked worktree',
  'a submodule under worktrees/',
]

/** The fixtures that the spec names in a `use_fixture` line. */
const specFixtures: readonly string[] = [
  ...new Set(
    [...readFileSync(SPEC, 'utf8').matchAll(/^\s*use_fixture ([A-Za-z0-9._-]+)\s*$/gm)].map(
      (match) => match[1] as string,
    ),
  ),
]
  .filter((name) => !NOT_APPLY_FIXTURES.includes(name))
  .sort()

describe('the apply_constraint cases', () => {
  it('cover each fixture that spec/node_apply_constraint_spec.sh uses', () => {
    const covered = [...new Set(SPEC_CASES.map(({ fixture }) => fixture))].sort()
    expect(covered).toEqual(specFixtures)
    expect(specFixtures.length).toBeGreaterThan(20)
  })
})

describe('apply_constraint parity on the spec cases', () => {
  it.each(SPEC_CASES.map((testCase) => [testCase.title, testCase] as const))(
    'agrees on %s',
    (title, testCase) => {
      const outcome = outcomeOf(testCase)
      if (GUARD_REFUSALS.includes(title)) expect(outcome).toEqual({ ...AGREE, wrote: false })
      else expect(outcome).toMatchObject(AGREE)
    },
    CASE_TIMEOUT_MS,
  )

  it('names a spec case for each refusal of the guard', () => {
    expect(SPEC_CASES.filter(({ title }) => GUARD_REFUSALS.includes(title))).toHaveLength(
      GUARD_REFUSALS.length,
    )
  })
})

/** The major of a version, for the arguments of a generated case only. */
const majorOf = (version: string): number => Number.parseInt(version.replace(/^[v=]+/, ''), 10)

/** The cases for each package of one fixture: direct, scoped and tighten. */
const generatedFor = (fixture: string): Case[] => {
  const dir = join(FIXTURES_ROOT, fixture)
  const map = runBash({ command: ADAPTER, args: ['resolution_map'], cwd: dir })
  if (map.status !== 0) return []
  const { resolutions } = JSON.parse(map.stdout) as { resolutions: Record<string, string[]> }
  const tree = treeOf(dir)
  return Object.entries(resolutions).flatMap(([pkg, versions]): Case[] => {
    const majors = [...new Set(versions.map(majorOf))]
      .filter(Number.isInteger)
      .sort((a, b) => a - b)
    const major = majors.at(-1)
    if (major === undefined) return []
    const top = versions.filter((version) => majorOf(version) === major).at(-1) as string
    const range = `>=${top} <${major + 1}.0.0`
    const found = node.parents(tree, pkg)
    const parents =
      found.outcome === 'ok' ? [...new Set(found.value.parents.map(({ name }) => name))] : []
    return [
      call(`direct ${pkg}`, fixture, pkg, range),
      ...(parents.length === 0 ? [] : [call(`scoped ${pkg}`, fixture, pkg, range, ...parents)]),
      call(`tighten ${pkg}`, fixture, '--tighten-bare', pkg, range),
    ]
  })
}

const generated: readonly Case[] = specFixtures.flatMap(generatedFor)

describe('apply_constraint parity on the generated cases', () => {
  it('finds cases to compare', () => {
    expect(generated.length).toBeGreaterThan(specFixtures.length)
  })

  it.each(generated.map((testCase) => [testCase.fixture, testCase.title, testCase] as const))(
    'agrees on %s: %s',
    (_fixture, _title, testCase) => {
      expect(outcomeOf(testCase)).toMatchObject(AGREE)
    },
    CASE_TIMEOUT_MS,
  )
})

/** Arguments that no spec example uses, on fixtures of each manager. */
const ODD_ARGS: readonly (readonly string[])[] = [
  ['', '>=1.0.0'],
  ['lodash', ''],
  [],
  ['--tighten-bare'],
  ['--tighten-bare', 'lodash', '>=4.17.21 <5', 'express'],
  ['lodash', '>=4.17.21 <5', '', 'express'],
  ['lodash', '>=4.17.21 <5', 'express\nkoa'],
  ['lodash', '*', 'express'],
  ['lodash', 'latest'],
  ['lodash', '>=1 ||', 'express'],
  ['lodash', '>=1 ||'],
  ['lodash', ' >=4.17.21 <5 '],
  ['lodash', '^4.17.21'],
  ['lodash', '4.17.21'],
  ['lodash', '~4.17.21'],
  ['lodash', '>= 4.17.21'],
  ['lodash', '>=4.17.21 <5', 'lodash'],
  ['@babel/core', '>=7.25.0 <8'],
  ['@babel/core', '>=7.25.0 <8', 'express'],
  ['nonexistent-pkg', '>=1.0.0 <2', 'nonexistent-parent'],
  ['--tighten-bare', 'nonexistent-pkg', 'latest'],
  ["it's", ">='1' <2", 'express'],
]

const ODD_FIXTURES = ['npm-v3', 'pnpm-v9', 'yarn-berry', PNPM11]

/** Setups that change the format of the files, not their content. */
const FORMATS: readonly (readonly [name: string, setup: string])[] = [
  ['tabs', `jq --tab . package.json > p.tmp && mv p.tmp package.json`],
  ['four spaces', `jq --indent 4 . package.json > p.tmp && mv p.tmp package.json`],
  ['one line', `jq -c . package.json > p.tmp && mv p.tmp package.json`],
  ['no newline at the end', `printf '%s' "$(cat package.json)" > p.tmp && mv p.tmp package.json`],
  ['CRLF line ends', `awk '{printf "%s\\r\\n", $0}' package.json > p.tmp && mv p.tmp package.json`],
  [
    'escapes in a text',
    `jq '.description = "caf\\u00e9 \\u007f \\u2028 \\u001f \\"q\\" \\\\\\\\ / \\ud83d\\ude00"' package.json > p.tmp && mv p.tmp package.json`,
  ],
  [
    'a __proto__ key',
    `jq '.["__proto__"] = {"x": 1}' package.json > p.tmp && mv p.tmp package.json`,
  ],
  [
    'a lockfile with tabs',
    `test ! -f package-lock.json || { jq --tab . package-lock.json > l.tmp && mv l.tmp package-lock.json; }`,
  ],
]

/** The calls that each format setup runs: a no-op, a direct write and a scoped write. */
const FORMAT_CALLS: readonly (readonly [fixture: string, args: readonly string[]])[] = [
  ['npm-v3', ['lodash', '>=4.17.21 <5']],
  ['npm-v3', ['undici', '>=6.19.0 <7', 'glob']],
  ['yarn-berry', ['undici', '>=6.19.0 <7', '@vercel/fun']],
  ['npm-stale-nested', ['axios', '>=1.18.0 <2', 'nx']],
  [PNPM11, ['brace-expansion', '>=5.0.9 <6', 'minimatch']],
]

/** Workspace files of shapes that the reader accepts and the spec does not write. */
const WORKSPACE_SHAPES: readonly (readonly [name: string, text: string])[] = [
  ['comments and a later key', "overrides:\\n  # pinned\\n  ws: '1'\\n\\ncatalog:\\n  x: 1\\n"],
  ['no block, with a newline at the end', 'packages:\\n  - packages/*\\n'],
  ['an empty block', 'overrides:\\n'],
  ['an empty block at the end, with no newline', 'packages:\\n  - a\\noverrides:'],
  ['a block with no newline at the end', "overrides:\\n  ws: '1'"],
  ['a plain key and a double-quoted value', 'overrides:\\n  ws: ">=8.17.1"\\n'],
  ['the same key unquoted', "overrides:\\n  minimatch@10.2.5>brace-expansion: '>=5.0.9 <6'\\n"],
  ['a CRLF block', "overrides:\\r\\n  ws: '1'\\r\\n"],
  ['a comment after the header', "overrides: # live\\n  ws: '1'\\n"],
]

const odd: readonly Case[] = [
  ...ODD_FIXTURES.flatMap((fixture) =>
    ODD_ARGS.map((args) => call(`odd ${JSON.stringify(args)}`, fixture, ...args)),
  ),
  ...FORMATS.flatMap(([name, setup]) =>
    FORMAT_CALLS.map(([fixture, args]) =>
      after(`format ${name} ${args.join(' ')}`, fixture, setup, ...args),
    ),
  ),
  ...WORKSPACE_SHAPES.flatMap(([name, text]) => [
    after(`workspace ${name}`, PNPM11, WORKSPACE(text), ...BRACE, 'minimatch'),
    after(`workspace ${name}, direct`, PNPM11, WORKSPACE(text), 'minimatch', '>=10.2.6 <11'),
    after(
      `workspace ${name}, tighten`,
      PNPM11,
      WORKSPACE(text),
      '--tighten-bare',
      'ws',
      '>=8.17.1 <9',
    ),
  ]),
  after('a manifest that holds no document', 'npm-v3', `printf '\\n' > package.json`, ...LODASH),
  after('a manifest that is null', 'npm-v3', `printf 'null\\n' > package.json`, ...LODASH),
  after('a manifest that is a list', 'yarn-berry', `printf '[]\\n' > package.json`, ...LODASH),
  after(
    'a pnpm field that is a text, with a workspace block',
    PNPM11,
    `jq '.pnpm = "x"' package.json > p.json && mv p.json package.json`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'a pnpm field that is false, with a workspace block',
    PNPM11,
    `jq '.pnpm = false' package.json > p.json && mv p.json package.json`,
    ...BRACE,
    'minimatch',
  ),
  after(
    'resolutions that is a list',
    'yarn-berry',
    `jq '.resolutions = []' package.json > p.json && mv p.json package.json`,
    ...LODASH,
  ),
  after(
    'a pnpm field that is a text',
    'pnpm-v9',
    `jq '.pnpm = "x"' package.json > p.json && mv p.json package.json`,
    ...LODASH,
  ),
  after(
    'overrides with a number value',
    'npm-v3',
    `jq '.overrides.lodash = 4' package.json > p.json && mv p.json package.json`,
    '--tighten-bare',
    ...LODASH,
  ),
  after(
    'a lockfile entry with an empty version',
    'npm-stale-nested',
    lockEdit('.packages["node_modules/axios"].version = ""'),
    'axios',
    '>=1.18.0 <2',
    'nx',
  ),
  after(
    'a lockfile packages list',
    'npm-stale-nested',
    lockEdit('.packages = []'),
    'axios',
    '>=1.18.0 <2',
    'nx',
  ),
  after(
    'a lockfile packages of false',
    'npm-stale-nested',
    lockEdit('.packages = false'),
    'axios',
    '>=1.18.0 <2',
    'nx',
  ),
  after(
    'a lockfile that is not JSON',
    'npm-stale-nested',
    `printf '{ not json\\n' > package-lock.json`,
    'axios',
    '>=1.18.0 <2',
    'nx',
  ),
]

/** The git parent of #50: beside one registry copy, and beside two. */
const GIT_PARENT_AGREES = call(
  'a git parent beside one registry copy',
  'pnpm-git-parent',
  'ms',
  '^2.1.3',
  'debug',
)
const GIT_PARENT_REFUSED = call(
  'a git parent beside two registry copies',
  'pnpm-git-parent-copies',
  'ms',
  '>=2.1.3 <3',
  'debug',
)

/** The cases whose bash side runs before the examples, at the same time. */
const ALL_CASES: readonly Case[] = [
  ...SPEC_CASES,
  ...generated,
  ...odd,
  GIT_PARENT_AGREES,
  GIT_PARENT_REFUSED,
]

/** The time limit of the bash side of all cases together. */
const BASH_TIMEOUT_MS = 590_000

beforeAll(async () => {
  const lanes = Math.max(1, Math.min(8, availableParallelism()))
  const results = await pool(ALL_CASES, lanes, prepare)
  for (const [index, testCase] of ALL_CASES.entries()) {
    prepared.set(testCase, results[index] as Prepared)
  }
}, BASH_TIMEOUT_MS)

afterAll(() => {
  for (const { base } of prepared.values()) rmSync(base, { recursive: true, force: true })
})

describe('apply_constraint parity on the odd cases', () => {
  it.each(odd.map((testCase) => [testCase.fixture, testCase.title, testCase] as const))(
    'agrees on %s: %s',
    (_fixture, _title, testCase) => {
      expect(outcomeOf(testCase)).toMatchObject(AGREE)
    },
    CASE_TIMEOUT_MS,
  )
})

describe('apply_constraint parity on a git parent (#50)', () => {
  it(
    'agrees beside one registry copy',
    () => {
      expect(outcomeOf(GIT_PARENT_AGREES)).toMatchObject(AGREE)
    },
    CASE_TIMEOUT_MS,
  )

  // The declared exception of ruling 2 on #50.
  it(
    'differs beside two registry copies: bash writes, and the port refuses and writes nothing',
    () => {
      const outcome = outcomeOf(GIT_PARENT_REFUSED)
      expect(outcome.answer.startsWith('bash answered: ')).toBe(true)
      expect({ wrote: outcome.wrote, treesDiffer: outcome.tree !== null }).toEqual({
        wrote: false,
        treesDiffer: true,
      })
    },
    CASE_TIMEOUT_MS,
  )
})

describe('apply_constraint parity in real repositories', () => {
  /** A real linked worktree and its primary checkout, each with a copy of `fixture`. */
  const repositoriesWith = (fixture: string) => {
    const sandbox = createSandbox()
    const base = realpathSync(sandbox.path)
    const git = createGitFixtures(sandbox)
    const main = git.createAt(base, 'main')
    git.branch(main, 'fix')
    const root = join(base, 'wt')
    git.worktree(main, root, 'fix')
    const plain = join(base, 'plain')
    mkdirSync(plain)
    for (const dir of [root, main, plain]) {
      cpSync(join(FIXTURES_ROOT, fixture), dir, { recursive: true, verbatimSymlinks: true })
    }
    return { root, main, plain }
  }

  /** Both sides in `dir`, with the state restored between them. */
  const bothIn = (dir: string, args: readonly string[]): Outcome => {
    const pristine = `${dir}.pristine`
    const keep = (path: string) => !path.endsWith('/.git') && !path.includes('/.git/')
    cpSync(dir, pristine, { recursive: true, verbatimSymlinks: true, filter: keep })
    const before = filesOf(pristine)
    const bash = runBash({ command: ADAPTER, args: ['apply_constraint', ...args], cwd: dir })
    const bashTree = filesOf(dir)
    for (const name of readdirSync(dir)) {
      if (name !== '.git') rmSync(join(dir, name), { recursive: true, force: true })
    }
    cpSync(pristine, dir, { recursive: true, verbatimSymlinks: true })
    const envelope = node.applyConstraint(treeOf(dir), requestOf(args))
    const tsTree = filesOf(dir)
    const strip = (files: Map<string, string>) =>
      new Map([...files].filter(([path]) => path !== '.git' && !path.startsWith('.git/')))
    return {
      answer: answerAgreement(bash, envelope),
      tree: treeDifference(strip(bashTree), strip(tsTree)),
      wrote: treeDifference(strip(before), strip(tsTree)) !== null,
    }
  }

  it.each([
    ['npm-cross-line', [...BRACE, 'minimatch']],
    ['pnpm-cross-line', [...BRACE, 'minimatch']],
    ['yarn-berry', ['undici', '>=6.19.0 <7', '@vercel/fun']],
  ] as const)(
    'agrees in a real linked worktree on %s',
    (fixture, args) => {
      const scene = repositoriesWith(fixture)
      expect(bothIn(scene.root, args)).toEqual({ ...AGREE, wrote: true })
    },
    CASE_TIMEOUT_MS,
  )

  it.each([
    ['a primary checkout', 'main'],
    ['a directory in no repository', 'plain'],
  ] as const)(
    'agrees on the refusal in %s, and writes nothing',
    (_title, where) => {
      const scene = repositoriesWith('npm-cross-line')
      expect(bothIn(scene[where], [...BRACE, 'minimatch'])).toEqual({ ...AGREE, wrote: false })
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'agrees on the refusal in a subdirectory of a primary checkout',
    () => {
      const scene = repositoriesWith('yarn-berry')
      const app = join(scene.main, 'packages', 'app')
      mkdirSync(app, { recursive: true })
      for (const name of ['package.json', 'yarn.lock']) {
        writeFileSync(join(app, name), readFileSync(join(scene.main, name)))
      }
      expect(bothIn(app, LODASH)).toEqual({ ...AGREE, wrote: false })
    },
    CASE_TIMEOUT_MS,
  )
})
