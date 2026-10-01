// `gh-security detect-scope [--env-prefix <prefix>] [<path>]`: decide whether a
// path is inside a git repository, and say which. This is the port of
// `scripts/common/detect-scope.sh`.
//
// Output: `{scope, owner, repo, nwo, path, git_remote, default_branch}`.
//
// Scope comes from git, never from the names of directories. Inside a
// repository (`git rev-parse --show-toplevel` succeeds) the scope is `repo`,
// and `nwo` is parsed from the URL of `origin`, which is its only source. A
// null `scope` is an answer and not an error. A bare repository answers a null
// scope, because it has no work tree. A linked worktree answers `repo`.
//
// `owner`, `repo` and `nwo` are null in a repository with no `origin`, and in
// one whose URL gives no `<owner>/<name>` pair. **Only a URL with a host
// yields an nwo, and only when its path has exactly two segments.** A local
// path, a `file://` URL and a relative remote name no host. A deeper path is
// not a GitHub repository. Each of those answers null, because a made-up
// `src/other-repo` reads downstream as a real repository.
//
// **`default_branch` comes from GitHub when the remote host is `github.com`**
// (#167, rulings 5 and 11 on #225). The `nwo` field does not depend on the
// host. The local `origin/HEAD` symref is written once, at clone time, and
// `git fetch` never refreshes it. A branch that is renamed on GitHub then
// stays wrong in each older checkout, with no sign. A failed read from GitHub
// is an error. It is never a fall back to the symref, because the symref is
// the value that cannot be trusted. A repository with no default branch on
// GitHub gives a null `default_branch`. The read names the host, because a
// bare `OWNER/REPO` follows `GH_HOST`, and could ask another server.
//
// With no nwo, or with a host that is not `github.com`, there is no GitHub
// repository to ask. A name on another host can also exist on `github.com`,
// where it is a different repository. The command then reads the `origin/HEAD`
// symref. When there is an `origin`, it then runs `git remote show origin`, as
// the script does. It never writes: `git remote set-head` is a write. The value
// is null when both fail, and a caller that needs the branch must stop.
//
// `--env-prefix` is the opaque command prefix that the environment needs
// (issue #193). It wraps the runner for `git` and for `gh`, so each runs as
// `<prefix> git ...` and `<prefix> gh ...`. Only `git remote show origin` and
// the GitHub call reach the network, and they need an identity. Nothing here
// names a tool, or looks for one.
//
// Differences from the script:
//   - The default branch comes from GitHub for a `github.com` remote, as
//     above. This is the main difference in the answers of a working checkout.
//   - `HEAD branch: (unknown)`, which git writes for a remote with no HEAD,
//     gives a null `default_branch`. The script answers the text `(unknown)`.
//   - `git remote show` runs with `LC_ALL=C`, so git writes `HEAD branch` in
//     English. The script reads the language of the caller.
//   - A leading dash is an option, as in every command here.
//   - A failure is `{"error": ...}` on stdout and prose on stderr, as
//     `cli.md` says. The script has no failure of its own.
//
// This file ships. It imports nothing outside the plugin.

import type { CommandContext, CommandHandler, CommandResult } from '../cli/command.ts'
import { parseCommandLine } from '../lib/args.ts'
import { parseEnvPrefix, withEnvPrefix } from '../lib/env-prefix.ts'
import { failed, ok } from '../lib/envelope.ts'
import { createGhClient, type GhClient, type GhClientOptions, GhError } from '../lib/gh.ts'
import { type Runner, run } from '../lib/process.ts'

/** How a `gh` client is made. A test gives its own. */
export type ClientFactory = (options: GhClientOptions) => GhClient

/** Text with its trailing newlines removed, as `$( )` removes them. */
const chomp = (text: string): string => text.replace(/\n+$/, '')

/**
 * The owner and the name in the URL of a remote, or null.
 *
 * The URL has a host in two forms: `scheme://[user[:pass]@]host[:port]/path`,
 * and the scp form `[user@]host:path`, which also covers an alias of an ssh
 * configuration. Anything else has no host. The path must have exactly two
 * segments, because the last two of a deeper path make a wrong, plausible
 * pair.
 */
export const parseRemote = (
  remote: string,
): { host: string; owner: string; repo: string } | null => {
  let url = remote
  if (url.endsWith('/')) url = url.slice(0, -1)
  if (url.endsWith('.git')) url = url.slice(0, -'.git'.length)
  if (url.endsWith('/')) url = url.slice(0, -1)

  let host = ''
  let path = ''
  const scheme = url.indexOf('://')
  if (scheme >= 0) {
    const rest = url.slice(scheme + '://'.length)
    const slash = rest.indexOf('/')
    if (slash >= 0) {
      host = rest.slice(0, slash)
      path = rest.slice(slash + 1)
    }
  } else {
    const colon = url.indexOf(':')
    if (colon >= 0) {
      host = url.slice(0, colon)
      path = url.slice(colon + 1)
      // A colon inside a path (`/tmp/we:ird/a/b`) is not a host separator.
      if (host.includes('/')) host = ''
    }
  }
  host = host.slice(host.lastIndexOf('@') + 1)
  const port = host.indexOf(':')
  if (port >= 0) host = host.slice(0, port)

  if (path.split('/').length !== 2) return null
  const cut = path.indexOf('/')
  const owner = path.slice(0, cut)
  const repo = path.slice(cut + 1)
  return host === '' || owner === '' || repo === '' ? null : { host, owner, repo }
}

const ORIGIN_PREFIX = 'refs/remotes/origin/'
const HEAD_BRANCH = 'HEAD branch: '

/** The name that `remote show` gives to a remote that has no HEAD. */
const UNKNOWN_HEAD = '(unknown)'

/** The one host that the GitHub read serves. The match ignores case, as DNS does. */
const GITHUB_HOST = 'github.com'

/**
 * The handler. The `gh` client factory, the process runner and the working
 * directory are parameters: an example gives a mock client, or a runner that
 * records its argv.
 */
export const detectScope = async (
  context: CommandContext,
  makeClient: ClientFactory,
  spawn: Runner,
  cwd: string,
): Promise<CommandResult> => {
  const parsed = parseCommandLine(context.args, { 'env-prefix': { type: 'string', default: '' } })
  if (parsed.outcome !== 'ok') return parsed
  const { options, positionals } = parsed.value

  const prefix = parseEnvPrefix(options['env-prefix'])
  const prefixed: Runner = (command, args = [], runOptions) => {
    const line = withEnvPrefix(prefix, { command, args })
    return spawn(line.command, line.args, runOptions)
  }

  const given = positionals[0] || cwd
  const target = given.startsWith('/') ? given : `${cwd}/${given}`
  const git = (args: readonly string[], env: NodeJS.ProcessEnv = context.env) =>
    prefixed('git', ['-C', target, ...args], { env })

  // The whole scope decision. A path in no repository, and a path that does
  // not exist, both answer as "not a repository".
  if ((await git(['rev-parse', '--show-toplevel'])).status !== 0) {
    return ok({
      scope: null,
      owner: null,
      repo: null,
      nwo: null,
      path: target,
      git_remote: null,
      default_branch: null,
    })
  }

  const remote = await git(['remote', 'get-url', 'origin'])
  const gitRemote = remote.status === 0 ? chomp(remote.stdout) : ''
  const pair = parseRemote(gitRemote)
  const nwo = pair === null ? null : `${pair.owner}/${pair.repo}`

  let defaultBranch = ''
  if (pair !== null && pair.host.toLowerCase() === GITHUB_HOST) {
    try {
      const view = await makeClient({ env: context.env, run: prefixed }).viewDefaultBranch({
        repository: `${GITHUB_HOST}/${pair.owner}/${pair.repo}`,
      })
      defaultBranch = view.name ?? ''
    } catch (error) {
      if (!(error instanceof GhError)) throw error
      return failed(`could not read the default branch of ${nwo} from GitHub: ${error.detail}`)
    }
  } else {
    const symref = await git(['symbolic-ref', `${ORIGIN_PREFIX}HEAD`])
    if (symref.status === 0) {
      const ref = chomp(symref.stdout)
      defaultBranch = ref.startsWith(ORIGIN_PREFIX) ? ref.slice(ORIGIN_PREFIX.length) : ref
    }
    if (defaultBranch === '' && gitRemote !== '') {
      const shown = await git(['remote', 'show', 'origin'], { ...context.env, LC_ALL: 'C' })
      const line = shown.stdout.split('\n').find((text) => text.includes(HEAD_BRANCH))
      const branch =
        line === undefined ? '' : line.slice(line.lastIndexOf(HEAD_BRANCH) + HEAD_BRANCH.length)
      defaultBranch = branch === UNKNOWN_HEAD ? '' : branch
    }
  }

  return ok({
    scope: 'repo',
    owner: pair === null ? null : pair.owner,
    repo: pair === null ? null : pair.repo,
    nwo,
    path: target,
    git_remote: gitRemote === '' ? null : gitRemote,
    default_branch: defaultBranch === '' ? null : defaultBranch,
  })
}

export const detectScopeCommand: CommandHandler = (context) =>
  detectScope(context, createGhClient, run, process.cwd())
