// `--out <file>`: write the answer of a command to a file too (#346). A later
// command then reads the file, and the model does not copy the answer with
// the Write tool. The allow hook gives no decision for a redirection
// (`cli.md`), so a flag does this job.
//
// The contract. `run.ts` applies it, for each command that its registry entry
// opts in (`out` in `command.ts`):
//   - `run.ts` takes `--out <file>` out of the arguments before the command
//     runs. The command never sees the flag.
//   - The file gets exactly the bytes that stdout gets: the JSON of an answer
//     with its newline, or the text of `render-pr commit-msg` and `body`.
//   - stdout still gets the answer, unchanged.
//   - A failure that carries a report (`failedReport`) writes its report to
//     the file. Any other failure, a throw included, writes its
//     `{"error": ...}` envelope. The exit status does not change.
//   - The command makes the parent directories of the file, and replaces a
//     file that is there.
//   - A file that cannot be written is a failure of the command: exit 1, and
//     `{"error": "<command>: cannot write --out <file>: <reason>"}` on stdout
//     in place of the answer, with the message on stderr. The answer is not
//     written on stdout.
//   - `--out` with no value, an empty value or a value that starts with `-`,
//     or `--out` twice, is a failure before the command runs. No file is
//     written.
//
// This file ships. It imports nothing outside the plugin, and nothing from
// node beyond `fs` and `path`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { type Envelope, failed, ok } from '../lib/envelope.ts'

const FLAG = '--out'

/**
 * Which calls of a command take `--out`: every call, or only the calls whose
 * first argument is one of the named verbs (`render-pr commit-msg`).
 */
export type OutScope = 'every call' | readonly string[]

/** The file to write, or null for none, and the arguments without the flag. */
export interface OutSplit {
  readonly out: string | null
  readonly args: readonly string[]
}

/** Take `--out <file>` out of the arguments of a call that takes it. */
export const takeOut = (
  args: readonly string[],
  scope: OutScope | undefined,
): Envelope<OutSplit> => {
  const applies = scope !== undefined && (scope === 'every call' || scope.includes(args[0] ?? ''))
  const at = applies ? args.indexOf(FLAG) : -1
  if (at === -1) return ok({ out: null, args })
  if (args.indexOf(FLAG, at + 1) !== -1) return failed(`${FLAG} is given more than once`)
  const file = args[at + 1] ?? ''
  if (file === '' || file.startsWith('-')) return failed(`${FLAG} requires a file`)
  return ok({ out: file, args: [...args.slice(0, at), ...args.slice(at + 2)] })
}

/** Write the text to the file, with its parent directories. The reason of a failure, or null. */
export const writeOut = (file: string, text: string): string | null => {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return null
  } catch (error) {
    return `cannot write ${FLAG} ${file}: ${(error as Error).message}`
  }
}
