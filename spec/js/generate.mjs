// Project the shipped Workflow script into an importable ES module, so that
// coverage instrumentation can see it.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// plugins/gh-security/workflows/fix-groups.mjs cannot be `import`ed. Its
// contract requires `export const meta = {...}` AND a top-level `return`, and
// it receives `agent`/`parallel`/`phase`/`log`/`args` as injected globals — a
// shape no ES module can have (a top-level `return` is a SyntaxError in one).
// The Workflow tool's own documentation describes `scriptPath` as pointing at
// a file it persisted from an inline script string, which is the clearest
// statement available that a script is read as source and evaluated, not
// imported as a module.
//
// Evaluating a string is therefore the faithful way to test it — and it was
// how spec/js/harness.mjs worked — but V8 attributes an evaluated string to no
// file, so the coverage report came back naming only the test harness and not
// one line of the shipped script. A `//# sourceURL=` pointing at the real path
// was tried and does not change that: vitest's provider reports modules from
// its own transform pipeline, and an evaluated script is in nobody's module
// graph. **A 100% threshold over that report would have been the vacuous pass
// this repo refuses everywhere else** — green while instrumenting none of the
// code it claims to gate.
//
// So the source is projected instead of evaluated. Both regions of the shipped
// file are copied **verbatim**, and the only things added are an export list
// and a function wrapper:
//
//   * the pure region becomes ordinary module-level declarations, exported by
//     name at the end so the region's own bytes are untouched;
//   * the wiring region becomes the body of `main(agent, parallel, phase, log,
//     args)`, which is exactly the shape the harness gives it — the injected
//     globals become parameters, and its top-level `return` becomes that
//     function's return.
//
// The result is a real module, imported by the tests and instrumented like any
// other. `spec/js/fix-groups.test.mjs` asserts that both regions appear in it
// byte-for-byte, so covering the projection is covering the shipped bytes; if
// that assertion ever fails, the coverage number stops meaning anything and
// the suite says so.
//
// The projection is regenerated on every run, is gitignored, and is never
// edited by hand. Editing it would be editing a build artifact.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const WORKFLOW_URL = new URL(
  '../../plugins/gh-security/workflows/fix-groups.mjs',
  import.meta.url,
)
export const PROJECTION_URL = new URL('./generated/workflow.mjs', import.meta.url)

export const WORKFLOW_PATH = fileURLToPath(WORKFLOW_URL)
export const PROJECTION_PATH = fileURLToPath(PROJECTION_URL)

export const PURE_BEGIN = '// >>> pure: begin'
export const PURE_END = '// >>> pure: end'
export const WIRING_BEGIN = '// >>> wiring: begin'

// The names the pure region defines. Listed here so a declaration silently
// renamed or deleted fails loudly at generation rather than surfacing as an
// unrelated "not a function" deep inside one example.
export const PURE_EXPORTS = [
  'RESULT_SCHEMA',
  'validateArgs',
  'workerCount',
  'dispatchPrompt',
  'agentLabel',
  'pairEntry',
]

// Slice between two markers. An absent marker or an empty region is a hard
// error, never an empty string quietly projected into a module that defines
// nothing: that is the same found-nothing-is-a-pass shape every gate in this
// repo refuses.
export function region(src, open, close) {
  const a = src.indexOf(open)
  if (a === -1) throw new Error(`marker not found in the workflow: ${open}`)
  const from = a + open.length
  const to = close === null ? src.length : src.indexOf(close, from)
  if (to === -1) throw new Error(`marker not found in the workflow: ${close}`)
  const out = src.slice(from, to).trim()
  if (!out) throw new Error(`the region after ${open} is empty; nothing would be projected`)
  return out
}

export function project(src) {
  const pure = region(src, PURE_BEGIN, PURE_END)
  const wiring = region(src, WIRING_BEGIN, null)
  for (const name of PURE_EXPORTS) {
    if (!pure.includes(name)) throw new Error(`the pure region no longer defines ${name}`)
  }
  return `// GENERATED from plugins/gh-security/workflows/fix-groups.mjs by
// spec/js/generate.mjs. Do not edit: every change here is discarded on the
// next test run. Both regions below are copied verbatim from that file; the
// export list and the main() wrapper are the only additions, and they
// reproduce the shape the Claude Code harness gives the script.

${pure}

export { ${PURE_EXPORTS.join(', ')} }

export async function main(agent, parallel, phase, log, args) {
${wiring}
}
`
}

export async function generate() {
  const src = await readFile(WORKFLOW_URL, 'utf8')
  await mkdir(new URL('./generated/', import.meta.url), { recursive: true })
  await writeFile(PROJECTION_URL, project(src), 'utf8')
  return PROJECTION_PATH
}

// vitest globalSetup: the projection has to exist before the suite is
// collected, because the test file imports it statically.
export default async function setup() {
  await generate()
}
