// The write of one file of `apply_constraint` (#222, ruling 14). node.sh
// writes each file to a temporary file, and then moves it into place with
// `mv`. The port writes the temporary file in the same directory, and then
// renames it into place.
//
// So a reader sees the old file or the new file, and never part of a file.
// A symlink at the path is replaced, and the file that it points to does not
// change. The new file keeps the mode of the old file. In node.sh it gets
// the mode 0600 of `mktemp`.
//
// This file ships. It imports nothing outside the plugin.

import { randomBytes } from 'node:crypto'
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** The `die` texts of node.sh for the two steps. */
export interface ReplaceErrors {
  readonly write: string
  readonly rename: string
}

/**
 * Put `text` at `path` through a temporary file and a rename. A failed step
 * removes the temporary file, and throws with its text of `errors`. The file
 * at `path` then stays as it was.
 */
export const replaceFile = (path: string, text: string, errors: ReplaceErrors): void => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}`)
  try {
    const old = statSync(path, { throwIfNoEntry: false })
    writeFileSync(temporary, text, { flag: 'wx' })
    // After the write, because the mode of a new file follows the umask.
    if (old?.isFile() === true) chmodSync(temporary, old.mode & 0o7777)
  } catch {
    rmSync(temporary, { force: true })
    throw new Error(errors.write)
  }
  try {
    renameSync(temporary, path)
  } catch {
    rmSync(temporary, { force: true })
    throw new Error(errors.rename)
  }
}
