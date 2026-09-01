---
type: ADR
description: Workflow scripts ship as files under plugins/*/workflows/ rather than markdown fences, and the repo gains a dev-and-CI JavaScript toolchain (vitest, ajv) with coverage thresholds at 100 on all four buckets to test them, while shipped plugin scripts stay bash + jq + gh.
status: stable
created: 2026-09-01
owner: brianespinosa
related_issues: [175]
---

# Workflow scripts are files, and JavaScript gets a real toolchain

## Context

Issue #175 moved `resolve-alerts` phase 6 from a dispatch schedule the model kept in prose to a
Claude Code Workflow script. That was the right move — the harness bounds concurrency
deterministically and the model does not — but the script was written **inside a fenced
` ```javascript ` block in `skills/resolve-alerts/SKILL.md`**.

Code in a markdown fence is not code as far as any tool is concerned. It cannot be parsed,
linted, imported, or executed. Nothing checks that it is syntactically valid JavaScript. The only
verification available is grepping the document for substrings, and that is exactly what the
layer shipped: **93 textual assertions in `spec/resolve_alerts_dispatch_spec.sh` and zero
behavioral tests.**

Those pins did real work — several caught real regressions — but they cannot see semantics, and a
three-way review proved it with a defect they all passed:

- The result schema's `allOf` required `action === "bare-override"` whenever `bare_override` was
  `"added"` or `"tightened"`.
- Its `oneOf` failure branch required `action` to be `null`.
- `apply_constraint` writes the override **before** `install`, so a `validate`, `install`, `push`
  or `pr` failure truthfully reports `bare_override: "added"` with `action: null`.

**No value of `action` satisfied both rules.** The schema was well-formed, so every pin asserting
that a rule was *present* stayed green, while the schema was unsatisfiable for a documented and
reachable failure path — the agent would be retried into a `null` result, losing the phase and
detail, or would discover that reporting `bare_override: "none"` validates and silently hide a
global pin on exactly the escalation a reviewer needs it on. A single executed assertion against
a real validator would have caught it on the first run. Textual pins could not, and no amount of
adding more of them would change that.

The same fence blocked more ordinary things: a typo in the script reaches the field run, the
markdown-embedded copy is the only copy so there is nothing to unit-test, and reviewers reading a
diff of prose cannot tell a behavior change from a rewording.

A second constraint bounds the answer. `plugins/gh-security/scripts/CLAUDE.md` has always stated
that plugin dependencies are `bash`, `jq` and `gh`, and nothing else — no `node`, no `npx`. That
rule exists because those scripts run **on the user's machine**, in the middle of a security fix,
where a missing runtime or a cold-cache `npx` fetch is a failure the user did not sign up for.
Any answer here has to leave that rule intact.

## Decision

**Workflow scripts ship as real files under `plugins/<plugin>/workflows/`, and this repository
gains a JavaScript toolchain for development and CI only.**

- `plugins/gh-security/workflows/fix-groups.mjs` is the dispatch workflow.
  `skills/resolve-alerts/SKILL.md` phase 6 references it by path
  (`${CLAUDE_PLUGIN_ROOT}/workflows/fix-groups.mjs`) and launches it with
  `Workflow({scriptPath, args})`. The fence is gone; what remains in the skill is the args
  contract and the rules that are genuinely the model's to keep.
- `package.json` at the repository root is `private: true` and carries **`vitest` and `ajv` at
  exact versions**, matching how every other tool in this repo is pinned and version-asserted
  after install.
- `spec/js/` holds the suite. `scripts/check.sh js` is the gate, with target discovery from
  `git ls-files` and an empty-discovery hard failure, like every other gate. It is wired into
  `all`, into the pre-push hook, and into `.github/workflows/gates.yml` as a `js` job that is
  added to the aggregate `gates` job's `needs:` list, whose arity floor moves from 4 to 5.
- The schema is tested by executing it with **ajv**, not by reading it. The unsatisfiable-`allOf`
  bug above is a test case.
- **Coverage thresholds are 100 on all four buckets** — `lines`, `functions`, `branches`,
  `statements` — via `@vitest/coverage-v8`, pinned exactly like every other tool here. The gate
  runs coverage; it is not a local convenience.

**The subject of that threshold is a projection, because the shipped file cannot be instrumented.**
The same property that stops vitest importing the workflow stops any provider measuring it: an
evaluated string belongs to no module graph, so the first coverage run named only the test harness
and not one line of the script. A `//# sourceURL=` pointing at the real path was tried and changed
nothing. So `spec/js/generate.mjs` projects the shipped file into an importable module before the
suite is collected: both regions are copied **verbatim**, and the only additions are an export list
and an `async function main(agent, parallel, phase, log, args)` wrapper around the wiring region —
which is precisely the shape the harness gives it, injected globals as parameters and the
top-level `return` as the function's. The tests import that, so every line they execute is a line
of the shipped file. Three assertions keep it honest: both regions must appear byte-for-byte in
the projection, the only non-comment additions must be exactly the export list and the wrapper,
and a missing or empty region is a hard error rather than an empty projection.

**A 100% threshold over an empty file set passes, so the threshold is not the gate.** This was
reproduced, not assumed: point `coverage.include` at a path matching nothing and vitest reports
`Unknown%` over 0/0 files, satisfies its own 100% thresholds, and exits 0 — this repository's
signature found-nothing-is-a-pass bug, arriving inside the coverage gate itself. `scripts/check.sh
js` therefore reads `coverage/coverage-summary.json` and refuses three things a threshold cannot
see: a report naming no files, a report not naming the projection, and any bucket of the
projection below 100. It deletes a stale summary before the run so a previous report cannot
satisfy them. `spec/check_sh_spec.sh` covers all three, plus a non-numeric percentage.

**The harness and the test file are outside the coverage set**, by `include` naming the projection
alone. They are test infrastructure; measuring them would let an unused helper move the number
while no shipped code changed.

**The boundary that keeps this consistent with the bash-only rule: a Workflow script never runs on
the user's machine the way a plugin script does.** It is loaded and evaluated *by the Claude Code
harness*, which is a node process already running on that machine whatever this repository
decides. Shipping a `.mjs` file for it adds no runtime the user did not already have, and adds no
dependency to any script under `plugins/gh-security/scripts/`, which remain `bash` + `jq` + `gh`
and are forbidden from calling into this file. What vitest and ajv are is a **dev and CI**
dependency: they run on a contributor's machine and on a GitHub runner, never on a user's.

That distinction is the whole argument. If it ever stops being true — if a plugin script needs
node, or a workflow file needs to run outside the harness — this ADR is the thing to revisit,
not the bash-only rule.

**The workflow file imports nothing, and its pure logic is fenced off by markers in-file.** This
follows from what the Workflow contract actually requires and what it declines to say. A script
must begin with `export const meta = {...}` *and* `return` a value at top level, and its
collaborators (`agent`, `parallel`, `phase`, `log`, `args`) arrive as injected globals rather than
imports. No ES module can have that shape, so the harness necessarily extracts `meta` and
evaluates the remainder as a function body — under which a top-level `import` would not even
parse. The reference does not state whether a `scriptPath` workflow may import a sibling module,
so the design assumes it may not. Testability is preserved instead by keeping everything above the
`// >>> wiring: begin` marker free of harness globals; `spec/js/harness.mjs` slices that region out
of the shipped file and evaluates it, and evaluates the whole file with stubbed collaborators for
the wiring. **The tests run the shipped bytes, never a copy.**

**Textual pins survive only where prose IS the implementation.**
`spec/resolve_alerts_dispatch_spec.sh` keeps the pins on model-executed behavior — the
interruption contract, the reap cadence, the approval boundary, the payload the model builds.
Every pin that was standing in for behavioral coverage of the script is deleted, because two
sources of truth for one behavior is worse than either alone.

## Consequences

- **A second toolchain in CI.** The gates workflow gains a `js` job and a node setup step, and the
  aggregate check now waits on five jobs instead of four. Contributors need `npm ci` before the
  `js` gate runs locally; it stands down with a warning in the pre-push hook when `node_modules`
  is absent, the same graceful degradation a missing `shellspec` already gets, because a hook that
  hard-fails a fresh clone trains people to `--no-verify` (ADR 005).
- **Another pinned version set to maintain.** `NODE_VERSION` in the workflow and the exact
  `vitest`/`@vitest/coverage-v8`/`ajv` versions in `package.json`, plus a committed lockfile, join
  ShellCheck, shellspec and the Claude CLI as things that must be bumped deliberately rather than
  drifting. The two vitest packages must move together.
- **A generated file in the test tree.** `spec/js/generated/` is written on every run and
  gitignored. It is a build artifact: editing it is meaningless, and the byte-identity assertions
  are what stop it drifting from its source. If the Workflow contract is ever confirmed to permit
  a `scriptPath` script to `import` a sibling module, the projection can be deleted and the pure
  region moved into a module both the workflow and the tests import directly.
- **100% coverage is a floor, not a proof.** Two of the `pairEntry` identity examples can be
  deleted without moving the number, because other examples already execute those branches — yet
  removing the `repo` comparison from the shipped code fails the suite on assertions. Coverage
  gates that code was *run*; the examples are what gate that it was *right*. Neither replaces the
  other, and a future contributor should not delete an assertion because the percentage survives
  it.
- **`plugins/gh-security/scripts/CLAUDE.md`'s dependency sentence needed a scope qualifier** and
  has one: the rule now says explicitly that it governs what runs on a user's machine, that it is
  not a repository-wide ban on node, and that no script there may call into the workflow file.
- **The js gate is not in `fast` and not in the pre-commit hook.** The pre-commit budget is ~2s
  and its purpose is to be cheap enough never to be skipped; vitest's startup plus a hard
  dependency on an installed `node_modules` fits neither. It runs pre-push beside the shellspec
  suite, and in CI unconditionally.
- **The workflow file is not covered by ShellCheck**, and this repo has no JavaScript linter. The
  vitest suite plus `claude plugin validate --strict` are the coverage; a linter is a later
  decision, not one this ADR makes by omission.
- **One thing stays unverified**: whether a `scriptPath` workflow may `import` a sibling module.
  The design does not depend on the answer — the file imports nothing — but if the permissive
  reading turns out to hold, splitting the pure region into its own module becomes available and
  the marker convention could retire.
