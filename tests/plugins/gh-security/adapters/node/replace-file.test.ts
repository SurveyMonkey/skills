// The write of one file of `apply_constraint` (#222, ruling 14), on real
// files in a scratch directory. The callers are in apply-constraint.test.ts.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

import { replaceFile } from '#gh-security/adapters/node/replace-file.ts'

const ERRORS = { write: 'the write failed', rename: 'the rename failed' }

const notRoot = process.getuid?.() !== 0

/** A scratch directory, removed after the test. */
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'replace-file-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const modeOf = (path: string): number => statSync(path).mode & 0o7777

describe('replaceFile', () => {
  it('writes a new file, and leaves no temporary file', () => {
    const dir = scratch()
    replaceFile(join(dir, 'file'), 'new\n', ERRORS)
    expect({ files: readdirSync(dir), text: readFileSync(join(dir, 'file'), 'utf8') }).toEqual({
      files: ['file'],
      text: 'new\n',
    })
  })

  it('keeps the mode of the old file', () => {
    const dir = scratch()
    const file = join(dir, 'file')
    writeFileSync(file, 'old\n')
    chmodSync(file, 0o640)
    replaceFile(file, 'new\n', ERRORS)
    expect({ mode: modeOf(file), text: readFileSync(file, 'utf8') }).toEqual({
      mode: 0o640,
      text: 'new\n',
    })
  })

  it('replaces a symlink, and leaves the file that it points to as it was', () => {
    const dir = scratch()
    const outside = scratch()
    writeFileSync(join(outside, 'target'), 'old\n')
    symlinkSync(join(outside, 'target'), join(dir, 'file'))
    replaceFile(join(dir, 'file'), 'new\n', ERRORS)
    expect({
      link: lstatSync(join(dir, 'file')).isSymbolicLink(),
      text: readFileSync(join(dir, 'file'), 'utf8'),
      target: readFileSync(join(outside, 'target'), 'utf8'),
    }).toEqual({ link: false, text: 'new\n', target: 'old\n' })
  })

  it('replaces a dangling symlink', () => {
    const dir = scratch()
    symlinkSync(join(dir, 'missing'), join(dir, 'file'))
    replaceFile(join(dir, 'file'), 'new\n', ERRORS)
    expect({ files: readdirSync(dir), text: readFileSync(join(dir, 'file'), 'utf8') }).toEqual({
      files: ['file'],
      text: 'new\n',
    })
  })

  it('throws with the rename text when the rename fails, and leaves no temporary file', () => {
    // A rename onto a directory that holds a file fails, on Linux and on macOS.
    const dir = scratch()
    mkdirSync(join(dir, 'file'))
    writeFileSync(join(dir, 'file', 'inner'), 'old\n')
    expect(() => replaceFile(join(dir, 'file'), 'new\n', ERRORS)).toThrow(ERRORS.rename)
    expect({
      files: readdirSync(dir),
      inner: readFileSync(join(dir, 'file', 'inner'), 'utf8'),
    }).toEqual({ files: ['file'], inner: 'old\n' })
  })

  it.skipIf(!notRoot)(
    'throws with the write text when the directory cannot be written, and leaves the old file whole',
    () => {
      const dir = scratch()
      writeFileSync(join(dir, 'file'), 'old\n')
      chmodSync(dir, 0o555)
      try {
        expect(() => replaceFile(join(dir, 'file'), 'new\n', ERRORS)).toThrow(ERRORS.write)
        expect({
          files: readdirSync(dir),
          text: readFileSync(join(dir, 'file'), 'utf8'),
        }).toEqual({ files: ['file'], text: 'old\n' })
      } finally {
        chmodSync(dir, 0o755)
      }
    },
  )
})
