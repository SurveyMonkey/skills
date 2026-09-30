# gh-security: the pin-audit driver

## The pin-audit driver owns phases 2, 4, 5 and 7

`common/audit-pins-driver.sh` executes `agents/audit-pins.md` phases 2, 4, 5 and, in `pr` mode,
phase 7. Same rule as the fix driver ([fix-driver.md](fix-driver.md)): **the audit procedure lives here and nowhere else**, and a
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

- **The removal is an in-driver edit, not an agent Edit call**, and it takes the whole override
  block when the entry was the last one in it. `pnpm-workspace.yaml` (issue #159) is not JSON and
  cannot be edited as one at all, and the adapter's own workspace writer deliberately refuses to
  delete a pre-existing entry, so the driver carries a line-level deleter over exactly the flat
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
  Asserting that the `versions` key is present is not asserting that it holds versions: read
  leniently, an absent or mistyped `versions` collapses to an empty list rather than raising. That
  empty list becomes both the baseline and the after-removal list, so the delta is empty, and an
  empty delta is this flow's documented cue for `removable`. A parser that found nothing would
  recommend a deletion with no advisory query run, which is the repo's headline rule inverted in
  the one driver whose output deletes things. `fix-group.sh` hard-errors on the identical payload
  for the identical reason.
- **The advisory cache is a payload like any other, and it outlives the process.**
  `$WORK/advisories/` is read by a later invocation than the one that wrote it, so it is written
  to a temporary path and renamed into place, as the state file is, and validated on read by the
  same check the fresh query goes through: object-ness, all five promised fields, and `verdict`
  being one of the four values `check-advisories.sh` emits. A torn entry read blind dies in the
  parse with nothing to show for it, as the checkpoint contract's own `needs_judgment`,
  manufactured out of a half-written file.
- **There is no one generic "is this JSON?" check, and the reason is not that it never fired.** It
  did: a failed parse produces nothing at all, and nothing is not JSON. What it could not do is
  say anything useful, because "is this JSON?" passes for `null`, for `[]` and for every
  wrong-shaped value, so on a payload it reported the wrong problem and on an internal capture it
  reported the right problem too late to name which step produced it. Both halves are now handled
  where they belong. A payload ENTERING the driver is validated against **the shape its caller
  reads**: the state file against its reader's predicate, a `resolved_versions` payload against
  the versions its caller lists, a cached advisory against the five fields it promises. A capture
  PRODUCED here fails the phase at the step that produced it, so the diagnosis names that step
  instead of whichever check the empty value happened to trip next.
- **A container check is not a shape check, and the difference recommends deletions.** The check
  in place asserted only that `findings` is an array: the box, not what the callers read out of
  it. A `tested` finding whose `attributable_versions` came back a string, an object or `null` is
  not `[]`, so it skipped the empty-delta arm, entered the advisory loop, and iterating it errored
  there: the loop was fed nothing, its body never ran, `verdicts` stayed `[]`, and **"all of them"
  over an empty list is `true`**. The pin earned `removable` with `advisory_verdict: "safe"` and
  no advisory query run at all, which in `pr` mode is a deletion in a pull request. The findings
  shape that is validated is therefore the shape the callers read, down to `collateral_changes`
  entries carrying a boolean `judged`. And `judge` additionally refuses a non-empty collateral
  list in which nothing was judged, because an empty verdict list collapses to `safe`, the
  strongest claim available about packages nobody looked at.
- **Each step refuses to run before the one it depends on**, and the guard on `together` is the
  one that earns its keep: before `judge` every finding still reads `tested`, so an unguarded
  `together` finds an empty candidate set and terminates exit 0 with `no removable pins found` — a
  claim about work that never happened, arriving at the agent as a successful audit. `judge`'s own
  guard is on a tested pin existing, not merely on `baseline_done`: `baseline` writes findings for
  the pins it refused, so a healthy repository has `findings: []` the moment it finishes and the
  same false claim was reachable with no `test-pin` call at all. And `judge_done` is cleared
  whenever a finding is recorded, because a `test-pin` run after a judgment leaves that pin
  `tested` and `together` selects on status — the pin would be dropped from a candidate set the
  agent believes is complete. **Every** write to `findings` goes through the one setter that
  clears the flag: the write that did not was `baseline`'s bulk write, so a second `baseline`
  after a completed judgment reset the findings to its own refused set while `judge_done` stayed
  true and `together` reported `no removable pins found` over an audit it had just discarded. And
  `judge` counts the pins the baseline did NOT refuse, never every testable pin: counting all of
  them deadlocks a repository whose baseline refused every one, since `test-pin` refuses those by
  design and there would be no route to any report at all.
- **The tested package's advisory answer never absorbs the collateral verdict.** `advisory_verdict`,
  `advisory_count` and `matched_ranges` are `check-advisories.sh`'s reply about the pinned package
  and nothing else; a collateral package's result lives in `collateral_verdict`. Derived instead
  from the pin's final status — which the collateral collapse overwrites — a pin whose own delta
  came back `safe` reported `advisory_verdict: "vulnerable"` with `matched_ranges: []`, and
  `inconclusive`, which that script never emits, swallowed the difference between `unknown` and
  `no-advisories` even with no collateral at all.
