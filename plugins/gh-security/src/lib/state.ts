// The fix driver's state file, typed. This replaces six bash helpers
// (`state_get`, `state_get_opt`, `state_ok`, `state_json`, `state_set` and
// `state_set_str`) plus `load_state`, and it keeps the discipline every one
// of them was written to.
//
// **Three outcomes, never two.** A read distinguishes a value, a file that
// could not be read, and a key that is absent, null or empty. Collapsing the
// last two is how a `cleanup` came to report success having removed nothing:
// jq's status was discarded, a zero-byte state file passed the "does it
// exist" check, every caller got the empty string, and the run went on to
// `rm -rf` the work directory while the worktree registration under
// `<git-common-dir>/worktrees/` survived.
//
// **The reader that dies is not a separate helper here.** In bash the check
// had to be split in two, because a `die` inside a command substitution ends
// only the subshell and its error JSON lands in the variable it was meant to
// fill. A returned envelope has no subshell to be lost in, so there is one
// reader and there is deliberately no unchecked sibling to reach for.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs` and `path`.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Envelope, failure, type JsonObject, type JsonValue, ok } from './envelope.ts'

export interface StateFile {
  /** Where it was read from, quoted in every failure this module produces. */
  readonly path: string
  /** Its contents, already known to be a JSON object. */
  readonly data: JsonObject
}

export const stateFileName = 'state.json'

export const statePath = (workDir: string): string => join(workDir, stateFileName)

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const writeObject = (path: string, data: JsonObject): Envelope<StateFile> => {
  // Written through a temp file and renamed, exactly as the bash helper did:
  // a failed write cannot truncate the state a later step depends on.
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(temporary, path)
  } catch (error) {
    return failure(`cannot write the state file at ${path}: ${String(error)}`)
  }
  return ok({ path, data })
}

/** Write a new state file for a work directory. */
export const createState = (workDir: string, data: JsonObject): Envelope<StateFile> =>
  writeObject(statePath(workDir), data)

/**
 * Read the state file for a work directory.
 *
 * A file that is absent, unreadable, unparseable, or not a JSON object is a
 * failure with its own wording: a crashed `setup` leaves a zero-byte one, and
 * nothing here can tell an interrupted run from a foreign directory, so the
 * answer is to stop rather than to rerun over it.
 */
export const loadState = (workDir: string): Envelope<StateFile> => {
  const path = statePath(workDir)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return failure(`no readable state file at ${path}; run 'setup' first`)
  }
  let parsed: JsonValue
  try {
    parsed = JSON.parse(text) as JsonValue
  } catch {
    return failure(
      `the state file at ${path} could not be read: it is unparseable or truncated. ` +
        'Nothing was removed or deleted on its say-so.',
    )
  }
  if (!isObject(parsed)) {
    return failure(
      `the state file at ${path} is not a JSON object. A crashed 'setup' can leave a ` +
        'zero-byte one; inspect the work directory by hand rather than rerunning, because ' +
        'nothing here can tell an interrupted run from a foreign directory.',
    )
  }
  return ok({ path, data: parsed })
}

/** Walk a dotted key path. `undefined` means some segment was not there. */
const at = (data: JsonObject, path: string): JsonValue | undefined => {
  let cursor: JsonValue = data
  for (const segment of path.split('.')) {
    if (!isObject(cursor)) return undefined
    const next: JsonValue | undefined = cursor[segment]
    if (next === undefined) return undefined
    cursor = next
  }
  return cursor
}

/**
 * A value the state is required to carry.
 *
 * Absent and null are the same answer here, and both are failures: returning
 * null at success put the check in the code without the thing it checks for,
 * because absence became a value. A run interrupted before it wrote its
 * apply result then reported itself ready for a pull request naming no edit
 * at all. Where a null IS legitimate, the call site says so by reaching for
 * {@link readOptionalValue}.
 */
export const readValue = (state: StateFile, path: string): Envelope<JsonValue> => {
  const value = at(state.data, path)
  if (value === undefined || value === null) {
    return failure(
      `the state file at ${state.path} has no usable value for '${path}'. ` +
        'Run the earlier steps first; an absent or empty value is never read as a ' +
        'legitimate answer here.',
    )
  }
  return ok(value)
}

/** The same read, for a key whose absence the caller handles itself. */
export const readOptionalValue = (state: StateFile, path: string): JsonValue | null =>
  at(state.data, path) ?? null

/**
 * A string the state is required to carry. The empty string is not one: every
 * path this reads is a repository root, a worktree or a branch name, and
 * `git -C ""` silently operates on the current directory (#18).
 */
export const readString = (state: StateFile, path: string): Envelope<string> => {
  const value = readValue(state, path)
  if (value.outcome !== 'ok') return value
  if (typeof value.value !== 'string' || value.value === '') {
    return failure(
      `the state file at ${state.path} has no usable value for '${path}': ` +
        `expected a non-empty string, found ${JSON.stringify(value.value)}.`,
    )
  }
  return ok(value.value)
}

/**
 * The same read for a key whose empty value is legitimate, `env_prefix` being
 * the one the drivers have. Anything that is not a non-empty string is `null`,
 * which for this seam means "bare", the ordinary single-login case.
 */
export const readOptionalString = (state: StateFile, path: string): string | null => {
  const value = at(state.data, path)
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Set one top-level key, and answer with the state as it now is.
 *
 * One key per call, the way the helper it replaces worked: a step writes what
 * it learned and nothing else, so a later step reading a key an earlier one
 * never wrote gets the absence rather than a stale value from a rewritten
 * whole.
 */
export const writeKey = (state: StateFile, key: string, value: JsonValue): Envelope<StateFile> =>
  writeObject(state.path, { ...state.data, [key]: value })
