---
type: ADR
description: The fix-dependency subagent is pinned to sonnet, the orchestrator inherits the session model, and criteria are set for a future Haiku trial.
status: stable
created: 2026-08-20
owner: brianespinosa
related_issues: [5]
---

# ADR 004: Subagent model tiering

Drives [RFC 001](../rfc/001-alert-orchestration.md). Landed in Phase 2
([#5](https://github.com/SurveyMonkey/skills/issues/5)).

## Context

RFC 001 moves the deterministic surface into scripts precisely so subagents can run on a smaller
model than the main session. Phase 2 makes that concrete: `agents/fix-dependency.md` pins a model
in frontmatter, and the orchestrator is a skill, which runs in the main session and cannot pin
one. The question is which model, and what evidence would justify moving.

## Decision

**`fix-dependency` is pinned to `sonnet`.** With discovery, override insertion, lockfile
validation, and risk-band arithmetic all scripted, the judgment that remains is interpreting
install failures, triaging failing repo scripts, and attributing failures to the update or to
pre-existing breakage via the base-branch comparison. That triage is exactly where a too-small
model produces confident nonsense, and the attribution call is the single highest-value judgment
the agent makes; Haiku was considered and rejected for it.

**The orchestrator inherits the session model.** Skills cannot pin one. With endpoint logic,
ranking, capacity, and PR state all script-side, the orchestrator is presentation and routing;
Sonnet is sufficient, and running the session on Opus adds nothing to this flow.

**Haiku re-evaluation criteria.** Dropping the agent to Haiku is a one-line frontmatter change,
to be considered after roughly twenty real fix PRs have shipped, and only if all three hold:

1. No incorrect pre-existing-versus-caused attribution surfaced in review of those PRs.
2. The overwhelming majority of runs required no failure triage at all — scripts green on the
   first try, the agent exercising only the mechanical path.
3. The failures that did occur were reported cleanly rather than diagnosed — that is, the runs
   where judgment was needed ended in failure reports a human picked up, not in the agent
   reasoning its way to a wrong fix.

If trialed, Haiku takes the narrowest slice first — Low-band direct patch bumps — with `sonnet`
retained for transitives and for anything that reaches the base-branch comparison. The trial
reverts on the first misattribution.

**Amended by [ADR 006](006-merge-risk-is-static-analysis.md).** Agents no longer run a
repository's checks, so the base-branch comparison and the attribution judgment it fed are gone
from the flow entirely. Criteria 1 and 3 above describe work that no longer happens and no longer
apply; criterion 2 is subsumed by them. The re-evaluation reduces to a single test: **no wrong
override shape in twenty PRs.** The `sonnet` pin itself is unchanged, and now stands on the
judgment that remains: interpreting install failures, choosing between scoped and bare overrides,
and writing the PR prose.

## Consequences

Subagent token cost drops relative to running everything at the session model, which is the
RFC's stated point of the script extraction.

A model pin in frontmatter is a fact about the plugin, not the user's session: users on any
session model get the same subagent behavior, which keeps merge-risk scores comparable across
machines and sessions.

The re-evaluation criteria commit us to actually reviewing attribution quality on real PRs
rather than deciding by vibes. Until that corpus exists, `sonnet` stands.
