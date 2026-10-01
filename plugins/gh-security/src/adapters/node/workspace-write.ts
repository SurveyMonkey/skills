// The writer of the `overrides:` block of pnpm-workspace.yaml (#159),
// ported from `workspace_overrides_write` in node.sh (#222). The awk there
// is the specification.
//
// The writer edits lines. It never makes the block again from its entries.
// An entry whose value changed is written again in its place, and a new
// entry goes at the end of the block, in the order of the final map. Each
// other line goes through byte for byte: other entries, comments, and the
// rest of the file. The writer then reads the block back, and the read must
// give the final map. So a shape that the writer cannot keep fails, and no
// file that pnpm reads in a different way ships. A block that the reader
// refuses after the write is a failure with the words of the reader.
//
// node.sh also refuses an entry that the final map does not hold. No caller
// makes that state: `apply_constraint` only adds and changes entries. So the
// port has no such check.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { hasWorkspaceOverrides } from './detect.ts'
import { equal } from './jq-json.ts'
import { entryOf, workspaceOverrides } from './workspace-overrides.ts'

// The awk patterns, with `[[:space:]]` spelled out.
const BLOCK_START = /^overrides:[ \t\n\v\f\r]*($|#)/
const BLOCK_END = /^[^ \t\n\v\f\r]/
const ENTRY_LINE = /^ {2}[^ \t\n\v\f\r]/

/** `yaml_quote`: a single-quoted scalar. */
const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** The lines that awk reads: a newline at the end of the text ends the last line. */
const linesOf = (text: string): string[] => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The changed entries, as awk reads them from the delta file. node.sh
 * writes each one as `key<TAB>value` on its own line. So a key or a value
 * with a line feed or a tab reads as awk reads it.
 */
const deltaOf = (
  current: Readonly<Record<string, string>>,
  final: Readonly<Record<string, string>>,
) => {
  const text = Object.entries(final)
    .filter(([key, value]) => !equal(Object.hasOwn(current, key) ? current[key] : null, value))
    .map(([key, value]) => `${key}\t${value}\n`)
    .join('')
  const order: string[] = []
  const want = new Map<string, string>()
  for (const line of linesOf(text)) {
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const key = line.slice(0, tab)
    order.push(key)
    want.set(key, line.slice(tab + 1))
  }
  return { empty: text === '', order, want }
}

/** The key of an entry line, or null for a line that `parse_entry` refuses. */
const keyOf = (line: string): string | null => {
  try {
    return entryOf(line).key
  } catch {
    return null
  }
}

/** The awk rewrite of the lines of the file. */
const rewrite = (
  text: string,
  order: readonly string[],
  want: ReadonlyMap<string, string>,
): string => {
  const done = new Set<string>()
  const out: string[] = []
  const entry = (key: string): string => `  ${quote(key)}: ${quote(want.get(key) as string)}`
  const pending = (): void => {
    for (const key of order) {
      if (done.has(key)) continue
      out.push(entry(key))
      done.add(key)
    }
  }
  let inBlock = false
  for (const line of linesOf(text)) {
    if (!inBlock && BLOCK_START.test(line)) {
      inBlock = true
      out.push(line)
      continue
    }
    if (inBlock && BLOCK_END.test(line)) {
      pending()
      inBlock = false
    }
    if (inBlock && ENTRY_LINE.test(line)) {
      const key = keyOf(line)
      if (key !== null && want.has(key)) {
        out.push(entry(key))
        done.add(key)
        continue
      }
    }
    out.push(line)
  }
  if (inBlock) pending()
  return out.map((line) => `${line}\n`).join('')
}

/**
 * `workspace_overrides_write`: give the block of pnpm-workspace.yaml at
 * `root` the entries of `final`. It writes nothing when no entry changes.
 * It throws with the words of node.sh. After a write, a block that reads
 * back as another map is a failure, and the file stays as written.
 */
export const writeWorkspaceOverrides = (
  root: string,
  final: Readonly<Record<string, string>>,
): void => {
  const path = join(root, 'pnpm-workspace.yaml')
  const current = Object.fromEntries(workspaceOverrides(root).map(({ key, value }) => [key, value]))
  const { empty, order, want } = deltaOf(current, final)
  if (empty) return
  let text = 'overrides:\n'
  if (statSync(path, { throwIfNoEntry: false })?.isFile() === true) {
    text = readFileSync(path, 'utf8')
    if (!hasWorkspaceOverrides(root)) {
      // A file with no newline at the end gets one first, so that the new
      // key starts its own line.
      if (text !== '' && !text.endsWith('\n')) text += '\n'
      text += 'overrides:\n'
    }
  }
  writeFileSync(path, rewrite(text, order, want))
  // A refusal of the read is the refusal of the call, as in node.sh.
  const read = Object.fromEntries(workspaceOverrides(root).map(({ key, value }) => [key, value]))
  if (!equal(read, final)) {
    throw new Error(
      'pnpm-workspace.yaml overrides: the block read back after writing does not match what was written. The file was left as rewritten for inspection, but treat the apply as failed.',
    )
  }
}
