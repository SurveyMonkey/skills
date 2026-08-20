---
description: >
  Audit this repo's dependency pins — the overrides and resolutions added to
  hold transitive dependencies at safe versions — and report which are no
  longer needed. Each removal is tested in an isolated worktree against every
  published advisory for the package. Report-only: nothing is changed and no PR
  is opened.
---

The user explicitly invoked `/gh-security:audit-pins`. Run the pin audit on the current
repository, directly: this entry point does not discover or fix alerts.

## 1. Detect scope

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh
```

The audit is **repo-scoped**. If `scope` is `org` or `user`, say that auditing across an org or
user arrives with cross-repo scope
([#6](https://github.com/SurveyMonkey/skills/issues/6)) and stop; do not fan out by hand. If
`git_remote` disagrees with `nwo`, trust `git_remote` and say so. If `default_branch` is null,
report that and stop — the audit worktree is created from it.

`repo_root` is `git -C <path> rev-parse --show-toplevel`.

## 2. Permissions preflight

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/preflight-permissions.sh check <repo_root> <nwo>
```

Same handling as the `resolve-alerts` skill's phase 2: on error, say so and continue without it;
if nothing is missing, continue silently; otherwise ask once, **enumerating every missing rule in
the question text itself**, and on consent run `apply` with the same arguments. Never block the
audit on permissions housekeeping.

## 3. Check there is something to audit, then resolve the adapter

Two separate questions, in this order.

**Is there a manifest?** Use Glob or `test -f <repo_root>/package.json`. `npm` is the only
ecosystem with an adapter today, so a repository with no node manifest has nothing this command
can audit: report exactly that and stop, without dispatching an agent that would only fail on its
first adapter call.

**Which adapter?**

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --ecosystem npm
```

This resolves `adapter_path` and nothing else. It is a pure routing table — ecosystem in, adapter
path out — and never looks at the filesystem, so it answers `supported: true` for `npm` in an
empty directory. It cannot stand in for the check above. Python arrives with its adapter
([#9](https://github.com/SurveyMonkey/skills/issues/9)), and this call is where the choice will be
made once more than one exists.

## 4. Dispatch the audit

One Task call, `subagent_type` `audit-pins`, whose prompt carries `repo_root`, `nwo`,
`default_branch`, `adapter_path` (from step 3), and `scripts_dir`
(`${CLAUDE_PLUGIN_ROOT}/scripts/common`), plus the instruction to follow its agent definition and
end with its JSON result block.

The audit runs an install per pin it tests, so it is not instant. Say so before dispatching.

## 5. Report

Parse the agent's fenced JSON result. **An unparseable or missing result block is a failure
report** — say so; never guess fields. Present its findings as a table:

> | Pin | Scope | Value | Without the pin | Advisories | Finding |

Then, in order:

- **Removable** pins: what to delete, and the version that resolves instead.
- **Still required** pins: the advisory range that still admits the version that would resolve.
- **Inconclusive** and **not tested** pins: why, so the user knows what was not established. A pin
  reported as `no-advisories` is not a pin proven safe.
- **Not a version pin**: aliases, patches, workspace and git targets, npm `"$pkg"` references.
  These are not stale pins; they are how the repository gets a different package or a patched one.

This phase is **report-only**. Do not remove any pin, do not open a PR, and do not offer to —
removal PRs graduate in a later minor
([#7](https://github.com/SurveyMonkey/skills/issues/7)). The user acts on the findings.
