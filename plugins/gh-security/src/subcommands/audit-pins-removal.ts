// The removal of one pin from the override file: the one place where the pin
// audit edits a user's manifest. These are the ports of
// `manifest_remove_paths` and `workspace_remove_key` in
// `audit-pins-driver.sh` (deleted in #236).
//
// The removal is an edit in the driver, not a verb of the adapter. The
// writer of the adapter refuses to delete an entry that is already there
// (audit-driver.md, "The removal is an in-driver edit"). So the deleter of
// `pnpm-workspace.yaml` is here. It reads lines, as the awk does, over the
// flat `key: value` block that the writer of the adapter keeps. It refuses
// a line in the block that it cannot read as an entry.
//
// Each rule of the awk is kept as it is, because #327 stays out of this port
// (round 7 ruling 5). The deleter compares the key of each entry with the
// target as text. It removes each line whose key is the target, in each
// `overrides:` block of the file. When the file had one entry in all, it
// also removes the line of the last `overrides:` key.
//
// This file ships. It imports nothing outside the plugin.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, withKey, withoutKey } from '../adapters/node/jq-json.ts'
import { isRecord, NO_DOCUMENT, readManifest } from '../adapters/node/manifest.ts'
import { replaceFile } from '../adapters/node/replace-file.ts'
import { thrownText } from '../lib/envelope.ts'

/**
 * jq's `delpaths([path])` for a path of keys. A key that is not there
 * changes nothing, and so does a null on the way. jq stops on any other
 * value on the way, and so does this function.
 */
const deletePath = (value: unknown, path: readonly string[]): unknown => {
  if (value === null) return null
  const key = path[0] as string
  if (!isRecord(value))
    throw new Error(`Cannot delete field "${key}" of a value that is not an object`)
  if (!Object.hasOwn(value, key)) return value
  return path.length === 1
    ? withoutKey(value, key)
    : withKey(value, key, deletePath(value[key], path.slice(1)))
}

/**
 * Remove each pin at `paths` from the override block at `root` of
 * `package.json`, and nothing else. After each removal, each ancestor of the
 * path that is now an empty object goes too, from the deepest up to the
 * block itself, and never above it. So the last entry takes the whole block,
 * and an emptied `pnpm` key above `pnpm.overrides` stays.
 *
 * The file is written as `jq` writes it, with an indent of two spaces. A
 * file of only white space stays empty, as jq writes nothing for it. The
 * answer is null, or the text of the failure.
 */
export const removeManifestPaths = (
  worktree: string,
  root: readonly unknown[],
  paths: readonly (readonly string[])[],
): string | null => {
  const file = join(worktree, 'package.json')
  try {
    if (!root.every((segment) => typeof segment === 'string')) {
      throw new Error(`the override block's address ${render(root, null)} is not a list of keys`)
    }
    let document = readManifest(file)
    if (document !== NO_DOCUMENT) {
      for (const path of paths) {
        const full = [...(root as string[]), ...path]
        document = deletePath(document, full)
        for (let depth = full.length - 1; depth >= root.length; depth -= 1) {
          const ancestor = full.slice(0, depth)
          const at = ancestor.reduce<unknown>(
            (current, key) => (isRecord(current) ? current[key] : null),
            document,
          )
          if (isRecord(at) && Object.keys(at).length === 0)
            document = deletePath(document, ancestor)
        }
      }
    }
    replaceFile(
      file,
      document === NO_DOCUMENT ? '' : `${render(document, '  ')}\n`,
      `cannot replace ${file}`,
    )
    return null
  } catch (error) {
    return thrownText(error)
  }
}

// The awk patterns, with `[[:space:]]` spelled out.
const BLOCK_START = /^overrides:[ \t\n\v\f\r]*($|#)/
const BLOCK_END = /^[^ \t\n\v\f\r]/
const BLANK_OR_COMMENT = /^[ \t\n\v\f\r]*(#|$)/

/**
 * `strip_scalar` on a quoted key: the text between the quotes. A doubled
 * single quote in a single-quoted key is one quote.
 */
const unquote = (text: string): string =>
  text.startsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text.slice(1, -1)

/**
 * `key_of`: the key of one line of the block, or empty for a line that is
 * not an entry. The first two characters are the indent, whatever they are.
 */
const keyOf = (line: string): string => {
  const rest = line.slice(2)
  const quote = rest.charAt(0)
  if (quote === "'" || quote === '"') {
    const close = rest.slice(1).indexOf(`${quote}: `)
    return close === -1 ? '' : unquote(rest.slice(0, close + 2))
  }
  const colon = rest.indexOf(':')
  return colon === -1 ? '' : rest.slice(0, colon)
}

/**
 * Remove the entry `target` from the `overrides:` block of
 * `pnpm-workspace.yaml`, and the `overrides:` line with it when it was the
 * only entry. Each other line is kept byte for byte. The answer is the
 * status of the awk: 0 when it removed the entry, 1 for a block that it
 * refuses or a file that it cannot write, and 2 when the block has no such
 * entry or the file cannot be read.
 */
export const removeWorkspaceKey = (worktree: string, target: string): 0 | 1 | 2 => {
  const file = join(worktree, 'pnpm-workspace.yaml')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 2
  }
  // awk reads no record after the last newline.
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const drop = new Set<number>()
  let inBlock = false
  let blockLine = -1
  let entries = 0
  for (const [index, line] of lines.entries()) {
    if (inBlock && BLOCK_END.test(line)) inBlock = false
    if (!inBlock && BLOCK_START.test(line)) {
      inBlock = true
      blockLine = index
      continue
    }
    if (!inBlock || BLANK_OR_COMMENT.test(line)) continue
    const key = keyOf(line)
    if (key === '') return 1
    entries += 1
    if (key === target) drop.add(index)
  }
  if (drop.size === 0) return 2
  if (entries === 1) drop.add(blockLine)
  const kept = lines.filter((_, index) => !drop.has(index)).map((line) => `${line}\n`)
  try {
    replaceFile(file, kept.join(''), `cannot replace ${file}`)
  } catch {
    return 1
  }
  return 0
}
