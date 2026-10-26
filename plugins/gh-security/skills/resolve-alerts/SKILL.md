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
allowed-tools: Bash(*detect-capacity.sh*), Bash(*gh issue list*), Bash(*gh issue create*), Bash(*gh issue comment*), Write, Read, Workflow, AskUserQuestion
---

Orchestrate the resolution of Dependabot security alerts for the current repository, or for every
repository checked out directly under the current directory: discover and rank, ask how much to
fix, dispatch one `fix-dependency` subagent per group (one major line of one package, in one repo)
in parallel, and report the pull requests they open.

**Each step is one command; run it, read its JSON, and decide.** Do not reimplement a command.
Write every call on one line, as shown, with literal paths and no variable, quote, pipe or
redirection, so the plugin's allow hook passes it. A call with `--env-prefix "<env_prefix>"`
cannot pass the hook, and prompts. Save an answer that a later command reads with
the Write tool, under `<run>`: the directory `.gh-security-dispatch/` at the root of the working
directory. **What a failure costs depends on what the script was run for.** A run-level script
(`discover-repos`, `detect-capacity.sh`) failing means report its error and stop.
`merge-envelopes` and `build-dispatches` are run-level too. After the dispatch, pull requests
exist: when `reap-batch`, `summarize-run` or `render-pr-status` fails, report its error and each
`pr_url` in `<run>/results.json`, verbatim. A command run
for one checkout or one repo failing means report its error and exclude that checkout, and carry
on with the others.

You are the control point the user approves. Subagents run unattended through PR creation, so
**nothing dispatches before the user approves the plan in phase 4**. PRs open **ready for
review**, and **nothing here acts on a pull request after it is created** (ADR 008).

## Phase 1: Discover the checkouts

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" discover-repos <cwd>
```

**Scope is the checkouts on disk, and nothing else** (ADR 011). **Do not classify the directory
yourself; the command already did.** A non-zero exit means the scope itself could not be
established, so there is no checkout to exclude: report the error and stop. An empty `repos` says
"No git repositories directly inside `<cwd>`" and stops.

**Nothing is ever cloned.** Not by default, not behind a flag, not into a directory the user names.
A repository the user wants in scope is one they clone themselves. An org with forty repositories
and six local checkouts has six in scope, and that is the answer, not a shortfall. There is no org to name, no login to resolve, and no question to ask here.

**Then, for every checkout in `repos`, resolve it before phase 3 asks anything, so the plan the user approves is final:** every branch name is settled and every group is classified before it is offered, and nothing is withdrawn after approval.

**An excluded checkout never ends the run on its own.** Report it by name with its reason, keep
going with the others, and stop only when no checkout survives. With one checkout in scope that is the same "report and stop" it always was.

### `env_prefix`

**Resolve `env_prefix` for each checkout first.** `env_prefix` is **a command prefix the
environment requires for repo-targeted commands**. It is optional, opaque and never derived:
**take it from your session context.** When the CLAUDE.md or rules covering a checkout's directory
state that commands in that tree need a prefix, that prefix is its `env_prefix`, verbatim. Any
context that names a wrapper command for tools run in a directory tree is such a statement, however
it is phrased. Where the stated prefix takes a directory, instantiate it against the checkout
itself. When no such context exists, the checkout has none and its commands run bare. Each checkout
resolves its own prefix, so two neighbors can differ.

The failure class is real: where `gh`, `git` and the package manager get their identity per
directory, the tools that arrange that load through interactive shell hooks that a non-interactive
tool shell never runs. A bare command then reads the wrong account, silently. So every command
below that names a checkout takes `--env-prefix "<env_prefix>"` when that checkout has one.

### Prepare each checkout

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" prepare-checkout <repo_root>
```

Add `--env-prefix "<env_prefix>"` before `<repo_root>` when the checkout has one. Write each answer
to `<run>/checkout-<n>.json`. An answer with `excluded: true` names its `reason` and `stderr`:
report both, verbatim, and go on. A non-zero exit also excludes the checkout: report its
error by name, leave its file out of phase 2, and name it again in phase 8. The command resolves
the repo, probes the branch namespace, discovers the alerts and classifies each group against `origin/<default_branch>`.

## Phase 2: Merge and rank

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" merge-envelopes <run>/checkout-1.json <run>/checkout-2.json
```

Name every file of phase 1. Write the answer to `<run>/merged.json`. **Report every excluded
checkout by name**, with its reason, whether or not `actionable` is empty. If `actionable` is
empty, report every skipped group and stop.

A group is one major line of one package in one repo. Two groups with the same `package` and
different `major_line`, or in different `repo`s, are independent work, never a duplicate. A group
in `skipped` is withdrawn before the question is ever asked: it never appears as a row the user
can approve.

## Phase 3: Ask how much to fix

Present `actionable` in its order:

> | # | Repo | Package | Line | Severity | EPSS | Alerts | Relationship |
> |---|---|---|---|---|---|---|---|

Omit the `Repo` column when one checkout is in scope. Show `Line` (the group's `major_line`)
always: `undici 6.x` and `undici 7.x` are two fixes, not one. Note the skipped groups and the
excluded checkouts briefly, with a `requires major version bump` group's `resolved_majors` context.
Then AskUserQuestion with three options:

- **One**: fix only the top-ranked group.
- **Highest tier**: fix every group at the highest severity present, across every repo.
- **Everything**: fix all actionable groups, across every repo.

## Phase 4: Present the dispatch plan and get one approval

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-capacity.sh
```

`cap` bounds how many subagents run at once, machine-wide across every repo in the batch.

> | Repo | Package | Line | Severity | Likely action | Branch |
>
> N group(s) across M repo(s), concurrency cap C.

Omit the `Repo` column when one checkout is in scope. "Likely action" is best-effort, from the
alerts' `relationship` (direct: version bump; transitive: scoped override). `Branch` shows each group's `branch_name`, and it is final: name each repo whose `branch_style` is `flat`.

Ask for **one** approval of the whole batch. This is **the last checkpoint before pull requests
exist**. **That one approval covers the workflow launch and every agent inside it**: say so, so the
user knows that approving the batch approves every group in it. No group joins the batch later.

## Phase 5: Prepare each repo for dispatch

Once per distinct repo in the approved batch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" preflight-repo --fallback-package <package> <repo_root>
```

`<package>` is the top-ranked approved package of that repo. Add `--env-prefix "<env_prefix>"`
when the repo has one. The command writes the worktree exclude, detects the package manager, and
probes the registry with one retry. A non-zero exit, or an answer with `ok: false`, excludes every
group of that repo: report the `probe_package`, the `stderr`, the `cause` (`auth` is the one
case where the remedy is your login flow for that registry) and that a new run probes again. A non-null
`exclude_error` is not fatal: report it and dispatch anyway. There is no proceed-anyway machinery:
a user who wants to dispatch past a failed probe says so in conversation.

Write `<run>/preflights.json`: one object from each repo's `checkout` (as `merged.json` spells it)
to its answer. For a non-zero exit, use the JSON that the command wrote on stdout: `{"error": ..., "exclude_error": ...}`.

## Phase 6: Dispatch the fix workflow

Write `<run>/prefixes.json`, from each `checkout` with a prefix to that prefix, when any has one.
Then build the Workflow `args`, naming each approved group that phase 5 kept:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" build-dispatches --envelope <run>/merged.json --cap <cap> --env-prefixes <run>/prefixes.json <repo>:<branch_name>
```

Drop `--env-prefixes` when no checkout has a prefix. Write the answer to `<run>/args.json`.

**Dispatch is one Workflow call.** The script is thin on purpose: it dispatches and it validates, and nothing else. The reap and the summary stay outside it. **Pass `args` as an actual JSON value, never as a JSON-encoded string**: a string arrives with no `dispatches`, and the script refuses it.

**The Workflow tool only accepts a `scriptPath` it can already read**, and the plugin tree is
outside the working directory. Stage a verified copy:

1. Copy the file byte-for-byte from `${CLAUDE_PLUGIN_ROOT}/workflows/fix-groups.mjs` to `<run>/`:
   a path under the working directory itself, not the session scratchpad, which is a session-scoped
   path outside it.
2. Checksum both the source and the copy and confirm they match before launching. On a mismatch,
   copy again; never patch the copy.
3. Launch `Workflow` with `scriptPath` pointing at the checksum-verified copy, not the plugin path.
4. Keep the staged copy in place for the life of the run, including any resume.

```
Workflow({ scriptPath: "<run>/fix-groups.mjs", args: <the answer of build-dispatches> })
```

The script is a real file: it is version-controlled, unit-tested by `spec/js/`, and its result schema is executed against a validator rather than read ([ADR 010](../../../../docs/adr/010-workflow-scripts-are-files-with-a-js-toolchain.md)). Never inline a copy of it, and never hand-edit a variant for one run. A checksum-verified byte-for-byte copy staged only so the tool can read it is neither of those.

**Nothing inside the workflow prompts.** Phase 4's approval covers it.

**The workflow can also throw, be cancelled, or return short, and that must never lose a group.**
When the call errors, the user interrupts it, or it returns fewer entries than `dispatches`:

- **Never read an absent or short return as "nothing ran."** The agents that ran made worktrees,
  pushed branches and opened pull requests.
- **Recover what did run first.** The tool result carries a `runId` and a transcript directory;
  `<transcriptDir>/journal.jsonl` records each agent's actual return value.
- **Resume rather than re-dispatch**: relaunch with `{scriptPath, resumeFromRunId: <runId>}` and the same `args`. A relaunch without `resumeFromRunId` re-runs every group, which is how a second branch and a second PR appear for work that already succeeded. Resuming the approved batch is not a new dispatch decision, but a run the user deliberately interrupted is, so there, ask first.
- The pool's workers steal from a shared cursor, and no bounded pool can make that order repeat, so a resumed entry can be `mispaired`. Treat a `mispaired` entry exactly like a `null` one.
- **When resume is impossible or declined, reap the whole `dispatches` list anyway**: give every dispatch with no entry the entry `{"dispatch": <it>, "result": null, "mispaired": false}`.

Write the workflow's entries to `<run>/results.json`, one for each dispatch, in dispatch order.
Then verify and reap each group:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" reap-batch <run>/results.json
```

Write the answer to `<run>/reports.json`. It reaps a group only when its PR reads `OPEN`, and it
reports every group either way.

Agents for the same repo share its repository-global git state, so while any agent is in flight no agent may touch it, and neither may you: no `git worktree prune`, no `git gc`, no config or ref writes.

## Phase 7: Summarize the run

Write the Workflow tool's result (`result` and `logs`) to `<run>/workflow.json`. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" summarize-run --workflow <run>/workflow.json --reports <run>/reports.json --discovery <run>/merged.json --preflight <run>/preflights.json --args <run>/args.json
```

Show its `markdown` verbatim, and tell the story around it: what shipped, what is still open and
why, and what the user does next. The summary describes the whole approved batch, and when the
workflow threw, was cancelled, or returned short, phase 6's interruption contract is what fills the gap. Agents are told never to park a turn waiting on a hung verb, so a `null` entry is a crash: never wait for it or retry it by hand.

The overrides that the summary names are leads, not findings: do not act on them.
`/gh-security:audit-pins` tests removability.

**When this run's own evidence shows the skill itself misbehaved, file a defect against this
repository**: read [defect-report.md](defect-report.md) first, and follow it.

### Filing a skill-defect report

The rules are in [defect-report.md](defect-report.md). The grants for it are in this skill's
`allowed-tools`.

## Phase 8: Close the run

If actionable groups remain because the user chose One or a tier, offer them as a **new scope
question**: back to phase 3 with the remaining groups.

Otherwise read the PRs this run opened, once, one call per repo, with its `--env-prefix` when it has one:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" pr-status <pr-url> <pr-url>
```

Pass each `success` `pr_url` of that repo. A non-zero exit still carries a full report. Write each
answer to `<run>/pr-status-<n>.json`, and write `<run>/bands.json`: each URL to its result's
`risk.band`, or `null`. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" render-pr-status --bands <run>/bands.json <run>/pr-status-1.json
```

Show its `markdown` verbatim. Report done, with every excluded checkout and repo and what would
unblock each. **When Filing a skill-defect report applied this run, the closing report carries its outcome too**: the filed or proposed issue's number or URL when one exists, or, when no capable account resolved, the drafted title and body verbatim.

The closing report points at the pin audit as separate follow-up work, run via
`/gh-security:audit-pins` once this batch's fix PRs have landed. This skill does not run it: the
two flows edit the same overrides block (#108).

**This is a report, not a prompt, for what this run did to pull requests.** Do not ask whether to
mark anything ready, merge anything, arm auto-merge, or re-check later (ADR 008). This prohibition
is scoped to PR actions; it does not withdraw phase 7's defect-report offer.

Remove `<run>` when the run ends at any phase: after the closing report, at each stop before it,
and when the user declines to resume an interrupted run. When the working directory is a
checkout, `<run>` is an untracked directory in the user's tree.
