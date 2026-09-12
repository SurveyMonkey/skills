// fix-groups.mjs — resolve-alerts phase 6's dispatch, as a Workflow script.
//
// Launched by skills/resolve-alerts/SKILL.md as
//   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/fix-groups.mjs",
//              args: { cap, dispatches } })
// and it does exactly two things: fan one `fix-dependency` agent out per
// approved group, bounded by the machine capacity cap, and validate each
// result against the Result contract in agents/fix-dependency.md. The reap
// (one common/post-agent.sh call per returned entry) and the phase 7 summary
// stay with the orchestrator; see ADR 003's amendments.
//
// ---------------------------------------------------------------------------
// Why this file has no `import`, and why it is split by markers
// ---------------------------------------------------------------------------
// A Workflow script is not loaded as a plain ES module. It is required to
// begin with `export const meta = {...}` AND to `return` a value at top
// level, and its collaborators (`agent`, `parallel`, `phase`, `log`, `args`)
// arrive as injected globals rather than imports — a combination no ES module
// can have, so the harness necessarily extracts `meta` and evaluates the rest
// as a function body. The reference does not say whether such a script may
// `import` a sibling module, and under the wrapping that its own contract
// implies, a top-level `import` would not even parse. So this file imports
// nothing and is self-contained.
//
// That would normally cost testability. It does not, because everything above
// the `wiring` marker below is pure: no globals, no I/O, no harness. The
// vitest suite (spec/js/) slices this region out of THIS file and evaluates
// it, so the tests run the shipped bytes rather than a copy. Keep the markers
// exact, keep the region pure, and add nothing to it that touches `agent`,
// `parallel`, `phase`, `log` or `args`.
// ---------------------------------------------------------------------------

export const meta = {
  name: 'gh-security-fix-dispatch',
  description: 'Fix each approved Dependabot alert group with its own subagent, bounded by the machine capacity cap',
  phases: [
    { title: 'Fix groups', detail: 'one fix-dependency agent per approved group', model: 'sonnet' },
  ],
}

// >>> pure: begin

// The Result block agents/fix-dependency.md promises. Validation happens at
// the tool-call layer, so a mismatch is retried rather than parsed out of a
// fence by the orchestrator.
const RESULT_SCHEMA = {
  type: 'object',
  required: [
    'status', 'package', 'major_line', 'repo', 'branch', 'pr_url', 'action',
    'resolved_version', 'risk', 'observations', 'requires_major_bump',
    'bare_override', 'no_op', 'failure', 'cleanup',
  ],
  properties: {
    status: { enum: ['success', 'no-op', 'failure'] },
    package: { type: 'string' },
    major_line: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    pr_url: { type: ['string', 'null'] },
    action: { enum: ['direct-update', 'scoped-override', 'bare-override', 'lockfile-refresh', null] },
    resolved_version: { type: ['string', 'null'] },
    risk: {
      type: ['object', 'null'],
      required: ['band', 'score', 'f4', 'f5'],
      properties: {
        // The scorer's own three bands (docs/adr/006, and the
        // merge-risk:low/medium/high labels render-pr.sh applies).
        band: { enum: ['Low', 'Medium', 'High'] },
        score: { type: 'number' },
        f4: { type: 'number' },
        f5: { type: 'number' },
      },
    },
    // `type` is the only field every observation carries: the adapter emits
    // `unscoped_override`, `manifest_pnpm_overrides_ignored` and
    // `pnpm_major_unknown`, the agent appends `unscoped_override_added`, and
    // only the two override shapes carry `key`.
    // Do NOT narrow this to an enum: an adapter gaining a fourth type would
    // then fail every result it appears in.
    observations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string' },
          key: { type: 'string' },
          range: { type: 'string' },
          targets_this_package: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
    // validate's own array, verbatim: one entry per still-vulnerable copy
    // below the fix line (node.sh `$bump`), keyed by the resolved `version`
    // and the advisory ranges it still matches.
    requires_major_bump: {
      type: 'array',
      items: {
        type: 'object',
        required: ['version', 'vulnerable_ranges'],
        properties: {
          version: { type: 'string' },
          vulnerable_ranges: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    bare_override: { enum: ['none', 'added', 'tightened'] },
    no_op: {
      type: ['object', 'null'],
      required: ['reason', 'evidence'],
      properties: { reason: { type: 'string' }, evidence: { type: 'object' } },
    },
    failure: {
      type: ['object', 'null'],
      required: ['phase', 'detail'],
      properties: {
        phase: {
          enum: ['input', 'worktree', 'baseline', 'classify', 'apply', 'install', 'validate', 'push', 'pr'],
        },
        detail: { type: 'string' },
      },
    },
    // `fix-group.sh cleanup` runs AFTER the commit, push and `gh pr create`,
    // and exits 3 when it leaves a worktree behind. That failure can follow
    // completed work, so it is reported here rather than through `failure`:
    // null when cleanup finished with no errors, otherwise the driver's own
    // cleanup report (minus its `status`/`step`).
    //
    // **This must be permitted alongside every status, success included.**
    // Forcing a cleanup error into the `failure` branch would make the agent
    // choose between reporting `success` and hiding the leak — the exact
    // thing `exit 3` exists to prevent — or reporting `failure`, which hides
    // a real open PR from phase 7 AND suppresses `post-agent.sh`'s reap,
    // since that only reaps a verified-open PR from a `success`. The leak
    // would then be missed by the second line of defence too. So the `oneOf`
    // branches below deliberately say nothing about `cleanup`.
    //
    // `worktree.path` and `work_dir.path` are the paths the driver RESOLVED
    // and acted on, which can differ textually from the ones the orchestrator
    // dispatched (`/private/var/...` against `/var/...` on macOS is the
    // specimen). Anything correlating them with a path built anywhere else —
    // `post-agent.sh` derives its own, unresolved — must resolve or
    // suffix-match rather than compare strings, or one leaked directory reads
    // as two.
    cleanup: {
      type: ['object', 'null'],
      required: ['worktree', 'work_dir', 'branch', 'errors'],
      properties: {
        worktree: {
          type: 'object',
          required: ['path', 'action'],
          properties: { path: { type: 'string' }, action: { type: 'string' } },
        },
        work_dir: {
          type: 'object',
          required: ['path', 'action'],
          properties: { path: { type: 'string' }, action: { type: 'string' } },
        },
        branch: { type: 'string' },
        branch_deleted: { type: 'boolean' },
        branch_tip: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] },
        errors: { type: 'array', items: { type: 'string' } },
        detail: { type: ['string', 'null'] },
      },
    },
  },
  // Cross-field rules used to live here as `oneOf`/`allOf`. The tool-schema
  // layer agent()'s `schema:` option is passed through rejects any of those
  // keywords at the schema ROOT — "input_schema does not support oneOf,
  // allOf, or anyOf at the top level" — so every dispatch threw before an
  // agent ever ran (#200). Those checks now live in `crossFieldViolations`
  // below, run on each result after `agent()` returns, warned rather than
  // enforced (see the wiring region for why).
}

// Exactly one of no_op/failure is non-null, both are null on success, and
// each agrees with `status`. Without this, {"status":"failure",
// "failure":null} is field-for-field structurally valid, clears
// post-agent.sh's gate (which reads only branch/package/major_line), and
// reaches phase 7's "failures get their phase and detail" with no data.
//
// bare_override must agree with action, in both directions — but ONLY on
// success. `action` is null on every failure, while `bare_override` still
// reports what was written, and `apply_constraint` writes the override
// BEFORE `install`: a validate_failed_after_ladder, an install_failure, a
// hook-rejected push and a failed pr all reach `status: "failure"` with
// `bare_override: "added"`. Ungated, no value of `action` satisfies both
// this rule and the failure branch above, and the tempting "fix" is to
// report `bare_override: "none"` — silently hiding a global pin on exactly
// the escalation a reviewer needs it on, and destroying the
// `unscoped_override_added` observation the pin audit depends on.
// `agents/fix-dependency.md` scopes the agreement rule to success, so the
// validator and the instruction the model actually reads agree.
//
// Returns an array of violation strings; empty means the result is
// consistent. Never throws: `post-agent.sh` and phase 7 read `no_op`,
// `failure`, `action` and `bare_override` directly off the result already,
// so a violation here is logged rather than failing the whole batch — the
// same information those two readers would otherwise silently disagree
// about is instead surfaced once, at the point the result arrives.
function crossFieldViolations(r) {
  const violations = []
  const bothNull = r.no_op === null && r.failure === null
  const onlyNoOp = r.no_op !== null && r.failure === null
  const onlyFailure = r.no_op === null && r.failure !== null

  if (r.status === 'success') {
    if (!bothNull) violations.push('status "success" requires no_op and failure to both be null')
    if (typeof r.pr_url !== 'string') violations.push('status "success" requires a non-null pr_url')
    if (typeof r.action !== 'string') violations.push('status "success" requires a non-null action')
    if (typeof r.resolved_version !== 'string') {
      violations.push('status "success" requires a non-null resolved_version')
    }
    if (r.risk === null || typeof r.risk !== 'object') violations.push('status "success" requires a non-null risk')
    if (['added', 'tightened'].includes(r.bare_override) && r.action !== 'bare-override') {
      violations.push('bare_override "' + r.bare_override + '" requires action "bare-override"')
    }
    if (r.action === 'bare-override' && !['added', 'tightened'].includes(r.bare_override)) {
      violations.push('action "bare-override" requires bare_override "added" or "tightened"')
    }
  } else if (r.status === 'no-op') {
    if (!onlyNoOp) violations.push('status "no-op" requires no_op to be non-null and failure to be null')
    if (r.pr_url !== null) violations.push('status "no-op" requires pr_url to be null')
    if (r.action !== null) violations.push('status "no-op" requires action to be null')
    if (typeof r.resolved_version !== 'string') {
      violations.push('status "no-op" requires a non-null resolved_version')
    }
    if (r.risk !== null) violations.push('status "no-op" requires risk to be null')
    // A no-op made no commit and wrote no override, so it cannot have added
    // or tightened one.
    if (r.bare_override !== 'none') violations.push('status "no-op" requires bare_override to be "none"')
  } else if (r.status === 'failure') {
    if (!onlyFailure) violations.push('status "failure" requires failure to be non-null and no_op to be null')
    if (r.pr_url !== null) violations.push('status "failure" requires pr_url to be null')
    if (r.action !== null) violations.push('status "failure" requires action to be null')
    if (r.resolved_version !== null) violations.push('status "failure" requires resolved_version to be null')
    if (r.risk !== null) violations.push('status "failure" requires risk to be null')
  }

  return violations
}

// Refuse a malformed `args` loudly. Every failure here is silent otherwise: a
// stringified `args` leaves `args.dispatches` undefined, and a missing `cap`
// makes the worker count NaN, Array.from({length: NaN}) empty, and
// parallel([]) return at once with every entry still null — which phase 7
// would faithfully report as a whole batch of crashed agents when nothing was
// ever dispatched. An empty dispatch list is refused for the same reason: it
// is indistinguishable downstream from a clean run over nothing.
function validateArgs(a) {
  if (!a || !Array.isArray(a.dispatches) || !a.dispatches.length) {
    throw new Error('args.dispatches must be a non-empty array of dispatch payloads (pass args as JSON, never as a JSON-encoded string)')
  }
  if (typeof a.cap !== 'number' || !(a.cap >= 1)) {
    throw new Error('args.cap must be a number >= 1, from detect-capacity.sh')
  }
  // pairEntry compares four group fields against what the agent reports back.
  // An absent one is `undefined`, so every comparison is false, every entry
  // is mispaired and nulled, and phase 7 reports a whole batch of crashed
  // agents over a run in which every pull request was opened — with the reap
  // never running. That is the same silent, inverted report the guards above
  // exist to refuse, so the fields pairEntry depends on are checked here too,
  // naming the index and the field rather than failing downstream.
  for (let i = 0; i < a.dispatches.length; i += 1) {
    const d = a.dispatches[i]
    const g = d && d.group
    if (!g || typeof g !== 'object') {
      throw new Error('args.dispatches[' + i + '].group is missing; every dispatch carries that group JSON verbatim')
    }
    const named = ['package', 'repo', 'branch_name']
    for (let k = 0; k < named.length; k += 1) {
      const field = named[k]
      if (typeof g[field] !== 'string' || !g[field].length) {
        throw new Error('args.dispatches[' + i + '].group.' + field
          + ' must be a non-empty string; the result identity check compares it against what the agent reports')
      }
    }
    // `major_line` may arrive as a number (6) rather than a string ("6.x"):
    // the layer that builds these payloads accepts and coerces one, so
    // refusing it here would reject a payload the rest of the stack handles.
    const line = g.major_line
    if (!(typeof line === 'number' || (typeof line === 'string' && line.length))) {
      throw new Error('args.dispatches[' + i
        + '].group.major_line must be a non-empty string or a number; the result identity check compares it against what the agent reports')
    }
  }
}

// The worker count IS the cap: the pool cannot exceed it and no count the
// orchestrator keeps has to track it. More workers than groups would be idle,
// so the batch size floors it.
function workerCount(cap, total) {
  return Math.min(cap, total)
}

function dispatchPrompt(d) {
  return 'Follow your agent definition end to end and finish with its JSON result block.\n'
    + 'Dispatch payload:\n' + JSON.stringify(d, null, 2)
}

function agentLabel(d) {
  return d.group.repo + ' ' + d.group.package + ' ' + d.group.major_line
}

// Never pair a result to a dispatch by position alone. The workers steal from
// a shared cursor, so the order agent() calls are initiated varies between
// runs, and resume caches "the longest unchanged prefix of agent() calls"
// without saying whether a call is matched by CONTENT or only by position. If
// it is positional, a resumed run could hand entry i another group's result,
// and the reap would then delete the wrong branch. The agent reports its own
// identity, so check it — and on a mismatch drop the result entirely rather
// than flagging it and hoping every reader honors the flag: a `pr_url` or
// `branch` belonging to a different group must be unreachable, not merely
// discouraged.
function pairEntry(d, r) {
  const paired = Boolean(r)
    && r.package === d.group.package
    && r.major_line === d.group.major_line
    && r.repo === d.group.repo
    && r.branch === d.group.branch_name
  const mispaired = Boolean(r) && !paired
  return { dispatch: d, result: mispaired ? null : r, mispaired }
}

// >>> pure: end
// >>> wiring: begin

validateArgs(args)

const DISPATCHES = args.dispatches
const WORKERS = workerCount(args.cap, DISPATCHES.length)
log('Dispatching ' + DISPATCHES.length + ' group(s), ' + WORKERS + ' at a time')

phase('Fix groups')

const results = new Array(DISPATCHES.length).fill(null)
let next = 0

// agent() returns null when a subagent dies on a terminal error, which is an
// ordinary failure entry. It THROWS on budget exhaustion, and that is a
// different animal: parallel() resolves a throwing thunk to null, so the
// worker would die silently while `next` had already advanced past the group
// it was holding. Every group that worker would have taken stays null and
// reads in phase 7 as a crashed agent — indistinguishable from a real crash,
// which is precisely the silent misreport validateArgs exists to prevent.
// So: record it and fail the whole run loudly afterwards. Phase 6's
// interruption contract is written for exactly this (recover from the
// journal, then resume from the runId), and a loud throw routes there, while
// a quiet batch of nulls does not.
const aborted = []

const worker = async () => {
  while (next < DISPATCHES.length) {
    const i = next
    next += 1
    const d = DISPATCHES[i]
    try {
      // Indexed write, never a push: workers finish out of order, and phase 7
      // is promised the entries in dispatch order.
      results[i] = await agent(dispatchPrompt(d), {
        // Plugin agents are registered namespaced (<plugin>:<agent>); the bare
        // name is not a resolvable agent type (#187).
        agentType: 'gh-security:fix-dependency',
        // ADR 004's pin, stated here because a workflow agent() without
        // `model` inherits the session model and composition with the target
        // definition's frontmatter is unspecified.
        model: 'sonnet',
        phase: 'Fix groups',
        label: agentLabel(d),
        schema: RESULT_SCHEMA,
      })
    } catch (e) {
      aborted.push({ group: d.group, error: (e && e.message) || String(e) })
      throw e
    }
    // The schema can no longer express these rules (#200), so check them here
    // and warn: `post-agent.sh` and phase 7 read `no_op`/`failure`/`action`/
    // `bare_override` off this same result directly, so failing the batch
    // over an inconsistency they will surface anyway would lose a completed
    // fix — including one that already opened a pull request — for a defect
    // in the agent's own bookkeeping.
    if (results[i]) {
      const violations = crossFieldViolations(results[i])
      if (violations.length) {
        log('Cross-field inconsistency in the result for ' + agentLabel(d) + ': ' + violations.join('; '))
      }
    }
  }
}

await parallel(Array.from({ length: WORKERS }, () => () => worker()))

if (aborted.length) {
  const missing = results.filter((r) => r === null).length
  log('A subagent call threw, so ' + aborted.length + ' worker(s) stopped early and '
    + missing + ' of ' + DISPATCHES.length + ' group(s) have no result.')
  throw new Error('agent() threw for ' + aborted[0].group.package + ' '
    + aborted[0].group.major_line + ': ' + aborted[0].error + '. '
    + missing + ' of ' + DISPATCHES.length + ' group(s) have no result, so this run is '
    + 'incomplete rather than a batch of failures. Recover it with the interruption '
    + 'contract in SKILL.md phase 6 — read the journal, then resume from the runId — '
    + 'and never read this as "nothing ran".')
}

return DISPATCHES.map((d, i) => pairEntry(d, results[i]))
