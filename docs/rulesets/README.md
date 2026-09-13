---
type: Reference
description: Point-in-time export of the protect-default branch ruleset and how it relates to the gates workflow.
owner: brianespinosa
created: 2026-09-12
stale_after: 2027-03-12
---

# Rulesets

This directory holds a point-in-time export of the repository's `protect-default` ruleset
(GitHub API id `15626085`), the one ruleset this repo carries. It is managed by hand in the
GitHub UI, not as code, so this export is the only record of it in the repository; nothing here
applies it back.

`protect-default.json` was exported with:

```bash
gh api repos/SurveyMonkey/skills/rulesets/15626085 | jq . > docs/rulesets/protect-default.json
```

The export is kept as-is, node ids, timestamps (`created_at`, `updated_at`) and all: stripping
them would make the file harder to diff against a future re-export for no benefit, since nothing
here parses or applies it.

The ruleset's one required status check is the aggregate `gates` job
(`.github/workflows/gates.yml`), pinned to the GitHub Actions app (`integration_id`) so no other
integration can satisfy the context by publishing a status of the same name. Every CI change that
adds or removes a gate touches `gates`' `needs:` list and arity floor, never this ruleset; see the
gate-change checklist in
[ADR 005](../adr/005-quality-gate-venues.md#gate-change-checklist). Re-export this file whenever
the ruleset itself changes.
