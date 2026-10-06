// The text rules of the PR renderer (#233). Most functions here are a rule
// that `render-pr.sh` had as a jq filter or an awk call. `fence` is new, and
// `cell` does for each cell what the script did only for a summary. A value
// that comes from input reaches a line, a table cell or a code fence through
// one of these functions. So a line break cannot split its line, a pipe
// cannot end its cell, and a backtick run cannot end its fence. A backtick
// in a line can still end a code span. The values that are Markdown, and
// `--repo`, are the exceptions (`pr-body.ts`).
//
// This file ships. It imports nothing outside the plugin.

/**
 * The dash of three sentences of the script. The sentences are part of what
 * a reader sees, so the text keeps it. The source holds the code point, and
 * not the character.
 */
export const DASH = String.fromCodePoint(0x2014)

/** The text of a value that a command substitution read: no final line feeds. */
export const withoutFinalNewlines = (text: string): string => text.replace(/\n+$/, '')

/** Text for one line: each line break, of any kind, becomes one space. */
export const inline = (text: string): string => text.replace(/\r\n|[\r\n]/g, ' ')

/**
 * The text of a value that the script read with `$(jq -r ...)`. The shell
 * dropped its final line feeds. A line break inside it becomes one space,
 * which is a difference from the script (#233).
 */
export const shown = (text: string): string => inline(withoutFinalNewlines(text))

/**
 * Text for one table cell. A backslash is doubled and a pipe is escaped, in
 * that order, so a text that holds `\|` cannot end the cell. In a summary,
 * the script escaped the pipe first, and the tsv step then doubled its
 * backslash. That left a cell that a pipe ended (#233).
 */
export const cell = (text: string): string =>
  inline(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

/**
 * The fence for a block of text: three backticks, or one more than the
 * longest run of backticks inside the block. A block that holds a run of
 * three cannot end its own fence.
 */
export const fence = (block: string): string => {
  const longest = Math.max(0, ...(block.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * A fraction as a percentage with one decimal, as `awk` printed it: the
 * exact value of the double is rounded, and an exact tie goes to the even
 * digit. JavaScript's `toFixed` sends a tie up. A tie is a real value:
 * 0.0125 times 100 is exactly 1.25.
 */
export const percent = (fraction: number): string => {
  const scaled = fraction * 100
  const tie = /^(\d+)\.(\d)50*$/.exec(scaled.toFixed(50))
  return tie !== null && Number(tie[2]) % 2 === 0 ? `${tie[1]}.${tie[2]}` : scaled.toFixed(1)
}
