---
name: resolve-alerts
description: >
  Resolve Dependabot security alerts for the current repository, or for every
  repository checked out directly under the current directory. Discovers open
  alerts, ranks them by severity and EPSS exploitability, and fixes one
  package, the highest severity tier, or everything: one subagent per group
  (one major line of one package, in one repo) in an isolated worktree through
  to a pull request, open for review, carrying a computed merge-risk rating.
  Use when asked to fix security vulnerabilities in dependencies, resolve
  Dependabot alerts for a repo or for a directory of checkouts, or clean up
  npm audit findings.
allowed-tools: Bash(*discover-repos.sh*), Bash(*detect-scope.sh*), Bash(*discover-alerts.sh*), Bash(*select-adapter.sh*), Bash(*classify-lines.sh*), Bash(*detect-capacity.sh*), Bash(*git -C * ls-remote*), Bash(*pr-status.sh*), Bash(*ensure-worktree-exclude.sh*), Bash(*post-agent.sh*), Bash(*node.sh detect*), Bash(*pnpm view *), Bash(*npm view *), Bash(*yarn npm info *), Bash(*gh issue list*), Bash(*gh issue create*), Bash(*gh issue comment*), Read, Workflow, AskUserQuestion
---

Orchestrate the resolution of Dependabot security alerts for the current repository, or for every
repository checked out directly under the current directory: discover and rank, ask how much to
fix, dispatch one `fix-dependency` subagent per group (one major line of one package, in one repo)
in parallel, and report the pull requests they open.

The deterministic work lives in scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/common/`. Call them;
do not reimplement them. Every script emits JSON on stdout and exits non-zero with an `error` key
on failure. **What a failure costs depends on what the script was run for.** A run-level script
(`discover-repos.sh`, `detect-capacity.sh`) failing means report its error and stop. A script run
for one checkout (`detect-scope.sh`, `discover-alerts.sh`, `select-adapter.sh`,
`classify-lines.sh`, the adapter's `detect`, and the two probes) failing means report its error
and exclude that checkout, by phase 1's rule, and carry on with the others.

You are the control point the user approves. Subagents run unattended through PR creation, so
**nothing dispatches before the user approves the plan in phase 4**, and that approval is the
whole of it: PRs open **ready for review** and **nothing here acts on a pull request after it is
created** (ADR 008). The decision to merge one is the reviewer's, on GitHub, with the diff in
front of them.

## Phase 1: Discover the checkouts

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/discover-repos.sh
```

**Scope is the checkouts on disk, and nothing else** (issue #188, ADR 011). The script answers
`repos`: when the working directory is inside a git repository, that checkout's root and nothing
else; when it is not, every immediate subdirectory that is itself the root of a checkout,
non-recursively. Subdirectories that are not repositories, and ones merely inside a repository
rather than at its root, are skipped without comment. **Do not classify the directory yourself; the
script already did.** Scope comes from git, never from what the directories are named (issue #134):
a checkout root is a fact `git rev-parse --show-toplevel` answers, and the script infers nothing
from a path segment. A symlinked entry is followed and listed once, under its resolved root, so
two links to one checkout are one repository in scope. A non-zero exit carries an `error`: the
target is not a directory or could not be read, or git itself failed for a reason other than "not
a git repository" (git missing from `PATH`, a `safe.directory` refusal, an unreadable or corrupt
`.git`). Report it and stop: the scope itself could not be established, so there is no checkout
to exclude and carry on from. An empty `repos` is exit 0, not an error: say "No git repositories
directly inside `<cwd>`" and stop.

**Nothing is ever cloned.** Not by default, not behind a flag, not into a directory the user names.
A repository the user wants in scope is one they clone themselves, which they were going to do
anyway to review the resulting pull request. An org with forty repositories and six local checkouts
has six in scope, and that is the answer, not a shortfall: this skill acts by making commits, so a
repository the user has not cloned is one they have not chosen to work on. There is no org to name,
no login to resolve, and no question to ask here. The skill runs against one repository or many,
and which it is follows from where it was invoked; a directory of checkouts is not an ambiguous
case to classify, it is the many-repo case.

**Then, for every checkout in `repos`, resolve three facts before anything else talks to it**, in
the order below. Resolve them for every checkout now, before phase 3 asks anything, so the plan
the user approves is final: every branch name is settled and every group is classified before it
is offered, and nothing is withdrawn after approval.

**An excluded checkout never ends the run on its own.** Steps 2 and 3 below each name a condition
under which a checkout is excluded; when one is, report it by name with the reason, keep going
with the others, and stop only when no checkout survives. With one checkout in scope that is the
same
"report and stop" it always was. Every checkout excluded here is named again in phase 2's report
and in phase 7's summary, so a repository silently left out of the batch never happens.

### 1. `env_prefix`

**Resolve `env_prefix` for this checkout here, before anything else talks to the repo.**
`env_prefix` is **a command prefix the environment requires for repo-targeted commands** — nothing
more is known or assumed about it here. It is optional, it is opaque, and it is never derived:
**take it from your session context.** When the CLAUDE.md or rules covering this repo's directory
state that commands in that tree need a prefix, that stated prefix is this repo's `env_prefix`,
used verbatim. When no such context exists — the ordinary single-login case — the repo has none
and every command for it runs bare, with no wrapping invented here.

**Any context that names a wrapper command for tools run in a directory tree is such a statement**,
however it is phrased. It does not have to use the word `env_prefix`, name this plugin, or mention
security work: a rule saying that commands in some tree must be run through a wrapper is stating
this repo's `env_prefix` whenever the repo sits in that tree. Where the stated prefix takes a
directory, **instantiate it against the checkout itself**, `repo_root`, which always exists: nothing
in this skill creates a checkout, so there is no destination directory to reason about and no
ordering hazard between resolving the prefix and having a directory to resolve it against.
Recognizing one is your job and missing one is silent, which is what the failure class below
describes.

The failure class the seam guards against is real and manager-agnostic: where `gh`, `git`, and the
package manager get their identity per directory rather than from a single ambient login, the tools
that arrange that load through interactive shell hooks that a non-interactive tool shell never
runs, so a bare `gh`, `git`, or install silently resolves the wrong identity or a dead registry
token. **The prefix covers your own commands, not just the agents'**: from here on, every `gh`,
`git`, and plugin-script invocation you make for this repo — `detect-scope.sh` next, the
namespace probe after it, every stage of the phase 2 pipeline, the adapter's `detect` and the
registry probe in phase 5, `post-agent.sh` in phase 6's reap step (which threads it to its own
`pr-status.sh` call and never to the reap it runs after) and this repo's `pr-status.sh` call in
phase 8 — runs under it, or discovery itself reads the wrong account's alerts before any dispatch
exists. Note
that `<env_prefix> <cmd>` runs `<cmd>` in the caller's current directory — it injects the
environment, it does not chdir — so it composes with, never replaces, whatever `cd` or `-C`
locator a command already carries. With several checkouts in scope each resolves its own prefix,
by the same rule, from whatever context covers its own directory; two neighbors can differ. The
command snippets in the phases below omit `env_prefix` for readability, exactly as the agent
definitions do; add it to every command you run for a repo that resolved one.

### 2. Identity and default branch

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh <repo_root>
```

Under `env_prefix` when this checkout resolved one: the script falls back to `git remote show
origin`, a network call, when the checkout records no `refs/remotes/origin/HEAD`, and a bare call
there resolves the wrong identity and answers a null `default_branch` for a checkout that is fine.
Use `nwo` for everything downstream for this repo. It is parsed from `origin`'s remote URL, which
is now its only source, so there is no directory convention to disagree with it and no tiebreak to
make: being in a checkout is what repo scope means, and the remote is what that checkout is. If
`nwo` is null the repository has no usable `origin`; report that and exclude the checkout, since
every call downstream names the repo. Carry `default_branch` from the same output into dispatch.
If it is null, the script could not resolve origin's default branch; report that and exclude the
checkout rather than guessing a branch name.

### 3. Branch namespace

**Probe this checkout's branch namespace here, once, right after its identity resolves.** Git refs
are a filesystem namespace, so a remote branch literally named `fix` (`refs/heads/fix`) rejects
every `fix/*` push with a `(directory file conflict)` — on the field run that surfaced this, every
agent in the batch finished its whole fix and then failed at push (issue #123). One read-only
probe, under `env_prefix` when this repo has one:

```bash
git -C <repo_root> ls-remote --heads origin refs/heads/fix
```

The fully-qualified refname is load-bearing: git matches the whole ref, not the tail component, so
a repo with `topic/fix` and no bare `fix` returns nothing here (verified empty). Non-empty output
means the slash namespace is blocked: this repo's **branch style is `flat`**, phase 2 passes
`--branch-style flat` to `discover-alerts.sh` so every emitted `branch_name` uses the
collision-safe `fix-dependabot-<pkg>-<line>x` scheme, and the phase 4 plan says so. Empty output is
the ordinary case: the style is `slash` (the default; pass no flag). The verdict is per checkout: a
neighbor whose probe came back empty runs with no flag. A non-zero exit gets **one retry**, exactly
like phase 5's registry probe; a second failure excludes the checkout (no groups exist for it
yet), reported in phase 2 and phase 7 with the probe's stderr verbatim, as with a null
`default_branch` — the
same way phase 5 distinguishes causes by what the output says, rather than a pre-baked "origin
unreachable" diagnosis: auth, a wrong `env_prefix`, and a non-git `repo_root` all fail here too,
not only an unreachable `origin`. A failed probe also prints nothing on stdout; never read a failed
probe's empty stdout as the slash verdict. Record every repo that flipped to flat; phase 7 names
them. The probe covers the shape seen in the wild; the inverse collision (a pre-existing
`fix/dependabot-<pkg>-<line>x/<anything>` branch blocking one group's exact name) is not probed — a
push it rejects fails that one group with the same `(directory file conflict)` rejection, which
that agent reports as its own failure.

EMU orgs stay out of scope (RFC 001 Non-Goals) in the only sense that was ever load-bearing: the
boundary is the ambient credential set a `gh`/`git` invocation resolves, not EMU-ness, and nothing
about it is read off a directory name. A session whose `gh` invocations resolve credentials that can
see an EMU repo (see `env_prefix`, above) reaches that checkout's alerts end to end. What RFC 001
never covered was asking an EMU **org** for its aggregate alert list, and no org-level discovery of
any kind exists here any more, so there is nothing EMU-specific left to detect or special-case.

## Phase 2: Discover and route

Once per checkout phase 1 kept, under that checkout's `env_prefix`:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/discover-alerts.sh <nwo> \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --from-discovery \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/classify-lines.sh --repo-root <repo_root> --base-ref origin/<default_branch>
```

**`<env_prefix>` wraps each of the three commands, not only the first.** A pipeline prefixed once
runs classification bare, and `classify-lines.sh` fetches from `origin`, so its fetch fails under
the wrong identity and the checkout is excluded for a cause that is not true of it. A non-zero
exit from `discover-alerts.sh` or `select-adapter.sh` here excludes the checkout the same way
`classify-lines.sh`'s does below: report the script's `{"error": ...}` line, continue with the
others.

When phase 1's namespace probe found `refs/heads/fix` for this checkout, add `--branch-style flat`
to its `discover-alerts.sh` call, so every `branch_name` the groups carry — and everything
downstream that consumes them, the fix agents included — is born with the flat scheme. The flag
belongs to the checkout whose probe hit, not to the batch.

`--base-ref origin/<default_branch>` uses phase 1's `default_branch` and is not optional here:
it is what pins the classification to the same tree the fix agents will branch from. The script
fetches that branch, reads the lockfile from a short-lived detached worktree at the fetched ref,
and cleans the worktree up itself, so whatever branch the user happens to have checked out — and
whatever uncommitted lockfile edits it carries — cannot silently reclassify a group
(issue #158). A non-zero exit from `classify-lines.sh` here is a stop for this repo, not for the
run: report it as blocked with the script's `{"error": ...}` line, exclude the checkout exactly as
phase 1 excludes one, continue with the others, and never re-run without `--base-ref`, which
would judge the user's checkout and reintroduce the defect the flag exists to close.

Each call returns `actionable` (ranked by severity then EPSS, each group annotated with its
`adapter_path` and its own `repo`) and `skipped` (each with a `reason`). With more than one checkout
in scope, concatenate the per-checkout envelopes into one and re-rank `actionable` by severity,
then EPSS descending, then `repo`, `package` and `major_line` to break ties, so a batch spanning
repos comes out in one stable order. Every group carries its `repo`, so nothing is lost in the
merge and nothing downstream has to remember which call produced it.

A group is **one major line of one package in one repo**, not one package: a package resolved at
several majors at once has a different patched version per line, and one group per line is what
lets each get its own branch, worktree and PR (issue #19). Two groups with the same `package` and
different `major_line`, or the same `package`/`major_line` in different `repo`s, are independent
work, never a duplicate.

If `actionable` is empty, report every skipped group and every excluded checkout, and stop.
Reasons you will see:

- `no fix available` — no patched version published yet
- `open PR exists` — a fix PR is already open (URL in `open_pr_url`)
- `ecosystem not supported yet` — no adapter; see `.github/CONTRIBUTING.md`
- `PR check failed` — the PR lookup itself errored (`error` field)
- `requires major version bump` — every resolved copy of the package sits below the group's fix
  line (`resolved_majors` names what is installed), so the only possible fix crosses a major and
  no override bounded to the resolved line can reach the patched version. Report it with the
  context sentence the annotations carry: "only 0.2.5 is installed; the fix line is 1.x". Human
  work — a major bump of the parent that holds it, or dropping that parent.
- `shared parent across major lines`: the package resolves on more than one major line, the
  sibling lines share a parent (`collision_parents` names them), and the shape is one no override
  key in that repo's syntax can scope apart: Yarn `resolutions` keys cannot carry a parent
  version today (the exact-locator form that could is unimplemented), and under npm and pnpm a
  single copy of the shared parent resolves the package on two majors at once, so every key
  naming it drags a sibling line. Dispatching such groups
  burns a worktree, install and validate cycle apiece before each fails closed on the same fact
  ([#132](https://github.com/SurveyMonkey/skills/issues/132)). Human work: a bump of the shared
  parent, or dropping the dependent that pins it. A shared parent whose copies version-qualified
  keys CAN separate stays actionable; the adapter writes those keys itself.

A group `classify-lines.sh` moves to `skipped` here is withdrawn from the phase 6 queue before the
question is ever asked: it never appears as a row the user can approve, so the user never approves
work that cannot be done. That ordering is the point of resolving every checkout in phase 1: on the
field run behind issue #188 a group was approved and then withdrawn as `requires major version
bump`, because the checkout that could have classified it did not exist until after the approval.

`classify-lines.sh` also annotates each still-actionable group with `resolved_majors` and a
`line_status` (`resolved`, `line_absent`, or `unknown`); all three dispatch normally — `unknown`
deliberately so, since validate fail-closes later and withholding a fixable group is the wrong
direction.

**Report every excluded checkout by name, every time phase 1 or this phase excluded one**, whether
or not `actionable` is empty, with its reason: no usable `origin`, no resolvable default branch, a
namespace probe that failed twice, or a `discover-alerts.sh`, `select-adapter.sh` or
`classify-lines.sh` failure. A checkout silently left out
of the batch is exactly the failure mode RFC 001's "it must never be silent" requirement exists to
prevent, and the requirement outlives the API-side filtering it was written for.

## Phase 3: Ask how much to fix

Present the ranked table:

> | # | Repo | Package | Line | Severity | EPSS | Alerts | Relationship |
> |---|---|---|---|---|---|---|---|

Omit the `Repo` column when one checkout is in scope — every row shares the same repo, and a
constant column is noise. Include it always when more than one is, for the same reason `Line` is
always shown: hiding a dimension that can differ between rows is how a collapsed report reads as
normal.

`Line` is the group's `major_line` (`6.x`, `7.x`). Show it always, not only when a package has
more than one: a row that says `undici 6.x` and another that says `undici 7.x` is the difference
between two fixes and one, and hiding it is how the collapsed-group bug read as normal.

Note skipped groups and excluded checkouts briefly. A `requires major version bump` group appears
among those skip notes with its `resolved_majors` context ("only 0.2.5 is installed; the fix line is
1.x"), never as a rankable row: it was moved to `skipped` in phase 2, and offering it for approval
is asking the user to approve doomed work (issue #101). Every group in the table is already
classified against its own checkout, so nothing offered here is withdrawn later. Then
AskUserQuestion with three options:

- **One** — fix only the top-ranked group (one line of one package in one repo, not every line or
  every repo).
- **Highest tier** — fix every group at the highest severity present (if no critical alerts
  exist, that means all high; if none, all medium, and so on), across every repo in scope.
- **Everything** — fix all actionable groups, across every repo in scope.

## Phase 4: Present the dispatch plan and get one approval

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-capacity.sh
```

`cap` bounds how many subagents run at once; it is machine load, not a harness limit, and it
applies **machine-wide across every repo in the batch**, not per repo — agents that touch three
repos at once still saturate the same laptop. Show the plan for the chosen batch:

> | Repo | Package | Line | Severity | Likely action | Branch |
>
> N group(s) across M repo(s), concurrency cap C.

Omit the `Repo` column when one checkout is in scope, as in phase 3. "Likely action" comes from
the alerts' `relationship` field (direct → version bump, transitive → scoped override) and is
best-effort: the subagent's own `why` classification is authoritative. An agent can also come back
with `action: "lockfile-refresh"` — its control install alone resolved the fix, because the
manifest already admitted the fixed version and only the stale lockfile pinned the vulnerable one —
which no prediction here anticipates. `Branch` shows each group's `branch_name`, and it is final:
phase 1's namespace probe already ran for every checkout, so name each repo whose batch runs flat,
if any, rather than leaving the user to notice the different spelling in the PRs.

Ask for **one** approval of the whole batch. This is **the last checkpoint before pull requests
exist**: subagents run unattended from here through PR creation, and no phase after this one asks
the user to approve anything about a PR. Nothing dispatches without it.

**That one approval covers the workflow launch and every agent inside it.** Phase 6 dispatches the
batch by running one Workflow script, and once it is launched **nothing inside it prompts** — no
per-group checkpoint, no confirmation as one agent finishes and the next starts. Say so here, so
the user approving the batch knows that approving it is approving every group in it. A group
withdrawn later never needed re-approval either, and no group is ever added to the batch after
this point.

## Phase 5: Prepare each repo for dispatch

**Once per distinct repo in the approved batch, before the first agent for that repo is
dispatched:**

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/ensure-worktree-exclude.sh <repo_root>
```

This writes the `.claude/worktrees/` line into that repo's `.git/info/exclude`, keeping the agents'
worktrees out of `git status`. It is local-only and never committed, it is idempotent, and it is
**yours to do, not the agents'**: two agents working the same repo start milliseconds apart, and a
read-then-append from each can duplicate the line or tear the file (issue #35). You know the repo
set, so one call per repo removes the race by construction. A failure here is not fatal — report it
and dispatch anyway; the worst case is worktree directories showing up in `git status`.

**Carry that repo's `env_prefix` into this phase and the next.** It was resolved in phase 1, once
per checkout, never here: by the time anything dispatches, every one of your own commands for the
repo has already been running under it. This phase and phase 6 only apply it — to the adapter's
`detect` and the registry preflight next, and to every group dispatched for the repo — and omit
the field from the dispatches of a repo that resolved none.

**Probe that repo's registry, once, before its first dispatch.** The field run this contract comes
from began with a dead private-registry token: all 33 agents would have failed at install, one at a
time, each burning a slot before reporting a confusing failure. Resolve the package manager the
same way `classify-lines.sh` and the fix agent do — `cd <repo_root> && <env_prefix>
<adapter_path> detect` gives `pm` and `pm_exec`, and it takes the same `cd` and the same prefix as
the probe below because it reads the lockfile from the current directory and resolves `pm_exec`
from the `PATH` the prefix arranges; a non-zero exit there excludes every one of that repo's
groups exactly as a failed probe does below, with the script's `{"error": ...}` line — and run one
read-only probe from inside `repo_root`, under `env_prefix` when this repo has one (bare when
not). The `cd` is
load-bearing and `env_prefix` cannot replace it: the prefix injects environment without changing
directory, so a probe without the `cd` runs in your working directory, resolves the wrong
`.npmrc`/`.yarnrc.yml`, and lets a dead private-registry token probe green against the public
registry — the exact failure this preflight exists to catch;
yarn berry additionally errors outside a project, which would exclude every berry repo. Probe a
**scoped** dependency from the repo's own manifest when one exists — scoped packages are where
private registries live — falling back to the top-ranked queued group's `package` for this repo
when the manifest declares no scoped dependency:

- pnpm: `cd <repo_root> && <env_prefix> <pm_exec> view <package> version`
- npm: `cd <repo_root> && <env_prefix> <pm_exec> view <package> version`
- yarn (berry): `cd <repo_root> && <env_prefix> <pm_exec> npm info <package> --fields version`

This is modeled on how phase 1 resolves `default_branch` up front and excludes a checkout on a null
rather than letting every downstream dispatch discover the same failure independently.
A non-zero exit gets **one retry** before it means anything — registries flake, and a transient
blip must not cost a repo its whole batch. A second failure is the signal: report one actionable
message naming the repo and distinguishing the cause by what the output says — an auth failure
(401 or 403) means dead registry credentials, and that is the one case where the remedy is
running your login flow for that registry; a 404 means the probe package is not in the registry
the probe reached, which is a routing or scope-mapping question, not an auth one; anything else
(timeout, DNS, connection reset) is network trouble. Exclude every one of that repo's groups from
phase 6's queue, and report them in phase 7 alongside the run's other skipped work, noting that
the failure may be transient and that re-running the skill re-probes. There is no proceed-anyway
machinery here: a user who wants to dispatch past a failed probe says so in conversation, the
same footing as the audit command's open-PR preflight. **One probe per repo, not per group** — the probe package, scoped dependency or
fallback, stands in for that repo's
registry reachability as a whole; a second dead package in the same repo is the same root cause; a
green probe does not shield an actual `install` inside a fix agent from failing on that group's
package specifically, but a probe failing here is worth stopping 30+ downstream failures for one
report.

## Phase 6: Dispatch the fix workflow

### The dispatch workflow

**Dispatch is one Workflow call, not a schedule you keep by hand.** The bookkeeping a rolling pool
needs — how many agents are in flight, which slot just freed, never overshooting the cap on a stale
count — is exactly what the harness does deterministically, and re-deriving it in prose costs
tokens on every run to arrive at a worse answer. Dispatch every approved group across every repo,
in the ranked order phases 3 and 4 settled, in one call.

**Pass `args` as an actual JSON value, never as a JSON-encoded string.** A stringified `args`
arrives as one string, `args.dispatches` is then `undefined`, and the guard at the top of the
script rejects it. That guard exists because every one of these mistakes is otherwise silent: a
missing `cap` makes the worker count `NaN`, `Array.from({length: NaN})` empty, and `parallel([])`
return at once with every entry still `null` — which phase 7 would faithfully report as a whole
batch of crashed agents when nothing was ever dispatched. Fail loudly, fix the `args`, relaunch.

Each payload is the group JSON verbatim under `group`, plus `adapter_path`, the group's own `nwo`
(its `repo` field), `default_branch` and `repo_root` for that group's repo (phase 1's facts for
that checkout), `scripts_dir`
(`${CLAUDE_PLUGIN_ROOT}/scripts/common`), and that repo's `env_prefix` when it resolved one (phase 1,
once per checkout; OPTIONAL — **omit the key rather than send null**).

The script is thin on purpose: it dispatches and it validates, and nothing else. The reap below and
the phase 7 summary stay outside it.

**The Workflow tool only accepts a `scriptPath` it can already read** — a path it returned itself,
or one under the working directory or a directory you have added. This skill always runs with the
working directory set to one of the user's own checkouts (phase 1's scope), which is outside the
plugin tree, so
`${CLAUDE_PLUGIN_ROOT}/workflows/fix-groups.mjs` is refused there even though the file exists and
you can read it directly. Stage a verified copy instead of hand-authoring a substitute:

1. Copy the file byte-for-byte from `${CLAUDE_PLUGIN_ROOT}/workflows/fix-groups.mjs` to a path
   **under the working directory itself** — not the session scratchpad, which is a session-scoped
   path outside the working directory and trips the same refusal. Create a directory for this (for
   example `.gh-security-dispatch/` at the root of the working directory) and stage the copy
   there — a mechanical copy, never retyped or paraphrased.
2. Checksum both the source and the copy and confirm they match before launching anything. A
   mismatch means the copy failed; redo the copy, never patch the copy by hand to make it match.
3. Launch `Workflow` with `scriptPath` pointing at the checksum-verified copy, not the plugin path.
4. Keep the staged copy in place for the life of the run, including any resume — a resume launches
   the same `scriptPath` again, so removing it before the batch is fully done breaks resume. Remove
   the staging directory once phase 7's summary is delivered (or once the user declines to resume
   an interrupted run). If the working directory is itself a git checkout, this directory is
   untracked; delete it rather than leaving it to dirty `git status`.

```
Workflow({
  scriptPath: "<checksum-verified copy of ${CLAUDE_PLUGIN_ROOT}/workflows/fix-groups.mjs, staged under the working directory>",
  args: { cap: <detect-capacity.sh's cap>, dispatches: [<one payload per approved group>] }
})
```

The script is a real file, not something to write out here: it is version-controlled, unit-tested
by `spec/js/`, and its result schema is executed against a validator rather than read
([ADR 010](../../../../docs/adr/010-workflow-scripts-are-files-with-a-js-toolchain.md)). **Never
inline a copy of it, and never hand-edit a variant for one run.** A checksum-verified byte-for-byte
copy staged only so the tool can read it is neither of those — it is the same tested file, proven
identical before launch, never edited. It does exactly two things —
fan one `fix-dependency` agent out per group under the cap, and validate each result against the
Result contract in `agents/fix-dependency.md`. Everything else on this page is yours.

What it guarantees, so nothing here re-derives it:

- **`min(cap, N)` workers hold the pool**, so it cannot exceed `cap` and no count of yours has to
  track it. One workflow covers the whole batch — never one per repo — which is what keeps the cap
  machine-wide.
- **Malformed `args` is refused loudly**, before a single agent is dispatched: a `dispatches` that
  is absent, not an array, or empty, and a `cap` that is not a number of at least one.
- **Each agent runs as `fix-dependency` on `sonnet`** (ADR 004's pin, passed explicitly because a
  workflow agent call without it inherits the session model) with the Result schema attached.
- **Entries come back in dispatch order**, one per group, each carrying its own `dispatch` payload
  beside its `result`.
- **A result that does not name its own dispatch is dropped, not trusted** (`mispaired: true`,
  `result: null`).

**The workflow can also throw, be cancelled, or return short — and that must never lose a group.**
Under the old rolling pool each completion arrived on its own, so an abort still left every result
already in hand. A single call loses them all at once, and the agents that ran had already made
worktrees, pushed branches and opened pull requests. So when the call errors, the user interrupts
it, or it returns fewer entries than `dispatches`:

- **Never read an absent or short return as "nothing ran."** It is the opposite: work you cannot
  see is exactly what is at risk of being abandoned.
- **Recover what did run before deciding anything.** The tool result carries a `runId` and a
  transcript directory; `<transcriptDir>/journal.jsonl` records each agent's actual return value.
  Read it to learn which groups completed and what they returned, rather than assuming.
- **Resume rather than re-dispatch.** Relaunch with `{scriptPath, resumeFromRunId: <runId>}`, the
  same staged copy's path and the same `args` in the same order: the unchanged prefix of `agent()` calls
  returns its cached results instantly and only the unfinished work runs live. Re-launching without
  `resumeFromRunId` re-runs every group, which is how a second branch and a second PR appear for
  work that already succeeded. Resuming the batch the user approved is not a new dispatch
  decision — but **a run the user deliberately interrupted is**, so there, ask first.
- **Do not trust a resumed run's pairing on position.** The pool's workers steal from a shared
  cursor, so which agent call happens third is decided by which agent finished first, and no
  bounded pool can make that order repeat — only serial dispatch could, which is the cap's whole
  purpose. So the script does not rely on it: it checks each result against its own dispatch and
  sets `mispaired: true` when they disagree. **Treat a `mispaired` entry exactly like a `null`
  one** — reap it from the dispatch payload with an empty result file, report the group as unknown,
  and never read its `pr_url` or `branch`, which belong to a different group. It is also a
  skill-defect report under phase 7's own rule: the evidence indicts this skill's harness, not the
  target repository.
- **When resume is impossible or declined, reap the whole `dispatches` list anyway**, one
  `post-agent.sh` call per group, with an empty result file for every group that has no entry.
  That is what finds and names each worktree and branch the interrupted run left behind; skipping
  it is the only way a group actually disappears.
- **Phase 7 then reports every group in `dispatches`**, says plainly that the run was interrupted
  and at which point, and names the groups with no result at all as unknown rather than as
  failures — they may have opened a pull request that nothing here read.

**`schema` replaces the old "an unparseable result block is a failure report" rule.** The agent is
forced through structured output and retried on a mismatch, so nothing here re-parses a fence. Be
precise about what that buys: the schema validates **the field set, the four enumerations, the
nullability of each field, the element shape of `observations[]` and `requires_major_bump[]`, and
the Result contract's cross-field rules** — exactly one of `no_op`/`failure` non-null with both
null on success, each agreeing with `status`, and `bare_override` agreeing with `action`. It does
not and cannot check that a `pr_url` names a real pull request, that `risk` is the scorer's own
output rather than a number the agent invented, or that a `no_op`'s evidence supports its reason.
Those stay what they always were: `post-agent.sh` verifies the pull request, and the rest is the
agent's contract to keep. **A group whose entry comes back `null` — the schema could not be satisfied
after retries, or the agent died — is a failure report for that group, and is still reported.** Its
`dispatch` entry is right there beside it, carrying `package`, `major_line`, `branch_name` and
`repo_root`, which is everything the reap and phase 7 need; run the reap below for it exactly as for
any other entry, with an empty result file, and `post-agent.sh` reports it `missing`, reaps nothing,
and names the worktree and branch it left. A null entry is never dropped, never retried by hand, and
never counted as a success, and neither is a `mispaired` one.

**Nothing inside the workflow prompts.** Phase 4's single approval covers the launch and every
agent the script dispatches; there is no per-group checkpoint, and it remains the last checkpoint
before pull requests exist.

**Reap each group's local artifacts once its result is in hand**, after the pull request is verified
and before that result is folded into phase 7 — **one `post-agent.sh` call per returned entry, never
one per repo and never one for the batch**. One call replaces the whole procedure — save that
entry's `result` object to a file as JSON (an empty file when it is `null`), then:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/post-agent.sh --result <path to the saved result> \
  --repo-root <repo_root> [--env-prefix "<env_prefix>"] \
  --package <group.package> --major-line <group.major_line> --branch <group.branch_name>
```

Pass that group's own `package`, `major_line`, and `branch_name` from its dispatch payload every
time, not only when you expect to need them: they are the only source of those facts when the
agent's result block cannot supply them — unparseable, missing, or a crash before it printed one —
and passing them unconditionally means this call never has to guess whether the fallback will be
needed. `env_prefix` goes to the pull-request read the script makes internally, under that repo's
`env_prefix` when it has one, and never to the reap that follows it — the script's own header says
why.

The script parses the result, verifies the pull request, reaps the group's worktree directory and
local branch **only when that PR reads `OPEN`**, and reports what it did on stdout, exit 0,
whatever the outcome. **An agent that ended any other way is never reaped**: a failure result, a
crash, an unparseable or missing result block, a `no-op`, or a PR that is not open all leave the
worktree and the branch in place, and the report names them (`reaped: false`, with `reason` and the
derived `worktree_path`/`branch`) for phase 7 rather than this phase guessing at what survived.
**A non-null `cleanup` on the result never changes whether this call runs.** A `success` whose
`cleanup` reports a leak is still a success with an open pull request, and it is exactly the group
whose leftovers most need collecting — the agent's own cleanup already failed on them. Reaping is
gated on the pull request reading `OPEN`, as above, and on nothing else; a `cleanup == null`
condition added here would skip precisely the runs this second line of defence exists for.

**A failure here is not fatal**: record the report, move to the next entry, and carry on. A reap
that could not finish must never stall the run, and neither does one that printed nothing at all — a
rejected argument or a refused path in the reap it runs internally — which the script turns into a
named `reason` rather than a guessed clean sweep.

Carry the script's report into phase 7 verbatim; it is what phase 7's own paragraph reads from, not
something to rebuild by hand.

Two lines of the same package may be in flight together, whether in the same repo or different
ones: they carry different `branch_name`s and different worktree paths (worktree paths are always
under that group's own `repo_root`), so they cannot collide.

Multiple fix agents dispatched for the same repo share a repository, and **repo-global git state
is shared**, so while any agent is in flight no agent may touch it: no `.git/info/exclude` write
(done once above, before dispatch), no `git worktree prune` — repository-wide, and a badly timed
one deletes a live sibling's registration — no `git gc`, no config writes, no branch or ref
manipulation outside its own branch. Each agent adds and removes its own worktree by path and
nothing else. The agent definition states this as a hard rule; the reason it is written here too
is that the earlier absolute phrasing ("cannot collide") is what invited the two calls issue #35
found. Something is in flight from the workflow's first dispatch until it returns, so this is a rule
for the whole run rather than for a window between dispatches.

## Phase 7: Summarize the run

The workflow returns **one entry per approved group**, in the order they were dispatched, each
carrying its own `dispatch` payload and its schema-validated `result`. Read the summary off those
returned entries; the batch is complete when the workflow returns, so there is nothing to hold or
reconcile as results trickle in. The summary describes the whole approved batch, not a subset —
and when the workflow threw, was cancelled, or returned fewer entries than `dispatches`, phase 6's
interruption contract is what fills the gap: recover from the journal, resume or reap the whole
list anyway, and report every group in `dispatches` either way.
**An entry whose `result` is `null` is a failure report** — record it as such; never guess fields,
and give it the same reap and the same line in the tables as any other entry. Agents are instructed
never to park a turn waiting on a hung verb, so a null entry means the agent crashed or could not
produce a result matching its own schema, not that it needs more time.

Present one table for the run:

> | Repo | Package | Line | PR | Risk | F4/F5 | Notes |

`F4/F5` is `risk.f4` and `risk.f5` from the agent's result, which is the whole of the coverage and
CI signal an agent reports; the scorer's fuller `coverage` and `ci` objects stay in the PR body.

Omit the `Repo` column when one checkout is in scope, as in phases 3 and 4.

**A `no-op` result is neither a success nor a failure, and gets its own line, never the failure
list.** The group's fix was already on the default branch when the agent got there: it made no
commit, opened no PR, and validate confirmed the alerts are cleared by what is installed. Report
those separately, with the agent's `no_op.reason` and the merged PR when it named one:

> Already fixed, nothing to do: `undici` 6.x in `octo/app` — the scoped overrides are already on
> `main` (<PR #597>, merged 2026-08-17), and validate confirms all 8 alerts are cleared by the
> resolved 6.28.0. Dependabot has not re-scanned yet, which is why they still show as open.

The condition is Dependabot re-scan lag, not a bug anywhere: GitHub reports alerts as open for a
window after the fix merges. Folding these into the failure list presents a clean outcome as
needing attention and buries the genuine failures beside it (issue #34).

Failures get their `phase` and `detail`. A result whose `action` is `bare-override` says so in
Notes (`bare override added` or `bare override tightened`, from `bare_override`): it is the one
action whose blast radius reaches past the alerts being fixed, and the table is where a user
comparing PRs will see it. A result whose `action` is `lockfile-refresh` also says so in Notes:
the PR is a no-change lockfile refresh whose only commit is the agent's control-install drift
commit, so its diff carries no manifest edit.

A `phase: "validate"` failure whose `detail` quotes `other_line_moves` means any fatal move: the
install moved a copy of the package on a major line the group does not own, and the agent
fail-closed before opening a PR. Moves classed `benign_dedup` (a within-major dedup onto a version
the line already resolved, on a line validate proved carries no open alerts) are not failures at
all: the agent proceeds, and each is disclosed in the PR body's Collateral section rather than
reported here ([#105](https://github.com/SurveyMonkey/skills/issues/105)).

A `phase: "classify"` failure whose `detail` names `peer_only_dependency` gets its own Notes label
(`peer-only dependency`) rather than the generic `failure: classify`: the package resolves only
through pnpm's peer auto-install, no `pnpm.overrides` key can reach it, and the remedy is a major
bump of one of the peer parents `detail` quotes, or a real dependency declaration. Both are
lockfile regeneration, both human work ([#103](https://github.com/SurveyMonkey/skills/issues/103)).

A `phase: "apply"` failure whose `detail` names the shared-parent shape gets its own Notes label
(`shared parent, no reachable override`) rather than the generic `failure: apply`: the root
manifest's own spec for that parent also admits its copies on other major lines, or a pre-existing
bare override for the package under that parent pins a different line, so the adapter wrote nothing
and no install ran. The remedy is a bump of the shared parent, or reconciling the existing override
by hand, both human work ([#132](https://github.com/SurveyMonkey/skills/issues/132)).

A `phase: "baseline"` failure gets its own Notes label
(`baseline could not be established (ambient, affects every group)`) rather than the generic
`failure: baseline`, whichever of its four shapes `detail` names — the agent's no-change control
install failed, the control install left residual changes outside the lockfile and tracked
install artifacts, a repo hook failed the drift commit, or the lockfile itself could not be
parsed for the snapshot. Each happens before any fix exists, so
the condition is a fact about the repository, not the group, and every group dispatched against
that repo hits the same wall until it is resolved
([#146](https://github.com/SurveyMonkey/skills/issues/146)).

A `phase: "push"` failure whose `detail` names a branch-namespace collision (a `directory file
conflict` push rejection) gets its own Notes label (`branch-namespace collision (preflight
miss)`): phase 1's namespace probe said `slash`, but this group's exact `fix/*`
push still landed on a blocking sibling ref — the inverse collision phase 1 documents as
unprobed. Re-running the skill hits the same wall for this group until the namespace is resolved
on the remote or the whole batch is re-run with the flat style forced
([#123](https://github.com/SurveyMonkey/skills/issues/123)).

**Before anything else in the summary, report every alert that stays open after this batch because
the only possible fix crosses a major** — two different senses of the same name, both belonging
here first because both mean the same thing to the user: a fix that did not happen.

- Post-fix, every non-empty `requires_major_bump[]` an agent's result carries, per package line
  (and per repo when more than one checkout is in scope). This is validate's own
  reconciliation: the group was dispatched and its own line fixed, but the install moved another
  copy of the package across the fix boundary, and validate proved that copy cannot be reached
  from where it landed.

  > Still vulnerable after this batch: `undici` 5.29.0 in `octo/app` (alerts patched only in the
  > 6.x line). No override bounded to 5.x can fix this; it needs a major bump of the parent that
  > pins it, or dropping that parent.

- Pre-dispatch, every group classify-lines.sh moved to `skipped` under `requires major version
  bump`, with its `resolved_majors` context. Phase 2 found it before the question was ever asked,
  and it is still reported here, not just in phase 3's skip note, so it does not vanish once the
  batch runs. It never reached a fix agent: no override at the resolved line could ever land the
  patched version, so there is nothing for validate to reconcile.

Reporting a batch as done without either kind is the failure mode issue #19 is about, and it is
worse coming from the summary than from an agent.

**Then re-report every checkout phase 1 or phase 2 excluded, by name, and every repo phase 5's
registry preflight excluded.** These are repos with alerts the batch never touched at all, and
belong in the same summary as the batch that did run — never a detail left only in the earlier
discovery report. A registry-preflight exclusion names the probe package, the diagnosed cause
(auth, not-found, or network), that the failure may be transient, and that re-running the skill
re-probes. A checkout the branch-namespace probe excluded (phase 1: `ls-remote` failed twice;
report the probe's stderr, not a guessed cause) is reported the same way, as is one with no usable
`origin`, no resolvable default branch, a failed `discover-alerts.sh`, `select-adapter.sh` or
`classify-lines.sh` run, or a failed adapter `detect` in phase 5. And **name every repo whose
batch ran under the flat branch scheme**, with the reason: a remote branch named `fix` occupies
the `fix/*` ref namespace, so that repo's PRs came from `fix-dependabot-...` branches — the user
reading branch names in the PRs should not have to
guess why they differ from a neighbor repo's.

**Then report every group classify-lines.sh skipped under `shared parent across major lines`,
with its `collision_parents`.** These alerts also stay open: the group's line shares a parent
with a sibling line in a shape no override key in that repo's syntax can scope apart, so that
group was never dispatched. The verdict is per group, so a line of the same package whose
parents are disjoint may still have run normally
([#132](https://github.com/SurveyMonkey/skills/issues/132)). The remedy is human work: bumping
the shared parent past the old line, or dropping the dependent that pins it. Like the
requires-major-bump skips, these are phase 2 findings that belong in this summary too, not only in
phase 3's skip note.

**Then say what phase 6's reap removed and what it left, from `post-agent.sh`'s own reports —
never rebuilt by hand.** Key what stayed on the user's disk on each report's `left_behind`, never on
`reaped` or `errors` alone: `reaped: true` means the reap ran to completion, not that it removed
everything, and a deliberate leave — a local branch whose tip is not on origin — reports a leftover
in `left_behind` with no `errors` entry at all (the underlying reap's own `tip-not-on-origin` case). So give the count of groups whose `left_behind` came back empty — a genuinely clean sweep —
rather than the count that merely read `reaped: true`, and name every artifact any other report's
`left_behind` still carries: a reap that ran and left something behind, and a group that never
attempted a reap at all — a failure, a crash, a `null` entry from the workflow, a `no-op`, a
PR that is not open, or a reap that printed nothing. Every one of those reports already carries the
derived `worktree_path` and `branch`, and the `reason` it was not reaped when it was not; nothing
here recomputes a path or a branch name from a template. A leftover under `.claude/worktrees/` sits
at a stable path and comes off by hand with `git -C <repo_root> worktree remove --force <path>` once
no agent is in flight, but only if this summary says it is there. Nothing left behind is a failure
on its own; a run that left nothing behind anywhere says so in one line.

**And report every non-null `cleanup` on a result, in the same breath.** The fix driver's own
cleanup runs *after* the commit, push and PR creation, so it can fail over completed work: a
result carrying a `cleanup` report left a worktree, a work directory or a branch behind inside the
agent, whatever its `status` says. **A `success` with a non-null `cleanup` is the case to say out
loud** — the pull request is real and open, and a worktree leaked anyway. Report it as a shipped
PR with a leaked artifact, never as a failed group, and never let the leak go unmentioned because
the group otherwise succeeded.

These are two views of the same disk, not two lists to print twice. The agent's `cleanup` is what
the agent's *own* cleanup could not remove; `post-agent.sh`'s `left_behind` is what the
orchestrator's reap found still there afterwards, and on a `success` it runs after the agent has
already tried. So **key the report on `left_behind`, as above, and use `cleanup` to explain it and
to catch what `left_behind` cannot see**: a path the reap was never asked about, and the driver's
own `errors[]` and `detail`, which say why the removal failed. Where both name the same path, say
it once, with the reason from `cleanup`. Where `cleanup` is non-null and `left_behind` came back
empty, the reap cleared what the agent could not — say that too, in a clause, because it is the
one case where a leak resolved itself.

**"The same path" is not the same string.** `cleanup`'s `worktree.path` and `work_dir.path` are
the paths the driver **resolved** and acted on, while `post-agent.sh` derives its own from
`<repo_root>/.claude/worktrees/fix-dependabot-<package_path>-<major_line>x` and never resolves it.
On macOS the same directory is `/private/var/...` in one and `/var/...` in the other, so comparing
them as text reports one leaked worktree as two. **Match on suffix, or resolve both before
comparing**, and when they agree report a single artifact — the resolved path is the one to show
the user, since it is what a `git worktree remove` will act on. Two paths that genuinely differ
after that are two artifacts and both get named.

Then aggregate `observations[]` across **all** results, deduplicate identical entries, and split
them by `type`, because the two are not the same news.

`unscoped_override_added` entries are global pins **this batch just created** (the agent's
`bare_override` is `added` and its `action` is `bare-override`). Report them individually, with
the reason the agent gave, the repo, and the PR that introduced them:

> This batch added 1 unscoped global override: `sharp` `>=0.35.0 <1` in `octo/app` <PR>, because
> <reason>. It pins `sharp` for every consumer in that repository, including copies that were
> never vulnerable.

`unscoped_override` entries are pre-existing, and stay one aggregate line per repo:

> Note: `octo/app` contains N unscoped global override(s): `<keys>`. These may be removable or
> convertible to scoped pins. `/gh-security:audit-pins` tests removability
> ([#7](https://github.com/SurveyMonkey/skills/issues/7)).

Leads, not findings. Do not act on either. Without deduplication a five-package dispatch would
report the same pre-existing bare overrides five times. Never fold a newly added pin into that
count and call it pre-existing debt: this batch is the record of where it came from.

### Filing a skill-defect report

**When this run's own evidence shows the skill itself misbehaved, file that as a defect against
this repository, not against the target.** The signal is a fail-close, a written key, or a probe
result that the run's own evidence contradicts: a false `baseline` or `validate` fail-close against
a payload that plainly should have passed, an adapter writing an override key the install then
proved ineffective, a namespace or registry probe reading the wrong verdict, or an agent visibly
working around its own tooling rather than through it. This is a narrower claim than "something
went wrong": a target repo's own defect — a stale lockfile, a dead registry token, a blocked branch
namespace — is never filed here, and is reported to the user only, exactly as the phases above
already do (`baseline` failures, registry-preflight exclusions, branch-namespace collisions). The
test is whether the evidence indicts the skill's logic or the repo's state; when in doubt, the
absence of a plausible repo-side explanation is what tips it toward the skill.

**Check this repository for an existing issue before drafting a new one.**

```bash
gh issue list --repo SurveyMonkey/skills --search "<distinguishing terms>" --state all
```

`--state all` matters because a fixed-and-closed defect is still a hit: the right response to
finding one is "the plugin needs updating again," not "no duplicate, file a new one."

A hit means a second independent field sighting is confirmation, not noise: comment the new run's
specifics onto it rather than opening a duplicate, the same way `unscoped_override` entries stay
one line per repo instead of five. No hit means draft a new issue.

**This search is also the reachability probe for the identity question below.** There is no
separate mechanism: running it under whatever identity this phase currently holds and watching
whether it succeeds is the check. An auth error here (not a "no results" empty list) is the signal
that this run's credentials cannot reach this repository at all, and that the identity paragraph
below applies before drafting or filing anything.

**The report carries the run's own concrete evidence**: the failing payload verbatim (an
`other_line_moves` JSON blob, a `resolved_majors` array, whatever the agent's result block or a
probe actually printed), the shapes involved, and what distinguishes a skill defect from the target
repo's own reality — the same distinction the paragraph above draws, made explicit for the reader
of the issue.

**Scrub the report exactly as this repository scrubs everything else.** Never name the target
repository, its owner or org, or its internal directory topology: write "a field run" or "the field
repository," never the real slug, and cite only public package names. This is not a different rule
for issue reports — it is the same rule fixtures, specs, and this file's own prose already follow.

**Consent gates filing, the same way it gates every action here.** Propose the drafted title and
body and file only on the user's go-ahead, unless the user pre-authorized filing defect reports
automatically earlier in this session — in that case file without asking again. Either way, the
closing report in phase 8 states what was filed (or proposed), with the issue number or URL once it
exists.

**The identity that files the report is resolved separately from the identity that ran the batch,
and is never assumed to be the same.** The credentials this run resolved for the target repo (via
`env_prefix`, or the ambient login) may belong to an account barred from contributing to outside
repositories — an Enterprise Managed User is the canonical case: it can push the fix branches and
open PRs on the target, but cannot open an issue here. So:

- Never file the report under the batch's own credentials without checking whether they can reach
  this repository at all.
- When the environment makes another, capable account discoverable — per-directory credential
  switching, or a second `gh` config or wrapper the session context documents for this repository —
  use it for the report, under the same consent that covers the report itself. This is the same
  `env_prefix` seam phase 1 resolves, read for a different directory: a rule stating a wrapper
  command for `SurveyMonkey/skills` is exactly the statement phase 1 already looks for, and using it
  here is not inventing anything. A bare `cd` into that directory is never the mechanism — the
  failure class phase 1 documents (:96-100) is precisely that per-directory identity tools load
  through interactive shell hooks a non-interactive tool shell never runs, so a bare `cd` followed by
  a bare `gh issue` command silently resolves whatever account was already ambient, not the
  directory's intended one. Switching identities is never invented silently; it is only ever an
  account the environment already documents a seam for.
- When no capable account resolves, the report does not vanish: hand the drafted title and body to
  the user in the closing summary, so they can file it from wherever they can.

## Phase 8: Offer the groups the user declined

If actionable groups remain because the user chose One or a tier, those groups were never approved
and never queued: the approved batch drained completely. Offer them now as a **new scope
question**, not as a resumption of work already approved: back to phase 3 with the remaining
groups.

Otherwise report done, including every checkout phase 1 or phase 2 excluded, every repo phase 5's
registry preflight excluded, and what would unblock each.

**When Filing a skill-defect report applied this run, the closing report carries its outcome too**,
exactly as that section promises: the filed or proposed issue's number or URL when one exists, or,
when no capable account resolved, the drafted title and body verbatim so the user can file it from
wherever they can.

**The closing report also points at the pin audit as separate follow-up work**, run via
`/gh-security:audit-pins` once this batch's fix PRs have landed. This skill does not run it and
does not offer it: the audit removes entries from the same overrides block these fixes just added
to or tightened, each on its own branch against the same base, and running both together is exactly
the conflict issue #108 documents (the field test's audit PR). Merge or close the
fix PRs from this run first.

**The closing report lists every PR this run opened, once, as information.** Read the current
state of them together:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/pr-status.sh <pr-url>...
```

Pass every `success` PR URL; `no-op` and `failure` results carry a null `pr_url` and there is
nothing to read. The script operates on PR URLs directly and needs no `repo_root`, but it reads
each PR under whatever identity the shell resolves, and two checkouts can carry different
`env_prefix`es. So **group the URLs by repo and make one call per repo, under that repo's
`env_prefix`** (bare when it resolved none); with one checkout in scope that is one call.

Report each PR with its URL, its merge-risk band, and its check state — and **state what that
check state is worth**, because most of these PRs are minutes old:

- `none` means no check has reported yet, which on a repository with CI usually means the
  workflows have not started, not that there are none.
- `pending` cites `check_counts` ("3 of 5 finished").
- `passed` on a very fresh PR, or on one reporting materially fewer checks than its siblings, is
  provisional: rollups populate as workflows spawn, and a job that has not been reported yet is
  invisible. Absent is not pending. Do not present the set as CI-complete.
- `failed` names `failing_checks`. This is the one worth saying loudly, since it tells the user
  which PR to open first.
- `merge_state: UNKNOWN` means GitHub has not computed mergeability yet, which is ordinary right
  after a push. Say so rather than reading it as clean or behind.
- `behind: true` or `conflict: true` means GitHub has computed mergeability and the PR needs a
  rebase or has a conflicting change. Report either when true. Both are derived from
  `merge_state`, so on a PR created moments ago they are `false` because nothing was computed
  yet — `false` here is "not established", not "clean", and must not be reported as clean.
- `is_draft: true` likewise means a human converted it, since these open ready.
- **Non-zero exit still carries a full report.** `pr-status.sh` reports and fails, like the
  adapter's `validate`: if one URL could not be read, the other entries are still present and
  correct. Read the report, name the entries carrying `error`, and do not discard the batch.

**When this batch opened more than one PR against the same repo, say so, unconditionally.** Name
them together and state plainly that they edit the same overrides block, so merging one leaves the
rest behind and the second to merge may conflict. You know this from the dispatch plan, not from
any check: `behind` and `conflict` are almost always unset this early (above), so waiting to
observe the collision means never reporting it. GitHub's "Update branch" resolves the ordinary
case; a conflicted machine-generated fix is better regenerated than hand-resolved — close it and
re-run this skill for that package.

**This is a report, not a prompt, for what this run did to pull requests.** Do not ask whether to
mark anything ready, merge anything, arm auto-merge, or re-check later: there is nothing left for
this skill to do to a PR that exists (ADR 008). Point the user at the URLs and stop. This
prohibition is scoped to PR actions; it does not withdraw phase 7's defect-report offer, which is
consent for a different action entirely — filing or commenting on an issue in this repository, never
a target repo's pull request.
