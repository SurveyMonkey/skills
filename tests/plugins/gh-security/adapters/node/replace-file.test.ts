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

const ERROR = 'cannot replace the file'

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
    replaceFile(join(dir, 'file'), 'new\n', ERROR)
    expect({ files: readdirSync(dir), text: readFileSync(join(dir, 'file'), 'utf8') }).toEqual({
      files: ['file'],
      text: 'new\n',
    })
  })

  it('keeps the mode of the old file', () => {
    const dir = scratch()
    const file = join(dir, 'file')
    writeFileSync(file, 'old\n')
    // A mode that no umask makes from the 0o666 of a new file.
    chmodSync(file, 0o766)
    replaceFile(file, 'new\n', ERROR)
    expect({ mode: modeOf(file), text: readFileSync(file, 'utf8') }).toEqual({
      mode: 0o766,
      text: 'new\n',
    })
  })

  it('replaces a symlink, and leaves the file that it points to as it was', () => {
    const dir = scratch()
    const outside = scratch()
    writeFileSync(join(outside, 'target'), 'old\n')
    symlinkSync(join(outside, 'target'), join(dir, 'file'))
    replaceFile(join(dir, 'file'), 'new\n', ERROR)
    expect({
      link: lstatSync(join(dir, 'file')).isSymbolicLink(),
      text: readFileSync(join(dir, 'file'), 'utf8'),
      target: readFileSync(join(outside, 'target'), 'utf8'),
    }).toEqual({ link: false, text: 'new\n', target: 'old\n' })
  })

  it('writes no file in the temporary directory of the system', () => {
    const dir = scratch()
    const before = process.env.TMPDIR
    process.env.TMPDIR = join(dir, 'missing')
    try {
      replaceFile(join(dir, 'file'), 'new\n', ERROR)
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
    expect(readdirSync(dir)).toEqual(['file'])
  })

  it('replaces a dangling symlink', () => {
    const dir = scratch()
    symlinkSync(join(dir, 'missing'), join(dir, 'file'))
    replaceFile(join(dir, 'file'), 'new\n', ERROR)
    expect({ files: readdirSync(dir), text: readFileSync(join(dir, 'file'), 'utf8') }).toEqual({
      files: ['file'],
      text: 'new\n',
    })
  })

  it('throws when the rename fails, and leaves no temporary file', () => {
    // A rename onto a directory that holds a file fails, on Linux and on macOS.
    const dir = scratch()
    mkdirSync(join(dir, 'file'))
    writeFileSync(join(dir, 'file', 'inner'), 'old\n')
    expect(() => replaceFile(join(dir, 'file'), 'new\n', ERROR)).toThrow(ERROR)
    expect({
      files: readdirSync(dir),
      inner: readFileSync(join(dir, 'file', 'inner'), 'utf8'),
    }).toEqual({ files: ['file'], inner: 'old\n' })
  })

  it.skipIf(!notRoot)(
    'throws when the directory cannot be written, and leaves the old file whole',
    () => {
      const dir = scratch()
      writeFileSync(join(dir, 'file'), 'old\n')
      chmodSync(dir, 0o555)
      try {
        expect(() => replaceFile(join(dir, 'file'), 'new\n', ERROR)).toThrow(ERROR)
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
