// The write of one file of `apply_constraint` (#222, ruling 14). node.sh
// writes each file to a temporary file from `mktemp`, and then moves it into
// place with `mv`. The port writes the temporary file in the same directory,
// and then renames it into place.
//
// So a reader sees the old file or the new file, and never part of a file.
// A symlink at the path is replaced, and the file that it points to does not
// change. The new file gets the mode of the file at the path, after symlinks.
// In node.sh it gets the mode 0600 of `mktemp`. A new file gets the mode
// from the umask. The owner and the group are not kept.
//
// The `mktemp` file of node.sh is in `$TMPDIR`, so there each write that can
// fail in the directory of the file fails at the `mv`. Here such a write
// fails at the temporary file. Each failure gives the one text of the caller:
// the `mv` text of node.sh.
//
// This file ships. It imports nothing outside the plugin.

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fchmodSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Put `text` at `path` through a temporary file and a rename. A failure
 * throws with `error`. The file at `path` then stays as it was, and no
 * temporary file stays.
 */
export const replaceFile = (path: string, text: string, error: string): void => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}`)
  let mode: number | null
  let fd: number
  try {
    const old = statSync(path, { throwIfNoEntry: false })
    mode = old?.isFile() === true ? old.mode & 0o7777 : null
    // `wx`: a file that is at the name already stays, and the open fails.
    fd = openSync(temporary, 'wx', mode ?? 0o666)
  } catch {
    throw new Error(error)
  }
  try {
    try {
      writeFileSync(fd, text)
      // The umask can narrow the mode of the open, so set it again.
      if (mode !== null) fchmodSync(fd, mode)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } catch {
    rmSync(temporary, { force: true })
    throw new Error(error)
  }
}
