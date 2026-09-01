// Test fixtures and collaborator stubs for the dispatch workflow.
//
// The subject under test is `spec/js/generated/workflow.mjs`, the importable
// projection of plugins/gh-security/workflows/fix-groups.mjs that
// spec/js/generate.mjs writes before the suite runs. Its header explains why
// the shipped file cannot be imported directly and how the projection stays
// faithful; fix-groups.test.mjs asserts the byte-identity that makes covering
// the projection equivalent to covering the shipped file.
//
// Nothing here is the subject of the coverage gate: this file and the test
// file are test infrastructure, and vitest.config.mjs's `include` names only
// the projection. Measuring the harness would let a helper nobody calls drag
// the number around without any shipped code changing.

import { readFile } from 'node:fs/promises'

import { WORKFLOW_URL } from './generate.mjs'

export async function workflowSource() {
  return readFile(WORKFLOW_URL, 'utf8')
}

// Run the projected workflow with stubbed collaborators. `agent` is whatever
// the caller supplies; the rest reproduce the documented semantics — notably
// parallel()'s contract that a thunk which throws resolves to null rather
// than rejecting the call.
export async function runWorkflow({ args, agent, main }) {
  const calls = []
  const logs = []
  const phases = []

  const agentStub = (prompt, opts) => {
    calls.push({ prompt, opts })
    return agent(prompt, opts, calls.length - 1)
  }
  const parallelStub = (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))

  const entries = await main(
    agentStub,
    parallelStub,
    (t) => phases.push(t),
    (m) => logs.push(m),
    args,
  )
  return { entries, calls, logs, phases }
}

// A result that satisfies RESULT_SCHEMA, as the base for mutation in the
// schema examples. Overrides are shallow-merged so an example states only the
// field it is about.
export function successResult(over = {}) {
  return {
    status: 'success',
    package: 'undici',
    major_line: '6.x',
    repo: 'octo/app',
    branch: 'fix/dependabot-undici-6x',
    pr_url: 'https://github.com/octo/app/pull/1',
    action: 'scoped-override',
    resolved_version: '6.28.0',
    risk: { band: 'Low', score: 3, f4: 0, f5: 0 },
    observations: [],
    requires_major_bump: [],
    bare_override: 'none',
    no_op: null,
    failure: null,
    ...over,
  }
}

export function failureResult(over = {}) {
  return {
    status: 'failure',
    package: 'undici',
    major_line: '6.x',
    repo: 'octo/app',
    branch: 'fix/dependabot-undici-6x',
    pr_url: null,
    action: null,
    resolved_version: null,
    risk: null,
    observations: [],
    requires_major_bump: [],
    bare_override: 'none',
    no_op: null,
    failure: { phase: 'install', detail: 'install failed' },
    ...over,
  }
}

export function noOpResult(over = {}) {
  return {
    status: 'no-op',
    package: 'undici',
    major_line: '6.x',
    repo: 'octo/app',
    branch: 'fix/dependabot-undici-6x',
    pr_url: null,
    action: null,
    resolved_version: '6.28.0',
    risk: null,
    observations: [],
    requires_major_bump: [],
    bare_override: 'none',
    no_op: { reason: 'already fixed on main', evidence: { diff: '' } },
    failure: null,
    ...over,
  }
}

// One dispatch payload, in the shape SKILL.md phase 6 builds.
export function dispatch(over = {}) {
  const group = {
    repo: 'octo/app',
    package: 'undici',
    major_line: '6.x',
    branch_name: 'fix/dependabot-undici-6x',
    ...(over.group || {}),
  }
  const out = {
    group,
    adapter_path: '/p/scripts/ecosystems/node.sh',
    nwo: group.repo,
    default_branch: 'main',
    repo_root: '/w/app',
    scripts_dir: '/p/scripts/common',
  }
  for (const [k, v] of Object.entries(over)) {
    if (k !== 'group') out[k] = v
  }
  return out
}
