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
    'bare_override', 'no_op', 'failure',
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
        band: { type: 'string' },
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
  },
  // Exactly one of no_op/failure is non-null, both are null on success, and
  // each agrees with `status`. Without this, {"status":"failure",
  // "failure":null} validates field-for-field, clears post-agent.sh's gate
  // (which reads only branch/package/major_line), and reaches phase 7's
  // "failures get their phase and detail" with no data.
  oneOf: [
    {
      properties: {
        status: { const: 'success' },
        pr_url: { type: 'string' },
        action: { type: 'string' },
        risk: { type: 'object' },
        no_op: { type: 'null' },
        failure: { type: 'null' },
      },
    },
    {
      properties: {
        status: { const: 'no-op' },
        pr_url: { type: 'null' },
        action: { type: 'null' },
        risk: { type: 'null' },
        no_op: { type: 'object' },
        failure: { type: 'null' },
      },
    },
    {
      properties: {
        status: { const: 'failure' },
        pr_url: { type: 'null' },
        action: { type: 'null' },
        risk: { type: 'null' },
        no_op: { type: 'null' },
        failure: { type: 'object' },
      },
    },
  ],
  // bare_override must agree with action, in both directions — but ONLY on
  // success. `action` is null on every failure, while `bare_override` still
  // reports what was written, and `apply_constraint` writes the override
  // BEFORE `install`: a validate_failed_after_ladder, an install_failure, a
  // hook-rejected push and a failed pr all reach `status: "failure"` with
  // `bare_override: "added"`. Ungated, no value of `action` satisfies both
  // this rule and the failure branch above, the agent is retried into a
  // `null` entry, and the likelier repair it finds is to report
  // `bare_override: "none"` — silently hiding a global pin on exactly the
  // escalation a reviewer needs it on, and destroying the
  // `unscoped_override_added` observation the pin audit depends on.
  // `agents/fix-dependency.md` states the agreement rule unconditionally and
  // nulls `action` on failure a few lines later; that reads fine as prose and
  // is only a contradiction once machine-checked. Both gates say so.
  allOf: [
    {
      if: {
        properties: { status: { const: 'success' }, bare_override: { enum: ['added', 'tightened'] } },
        required: ['status', 'bare_override'],
      },
      then: { properties: { action: { const: 'bare-override' } } },
    },
    {
      if: {
        properties: { status: { const: 'success' }, action: { const: 'bare-override' } },
        required: ['status', 'action'],
      },
      then: { properties: { bare_override: { enum: ['added', 'tightened'] } } },
    },
  ],
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

const worker = async () => {
  while (next < DISPATCHES.length) {
    const i = next
    next += 1
    const d = DISPATCHES[i]
    // Indexed write, never a push: workers finish out of order, and phase 7
    // is promised the entries in dispatch order.
    results[i] = await agent(dispatchPrompt(d), {
      agentType: 'fix-dependency',
      // ADR 004's pin, stated here because a workflow agent() without `model`
      // inherits the session model and composition with the target
      // definition's frontmatter is unspecified.
      model: 'sonnet',
      phase: 'Fix groups',
      label: agentLabel(d),
      schema: RESULT_SCHEMA,
    })
  }
}

await parallel(Array.from({ length: WORKERS }, () => () => worker()))

return DISPATCHES.map((d, i) => pairEntry(d, results[i]))
