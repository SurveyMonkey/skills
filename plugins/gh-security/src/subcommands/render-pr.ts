// `gh-security render-pr <verb> [options]`: the commit message, the PR body,
// the labels and the `gh pr create` call of one dependency-fix group. This is
// the port of `scripts/common/render-pr.sh` (#233). The text is a template
// over typed inputs (`src/render/`), and not a join of jq strings.
//
//   render-pr commit-msg --state <file> --group-json <file> --repo <nwo>
//   render-pr body       --state <file> --group-json <file> --repo <nwo>
//                        [--collateral-note <file>] [--global-override-note <file>]
//   render-pr labels     --repo <nwo> --band <low|medium|high> [--label <name>]...
//                        [--env-prefix "<string>"]
//   render-pr create     --repo <nwo> --head <branch> --title <string> --body-file <file>
//                        --band <low|medium|high> [--label <name>]... [--env-prefix "<string>"]
//
// `--state` is the `ready_for_pr` answer of `fix-group score`. `--group-json`
// is the group that `fix-group setup` was given. `commit-msg` and `body` run
// no child. They write the text itself on stdout, and not a JSON string. The
// commit message and the body are the files that a caller needs. A caller
// that gets them as JSON must unwrap them. When a check fails, no part of
// the text is written. A failure is `{"error": ...}` on stdout, as for every
// command, with the message on stderr.
//
// `labels` and `create` run `gh label create` and `gh pr create`, through
// the `gh` client (`lib/gh.ts`). `create` never passes `--draft`: a PR opens
// ready for review (ADR 008). A required narrative note that is missing is an
// error, and never prose that the command made up.
//
// `--env-prefix` is the opaque command prefix that the environment needs
// (#193). It wraps the runner that the `gh` client uses, so `gh` runs as
// `<prefix> gh ...`. Nothing here names a tool, or looks for one.
//
// Differences from the script, each declared with #233:
//   - A failure writes its message on stderr without the `render-pr: ` prefix
//     that the script gave it. The same message is in the JSON.
//   - A usage failure names the command, `gh-security render-pr`.
//   - The `gh` client turns a failure into its detail: the stderr of `gh`, or
//     `gh exited <status>` when stderr is empty (#302). The script quoted
//     stdout when stderr was empty, and stdout and stderr together for
//     `gh pr create`.
//   - A `gh pr create` that exits 0 with no URL fails as
//     `gh pr create failed: gh answered gh pr create with no pull request
//     URL: ...`. The script said `produced no PR URL`.
//   - A note file that is not UTF-8 text is read with U+FFFD for each bad
//     sequence, as `jq` read a JSON file. `cat` passed the bytes of a note.
//     A note file is written as it is, and so are its line breaks.
//   - A note file that cannot be read is an error, also when the state does
//     not need the note. The script checked only that the file was there.
//   - A `--env-prefix` with no value is an error. The script looped for ever.
//   The differences of the rendered text are in `src/render/`.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync, statSync } from 'node:fs'

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { type Envelope, failed, ok } from '../lib/envelope.ts'
import { createGhClient, type GhClient, type GhClientOptions, GhError } from '../lib/gh.ts'
import { type Runner, run } from '../lib/process.ts'
import { withoutBom } from '../merge-risk/score.ts'
import { commitMessage } from '../render/commit-message.ts'
import { prBody } from '../render/pr-body.ts'
import { readBodyInputs, readCommitInputs } from '../render/pr-inputs.ts'

const USAGE = 'usage: gh-security render-pr <commit-msg|body|labels|create> [options]'

/** How a `gh` client is made. A test gives its own. */
export type ClientFactory = (options: GhClientOptions) => GhClient

/** The flags of each verb that take a value. `--label` may repeat. */
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  'commit-msg': ['--state', '--group-json', '--repo'],
  body: ['--state', '--group-json', '--repo', '--collateral-note', '--global-override-note'],
  labels: ['--repo', '--band', '--label', '--env-prefix'],
  create: ['--repo', '--head', '--title', '--body-file', '--band', '--label', '--env-prefix'],
}

/** The flags that take no value check, because an empty value means none. */
const MAY_BE_EMPTY = '--env-prefix'

interface Options {
  readonly values: ReadonlyMap<string, string>
  /** Each `--label`, in the order given. */
  readonly labels: readonly string[]
}

/**
 * Read the flags of one verb, in pairs. A flag that the verb does not have is
 * an error, and so is a flag with no value. The last of a repeated flag wins,
 * except `--label`, which collects.
 */
const parseOptions = (verb: string, args: readonly string[]): Envelope<Options> => {
  const flags = FLAGS[verb] as readonly string[]
  const values = new Map<string, string>()
  const labels: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string
    if (!flags.includes(flag)) return failed(`${verb}: unknown option '${flag}'`)
    const value = args[index + 1]
    if (value === undefined || (value === '' && flag !== MAY_BE_EMPTY)) {
      return failed(`${flag} requires a value`)
    }
    if (flag === '--label') labels.push(value)
    else values.set(flag, value)
  }
  return ok({ values, labels })
}

/** The value of a flag, or the empty text when it was not given. */
const flagOf = (options: Options, flag: string): string => options.values.get(flag) ?? ''

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `need_file`: the flag has a value, and the value names a file. */
const needFile = (flag: string, path: string): Envelope<string> => {
  if (path === '') return failed(`${flag} requires a file`)
  return isFile(path) ? ok(path) : failed(`${flag}: no such file: ${path}`)
}

/** A JSON file, or `undefined` for a file that cannot be read or parsed. A byte order mark is ignored, as `jq` ignores it. */
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(withoutBom(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/** A note, as it is. A file that cannot be read is an error that names it. */
const readNote = (flag: string, path: string): Envelope<string> => {
  try {
    return ok(readFileSync(path, 'utf8'))
  } catch (error) {
    return failed(`${flag}: cannot read ${path}: ${(error as Error).message}`)
  }
}

/** The two files that `commit-msg` and `body` read, once each flag has its file. */
interface Inputs {
  readonly state: unknown
  readonly group: unknown
  readonly files: { readonly state: string; readonly group: string }
  readonly repo: string
}

const readInputs = (verb: string, options: Options): Envelope<Inputs> => {
  const state = needFile('--state', flagOf(options, '--state'))
  if (state.outcome !== 'ok') return state
  const group = needFile('--group-json', flagOf(options, '--group-json'))
  if (group.outcome !== 'ok') return group
  const repo = flagOf(options, '--repo')
  if (repo === '') return failed(`${verb} requires --repo`)
  return ok({
    state: readJson(state.value),
    group: readJson(group.value),
    files: { state: state.value, group: group.value },
    repo,
  })
}

/** The text of a verb that writes text. Nothing is written for a failure. */
const writeText = (context: CommandContext, text: Envelope<string>): CommandResult => {
  if (text.outcome !== 'ok') return text
  context.io.stdout(text.value)
  return undefined
}

const commitMsg = (options: Options): Envelope<string> => {
  const inputs = readInputs('commit-msg', options)
  if (inputs.outcome !== 'ok') return inputs
  const read = readCommitInputs(inputs.value.state, inputs.value.group, inputs.value.files)
  return read.outcome === 'ok' ? ok(commitMessage(read.value, inputs.value.repo)) : read
}

const body = (options: Options): Envelope<string> => {
  const inputs = readInputs('body', options)
  if (inputs.outcome !== 'ok') return inputs
  // A note file must exist whether or not this state needs it. The script
  // checked that both were there, the collateral note first, before it read
  // one.
  const given = (
    [
      ['--collateral-note', 'collateral'],
      ['--global-override-note', 'override'],
    ] as const
  ).filter(([flag]) => flagOf(options, flag) !== '')
  for (const [flag] of given) {
    const file = needFile(flag, flagOf(options, flag))
    if (file.outcome !== 'ok') return file
  }
  const notes: { override?: string; collateral?: string } = {}
  for (const [flag, key] of given) {
    const text = readNote(flag, flagOf(options, flag))
    if (text.outcome !== 'ok') return text
    notes[key] = text.value
  }
  const read = readBodyInputs(inputs.value.state, inputs.value.group, inputs.value.files, {
    override: notes.override,
    collateral: notes.collateral,
  })
  return read.outcome === 'ok' ? ok(prBody(read.value, inputs.value.repo)) : read
}

/** The color and the description of each band's label, as `labels` made them. */
const BANDS: Readonly<Record<string, readonly [string, string]>> = {
  low: ['2da44e', 'Low merge risk'],
  medium: ['d4a72c', 'Medium merge risk'],
  high: ['cf222e', 'High merge risk'],
}

/** The band in lower case. The names of the bands are ASCII, so no other letter can match one. */
const bandOf = (options: Options): string => flagOf(options, '--band').toLowerCase()

/** The client of one call, with the env prefix in front of `gh`. */
const clientFor = (
  context: CommandContext,
  options: Options,
  makeClient: ClientFactory,
  spawn: Runner,
): GhClient => {
  const prefix = parseEnvPrefix(flagOf(options, '--env-prefix'))
  const prefixed: Runner = (command, args = [], runOptions) => {
    const line = withEnvPrefix(prefix, { command, args })
    return spawn(line.command, line.args, runOptions)
  }
  return makeClient({ env: context.env, run: prefixed })
}

/** One `gh` call that can fail, as the message of the call or nothing. A defect of the call goes on. */
const attempt = async (what: string, call: () => Promise<unknown>): Promise<string | null> => {
  try {
    await call()
    return null
  } catch (error) {
    if (!(error instanceof GhError)) throw error
    return `${what} failed: ${error.detail}`
  }
}

const labels = async (
  context: CommandContext,
  options: Options,
  makeClient: ClientFactory,
  spawn: Runner,
): Promise<CommandResult> => {
  const repository = flagOf(options, '--repo')
  if (repository === '') return failed('labels requires --repo')
  const band = bandOf(options)
  const facts = Object.hasOwn(BANDS, band) ? BANDS[band] : undefined
  if (facts === undefined) {
    return failed(`labels: --band must be low, medium, or high, got '${flagOf(options, '--band')}'`)
  }
  const client = clientFor(context, options, makeClient, spawn)
  // `gh pr create` fails outright on a label that does not exist, so every
  // label that `create` passes is made here first. A name that this
  // repository has never seen gets a neutral color and a generic description.
  const wanted: readonly (readonly [string, string, string])[] = [
    ['security', 'D93F0B', 'Security fix'],
    ['dependencies', '0366d6', 'Pull requests that update a dependency file'],
    [`merge-risk:${band}`, ...facts],
    ...options.labels.map(
      (name) => [name, 'ededed', "Required by this repository's own conventions"] as const,
    ),
  ]
  for (const [name, color, description] of wanted) {
    const failure = await attempt(`gh label create ${name}`, () =>
      client.createLabel({ repository, name, color, description }),
    )
    if (failure !== null) return failed(failure)
  }
  return ok({ status: 'ok', labels: wanted.map(([name]) => name) })
}

const create = async (
  context: CommandContext,
  options: Options,
  makeClient: ClientFactory,
  spawn: Runner,
): Promise<CommandResult> => {
  const repository = flagOf(options, '--repo')
  if (repository === '') return failed('create requires --repo')
  const head = flagOf(options, '--head')
  if (head === '') return failed('create requires --head')
  const title = flagOf(options, '--title')
  if (title === '') return failed('create requires --title')
  const bodyFile = needFile('--body-file', flagOf(options, '--body-file'))
  if (bodyFile.outcome !== 'ok') return bodyFile
  const band = bandOf(options)
  if (!Object.hasOwn(BANDS, band)) {
    return failed(`create: --band must be low, medium, or high, got '${flagOf(options, '--band')}'`)
  }
  const client = clientFor(context, options, makeClient, spawn)
  let url = ''
  const failure = await attempt('gh pr create', async () => {
    url = (
      await client.createPullRequest({
        repository,
        head,
        labels: ['security', 'dependencies', `merge-risk:${band}`, ...options.labels],
        title,
        bodyFile: bodyFile.value,
      })
    ).url
  })
  return failure === null ? ok({ status: 'ok', pr_url: url }) : failed(failure)
}

/**
 * The handler. The `gh` client factory and the process runner are
 * parameters: an example gives a mock client, or a runner that records its
 * argv.
 */
export const renderPr = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
): Promise<CommandResult> => {
  const [verb, ...args] = context.args
  if (verb === undefined || verb === '') return failed(USAGE)
  if (!Object.hasOwn(FLAGS, verb)) return failed(`render-pr: unknown subcommand '${verb}'`)
  const options = parseOptions(verb, args)
  if (options.outcome !== 'ok') return options
  switch (verb) {
    case 'commit-msg':
      return writeText(context, commitMsg(options.value))
    case 'body':
      return writeText(context, body(options.value))
    case 'labels':
      return labels(context, options.value, makeClient, spawn)
    default:
      return create(context, options.value, makeClient, spawn)
  }
}

export const renderPrCommand: CommandHandler = (context) => renderPr(context, createGhClient, run)
