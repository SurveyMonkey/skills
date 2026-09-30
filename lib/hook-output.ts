// This file writes the JSON that a SessionStart hook returns
// (`.claude/rules/path-hooks.md`, https://code.claude.com/docs/en/hooks).
// The plugin prefix is a parameter, so each plugin shares one writer.
//
// `systemMessage` is a top-level field, and the CLI shows it in the terminal
// under its own label. So the message starts with a newline, and the first
// real line starts a line of its own.
//
// `additionalContext` goes inside `hookSpecificOutput`, and only the model
// reads it. `emit` leaves that object out when the caller gives no context.
//
// This file ships. It imports nothing.

/** The colour codes that the CLI keeps in `systemMessage`. */
const SGR = {
  bold: '\u001b[1m',
  normal: '\u001b[22m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  reset: '\u001b[0m',
} as const

/**
 * One line in colour, with `<prefix>:` in bold. A problem line
 * (`<prefix>: ⚠️ ...`) is yellow. A status line (`<prefix>: ...`) is cyan.
 * A line that does not start with `<prefix>: ` stays plain.
 */
export const colour = (prefix: string, line: string): string => {
  const start = `${prefix}: `
  if (!line.startsWith(start)) return line
  const tint = line.startsWith(`${prefix}: ⚠️ `) ? SGR.yellow : SGR.cyan
  return `${tint}${SGR.bold}${prefix}:${SGR.normal}${line.slice(start.length - 1)}${SGR.reset}`
}

/**
 * The response of a SessionStart hook: one JSON object and a newline.
 * `lines` may hold several lines, joined by `\n`. Each line gets its own
 * colour. Without `additionalContext`, the object has no `hookSpecificOutput`.
 */
export const emit = (prefix: string, lines: string, additionalContext?: string): string => {
  const payload: Record<string, unknown> = {
    systemMessage: `\n${lines
      .split('\n')
      .map((line) => colour(prefix, line))
      .join('\n')}`,
  }
  if (additionalContext !== undefined) {
    payload.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext }
  }
  return `${JSON.stringify(payload)}\n`
}
