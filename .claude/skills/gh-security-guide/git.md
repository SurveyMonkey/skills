# gh-security: git and worktree rules

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

## Repo-global git state belongs to the orchestrator, never to an agent

Agents share a `repo_root` by design — the dispatch workflow runs multiple `fix-dependency` agents
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
  `common/reap-agent-artifacts.sh`: once that agent's result is in hand and its pull request has
  been verified open, and never for an agent that ended any other way. The verified open PR is what
  makes the local branch delete safe (its tip is on origin). Since issue #175 the reap runs after
  the dispatch workflow returns, so in practice no sibling is in flight — but **the local-scope
  rule is what makes it safe, not the timing**: the script touches exactly one worktree path and
  one local ref, which is why it would be legal mid-flight too, and why nothing here may be
  widened on the strength of "everything has finished by now." It never prunes either. Its one administrative write is the narrow form of the
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
`common/require-linked-worktree.sh`, called by `ecosystems/node.sh` before each of the verbs that
write: `apply_constraint` (rewrites `package.json`, and under npm deletes the stale lockfile
entries its override must move — npm keeps an existing `package-lock.json` entry over a newly
added override, issue #124),
`install` (rewrites the lockfile and `node_modules`) and `shim`
(creates a directory and an executable, and absolutizes a vendored runner from the cwd). That is
the whole set today; a verb that starts writing joins it, and the guard is its first statement. It
requires the cwd to sit inside a **linked** worktree, which a primary checkout, any subdirectory
of one, a submodule (also a `.git` file), and a directory in no repository at all all fail. Specs
fake a worktree with `fake_linked_worktree` (see `spec/spec_helper.sh`).
The TypeScript port of the guard is `requireLinkedWorktree` in `plugins/gh-security/src/worktree.ts`.
It is a function, not a command. Each write verb of the adapter calls it in
process, as its first statement (#222). In the node adapter, these are `install`
(`src/adapters/node/install.ts`), `shim` (`src/adapters/node/shim.ts`) and `applyConstraint`
(`src/adapters/node/apply-constraint.ts`). `validate` only reads, so it has no guard.
`tests/plugins/gh-security/parity-worktree.test.ts` runs the guard against the script.
