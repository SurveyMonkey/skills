// The runner's own claims, each one against a real child. There is no spawn
// seam here, on purpose: the process boundary itself is the subject, and a
// stand-in for `spawn` would prove only that the stand-in was called.
//
// The children are `process.execPath` with a program given by `-e`, so the
// interpreter that runs this suite is the interpreter under test. The target
// stack keeps these programs as fixture files; here each one is a string in
// this file, so the suite adds no fixture tree.
//
// A time limit is generous where the test says it did NOT fire, and tiny
// where it says it did. A slow CI runner then still passes.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { killGroup, run } from '#gh-security/lib/process.ts'

const scratches: string[] = []
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gh-security-process-')))
  scratches.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true })
})

/** The child programs. `process.argv[1]` is the first argument after `-e`. */
const FAIL = 'process.stdout.write("partial\\n");process.stderr.write("boom\\n");process.exit(3)'
const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'
const WHERE = 'process.stdout.write(process.cwd() + "\\n" + process.env.HOME + "\\n")'
const ECHO_STDIN = 'process.stdout.write(require("node:fs").readFileSync(0))'
const EXIT_NOW = 'process.exit(0)'
/** Writes "a" to stderr, then "b" to stdout 50 ms later. */
const STDERR_THEN_STDOUT =
  'process.stderr.write("a\\n");setTimeout(() => process.stdout.write("b\\n"), 50)'
const SLEEP = 'setTimeout(() => process.stdout.write("finished\\n"), Number(process.argv[1]))'
const PGID =
  'process.stdout.write(require("node:child_process").execFileSync("ps", ' +
  '["-o", "pgid=", "-p", String(process.pid)]).toString().trim())'
/** Writes `<marker>.started` at once, and `<marker>.survived` after 5 s. */
const GRANDCHILD =
  'const fs = require("node:fs"); const marker = process.argv[1];' +
  'fs.writeFileSync(marker + ".started", "started");' +
  'setTimeout(() => fs.writeFileSync(marker + ".survived", "survived"), 5000)'
/** Starts GRANDCHILD with this child's stdout, then waits for a minute. */
const SPAWN_SLEEPER =
  'const child = require("node:child_process").spawn(process.execPath, ' +
  `["-e", ${JSON.stringify(GRANDCHILD)}, process.argv[1]], { stdio: "inherit" });` +
  'process.stdout.write("spawned " + child.pid + "\\n");' +
  'setTimeout(() => process.stdout.write("outlived the bound\\n"), 60000)'

/** A time limit that no correct run can reach on any runner. */
const GENEROUS_MS = 120_000
/** A time limit that a child which sleeps for a minute always overruns. */
const TINY_MS = 250
/** The one time limit that must be long enough, not short enough. It must
 *  not fire until two nested node starts have written the marker (about
 *  120 ms when idle). It must fire before the grandchild's own 5 s write.
 *  A change here needs a change to the 5 s in GRANDCHILD too. */
const GROUP_MS = 4_000
/** A bound that a child which exits at once never reaches, and that a test
 *  can still wait out. */
const CLEARED_MS = 2_000
/** Past the grandchild's own 5 s write, so "it did not survive" is a real
 *  observation. */
const SURVIVAL_WINDOW_MS = 6_000
/** More than the two limits above cost together, for a slow runner. A group
 *  that survives keeps the pipe open, so `run` never resolves and the test
 *  fails as a timeout. */
const GROUP_TEST_BUDGET_MS = 30_000

const node = (program: string, args: string[] = [], options = {}) =>
  run(process.execPath, ['-e', program, ...args], options)

it('answers with the status and both streams of a child that ran', async () => {
  const result = await node(FAIL)

  expect(result.status).toBe(3)
  expect(result.signal).toBeNull()
  expect(result.stdout).toBe('partial\n')
  expect(result.stderr).toBe('boom\n')
  expect(result.startFailure).toBeNull()
  expect(result.timedOut).toBe(false)
  expect(result.streamErrors).toEqual([])
})

it('answers with both streams together, for a caller that wants one transcript', async () => {
  const result = await node(FAIL)

  expect(result.combined).toContain('partial\n')
  expect(result.combined).toContain('boom\n')
  // "partial\n" is 8 characters and "boom\n" is 5.
  expect(result.combined.length).toBe(13)
})

// Mutant: all of stdout, then all of stderr. The transcript keeps the order
// in which the child wrote, over both pipes.
it('keeps the order of the writes in the transcript', async () => {
  const result = await node(STDERR_THEN_STDOUT)

  expect(result.combined).toBe('a\nb\n')
})

it('hands the child its arguments unchanged, with no shell between', async () => {
  // A shell would read the semicolon and the quotes again as its own.
  const awkward = ['a b; rm -rf /', '"quoted"', '✓']
  const result = await node(ECHO_ARGV, awkward)

  expect(JSON.parse(result.stdout)).toEqual(awkward)
})

it('runs the child where it was told to, with the environment it was given', async () => {
  const root = scratch()
  const where = join(root, 'elsewhere')
  mkdirSync(where)

  const result = await node(WHERE, [], {
    cwd: where,
    env: { ...process.env, HOME: join(root, 'home') },
  })

  const [cwd, home] = result.stdout.split('\n')
  expect(cwd).toBe(where)
  expect(home).toBe(join(root, 'home'))
})

it('gives the child only the environment it was given, not this one added to it', async () => {
  const result = await node('process.stdout.write(String(process.env.PATH))', [], {
    env: { HOME: '/nowhere' },
  })

  expect(result.stdout).toBe('undefined')
})

it('writes what it was given to the child and closes the pipe', async () => {
  const result = await node(ECHO_STDIN, [], { stdin: 'piped in' })

  expect(result.stdout).toBe('piped in')
})

it('closes stdin on a child that was given none, rather than leaving it open', async () => {
  // An open stdin makes a child that reads it wait for a writer that never
  // comes.
  const result = await node(ECHO_STDIN)

  expect(result.stdout).toBe('')
  expect(result.status).toBe(0)
})

it('decodes output with replacement rather than failing on a stray byte', async () => {
  const result = await node(ECHO_STDIN, [], { stdin: new Uint8Array([0xff, 0x41]) })

  expect(result.stdout).toBe('�A')
})

it('survives a child that exits before reading the stdin it was given', async () => {
  // The write fails with EPIPE, on a stream. With no listener, that error
  // event would stop this whole process. The stdin is larger than a pipe
  // buffer, so the write cannot complete before the child is gone.
  const result = await node(EXIT_NOW, [], { stdin: 'x'.repeat(8 * 1024 * 1024) })

  expect(result.status).toBe(0)
  expect(result.startFailure).toBeNull()
  expect(result.streamErrors).toEqual([])
})

it('reports a command that is not there as 127, the way a shell does', async () => {
  const result = await run('definitely-not-a-command-127')

  expect(result.startFailure?.code).toBe('ENOENT')
  expect(result.status).toBe(127)
  expect(result.stdout).toBe('')
})

it('reports a command that is there and cannot be run as 126', async () => {
  const notExecutable = join(scratch(), 'tool')
  writeFileSync(notExecutable, '#!/bin/sh\necho hi\n', { mode: 0o644 })

  const result = await run(notExecutable)

  expect(result.startFailure?.code).toBe('EACCES')
  expect(result.status).toBe(126)
})

it('answers rather than rejecting when node refuses the argv outright', async () => {
  // `spawn` checks argv synchronously and throws a TypeError for a NUL
  // byte. A throw in the promise executor is a rejection, and no caller
  // has a `try` for it.
  const result = await run('git', ['rev-parse\u0000--show-toplevel'])

  expect(result.startFailure?.code).toBe('ERR_INVALID_ARG_VALUE')
  // 126, not 127: the code is not `ENOENT`. node checks the argv before any
  // lookup, so this shows nothing about whether `git` is on PATH.
  expect(result.status).toBe(126)
  expect(result.stdout).toBe('')
  expect(result.timedOut).toBe(false)
})

it('reports a working directory that is not there as a failure to start', async () => {
  const result = await node(ECHO_ARGV, [], { cwd: join(scratch(), 'never-created') })

  expect(result.startFailure?.code).toBe('ENOENT')
  expect(result.startFailure?.message).toContain('spawn')
})

it('leaves a child that finishes inside its bound alone', async () => {
  const result = await node(SLEEP, ['10'], { timeoutMs: GENEROUS_MS })

  expect(result.timedOut).toBe(false)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('finished\n')
})

// Mutant: a bound that is not cleared when the child ends. It fires later,
// and signals a process group whose pid the kernel can give to another.
it(
  'clears the bound of a child that ended inside it',
  async () => {
    const kill = vi.spyOn(process, 'kill')
    try {
      const result = await node(EXIT_NOW, [], { timeoutMs: CLEARED_MS })
      await new Promise((resolve) => setTimeout(resolve, CLEARED_MS + 500))

      expect(result.timedOut).toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  },
  GROUP_TEST_BUDGET_MS,
)

it('kills a child that outlives its bound and says the bound fired', async () => {
  const result = await node(SLEEP, ['600000'], { timeoutMs: TINY_MS })

  expect(result.timedOut).toBe(true)
  // A killed child has no status of its own. The signal is what happened.
  expect(result.status).toBeNull()
  expect(result.signal).toBe('SIGKILL')
  expect(result.stdout).toBe('')
})

it(
  'kills the whole process group, not only the child it holds',
  async () => {
    // The grandchild has the child's stdout. So a group that survived would
    // also keep this run open, and the test would fail as a timeout.
    const marker = join(scratch(), 'grandchild')

    const result = await node(SPAWN_SLEEPER, [marker], { timeoutMs: GROUP_MS })

    expect(result.timedOut).toBe(true)
    expect(result.stdout).toContain('spawned ')
    expect(existsSync(`${marker}.started`)).toBe(true)
    // The limit fired at 4 s. After this wait, the grandchild's own 5 s
    // deadline is past, so a grandchild that outlived the kill had its
    // chance to say so.
    await new Promise((resolve) => setTimeout(resolve, SURVIVAL_WINDOW_MS))
    expect(existsSync(`${marker}.survived`)).toBe(false)
    expect(existsSync(`${marker}.started`)).toBe(true)
  },
  GROUP_TEST_BUDGET_MS,
)

it('measures how long the child actually took', async () => {
  // Only the floor. A loaded runner makes a child slower, never faster.
  const result = await node(SLEEP, ['120'])

  expect(result.elapsedMs).toBeGreaterThanOrEqual(100)
})

it('says nothing about a process group that is already gone', () => {
  // A pid far above any that the kernel gives has no group to signal.
  expect(() => killGroup(2 ** 30)).not.toThrow()
})

it("detaches a bounded child and leaves an unbounded one in this process's group", async () => {
  // The group kill depends on this, and it is not a branch, so coverage
  // cannot see it: `detached: true` on every child passes all the other
  // tests in this file.
  const mine = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    .toString()
    .trim()

  const unbounded = await node(PGID)
  const bounded = await node(PGID, [], { timeoutMs: GENEROUS_MS })

  expect(unbounded.stdout).toBe(mine)
  expect(bounded.stdout).not.toBe(mine)
})

it('reports a bounded command that is not there as a start failure, not as a timeout', async () => {
  const result = await run('definitely-not-a-command-127', [], { timeoutMs: TINY_MS })

  expect(result.startFailure?.code).toBe('ENOENT')
  expect(result.status).toBe(127)
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeNull()
})
