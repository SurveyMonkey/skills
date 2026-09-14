// The io the entry point hands a command (#224). The io is the process
// boundary, so the two writers are observed through a spy on the real
// stream, and the reader is exercised against a real file rather than
// against the suite's own stdin (the testing skill's mocking.md: the
// filesystem is never mocked).
import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  nodeIo,
  readAll,
  STDIN_FD,
  writeStderr,
  writeStdout,
} from '../../plugins/gh-security/src/cli/command.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readAll', () => {
  it('reads a descriptor to the end', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gh-security-io-')), 'input.json')
    writeFileSync(path, '{"tool_name":"Bash"}\n')
    const fd = openSync(path, 'r')
    try {
      expect(readAll(fd)).toBe('{"tool_name":"Bash"}\n')
    } finally {
      closeSync(fd)
    }
  })
})

describe('the real io', () => {
  it('writes what it is given to stdout, with nothing added', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    writeStdout('{"version":"1.2.3"}\n')
    expect(write.mock.calls).toEqual([['{"version":"1.2.3"}\n']])
  })

  it('writes what it is given to stderr, with nothing added', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    writeStderr('boom\n')
    expect(write.mock.calls).toEqual([['boom\n']])
  })

  it('wires the two writers and reads standard input', () => {
    // The descriptor is the claim being checked: an io that read the wrong
    // one would hang rather than fail, which no example could then observe.
    expect(STDIN_FD).toBe(0)
    expect({ stdout: nodeIo.stdout, stderr: nodeIo.stderr }).toEqual({
      stdout: writeStdout,
      stderr: writeStderr,
    })
  })
})
