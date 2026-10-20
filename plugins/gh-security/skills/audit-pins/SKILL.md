---
name: audit-pins
disable-model-invocation: true
description: >
  Audit this repo's dependency pins (the overrides and resolutions added to
  hold transitive dependencies at safe versions) and report which are no
  longer needed. Preflights for the repo's own open security-labeled PRs and
  stops if any exist. Each removal is tested in an isolated worktree against
  every published advisory for the package, and the removable set is tested
  once more together before a removal PR is opened for review. Report-only is
  offered as the alternative.
---

The user explicitly invoked `/gh-security:audit-pins`. Run the pin audit on the current
repository, directly: this entry point does not discover or fix alerts.

**Each step is one command; run it, read its JSON, and decide.** Write every call on one line, as
shown, with literal paths and no variable, quote, pipe or redirection, so the plugin's allow hook
passes it. A call with `--env-prefix "<env_prefix>"` cannot pass the hook, and prompts.

## 1. Resolve `env_prefix`, then detect scope

**Resolve `env_prefix` first, before anything talks to the repo.** `env_prefix` is a command
prefix the environment requires for repo-targeted commands: optional, opaque, and never derived.
**Take it from your session context.** When the CLAUDE.md or rules covering the working
directory state that commands in that tree need a prefix, that stated prefix is `env_prefix`,
verbatim. When no such context exists, there is none, and commands run bare. The failure it guards
against: where `gh`, `git` and the package manager get their identity per directory, the tools
that arrange that load through interactive shell hooks that a non-interactive tool shell never
runs, so a bare `gh` or `git` silently reads the wrong identity.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" detect-scope <cwd>
```

Add `--env-prefix "<env_prefix>"` before `<cwd>` when there is one: the command reads the default
branch from GitHub. A non-zero exit is an error: report it and stop.

The audit is **repo-scoped**, and stays so even when `resolve-alerts` runs across several
checkouts: one `audit-pins` agent tests one repository's pins. If `scope` is null, say that this
skill audits a single repository and ask which one, or ask the user to run it from that repo's
checkout. **Re-run `detect-scope` against that checkout and read `nwo`, `default_branch` and
`repo_root` from the second output**, never from the first: the first ran outside every
repository, so every one of its fields is null. Never fan out across every repo in an org by
hand: each pin tested costs an install.

If `nwo` is null, this checkout has no usable `origin`; report that and stop, since the audit's
own PR is opened against that repository. If `default_branch` is null, report that and stop.

`repo_root` is `git -C <path> rev-parse --show-toplevel`, where `<path>` is the answer's `path`.

## 2. Check there is something to audit

Use Glob for `<repo_root>/package.json`. `npm` is the only ecosystem with an adapter today, so a
repository with no node manifest has nothing this skill can audit: report exactly that and stop.
The agent's `audit-pins list` step routes the ecosystem itself (`--ecosystem`, default `npm`).

## 3. Check for open security fix PRs, and stop if any exist

```bash
gh pr list --repo <nwo> --label security --state open --limit 100 --json number,title,url,headRefName
```

Put `<env_prefix>` in front when step 1 resolved one.

**A non-zero exit here is a failure, never an answer.** Report its stderr and stop. A failed
lookup read as "no open PRs" opens the audit against a moving target.

The audit's verdicts are computed against the default branch. An open PR with the `security`
label may be an unmerged fix that still adds or tightens an override the audit is about to judge
removable. A field-test audit PR removed 8 keys that four unmerged fix PRs of the same batch
still changed.

**Exclude the audit's own removal PR.** Drop each entry whose `headRefName` is
`chore/dependabot-remove-pins`: that PR is this plugin's own prior output, and the agent's own
open-PR guard handles it.

If the filtered list is non-empty, report each PR by number and title, say that these open
security fixes should be merged or closed before the audit runs, and **stop**. There is no
proceed-anyway option: a user who wants to run the audit regardless says so in conversation.

## 4. Keep the audit worktree out of `git status`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" ensure-worktree-exclude <repo_root>
```

The agent does not do this for itself: `.git/info/exclude` is repo-global state
([#35](https://github.com/SurveyMonkey/skills/issues/35)). A failure here is not fatal: report it
and dispatch anyway.

## 5. Ask which mode, then dispatch

The agent cannot ask anything, so the mode is decided here. AskUserQuestion, once, with two
options. **PR mode is the first option and the recommended one**, because the audit already does
all the work a removal PR needs:

- **Open a PR** (`mode: pr`, recommended): audit, then remove the pins the audit confirms,
  install once with all of them gone, check each version that newly resolves against every
  published advisory, and open a PR with that evidence. It opens **ready for review**, which is
  not merging it: you review the diff and merge it on GitHub, or close it (ADR 008).
- **Report only** (`mode: report`): the findings and nothing else; the repository is left as it
  is.

**Never omit `mode` and never guess it.** The audit runs one install per pin, and PR mode adds up
to two more; say so before dispatching.

Then one Task call, `subagent_type` `audit-pins`, whose prompt carries `repo_root`, `nwo`,
`default_branch`, `mode`, `cli` (`${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts`), `adapter_path`
(`${CLAUDE_PLUGIN_ROOT}/scripts/ecosystems/node.sh`, for the adapter verbs with no command yet),
an OPTIONAL `env_prefix`, plus the
instruction to follow its agent definition and end with its JSON result block. Pass `env_prefix`
only when step 1 resolved one.

## 6. Report

Parse the agent's fenced JSON result. **An unparseable or missing result block is a failure
report**: say so, and never guess fields. Present the findings **grouped by package, one table
per package**, never a flat list of pin keys:

> | Pin | Scope | Value | Attributable to removal | Elsewhere in the tree | Advisories | Finding |

"Elsewhere in the tree" is never blank. It reads `nothing else moved`, names each other package
whose resolution changed with its verdict, or reads `not checked`. A verdict with an empty column
and one with an unchecked column are different claims.

Then, in order:

- **Removable** pins: what to delete, and the version that resolves instead.
- **Removable individually** pins: the package carries more than one, and each was tested with the
  others still in place. Say that removing more than one requires a fresh audit of what remains.
  Never collapse this status into `removable`.
- **Still required** pins: the advisory range that still admits the version that would resolve.
- **Inconclusive** and **not tested** pins: why. A pin reported as `no-advisories` is not a pin
  proven safe.
- **Not a version pin**: aliases, patches, workspace and git targets, npm `"$pkg"` references.

In `report` mode that is the whole result: nothing was changed.

## 7. Report the PR

In `pr` mode only, and only when the result's `pr` is non-null: report the URL, `pr.attempt`,
`pr.removed_keys`, `pr.left_behind` with each reason, and the `pr.risk` band, or "not scored" when
`pr.risk.band` is `null`.

When `pr` is `null`, say which of the five reasons in `pr_skipped_reason` it was, with
`pr_skipped_detail`, and stop:

| `pr_skipped_reason` | What to say |
|---|---|
| `open PR already exists` | a removal PR is already open; link `existing_pr_url`, and say these findings tell them whether it is still the right one |
| `no pins` | the repository declares no overrides or resolutions |
| `no removable pins found` | it has pins, and each one still does something |
| `partial resolution map` | the lockfile could not be read whole, so no removal could be judged against the whole tree |
| `combined test failed` | the confirmed pins are not removable as a set; name the package and version that failed it, and the attempt |

None of those is a failure. **A `"status": "failure"` result is none of the five.** Report its
`failure.phase` and `failure.detail` in the failure's own terms. **A `pr`-mode success with a
`null` `pr` and a `pr_skipped_reason` that is missing or outside those five values is a contract
violation.** Report it as a failure of the agent, quoting what came back.

When a contract violation, or other evidence, shows the audit's own logic misbehaved rather than
the target repo's state, read
`${CLAUDE_PLUGIN_ROOT}/skills/resolve-alerts/defect-report.md` first, and follow it. Never
re-derive its rules here. Its closing report is this step's report.

Otherwise read the PR's state once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh-security.ts" pr-status <pr.url>
```

Add `--env-prefix "<env_prefix>"` before `<pr.url>` when step 1 resolved one. Read `prs[0]`. A
non-zero exit means the PR could not be read: report its `error`, and the URL, then stop.

Nothing here acts on a pull request after it is created (ADR 008): do not offer to merge it, do
not enable auto-merge, and do not ask whether it may be marked ready for review, because it
already is. Report what follows, then stop.

- **`pr.risk` rates the change for the reviewer**, and nothing gates on it (ADR 006).
- **`checks` is minutes old.** `none` usually means the workflows have not started;
  `pending` cites `check_counts`; `passed` is provisional this soon; `failed` names
  `failing_checks`, which is the one to say loudly. `merge_state: UNKNOWN` is ordinary right after
  a push.

**That is the end of the skill.** A conflicted removal PR is better regenerated than
hand-resolved: close it and run this skill again. The audit owns `chore/dependabot-remove-pins`
and rebuilds it from the current default branch on the next run.
