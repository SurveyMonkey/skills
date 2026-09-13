---
type: RFC
description: Moves the gh-security plugin's deterministic layer off bash 3.2 and jq onto TypeScript executed directly by Node 22.18 or newer, keeping the domain rules and the fixture corpus as the requirements and running both implementations against them until each bash script is retired.
status: stable
created: 2026-09-12
owner: brianespinosa
related_milestones: [5, 6]
related_adrs: [12]
---

# RFC 002: The gh-security deterministic layer moves to TypeScript

## Summary

The deterministic layer of `gh-security` is 13,690 lines of bash 3.2 and jq across eighteen
shipped scripts, one of which, `ecosystems/node.sh`, is 4,273 lines on its own. Two costs of that
implementation are now measured rather than anticipated. The first is wall clock: the test suite
is process-bound rather than compute-bound, which [ADR 005](../adr/005-quality-gate-venues.md)
established from a CI run where the macOS spec leg burned 204.5s of CPU against 220.97s of wall
clock on one core with `sys` at 45% of it, the fork/exec signature; every adapter verb re-parses
the 4,273-line adapter and re-forks the thirteen top-level heredoc library loads scattered through
it before it does any work, and [#212](https://github.com/SurveyMonkey/skills/issues/212) records
the slowest single spec file at 598s serial. The second cost is a defect class. The scripts' data
layer is jq strings passed through shell word splitting, and the failures it produces are
silent-success failures: `jq -r` on a missing key yields the string `null`, whose numeric test
fails on stderr inside an `if` that `set -e` never sees; a `die` inside `$( )` ends only the
subshell; a jq that errors feeds a heredoc-driven loop nothing, so the loop body never runs and
`all` over the resulting empty array is `true`. Each of those shapes has shipped a wrong answer as
a confident one, and `plugins/gh-security/docs/GUIDE.md` is now largely a list of them with
the discipline each one forced. A third cost is paid by everyone working in the tree and is harder
to put a number on: there is no language server for bash, so no rename, no go-to-definition, and
no type across the JSON contracts that every script both promises and consumes.

## Motivation

This is not a design from scratch, and treating it as one would be the failure mode. The domain
rules in `plugins/gh-security/docs/GUIDE.md` and the 90 fixture directories under
`spec/fixtures/` are the requirements; every one of them was written to a defect found in the
field or in review. What this RFC proposes is a change of substrate under those requirements, not
a change to them.

**The cost is concentrated where the work is growing.** Milestone 7 adds a Python adapter behind
the same contract, and [#193](https://github.com/SurveyMonkey/skills/issues/193) moves roughly 700
lines of mechanical prose out of `plugins/gh-security/skills/resolve-alerts/SKILL.md` and into
commands. Both land as new deterministic surface. Adding either to the current substrate means
another lockfile parser written as line-oriented `awk` and jq, and another set of the guards above
written by hand, each one a rule a reviewer has to remember rather than a thing a compiler checks.

**The process cost is structural, not incidental.** A verb like `classify-lines` runs one adapter
process per resolved copy, and `score-merge-risk.sh` runs one `range_facts` process per declared
range. Each of those processes pays the full 4,273-line parse and the thirteen heredoc loads to
answer one semver question. In-process, the same question is a function call. The suite feels this
most because it makes the most calls, but a field run pays it too, inside the ten-minute ceiling
the Bash tool imposes on every call, which is already why `fix-group.sh` is stepped rather than
one run.

**The defect classes are substrate-specific.** Every rule quoted in the Summary exists because
bash and jq make the wrong thing the quiet thing. `plugins/gh-security/docs/GUIDE.md` records
the rules that answer them: a field the contract promises is present and typed or it is a hard
error, never a default; there is no unchecked state reader to reach for; a reply is asserted to be
a JSON object before any field of it is read. A typed boundary answers the same class by
construction, and the parts that remain genuinely runtime (a lockfile is still untrusted input)
are then checked in one place rather than at every call site.

**Why now.** The bash implementation is at its high-water mark and about to grow twice. Porting
before the Python adapter means one adapter to port rather than two, and porting before #193's
commands means they are written once, in the target substrate, rather than written in bash and
ported immediately after.

## Goals / Non-Goals

**Goals**

- Every deterministic script that runs as part of a fix or audit run is TypeScript, executed
  directly by Node, behind one CLI entry point at `plugins/gh-security/bin/gh-security.ts`.
- The runtime floor is Node 22.18, the first release whose type stripping runs without a flag and
  without a warning on stderr (spike table and reasoning in
  [ADR 012](../adr/012-typescript-on-node-22-18.md), landed in Phase 0 by
  [#213](https://github.com/SurveyMonkey/skills/issues/213)).
- The adapter contract ([ADR 001](../adr/001-ecosystem-adapter-contract.md)) survives as a
  contract, but as an in-process interface rather than a process boundary.
- The fixture corpus is carried over unchanged, and bash and TypeScript answer the same fixtures
  side by side until each bash script is retired.
- The behavior a user sees does not change, other than the runtime floor and the launch-time error
  below it.
- Coverage of the TypeScript source is 95 to 100 on all four buckets, preferably 100, with
  exclusion by name and a stated reason as the only relief.

**Non-Goals**

- **`workflows/fix-groups.mjs` is not touched.** ADR 010's boundary (a Workflow script is loaded
  and evaluated by the harness, never run in the user's shell) is unaffected by this RFC, the file
  already has a JavaScript toolchain and a 100 coverage floor, and rewriting it would put a
  migration in the one place that is already tested the way this RFC wants everything tested.
- **`notice-scan.sh` and `detect-capacity.sh` stay bash.** The notice hook runs as a PostToolUse
  hook on every Bash call, where a node process start is a standing cost paid per tool call for a
  grep; capacity detection is three `sysctl` and `/proc` reads and is called once per dispatch.
  Neither is in the fix path, and neither carries the data layer this port exists to replace.
- **The #193 commands are not ported.** They do not exist yet. They are built in TypeScript inside
  Phase 3, against the contracts agreed in their own issues.
- **No change to the domain rules.** Where the port disagrees with
  `plugins/gh-security/docs/GUIDE.md`, the document wins and the port is wrong, except for the
  bash-and-jq mechanism sections, which #216 rewrites because they describe a substrate that is
  going away.
- **No published npm package, no build step, and no bundler.** The plugin ships `.ts` files that
  Node executes.
- **Not a rewrite of the agent prompts or the skill.** #237 changes the calls they make; it does
  not re-derive what they say.

## Proposed Approach

### Runtime

Node 22.18 or newer, executing `.ts` files directly by type stripping. Erasable syntax only,
enforced at build-free lint time by `tsc --erasableSyntaxOnly`, so nothing in the tree depends on
a transform: no `enum`, no parameter properties, no namespaces. Imports name the `.ts` extension
explicitly. ADR 012 records the runtime decision, the spike table behind the 22.18 floor, and the
coverage policy.

The floor is a breaking change for anyone below it, so it ships with the 1.0.0 version bump
(#238), and the CLI entry carries a preamble that exits with a named error rather than a stack
trace when the running Node is older (#214, #224).

### Shape

```
plugins/gh-security/
  bin/gh-security.ts        # one entry point; subcommand registry; JSON on stdout
  src/
    lib/                    # envelopes, process runner, git helpers, gh client, state file
    semver/                 # comparison and range facts
    lockfiles/              # npm, pnpm, Yarn Berry parsers
    adapters/               # the ADR 001 verbs as an in-process interface
    commands/               # discovery, preflight, scoring, rendering, drivers
  scripts/
    common/detect-capacity.sh
    common/notice-scan.sh
  workflows/fix-groups.mjs
```

One entry point rather than eighteen executables is also what closes
[#16](https://github.com/SurveyMonkey/skills/issues/16): the PreToolUse allow rule for the
plugin's own scripts becomes one pattern for one path instead of a list that grows with the script
count.

The adapter stays a contract and stops being a process. Every obligation ADR 001 states (four exit
codes, empty results are never implicitly successful, a promised field is present and typed or it
is a hard error, version and range semantics stay inside the adapter) is carried onto an interface,
where the type system enforces the parts of it that are shape and the tests enforce the parts that
are behavior. A process seam survives exactly where there is an ecosystem boundary that is not
ours to cross: invoking the package manager, invoking `git` and `gh`, and calling
`detect-capacity.sh`.

### Parity is the migration strategy

Nothing is ported on a reading of the bash. For each port issue, the bash script and its
TypeScript replacement are run against the same fixture and their JSON is diffed, by a parity
runner that lands with the test harness in #219 and is deleted in #241 when there is nothing left
to compare against. The rule the phases are ordered by: **a bash script is deleted only after its
replacement is parity-green on every fixture that covered it**, and its spec file goes in the same
commit, because two implementations of one behavior outlive their usefulness the moment one of
them is authoritative.

The same rule governs the prose pins. `spec/PINS.md` already marks which pins are mechanical
([#197](https://github.com/SurveyMonkey/skills/issues/197)); each mechanical pin is retired as its
successor command lands (#231), never kept beside it. Judgment pins, where prose genuinely is the
implementation, stay.

### Testing

vitest becomes the primary venue and shellspec covers the bash that remains: `notice_scan`,
`detect_capacity`, `githooks`, `check_sh`, `reference_scrub` and `bash32_parse` (#240). The
`testing` skill stays the policy the port follows; #216 replaces only its bash-specific mechanisms
(the `common_jq` and `adapter_jq` seams, the command-based `gh` mock, the worked example), and
leaves the language-neutral rules (assert the verdict not the parse, independent expected values,
red first, only the system boundary is mocked) as they are.

The harness in #219 is what makes the in-process tests cheap: a loader over the existing fixture
directories, an in-process `gh` mock carrying the semantics of the shared helper from
[#196](https://github.com/SurveyMonkey/skills/issues/196) (one reply per endpoint, a fail switch
per endpoint, unhandled endpoints fail loudly), and a temp git repo builder for the few tests that
genuinely need one.

## Alternatives Considered

- **Keep bash and optimize it.** Split `node.sh` into sourced files, or lazy-load the heredoc
  libraries per verb. This addresses the wall clock, partially: the parse cost drops but the
  process-per-call structure remains, and it is the structure that makes `classify-lines` fork per
  resolved copy. It addresses neither defect class nor the absent language server, and it adds a
  sourcing layer to the file that is already hardest to review. Rejected as paying a real cost for
  the smallest of the three problems.
- **Rewrite in Python.** Comparable ergonomics, a real type checker, and the milestone 7 adapter
  is a Python *ecosystem* adapter, which invites the confusion that it should therefore be written
  in Python. Rejected on the runtime argument that decides this whole question: Claude Code is
  node, and every package manager in the fix path needs node, so node is present wherever this
  plugin can do its job. Python is not, and a `python3` on macOS is not a `python3` anyone should
  rely on. An ecosystem adapter is about the ecosystem's semantics, not its language.
- **TypeScript compiled to JavaScript, shipping the JavaScript.** The conventional answer, and it
  removes the runtime floor argument entirely because the shipped artifact is plain `.js`.
  Rejected because it puts a build step and a generated tree between the source and the thing that
  runs, in a repository installed directly from its default branch: the artifact users get would
  be one nobody reviewed, and ADR 010's projection machinery is the local evidence for how much
  apparatus it takes to keep a generated file honest. Direct execution keeps the reviewed file and
  the executed file the same bytes.
- **Ship plain JavaScript with JSDoc types.** No floor, no stripping, `tsc` still checks it.
  Rejected as the worst of both: the annotation burden of types with a syntax that fights them,
  and every contributor writing `@param {import('./x.ts').Y}` instead of an import.
- **Deno or Bun.** Both run TypeScript directly and both are better at it than Node is. Both are a
  runtime the user does not have, which is exactly the objection ADR 010 raised and this RFC
  answers by pointing at node already being present. Rejected on that asymmetry alone.
- **Do nothing, and pay the costs.** The honest baseline. Rejected on the "why now" argument: the
  deterministic surface grows twice more (milestone 7's adapter, #193's commands), so doing
  nothing is not holding the cost steady, it is choosing to pay it on a larger surface later.

## Trade-offs & Risks

- **A runtime floor is a breaking change**, and it is the reason the plugin goes to 1.0.0. A user
  on an older Node gets a named error at launch instead of a working tool. Mitigation: the floor
  is stated in the install docs, the error names the required version, and the only supported LTS
  lines clear it.
- **The port is the largest change this plugin has taken, and it changes everything at once.**
  Mitigation is the parity gate and the phase ordering: no bash script is deleted while its
  replacement is unproven, so every phase boundary is a working plugin, and the last phase before
  release is real runs against the field-test repositories (#239).
- **Parity is only as good as the fixtures.** A behavior no fixture covers can be ported wrong and
  go green. This is the known limit of the strategy, and it is why #239 exists and why every
  defect found in it lands with a fixture in the same PR as its fix. Field runs have found what
  fixtures missed on every phase of RFC 001, and there is no reason to expect otherwise here.
- **Two toolchains during the port.** Contributors need node and a `node_modules` for the whole
  middle of this milestone, on top of shellspec and ShellCheck, and CI runs both suites. This is
  bounded: #240 narrows the shellspec job and #241 deletes the parity runner.
- **A type system is not a domain check.** Nothing about TypeScript catches an adapter that reads
  a Yarn `resolution:` entry's `dependencies` block and forgets its peers. The domain rules in
  `plugins/gh-security/docs/GUIDE.md` remain the requirements document, and the fixture that
  covers each one remains the enforcement.
- **The in-process adapter loses one property the process boundary gave for free**: an adapter
  crash used to be an exit code the caller handled, and in process it is an exception that can
  unwind through a caller that did not expect it. The envelope and error types in #217 are where
  that is answered, and they are the first thing built for exactly that reason.
- **Node's type stripping is younger than the code it will run.** The floor exists to put the
  plugin on releases where it is on by default and silent, and `--erasableSyntaxOnly` is what
  keeps the source inside the subset that survives stripping, but this is a newer part of the
  runtime than `bash` is.

## Rollout / Migration Plan

Phases are tracked in [milestone 6](https://github.com/SurveyMonkey/skills/milestone/6), with
blockers recorded as issue dependencies; the plan keys below (P0-1 and so on) are the ones the
issues carry. Each phase leaves the plugin working.

**Phase 0: records and toolchain.**

| Key | Issue | Scope |
|---|---|---|
| P0-1 | [#212](https://github.com/SurveyMonkey/skills/issues/212) | This RFC |
| P0-2 | [#213](https://github.com/SurveyMonkey/skills/issues/213) | ADR 012, superseding ADR 010; amendments to ADR 001 and ADR 005 |
| P0-3 | [#214](https://github.com/SurveyMonkey/skills/issues/214) | `tsconfig.json`, pinned `typescript` and `@types/node`, the `types` gate, the Node floor preamble |
| P0-4 | [#216](https://github.com/SurveyMonkey/skills/issues/216) | The plugin guide moved to `plugins/gh-security/docs/GUIDE.md` and rewritten; the `testing` skill's bash-specific parts amended |
| P0-5 | [#215](https://github.com/SurveyMonkey/skills/issues/215) | TypeScript language server on for every session on this checkout |

**Phase 1: foundations.**

| Key | Issue | Scope |
|---|---|---|
| P1-1 | [#217](https://github.com/SurveyMonkey/skills/issues/217) | The shared library: envelopes, process runner, git helpers, typed `gh` client, typed state file, one env-prefix seam |
| P1-2 | [#218](https://github.com/SurveyMonkey/skills/issues/218) | The semver module, ported from `SEMVER_JQ` and `range_facts` |
| P1-3 | [#219](https://github.com/SurveyMonkey/skills/issues/219) | Test harness: fixture loader, in-process `gh` mock, git repo builder, parity runner |

**Phase 2: the adapter.**

| Key | Issue | Scope |
|---|---|---|
| P2-1 | [#220](https://github.com/SurveyMonkey/skills/issues/220) | Lockfile parsers as modules (npm, pnpm, Yarn Berry) |
| P2-2 | [#221](https://github.com/SurveyMonkey/skills/issues/221) | The adapter read verbs behind one interface |
| P2-3 | [#222](https://github.com/SurveyMonkey/skills/issues/222) | `apply_constraint` and `validate` |
| P2-4 | [#223](https://github.com/SurveyMonkey/skills/issues/223) | Retire `node.sh`, `select-adapter.sh` and their specs |

**Phase 3: the commands**, including the #193 contracts, which are built here rather than
ported. P3-4 is the retirement issue and runs last, which is why its row sits at the bottom.

| Key | Issue | Scope |
|---|---|---|
| P3-1 | [#224](https://github.com/SurveyMonkey/skills/issues/224) | The CLI entry point and subcommand registry |
| P3-2 | [#225](https://github.com/SurveyMonkey/skills/issues/225) | The discovery commands, folding in [#54](https://github.com/SurveyMonkey/skills/issues/54) (alert JSON on stdin, so grouping re-runs without re-fetching) and [#167](https://github.com/SurveyMonkey/skills/issues/167) (`default_branch` resolved from GitHub rather than a stale `origin/HEAD`) |
| P3-3 | [#226](https://github.com/SurveyMonkey/skills/issues/226) | `pr-status`, `ensure-worktree-exclude`, `require-linked-worktree` |
| P3-5 | [#227](https://github.com/SurveyMonkey/skills/issues/227) | `prepare-checkout` and `merge-envelopes` |
| P3-6 | [#228](https://github.com/SurveyMonkey/skills/issues/228) | `preflight-repo` and `build-dispatches` |
| P3-7 | [#229](https://github.com/SurveyMonkey/skills/issues/229) | `reap-batch` and `summarize-run` |
| P3-8 | [#230](https://github.com/SurveyMonkey/skills/issues/230) | The `pr-status` renderer per repo, closing #193 |
| P3-4 | [#231](https://github.com/SurveyMonkey/skills/issues/231) | Retire the ported common scripts, their specs, and the mechanical pins |

**Phase 4: the drivers.**

| Key | Issue | Scope |
|---|---|---|
| P4-1 | [#232](https://github.com/SurveyMonkey/skills/issues/232) | The fix-group driver over a typed state file |
| P4-2 | [#233](https://github.com/SurveyMonkey/skills/issues/233) | Merge-risk scoring and PR rendering |
| P4-3 | [#234](https://github.com/SurveyMonkey/skills/issues/234) | One reap module, replacing three implementations |
| P4-4 | [#235](https://github.com/SurveyMonkey/skills/issues/235) | The audit-pins driver on the shared library |
| P4-5 | [#236](https://github.com/SurveyMonkey/skills/issues/236) | Retire the bash drivers and their specs |

**Phase 5: prompts and release.**

| Key | Issue | Scope |
|---|---|---|
| P5-1 | [#237](https://github.com/SurveyMonkey/skills/issues/237) | `SKILL.md`, the agents and the commands invoke the CLI |
| P5-2 | [#238](https://github.com/SurveyMonkey/skills/issues/238) | Plugin 1.0.0; README, ARCHITECTURE, diagrams, manifest validation |
| P5-3 | [#239](https://github.com/SurveyMonkey/skills/issues/239) | Field test on the field-test repositories before release |

**Phase 6: narrow the gates and clean up.**

| Key | Issue | Scope |
|---|---|---|
| P6-1 | [#240](https://github.com/SurveyMonkey/skills/issues/240) | Shellspec reduced to the bash gates; vitest primary |
| P6-2 | [#241](https://github.com/SurveyMonkey/skills/issues/241) | Delete the parity runner and the retired-script allowlist |

**The CI-cost track runs alongside**, in [milestone 5](https://github.com/SurveyMonkey/skills/milestone/5),
because its issues change the same workflow this port keeps adding jobs to:
[#208](https://github.com/SurveyMonkey/skills/issues/208) (C2, the macOS leg),
[#209](https://github.com/SurveyMonkey/skills/issues/209) (C3, cancelled runs),
[#210](https://github.com/SurveyMonkey/skills/issues/210) (C4, the ruleset export and the
gate-change checklist), [#211](https://github.com/SurveyMonkey/skills/issues/211) (C5, the coverage
gate for `src`), plus the dev-toolchain switches
[#249](https://github.com/SurveyMonkey/skills/issues/249) (lefthook),
[#250](https://github.com/SurveyMonkey/skills/issues/250) (Biome) and
[#251](https://github.com/SurveyMonkey/skills/issues/251) (pnpm). #249 reverses ADR 005's
rejection of lefthook and carries the amendment that records the reversal. ADR 005 refused it on
two grounds: that lefthook adds a dependency to a repo whose stated constraint is `bash`, `jq` and
`gh`, and that `core.hooksPath` does the job with none. This port answers the first, because a
deterministic layer in TypeScript needs node anyway; #249 answers the second on its own ground,
which is speed rather than dependencies, because the pre-push shellspec run is the slowest thing
in the local loop and hooks become staged-only. The ones that add or drop a job move the aggregate
`gates` job's `needs:` list and its arity floor; none of them touches the repository ruleset,
which requires only the job id `gates`. C4's checklist is the record of that rule.

## Open Questions

- **Whether any `src` file legitimately cannot reach 100 coverage.** The policy (ADR 012) already
  answers what happens when one does: exclusion by name with a stated reason, never a lowered
  number, and never below the 95 floor. Which files, if any, is answered by the code as it lands.

## Decisions & Follow-ups

- **The runtime is node, and the argument is availability, not preference.** ADR 010 kept shipped
  scripts on bash because a plugin script must not need a runtime the user lacks. The fix flow
  cannot complete without npm, pnpm or yarn, every one of which needs node, and Claude Code is
  itself node. ADR 001's own `npx semver` objection was about a cold-cache registry fetch in the
  middle of a security fix, which is a different thing from requiring the runtime. ADR 010 names
  this as the case in which to revisit it.
- **The floor is 22.18 rather than "current LTS".** It is the first release where type stripping
  runs without a flag and writes nothing to stderr; the spike behind that is ADR 012's.
- **`notice-scan.sh` and `detect-capacity.sh` stay bash**, on the per-call cost of the first and
  the triviality of the second, not on any reservation about the port.
- **`workflows/fix-groups.mjs` is untouched**, and ADR 010's harness-versus-user-shell boundary
  survives this RFC intact even though ADR 012 supersedes the ADR that drew it: what is
  superseded is ADR 010's bash-only rule for shipped scripts, not the boundary.
- **Coverage is 95 to 100 on all four buckets, preferably 100** (#211, ADR 012), with exclusion by
  name and a reason as the only relief. The existing 100 floor on the workflow file does not move.
- **The mechanical prose pins retire with the scripts they pin** (#197, #231). A pin is never kept
  beside its successor: two sources of truth for one behavior is worse than either alone, which is
  the rule ADR 010 already applied to the dispatch script's textual pins.
- **The `testing` skill stays the policy**, amended rather than replaced (#216).
- **The TypeScript tests live in `spec/ts/`**, beside `spec/js/` and `spec/fixtures/`, with the
  existing `path-spec` rule applying to them unchanged. Settled in #216's decision comment rather
  than in #214, which this constrains: #214's vitest include globs follow from it.

To be spawned as this RFC executes:

- ~~ADR: the runtime decision, the erasable-syntax constraint and the coverage policy
  ([#213](https://github.com/SurveyMonkey/skills/issues/213)), which also amends ADR 001's process
  boundary and ADR 005's venue split.~~ **Landed in Phase 0 as
  [ADR 012](../adr/012-typescript-on-node-22-18.md)**, which supersedes ADR 010 on the bash-only
  rule for shipped scripts and carries the ADR 001 and ADR 005 amendments.

## Related

- [Milestone 6: TypeScript port, v1.0](https://github.com/SurveyMonkey/skills/milestone/6) and
  [milestone 5: CI cost](https://github.com/SurveyMonkey/skills/milestone/5)
- Requirements: `plugins/gh-security/docs/GUIDE.md`, `spec/fixtures/`, `spec/PINS.md`
- [RFC 001: Orchestrated multi-agent security alert resolution](001-alert-orchestration.md)
- [ADR 001: Ecosystem adapter contract](../adr/001-ecosystem-adapter-contract.md)
- [ADR 005: Quality gate venues and automation](../adr/005-quality-gate-venues.md)
- [ADR 010: Workflow scripts are files, and JavaScript gets a real toolchain](../adr/010-workflow-scripts-are-files-with-a-js-toolchain.md)
- [#193: move resolve-alerts' mechanical phases out of SKILL.md prose](https://github.com/SurveyMonkey/skills/issues/193)
- [Node.js: running TypeScript natively](https://nodejs.org/api/typescript.html)
