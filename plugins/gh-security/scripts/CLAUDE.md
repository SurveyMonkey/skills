# gh-security scripts

Deterministic work lives here so agent prompts do not re-derive procedures each session.
**Agents decide, scripts do.** Anything with one correct procedure belongs in a script with a
JSON contract; interpreting failures and writing prose stays with the agent.

## Hard constraints

**Dependencies are `bash`, `jq`, and `gh`. Nothing else.** No `node`, no `npx`, no `yq`, no
`python`. Semver comparison is implemented in jq rather than shelling out to `npx semver`, which
would mean a cold-cache network fetch in the middle of a security fix.

**Target jq 1.7** (ubuntu-latest's, and CI's Linux leg). Development machines run 1.8 from
Homebrew, so anything the two versions read differently goes green locally and red only in CI.
**Parenthesize a `//` default before binding it**: `(A // B) as $x`, never `A // B as $x`. `as`
takes its whole right-hand side, so the unparenthesized form parses as `A // (B as $x | body)`
and short-circuits to `A` whenever `A` is present — 1.8 reads it as intended, 1.7 does not
([#82](https://github.com/SurveyMonkey/skills/pull/82)). `spec/jq_binding_spec.sh` gates the
shape on every platform.

**Target bash 3.2** (the macOS default). Not every engineer has Homebrew bash on PATH. That rules
out associative arrays, `mapfile`/`readarray`, `${var,,}`, and `**`. jq carries the data
structures instead.

**Use POSIX character classes in regexes**, `[[:space:]]` not `\s`. BSD grep on macOS does not
support `\s` in ERE. It works under ugrep, which some engineers alias to `grep`, so this fails
only on other people's machines.

## Layout

| Path | Scope |
|---|---|
| `common/` | Ecosystem-agnostic: scope detection, alert discovery, adapter routing, risk scoring, capacity detection, PR status, advisory lookup, worktree ignore setup, agent artifact reaping |
| `ecosystems/` | One adapter per GitHub advisory ecosystem. `node.sh` handles `npm` alerts |

## Adapter contract

See `docs/adr/001-ecosystem-adapter-contract.md`. Adapters are invoked as
`<adapter>.sh <verb> [args]`, emit JSON on stdout, human-readable detail on stderr, and exit
non-zero with `{"error": "..."}` on failure.

Everything ecosystem-specific stays behind the verbs, **including version comparison and range
semantics**. Phase 6's Python adapter implements PEP 440; node implements semver. Do not lift
`compare_versions` or `range_facts` into `common/`. `score-merge-risk.sh` is the pattern to copy:
it needs to know how far past `^9` a fix landed, and it asks the adapter rather than reaching for
a leading digit itself.

**A field the contract promises arrives present and of the promised type, or it is a hard error,
never a default.** `jq -r` on a missing key yields the string `null`, and `[ "null" -ge 2 ]` fails
only on stderr inside an `if`, which `set -e` never sees: an adapter missing `major_distance` made
the whole multi-major escalation vanish while the script still exited 0. Callers distinguish
absent from null explicitly (`has($k)`), because null is often a legitimate answer — a range with
no floor has no `majors_ahead` — and absence never is. The same rule is why `range_facts` always
emits every key. Two further routes reach the same silent zero and are checked the same way: a
present-but-untyped value (`"major_distance":"lots"` passes `has()` and then fails the integer test
on stderr only), and an adapter that exits 0 with **empty** stdout (jq on empty input emits
nothing, so every `has()` check downstream is skipped rather than failed). `score-merge-risk.sh`
asserts the reply is a JSON object before reading any field of it, and validates the numeric ones
against `^[0-9]+$`.

## The fix driver owns phases 1 to 5

`common/fix-group.sh` executes `agents/fix-dependency.md` phases 1 to 5 and Cleanup. **It is the
single home of that procedure**: a prose re-derivation of any of it in an agent definition is a
bug, not a fallback. Every branch it takes was an enumerated branch of that document first, each
one added to fix a field defect, and a fully enumerated decision tree is a script that has not
been written yet ([#171](https://github.com/SurveyMonkey/skills/issues/171)).

**Stepped, with a state file at `$WORK/state.json`, not one run**, because the Bash tool's
10-minute ceiling cannot wrap a control install plus a fix install (field runs: ~4 minutes each,
up to ~17 minutes total) and the remediation ladder needs a seam where judgment can escape to the
agent. The subcommands, the exit-code contract and the option surface are stated once, in the
script's own header (`common/fix-group.sh:1-50`); restating them here is how the two drift.

What that header does not say, and what belongs here:

- **The state file is the only thing that survives between steps**, so anything a later step needs
  is written into it and never carried in the caller's transcript. Two things it holds are load-
  bearing rather than incidental: the **fix-install counter**, which is what makes
  `install_budget_exhausted` reachable at all (one `apply` spends at most three of the four, and
  the agent doc sanctions re-running `apply` — a process-local counter reset on that re-run and
  bounded nothing), and the **`install_signals[]` union**, which carries what an install printed
  past the point where its output is discarded.
- **Every read of that file distinguishes "value", "absent" and "unreadable", and there is
  deliberately no unchecked sibling to reach for.** A discarded jq status turned a truncated
  `state.json` into empty strings, which is how a `cleanup` came to report success having removed
  nothing — and how `git -C ""`, which silently operates on the *current* directory, became
  reachable with `worktree remove --force` behind it (#18's failure mode). Every reader reports
  and `state_ok` does the dying, in the caller's own shell, because every call site sits in `$( )`
  and an exit there ends only the subshell. An "every source is asserted" comment above a
  hand-maintained list is not the guarantee; a reader that cannot be called unchecked is.
- **`cleanup` holds its path to `reap-agent-artifacts.sh`'s containment discipline**, because the
  two run the same `rm -rf` on the same directory from opposite sides. Both sides resolved
  physically, no `..` segment, contained under `<repo_root>/.claude/worktrees/`, plus one
  condition available only here: `--work` must name the workspace `setup` recorded. The removal's
  status is then checked and reported as `work_dir: {path, action}` beside `errors[]` — reporting
  `worktree_removed: true` with no field naming `$WORK` is the failure this file records on the
  reap's side of the same operation. **A populated `errors[]` exits non-zero**, as it does there
  (`reap-agent-artifacts.sh`'s last line is `[ -z "$errors" ] || exit 1`): the fields without that
  line still let an orchestrator keying on `status` read a leaked worktree as a clean cleanup.
  **That exit 3 is a signal, not a verdict on the run**, and it is the one exit-3 the agent does
  not map straight onto a failure result: `cleanup` runs after the push and the PR, so the agent
  maps it by what shipped — a PR open means `status: "success"` with the report in the result's
  own `cleanup` field, and nothing shipped means a `failure` at `worktree` carrying the same
  report. Reporting the leak as a run failure while a PR is open costs more than it buys: the
  result schema forces `pr_url: null` there, hiding an open PR from phase 7 and suppressing the
  orchestrator's reap, which runs only on a verified-open PR and is the second line of defence
  against this exact leak. Note
  what the containment conditions do *not* prove — `state.work` and `repo_root` both come out of
  the file inside the directory being deleted, so they rule out an uncontained path, a `..` or
  symlink path, and a moved workspace, not a forged state file.
- **Judgment escapes at three points**, each fail-closed and none of them a retry:
  `install_failure`, `validate_failed_after_ladder` and `install_budget_exhausted`. The
  placed-shape reconcile-by-hand escalation is a *fourth thing the agent decides*, not a fourth
  wire shape: it is a `validate_failed_after_ladder` whose `written[]` is all nested rule paths.
  An `apply_constraint` refusal is not an escape either — it is a phase `apply` failure quoting
  the adapter verbatim.
- **The ladder's first step is npm-only, and says so rather than faking it.** It derives the
  parents to scope from `validate`'s `violations[].path`, and only npm's path is an install path
  naming an enclosing parent; pnpm reports `<name>@<version>` and Yarn Berry the resolution
  locator, both of which name the violating copy. So on those two managers step 1 cannot run, and
  the `parent_derivation` object in the result and in the escalation evidence records that
  instead of presenting an unexhausted step as exhausted.
- **The widest shape actually applied is read off `written[]`, never off `apply_constraint`'s
  `mode`.** `mode` describes the call's input — `direct` means zero parents were passed — while a
  transitive package with an empty eligible set takes that same branch and gets a **top-level bare
  override** written for it. Keyed off `mode`, that pin was reported as `direct-update`, scored F6
  as 0, and never reached the pin audit as an `unscoped_override_added` observation.

## The pin-audit driver owns phases 2, 4, 5 and 7

`common/audit-pins-driver.sh` executes `agents/audit-pins.md` phases 2, 4, 5 and, in `pr` mode,
phase 7. Same rule as the fix driver: **the audit procedure lives here and nowhere else**, and a
prose re-derivation of any of it in the agent definition is a bug. What stays with the agent is what
reads history or writes prose — phase 1's worktree and its two `pr`-mode guards, phase 3's
provenance, phase 6's report, and phase 8's merge risk and pull request.

Stepped, with a state file at `$WORK/state.json`, for `fix-group.sh`'s reasons and one of its own:
this flow runs **one install per pin**, so a repository with a dozen pins cannot fit inside the
Bash tool's 10-minute ceiling however the work is arranged. `test-pin` is therefore one pin per
call, and the state file is what makes the with-all-pins baseline outlive the call that took it.
The subcommands, the exit-code contract and the option surface are stated once, in the script's
own header; restating them here is how the two drift.

What that header does not say, and what belongs here:

- **The removal is an in-script `jq` edit, not an agent Edit call**, and it takes the whole
  override block when the entry was the last one in it. `pnpm-workspace.yaml` (issue #159) cannot
  be edited with `jq` at all and the adapter's own workspace writer deliberately refuses to delete
  a pre-existing entry, so the driver carries a line-level deleter over exactly the flat
  `key: value` block that writer round-trips, and refuses any line inside the block it cannot read
  as an entry. A wrong parse there writes a file pnpm reads on every install.
- **A pin is identified by its `path`, never by its key alone.** npm nests several entries under
  one key (`{"rimraf": {".": ..., "glob": ...}}`), so `--key` is refused when it names more than
  one pin rather than resolved by position.
- **`resolution_map` unavailable and `resolution_map` erroring take different routes**, and the
  agent definition reads as if they were one thing. Exit 2 is the contract's "not implemented"
  (ADR 001): there is no whole-tree view to be had, so the audit runs and every verdict says it
  covers the named package only. Any other non-zero exit is a parser refusing a lockfile it could
  not read, and that refusal is the answer — a diff against a map that was never built reports
  every package unchanged, which is "found nothing" meaning "all clear" once more.
- **`compose` is the one phase name this driver emits that the four-phase audit vocabulary does
  not**: it comes only from `together`, and the agent's result contract reserves it for exactly
  that step's two failures, an edit that did not land and an install that did not finish.
- **The platform-binary family sample tests a platform triple, not a shared prefix.** A prefix
  match alone groups `@babel/`, `@types/` and `eslint-`, and a two-member scope moving in lockstep
  is ordinary, so on the prefix test alone one member's `safe` verdict would stand for a package
  nothing judged. Every member's name past the shared prefix must end in an `<os>-<arch>` pair
  with only libc or ABI tokens after it. **And its "moved as one unit" condition is checked
  against the whole tree**: that cannot be read off the diff alone, so the driver counts the family
  in the union of both maps and refuses to sample when that count exceeds the number that moved.
- **A `resolved_versions` payload that found nothing is a hard error, not an empty list.**
  `adapter_field ... present` asserts the KEY, and `[ .versions[]?.version ]` turns an absent or
  mistyped `versions` into `[]` because `?` swallows the type error by design. That `[]` becomes
  both the baseline and the after-removal list, so the delta is empty — and an empty delta is this
  flow's documented cue for `removable`. A parser that found nothing would recommend a deletion
  with no advisory query run, which is the repo's headline rule inverted in the one driver whose
  output deletes things. `fix-group.sh`'s `line_versions` hard-errors on the identical payload for
  the identical reason.
- **The advisory cache is a payload like any other, and it outlives the process.**
  `$WORK/advisories/` is read by a later invocation than the one that wrote it, so it is written
  temp-plus-`mv` (as `state_set` writes the state file) and validated on read by the same function
  the fresh query goes through — object-ness, all five promised fields, and `verdict` being one of
  the four values `check-advisories.sh` emits. A torn entry read blind reaches `--argjson`, where
  jq dies exit 2 with no stdout: the checkpoint contract's own `needs_judgment`, manufactured out
  of a half-written file.
- **There is no `require_json` helper, and the reason is not that it never fired.** It did: a jq
  that errors prints nothing, and `printf '' | jq -e 'true'` exits 4. What it could not do is say
  anything useful — "is this JSON?" passes for `null`, for `[]` and for every wrong-shaped value,
  so on a payload it reported the wrong problem and on an internal capture it reported the right
  problem too late to name which step produced it. Both halves are now handled where they belong.
  A payload ENTERING the script is validated against **the shape its caller reads**:
  `state_json`'s predicate, `rv_versions`, `advisory_validate`. A capture PRODUCED here carries
  `|| fail_phase` on the producing command, so the diagnosis names that command instead of
  whichever check the empty value happened to trip next.
- **A container check is not a shape check, and the difference recommends deletions.**
  `state_json '.findings' 'type == "array"'` asserted the box. A `tested` finding whose
  `attributable_versions` came back a string, an object or `null` is not `[]`, so it skipped the
  empty-delta arm, entered the advisory loop, and `jq -r '.[]'` errored there — the heredoc fed
  nothing, the loop body never ran, `verdicts` stayed `[]`, and **`all` over an empty array is
  `true`**. The pin earned `removable` with `advisory_verdict: "safe"` and no advisory query run
  at all, which in `pr` mode is a deletion in a pull request. `FINDINGS_SHAPE` is therefore the
  shape the callers read, down to `collateral_changes` entries carrying a boolean `judged` — and
  `judge` additionally refuses a non-empty collateral list in which nothing was judged, because an
  empty verdict list collapses to `safe`, the strongest claim available about packages nobody
  looked at.
- **Each step refuses to run before the one it depends on**, and the guard on `together` is the
  one that earns its keep: before `judge` every finding still reads `tested`, so an unguarded
  `together` finds an empty candidate set and terminates exit 0 with `no removable pins found` — a
  claim about work that never happened, arriving at the agent as a successful audit. `judge`'s own
  guard is on a tested pin existing, not merely on `baseline_done`: `baseline` writes findings for
  the pins it refused, so a healthy repository has `findings: []` the moment it finishes and the
  same false claim was reachable with no `test-pin` call at all. And `judge_done` is cleared by
  every `record_finding`, because a `test-pin` run after a judgment leaves that pin `tested` and
  `together` selects on status — the pin would be dropped from a candidate set the agent believes
  is complete. **Every** write to `findings` goes through `set_findings`, which clears the flag:
  the one that did not was `baseline`'s bulk write, so a second `baseline` after a completed
  judgment reset the findings to its own refused set while `judge_done` stayed true and
  `together` reported `no removable pins found` over an audit it had just discarded. And `judge`
  counts the pins the baseline did NOT refuse, never every testable pin: counting all of them
  deadlocks a repository whose baseline refused every one, since `test-pin` refuses those by
  design and there would be no route to any report at all.
- **The tested package's advisory answer never absorbs the collateral verdict.** `advisory_verdict`,
  `advisory_count` and `matched_ranges` are `check-advisories.sh`'s reply about the pinned package
  and nothing else; a collateral package's result lives in `collateral_verdict`. Derived instead
  from the pin's final status — which the collateral collapse overwrites — a pin whose own delta
  came back `safe` reported `advisory_verdict: "vulnerable"` with `matched_ranges: []`, and
  `inconclusive`, which that script never emits, swallowed the difference between `unknown` and
  `no-advisories` even with no collateral at all.

## One group per package major line, and validate decides completeness

`discover-alerts.sh` groups by package **and** the major of `first_patched_version`. Grouping by
package alone collapsed every patched version into one `highest_fixed_version`, which described
only the newest line while the older ones stayed vulnerable under a group reported as fixed
([#19](https://github.com/SurveyMonkey/skills/issues/19)). Anything that regroups or renames must
keep one branch, one worktree and one PR per line.

Discovery cannot tell which resolved copy an alert matched: the API does not say, and discovery
has no lockfile. **Only the adapter's `validate` can answer whether the alerts were actually
cleared**, and it must be given the group's `vulnerable_range`s (`--vulnerable`) to do it. A
constraint check alone passes a partial fix, so the guarantee is enforced rather than requested:
`--line` without `--vulnerable` is an error, and so is a `--vulnerable` range that does not parse
(range satisfaction answers false for a token it cannot read, which on this side means "nothing is
vulnerable").

## Where the prescribed git shapes run, and why

Both agent definitions prescribe exact `git` shapes, and where each one runs is a constraint rather
than a style choice.

**Every write the audit's `pr` mode makes runs from inside the worktree**, because a write that
names `repo_root` instead lands in the user's own tree (Hard rules, `agents/fix-dependency.md`).
`agents/audit-pins.md` phases 7 and 8 are the authority on which those are; as of this writing they
are `ls-files -- .yarn/cache`, `checkout HEAD -- .yarn/cache`, `status --porcelain`, `diff --quiet`,
`add`, `branch -D`, `switch -c`, `commit`, and
`push -u --force-with-lease=<ref>:<sha> origin <ref>`. **A prescribed shape that starts naming
`repo_root` is a bug, not a style change.**

**That the branch is created from inside the worktree rather than at `worktree add` time is
deliberate.** A run that opens no PR leaves no branch behind.

**The fix agent's leftover-branch cleanup is the one write either definition prescribes at
`<repo_root>`, and it has to be.** Git refuses to delete a branch that is checked out in a
worktree, so `branch -D <branch_name>` runs **after** `worktree remove`, when no worktree is left
to run it from ([#84](https://github.com/SurveyMonkey/skills/issues/84)). The audit's own
`branch -D` above is not the same case: it deletes a *remnant* of the branch name before
`switch -c` creates it, so nothing has it checked out.

## `allowed-tools` in a plugin skill's frontmatter is not honored

Claude Code does not currently apply a plugin skill's `allowed-tools` grants
([anthropics/claude-code#80696](https://github.com/anthropics/claude-code/issues/80696),
[#80802](https://github.com/anthropics/claude-code/issues/80802), both open as of v0.8.2). The list
in `skills/resolve-alerts/SKILL.md` documents the intended surface; it does not suppress prompts.
That is why prescribed shapes are written to be pre-approvable on their own (literal paths, no
variables, no conditionals, no redirections) rather than relying on the frontmatter. The plugin
carried a permissions preflight that pre-approved its whole surface in one decision until v0.8.2,
when `auto` became the recommended default mode and the workaround was removed
([#86](https://github.com/SurveyMonkey/skills/issues/86)).

## `env_prefix` is an opaque, optional seam

`env_prefix` is **a command prefix the environment requires for repo-targeted commands**. The
plugin never names an environment manager, probes the filesystem for one, or invents a prefix of
its own, and it never assumes per-directory environments exist at all. **Where a prefix comes from
is the user's environment's concern** — a workspace- or user-level CLAUDE.md or rules file saying
commands in that tree need one — and the dispatcher passes verbatim whatever the session context
supplies.

**The opacity is the agent's, not the dispatcher's.** The dispatcher does have to recognize a
context statement, and to instantiate the prefix against a directory where the statement takes one
(SKILL.md phase 5 says which directory, and why it is not the checkout path). That happens once,
before the repo's first command. From then on the prefix is a literal string that is threaded and
prepended and never re-derived, by the dispatcher or by any agent it dispatches.
Absent any such context there is no prefix and nothing extra happens, which is the ordinary
single-login case ([#135](https://github.com/SurveyMonkey/skills/issues/135)).

The contract is one optional dispatch field. The dispatcher — `resolve-alerts` SKILL.md phase 1
(repo scope) or phase 5 (org and user scope), or the `audit-pins` command's step 1 — resolves
`env_prefix` from session context, runs its own `gh`/`git`/script invocations for that repo under
it, and carries it in the dispatch payload. Each agent then prepends it verbatim to every `gh`,
`git`, package-manager, and adapter-script invocation — composed **after** the command's own `cd`
locator, because the prefix injects environment without changing directory — and runs those
commands bare when the field is absent. It wraps a command, not a shell builtin, so it can never
stand in for a `cd`. `check-advisories.sh` makes its own `gh` call, so it takes the same wrapping.

The failure class this guards against is manager-agnostic: per-directory environment tools load
through interactive shell hooks that non-interactive tool shells never run, so a bare `gh`, `git`,
or install resolves whatever identity or registry token the shell defaults to. The symptoms are
misleading rather than obvious, which is why this is a contract and not a tip: bare `gh` reports
"please run gh auth login" on a correctly configured machine, bare `git fetch` reports
**`repository not found`** (reads as a renamed or deleted repo, not an auth context), bare
`git commit` fails on a missing author identity, and a bare package-manager install 401s against
the wrong registry token. Following an agent definition literally without the wrapping fails at
phase 1 ([#33](https://github.com/SurveyMonkey/skills/issues/33)).

**An absent prefix has two causes and only one of them is benign**: the environment genuinely
needs none, or session context stated one and the dispatcher did not recognize it. Any of the
symptoms above is the signal to re-read session context for a prefix you missed, before concluding
that this repo's commands belong bare.

## Repo-global git state belongs to the orchestrator, never to an agent

Agents share a `repo_root` by design — the rolling pool runs multiple `fix-dependency` agents
against the same repo at once, and a pin audit dispatched separately may still coincide with one in
the narrow window the preflight does not close (`docs/adr/009-decouple-pin-audit.md`) — and
worktree *paths* not colliding is not the same as repository state not colliding
([#35](https://github.com/SurveyMonkey/skills/issues/35)).

- `.git/info/exclude` is written once per repo by `common/ensure-worktree-exclude.sh`, called by
  the orchestrator before it dispatches any agent for that repo. Agents never write it. Two agents
  working the same repo start milliseconds apart, so a read-then-append from each can duplicate the
  line or tear the file.
- **Never `git worktree prune` from an agent.** It walks *every* worktree entry in the repository,
  so a call timed against a sibling mid `worktree add`/`remove` can delete a live registration —
  and the breakage surfaces in the victim, not the caller. `git worktree remove <own-path>` already
  removes the caller's own entry; that is the whole cleanup an agent is entitled to.
- **What an agent leaves behind is reaped by the orchestrator, one agent at a time**, through
  `common/reap-agent-artifacts.sh`: on each completion, after the orchestrator has verified that
  agent's pull request is open, and never for an agent that ended any other way. The verified open
  PR is what makes the local branch delete safe (its tip is on origin), and the script is local
  scope only, touching exactly one worktree path and one local ref, so it is legal while siblings
  are in flight. It never prunes either. Its one administrative write is the narrow form of the
  same rule: a worktree directory that is gone while its registration survives blocks both a later
  `worktree add` on that path and any `branch -D` of its branch, and `git worktree remove` refuses
  it, so the reap removes the **single** entry under `<git-common-dir>/worktrees/` whose `gitdir`
  file names that one path, identified by that content and never by position.

## No Bash snippet may depend on the previous call

The Bash tool resets cwd between invocations and shell variables do not survive it. A snippet in
an agent definition that relies on an earlier `cd` or an earlier assignment runs in the user's
checkout instead of the worktree — which is how a live run bumped a package and regenerated a
lockfile in a real repository ([#18](https://github.com/SurveyMonkey/skills/issues/18)). Every
prescribed snippet locates itself: `git -C <path> ...`, or `cd <path> && <command>` for
everything else.

Scripts that are cwd-sensitive enforce it rather than trust it, through one shared guard:
`common/require-linked-worktree.sh`, invoked by `refuse_primary_checkout` in
`ecosystems/node.sh` for the verbs that write: `apply_constraint`
(rewrites `package.json`, and under npm deletes the stale lockfile entries its override must
move — npm keeps an existing `package-lock.json` entry over a newly added override, issue #124),
`install` (rewrites the lockfile and `node_modules`) and `shim`
(creates a directory and an executable, and absolutizes a vendored runner from the cwd). That is
the whole set today; a verb that starts writing joins it, and the guard is its first statement. It
requires the cwd to sit inside a **linked** worktree, which a primary checkout, any subdirectory
of one, a submodule (also a `.git` file), and a directory in no repository at all all fail. Specs
fake a worktree with `fake_linked_worktree` (see `spec/spec_helper.sh`).

## Removability is judged against the advisory database, never repo alert history

`check-advisories.sh` unions the vulnerable ranges of **every published advisory** for a package
and, given `--adapter` and `--version`, returns a verdict for one candidate version. The pin audit
has no other source for "is this version safe", and the reason is structural: a pin keeps
vulnerable versions out of the lockfile, so every advisory published after the pin produced no
alert on that repository. Asking the repo's own alert history is asking "was anything reported
while we were protected", whose answer is no by construction.

Its four verdicts exist because three different things get mistaken for safety. `safe` means
advisories exist, every range was evaluated, and none admits the version. `unknown` means a range
could not be read — never folded into `safe`, since an unreadable range is exactly where an
unnoticed match hides. `no-advisories` means the query succeeded and returned nothing, which a
non-security pin, a misspelled package name, and the wrong ecosystem all produce identically.

When the adapter itself fails on a range, its stderr is kept in `adapter_errors[]` rather than
discarded. The verdict is unchanged — an unevaluated range is never folded into `safe` — but a
broken adapter otherwise turned every pin in the audit inconclusive with nothing naming the cause.

## An override's key is scoped; its effect is not, and only a baseline sees the difference

The pin audit already knows this on the removal side. The fix side learned it the hard way: a
scoped entry can move a copy of the package on a major line the group does not own, and every
check in the fix flow was scoped to `--line` and structurally unable to notice
([#83](https://github.com/SurveyMonkey/skills/issues/83)). The fix flow's `--baseline` is
snapshotted after a no-change control install, so the diff measures only apply-attributable
movement; snapshotted before any install, a stale default-branch lockfile's ambient re-resolution
gets attributed to the fix ([#146](https://github.com/SurveyMonkey/skills/issues/146)).

The mechanism is per-manager, and Yarn's is the one that bites. Verified empirically against a
throwaway worktree of a real repository, and against Yarn's `reduceDependency` hook:

- **Yarn** compares the `from` half of a `resolutions` key by `locatorHash` equality against the
  parent's **resolved locator**. A bare `minimatch/brace-expansion` falls back to the parent's own
  reference, so it matches every copy of `minimatch` — that is the defect. Only the parent's exact
  resolved version narrows (`minimatch@npm:10.2.5/...`, protocol optional). A **range** there
  parses and then silently never matches: no warning, exit 0, nothing applied. That is a worse
  failure than the collapse, and it is why "just narrow the key" is not a one-line fix.
- **pnpm** matches `parent@^10>dep` with `semver.satisfies` against the parent's resolved version.
  An exact version there narrows the key to one copy, and `apply_constraint` uses it: a pnpm
  parent the lockfile resolves at more than one version gets **version-qualified keys**
  (`minimatch@10.2.5>brace-expansion`), one per parent version whose resolution of the child sits
  on the target line, read from the same `snapshots:` edges `declared_ranges --line` classifies
  with. A bare key there matched every copy of the parent, which is how `ws` 7.x/8.x and
  `brace-expansion` 1.x each collapsed their sibling lines on the field run; the qualified form is
  the one five shipped field PRs validated with `other_line_moves: []`
  ([#100](https://github.com/SurveyMonkey/skills/issues/100)). A single-version parent keeps the
  bare key — nothing else exists for it to leak onto. A multi-version parent can still receive
  the bare key on two fallback paths — no parent version qualifies for the target line, or none
  of its snapshot keys carries a readable version — because an entry that over-covers beats
  writing nothing. The exact-version form is a deliberate staleness tradeoff: it is the shape the
  field PRs validated, and a later bump of a parent copy inertly un-matches its key rather than
  dragging the new copy onto the wrong line; re-running the fix refreshes it. The same snapshots
  record only what each copy *resolved*, never the specifier it was declared with, so a
  multi-copy pnpm parent keeps its per-copy line while its declared ranges stay unread
  (`parents_unreadable`) — under pnpm the risk score sees fewer declared ranges than under npm or
  yarn. yarn stays unqualified: its narrowing needs the full resolved locator (above).
- **npm** matches `{"parent@^10": {...}}` with `semver.intersects` on the edge's descriptor and
  `semver.satisfies` on the node's resolved version, and its nesting is transitive rather than
  direct-child-only. `apply_constraint` qualifies npm parents the same way it qualifies pnpm's: a
  multi-version parent gets one nested key per copy whose resolution of the child sits on the
  target line, keyed by the copy's **exact resolved version**, which every edge that resolved
  that copy admits (a version satisfying a range always intersects it) while a sibling line's
  edges admit it only when their declared ranges span majors. The one exception is empirically
  forced (npm 11.16.0, issue #132): npm hard-fails the install with `EOVERRIDE` on any override
  key whose selector intersects a **direct dependency's** spec without being byte-identical to
  it, so the copies satisfying the root manifest's own declared spec share a single key carrying
  that spec verbatim, and that key also covers every other edge whose range admits such a copy,
  because two ranges sharing a version always intersect. Declared-range qualifiers for the
  general case were considered and rejected on the same evidence: two same-major ranges
  (a grandparent's `^10.0.3` beside the root's `^10.2.5`) intersect each other, which is exactly
  the `EOVERRIDE` shape. Same fallbacks as pnpm, in both directions: a single-version parent and
  a parent with no qualifying copy keep the bare nested key, and the same staleness tradeoff
  applies, since a later bump of a parent copy inertly un-matches its exact key rather than
  dragging the new copy onto the wrong line. The carve-out's hard edges each have a fixed route:
  a root spec that ALSO admits an off-line copy of the parent (`*`, `>=3`, a cross-major `||`)
  is refused outright before anything is written, because no key satisfies the byte-identical
  rule and the line separation at once; a root spec the range readers cannot judge (a dist-tag,
  `file:`, a tarball URL, `workspace:*`, an `npm:` alias) and a parent copy whose lockfile
  version is unreadable or not plain semver all fall back to the bare key; and a prerelease copy
  is never counted covered by the root spec (node-semver excludes prereleases from plain ranges)
  and takes its own exact key. A pre-existing bare nested key for the same parent and child is
  superseded and reported in `superseded_keys` when it pins this line, because npm inserts it
  first into the OverrideSet and it would leave the qualified keys inert, and the call refuses
  when that key pins a DIFFERENT line, since deleting it strips that line's protection and
  keeping it smothers this fix.

  One shape sits outside that whole top-level algorithm: an override-placed parent, one a
  pre-existing rule names as a child key of another rule (`{"A": {"B": "<range>"}}`). npm scopes
  such a node to the rule that placed it, so a top-level key never matches it, qualified or bare,
  and a constraint written there is silently inert (field-verified across three clean reinstalls,
  issue #147). `apply_constraint` therefore nests the new entry inside the placing rule, the
  `"."` self key carrying the parent's own range, and only when the lockfile corroborates the
  rule: its root and every intermediate segment must appear, in order, in a parent copy's logical
  ancestor chain, with each segment's selector (the child key's own included) checked against the
  installed copy's version by the same `satisfies` the qualifiers use, so a rule that merely
  spells the parent's name, or whose selector cannot match the installed chain, places nothing
  and the ordinary top-level write proceeds. A parent with both placed and normally-resolved
  copies composes both shapes, which cannot collide since each matches only its own copies, and
  `--tighten-bare` composes the same way: the placing rule's pin tightens in place, plus the
  covering top-level key when normal copies exist. The shapes no verified key form serves are
  refused outright, naming the rule: a rule placing the parent through an `npm:` alias child key,
  a version-qualified child key as the placing rule (when its selector does match installed
  copies), a rule whose reach also spans other major lines of the child, a dead different-line
  top-level pair for a fully placed parent, and a different-line pin already inside the placing
  rule.

So `validate --baseline` detects rather than prevents, and that ordering is deliberate: detection
is the guard that has to exist under any of the three narrowing schemes, including the one that
fails open. `other_line_moves` is `null` when no baseline was passed and `[]` when one was and
nothing moved — the same "not checked" versus "checked and clean" distinction the audit draws with
`collateral_changes: null`, and for the same reason. Only majors **present in the baseline** are
compared; a major that first appears after the install is the install adding a copy, not this fix
moving one. Detection is only as honest as its baseline: `agents/fix-dependency.md` snapshots it
after a no-change control install precisely because a stale default-branch lockfile otherwise
attributes ambient re-resolution to the fix
([#146](https://github.com/SurveyMonkey/skills/issues/146)) — the adapter deliberately does not
loosen for it. Each entry also carries a `class`, `"fatal"` or `"benign_dedup"` (with
`--sibling-alerts`, a within-major dedup no sibling alert can reach); `validate`'s own `ok` keys on
whether any entry's `class` is `"fatal"`, not on the array being non-empty.

The parent list is the second route to the same damage. `why` has no `--line` and answers about
the package as a whole, so `agents/fix-dependency.md` narrows to `declared_ranges --line`'s
`parents_read` before calling `apply_constraint`. A parent in `parents_other_lines` never receives
a scoped entry: on a live run, passing all of `undici`'s parents for the 6.x group would have
pinned `@vercel/sandbox` (7.28.0) and `vercel` (5.29.0) under `>=6.28.0 <7`.

## A removal is judged against the whole tree, not one package

An override is not scoped in its effects the way its key is scoped in its syntax. Lifting one
changes dedup and hoisting and can let a peer conflict resolve differently, so removing a pin on A
can move B. `resolved_versions A` cannot see that, and the `removable` verdict it produces is
correct about A and silent about the tree it was tested in
([#42](https://github.com/SurveyMonkey/skills/issues/42)).

`resolution_map` is the whole-lockfile answer, and the audit diffs it across every removal.
Anything else that judges a tree change reads it the same way. Two rules travel with it:

- **Zero entries is an error here too, and for a sharper reason.** A diff against an empty map
  reports every package unchanged — "found nothing" meaning "all clear" once more, this time
  wearing the shape of a clean diff. **Guard on what the parser read, never on what a `grep`
  counted.** The yarn count was a `grep -c 'resolution: "'` while the rows had to survive two more
  filters, so a lockfile parsed to nothing reported `lockfile_entries: 3, package_count: 0` and
  exit 0 ([#46](https://github.com/SurveyMonkey/skills/issues/46)). A parser therefore separates
  "read it and excluded it" from "could not read it" and refuses when the recognized share
  collapses — a ratio and not a zero-check, because an all-local repository legitimately resolves
  to no registry version and a *partial* parse passes a zero-check.
- **A verdict says what it covers.** When the map is unavailable the audit still runs, but its
  findings say the claim is about the named package only. A narrower finding is a smaller result;
  a finding that outruns what was checked is a wrong one. The guard is a *ratio*, so a single
  unreadable locator passes it and drops its package from both snapshots — no change in the diff,
  and `[]` is the stronger claim. `resolution_map` therefore reports `unreadable_entries`, and
  `agents/audit-pins.md` maps any non-zero value onto `collateral_changes: null` +
  `collateral_verdict: not-checked` ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
- **Every parser owes three answers, not two**, and "deliberately excluded" is the one that keeps
  getting forgotten: an npm workspace link (`link: true`, no `version`) and a pnpm `link:`, `file:`
  or git entry belong with Berry's `workspace:` and `portal:` locators, not in the unread count.
  Counting them as unread hard-failed ordinary monorepos with a "the parser is broken" diagnosis,
  which stops the audit and fails the fix flow's baseline
  ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
- **A package is identified by what it resolves to, never by where it sits**, and identically in
  `resolution_map` and `resolved_versions` — the audit reads a disagreement between them as a
  parser bug. Berry's `patch:` locator percent-encodes the descriptor it wraps, and npm keys an
  `npm:` alias by the alias with the real name in `.name`; matching a literal `@npm:` or reading
  the `node_modules/` path lost the first entirely and mislabeled the second
  ([#44](https://github.com/SurveyMonkey/skills/issues/44)). Neither tripped the zero-entry guard,
  because the entry count is nonzero and the map merely looks healthy — which is the whole reason
  to state the identity rule rather than leave it to each parser. The **install key** answers too,
  in `resolved_versions` only: it is what an override entry for an aliased dependency names, so it
  is what `list_pins` hands the audit, and `present: false` there is read as "the package left the
  tree". That is the single place the two verbs differ about a name, it is documented in ADR 001,
  and `apply_constraint` writes the same key so the copy can also be moved
  ([#46](https://github.com/SurveyMonkey/skills/issues/46)). Answering under both names has one
  documented consequence: a real package sharing its name with another entry's install key has its
  versions merged into one answer. **On the read path** the direction is fail-safe and the audit
  names the shape. **On the write path it is not**: `apply_constraint` retargets the colliding
  declaration in place, turning `"lodash": "npm:underscore@^1.13.6"` into
  `"npm:underscore@^4.17.21"` — a version of `underscore` that does not exist — while the copy the
  caller meant goes unmoved. The adapter cannot tell the two senses apart there either, so
  `written[]` reports what it wrote and `agents/fix-dependency.md` fails the run on a written
  `npm:` value naming a package other than the one passed
  ([#49](https://github.com/SurveyMonkey/skills/issues/49)). See ADR 001's alias exception.

## What a parent declares comes from the lockfile, never from `node_modules/`

`apply_constraint` runs **before** `install`, in a fresh worktree where `node_modules` is
gitignored and absent; Yarn PnP never has one, and pnpm links only direct dependencies into one.
Reading `node_modules/<parent>/package.json` for a parent's alias key therefore found nothing every
time, skipped silently, and wrote the plain package name — which does not govern the aliased copy,
so the escalation ladder re-ran the same lookup and the flow dead-ended
([#48](https://github.com/SurveyMonkey/skills/issues/48)). The declarations come from
`.packages["node_modules/<parent>"]` (npm) and each `resolution:` entry (Berry), through one reader
that `why`, `apply_constraint` and `declared_ranges` all share — the shared reader is what gave
Berry a working alias path at all
([#47](https://github.com/SurveyMonkey/skills/issues/47)). Both read the same three blocks —
`dependencies`, `optionalDependencies` and `peerDependencies` — because a parent that declares the
package as a peer is why the copy is in the tree at all; Berry read only `dependencies` until
[#49](https://github.com/SurveyMonkey/skills/issues/49), which hid exactly that parent.

Two rules travel with it, both of which the old lookup broke:

- **A parent whose declaration cannot be read is named**, in `alias_lookup.parents_unresolved`.
  pnpm has no readable declaration at all — its snapshots record what a dependency resolved to, not
  the key it was declared under — so it reports `source: "unsupported"` rather than guessing.
- **The result states the key and value actually written**, in `written[]`, produced by the same jq
  pass that writes them. Two copies of that logic is how the report came to say `package`/`range`
  while an alias key had been written, putting an edit in the PR body that was never made.

`declared_ranges` is the one verb that also reads the installed manifest, and it may: it runs
**after** `install`, and the manifest on disk is the state actually installed, which is how a
parent that declares nothing in the release the lockfile recorded is told apart from one nobody
could read. But it is per parent *name*, and a parent in the tree at several versions has one
declaration per copy, each resolving its own copy of the package. Asking one file for a
multi-version parent attributes one copy's range to every line; asking it in a worktree that has
no `node_modules` — Berry PnP, or any fix worktree before `install` — loses the range entirely and
reports the parent as unreadable, which is what happened on a live `brace-expansion` fix
([#85](https://github.com/SurveyMonkey/skills/issues/85)). So the lockfile answers **per parent
copy** whenever the manifest cannot: more than one copy, or no manifest on disk. A manifest that
is on disk and will not parse is a damaged install and stays `parents_unreadable` +
`parents_malformed` rather than falling back — the reviewer needs that fact, not a substitute for
it. pnpm's rows carry no declared range, for the same reason `alias_lookup` reports `unsupported`
for it — its snapshots record what resolved, never the specifier — but they do carry **line
membership**: the child version each parent copy resolves, which is what `--line` classifies on.
Under the isolated store neither of the installed-tree probes can answer that (the child is never
nested under `node_modules/<parent>/`, and the hoisted fallback describes the root's copy), so
every pnpm parent used to land in `parents_unreadable` with `parents_other_lines` empty, and the
overrides written for them collapsed the sibling lines
([#100](https://github.com/SurveyMonkey/skills/issues/100)). An other-line pnpm parent is now
named in `parents_other_lines`; only an on-line copy whose manifest is truly absent stays
`parents_unreadable`, because its range — unlike its line — really is unreadable.

`spec/fixtures/npm-alias` has **no committed `node_modules`** for this reason, and
`spec/fixtures/npm-alias-installed` is a separate specimen of the installed state `declared_ranges`
reads. A fixture carrying a directory that does not exist where the verb runs is not a specimen of
reality, and it is why the suite stayed green through this.

## The rule that matters most

**Zero resolved versions is an error, never a pass.** `resolved_versions` returning an empty list
means the parser failed, not that the package is absent. The shipped v0.1.0 yarn validation
regex could never match, so it returned zero lines and every yarn repo got a "lockfile
validated" claim backed by nothing. Any code path that treats "found nothing" as success is a
bug.

## Supported toolchains

`node.sh detect` handles pnpm, npm, and Yarn Berry (v2+, lockfiles carrying a `__metadata`
block). Unsupported toolchains are **rejected gracefully**, never with a crash, pointing at
`.github/CONTRIBUTING.md`:

- **bun** — dropped, unused internally
- **Yarn Classic v1** — a `yarn.lock` with no `__metadata` block

Same treatment for non-`npm` advisory ecosystems in `select-adapter.sh`: skipped and reported.

## Testing

Shellspec suites live in `spec/` at the repo root; conventions are in the root `CLAUDE.md`
(Testing section). The suite runs in CI and in the committed pre-push hook, via
`scripts/check.sh` at the repo root (ADR 005). Fixture tests do not replace verifying
against real repositories with live alerts; check both the success path and the "parser found
nothing" path.
