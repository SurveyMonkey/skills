---
description: >
  Deprecated: use /gh-security:resolve-alerts. Fixes the single top-ranked
  group of Dependabot alerts for the current repo, exactly as before, then
  offers the next batch. This shim will be removed in a future release.
---

`/gh-security:fix-alert` is a deprecation shim. Before doing anything else, print this notice
verbatim:

> **`/gh-security:fix-alert` is deprecated** and will be removed in the first release cut at
> least two months after v0.3.0 shipped. Use `/gh-security:resolve-alerts`, or simply ask Claude
> to fix this repo's security alerts. Continuing with the previous behavior: fixing the single
> top-ranked package.

Then read `${CLAUDE_PLUGIN_ROOT}/skills/resolve-alerts/SKILL.md` and execute it exactly, with one
change: in its Phase 3, do **not** ask how much to fix — the answer is pre-supplied as **One**
(fix only the top-ranked group). Still present the ranked table so the user sees what was chosen
and what remains, then continue directly to Phase 4. Every other part of the skill runs
unchanged, including the dispatch-plan approval, the mark-ready decision flow, and the
next-batch offer.
