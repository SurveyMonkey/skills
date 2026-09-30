// The reader of the `overrides:` block in `pnpm-workspace.yaml`, ported from
// `WORKSPACE_OVERRIDES_FUNCS`, `WORKSPACE_OVERRIDES_READER` and
// `workspace_overrides_json` in node.sh (#159, #221). The awk there is the
// specification.
//
// It is not a YAML parser. It reads the one shape that pnpm writes: a flat
// map of scalar entries, each on a line with two spaces of indent. For all
// other shapes it refuses and names the shape and the line. A wrong read
// gives a wrong override. Comment lines and blank lines in the block are
// read and skipped.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** An entry of the block: the key and the value, without their quotes. */
export type WorkspaceOverride = { readonly key: string; readonly value: string }

// The `[[:space:]]` class of awk is spelled out: JavaScript `\s` also
// matches Unicode space.
const TRAILING_SPACE = /[ \t\n\v\f\r]+$/
const LEADING_SPACE = /^[ \t\n\v\f\r]+/
const INLINE_COMMENT = /[ \t\n\v\f\r]#/
const BLOCK_END = /^[^ \t\n\v\f\r]/
const BLOCK_START = /^overrides:[ \t\n\v\f\r]*($|#)/
const BLANK_OR_COMMENT = /^[ \t\n\v\f\r]*(#|$)/
const ENTRY_LINE = /^ {2}[^ \t\n\v\f\r]/

/** A line that the reader refuses, with the words of `refuse`. */
class Refusal extends Error {}

/** `strip_scalar`: the value of a plain, single-quoted or double-quoted scalar. */
const scalarOf = (text: string): string => {
  const trimmed = text.replace(TRAILING_SPACE, '')
  if (/^'.*'$/s.test(trimmed)) return trimmed.slice(1, -1).replaceAll("''", "'")
  if (/^".*"$/s.test(trimmed)) {
    const inner = trimmed.slice(1, -1)
    if (inner.includes('\\')) throw new Refusal('a double-quoted scalar with backslash escapes')
    return inner
  }
  return trimmed
}

/**
 * `parse_entry`: the key and the value of one line of the block. A quoted key
 * ends at its closing quote, when a colon and a space follow it.
 */
const entryOf = (line: string): WorkspaceOverride => {
  const rest = line.slice(2)
  let key: string
  let raw: string
  // A throw from `scalarOf` for the key waits until the value checks are done,
  // because `parse_entry` checks the value before it returns that error.
  let keyRefusal: Refusal | null = null
  const quote = rest.charAt(0)
  if (quote === "'" || quote === '"') {
    const close = rest.indexOf(`${quote}: `, 1)
    if (close === -1) throw new Refusal('an entry whose quoted key never closes')
    try {
      key = scalarOf(rest.slice(0, close + 1))
    } catch (error) {
      keyRefusal = error as Refusal
      key = ''
    }
    raw = rest.slice(close + 2)
  } else {
    const colon = rest.indexOf(':')
    if (colon === -1) throw new Refusal('a line inside the block that is not a key: value entry')
    key = rest.slice(0, colon)
    raw = rest.slice(colon + 1)
  }
  const text = raw.replace(LEADING_SPACE, '')
  if (text.startsWith('#') || INLINE_COMMENT.test(text)) {
    throw new Refusal('an entry carrying an inline comment')
  }
  const value = scalarOf(text)
  if (keyRefusal !== null) throw keyRefusal
  if (value === '') throw new Refusal('an entry with no scalar value (a nested map or sequence)')
  if (/^[&*{[!]/.test(value)) throw new Refusal('an anchor, alias, tag or flow-style value')
  if (/^[|>][+-]?$/.test(value)) throw new Refusal('a block-scalar value')
  if (key === '') throw new Refusal('an entry with an empty key')
  return { key, value }
}

/** `WORKSPACE_OVERRIDES_READER` over the lines of the file. */
const readLines = (lines: readonly string[]): readonly WorkspaceOverride[] => {
  const entries: WorkspaceOverride[] = []
  const keys = new Set<string>()
  let inBlock = false
  let seen = false
  for (const [index, line] of lines.entries()) {
    const at = ` (pnpm-workspace.yaml line ${index + 1})`
    try {
      // The end of the block does not use up the line: it can be a second
      // `overrides:` key (#159 review).
      if (inBlock && BLOCK_END.test(line)) inBlock = false
      if (!inBlock && (line.startsWith("'overrides':") || line.startsWith('"overrides":'))) {
        throw new Refusal(
          'a quoted top-level overrides: key (write it unquoted so every reader of this file agrees on where the block is)',
        )
      }
      if (!inBlock && BLOCK_START.test(line)) {
        if (seen) throw new Refusal('a duplicate top-level overrides: key')
        inBlock = true
        seen = true
        continue
      }
      if (!inBlock && line.startsWith('overrides:')) {
        throw new Refusal('an overrides: key carrying an inline (flow-style) value')
      }
      if (!inBlock) continue
      if (BLANK_OR_COMMENT.test(line)) continue
      if (line.includes('\t')) {
        throw new Refusal(
          'a tab character on a line of the overrides block (this reader handles space-indented YAML only)',
        )
      }
      if (!ENTRY_LINE.test(line)) {
        throw new Refusal(
          'a line of the overrides block not indented with exactly two spaces (the form pnpm emits and the only one this reader accepts)',
        )
      }
      const entry = entryOf(line)
      if (keys.has(entry.key)) {
        throw new Refusal(
          `duplicate keys in the block ('${entry.key}'), which YAML readers resolve inconsistently`,
        )
      }
      keys.add(entry.key)
      entries.push(entry)
    } catch (error) {
      throw new Error(
        `pnpm-workspace.yaml overrides: cannot safely read the block: it contains ${(error as Refusal).message}${at}. Refusing to route overrides through a block this script cannot round-trip; simplify it to flat 'key: value' entries or edit it by hand.`,
      )
    }
  }
  return entries
}

/**
 * `workspace_overrides_json`: the entries of the block in `pnpm-workspace.yaml`
 * at `root`, in file order. No file, or a file with no block, has none. It
 * throws for a shape that it refuses, with the shape and the line in the
 * text, and for a file that it cannot read.
 */
export const workspaceOverrides = (root: string): readonly WorkspaceOverride[] => {
  const path = join(root, 'pnpm-workspace.yaml')
  if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `pnpm-workspace.yaml overrides: cannot read the file at all (not a shape problem; check that it exists and is readable from ${root}).`,
    )
  }
  // awk reads no record after the last newline.
  return readLines(text.replace(/\n$/, '').split('\n'))
}
