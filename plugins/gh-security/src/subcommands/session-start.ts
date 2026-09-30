// `gh-security session-start`: the SessionStart check of the tool table
// (`.claude/rules/path-hooks.md`). `hooks/session-start.ts` calls it.
//
// When all tools are present, it writes nothing. When one is missing, it
// writes one JSON object with `systemMessage` and `additionalContext`. It
// never writes plain text to stdout, and it returns success. When only the
// deadline passed, nothing is known to be missing, so the object has no
// `additionalContext`.
//
// A PATH scan does the lookup, so no child process starts. The scan has a
// deadline. A tool that the scan did not reach counts as present, because
// a false alert costs more than a late one. One extra line says that the
// check ran out of time.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs` and `path`.

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { CommandContext, CommandResult } from '../cli/command.ts'
import { DEPENDENCIES, NODE_TOOL } from '../dependency-table.ts'
import { absentDependencies, type Dependency } from '../lib/dependencies.ts'
import { emit } from '../lib/hook-output.ts'
import { meetsNodeFloor } from '../lib/node-floor.ts'

/** The time that the scan may take, in milliseconds. The hook timeout is 3 seconds. */
export const DEADLINE_MS = 1_500

export const PREFIX = 'gh-security'

/** What the check reads from the machine. A test replaces each part. */
export interface Edges {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly version: string
  readonly executable: (path: string) => boolean
  /** A monotonic clock, in milliseconds. */
  readonly now: () => number
}

/** Whether `path` is an executable file. A directory is not. */
export const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return !statSync(path).isDirectory()
  } catch {
    return false
  }
}

const problem = (text: string): string => `${PREFIX}: ⚠️ ${text}`

/**
 * The text to write to stdout: empty when every tool is present.
 *
 * The node row uses `meetsNodeFloor`. Every other row is a PATH lookup,
 * with the empty entries left out.
 */
export const sessionStartOutput = (
  table: readonly Dependency[],
  edges: Edges,
  deadlineMs: number,
): string => {
  const started = edges.now()
  let expired = false
  const present = (tool: string): boolean => {
    if (tool === NODE_TOOL) return meetsNodeFloor(edges.version)
    for (const directory of (edges.env.PATH ?? '').split(delimiter)) {
      if (edges.now() - started >= deadlineMs) {
        expired = true
        return true
      }
      if (directory !== '' && edges.executable(join(directory, tool))) return true
    }
    return false
  }

  const absent = absentDependencies(table, present)
  const lines = absent.map((dependency) => problem(`${dependency.label} is missing`))
  if (expired) lines.push(problem('the tool check ran out of time'))
  if (lines.length === 0) return ''
  const context =
    absent.length === 0
      ? undefined
      : `Missing: ${absent.map((dependency) => dependency.label).join('; ')}. ` +
        'The gh-security plugin cannot run.'
  return emit(PREFIX, lines.join('\n'), context)
}

export const sessionStartCommand = (context: CommandContext): CommandResult => {
  const text = sessionStartOutput(
    DEPENDENCIES,
    {
      env: context.env,
      version: process.version,
      executable: isExecutableFile,
      now: () => performance.now(),
    },
    DEADLINE_MS,
  )
  if (text !== '') context.io.stdout(text)
  return undefined
}
