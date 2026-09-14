---
type: ADR
description: The gh-security deterministic layer runs on Node 22.18 or newer, executing erasable TypeScript directly with no build step and explicit .ts imports, with the adapter contract as an in-process interface and coverage of the TypeScript source held at 100 on all four buckets above a 95 floor.
status: stable
created: 2026-09-12
owner: brianespinosa
related_issues: [213, 211]
---

# ADR 012: TypeScript on Node 22.18, executed directly

Drives [RFC 002](../rfc/002-typescript-port.md). Lands in Phase 0
([#213](https://github.com/SurveyMonkey/skills/issues/213)). **Supersedes
[ADR 010](010-workflow-scripts-are-files-with-a-js-toolchain.md)** on the question of what a
shipped plugin script may be written in, and amends
[ADR 001](001-ecosystem-adapter-contract.md) and
[ADR 005](005-quality-gate-venues.md) where each states a consequence of the bash substrate.

## Context

Two documents in this repository say a shipped plugin script is `bash` plus `jq` plus `gh` and
nothing else. [ADR 001](001-ecosystem-adapter-contract.md) said it first, with a specific
argument: node has no built-in semver, so using it would mean `npx semver` and a cold-cache
network fetch in the middle of a security fix. [ADR 010](010-workflow-scripts-are-files-with-a-js-toolchain.md)
restated it as the boundary that let the repository take a JavaScript toolchain at all, and said
plainly where the line runs: a Workflow script is evaluated by the Claude Code harness, which is
already a node process, while a plugin script runs in the user's own shell, where a missing
runtime is a failure the user did not sign up for. ADR 010 then named its own escape hatch: if a
plugin script ever needs node, that ADR is the thing to revisit rather than the bash-only rule.

**The premise is checkable, and it does not hold.** The central act of a fix run is a dependency
install through pnpm, npm or Yarn Berry. Every one of those is a node program. A repository this
plugin can fix is by construction a repository whose package manager runs, and the plugin already
reports and stops where one does not. Claude Code, which is what invokes the plugin at all, is
itself a node process. There is no reachable state in which the fix flow can complete and node is
absent.

**And the `npx semver` objection was never about node.** It was about a registry fetch on a cold
cache at the worst possible moment. Shipping `.ts` files that the already-present node executes
fetches nothing: no install, no registry, no cache. The argument that retired bash comparison in
favor of jq does not reach the runtime.

What remains is a real question the escape hatch does not answer: TypeScript does not run by
itself. Either something compiles it, which puts a generated artifact between the reviewed source
and the executed code in a repository whose plugins are installed straight from the default branch,
or the runtime strips the types. Node does strip types, unflagged, from some release onward; which
release, and whether it does so silently, is a fact to measure rather than read off a changelog,
because a warning on stderr in the middle of a security fix is its own kind of failure. Type
stripping is also not the whole of TypeScript: syntax that has runtime meaning cannot be erased,
and the runtime has to be asked what it does with it.

## Decision

**The runtime floor is Node 22.18**, and the deterministic layer ships as `.ts` files that node
executes directly.

The floor comes from a spike, recorded here as it was run
([#213](https://github.com/SurveyMonkey/skills/issues/213)):

| Node | Result |
|---|---|
| 22.16 | Fails at launch, with a named error |
| 22.17 | Fails at launch, with a named error |
| 22.18.0 | Runs; **zero bytes on stderr** |
| 22.22.2 | Runs; **zero bytes on stderr** |
| 24.15.0 | Runs; **zero bytes on stderr** |
| 24.18.0 | Runs; **zero bytes on stderr** |

Zero bytes on stderr is the property being asserted, not merely a zero exit: a run that works
while printing an experimental-feature warning would put that warning into the middle of every
`gh-security` command's output, and into the stderr capture the scripts' own contracts read. 22.18
is the first release that clears both halves. The supported LTS lines all sit above it, so the
floor excludes no release anyone should be running, and CI already pins 24.18.0.

**Erasable syntax only, enforced by `tsc --erasableSyntaxOnly`.** The same spike confirmed what
the flag exists for: `enum` is rejected at runtime with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. The
compiler flag turns that class of failure, which otherwise lands at launch on a user's machine,
into a failure of the `types` gate on a pull request. It rules out `enum`, parameter properties
and namespaces, none of which the port needs.

**Direct execution, with explicit `.ts` extensions on imports.** No build step, no bundler, no
generated tree, no published package. The file a reviewer reads on the default branch is the file
that runs, byte for byte, which is the property ADR 010 spent its projection machinery to recover
for a file it could not execute directly. `tsconfig.json` is `noEmit` with
`module`/`moduleResolution` at `nodenext` and `allowImportingTsExtensions`
([#214](https://github.com/SurveyMonkey/skills/issues/214)).

**The floor is enforced where it is crossed, not documented and hoped for.** The CLI entry carries
a preamble that exits with a named error naming the required version when the running node is
older, and `scripts/check.sh` asserts the same floor, the way it already asserts every pinned tool
version after install. The floor is a breaking runtime requirement, which is why the plugin goes
to 1.0.0 with it (#238).

**Coverage of the TypeScript source is 100 on all four buckets** (lines, branches, functions,
statements), **with 95 as the floor the gate never goes below**, and **exclusion by name with a
stated reason as the only relief**
([#211](https://github.com/SurveyMonkey/skills/issues/211)). A file that genuinely cannot reach
100, a process boundary or a platform branch, is named in the exclusion list with a comment saying
why; the number is never lowered to accommodate it, because a lowered threshold hides every other
file's regression behind the one file that earned the exception. The existing 100 floor on
`workflows/fix-groups.mjs` does not move, and neither does the rule ADR 010 established alongside
it: a threshold satisfied by an empty file set is this repository's signature bug, so
`check.sh js` keeps reading the coverage summary and refusing a report that names no files.

**What this does not change.** ADR 010's boundary between a Workflow script and a plugin script is
not repealed, it is made irrelevant to the question it was drawn for: `workflows/fix-groups.mjs`
stays exactly as it is, evaluated by the harness, and nothing in the port imports it or is imported
by it. `notice-scan.sh` and `detect-capacity.sh` stay bash (RFC 002, Non-Goals). The domain rules
in `plugins/gh-security/docs/GUIDE.md` remain the requirements document; only its bash-and-jq
mechanism sections are rewritten ([#216](https://github.com/SurveyMonkey/skills/issues/216)).

## Consequences

- **A runtime floor is a user-visible breaking change.** Anyone below 22.18 gets a named error at
  launch instead of a working plugin. That is the cost of the decision, paid deliberately and
  announced with 1.0.0; the alternative, a silent failure deep inside a fix run, is worse.
- **The repository now depends on a young runtime feature.** Type stripping is newer than any
  other part of this toolchain. `--erasableSyntaxOnly` is the containment: it keeps the source
  inside the subset the feature is specified to handle, so the risk is a runtime regression rather
  than a source-level surprise.
- **`npx semver` stays refused, for its original reason.** Nothing in the port fetches from a
  registry at run time, and a dependency added to a *shipped* path would reintroduce exactly the
  cold-cache failure ADR 001 named. The TypeScript that ships imports nothing outside the plugin;
  vitest, ajv, `typescript` and `@types/node` remain dev and CI dependencies, which is the same
  split ADR 010 drew.
- **The exclusion list is the thing to watch.** A coverage policy whose relief valve is "name the
  file and say why" degrades exactly as fast as reviewers let entries accumulate. #211's acceptance
  criterion is that the list is empty or every entry carries a reason, and that is the standing
  review obligation.
- **Two ADRs are amended rather than rewritten**, below.

### ADR 001 amendment: the adapter contract is an interface, not a process

[ADR 001](001-ecosystem-adapter-contract.md) specifies invocation as
`<adapter> <verb> [args]` with JSON on stdout and four exit codes. Every obligation in it survives
this ADR: empty results are never implicitly successful, a promised field arrives present and of
the promised type or it is a hard error, version comparison and range semantics stay behind the
contract, and a package is keyed by what it resolves to in both `resolved_versions` and
`resolution_map`. What changes is only where the boundary sits.

**The contract becomes an in-process interface.** Verbs are functions behind one adapter
interface; the four exit codes become the same four outcomes carried in a typed result envelope,
and the stdout/stderr split survives only at the CLI entry point, where a command is invoked from
a prompt. **A process seam exists only at an ecosystem boundary**: invoking the package manager,
invoking `git` or `gh`, and calling `detect-capacity.sh`. A verb never spawns another verb, and no
call site pays a process to ask a semver question.

ADR 001's dependency paragraph ("Dependencies are `bash`, `jq`, and `gh`. No `node`, no `npx`.")
is superseded by this ADR for the reasons in Context above. Its `npx semver` half stands: nothing
shipped fetches from a registry at run time.

### ADR 005 amendment: vitest is the primary venue

[ADR 005](005-quality-gate-venues.md) splits the gates by cost and venue with shellspec as the
suite. **vitest becomes the primary suite venue, and shellspec covers the bash that remains**:
`notice_scan`, `detect_capacity`, `check_sh`, `reference_scrub` and `bash32_parse`
([#240](https://github.com/SurveyMonkey/skills/issues/240)). Everything ADR 005 decides about
venues is unchanged by that substitution: one entry point in `scripts/check.sh`, empty discovery
as a hard failure in every gate, CI as the enforcement boundary, and the executed-example floor,
which vitest needs for the same reason shellspec did.

The macOS leg keeps its reason for existing, narrowed: it is still the only runner whose
`/bin/bash` is 3.2, and after #240 that is all it runs.

**What this ADR does not do to ADR 005 is reverse its lefthook refusal.** That refusal rests on
two grounds: the dependency against the `bash`, `jq` and `gh` constraint, and `core.hooksPath`
doing the job with none. This ADR removes the first and is silent on the second, which stands on
its own; [#249](https://github.com/SurveyMonkey/skills/issues/249) answers it on the different
ground of hook speed and carries the amendment that records the reversal.
