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
| `common/` | Ecosystem-agnostic: scope detection, alert discovery, adapter routing, risk scoring, capacity detection, PR status and promotion, advisory lookup, worktree ignore setup |
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

## Prescribed shapes and the preflight catalog move together

`preflight-permissions.sh` pre-approves exactly the command shapes the agent definitions
prescribe. Changing a prescribed shape in `agents/fix-dependency.md` or `agents/audit-pins.md`
without updating the catalog in the same commit reintroduces a permission prompt for spec'd
behavior — caught live once already (the `rev-parse` → `branch --list` guard change). Keep them in
lockstep: the audit's `git log -S`, `gh pr list` and fixed-alert lookup are in the catalog because
its definition prescribes them.

The audit's `pr` mode added **one** rule, and which shapes needed one is a checked fact rather than
an assumption. Every write it makes runs **from inside the worktree**, so
`Bash(git -C *$REPO_ROOT/.claude/worktrees/*)` covers all of those:
`ls-files -- .yarn/cache`, `checkout HEAD -- .yarn/cache`, `status --porcelain`, `diff --quiet`,
`add`, `branch -D`, `switch -c`, `commit`, and
`push -u --force-with-lease=<ref>:<sha> origin <ref>`. Its `gh pr list --repo <nwo> --head ...`
guards, `gh label` and `gh pr create` are byte-identical in shape to the fix agent's and were
already in the catalog.

The fix agent's leftover-branch cleanup is the mirror image, and the one *writing* git shape either
definition prescribes at `<repo_root>`: git refuses to delete a branch that is checked out in a
worktree, so `branch -D <branch_name>` runs **after** `worktree remove`, when no worktree is left to
run it from. `Bash(git -C *$REPO_ROOT* branch --list *)` is read-only and does not match it, so the
catalog carries `Bash(git -C *$REPO_ROOT* branch -D *)`
([#84](https://github.com/SurveyMonkey/skills/issues/84)).

The one addition is `Bash(git -C *$REPO_ROOT* ls-remote --heads origin *)`, for the remnant guard.
`rev-parse`, `branch --list` and `fetch origin` were already there and `ls-remote` was not, which
is exactly the lockstep failure this section is about: the guard's other three shapes would have
run silently while the one that reads the remote prompted.

That the branch is created from inside the worktree rather than at `worktree add` time is a
deliberate consequence of the same rule: it keeps every branch-manipulating shape under the one
worktree rule, and it means a run that opens no PR leaves no branch behind. A shape that drifts
from the fix agent's, or that starts naming `repo_root`, is a catalog change in the same commit.

## Every `gh` and `git` command runs under `direnv exec <repo_root>`

`direnv` does not auto-load in a non-interactive tool shell, so a bare `gh` or `git` uses whatever
account the shell defaults to. Both agent definitions and both entry points prescribe
`direnv exec <repo_root> gh ...` and `direnv exec <repo_root> git -C <path> ...` for that reason;
`check-advisories.sh` makes its own `gh` call, so it takes the same wrapping.

The failure modes are misleading rather than obvious, which is why this is a rule and not a tip:
bare `gh` reports "please run gh auth login" on a correctly configured machine, bare `git fetch`
reports **`repository not found`** (reads as a renamed or deleted repo, not an auth context), and
bare `git commit` fails on a missing author identity. Following an agent definition literally
without the wrapping fails at phase 1 ([#33](https://github.com/SurveyMonkey/skills/issues/33)).

## Repo-global git state belongs to the orchestrator, never to an agent

Agents share a `repo_root` by design — the spare-slot pin audit rides in the same wave as a fix
agent — and worktree *paths* not colliding is not the same as repository state not colliding
([#35](https://github.com/SurveyMonkey/skills/issues/35)).

- `.git/info/exclude` is written once per repo by `common/ensure-worktree-exclude.sh`, called by
  the orchestrator before it dispatches any wave. Agents never write it. Two agents dispatched in
  one message start milliseconds apart, so a read-then-append from each can duplicate the line or
  tear the file.
- **Never `git worktree prune` from an agent.** It walks *every* worktree entry in the repository,
  so a call timed against a sibling mid `worktree add`/`remove` can delete a live registration —
  and the breakage surfaces in the victim, not the caller. `git worktree remove <own-path>` already
  removes the caller's own entry; that is the whole cleanup an agent is entitled to.

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
(rewrites `package.json`), `install` (rewrites the lockfile and `node_modules`) and `shim`
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
([#83](https://github.com/SurveyMonkey/skills/issues/83)).

The mechanism is per-manager, and Yarn's is the one that bites. Verified empirically against a
throwaway worktree of a real repository, and against Yarn's `reduceDependency` hook:

- **Yarn** compares the `from` half of a `resolutions` key by `locatorHash` equality against the
  parent's **resolved locator**. A bare `minimatch/brace-expansion` falls back to the parent's own
  reference, so it matches every copy of `minimatch` — that is the defect. Only the parent's exact
  resolved version narrows (`minimatch@npm:10.2.5/...`, protocol optional). A **range** there
  parses and then silently never matches: no warning, exit 0, nothing applied. That is a worse
  failure than the collapse, and it is why "just narrow the key" is not a one-line fix.
- **pnpm** matches `parent@^10>dep` with `semver.satisfies` against the parent's resolved version.
- **npm** matches `{"parent@^10": {...}}` with `semver.intersects` on the edge's descriptor and
  `semver.satisfies` on the node's resolved version, and its nesting is transitive rather than
  direct-child-only.

So `validate --baseline` detects rather than prevents, and that ordering is deliberate: detection
is the guard that has to exist under any of the three narrowing schemes, including the one that
fails open. `other_line_moves` is `null` when no baseline was passed and `[]` when one was and
nothing moved — the same "not checked" versus "checked and clean" distinction the audit draws with
`collateral_changes: null`, and for the same reason. Only majors **present in the baseline** are
compared; a major that first appears after the install is the install adding a copy, not this fix
moving one.

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
it. pnpm has no rows here at all, for the same reason `alias_lookup` reports `unsupported` for it.

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
