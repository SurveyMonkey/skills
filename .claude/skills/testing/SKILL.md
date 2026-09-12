---
name: testing
description: This repository's test strategy, covering seams, asserting the verdict rather than the parse, independent expected values, red-first, what may be mocked, when a prose pin is legitimate, and the review checklist. Use when writing or reviewing a shellspec or vitest example, when adding a script under plugins, and when fixing a defect found by running the code.
---

# Testing

This is the strategy the gates enforce. The gate commands themselves (`scripts/check.sh`,
shellspec, vitest, ShellCheck) and the rules about suppressing a linter finding live in the root
[CLAUDE.md](../../../CLAUDE.md); nothing here repeats them.

Structure adapted from the TDD skill at
<https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd>, with every example
rewritten in this repository's idiom: bash scripts with JSON contracts, shellspec, and a mocked
`gh`.

Paired worked examples from this suite: [tests.md](tests.md). Mocking: [mocking.md](mocking.md).

## Seams

**For a shell script, the CLI and the JSON it writes to stdout are the seam.** That pair is the
contract every consumer reads, so it is the only thing a spec may observe. Never reach inside: no
temp file, no intermediate variable, no sourcing a script to call one of its functions.

**For the one JavaScript file this repo ships, the seam is the module's exported surface**, because
the Workflow script has no CLI: `spec/js/` imports the functions under test from
`spec/js/generated/workflow.mjs`, the importable projection of the shipped file, and the byte
identity between projection and shipped file is itself asserted so that covering the one covers the
other (ADR 010). Importing a named export there is the seam, not a reach inside it; reaching past
the exports into module-private state still is.

- **Assert a `jq` projection through `common_jq` / `adapter_jq`** (`spec/spec_helper.sh`), not
  string matching against pretty-printed output. Both preserve the script's exit status, which
  matters because `validate` deliberately emits its report *and* fails. An example that cares
  about a specific non-zero exit uses `When run script` instead.
- **Project narrowly and compare exactly.** `'{ok, violations: [.violations[].version]}'` equal to
  one literal beats a pile of `should include` lines: the projection names what the example is
  about, and exact equality is what a stray extra key has to survive.
- **Rendered text is the same seam**, asserted byte-for-byte against a reviewed fixture
  (`spec/render_pr_spec.sh`), never by substring.
- **Prose is a seam only where prose is the implementation.** See "Prose pins" below.
- **Use `Parameters` for table-driven cases** (version ordering, ecosystem routing, band
  thresholds) rather than near-identical repeated examples. One row per case, and one row per
  spelling: a single alternated pattern hides which case died.

**Agree the seam before the code.** An issue or plan proposing a new script carries its usage line
and its JSON output shape, error cases included, before any code is written; that block is what the
specs then test at, and the reviewer of the plan is agreeing to the seam, not only to the idea
(issue #198).

## New script

**Contract first.** Agree the usage line and JSON output shape, error cases included, as "Seams"
above says, before any code is written. That block is the seam the specs test at, and the reviewer
of the plan is agreeing to the seam, not only to the idea.

**Red first.** The first spec example for a new script is committed failing against the missing
script (or, where a commit must be green, is the first thing written on the branch and shown
failing in the PR description), the same one slice at a time that "Red first" below asks for.

A worked example: the `discover-repos.sh` contract, distilled from issue #188's approved plan and
matching what shipped:

```
discover-repos.sh [<path>]
```

Exits 0 and emits `{target: <resolved path>, repos: []}` when there are no repositories. When the
input path is inside a git checkout, emits `{target: <resolved path>, repos: [<root path>]}` for
that one checkout. Otherwise, for each immediate non-dot subdirectory that is a checkout root
(symlink-resolved), its path is added to `repos`, sorted by that resolved path under a pinned
collation with duplicates collapsed (two links to one checkout are one entry). Every error, of
which the script's own header names several beyond the two most obvious (not a directory, an
unreadable directory), exits 1 with `{error: <reason>}` on stderr and nothing on stdout.

When committing the first spec example against this contract, it fails because the script does
not exist yet. The smallest script that passes it comes next. Then the next case: the directory
with multiple immediate checkouts, the symlink to a checkout's subdirectory that the guard must
suppress, then each error shape in turn. See the review checklist's mutant question below for how
to confirm each new example pulls its own weight.

**PR body.** A PR landing a new script states, in its description: "Contract agreed in <issue or
plan comment>; first failing example: <spec:line>." Naming both makes the agreement and the first
red example checkable from the PR alone.

## Assert the verdict, not the parse

A spec that stops at "the JSON parsed" passes while the hazard survives. Assert through the rule
that consumes the parse: `validate`'s `ok`, the `skipped` reason a group carries, the
`present: false` to `removable` path, the notice hook's rewritten text. The defects that reach
production here are all plausible-looking parses that become a wrong verdict downstream, so the
example has to fail for the reason the bug mattered.

Corollary for the `It` title: it must claim no more than the assertion checks. `runs
discover-repos.sh first` asserted existence, not order.

## Expected values come from an independent source

The expected value must be able to disagree with the code. It may be:

- a known-good literal written by hand from the behavior being specified;
- a published spec (the ordering chain in `spec/node_semver_spec.sh` is semver.org section 11);
- a specimen trimmed from a real run.

It must never be recomputed the way the code computes it.

**A shape found in the wild is the specimen.** It must never be hand-authored when a real sample
exists: invented pnpm and yarn audit fixtures encoded formats those tools never emit, which is
exactly why the suite could not see the bug. An alert pointing into `spec/fixtures/` is about a
specimen, so it is not the fixture that gets "fixed". **A parser gaining a format branch needs a
real specimen of that branch** (aliases, `patch:` locators, workspace and portal targets, binding
parameters, nesting), not a comment claiming the branch is excluded.

What a specimen is allowed to name is settled by the reference rule in the root CLAUDE.md, and
`spec/reference_scrub_spec.sh` gates it.

## Red first

**A fix without a fixture is not a fix.** Any defect found by running the code, against a real
repository, a crafted input, or a review reproduction, lands a fixture carrying that exact shape in
the same commit as the fix. This is the deliverable, not optional cleanup. Without it the suite
stays green while each round trades one defect for another: the notice hook's text-only match
missed `--json` output, its replacement regex could not match a brace in an advisory title, and
that replacement's fix for yarn `patch:` locators inverted `present` for npm alias keys. Every one
passed a full suite at the time.

**Prove the red.** Run the new example against the pre-fix code and see it fail before the fix
lands. An example that was never red is an example that has never been shown to be able to fail.

**One slice at a time for a new script.** The first example is written against the agreed contract
and fails because the script does not exist yet, then the smallest script that passes it, then the
next example. Not the whole spec followed by the whole script: bulk examples verify imagined
behavior and go insensitive to real changes.

## Mocking

Mock at the system boundary and nowhere else: `gh`, the machine probes, and the Workflow runtime.
Not a sibling script the caller resolves by path, not an adapter in its own specs, not git, not the
filesystem: real `git init` repositories, real files, real scratch directories. A collaborator the
script accepts as a path is substituted through that flag, which is its seam rather than a way
around it. Full rules and the shared `gh` helper: [mocking.md](mocking.md).

## Prose pins

A **prose pin** is an example that greps a SKILL.md, agent definition or command file for a phrase
(`phrase_in`, `count_in`, `rule_in`). It verifies wording rather than behavior, so it passes by
construction the moment the sentence exists and fails on a reword that changes nothing.

**Allowed only where prose genuinely is the implementation**: the approval boundary, the
interruption contract, consent gates, and `env_prefix`, which is read from session context no
script can see. There the sentence is the only artifact, and a pin is the only way to see it
regress.

**Never for a mechanical rule.** A rule that needs a grep count to stay alive wants to be a script
(issue #193). When it becomes one, the pin is deleted in the same change that lands the executable
example; it is never kept beside it as a second source of truth. The classification and retirement
of the existing pins is issue #197.

A pin that is allowed still has to work: patterns are dialect-safe (no `\|`, no `\s`; BSD grep
reads a BRE `\|` as a literal bar, so an alternated pattern is vacuously green on macOS), the
phrase is specific enough that the regression it guards could not keep it, and the `It` title
claims no more than the count proves.

## Good and bad tests

Paired examples from this suite, each with a file path: [tests.md](tests.md).

## Review checklist

For a spec under review, including by the `pr-test-analyzer` agent:

1. **Seam or internals?** CLI and stdout (or, in `spec/js/`, a named export), or a temp file,
   module-private state, a side channel.
2. **Literal or recomputed?** Could the expected value ever disagree with the code.
3. **Boundary or collaborator?** Only `gh`, the machine probes and the Workflow runtime are mocked;
   a collaborator behind a documented flag is substituted through it (see `mocking.md`).
4. **Verdict or parse?** Does the assertion run through the rule that consumes the output.
5. **Would the named mutant fail?** Name the defect the example exists for and check that it dies.
6. **Does the `It` title claim more than the assertion checks?**
7. **If it is a prose pin:** is prose the implementation here, or is a script owed.
