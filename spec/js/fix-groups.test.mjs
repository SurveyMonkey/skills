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
  cleanupReport,
  dispatch,
  failureResult,
  stripCommentsAndStrings,
  noOpResult,
  runWorkflow,
  successResult,
  workflowSource,
} from './harness.mjs'
import {
  PROJECTION_URL,
  PURE_BEGIN,
  PURE_END,
  WIRING_BEGIN,
  assertMarkersOnce,
  project,
  region,
} from './generate.mjs'
import { readFile } from 'node:fs/promises'
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

  // pairEntry compares four group fields against what the agent reports. An
  // absent one is undefined, so every comparison is false, every entry is
  // mispaired and nulled, and phase 7 reports a whole batch of crashed agents
  // over a run in which every PR opened — with the reap never running. Before
  // this guard, a payload missing branch_name did exactly that silently.
  describe('the group fields the identity check depends on', () => {
    const ok = { cap: 2 }

    it('accepts a well-formed group', () => {
      expect(() => validateArgs({ ...ok, dispatches: [dispatch()] })).not.toThrow()
    })

    for (const [name, group] of [
      ['a missing group', undefined],
      ['a null group', null],
      ['a group that is not an object', 'undici 6'],
    ]) {
      it(`refuses ${name}`, () => {
        const d = dispatch()
        d.group = group
        expect(() => validateArgs({ ...ok, dispatches: [d] })).toThrow(/group is missing/)
      })
    }

    it('refuses a null dispatch entry', () => {
      expect(() => validateArgs({ ...ok, dispatches: [null] })).toThrow(/dispatches\[0\]\.group is missing/)
    })

    for (const field of ['package', 'repo', 'branch_name']) {
      it(`refuses a group with no ${field}`, () => {
        const d = dispatch()
        delete d.group[field]
        expect(() => validateArgs({ ...ok, dispatches: [d] }))
          .toThrow(new RegExp(`group\\.${field} must be a non-empty string`))
      })

      it(`refuses a group whose ${field} is empty`, () => {
        const d = dispatch({ group: { [field]: '' } })
        expect(() => validateArgs({ ...ok, dispatches: [d] }))
          .toThrow(new RegExp(`group\\.${field} must be a non-empty string`))
      })

      it(`refuses a group whose ${field} is not a string`, () => {
        const d = dispatch({ group: { [field]: 7 } })
        expect(() => validateArgs({ ...ok, dispatches: [d] }))
          .toThrow(new RegExp(`group\\.${field} must be a non-empty string`))
      })
    }

    // major_line is the one field that may legitimately arrive as a number:
    // the layer building these payloads accepts and coerces one, so refusing
    // it here would reject a payload the rest of the stack handles.
    it('accepts a numeric major_line', () => {
      const d = dispatch({ group: { major_line: 6 } })
      expect(() => validateArgs({ ...ok, dispatches: [d] })).not.toThrow()
    })

    for (const [name, line] of [
      ['absent', undefined],
      ['empty', ''],
      ['null', null],
      ['an object', { major: 6 }],
    ]) {
      it(`refuses a major_line that is ${name}`, () => {
        const d = dispatch({ group: { major_line: line } })
        if (line === undefined) delete d.group.major_line
        expect(() => validateArgs({ ...ok, dispatches: [d] }))
          .toThrow(/group\.major_line must be a non-empty string or a number/)
      })
    }

    // The index is what makes a 33-group batch diagnosable.
    it('names the offending index, not just the field', () => {
      const bad = dispatch()
      delete bad.group.branch_name
      expect(() => validateArgs({ ...ok, dispatches: [dispatch(), dispatch(), bad] }))
        .toThrow(/dispatches\[2\]\.group\.branch_name/)
    })

    // The whole point: this must fail loudly rather than produce a batch of
    // nulls that phase 7 reads as crashed agents.
    it('refuses before dispatching anything, rather than nulling the batch', async () => {
      const seen = []
      const bad = dispatch()
      delete bad.group.branch_name
      await expect(runWorkflow({
        main,
        args: { cap: 1, dispatches: [bad] },
        agent: (p2, o, i) => { seen.push(i); return successResult() },
      })).rejects.toThrow(/branch_name/)
      expect(seen).toHaveLength(0)
    })
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
    expect(agentLabel(dispatch())).toBe('octo/app undici 6')
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
    ['major_line', '7'],
    ['repo', 'octo/other'],
    // The branch is what the reap acts on, so a result naming a different
    // one is the most dangerous mismatch of the four, not the least.
    ['branch', 'fix/dependabot-sharp-7x'],
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

  // The agent contract nulls resolved_version on failure and requires it on a
  // no-op. Both directions, because leaving either unconstrained lets a
  // result claim something the doc forbids.
  // `fix-group.sh cleanup` runs after the PR is created and exits 3 when it
  // leaves a worktree behind, so a cleanup error can follow completed work.
  // Forcing it into the `failure` branch would make the agent choose between
  // hiding the leak and hiding a real open PR — and hiding the PR also
  // suppresses post-agent.sh's reap, which only reaps a verified-open PR
  // from a success. Every branch must therefore permit a report.
  describe('the cleanup field', () => {
    it('requires the field to be present, even when it is null', () => {
      const r = successResult()
      delete r.cleanup
      expect(accepts(r)).toBe(false)
    })

    for (const [name, build] of [
      ['success', successResult],
      ['no-op', noOpResult],
      ['failure', failureResult],
    ]) {
      it(`accepts a ${name} with no cleanup error`, () => {
        expect(accepts(build({ cleanup: null })), JSON.stringify(validate.errors)).toBe(true)
      })

      it(`accepts a ${name} carrying a cleanup report`, () => {
        const r = build({ cleanup: cleanupReport() })
        expect(accepts(r), JSON.stringify(validate.errors)).toBe(true)
      })
    }

    // The shape the contract actually maps: a PR shipped, then cleanup
    // failed. This must validate as a SUCCESS with a live pr_url, or the
    // reap never runs on a group that really does have an open PR.
    it('accepts the shipped-PR-then-failed-cleanup shape as a success', () => {
      const r = successResult({ cleanup: cleanupReport() })
      expect(accepts(r), JSON.stringify(validate.errors)).toBe(true)
      expect(r.pr_url).toBeTruthy()
      expect(r.failure).toBeNull()
    })

    // The other half of the mapping: cleanup failed and nothing shipped.
    it('accepts the no-PR cleanup failure as a worktree-phase failure', () => {
      const r = failureResult({
        failure: { phase: 'worktree', detail: 'cleanup left a worktree behind' },
        cleanup: cleanupReport(),
      })
      expect(accepts(r), JSON.stringify(validate.errors)).toBe(true)
    })

    for (const field of ['worktree', 'work_dir', 'branch', 'errors']) {
      it(`rejects a cleanup report with no ${field}`, () => {
        const report = cleanupReport()
        delete report[field]
        expect(accepts(successResult({ cleanup: report }))).toBe(false)
      })
    }

    // Layer 1 confirms worktree and work_dir are each {path, action}, and the
    // path is the RESOLVED one the driver acted on. Phase 7 correlates on it,
    // so a report that omits either field would leave the orchestrator
    // comparing undefined against post-agent.sh's derived path.
    for (const container of ['worktree', 'work_dir']) {
      for (const field of ['path', 'action']) {
        it(`rejects a cleanup report whose ${container} has no ${field}`, () => {
          const report = cleanupReport()
          delete report[container][field]
          expect(accepts(successResult({ cleanup: report }))).toBe(false)
        })
      }

      it(`rejects a cleanup report whose ${container} path is not a string`, () => {
        const report = cleanupReport()
        report[container].path = { path: '/w' }
        expect(accepts(successResult({ cleanup: report }))).toBe(false)
      })
    }

    // The resolved form is what the driver really emits; the schema must not
    // quietly require the dispatched spelling.
    it('accepts the resolved path form the driver emits', () => {
      const report = cleanupReport()
      expect(report.worktree.path.startsWith('/private/')).toBe(true)
      expect(accepts(successResult({ cleanup: report })), JSON.stringify(validate.errors)).toBe(true)
    })

    // The remaining keys layer 1 names. Typed but not required: the driver
    // emits all eight today, and requiring the three that carry no structural
    // meaning here would reject a trimmed-but-usable report for nothing.
    it('accepts the full eight-key report the driver emits', () => {
      const report = cleanupReport()
      expect(Object.keys(report).sort()).toEqual([
        'branch', 'branch_deleted', 'branch_tip', 'detail', 'errors', 'reason', 'work_dir', 'worktree',
      ])
      expect(accepts(successResult({ cleanup: report })), JSON.stringify(validate.errors)).toBe(true)
    })

    for (const [field, bad] of [
      ['branch_deleted', 'no'],
      ['branch_tip', 7],
      ['reason', 7],
    ]) {
      it(`rejects a cleanup report whose ${field} is mistyped`, () => {
        expect(accepts(successResult({ cleanup: cleanupReport({ [field]: bad }) }))).toBe(false)
      })
    }

    it('rejects a cleanup report whose errors are not strings', () => {
      expect(accepts(successResult({ cleanup: cleanupReport({ errors: [{ msg: 'x' }] }) }))).toBe(false)
    })

    it('rejects a cleanup field that is neither an object nor null', () => {
      expect(accepts(successResult({ cleanup: 'left a worktree' }))).toBe(false)
    })
  })

  it('rejects a failure carrying a resolved_version', () => {
    expect(accepts(failureResult({ resolved_version: '6.28.0' }))).toBe(false)
  })

  it('rejects a no-op with no resolved_version', () => {
    expect(accepts(noOpResult({ resolved_version: null }))).toBe(false)
  })

  it('rejects a success with no resolved_version', () => {
    expect(accepts(successResult({ resolved_version: null }))).toBe(false)
  })

  // A no-op made no commit and wrote no override, so it cannot have added one.
  it('rejects a no-op claiming it added a bare override', () => {
    expect(accepts(noOpResult({ bare_override: 'added' }))).toBe(false)
  })

  it('accepts each band the scorer actually emits', () => {
    for (const band of ['Low', 'Medium', 'High']) {
      const r = successResult({ risk: { band, score: 3, f4: 0, f5: 0 } })
      expect(accepts(r), band).toBe(true)
    }
  })

  it('rejects a risk band outside the scorer vocabulary', () => {
    expect(accepts(successResult({ risk: { band: 'Critical', score: 3, f4: 0, f5: 0 } }))).toBe(false)
    expect(accepts(successResult({ risk: { band: 'low', score: 3, f4: 0, f5: 0 } }))).toBe(false)
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

  // A stub agent that reports the identity of the group it was actually given,
  // which is what a real fix agent does — and what pairEntry checks. Derived
  // from the dispatch rather than re-parsed out of the label, so these
  // examples assert shipped logic and not a fixture's own string handling.
  const echoFor = (dispatches) => (_prompt, opts, i) => {
    const d = dispatches.find((x) => agentLabel(x) === opts.label)
    expect(d, `agent called with an unknown label: ${opts.label}`).toBeDefined()
    return successResult({
      package: d.group.package,
      major_line: d.group.major_line,
      repo: d.group.repo,
      branch: d.group.branch_name,
      pr_url: `https://github.com/octo/app/pull/${i}`,
    })
  }
  const echo = echoFor(batch(64))

  it('dispatches exactly one agent per group and returns one entry per group', async () => {
    const dispatches = batch(7)
    const { entries, calls } = await runWorkflow({ main, args: { cap: 3, dispatches }, agent: echo })
    expect(calls).toHaveLength(7)
    expect(entries).toHaveLength(7)
    expect(entries.every((e) => e.mispaired === false)).toBe(true)
  })

  // THE assertion this suite was missing. Replacing dispatchPrompt(d) with a
  // bare string left all 90 examples green at 100% coverage: dispatchPrompt
  // stayed covered because other examples call it directly, and nothing ever
  // looked at what the agent was actually told. The prompt carries the entire
  // dispatch payload, so it is the most consequential thing this workflow
  // does.
  it('sends each agent exactly the prompt built for its own group', async () => {
    const dispatches = batch(5)
    const { calls } = await runWorkflow({ main, args: { cap: 2, dispatches }, agent: echo })
    // Workers steal, so pair by label rather than by call order.
    for (const d of dispatches) {
      const c = calls.find((x) => x.opts.label === agentLabel(d))
      expect(c, `no agent call for ${agentLabel(d)}`).toBeDefined()
      expect(c.prompt).toBe(dispatchPrompt(d))
    }
    expect(calls).toHaveLength(dispatches.length)
  })

  it('round-trips the whole payload out of every prompt it sent', async () => {
    const dispatches = batch(4)
    const { calls } = await runWorkflow({ main, args: { cap: 4, dispatches }, agent: echo })
    const sent = calls
      .map((c) => JSON.parse(c.prompt.split('Dispatch payload:\n')[1]))
      .sort((a, b) => a.group.package.localeCompare(b.group.package))
    expect(sent).toEqual([...dispatches].sort((a, b) => a.group.package.localeCompare(b.group.package)))
  })

  it('never sends a prompt that is not one of the built payloads', async () => {
    const dispatches = batch(3)
    const { calls } = await runWorkflow({ main, args: { cap: 1, dispatches }, agent: echo })
    const allowed = new Set(dispatches.map((d) => dispatchPrompt(d)))
    for (const c of calls) expect(allowed.has(c.prompt)).toBe(true)
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

  // agent() throws on budget exhaustion. parallel() would swallow that into a
  // null thunk result, leaving the groups that worker was holding as nulls
  // indistinguishable from crashed agents. The run must fail loudly instead.
  it('fails the whole run loudly when an agent call throws', async () => {
    const dispatches = batch(6)
    const boom = (prompt, opts, i) => {
      if (i === 0) throw new Error('token budget exhausted')
      return echo(prompt, opts, i)
    }
    await expect(runWorkflow({ main, args: { cap: 2, dispatches }, agent: boom }))
      .rejects.toThrow(/token budget exhausted/)
  })

  it('says how many groups have no result, and points at the interruption contract', async () => {
    const dispatches = batch(3)
    const boom = () => { throw new Error('token budget exhausted') }
    await expect(runWorkflow({ main, args: { cap: 1, dispatches }, agent: boom }))
      .rejects.toThrow(/3 of 3 group\(s\) have no result/)
    await expect(runWorkflow({ main, args: { cap: 1, dispatches }, agent: boom }))
      .rejects.toThrow(/resume from the runId/)
  })

  // A thrown non-Error has no .message, and the abandonment report must still
  // name something rather than "undefined". Found by the branch threshold:
  // this path was the one line the suite did not reach.
  it('reports a thrown non-Error too', async () => {
    const boom = () => { throw 'budget gone' }
    await expect(runWorkflow({ main, args: { cap: 1, dispatches: batch(2) }, agent: boom }))
      .rejects.toThrow(/budget gone/)
  })

  it('logs the abandonment before it throws', async () => {
    const dispatches = batch(4)
    const logs = []
    const boom = (prompt, opts, i) => {
      if (i === 1) throw new Error('token budget exhausted')
      return echo(prompt, opts, i)
    }
    await runWorkflow({ main, args: { cap: 1, dispatches }, agent: boom, logs })
      .catch(() => {})
    expect(logs.join('\n')).toMatch(/worker\(s\) stopped early/)
  })

  it('never reports a partial batch as ordinary failures', async () => {
    // The hazard in one line: a resolved value here would be read by phase 7
    // as "these groups crashed", when in fact they were never dispatched.
    const boom = () => { throw new Error('token budget exhausted') }
    const outcome = await runWorkflow({ main, args: { cap: 1, dispatches: batch(2) }, agent: boom })
      .then(() => 'resolved', () => 'rejected')
    expect(outcome).toBe('rejected')
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
  //
  // These read the artifact FROM DISK — the same bytes vitest imported and
  // instrumented — rather than re-projecting in memory and comparing that to
  // itself. An earlier version did the latter, which certified that project()
  // is faithful while saying nothing about the file actually measured: a
  // partial or stale write satisfied every example.
  const onDisk = async () => readFile(PROJECTION_URL, 'utf8')

  it('is on disk, and is exactly what project() produces from the shipped file', async () => {
    expect(await onDisk()).toBe(project(await workflowSource()))
  })

  it('copies the pure region verbatim into the measured artifact', async () => {
    const src = await workflowSource()
    expect(await onDisk()).toContain(region(src, PURE_BEGIN, PURE_END))
  })

  it('copies the wiring region verbatim into the measured artifact', async () => {
    const src = await workflowSource()
    expect(await onDisk()).toContain(region(src, WIRING_BEGIN, null))
  })

  // region() appears on both sides of the assertions above, so a bug in it
  // would be invisible there. Pin it against a hand-built input instead.
  it('slices regions by their markers, independently of the shipped file', () => {
    const src = `head\n${PURE_BEGIN}\nPURE\n${PURE_END}\nmid\n${WIRING_BEGIN}\nWIRE\n`
    expect(region(src, PURE_BEGIN, PURE_END)).toBe('PURE')
    expect(region(src, WIRING_BEGIN, null)).toBe('WIRE')
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

  // indexOf silently takes the first of a duplicate pair, so a second marker
  // would truncate the region and a reordered file would project duplicated
  // declarations that fail later as an unrelated syntax error.
  it('refuses a duplicated marker rather than taking the first', async () => {
    const src = await workflowSource()
    for (const marker of [PURE_BEGIN, PURE_END, WIRING_BEGIN]) {
      expect(() => project(`${src}\n${marker}\n`), marker)
        .toThrow(/appears more than once/)
    }
  })

  it('refuses markers that are out of order', () => {
    const src = `${WIRING_BEGIN}\nWIRE\n${PURE_BEGIN}\nPURE\n${PURE_END}\n`
    expect(() => project(src)).toThrow(/out of order/)
  })

  it('accepts the shipped file markers as they stand', async () => {
    const src = await workflowSource()
    expect(() => assertMarkersOnce(src)).not.toThrow()
  })

  // Forty lines of the shipped file — the header and `export const meta` —
  // sit above the pure marker, so the projection never touches them and no
  // example parsed them. A trailing comma inside meta, a mis-nested brace, or
  // a stray token up there shipped green, which is the same unparseable-code
  // problem ADR 010's Context indicts the markdown fence for. So load the
  // WHOLE file the way the harness does: strip `export` off meta, then
  // evaluate the entire remainder as an async function body.
  describe('the whole file parses and evaluates the way the harness loads it', () => {
    const harnessLoad = async () => {
      const src = await workflowSource()
      const body = src.replace(/^export const meta =/m, 'const meta =')
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      return new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args',
        `${body}\n;return meta\n`)
    }

    it('parses as an async function body, meta and header included', async () => {
      await expect(harnessLoad()).resolves.toBeInstanceOf(Function)
    })

    // The meta literal on its own: evaluating the whole body would run the
    // wiring and hit its own `return` first.
    const evalMeta = async () => {
      const src = await workflowSource()
      const at = src.search(/^export const meta = \{$/m)
      const end = src.indexOf('\n}\n', at)
      const literal = src.slice(at, end + 2).replace(/^export /, '')
      // eslint-disable-line no-new-func — same evaluation the harness does
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      return new AsyncFunction(`${literal}\n;return meta\n`)()
    }

    it('evaluates to a meta object with the phase title phase() opens', async () => {
      const meta = await evalMeta()
      expect(meta.name).toBe('gh-security-fix-dispatch')
      expect(typeof meta.description).toBe('string')
      // Every declared phase must have a phase() call that opens it, or the
      // progress display silently grows an empty group.
      const { phases } = await runWorkflow({
        main, args: { cap: 1, dispatches: [dispatch()] }, agent: () => successResult(),
      })
      expect(meta.phases.map((p) => p.title)).toEqual(phases)
      expect(meta.phases.every((p) => p.model === 'sonnet')).toBe(true)
    })

    it('is rejected as a whole when the header above the markers is malformed', async () => {
      const src = await workflowSource()
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const load = (text) => new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args',
        text.replace(/^export const meta =/m, 'const meta ='))
      // Both mutations live in the forty lines above the pure marker, which
      // the projection never sees. Before this example they shipped green.
      expect(() => load(src.replace(
        "name: 'gh-security-fix-dispatch',", "name: 'gh-security-fix-dispatch',,"))).toThrow()
      expect(() => load(src.replace('  phases: [', '  phases: [[['))).toThrow()
      expect(() => load(src)).not.toThrow()
    })
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

  // The stripper the purity check depends on. Without these, it recognised
  // only single-quoted strings, so an error message rewritten with double
  // quotes or a template literal — both of which name `args.dispatches` for
  // the caller — would fail the suite on prose rather than on a real use.
  describe('the stripper the purity check depends on', () => {
    for (const [form, code] of [
      ['single-quoted', "const m = 'args.cap must be a number'"],
      ['double-quoted', 'const m = "args.cap must be a number"'],
      ['a template literal', 'const m = `args.dispatches[${i}] is bad`'],
    ]) {
      it(`strips ${form} strings`, () => {
        expect(stripCommentsAndStrings(code)).not.toMatch(/\bargs\b/)
      })
    }

    it('strips line comments', () => {
      expect(stripCommentsAndStrings('  // args.cap is the width\nconst x = 1'))
        .not.toMatch(/\bargs\b/)
    })

    // And does NOT hide a real use, which is the whole point.
    it('leaves an actual use of the global visible', () => {
      expect(stripCommentsAndStrings('const n = args.dispatches.length')).toMatch(/\bargs\b/)
      expect(stripCommentsAndStrings("const n = args.dispatches.length // 'args'"))
        .toMatch(/\bargs\b/)
    })
  })

  it('keeps the pure region free of every harness global', async () => {
    const src = await workflowSource()
    // Strip line comments and single-quoted strings, so neither a prose
    // mention of `agent()` nor an error message naming `args.cap` for the
    // caller's benefit reads as a USE of the global.
    const code = stripCommentsAndStrings(region(src, PURE_BEGIN, PURE_END))
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
