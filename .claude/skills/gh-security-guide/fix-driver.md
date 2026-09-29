# gh-security: the fix driver

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
script's own header (`common/fix-group.sh:1-76`); restating them here is how the two drift.

What that header does not say, and what belongs here:

- **The state file is the only thing that survives between steps**, so anything a later step needs
  is written into it and never carried in the caller's transcript. Two things it holds are load-
  bearing rather than incidental: the **fix-install counter**, which is what makes
  `install_budget_exhausted` reachable at all (one `apply` spends at most three of the four, and
  the agent doc sanctions re-running `apply` — a process-local counter reset on that re-run and
  bounded nothing), and the **`install_signals[]` union**, which carries what an install printed
  past the point where its output is discarded.
- **Every read of that file distinguishes "value", "absent" and "unreadable", and there is
  deliberately no unchecked sibling to reach for.** A discarded parse status turned a truncated
  `state.json` into empty strings, which is how a `cleanup` came to report success having removed
  nothing — and how `git -C ""`, which silently operates on the *current* directory, became
  reachable with `worktree remove --force` behind it (#18's failure mode). Every reader reports
  and one checked accessor does the dying at the call site, because a reader that answers with a
  value cannot end the run from inside it. An "every source is asserted" comment above a
  hand-maintained list is not the guarantee; a reader that cannot be called unchecked is.
- **`cleanup` holds its path to `reap-agent-artifacts.sh`'s containment discipline**, because the
  two run the same `rm -rf` on the same directory from opposite sides. Both sides resolved
  physically, no `..` segment, contained under `<repo_root>/.claude/worktrees/`, plus one
  condition available only here: `--work` must name the workspace `setup` recorded. The removal's
  status is then checked and reported as `work_dir: {path, action}` beside `errors[]` — reporting
  `worktree_removed: true` with no field naming `$WORK` is the failure [git.md](git.md) records on
  the reap's side of the same operation. **A populated `errors[]` exits non-zero**, as it does there
  (`reap-agent-artifacts.sh` ends the same way for the same reason): the fields without that
  exit still let an orchestrator keying on `status` read a leaked worktree as a clean cleanup.
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
