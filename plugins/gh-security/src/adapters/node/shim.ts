// `shim` for the node adapter, ported from `verb_shim` in node.sh (#222). It
// is a write verb, so the worktree guard is its first statement (ADR 001,
// "Invocation").
//
// Some repository scripts call the bare name of the package manager. That
// fails when the manager runs through corepack or a vendored release, and no
// binary is on PATH. So the verb writes `<dir>/<pm>`, a shell script that
// starts the runner. The caller puts `dir` first on PATH. When the manager
// is on PATH already, the verb writes nothing.
//
// The runner is the `pm_exec` of the detection, or the runner that the
// caller names (the test seam of node.sh). A vendored runner, `node
// .yarn/...`, is relative to the root, and the shim runs from any
// directory. So the verb makes that runner absolute. A relative `dir` is
// relative to the root, and the answer names `dir` as it is given. The shim
// file gets mode 0755. node.sh gets the same mode from `chmod +x` under a
// umask of 022. The verb does not run `detect`.
//
// This file ships. It imports nothing outside the plugin.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { type Envelope, failed, ok } from '../../lib/envelope.ts'
import { requireLinkedWorktree } from '../../worktree.ts'
import type { ShimAnswer, ShimOptions, Tree } from '../adapter.ts'
import { type NodeDetection, onPath } from './detect.ts'

const VENDORED = 'node .yarn/'

/** `verb_shim`. */
export const shim = (
  { root, detection }: Tree<NodeDetection>,
  dir: string,
  { env, runner: given = '' }: ShimOptions,
): Envelope<ShimAnswer> => {
  const guard = requireLinkedWorktree(root, "refusing to run 'shim' here")
  if (guard.outcome !== 'ok') return guard
  if (dir === '') return failed('shim requires a target directory')
  const { pm, pm_exec } = detection
  // node.sh reads an empty runner as no runner (`${2:-}`). It writes no shim
  // when its runner is the bare name and that name is on PATH. With one PATH
  // for `detect` and `shim`, a manager on PATH is its own runner, so the PATH
  // test is enough.
  if (given === '' && onPath(pm, root, env)) {
    return ok({ created: false, pm, reason: `${pm} is already on PATH` })
  }
  const named = given === '' ? pm_exec : given
  const runner = named.startsWith(VENDORED) ? `node ${root}/${named.slice('node '.length)}` : named
  const directory = resolve(root, dir)
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return failed(`cannot create shim directory: ${dir}`)
  }
  const shimFile = `${dir}/${pm}`
  try {
    writeFileSync(join(directory, pm), `#!/bin/sh\nexec ${runner} "$@"\n`)
    chmodSync(join(directory, pm), 0o755)
  } catch {
    return failed(`cannot write shim: ${shimFile}`)
  }
  return ok({ created: true, pm, shim: shimFile, path_prefix: dir, runner })
}
