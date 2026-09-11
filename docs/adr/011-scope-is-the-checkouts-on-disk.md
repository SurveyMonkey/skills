---
type: ADR
description: resolve-alerts takes its scope from the checkouts already on disk (the current repository, or every repository checked out directly under the current directory) and never clones; org and user API discovery and the clone phase are removed.
status: stable
created: 2026-09-11
owner: brianespinosa
related_issues: [188, 37]
---

# ADR 011: Scope is the checkouts on disk, and the skill never clones

Amends RFC 001's Phase 3 ([#6](https://github.com/SurveyMonkey/skills/issues/6)), which added org
and user scope over the GitHub API, and the clone phase the orchestrator grew to make that scope
actionable. It leaves standing everything those phases sat on top of: worktree isolation and the
per-machine concurrency cap ([ADR 003](003-worktree-isolation-and-concurrency-cap.md)), the single
batch approval and the no-touching-a-PR-afterwards rule
([ADR 008](008-prs-open-ready-for-review.md)), and every read-only reporting skill elsewhere in
this marketplace, which is not what this ADR is about. `discover-alerts.sh` keeps its alert
discovery, grouping, ranking and PR-checking; `detect-scope.sh` keeps its job of reading a
checkout's facts. What changes is where the set of repositories in a run comes from.

## Context

`resolve-alerts` is not a reporting skill. Every group it acts on needs a git worktree, a
dependency install, a commit and a push, so the repositories it can finish work in are the
repositories that exist on the machine. Scope, however, was answered somewhere else: from the
GitHub API. `detect-scope.sh` answered `repo` inside a checkout and `null` outside one, a null
answer triggered a three-option question (this org, my repos, one named repo), and
`discover-alerts.sh --scope org|user` then went to the aggregate org endpoint, fell back to
per-repo enumeration on a 403, or fanned out over `GET /user/repos`, filtering for push access
and dropping forks and archived repositories into a reported `skipped_repos` list.

The API answered a wider question than the skill could act on, and a whole phase existed to close
the gap. Phase 5 (roughly 122 lines of SKILL.md) cloned whatever was missing into a destination the
user was asked about once per run, either a directory they named or a `mktemp -d` one, and phase 7
decided whether that temporary directory could be `rm -rf`'d, which it could only be when every
group in it had opened a pull request. Four tool grants existed for no other reason:
`gh repo clone`, `git -C * fetch` (whose only caller was that phase's
`git -C <repo_root> fetch origin`), `mktemp -d -t gh-security-clones*`, and
`rm -rf *gh-security-clones*`.

Making the API's answer true on disk cost more than the coverage it bought:

- **`env_prefix` was resolved twice**, once at phase 1 for repo scope and again per repository in
  phase 5, where the second resolution carried a hazard that had to be written down: instantiate
  against the destination directory and never the checkout path, because at that moment the
  checkout does not exist yet.
- **Clones landed outside every workspace directory.** A checkout under a temporary directory sits
  where directory-scoped credentials do not apply, which is a documented failure mode with two
  observed shapes: a fetch reporting the repository as missing, and an install returning 401
  against the wrong registry.
- **The approved plan was provisional.** Reconciliation happened after approval, so a field run had
  an approved group withdrawn in phase 5 as `requires major version bump` because the resolved
  major sat below the fix line. The user approved work that could never be done.
- **Two code paths had to be tested**, and the cross-repo one needed API fixtures standing in for
  repositories that do not exist locally, which is the branch least able to be exercised for real.

Issue [#37](https://github.com/SurveyMonkey/skills/issues/37) is the same shape from the other
direction: the org-scope 403 fallback was never once exercised against a real 403.

## Decision

**Scope is the set of checkouts on disk.** A new `discover-repos.sh [path]` answers it: if the
target is inside a git repository, that checkout root is the scope; otherwise the scope is every
immediate, non-dot subdirectory that is itself a checkout root, resolved through symlinks and
never recursed into. It outputs `{"target": ..., "repos": [...]}`. No repositories is exit 0 with
an empty list, and the skill stops there.

**Nothing is cloned, ever.** This is a standing non-goal, not a default: no auto-clone now or
later, not behind a flag and not as an opt-in destination. A user who wants a repository in scope
clones it themselves, which is what they would do anyway to review the resulting pull request.

`detect-scope.sh` is unchanged; what narrows is its use here, to reading one checkout's facts, its
`nwo` and `default_branch`, once per checkout discovery returned. `discover-alerts.sh` becomes
repo-only. Its `--scope` flag, the org and user endpoint paths, the push-access filtering and the
`skipped_repos` output all go.

**Everything that can withdraw a group runs before the ranked table.** The orchestrator runs
discovery, `env_prefix` resolution, the branch-namespace probe and `classify-lines.sh` once per
checkout before it presents anything to the user, so the plan the user approves is final: no
provisional branch names, and no group withdrawn after approval. A checkout with no usable origin,
no resolvable default branch, or a failed probe is reported by name and excluded, and the run
continues with the others.

Phase numbering is kept rather than compacted. Phase 5 becomes the per-repository pre-dispatch
step, the worktree-exclude write and the registry probe that previously opened phase 6.

## Consequences

**Three code paths, one question and four tool grants leave the skill.** The clone phase,
the three-option scope question, the org and user discovery paths and the `skipped_repos` contract
are all removed, along with the double `env_prefix` resolution and its destination-versus-checkout
hazard, the temp-directory credential failure mode, and the phase 7 decision about whether a
temporary directory may be deleted. Roughly 20 scope-conditional passages and 22 clone or `mktemp`
mentions leave SKILL.md, and the plugin's permission surface loses four grants: `gh repo clone`,
`git -C * fetch`, `mktemp -d -t gh-security-clones*` and `rm -rf *gh-security-clones*`.

**`classify-lines.sh` keeps its `--branch-style` flag.** The orchestrator now hands the style to
discovery directly, so nothing in this flow reaches the classifier without it, but a caller that
learns the namespace verdict only after discovery can still convert the names it already has; under
the default style the rewrite is a no-op.

**What is left is testable with directories.** One code path, exercised against real checkouts on a
real filesystem, instead of two where the second needs invented API fixtures for repositories that
do not exist.

**An organization with 40 repositories and 6 local checkouts has 6 repositories in scope, and that
is the correct answer**, not a shortfall. The other 34 were never repositories this skill could
carry through to a pull request without first making them local, and making them local is the
user's decision to make.

**[#37](https://github.com/SurveyMonkey/skills/issues/37) closes because the path it describes no
longer exists**, and the gaps [#40](https://github.com/SurveyMonkey/skills/issues/40) recorded,
already closed, are moot for the same reason.

**This says nothing about reporting skills.** A read-only report can legitimately go org-wide over
the API, and the argument here does not reach it: the constraint is that a run producing a commit
takes its scope from disk. Nothing in this marketplace changes on that account.

**It also does not fix [#187](https://github.com/SurveyMonkey/skills/issues/187)**, the hardcoded
unqualified agent type in `workflows/fix-groups.mjs`. That defect fails identically at repo scope
and is untouched here.

**This partly reverses RFC 001 Phase 3 on purpose**, and it continues
[#134](https://github.com/SurveyMonkey/skills/issues/134), which already moved scope off directory
names and onto git. Phase 3 read scope from an API instead; this reads it from the working copies
that same API was being used to reason about.
