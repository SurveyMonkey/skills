// The stream rules, including the two that node already holds. Those two are
// pinned against a real child, not stated in prose. If a later node stops
// opening /dev/null over a closed descriptor, or encodes stdout with the
// locale, this file goes red.
import { expect, it } from 'vitest'
import { run } from '#gh-security/lib/process.ts'
import {
  createOutput,
  createWriter,
  readStdinText,
  streamFailures,
} from '#gh-security/lib/streams.ts'

const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'

/** A stand-in for `process.stdout`: what was written, and a way to raise the
 *  error that node would raise. This is not a mock of a system boundary
 *  (the real child cases are below). It is the only way to get an `ENOSPC`
 *  on demand. */
const fake = () => {
  const written: string[] = []
  const listeners: Array<(error: NodeJS.ErrnoException) => void> = []
  return {
    written,
    stream: {
      write(text: string) {
        written.push(text)
        return true
      },
      on(_event: 'error', listener: (error: NodeJS.ErrnoException) => void) {
        listeners.push(listener)
        return undefined
      },
    },
    raise(code: string) {
      const error: NodeJS.ErrnoException = new Error(code)
      error.code = code
      for (const listener of listeners) listener(error)
    },
  }
}

/** An async iterable over the chunks that a stream would give. */
async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value
}

it('writes through to the stream it was given', () => {
  const stdout = fake()

  createWriter(stdout.stream).write('a line\n')

  expect(stdout.written).toEqual(['a line\n'])
})

it('starts out not silenced', () => {
  expect(createWriter(fake().stream).silenced).toBe(false)
})

it('goes quiet for good once the reader has gone away', () => {
  const stdout = fake()
  const writer = createWriter(stdout.stream)

  writer.write('first\n')
  stdout.raise('EPIPE')
  writer.write('second\n')

  expect(writer.silenced).toBe(true)
  expect(stdout.written).toEqual(['first\n'])
})

it('re-throws every error that is not a broken pipe', () => {
  // A listener silences node's default crash for EVERY code on that stream.
  // A full disk must not disappear with the broken pipe.
  const stdout = fake()
  const writer = createWriter(stdout.stream)

  expect(() => stdout.raise('ENOSPC')).toThrow('ENOSPC')
  expect(writer.silenced).toBe(false)
})

it('can be silenced deliberately, with nothing having gone wrong', () => {
  const stdout = fake()
  const writer = createWriter(stdout.stream)

  writer.silence()
  writer.write('after\n')

  expect(writer.silenced).toBe(true)
  expect(stdout.written).toEqual([])
})

it('keeps stderr alive when stdout loses its reader', () => {
  const stdout = fake()
  const stderr = fake()
  const output = createOutput(stdout.stream, stderr.stream)

  stdout.raise('EPIPE')
  output.out.write('dropped\n')
  output.err.write('still said\n')

  expect(stdout.written).toEqual([])
  expect(stderr.written).toEqual(['still said\n'])
})

it('silences both at the end of a run', () => {
  const stdout = fake()
  const stderr = fake()
  const output = createOutput(stdout.stream, stderr.stream)

  output.silence()
  output.out.write('dropped\n')
  output.err.write('dropped\n')

  expect(stdout.written).toEqual([])
  expect(stderr.written).toEqual([])
})

it('reads stdin as UTF-8, replacing what it cannot decode', async () => {
  const text = await readStdinText(
    chunks(new TextEncoder().encode('✓ done '), new Uint8Array([0xff])),
  )

  expect(text).toBe('✓ done �')
})

it('reads an empty stdin as an empty string', async () => {
  await expect(readStdinText(chunks())).resolves.toBe('')
})

it('writes UTF-8 whatever the locale says', async () => {
  const result = await run(process.execPath, ['-e', ECHO_ARGV, '✓ done'], {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', LC_CTYPE: 'C' },
  })

  expect(JSON.parse(result.stdout)).toEqual(['✓ done'])
})

it('survives a descriptor that was closed before it started', async () => {
  // node opens /dev/null over a closed stdio descriptor at startup. The
  // writes are discarded, and the child still exits 0.
  const result = await run('sh', ['-c', 'exec 1>&- ; "$0" -e "$1" ok', process.execPath, ECHO_ARGV])

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('')
})

it('reports every stream error that is not a broken pipe, and none that is', () => {
  const broken: NodeJS.ErrnoException = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  const full: NodeJS.ErrnoException = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' })

  expect(streamFailures(broken)).toEqual([])
  expect(streamFailures(full)).toEqual([{ code: 'ENOSPC', message: 'write ENOSPC' }])
})

it('falls back to the name for a stream error carrying no code', () => {
  // node's own stream errors all have a code. A caller's own stream can emit
  // anything, and an empty `code` would read as "no error".
  expect(streamFailures(new Error('something went wrong'))).toEqual([
    { code: 'Error', message: 'something went wrong' },
  ])
})

it('falls back to the name only for an absent code, not for an empty one', () => {
  // `??`, not `||`, as the target stack has it. This pins that choice.
  const blank: NodeJS.ErrnoException = Object.assign(new Error('odd'), { code: '' })

  expect(streamFailures(blank)).toEqual([{ code: '', message: 'odd' }])
})
