// Behavioral tests for plugins/gh-security/workflows/fix-groups.mjs.
//
// These replace the textual pins that were standing in for them while the
// script lived in a markdown fence (ADR 010). The distinction that decides
// where a test belongs: anything the SCRIPT does is tested here, by running
// it; anything the MODEL does — the interruption contract, the reap cadence,
// the approval boundary — stays a prose pin in
// spec/resolve_alerts_dispatch_spec.sh, because prose is its implementation.
//
// The schema is executed by ajv, not read. That is the point: the bug this
// suite exists to have caught was a well-formed schema that no truthful
// failure result could satisfy, and every textual pin passed against it.

import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'

import {
  dispatch,
  failureResult,
  noOpResult,
  runWorkflow,
  successResult,
  workflowSource,
} from './harness.mjs'
import { PURE_BEGIN, PURE_END, WIRING_BEGIN, project, region } from './generate.mjs'
// The projection generate.mjs writes before the suite is collected. This is
// the module the coverage gate measures; the byte-identity examples at the
// bottom are what make measuring it equivalent to measuring the shipped file.
import {
  RESULT_SCHEMA,
  agentLabel,
  dispatchPrompt,
  main,
  pairEntry,
  validateArgs,
  workerCount,
} from './generated/workflow.mjs'

const validate = new Ajv({ allErrors: true, strict: false }).compile(RESULT_SCHEMA)
const accepts = (r) => validate(r)

describe('validateArgs', () => {
  it('accepts a well-formed args object', () => {
    expect(() => validateArgs({ cap: 3, dispatches: [dispatch()] })).not.toThrow()
  })

  for (const [name, bad] of [
    ['a missing args object', undefined],
    ['a null args object', null],
    // The failure the guard exists for: args passed as a JSON-encoded string
    // arrives as one string, so `.dispatches` is undefined.
    ['a stringified args object', JSON.stringify({ cap: 3, dispatches: [] })],
    ['dispatches absent', { cap: 3 }],
    ['dispatches not an array', { cap: 3, dispatches: { 0: dispatch() } }],
    // An empty batch is refused rather than run: Array.from({length: 0}) and
    // parallel([]) both succeed silently, so it would return zero entries and
    // read as a clean run over nothing.
    ['dispatches empty', { cap: 3, dispatches: [] }],
  ]) {
    it(`refuses ${name}`, () => {
      expect(() => validateArgs(bad)).toThrow(/args\.dispatches must be a non-empty array/)
    })
  }

  for (const [name, cap] of [
    ['cap absent', undefined],
    ['cap null', null],
    // The silent inversion: NaN made the worker count NaN, the worker array
    // empty, and every entry null — a whole batch reported as crashed agents
    // when nothing was dispatched.
    ['cap NaN', Number.NaN],
    ['cap a numeric string', '3'],
    ['cap zero', 0],
    ['cap negative', -1],
  ]) {
    it(`refuses ${name}`, () => {
      expect(() => validateArgs({ cap, dispatches: [dispatch()] }))
        .toThrow(/args\.cap must be a number >= 1/)
    })
  }

  it('refuses a bad dispatches list before it looks at cap', () => {
    expect(() => validateArgs({ dispatches: [] })).toThrow(/args\.dispatches/)
  })
})

describe('workerCount', () => {
  for (const [name, cap, total, want] of [
    ['cap above the batch size, so the batch floors it', 6, 2, 2],
    ['cap below the batch size, so the cap binds', 3, 33, 3],
    ['cap equal to the batch size', 4, 4, 4],
    ['a cap of one, the serial floor', 1, 33, 1],
    ['the detect-capacity fallback cap', 3, 5, 3],
  ]) {
    it(`returns ${want} for ${name}`, () => {
      expect(workerCount(cap, total)).toBe(want)
    })
  }

  it('never exceeds the cap, at any batch size', () => {
    for (let total = 1; total <= 50; total += 1) {
      expect(workerCount(3, total)).toBeLessThanOrEqual(3)
    }
  })
})

describe('the dispatch payload', () => {
  it('carries every field the fix agent needs, verbatim', () => {
    const d = dispatch()
    const payload = JSON.parse(dispatchPrompt(d).split('Dispatch payload:\n')[1])
    expect(payload).toEqual(d)
    for (const k of ['group', 'adapter_path', 'nwo', 'default_branch', 'repo_root', 'scripts_dir']) {
      expect(payload).toHaveProperty(k)
    }
  })

  it('tells the agent to follow its definition and end with its result block', () => {
    expect(dispatchPrompt(dispatch())).toMatch(/Follow your agent definition end to end/)
  })

  // env_prefix is OPTIONAL and opaque. A null would be carried into the
  // agent's command construction as the string "null"; the contract is that
  // an absent prefix means the key is not there at all.
  it('omits env_prefix entirely when the repo resolved none', () => {
    const payload = JSON.parse(dispatchPrompt(dispatch()).split('Dispatch payload:\n')[1])
    expect('env_prefix' in payload).toBe(false)
    expect(dispatchPrompt(dispatch())).not.toMatch(/env_prefix/)
  })

  it('carries env_prefix verbatim when the repo resolved one', () => {
    const d = dispatch({ env_prefix: 'direnv exec /w/app' })
    const payload = JSON.parse(dispatchPrompt(d).split('Dispatch payload:\n')[1])
    expect(payload.env_prefix).toBe('direnv exec /w/app')
  })

  it('labels each agent by repo, package and line', () => {
    expect(agentLabel(dispatch())).toBe('octo/app undici 6.x')
  })
})

describe('pairEntry', () => {
  const d = dispatch()

  it('pairs a result whose identity matches its dispatch', () => {
    const r = successResult()
    const entry = pairEntry(d, r)
    expect(entry.mispaired).toBe(false)
    expect(entry.result).toBe(r)
    expect(entry.dispatch).toBe(d)
  })

  // Each field independently, because a check that ANDs three comparisons can
  // lose one and still pass a test that only ever varies the first.
  for (const [field, value] of [
    ['package', 'sharp'],
    ['major_line', '7.x'],
    ['repo', 'octo/other'],
  ]) {
    it(`trips on a mismatched ${field}`, () => {
      const entry = pairEntry(d, successResult({ [field]: value }))
      expect(entry.mispaired).toBe(true)
    })
  }

  // The reason mispairing matters: a positionally mis-attributed result would
  // send the reap at a branch belonging to another group. Dropping the result
  // makes that unreachable rather than merely discouraged.
  it('never exposes a mispaired result pr_url or branch', () => {
    const entry = pairEntry(d, successResult({ repo: 'octo/other' }))
    expect(entry.result).toBeNull()
    expect(JSON.stringify(entry)).not.toContain('octo/other')
    expect(JSON.stringify(entry)).not.toContain('/pull/1')
  })

  it('keeps the dispatch on a mispaired entry, so the group is still reapable', () => {
    const entry = pairEntry(d, successResult({ package: 'sharp' }))
    expect(entry.dispatch.group.branch_name).toBe('fix/dependabot-undici-6x')
    expect(entry.dispatch.repo_root).toBe('/w/app')
  })

  // A null result is the agent dying or failing schema validation after
  // retries. That is a failure report, not a mispairing.
  it('reports a null result as null and not mispaired', () => {
    const entry = pairEntry(d, null)
    expect(entry.result).toBeNull()
    expect(entry.mispaired).toBe(false)
  })
})

describe('RESULT_SCHEMA, executed', () => {
  it('accepts a conforming success', () => {
    expect(accepts(successResult())).toBe(true)
  })

  it('accepts a conforming no-op', () => {
    expect(accepts(noOpResult())).toBe(true)
  })

  it('accepts a conforming failure', () => {
    expect(accepts(failureResult())).toBe(true)
  })

  // THE regression test. apply_constraint writes the override before install,
  // so a validate/install/push/pr failure truthfully reports
  // bare_override "added" while action is null. An ungated agreement rule
  // made that unsatisfiable: the agent would be retried into a null entry,
  // losing the phase and detail, or would "fix" it by reporting
  // bare_override "none" and hiding a global pin.
  for (const phase of ['validate', 'install', 'push', 'pr']) {
    it(`accepts a ${phase} failure that truthfully reports bare_override added`, () => {
      const r = failureResult({
        bare_override: 'added',
        failure: { phase, detail: 'failed after the override was written' },
        observations: [{ type: 'unscoped_override_added', key: 'sharp', range: '>=0.35.0 <1' }],
      })
      expect(accepts(r), JSON.stringify(validate.errors)).toBe(true)
    })
  }

  it('accepts a failure reporting bare_override tightened', () => {
    expect(accepts(failureResult({ bare_override: 'tightened' }))).toBe(true)
  })

  it('rejects a failure whose failure object is null', () => {
    expect(accepts(failureResult({ failure: null }))).toBe(false)
  })

  it('rejects a no-op whose no_op object is null', () => {
    expect(accepts(noOpResult({ no_op: null }))).toBe(false)
  })

  it('rejects a success carrying both no_op and failure', () => {
    const r = successResult({
      no_op: { reason: 'r', evidence: {} },
      failure: { phase: 'install', detail: 'd' },
    })
    expect(accepts(r)).toBe(false)
  })

  it('rejects a failure carrying both no_op and failure', () => {
    const r = failureResult({ no_op: { reason: 'r', evidence: {} } })
    expect(accepts(r)).toBe(false)
  })

  it('rejects a success whose pr_url is null', () => {
    expect(accepts(successResult({ pr_url: null }))).toBe(false)
  })

  it('rejects a failure carrying a pr_url', () => {
    expect(accepts(failureResult({ pr_url: 'https://x/pull/1' }))).toBe(false)
  })

  // Still enforced on success, which is where action is non-null and the
  // agreement is meaningful.
  it('rejects a success with bare_override added but a scoped action', () => {
    expect(accepts(successResult({ bare_override: 'added' }))).toBe(false)
  })

  it('rejects a success with a bare-override action but bare_override none', () => {
    expect(accepts(successResult({ action: 'bare-override' }))).toBe(false)
  })

  it('accepts a success where bare_override and action agree', () => {
    const r = successResult({ action: 'bare-override', bare_override: 'added' })
    expect(accepts(r), JSON.stringify(validate.errors)).toBe(true)
  })

  for (const [field, bad] of [
    ['status', 'succeeded'],
    ['bare_override', 'yes'],
    ['action', 'override'],
  ]) {
    it(`rejects an out-of-enum ${field}`, () => {
      expect(accepts(successResult({ [field]: bad }))).toBe(false)
    })
  }

  it('rejects an out-of-enum failure phase', () => {
    expect(accepts(failureResult({ failure: { phase: 'lint', detail: 'd' } }))).toBe(false)
  })

  it('accepts every documented failure phase', () => {
    for (const phase of ['input', 'worktree', 'baseline', 'classify', 'apply', 'install', 'validate', 'push', 'pr']) {
      expect(accepts(failureResult({ failure: { phase, detail: 'd' } })), phase).toBe(true)
    }
  })

  it('accepts a null action, which every non-success carries', () => {
    expect(accepts(failureResult({ action: null }))).toBe(true)
  })

  for (const field of ['status', 'package', 'branch', 'observations', 'requires_major_bump', 'bare_override', 'no_op', 'failure']) {
    it(`rejects a result missing ${field}`, () => {
      const r = successResult()
      delete r[field]
      expect(accepts(r)).toBe(false)
    })
  }

  it('rejects a risk object missing a scorer factor', () => {
    expect(accepts(successResult({ risk: { band: 'Low', score: 3, f4: 0 } }))).toBe(false)
  })

  // The adapter emits four observation types; narrowing to an enum would
  // reject three of them.
  for (const type of ['unscoped_override', 'unscoped_override_added', 'manifest_pnpm_overrides_ignored', 'pnpm_major_unknown']) {
    it(`accepts the ${type} observation the adapter really emits`, () => {
      expect(accepts(successResult({ observations: [{ type }] }))).toBe(true)
    })
  }

  it('rejects an observation with no type', () => {
    expect(accepts(successResult({ observations: [{ key: 'sharp' }] }))).toBe(false)
  })

  // The specimen is node.sh's own $bump array, not an invented shape.
  it('accepts requires_major_bump in the shape validate emits', () => {
    const r = successResult({
      requires_major_bump: [{ version: '5.29.0', vulnerable_ranges: ['< 6.28.0'] }],
    })
    expect(accepts(r), JSON.stringify(validate.errors)).toBe(true)
  })

  it('rejects a requires_major_bump entry missing its ranges', () => {
    expect(accepts(successResult({ requires_major_bump: [{ version: '5.29.0' }] }))).toBe(false)
  })
})

describe('the workflow body, run with stubbed collaborators', () => {
  const batch = (n) =>
    Array.from({ length: n }, (_, i) =>
      dispatch({ group: { package: `pkg-${i}`, branch_name: `fix/dependabot-pkg-${i}-6x` } }))

  const echo = (_prompt, opts, i) => {
    const label = opts.label.split(' ')
    return successResult({ package: label[1], major_line: label[2], repo: label[0], pr_url: `https://github.com/octo/app/pull/${i}` })
  }

  it('dispatches exactly one agent per group and returns one entry per group', async () => {
    const dispatches = batch(7)
    const { entries, calls } = await runWorkflow({ main, args: { cap: 3, dispatches }, agent: echo })
    expect(calls).toHaveLength(7)
    expect(entries).toHaveLength(7)
    expect(entries.every((e) => e.mispaired === false)).toBe(true)
  })

  it('routes every agent to fix-dependency, on sonnet, with the schema', async () => {
    const { calls } = await runWorkflow({ main, args: { cap: 2, dispatches: batch(3) }, agent: echo })
    for (const c of calls) {
      expect(c.opts.agentType).toBe('fix-dependency')
      expect(c.opts.model).toBe('sonnet')
      expect(c.opts.schema).toStrictEqual(RESULT_SCHEMA)
      expect(c.opts.phase).toBe('Fix groups')
    }
  })

  it('never runs more agents at once than the cap', async () => {
    let inFlight = 0
    let peak = 0
    const slow = async (prompt, opts, i) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return echo(prompt, opts, i)
    }
    await runWorkflow({ main, args: { cap: 3, dispatches: batch(12) }, agent: slow })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBe(3)
  })

  it('returns entries in dispatch order even when agents finish out of order', async () => {
    const dispatches = batch(6)
    const reversed = async (prompt, opts, i) => {
      await new Promise((r) => setTimeout(r, (6 - i) * 2))
      return echo(prompt, opts, i)
    }
    const { entries } = await runWorkflow({ main, args: { cap: 6, dispatches }, agent: reversed })
    expect(entries.map((e) => e.dispatch.group.package)).toEqual(dispatches.map((d) => d.group.package))
    expect(entries.map((e) => e.result.package)).toEqual(dispatches.map((d) => d.group.package))
  })

  it('carries a null result through as a failure entry without stalling the batch', async () => {
    const dispatches = batch(4)
    const withNull = (prompt, opts, i) => (i === 1 ? null : echo(prompt, opts, i))
    const { entries } = await runWorkflow({ main, args: { cap: 2, dispatches }, agent: withNull })
    expect(entries).toHaveLength(4)
    expect(entries[1].result).toBeNull()
    expect(entries[1].mispaired).toBe(false)
    expect(entries[1].dispatch.group.branch_name).toBe('fix/dependabot-pkg-1-6x')
    expect(entries.filter((e) => e.result !== null)).toHaveLength(3)
  })

  it('flags and empties a mispaired result end to end', async () => {
    const dispatches = batch(3)
    const swap = (prompt, opts, i) =>
      (i === 2 ? successResult({ package: 'someone-else', pr_url: 'https://github.com/octo/app/pull/99' }) : echo(prompt, opts, i))
    const { entries } = await runWorkflow({ main, args: { cap: 1, dispatches }, agent: swap })
    const bad = entries.find((e) => e.mispaired)
    expect(bad).toBeDefined()
    expect(bad.result).toBeNull()
    expect(JSON.stringify(entries)).not.toContain('/pull/99')
  })

  it('announces the batch size and the width it runs at', async () => {
    const { logs } = await runWorkflow({ main, args: { cap: 3, dispatches: batch(9) }, agent: echo })
    expect(logs).toContain('Dispatching 9 group(s), 3 at a time')
  })

  it('opens exactly one phase, matching the meta entry', async () => {
    const { phases } = await runWorkflow({ main, args: { cap: 2, dispatches: batch(2) }, agent: echo })
    expect(phases).toEqual(['Fix groups'])
  })

  it('throws before dispatching anything when args are malformed', async () => {
    const seen = []
    await expect(runWorkflow({
      main,
      args: { dispatches: [] },
      agent: (p, o, i) => { seen.push(i); return echo(p, o, i) },
    })).rejects.toThrow(/args\.dispatches/)
    expect(seen).toHaveLength(0)
  })
})

describe('the projection is the shipped file', () => {
  // Everything the coverage gate claims rests on these. If the projection
  // stopped being byte-identical to the regions it copies, the number would
  // still be 100 and would still mean nothing.
  it('copies the pure region verbatim', async () => {
    const src = await workflowSource()
    const generated = project(src)
    expect(generated).toContain(region(src, PURE_BEGIN, PURE_END))
  })

  it('copies the wiring region verbatim', async () => {
    const src = await workflowSource()
    const generated = project(src)
    expect(generated).toContain(region(src, WIRING_BEGIN, null))
  })

  it('adds nothing to the projection but an export list and the main wrapper', async () => {
    const src = await workflowSource()
    const generated = project(src)
    const added = generated
      .replace(region(src, PURE_BEGIN, PURE_END), '')
      .replace(region(src, WIRING_BEGIN, null), '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
    expect(added).toEqual([
      'export { RESULT_SCHEMA, validateArgs, workerCount, dispatchPrompt, agentLabel, pairEntry }',
      'export async function main(agent, parallel, phase, log, args) {',
      '}',
    ])
  })

  // An absent or empty region must be a hard error, never an empty projection
  // that defines nothing and reports 100% of zero.
  it('refuses a workflow whose markers are gone', async () => {
    const src = await workflowSource()
    expect(() => project(src.replace(PURE_BEGIN, '// nope'))).toThrow(/marker not found/)
    expect(() => project(src.replace(WIRING_BEGIN, '// nope'))).toThrow(/marker not found/)
  })

  it('refuses a workflow whose pure region is empty', () => {
    const empty = `${PURE_BEGIN}\n\n${PURE_END}\n${WIRING_BEGIN}\nreturn 1\n`
    expect(() => project(empty)).toThrow(/is empty; nothing would be projected/)
  })

  it('refuses a workflow whose wiring region is empty', () => {
    const src = `${PURE_BEGIN}\nconst x = 1\n${PURE_END}\n${WIRING_BEGIN}\n   \n`
    expect(() => project(src)).toThrow(/is empty; nothing would be projected/)
  })

  it('refuses a pure region that lost one of its declarations', async () => {
    const src = await workflowSource()
    expect(() => project(src.replace(/pairEntry/g, 'renamed'))).toThrow(/no longer defines pairEntry/)
  })

  it('declares meta as a pure literal the harness can extract statically', async () => {
    const src = await workflowSource()
    expect(src).toMatch(/^export const meta = \{$/m)
    const at = src.search(/^export const meta = \{$/m)
    const meta = src.slice(at, src.indexOf('\n}\n', at))
    // No interpolation, no spreads, no calls: the harness reads this
    // statically and refuses anything else.
    expect(meta).not.toMatch(/\$\{|\.\.\.|=>/)
    expect(meta).toMatch(/name: 'gh-security-fix-dispatch'/)
    expect(meta).toMatch(/title: 'Fix groups'/)
    expect(meta).toMatch(/model: 'sonnet'/)
  })

  // A Workflow script receives its collaborators as injected globals and,
  // under the wrapping its own contract implies, could not parse a top-level
  // import anyway. This is the pin that keeps someone from "extracting a
  // helper module" and breaking the load.
  it('imports nothing', async () => {
    expect(await workflowSource()).not.toMatch(/^\s*import\s/m)
  })

  it('keeps the pure region free of every harness global', async () => {
    const src = await workflowSource()
    // Strip line comments and single-quoted strings, so neither a prose
    // mention of `agent()` nor an error message naming `args.cap` for the
    // caller's benefit reads as a USE of the global.
    const code = region(src, PURE_BEGIN, PURE_END)
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    for (const [name, use] of [
      ['agent', /\bagent\s*\(/],
      ['parallel', /\bparallel\s*\(/],
      ['phase', /\bphase\s*\(/],
      ['log', /\blog\s*\(/],
      ['args', /\bargs\b/],
    ]) {
      expect(code, `the pure region must not use the ${name} global`).not.toMatch(use)
    }
  })
})
