// Load plugins/gh-security/workflows/fix-groups.mjs the way the Claude Code
// Workflow tool does, so the tests run the SHIPPED BYTES rather than a copy.
//
// Why not `import()` the workflow directly: it is not a plain ES module. Its
// contract requires both `export const meta = {...}` and a top-level
// `return`, and it receives `agent`/`parallel`/`phase`/`log`/`args` as
// injected globals rather than imports. No ES module can have that shape, so
// the harness necessarily strips `meta` out and evaluates the remainder as a
// function body. This file reproduces exactly that, which is also why the
// workflow may not `import` a sibling module and why its pure logic is
// marked off in-file instead.
//
// Two entry points, because the two things worth testing have different
// shapes. `loadPure()` evaluates only the pure region and hands back its
// functions for unit tests. `runWorkflow()` evaluates the whole file with
// stubbed collaborators, which is the end-to-end wiring test.
//
// Every slice is asserted non-empty before it is used: a marker that stops
// matching would otherwise evaluate an empty string, define nothing, and
// produce a suite that passes having tested nothing at all — this repo's
// signature bug class.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const WORKFLOW_URL = new URL(
  '../../plugins/gh-security/workflows/fix-groups.mjs',
  import.meta.url,
)

export const WORKFLOW_PATH = fileURLToPath(WORKFLOW_URL)

const PURE_BEGIN = '// >>> pure: begin'
const PURE_END = '// >>> pure: end'
const WIRING_BEGIN = '// >>> wiring: begin'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function workflowSource() {
  return readFile(WORKFLOW_URL, 'utf8')
}

function slice(src, open, close) {
  const a = src.indexOf(open)
  if (a === -1) throw new Error(`marker not found in the workflow: ${open}`)
  const from = a + open.length
  const to = close === null ? src.length : src.indexOf(close, from)
  if (to === -1) throw new Error(`marker not found in the workflow: ${close}`)
  const out = src.slice(from, to).trim()
  if (!out) throw new Error(`the region after ${open} is empty; nothing would be tested`)
  return out
}

// Strip line comments and single-quoted string literals, so that neither a
// prose mention of `agent()` in the region's own commentary nor an error
// message that names `args.cap` for the caller's benefit reads as a USE of
// the harness global. Only the remaining code is searched.
export function stripCommentsAndStrings(src) {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''")
}

// The names the pure region defines. Listed here so a function silently
// renamed or deleted fails loudly at load rather than surfacing as an
// unrelated "not a function" deep inside one example.
export const PURE_EXPORTS = [
  'RESULT_SCHEMA',
  'validateArgs',
  'workerCount',
  'dispatchPrompt',
  'agentLabel',
  'pairEntry',
]

export async function loadPure() {
  const src = slice(await workflowSource(), PURE_BEGIN, PURE_END)
  const epilogue = `\nreturn { ${PURE_EXPORTS.join(', ')} }\n`
  const mod = await new AsyncFunction(src + epilogue)()
  for (const name of PURE_EXPORTS) {
    if (mod[name] === undefined) {
      throw new Error(`the pure region no longer defines ${name}`)
    }
  }
  return mod
}

// Run the whole workflow with stubbed collaborators. `agent` is whatever the
// caller supplies; the rest reproduce the documented semantics — notably
// parallel()'s contract that a thunk which throws resolves to null rather
// than rejecting the call.
export async function runWorkflow({ args, agent }) {
  const src = await workflowSource()
  // `meta` is extracted by the real harness before the body is evaluated;
  // here it just becomes an ordinary binding.
  // Anchored at line start: the file's own header comment quotes
  // `export const meta = {...}`, and an unanchored replace would rewrite the
  // comment and leave the real declaration exporting.
  const body = src.replace(/^export const meta =/m, 'const meta =')
  if (body === src) throw new Error('the workflow no longer declares `export const meta =`')
  if (!body.includes(WIRING_BEGIN)) throw new Error('the workflow lost its wiring marker')

  const calls = []
  const logs = []
  const phases = []

  const agentStub = (prompt, opts) => {
    calls.push({ prompt, opts })
    return agent(prompt, opts, calls.length - 1)
  }
  const parallelStub = (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))

  const run = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', body)
  const entries = await run(
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
