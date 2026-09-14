// `env_prefix`, in one place. The four per-script `set_env_prefix`/`run_env`
// pairs (`fix-group.sh`, `audit-pins-driver.sh`, `post-agent.sh`,
// `render-pr.sh`) become this module, which the `gh` client and the git
// helpers both compose through.
//
// **The prefix is opaque, and that is the contract** (the plugin guide,
// "`env_prefix` is an opaque, optional seam"). It is a command prefix the
// user's environment requires, resolved once from session context by the
// dispatcher and threaded verbatim from there. Nothing here names an
// environment manager, probes for one, or invents a prefix of its own: a
// per-directory launcher invoked as `<tool> exec <dir>` is one thing a
// session might supply and an environment-injecting wrapper is another, and a
// module that knew either name would be making the assumption the guide
// forbids. `spec/env_prefix_seam_spec.sh` is the executable form of that
// rule: it greps this whole plugin for such a name. Absent means bare, which
// is the ordinary single-login case.
//
// It wraps a command, never a shell builtin, so it can never stand in for a
// `cd`: the request keeps its own `cwd`, and the prefix is composed after it.
//
// This file ships. It imports nothing outside the plugin.

import type { RunRequest } from './process-runner.ts'

/** An argv prefix: the command to run, then its own arguments. */
export type EnvPrefix = readonly string[]

/** No prefix. The environment needs none, or session context stated none. */
export const NO_ENV_PREFIX: EnvPrefix = []

/**
 * Read a prefix out of the one optional dispatch field that carries it.
 *
 * Split on whitespace, which is what the bash seam's `read -a` did, so the
 * same dispatch payload produces the same argv here. The literal string
 * `null` is no prefix: that is what a JSON null arrives as when it comes
 * through a state file, and treating it as a command named `null` would run
 * every `gh` call through a program that does not exist.
 */
export const parseEnvPrefix = (raw: string | null | undefined): EnvPrefix => {
  if (raw === null || raw === undefined) return NO_ENV_PREFIX
  const words = raw.split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 1 && words[0] === 'null') return NO_ENV_PREFIX
  return words
}

/**
 * Wrap a request in the prefix. With no prefix the request is returned
 * untouched, which is the bare invocation every environment that needs
 * nothing gets.
 */
export const withEnvPrefix = (prefix: EnvPrefix, request: RunRequest): RunRequest => {
  if (prefix.length === 0) return request
  const [command, ...prefixArgs] = prefix
  return {
    ...request,
    // `prefix.length` is non-zero, so the first element is there;
    // `noUncheckedIndexedAccess` cannot know that, and the fallback a
    // destructuring default would need is a branch nothing can reach.
    command: command as string,
    args: [...prefixArgs, request.command, ...request.args],
  }
}
