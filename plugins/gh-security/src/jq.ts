// The parts of jq that the discovery scripts read alerts and lines with, as
// functions. `discover-alerts` and `classify-lines` are ports of two jq
// programs. Each sorts, groups and trims as jq does, so each uses these
// functions, and the two ports give the same order and the same text.
//
// The probes for each rule ran against jq 1.8.1. CI runs jq 1.7. Where the
// two versions read a value differently, the comment says so.
//
// This file ships. It imports nothing outside the plugin.

/** The rank of each JSON type in jq's order. */
const typeRank = (value: unknown): number => {
  if (value === null) return 0
  if (value === false) return 1
  if (value === true) return 2
  if (typeof value === 'number') return 3
  if (typeof value === 'string') return 4
  return Array.isArray(value) ? 5 : 6
}

/**
 * jq's order of two JSON values: null, false, true, numbers, strings, arrays,
 * then objects. Text is in the order of its UTF-8 bytes, which is the order
 * of its code points. JavaScript's own `<` compares UTF-16 units, which puts
 * a character above U+FFFF before U+E000 to U+FFFF. Arrays compare entry by
 * entry, and then by length. Objects compare their sorted keys first, and
 * then their values in key order.
 */
export const compareJq = (a: unknown, b: unknown): number => {
  const rank = typeRank(a) - typeRank(b)
  if (rank !== 0) return rank
  if (typeof a === 'number') return Math.sign(a - (b as number))
  if (typeof a === 'string') return Buffer.compare(Buffer.from(a), Buffer.from(b as string))
  if (Array.isArray(a)) {
    const other = b as unknown[]
    for (let index = 0; index < Math.min(a.length, other.length); index += 1) {
      const order = compareJq(a[index], other[index])
      if (order !== 0) return order
    }
    return Math.sign(a.length - other.length)
  }
  if (typeof a === 'object' && a !== null) {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left).sort(compareJq)
    const order = compareJq(keys, Object.keys(right).sort(compareJq))
    if (order !== 0) return order
    for (const key of keys) {
      const value = compareJq(left[key], right[key])
      if (value !== 0) return value
    }
  }
  return 0
}

/** jq's `sort`. The sort is stable, as jq's is. */
export const sortJq = <T>(values: readonly T[]): T[] => [...values].sort(compareJq)

/** jq's `unique`: sorted, and each value once. */
export const uniqueJq = <T>(values: readonly T[]): T[] =>
  sortJq(values).filter(
    (value, index, sorted) => index === 0 || compareJq(sorted[index - 1], value) !== 0,
  )

/** jq's `tostring`: text as it is, and any other value as its JSON text. */
export const tostring = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value)

/** jq's `//`: the value, unless it is null, false or not there. */
export const orElse = (value: unknown, fallback: unknown): unknown =>
  value === undefined || value === null || value === false ? fallback : value

/**
 * A field of a JSON value, as jq's `.name` reads it. Null and an object
 * without the field give null. jq stops with an error for any other value,
 * and so does this function.
 */
export const fieldOf = (value: unknown, name: string): unknown => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`cannot read the field ${JSON.stringify(name)} of ${JSON.stringify(value)}`)
  }
  // An own field only: `constructor` would otherwise find a member of
  // `Object.prototype`.
  return Object.hasOwn(value, name) ? (value as Record<string, unknown>)[name] : null
}

/** A path of fields, as jq's `.a.b.c` reads it. */
export const pathOf = (value: unknown, ...names: readonly string[]): unknown =>
  names.reduce<unknown>((at, name) => fieldOf(at, name), value)

/**
 * The `[[:space:]]` class of jq's regex engine. A probe showed that it holds
 * U+00A0, U+0085, U+2028 and U+3000. That is the Unicode `White_Space`
 * property, and not JavaScript's `\s`, which has U+FEFF and not U+0085.
 */
const LEADING_SPACE = /^\p{White_Space}+/u
const TRAILING_SPACE = /\p{White_Space}+$/u

/**
 * A plain major number, as jq's `test("^[0-9]+$")` reads it. A probe showed
 * that jq's `$` also matches before one line break at the end of the text.
 */
const PLAIN_NUMBER = /^[0-9]+\n?$/

/**
 * The major of a version, by the rule of `line_of` in `discover-alerts.sh`
 * and `major_of` in `classify-lines.sh`: remove the white space at each end,
 * then each `v` and `=` at the start, then keep the part before the first
 * dot when it is a plain number. Else null. This is extraction, not
 * comparison: the order of versions is a question for the adapter.
 */
export const majorOf = (version: unknown): string | null => {
  const head = tostring(version)
    .replace(LEADING_SPACE, '')
    .replace(TRAILING_SPACE, '')
    .replace(/^[v=]+/, '')
    .split('.')[0] as string
  return PLAIN_NUMBER.test(head) ? head : null
}

/**
 * jq's `tonumber` for a major that {@link majorOf} gave. A major that ends
 * in a line break is not a number to jq 1.8, so it stops with an error.
 */
export const majorNumber = (major: string): number => {
  if (!/^[0-9]+$/.test(major)) throw new Error(`${JSON.stringify(major)} is not a number`)
  return Number(major)
}
