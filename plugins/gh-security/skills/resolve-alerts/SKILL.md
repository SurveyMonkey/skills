---
name: resolve-alerts
description: >
  Resolve Dependabot security alerts for the current repository, or across an
  entire org or the user's own repos. Discovers open alerts, ranks them by
  severity and EPSS exploitability, and fixes one package, the highest
  severity tier, or everything — one subagent per group (one major line of
  one package, in one repo) in an isolated worktree through to a pull request,
  open for review, carrying a computed merge-risk rating. Use when asked to fix security
  vulnerabilities in dependencies, resolve Dependabot alerts across a repo,
  org, or the user's own repos, or clean up npm audit findings.
allowed-tools: Bash(*detect-scope.sh*), Bash(*discover-alerts.sh*), Bash(*select-adapter.sh*), Bash(*classify-lines.sh*), Bash(*detect-capacity.sh*), Bash(*pr-status.sh*), Bash(*ensure-worktree-exclude.sh*), Bash(*post-agent.sh*), Bash(*node.sh detect*), Bash(*pnpm view *), Bash(*npm view *), Bash(*yarn npm info *), Bash(*gh repo clone*), Bash(*git -C * fetch*), Bash(mktemp -d -t gh-security-clones*), Bash(rm -rf *gh-security-clones*), Bash(*gh issue list*), Bash(*gh issue create*), Bash(*gh issue comment*), Read, Workflow, AskUserQuestion
---

Orchestrate the resolution of Dependabot security alerts, at repo, org, or user scope: discover
and rank, ask how much to fix, dispatch one `fix-dependency` subagent per group (one major line of
one package, in one repo) in parallel, and report the pull requests they open.

The deterministic work lives in scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/common/`. Call them;
do not reimplement them. Every script emits JSON on stdout and exits non-zero with an `error` key
on failure; if one fails, report its error and stop.

You are the control point the user approves. Subagents run unattended through PR creation, so
**nothing dispatches before the user approves the plan in phase 4**, and that approval is the
whole of it: PRs open **ready for review** and **nothing here acts on a pull request after it is
created** (ADR 008). The decision to merge one is the reviewer's, on GitHub, with the diff in
front of them.

## Phase 1: Detect scope

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh
```

**Scope comes from git, never from what the directories are named** (issue #134). `scope` is
`repo` when the working directory is inside a git repository and `null` when it is not, and the
script infers nothing from a path segment.

- **repo scope**: use `nwo` for everything downstream. It is parsed from `origin`'s remote URL,
  which is now its only source, so there is no directory convention to disagree with it and no
  tiebreak to make: being in a checkout is what repo scope means, and the remote is what that
  checkout is. If `nwo` is null the repository has no usable `origin`; report that and stop, since
  every call downstream names the repo. Carry `default_branch` from the same output into dispatch.
  If it is null, the script could not resolve origin's default branch; report that and stop.
- **null scope**: the working directory is in no repository, so there is nothing to detect and
  nothing to guess. **Ask what to operate on**, with AskUserQuestion in the phase 3 style, and say
  first that no repository was found at the current path. Three options:
  - **This org** — org scope; the user names the org, which becomes `owner`.
  - **My repos** — user scope, the authenticated user's own repositories. `discover-alerts.sh
    --scope user` always operates on those regardless of what `owner` resolves to, so nothing here
    needs the login resolved.
  - **One repo** — repo scope against a repo the user names as `owner/name`, which becomes `nwo`.

  Whatever the answer, `nwo`, `repo_root` and `default_branch` for each repo are resolved in phase
  5, once discovery says which repos are actually in play and a local checkout exists to read them
  from.

**At repo scope detected from a local checkout, resolve `env_prefix` here, before anything else
talks to the repo.** `env_prefix` is **a command prefix the environment requires for repo-targeted
commands** — nothing more is known or assumed about it here. It is optional, it is opaque, and it
is never derived: **take it from your session context.** When the CLAUDE.md or rules covering this
repo's directory state that commands in that tree need a prefix, that stated prefix is this repo's
`env_prefix`, used verbatim. When no such context exists — the ordinary single-login case — the
repo has none and every command for it runs bare, with no wrapping invented here.

**Any context that names a wrapper command for tools run in a directory tree is such a statement**,
however it is phrased. It does not have to use the word `env_prefix`, name this plugin, or mention
security work: a rule saying that commands in some tree must be run through a wrapper is stating
this repo's `env_prefix` whenever the repo sits in that tree. Where the stated prefix takes a
directory, instantiate it against this repo's directory, which already exists at repo scope.
Recognizing one is your job and missing one is silent, which is what the failure class below
describes.

The failure class the seam guards against is real and manager-agnostic: where `gh`, `git`, and the
package manager get their identity per directory rather than from a single ambient login, the tools
that arrange that load through interactive shell hooks that a non-interactive tool shell never
runs, so a bare `gh`, `git`, or install silently resolves the wrong identity or a dead registry
token. **The prefix covers your own commands, not just the agents'**: from here on, every `gh`,
`git`, and plugin-script invocation you make for this repo — `discover-alerts.sh` and
`classify-lines.sh` in phase 2, `detect-scope.sh` when re-run, `post-agent.sh` in phase 6's reap
step (which threads it to its own `pr-status.sh` call and never to the reap it runs after) and
`pr-status.sh` again in phase 8 — runs under it, or discovery itself reads the wrong account's alerts
before any dispatch exists. Note
that `<env_prefix> <cmd>` runs `<cmd>` in the caller's current directory — it injects the
environment, it does not chdir — so it composes with, never replaces, whatever `cd` or `-C`
locator a command already carries. Wherever there is no `repo_root` yet — org and user scope, and
a repo the user named when the scope came back null — resolution happens per repo in phase 5.
The command snippets in the phases below omit `env_prefix` for readability, exactly as the agent
definitions do; add it to every command you run for a repo that resolved one.

**At repo scope detected from a local checkout, probe the branch namespace here, once, right after
`env_prefix` resolves.** Git refs are a filesystem namespace, so a remote branch literally named
`fix` (`refs/heads/fix`) rejects every `fix/*` push with a `(directory file conflict)` — on the
field run that surfaced this, every agent in the batch finished its whole fix and then failed at
push (issue #123). One read-only probe, under `env_prefix` when this repo has one:

```bash
git -C <repo_root> ls-remote --heads origin refs/heads/fix
```

The fully-qualified refname is load-bearing: git matches the whole ref, not the tail component, so
a repo with `topic/fix` and no bare `fix` returns nothing here (verified empty). Non-empty output
means the slash namespace is blocked: this repo's **branch style is `flat`**, phase 2 passes
`--branch-style flat` to `discover-alerts.sh` so every emitted `branch_name` uses the
collision-safe `fix-dependabot-<pkg>-<line>x` scheme, and the phase 4 plan says so. Empty output is
the ordinary case: the style is `slash` (the default; pass no flag). A non-zero exit gets **one
retry**, exactly like phase 6's registry probe; a second failure means report the probe's stderr
verbatim and stop, as with a null `default_branch` — the same way phase 6 distinguishes causes by
what the output says, rather than a pre-baked "origin unreachable" diagnosis: auth, a wrong
`env_prefix`, and a non-git `repo_root` all fail here too, not only an unreachable `origin`. A
failed probe also prints nothing on stdout; never read a failed probe's empty stdout as the slash
verdict. The probe covers the shape seen in the wild; the
inverse collision (a pre-existing `fix/dependabot-<pkg>-<line>x/<anything>` branch blocking one
group's exact name) is not probed — a push it rejects fails that one group with the same
`(directory file conflict)` rejection, which that agent reports as its own failure.

EMU orgs are out of scope (RFC 001 Non-Goals): this skill does not detect or special-case
org-scope discovery against one. That is a narrower claim than it once was — the boundary is the
ambient credential set a `gh`/`git` invocation resolves, not EMU-ness, and nothing about it is
read off a directory name now that scope comes from git. A session whose `gh` invocations resolve
credentials that can see an EMU repo (see `env_prefix`, above) reaches that repo's alerts end to
end at **repo** scope; what stays out of scope is asking an EMU **org** for its aggregate alert
list, which RFC 001 never covers.

## Phase 2: Discover and route

At repo scope, when phase 1 detected it from a local checkout:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/discover-alerts.sh --scope <scope> <target> \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --from-discovery \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/classify-lines.sh --repo-root <repo_root> --base-ref origin/<default_branch>
```

When phase 1's namespace probe found `refs/heads/fix`, add `--branch-style flat` to the
`discover-alerts.sh` call, so every `branch_name` the groups carry — and everything downstream
that consumes them, the fix agents included — is born with the flat scheme. At org and user scope
no probe has run yet (there is no checkout), so discovery takes no style flag there; the per-repo
rewrite happens in phase 5.

`--base-ref origin/<default_branch>` uses phase 1's `default_branch` and is not optional here:
it is what pins the classification to the same tree the fix agents will branch from. The script
fetches that branch, reads the lockfile from a short-lived detached worktree at the fetched ref,
and cleans the worktree up itself, so whatever branch the user happens to have checked out — and
whatever uncommitted lockfile edits it carries — cannot silently reclassify a group
(issue #158). A non-zero exit from `classify-lines.sh` here is a stop for this repo: report it as
blocked with the script's `{"error": ...}` line, and never re-run without `--base-ref`, which
would judge the user's checkout and reintroduce the defect the flag exists to close.

Wherever there is no local checkout yet — org and user scope, and a repo the user named when
phase 1's scope came back null — stop after `select-adapter.sh` instead: line reconciliation
happens after checkout, in phase 5, per repo. **Discovery for a named repo therefore runs before
any per-repo environment resolution exists**: phase 5 is where that repo's `env_prefix` and
`repo_root` are settled, so this call, like every org and user scope discovery call, is made with
whatever identity your own shell resolves. In a workspace whose credentials are scoped to its
directories, run this skill from inside the relevant directory so that identity is the right one,
or expect discovery to read the wrong account's alerts.

`target` is `nwo` at repo scope, `owner` at org scope, and omitted (or the authenticated login) at
user scope. Returns `actionable` (ranked by severity then EPSS, each group annotated with its
`adapter_path` and, at every scope, its own `repo`) and `skipped` (each with a `reason`), plus
`skipped_repos` — repos excluded at org or user scope, because the user cannot push to them
(`no push access`), because the API did not say whether they can (`permission data missing from
API response`), because the repo is a fork (`fork repository`, on both the aggregate and fan-out
paths) or archived (`archived repository`, fan-out path only — the aggregate response can never
name an archived repo, since GitHub refuses Dependabot alerts for archived repositories outright),
or because their alerts could not be read (`alert fetch failed`, `invalid alert response`).
`skipped_repos` is always present and empty at repo scope.

A group is **one major line of one package in one repo**, not one package: a package resolved at
several majors at once has a different patched version per line, and one group per line is what
lets each get its own branch, worktree and PR (issue #19). Two groups with the same `package` and
different `major_line`, or the same `package`/`major_line` in different `repo`s, are independent
work, never a duplicate.

If `actionable` is empty, report every skipped group and every skipped repo, and stop. Reasons you
will see:

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

`classify-lines.sh` also annotates each still-actionable group with `resolved_majors` and a
`line_status` (`resolved`, `line_absent`, or `unknown`); all three dispatch normally — `unknown`
deliberately so, since validate fail-closes later and withholding a fixable group is the wrong
direction.

`skipped_repos` reasons:

- `no push access` — the authenticated user cannot push to the repo; never dispatched
- `permission data missing from API response` — the API did not say whether the user can push
- `fork repository` — never a dispatch target, on both the aggregate and fan-out paths
- `archived repository` — never a dispatch target; fan-out path only
- `alert fetch failed` / `invalid alert response` — the per-repo alert call itself failed
  (`error` field where present)

**Report every skipped repo by name, every time it is non-empty**, whether or not `actionable` is
empty. A repo silently left out of the batch is exactly the failure mode the RFC's push-access
filtering requirement exists to prevent.

## Phase 3: Ask how much to fix

Present the ranked table:

> | # | Repo | Package | Line | Severity | EPSS | Alerts | Relationship |
> |---|---|---|---|---|---|---|---|

Omit the `Repo` column at repo scope — every row shares the same repo, and a constant column is
noise. Include it always at org and user scope, for the same reason `Line` is always shown: hiding
a dimension that can differ between rows is how a collapsed report reads as normal.

`Line` is the group's `major_line` (`6.x`, `7.x`). Show it always, not only when a package has
more than one: a row that says `undici 6.x` and another that says `undici 7.x` is the difference
between two fixes and one, and hiding it is how the collapsed-group bug read as normal.

Note skipped groups and skipped repos briefly. A `requires major version bump` group appears among
those skip notes with its `resolved_majors` context ("only 0.2.5 is installed; the fix line is
1.x"), never as a rankable row: it was moved to `skipped` in phase 2, and offering it for approval
is asking the user to approve doomed work (issue #101). At org and user scope no group carries a
`line_status` yet — line reconciliation happens after checkout, in phase 5 — so say a group may
still be withdrawn there. Then AskUserQuestion with three options:

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

Omit the `Repo` column at repo scope, as in phase 3. "Likely action" comes from the alerts'
`relationship` field (direct → version bump, transitive → scoped override) and is best-effort: the
subagent's own `why` classification is authoritative. An agent can also come back with
`action: "lockfile-refresh"` — its control install alone resolved the fix, because the manifest
already admitted the fixed version and only the stale lockfile pinned the vulnerable one — which
no prediction here anticipates. `Branch` shows each group's `branch_name`;
at repo scope it is final (phase 1's namespace probe already ran — say so when the batch runs
flat), while at org and user scope it is provisional until phase 5's per-repo probe, which can
flip a repo's names to the flat `fix-dependabot-...` scheme; say that too.

At org or user scope, name every distinct repo the plan touches and say plainly that a repo not
yet checked out locally will be cloned before dispatch, into a destination phase 5 asks about
once: a directory the user names and keeps, or a temporary directory removed at the end of the run
when every group in it opened a PR, and kept and reported otherwise. Say that the cloning is part
of what this approval covers, and that the destination question
is the one thing still to be settled, not a separate consent step for the work itself.

Ask for **one** approval of the whole batch. This is **the last checkpoint before pull requests
exist**: subagents run unattended from here through PR creation, and no phase after this one asks
the user to approve anything about a PR. Nothing dispatches without it.

**That one approval covers the workflow launch and every agent inside it.** Phase 6 dispatches the
batch by running one Workflow script, and once it is launched **nothing inside it prompts** — no
per-group checkpoint, no confirmation as one agent finishes and the next starts. Say so here, so
the user approving the batch knows that approving it is approving every group in it. A group
withdrawn later never needed re-approval either, and no group is ever added to the batch after
this point.

## Phase 5: Resolve local checkouts

Skip this phase entirely when phase 1 detected repo scope from a local checkout — `repo_root`,
`nwo`, and `default_branch` are already known from there. Run it otherwise: at org and user scope,
and for the single repo a user named when phase 1's scope came back null, which has no local
checkout either.

**Ask once, before the first repo is resolved, where new clones go.** The machine may have no copy
of some repo in the batch, and there is no convention that says where a new one belongs, so this
is **one question for the whole run**, never one per repo: AskUserQuestion in the phase 3 style,
with two options.

- **A directory I name** — clones land at `<destination>/<repo-name>` and stay there afterwards.
  Take the directory from the question's free-form answer. When the current directory holds
  `@`-prefixed owner directories, offer `<current directory>/@<repo-owner>`
  as the suggested default: a layout the machine already has is a reasonable guess, and it is only
  ever a default the user can replace. Nothing else in this skill reads that convention.
- **A temporary directory, cleaned up when every group in it opens a PR** — create it with the
  exact command below, clone into it, and let phase 7 decide whether it can be removed. The label
  is literal: phase 7 keeps and reports the whole directory when any group in it ended without a
  verified open PR, because its worktree and branch are then the only copies of that work.

  ```bash
  mktemp -d -t gh-security-clones
  ```

  **Record the path that command printed, verbatim, and treat it as this run's only removable
  path.** Phase 7 removes exactly that recorded string and refuses any other; the
  `gh-security-clones` component is what makes a removal recognizable as this skill's own, in the
  transcript and in the tool grant.

  **Say what this option costs before the user picks it.** Clones under a temporary directory sit
  outside every workspace directory, so in a workspace whose credentials are scoped to its
  directories, **a repo cloned there runs without the command prefix your environment requires**,
  and `gh`, `git` and the package manager resolve whatever identity the bare shell has. The
  failures that produces are misleading rather than obvious: a fetch that reports the repository
  as missing, an install that 401s against the wrong registry.
  **In such a workspace, name a directory instead.**

Ask it even when every repo turns out to already have a checkout; the answer costs one question
and the alternative is discovering the need for it halfway through resolving repos.

For each **distinct repo** named in the approved batch:

1. **Resolve `env_prefix` for the repo, before its clone or fetch.** The same resolution phase 1
   makes at repo scope, and by the same rule: whatever prefix your session context states for the
   directory this repo's checkout will live in is that repo's `env_prefix`, taken verbatim; where
   the context states none, the repo has none and its commands run bare. Nothing is probed here
   either, so no checkout has to exist for the statement to be read. **Where the stated prefix
   takes a directory, instantiate it against the destination directory this run chose, never
   against the checkout path.** Phase 1 can name the checkout because it has one; here the checkout
   is what step 2 is about to create under this very prefix, and a prefix instantiated against a
   path that does not exist yet fails on that clone. The destination exists first and contains the
   checkout, so the environment it selects is the one the checkout inherits.
   **Your own commands for this repo run under it too**, not just the dispatches: the clone or
   fetch in step 2, `detect-scope.sh` in step 3, the namespace probe in step 4,
   `classify-lines.sh` in step 5, and `pr-status.sh` in phase 6's reap step and again in phase 8.
   The prefix injects environment without changing directory, so it composes with the `-C` or `cd`
   locator each of those already carries.
2. **Reuse a checkout wherever one is found; clone only what is missing.** The expected path is
   `<destination>/<repo-name>`, where `<destination>` is the answer to the clone-destination
   question above, plus any path the user named for this repo specifically in conversation.
   - If a git repository already exists at that path, use it as `repo_root` and refresh it:
     `git -C <repo_root> fetch origin`. A checkout the run did not create is never removed by it,
     whichever destination was chosen.
   - If nothing exists there, clone it there: `gh repo clone <repo> <repo_root>`.
   - If a directory exists at that path but is not the expected git repository (wrong remote, or
     not a repository at all), stop and report the conflict for that repo rather than guessing;
     do not dispatch groups for it. Step 3's `detect-scope.sh` call answers "is this the right
     repository" from `origin` itself, which is where its `nwo` comes from.
3. **Resolve `default_branch` and confirm the identity** of that `repo_root`:
   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh <repo_root>
   ```
   Use its `default_branch`. If null, report that repo as blocked and exclude its groups from
   dispatch rather than guessing a branch name. Its `nwo` is read from that checkout's own
   `origin`, so an `nwo` that is not the repo this batch meant is the wrong-repository conflict
   from step 2 arriving one step late: report it and exclude that repo's groups the same way.
4. **Probe that repo's branch namespace** — the same probe phase 1 makes at repo scope, with the
   same semantics, one per repo:
   ```bash
   git -C <repo_root> ls-remote --heads origin refs/heads/fix
   ```
   The fully-qualified refname matters here too: git matches the whole ref, not the tail
   component, so a repo with `topic/fix` and no bare `fix` returns nothing. Non-empty output means
   the remote rejects every `fix/*` push (`(directory file conflict)`, issue #123): this repo's
   branch style is `flat`, and the next step's `classify-lines.sh` call takes
   `--branch-style flat`, which rewrites that repo's `branch_name`s to the
   `fix-dependabot-<pkg>-<line>x` scheme before anything dispatches — the fix agents consume the
   rewritten names verbatim and never decide naming themselves. Empty output keeps the default
   slash scheme (no flag). A non-zero exit gets one retry; a second failure gets that repo's groups
   excluded from dispatch and reported in phase 7 with the probe's stderr verbatim, as with a null
   `default_branch` — not a pre-baked "origin unreachable" diagnosis, since auth, a wrong
   `env_prefix`, and a non-git `repo_root` all fail here too. A failed probe also prints nothing on
   stdout; never read a failed probe's empty stdout as the slash verdict. Record every repo that
   flipped to flat; phase 7 names them.
5. **Reconcile each approved group with what the default branch actually resolves.** Once the
   repo's `{repo, repo_root, default_branch}` triple is resolved, run:
   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/common/classify-lines.sh --repo-root <repo_root> --base-ref origin/<default_branch>
   ```
   (plus `--branch-style flat` when step 4 flipped this repo)
   with that repo's APPROVED groups on stdin, as the phase 2 envelope filtered to them
   (`{actionable: <that repo's approved groups>, skipped: []}`). `--base-ref` carries step 3's
   `default_branch`, exactly as phase 2 does at repo scope: the script fetches that branch and
   classifies against a short-lived detached worktree at the fetched ref, so a checkout step 2
   reused — whatever branch it sits on — classifies the same as a fresh clone
   (issue #158). A non-zero exit from `classify-lines.sh` here is a stop for this repo: report it
   as blocked with the script's `{"error": ...}` line, and never re-run without `--base-ref`,
   which would judge the user's checkout and reintroduce the defect the flag exists to close.
   A group that reclassifies
   `requires_major_bump` is **withdrawn from the phase 6 queue** — no re-approval needed: the
   approval covered fixing the group, and this discovers the fix does not exist — and reported in
   phase 7 as skipped with the same `requires major version bump` reason and its
   `resolved_majors` context. A group that reclassifies `cross_line_collision` is withdrawn the
   same way and reported under `shared parent across major lines` with its `collision_parents`
   (issue #132). Every other `line_status`, `unknown` included, dispatches as
   approved.

Carry the resolved `{repo, repo_root, default_branch}` triples into phase 6; every group dispatched
for a given repo shares its triple.

## Phase 6: Dispatch the fix workflow

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

**Carry that repo's `env_prefix` into this phase.** It was resolved in phase 1 (repo scope) or
phase 5 step 1 (org and user scope), never here: by the time anything dispatches, every one of
your own commands for the repo has already been running under it. This phase only applies it — to
the registry preflight next and to every group dispatched for the repo — and omits the field from
the dispatches of a repo that resolved none.

**Probe that repo's registry, once, before its first dispatch.** The field run this contract comes
from began with a dead private-registry token: all 33 agents would have failed at install, one at a
time, each burning a slot before reporting a confusing failure. Resolve the package manager the
same way `classify-lines.sh` and the fix agent do — `<adapter_path> detect` gives `pm` and
`pm_exec` — and run one read-only probe from inside `repo_root`, under `env_prefix` when this repo
has one (bare when not). The `cd` is load-bearing and `env_prefix` cannot replace it: the prefix
injects environment without changing directory, so a probe without the `cd` runs in your
working directory, resolves the wrong `.npmrc`/`.yarnrc.yml`, and lets a dead private-registry
token probe green against the public registry — the exact failure this preflight exists to catch;
yarn berry additionally errors outside a project, which would exclude every berry repo. Probe a
**scoped** dependency from the repo's own manifest when one exists — scoped packages are where
private registries live — falling back to the top-ranked queued group's `package` for this repo
when the manifest declares no scoped dependency:

- pnpm: `cd <repo_root> && <env_prefix> <pm_exec> view <package> version`
- npm: `cd <repo_root> && <env_prefix> <pm_exec> view <package> version`
- yarn (berry): `cd <repo_root> && <env_prefix> <pm_exec> npm info <package> --fields version`

This is modeled on how phase 1 and phase 5 resolve `default_branch` up front and stop or exclude
on a null rather than letting every downstream dispatch discover the same failure independently.
A non-zero exit gets **one retry** before it means anything — registries flake, and a transient
blip must not cost a repo its whole batch. A second failure is the signal: report one actionable
message naming the repo and distinguishing the cause by what the output says — an auth failure
(401 or 403) means dead registry credentials, and that is the one case where the remedy is
running your login flow for that registry; a 404 means the probe package is not in the registry
the probe reached, which is a routing or scope-mapping question, not an auth one; anything else
(timeout, DNS, connection reset) is network trouble. Exclude every one of that repo's groups from
the queue below, and report them in phase 7 alongside the run's other skipped work, noting that
the failure may be transient and that re-running the skill re-probes. There is no proceed-anyway
machinery here: a user who wants to dispatch past a failed probe says so in conversation, the
same footing as the audit command's open-PR preflight. **One probe per repo, not per group** — the probe package, scoped dependency or
fallback, stands in for that repo's
registry reachability as a whole; a second dead package in the same repo is the same root cause; a
green probe does not shield an actual `install` inside a fix agent from failing on that group's
package specifically, but a probe failing here is worth stopping 30+ downstream failures for one
report.

### The dispatch workflow

**Dispatch is one Workflow call, not a schedule you keep by hand.** The bookkeeping a rolling pool
needs — how many agents are in flight, which slot just freed, never overshooting the cap on a stale
count — is exactly what the harness does deterministically, and re-deriving it in prose costs
tokens on every run to arrive at a worse answer. Launch the script below with `args` set to
`{cap: <detect-capacity.sh's cap>, dispatches: [<one payload per approved group>]}`, every group
across every repo in the ranked order phases 3 and 4 settled.

**Pass `args` as an actual JSON value, never as a JSON-encoded string.** A stringified `args`
arrives as one string, `args.dispatches` is then `undefined`, and the guard at the top of the
script rejects it. That guard exists because every one of these mistakes is otherwise silent: a
missing `cap` makes the worker count `NaN`, `Array.from({length: NaN})` empty, and `parallel([])`
return at once with every entry still `null` — which phase 7 would faithfully report as a whole
batch of crashed agents when nothing was ever dispatched. Fail loudly, fix the `args`, relaunch.

Each payload is the group JSON verbatim under `group`, plus `adapter_path`, the group's own `nwo`
(its `repo` field), `default_branch` and `repo_root` for that group's repo (from phase 1 at repo
scope, or phase 5's resolved triples at org/user scope), `scripts_dir`
(`${CLAUDE_PLUGIN_ROOT}/scripts/common`), and that repo's `env_prefix` when it resolved one (phase 1
at repo scope, phase 5 at org and user scope; OPTIONAL — **omit the key rather than send null**).

The script is thin on purpose: it dispatches and it validates, and nothing else. The reap below and
the phase 7 summary stay outside it.

```javascript
export const meta = {
  name: 'gh-security-fix-dispatch',
  description: 'Fix each approved Dependabot alert group with its own subagent, bounded by the machine capacity cap',
  phases: [
    { title: 'Fix groups', detail: 'one fix-dependency agent per approved group', model: 'sonnet' },
  ],
}

// args: { cap: <detect-capacity.sh cap>, dispatches: [ <one payload per approved group> ] }
const RESULT_SCHEMA = {
  type: 'object',
  required: [
    'status', 'package', 'major_line', 'repo', 'branch', 'pr_url', 'action',
    'resolved_version', 'risk', 'observations', 'requires_major_bump',
    'bare_override', 'no_op', 'failure',
  ],
  properties: {
    status: { enum: ['success', 'no-op', 'failure'] },
    package: { type: 'string' },
    major_line: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    pr_url: { type: ['string', 'null'] },
    action: { enum: ['direct-update', 'scoped-override', 'bare-override', 'lockfile-refresh', null] },
    resolved_version: { type: ['string', 'null'] },
    risk: {
      type: ['object', 'null'],
      required: ['band', 'score', 'f4', 'f5'],
      properties: {
        band: { type: 'string' },
        score: { type: 'number' },
        f4: { type: 'number' },
        f5: { type: 'number' },
      },
    },
    // `type` is the only field every observation carries: the adapter emits
    // `unscoped_override`, `manifest_pnpm_overrides_ignored` and
    // `pnpm_major_unknown`, the agent appends `unscoped_override_added`, and
    // only the two override shapes carry `key`.
    // Do NOT narrow this to an enum: an adapter gaining a fourth type would
    // then fail every result it appears in.
    observations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string' },
          key: { type: 'string' },
          range: { type: 'string' },
          targets_this_package: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
    // validate's own array, verbatim: one entry per still-vulnerable copy
    // below the fix line (node.sh `$bump`), keyed by the resolved `version`
    // and the advisory ranges it still matches.
    requires_major_bump: {
      type: 'array',
      items: {
        type: 'object',
        required: ['version', 'vulnerable_ranges'],
        properties: {
          version: { type: 'string' },
          vulnerable_ranges: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    bare_override: { enum: ['none', 'added', 'tightened'] },
    no_op: {
      type: ['object', 'null'],
      required: ['reason', 'evidence'],
      properties: { reason: { type: 'string' }, evidence: { type: 'object' } },
    },
    failure: {
      type: ['object', 'null'],
      required: ['phase', 'detail'],
      properties: {
        phase: {
          enum: ['input', 'worktree', 'baseline', 'classify', 'apply', 'install', 'validate', 'push', 'pr'],
        },
        detail: { type: 'string' },
      },
    },
  },
  // The Result contract's cross-field rules. Without these,
  // {"status":"failure","failure":null} validates field-for-field, clears
  // post-agent.sh's gate (which reads only branch/package/major_line), and
  // reaches phase 7's "failures get their phase and detail" with no data.
  oneOf: [
    {
      properties: {
        status: { const: 'success' },
        pr_url: { type: 'string' },
        action: { type: 'string' },
        risk: { type: 'object' },
        no_op: { type: 'null' },
        failure: { type: 'null' },
      },
    },
    {
      properties: {
        status: { const: 'no-op' },
        pr_url: { type: 'null' },
        action: { type: 'null' },
        risk: { type: 'null' },
        no_op: { type: 'object' },
        failure: { type: 'null' },
      },
    },
    {
      properties: {
        status: { const: 'failure' },
        pr_url: { type: 'null' },
        action: { type: 'null' },
        risk: { type: 'null' },
        no_op: { type: 'null' },
        failure: { type: 'object' },
      },
    },
  ],
  // bare_override must agree with action, in both directions.
  allOf: [
    {
      if: { properties: { bare_override: { enum: ['added', 'tightened'] } }, required: ['bare_override'] },
      then: { properties: { action: { const: 'bare-override' } } },
    },
    {
      if: { properties: { action: { const: 'bare-override' } }, required: ['action'] },
      then: { properties: { bare_override: { enum: ['added', 'tightened'] } } },
    },
  ],
}

// Refuse a malformed `args` loudly. Every failure here is silent otherwise:
// a stringified `args` leaves `args.dispatches` undefined, and a missing
// `cap` makes Math.min NaN, Array.from({length: NaN}) empty, and parallel()
// return at once with every entry still null — which phase 7 would read as a
// whole batch of crashed agents when nothing was ever dispatched.
if (!args || !Array.isArray(args.dispatches) || !args.dispatches.length) {
  throw new Error('args.dispatches must be a non-empty array of dispatch payloads (pass args as JSON, never as a JSON-encoded string)')
}
if (typeof args.cap !== 'number' || !(args.cap >= 1)) {
  throw new Error('args.cap must be a number >= 1, from detect-capacity.sh')
}

const DISPATCHES = args.dispatches
const WORKERS = Math.min(args.cap, DISPATCHES.length)
log('Dispatching ' + DISPATCHES.length + ' group(s), ' + WORKERS + ' at a time')

phase('Fix groups')

const results = new Array(DISPATCHES.length).fill(null)
let next = 0

const worker = async () => {
  while (next < DISPATCHES.length) {
    const i = next
    next += 1
    const d = DISPATCHES[i]
    results[i] = await agent(
      'Follow your agent definition end to end and finish with its JSON result block.\n' +
        'Dispatch payload:\n' + JSON.stringify(d, null, 2),
      {
        agentType: 'fix-dependency',
        model: 'sonnet',
        phase: 'Fix groups',
        label: d.group.repo + ' ' + d.group.package + ' ' + d.group.major_line,
        schema: RESULT_SCHEMA,
      },
    )
  }
}

await parallel(Array.from({ length: WORKERS }, () => () => worker()))

return DISPATCHES.map((d, i) => ({ dispatch: d, result: results[i] }))
```

`cap` bounds the pool here and nowhere else: the workers are what hold it, so the pool can never
exceed it and no count of yours has to track it. The cap stays machine-wide across every repo in
the batch — a single workflow over every approved group, never one workflow per repo, is what makes
that true by construction.

**`model: 'sonnet'` is passed explicitly, and that is what holds ADR 004's pin here.** The fix
agent's own frontmatter (`agents/fix-dependency.md`) pins sonnet for a Task dispatch, but a
workflow `agent()` call with no `model` inherits the session model, and whether `agentType`
composes with the target definition's frontmatter is not specified. Left implicit, a 33-group run
could silently execute on whatever model the session happens to hold, voiding ADR 004 with nothing
to notice it. So the pin is stated at the call site and mirrored on the `meta` phase entry, where
the progress display reports it. **Never drop either without changing ADR 004 first**, and if the
frontmatter mechanism is ever confirmed to compose, this becomes redundant rather than wrong.

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
  same script and the same `args`: the unchanged prefix of `agent()` calls returns its cached
  results instantly and only the unfinished work runs live. Re-launching without
  `resumeFromRunId` re-runs every group, which is how a second branch and a second PR appear for
  work that already succeeded. Resuming the batch the user approved is not a new dispatch
  decision — but **a run the user deliberately interrupted is**, so there, ask first.
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
never counted as a success.

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

Omit the `Repo` column at repo scope, as in phases 3 and 4.

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
miss)`): the namespace probe in phase 1 or phase 5 said `slash`, but this group's exact `fix/*`
push still landed on a blocking sibling ref — the inverse collision those phases document as
unprobed. Re-running the skill hits the same wall for this group until the namespace is resolved
on the remote or the whole batch is re-run with the flat style forced
([#123](https://github.com/SurveyMonkey/skills/issues/123)).

**Before anything else in the summary, report every alert that stays open after this batch because
the only possible fix crosses a major** — two different senses of the same name, both belonging
here first because both mean the same thing to the user: a fix that did not happen.

- Post-fix, every non-empty `requires_major_bump[]` an agent's result carries, per package line
  (and per repo at org/user scope). This is validate's own reconciliation: the group was dispatched
  and its own line fixed, but the install moved another copy of the package across the fix
  boundary, and validate proved that copy cannot be reached from where it landed.

  > Still vulnerable after this batch: `undici` 5.29.0 in `octo/app` (alerts patched only in the
  > 6.x line). No override bounded to 5.x can fix this; it needs a major bump of the parent that
  > pins it, or dropping that parent.

- Pre-dispatch, every group classify-lines.sh moved to `skipped` under `requires major version
  bump`, with its `resolved_majors` context — whether phase 2 found it at repo scope (still
  reported here, not just phase 3's skip note, so it does not vanish once the batch runs) or phase
  5 withdrew it after approval at org or user scope. Neither reached a fix agent: no override at
  the resolved line could ever land the patched version, so there is nothing for validate to
  reconcile.

Reporting a batch as done without either kind is the failure mode issue #19 is about, and it is
worse coming from the summary than from an agent.

**Then re-report every skipped repo from phase 2's `skipped_repos`, by name, if any remain
unaddressed, and every repo phase 6's registry preflight excluded.** These are repos with alerts
the batch never touched at all, and belong in the same summary as the batch that did run — never a
detail left only in the earlier discovery report. A registry-preflight exclusion names the probe
package, the diagnosed cause (auth, not-found, or network), that the failure may be transient, and
that re-running the skill re-probes. A repo the branch-namespace probe excluded (phase 1 at repo
scope, phase 5 step 4 otherwise: `ls-remote` failed twice, so `origin` is unreachable) is reported
the same way. And **name every repo whose batch ran under the flat branch scheme**, with the
reason: a remote branch named `fix` occupies the `fix/*` ref namespace, so that repo's PRs came
from `fix-dependabot-...` branches — the user reading branch names in the PRs should not have to
guess why they differ from a neighbor repo's.

**Then report every group classify-lines.sh skipped under `shared parent across major lines`,
with its `collision_parents`.** These alerts also stay open: the group's line shares a parent
with a sibling line in a shape no override key in that repo's syntax can scope apart, so that
group was never dispatched. The verdict is per group, so a line of the same package whose
parents are disjoint may still have run normally
([#132](https://github.com/SurveyMonkey/skills/issues/132)). The remedy is human work: bumping
the shared parent past the old line, or dropping the dependent that pins it. Like the
requires-major-bump skips, report these whether phase 2 found them at repo scope or phase 5
withdrew them after approval.

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

**Then, when phase 5's clone destination was the temporary one, decide whether it can be
removed.** The condition is the one that gates the reap, for the same reason: **a group whose
agent ended without a verified open PR has nothing on the remote**, so its worktree and its branch
are the only copies of that work, and both sit inside this directory. Removing it would destroy
exactly what phase 6 deliberately preserved.

- **Every group in that destination ended with a verified open PR**, or nothing was cloned into it
  at all: remove it, and name the directory and the repositories that were in it, in one line.
  Those clones hold nothing the run still needs, because every pull request lives on the remote,
  and anything the reap left behind inside goes with the directory, so say that rather than
  pointing the user at a worktree path that no longer exists.
- **Any group in it ended any other way** — a failure, a crash, a `no-op`, a `null` entry from the
  workflow, or a `pr_url` whose PR is not open: **keep the whole directory**, and
  report that it was kept, where it is, and which groups are the reason. It is temporary in the
  sense that nothing else will reuse it, never in the sense that this skill deletes unpushed work.

The removal is one command, after the last agent has returned, against the path phase 5 recorded
from `mktemp`, verbatim:

```bash
rm -rf <the recorded gh-security-clones path>
```

**Never widen that path and never substitute another**: not a parent of it, not a glob, not a
directory the user named. A checkout that already existed is reused, never created, so it is never
inside the removable directory. A run whose clones went to a directory the user named removes
nothing and says nothing here.

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
  failure class phase 1 documents (:74-78) is precisely that per-directory identity tools load
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

Otherwise report done, including any repos still in `skipped_repos` and what would unblock each.

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
nothing to read. The script operates on PR URLs directly and needs no `repo_root`, so a batch's
URLs can span repos and are handled identically at every scope.

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
