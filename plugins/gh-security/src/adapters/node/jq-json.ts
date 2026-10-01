// The jq rules for JSON values that `apply_constraint` needs (#222). The
// passes of `verb_apply_constraint` in node.sh are jq programs. So the port
// reads and writes values as jq does: where jq stops, these functions throw,
// and where jq answers, they give the same answer.
//
// The values are the plain values of `JSON.parse`. Two jq answers are not
// kept, and each is a declared divergence:
//
//   - A key that is a whole number, such as "1", moves to the start of its
//     object. JavaScript orders those keys first. jq keeps the order of the
//     file.
//   - A number is written as JavaScript writes it. jq 1.7 and later keep the
//     text of a number from the file, such as `1.0`.
//
// A list where jq reads an object is a third case. jq reads the indexes of
// a list as its keys. These functions refuse a list that holds entries.
//
// This file ships. It imports nothing outside the plugin.

import { isRecord } from './manifest.ts'

/** jq's `type`. */
export const jqType = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

/** jq's `//`: `value`, or `fallback` when `value` is null or false. */
export const or = (value: unknown, fallback: unknown): unknown =>
  value === null || value === false ? fallback : value

/**
 * jq's `.[key]`: null for null or for an absent key. It throws where jq
 * stops, for a value that is not an object or null.
 */
export const get = (value: unknown, key: string): unknown => {
  if (value === null) return null
  if (!isRecord(value)) throw new Error(`cannot index a ${jqType(value)} with "${key}"`)
  return Object.hasOwn(value, key) ? value[key] : null
}

/** jq's `getpath`: null where the path ends at a null. */
export const getPath = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => get(current, key), value)

/**
 * jq's `.[key] = value`: a key that is there keeps its place, and a new key
 * goes last. Null becomes an object. `Object.fromEntries` keeps a
 * `__proto__` key as a key.
 */
export const withKey = (
  target: unknown,
  key: string,
  value: unknown,
): Readonly<Record<string, unknown>> => {
  if (target !== null && !isRecord(target)) {
    throw new Error(`cannot set "${key}" on a ${jqType(target)}`)
  }
  const entries = target === null ? [] : Object.entries(target)
  const index = entries.findIndex(([name]) => name === key)
  if (index === -1) entries.push([key, value])
  else entries[index] = [key, value]
  return Object.fromEntries(entries)
}

/** jq's `setpath`. */
export const setPath = (target: unknown, path: readonly string[], value: unknown): unknown => {
  const [key, ...rest] = path
  if (key === undefined) return value
  return withKey(target, key, setPath(get(target, key), rest, value))
}

/** jq's `del(.[key])`. Null stays null. */
export const withoutKey = (target: unknown, key: string): unknown => {
  if (target === null) return null
  if (!isRecord(target)) throw new Error(`cannot delete "${key}" from a ${jqType(target)}`)
  return Object.fromEntries(Object.entries(target).filter(([name]) => name !== key))
}

/** jq's `has(key)` on an object. It throws for any other value. */
export const has = (target: unknown, key: string): boolean => {
  if (!isRecord(target)) throw new Error(`cannot check a ${jqType(target)} for "${key}"`)
  return Object.hasOwn(target, key)
}

/**
 * jq's `to_entries`, as pairs. An empty list has none. A list that holds
 * entries is refused: jq gives number keys there, and no key of this port
 * is a number.
 */
export const entriesOf = (value: unknown): readonly (readonly [string, unknown])[] => {
  if (isRecord(value)) return Object.entries(value)
  if (Array.isArray(value) && value.length === 0) return []
  throw new Error(`cannot read the entries of a ${jqType(value)}`)
}

/**
 * jq's `add` over the blocks of a declaration, after `// {}`. Objects merge,
 * and a later object wins a key. Lists join. jq stops on a mix, and on a
 * text or a number that `to_entries` then reads.
 */
export const addBlocks = (blocks: readonly unknown[]): unknown => {
  if (blocks.every(isRecord)) {
    return Object.fromEntries(blocks.flatMap((block) => Object.entries(block)))
  }
  if (blocks.every(Array.isArray)) return blocks.flat()
  throw new Error('cannot add dependency blocks of different types')
}

/** jq's `==`: the same value. The order of the keys of an object does not count. */
export const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => equal(item, b[index]))
    )
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    )
  }
  return a === b
}

const RANK: Readonly<Record<string, number>> = {
  null: 0,
  boolean: 1,
  number: 2,
  string: 3,
  array: 4,
  object: 5,
}

/**
 * jq's order: null, false, true, numbers, texts, lists, objects. Texts sort
 * by UTF-16 unit here and by code point in jq, so the order differs only
 * for a character above U+FFFF. Two lists, or two objects, have no fixed
 * order here. jq sorts them by their contents.
 */
export const compare = (a: unknown, b: unknown): number => {
  const rank = (RANK[jqType(a)] as number) - (RANK[jqType(b)] as number)
  if (rank !== 0) return Math.sign(rank)
  if (a === b) return 0
  return (a as number | string) < (b as number | string) ? -1 : 1
}

/**
 * jq's `unique`: sorted, each value once. Two values are the same value when
 * jq's `==` says so, so two equal objects in a lockfile are one version.
 */
export const unique = <T>(values: readonly T[]): T[] => {
  const sorted = [...values].sort(compare)
  return sorted.filter((value, index) => sorted.findIndex((each) => equal(each, value)) === index)
}

/** jq's `split`: an empty text has no parts. It throws for a value that is not a text. */
export const split = (value: unknown, separator: string): string[] => {
  if (typeof value !== 'string') throw new Error(`cannot split a ${jqType(value)}`)
  return value === '' ? [] : value.split(separator)
}

/** jq's `test`. It throws for a value that is not a text. */
export const test = (value: unknown, pattern: RegExp): boolean => {
  if (typeof value !== 'string') throw new Error(`cannot match a ${jqType(value)}`)
  return pattern.test(value)
}

/** jq's `startswith`. It throws for a value that is not a text. */
export const startsWith = (value: unknown, prefix: string): boolean => {
  if (typeof value !== 'string') throw new Error(`cannot test the start of a ${jqType(value)}`)
  return value.startsWith(prefix)
}

/**
 * jq's `ltrimstr` on a text. It throws for any other value. jq 1.8 stops
 * there too, and jq 1.7 stops at the `split` that follows each use here.
 */
export const trimStart = (value: unknown, prefix: string): string =>
  startsWith(value, prefix) ? (value as string).slice(prefix.length) : (value as string)

/** A text as jq writes it: the escapes of `JSON.stringify`, and U+007F as `\u007f`. */
const textOf = (value: string): string => JSON.stringify(value).replaceAll('\u007f', '\\u007f')

/**
 * The JSON text of a value as jq writes it. `unit` is the text of one level
 * of indent, or null for `jq -c`.
 */
export const render = (value: unknown, unit: string | null, depth = 0): string => {
  if (typeof value === 'string') return textOf(value)
  if (!Array.isArray(value) && !isRecord(value)) return JSON.stringify(value)
  const items = Array.isArray(value)
    ? value.map((item) => render(item, unit, depth + 1))
    : Object.entries(value).map(
        ([key, item]) =>
          `${textOf(key)}:${unit === null ? '' : ' '}${render(item, unit, depth + 1)}`,
      )
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (items.length === 0) return `${open}${close}`
  if (unit === null) return `${open}${items.join(',')}${close}`
  const inner = unit.repeat(depth + 1)
  return `${open}\n${inner}${items.join(`,\n${inner}`)}\n${unit.repeat(depth)}${close}`
}

/** jq's `tostring`: a text as it is, any other value as `jq -c` writes it. */
export const toText = (value: unknown): string =>
  typeof value === 'string' ? value : render(value, null)

// `grep -m1 '^[[:space:]][[:space:]]*"'`, with `[[:space:]]` spelled out.
const INDENTED_KEY = /^[ \t\n\v\f\r]+"/

/**
 * `set_indent_args`: the indent of the first line that starts with white
 * space and then a quote. A tab gives `--tab`, four spaces give
 * `--indent 4`, and any other line, or no line, gives `--indent 2`.
 */
export const indentOf = (text: string): string => {
  const line = text.split('\n').find((each) => INDENTED_KEY.test(each)) ?? ''
  if (line.startsWith('\t')) return '\t'
  return line.startsWith('    ') ? '    ' : '  '
}
