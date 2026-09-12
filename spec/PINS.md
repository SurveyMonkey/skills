# Prose pin inventory

Issue #197. A **prose pin** is a shellspec `It` example that greps a SKILL.md, agent
definition, or command file for a phrase or count (`phrase_in`, `count_in`, `rule_in`, or an
ad hoc `grep`/`awk` against one of those files), rather than exercising real script behavior.
See `.claude/skills/testing/SKILL.md`, "Prose pins", for the rule this inventory applies.

Every pin below carries one of two tags:

- **`judgment`** — prose *is* the implementation here (the approval boundary, the
  interruption contract, consent gates, `env_prefix` read from session context, and
  similarly irreducible calls). These stay. Every surviving `judgment` pin has been checked
  against the testing skill's review checklist (title vs. assertion, dialect-safe pattern,
  specific enough that a regression could not keep it green); fixes made during that pass are
  listed in the PR description, not here.
- **`mechanical`** — a rule over JSON or script behavior that a script could execute instead
  of an agent re-deriving it from prose every run. Each mechanical pin names the script that
  absorbs its rule. **A mechanical pin is deleted, never kept, the moment its successor script
  lands** — it is never kept beside the executable example as a second source of truth.

## Marker and grep

Every mechanical pin carries a one-line comment directly above its `It` line, in exactly this
grammar:

```
# pin: mechanical, retired by <script>
```

where `<script>` is one of the seven successor scripts named in issue #193:
`prepare-checkout.sh`, `merge-envelopes.sh`, `preflight-repo.sh`, `build-dispatches.sh`,
`reap-batch.sh`, `summarize-run.sh`, `pr-status.sh --env-prefix`.

The change that lands the equivalent of one of those scripts (the TypeScript port of gh-security,
which took over issue #193; the script name is the mapping key) finds every pin it must delete
with one grep:

```
grep -rn 'pin: mechanical, retired by <script>' spec/
```

`spec/pins_inventory_spec.sh` keeps this file and the markers honest: every
`phrase_in`/`count_in`/`rule_in`-style example either carries the marker or is listed below as
`judgment`, and every marker names one of the seven scripts above.

## Totals

368 pins across 16 files: 284 `judgment`, 84 `mechanical`.

Mechanical pins by successor script:

| Successor script | Pins |
|---|---|
| `prepare-checkout.sh` | 29 |
| `reap-batch.sh` | 22 |
| `summarize-run.sh` | 21 |
| `build-dispatches.sh` | 5 |
| `preflight-repo.sh` | 5 |
| `merge-envelopes.sh` | 1 |
| `pr-status.sh --env-prefix` | 1 |

Each mechanical pin is retired in the same change that lands its successor, which is now a
command in the TypeScript port of gh-security rather than a bash script in this repository;
until then it stays here, marked, as the record of the rule the port must reproduce.

### `spec/resolve_alerts_scope_spec.sh` — 66 pins (42 judgment, 24 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 35 | prescribes running discover-repos.sh | judgment | - |
| 41 | states the rule as the checkouts on disk and nothing else | judgment | - |
| 50 | reads a checkout as the whole scope | judgment | - |
| 56 | reads a plain directory as its immediate checkout roots, non-recursively | judgment | - |
| 64 | forbids the orchestrator from classifying the directory itself | judgment | - |
| 70 | still says scope comes from git rather than from directory names | judgment | - |
| 77 | stops on an empty list with the no-repositories sentence | judgment | - |
| 85 | stops on a non-zero exit because there is no checkout to exclude | judgment | - |
| 93 | reads a symlinked entry once, under its resolved root | judgment | - |
| 102 | treats a git failure as an error rather than an empty scope | judgment | - |
| 111 | makes origin the only source of nwo | mechanical | prepare-checkout.sh |
| 118 | no longer offers a scope override | mechanical | prepare-checkout.sh |
| 125 | no longer tiebreaks git_remote against nwo | mechanical | prepare-checkout.sh |
| 133 | states the non-goal in phase 1 | judgment | - |
| 141 | closes every form the convenience could take | judgment | - |
| 147 | puts cloning on the user | judgment | - |
| 155 | says a partial set of checkouts is the correct scope | judgment | - |
| 174 | carries no $1 | judgment | - |
| 183 | no longer asks what to operate on | judgment | - |
| 204 | no longer mentions the $1 | judgment | - |
| 211 | says there is no org, login, or question left | judgment | - |
| 222 | splits the failure rule by what the script was run for | judgment | - |
| 228 | stops the run on a run-level script | judgment | - |
| 234 | excludes the checkout on a per-checkout script | judgment | - |
| 245 | resolves every checkout before phase 3 | judgment | - |
| 251 | settles branch names and classification before the question | judgment | - |
| 257 | no longer hedges that an offered group may be withdrawn | judgment | - |
| 275 | carries no $1 | judgment | - |
| 282 | no longer speaks of a clone destination | judgment | - |
| 291 | instantiates a path-taking prefix against the checkout itself | judgment | - |
| 301 | resolves env_prefix before detect-scope.sh | mechanical | prepare-checkout.sh |
| 308 | runs detect-scope.sh under the prefix and says why | mechanical | prepare-checkout.sh |
| 317 | wraps every stage of the phase 2 pipeline, not only the first | mechanical | prepare-checkout.sh |
| 324 | runs the phase 2 pipeline once per checkout | mechanical | prepare-checkout.sh |
| 333 | keeps the branch-style verdict per checkout | mechanical | prepare-checkout.sh |
| 340 | applies the flat flag to the checkout whose probe hit, not to the batch | mechanical | prepare-checkout.sh |
| 348 | resolves env_prefix per checkout, so neighbors can differ | judgment | - |
| 355 | withdraws a doomed group before the question is ever asked | judgment | - |
| 361 | presents branch names as final in the phase 4 plan | judgment | - |
| 371 | states the cross-checkout re-rank in the order the deleted script used | mechanical | merge-envelopes.sh |
| 379 | states the exclusion rule once | judgment | - |
| 385 | continues with the others and stops only when none survive | judgment | - |
| 392 | reads a lone excluded checkout as the old report-and-stop | judgment | - |
| 401 | excludes a checkout with no usable origin | mechanical | prepare-checkout.sh |
| 408 | excludes a checkout whose default branch is null | mechanical | prepare-checkout.sh |
| 418 | makes a classify failure a stop for the repo, not the run | mechanical | prepare-checkout.sh |
| 426 | reports every excluded checkout by name in phase 2 | judgment | - |
| 433 | re-reports every excluded checkout in the phase 7 summary | mechanical | summarize-run.sh |
| 443 | excludes the checkout on a twice-failed probe, with its stderr | mechanical | prepare-checkout.sh |
| 450 | never turns a failed probe into an origin-unreachable diagnosis | mechanical | prepare-checkout.sh |
| 457 | no longer diagnoses a failed probe as an unreachable origin | mechanical | prepare-checkout.sh |
| 467 | lists the discovery and routing scripts among the exclusion causes | mechanical | prepare-checkout.sh |
| 474 | excludes a repo whose adapter detect fails in phase 5 | mechanical | preflight-repo.sh |
| 481 | carries the registry exclusions into the phase 8 closing report | mechanical | summarize-run.sh |
| 490 | reads PR status once per repo, under that repo prefix | mechanical | pr-status.sh --env-prefix |
| 500 | omits the column for one checkout and shows it for several | judgment | - |
| 506 | no longer keys the column on a scope mode | judgment | - |
| 515 | grants discover-repos.sh | mechanical | prepare-checkout.sh |
| 523 | grants the ls-remote namespace probe | mechanical | prepare-checkout.sh |
| 540 | grants no $1 | mechanical | prepare-checkout.sh |
| 549 | branches on a null scope | judgment | - |
| 555 | drops the git_remote cross-check it can no longer make | judgment | - |
| 561 | stops on a null nwo | judgment | - |
| 571 | re-runs detect-scope against the checkout the user names | judgment | - |
| 577 | reads the second output rather than the first | judgment | - |
| 585 | stays repo-scoped in the checkout vocabulary | judgment | - |

### `spec/resolve_alerts_branch_style_spec.sh` — 9 pins (3 judgment, 6 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 34 | prescribes one fully-qualified ls-remote probe at the one resolution point | mechanical | prepare-checkout.sh |
| 45 | maps a refs/heads/fix hit onto --branch-style flat at every consuming site | mechanical | prepare-checkout.sh |
| 52 | gives the probe the registry preflight retry | mechanical | prepare-checkout.sh |
| 63 | excludes a checkout whose probe fails twice, reporting the probe stderr rather than a diagnosis | mechanical | prepare-checkout.sh |
| 70 | names the unprobed inverse collision instead of claiming coverage | mechanical | prepare-checkout.sh |
| 77 | reports every flat-scheme repo in the phase 7 summary | mechanical | summarize-run.sh |
| 85 | consumes either spelling verbatim | judgment | - |
| 96 | carries the field push-rejection specimen verbatim | judgment | - |
| 102 | forbids improvising a branch name at push time | judgment | - |

### `spec/audit_pins_scratch_spec.sh` — 7 pins (7 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 30 | names the package-qualified path three times: inventory, write, consume | judgment | - |
| 36 | writes the why capture to a package-qualified path | judgment | - |
| 43 | passes the same package-qualified path to score-merge-risk.sh | judgment | - |
| 53 | has no remaining unqualified why.json literal | judgment | - |
| 64 | states the slash-to-dash slug rule for a scoped package name | judgment | - |
| 70 | gives the slug rule the concrete scoped-package example | judgment | - |
| 80 | grounds the slug rule in scoring many packages in the same WORK | judgment | - |

### `spec/resolve_alerts_dispatch_spec.sh` — 67 pins (40 judgment, 27 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 56 | embeds no javascript fence in the skill any more | judgment | - |
| 71 | copies the workflow byte-for-byte from the plugin root before launch | judgment | - |
| 77 | checksums the staged copy against the source before launching | judgment | - |
| 83 | launches the workflow by scriptPath, from the staged checksum-verified copy | judgment | - |
| 93 | rules out the session scratchpad as a staging location | judgment | - |
| 101 | requires the staged copy to survive until the run, and any resume, is done | judgment | - |
| 110 | forbids inlining a copy or hand-editing a variant | judgment | - |
| 116 | explains that the staged, checksum-verified copy is not the forbidden kind | judgment | - |
| 122 | points at the tests as the reason the file is authoritative | judgment | - |
| 140 | states the $1 guarantee once | judgment | - |
| 147 | keeps the reap and the summary outside the script | judgment | - |
| 156 | keeps the sonnet pin in the agent frontmatter ADR 004 names | judgment | - |
| 168 | tells the caller to pass args as JSON, never as a JSON-encoded string | mechanical | build-dispatches.sh |
| 175 | names the silent empty-batch inversion that guard prevents | mechanical | build-dispatches.sh |
| 193 | still carries $1 | mechanical | build-dispatches.sh |
| 202 | still omits env_prefix rather than sending null | mechanical | build-dispatches.sh |
| 213 | says phase 4 approval covers the workflow launch and every agent in it | judgment | - |
| 219 | states plainly that nothing inside the workflow prompts | judgment | - |
| 225 | grants the Workflow tool in the frontmatter | judgment | - |
| 234 | no longer grants the Task tool | judgment | - |
| 257 | no longer carries the $1 | judgment | - |
| 271 | refuses to read an absent or short return as nothing having run | judgment | - |
| 284 | names the $1 mode | judgment | - |
| 291 | names the journal as the record of what actually returned | judgment | - |
| 297 | resumes from the runId rather than re-dispatching the batch | judgment | - |
| 303 | says a plain relaunch duplicates the branches and PRs that already succeeded | judgment | - |
| 312 | asks before resuming a run the user deliberately interrupted | judgment | - |
| 318 | reaps the whole dispatch list anyway when resume is impossible or declined | judgment | - |
| 325 | reports groups with no result as unknown rather than as failures | mechanical | summarize-run.sh |
| 331 | is reachable from phase 7, which otherwise keys on one entry per group | judgment | - |
| 340 | reads phase 7 off the returned entries rather than a fence | mechanical | summarize-run.sh |
| 347 | treats a null entry as that group failure report, still reported | mechanical | reap-batch.sh |
| 354 | reaps a null entry with an empty result file so post-agent.sh reports it missing | mechanical | reap-batch.sh |
| 361 | never drops, hand-retries, or counts a null or mispaired entry as a success | mechanical | reap-batch.sh |
| 370 | handles a mispaired entry exactly like a null one | mechanical | reap-batch.sh |
| 377 | never reads a mispaired entry pr_url or branch | mechanical | reap-batch.sh |
| 383 | says no bounded pool can make the dispatch order repeat | judgment | - |
| 390 | says plainly what the schema cannot check | judgment | - |
| 403 | reports every non-null cleanup alongside the reap accounting | mechanical | summarize-run.sh |
| 410 | singles out a success whose cleanup failed | mechanical | summarize-run.sh |
| 417 | refuses to report a leaked worktree as a failed group | mechanical | summarize-run.sh |
| 426 | relates cleanup to post-agent.sh left_behind rather than duplicating it | mechanical | summarize-run.sh |
| 433 | keeps left_behind as the key and cleanup as the explanation | mechanical | summarize-run.sh |
| 440 | names the case where the reap cleared what the agent could not | mechanical | summarize-run.sh |
| 450 | never gates the reap on cleanup being null | mechanical | reap-batch.sh |
| 457 | says a leaked success is the group that most needs reaping | mechanical | reap-batch.sh |
| 467 | warns that the same directory is not the same string | mechanical | summarize-run.sh |
| 474 | names the consequence of comparing the two as text | mechanical | summarize-run.sh |
| 481 | prescribes suffix matching or resolution before comparing | mechanical | summarize-run.sh |
| 488 | reports one artifact when the two agree, showing the resolved path | mechanical | summarize-run.sh |
| 501 | still writes the worktree exclude once per repo, before any dispatch for it | mechanical | preflight-repo.sh |
| 508 | still gives the registry preflight one retry before it means anything | mechanical | preflight-repo.sh |
| 514 | still keeps repo-global git state with the orchestrator while agents are in flight | judgment | - |
| 520 | still allows two lines of the same package to run together | judgment | - |
| 533 | ties the reap to the result being in hand, not to a completion notification | mechanical | reap-batch.sh |
| 540 | no longer claims in scripts/CLAUDE.md that the reap runs on each completion | mechanical | reap-batch.sh |
| 547 | keeps the never-prune rule in scripts/CLAUDE.md on the entitlement, not the timing | judgment | - |
| 553 | keeps the never-prune rule in reap-agent-artifacts.sh on the entitlement too | judgment | - |
| 559 | records the widened pull-request read window in ADR 003 | judgment | - |
| 568 | no longer describes the fix agent as running from a rolling pool | judgment | - |
| 575 | describes the dispatch as a capacity-bounded workflow instead | judgment | - |
| 581 | keeps the headline bullet on the same mechanism | judgment | - |
| 593 | says the plugin scripts keep their bash, jq and gh constraint | judgment | - |
| 599 | rests the decision on the harness already being node | judgment | - |
| 605 | names the toolchain as a dev and CI dependency, not a user-facing one | judgment | - |
| 613 | scopes the scripts dependency rule to what runs on a user machine | judgment | - |
| 619 | forbids a plugin script from calling into the workflow file | judgment | - |

### `spec/audit_pins_rules_spec.sh` — 56 pins (53 judgment, 3 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 103 | requires the combined test before any PR | judgment | - |
| 112 | puts the individually-tested pins in attempt 1 | judgment | - |
| 121 | fails an attempt closed on a partially-read map | judgment | - |
| 129 | narrows attempt 2 by dropping the individually-tested pins | judgment | - |
| 139 | restores the tree between the two attempts | judgment | - |
| 148 | verifies the edits landed before the combined install | judgment | - |
| 158 | routes a failed combined install to the compose phase | judgment | - |
| 167 | routes a broken advisory lookup to the advisories phase, not a failed attempt | judgment | - |
| 178 | forbids the agent from merging its own PR or arming auto-merge | judgment | - |
| 184 | creates the PR on the plugin-owned head | judgment | - |
| 194 | passes no --draft, anywhere | judgment | - |
| 203 | refuses to default the mode | judgment | - |
| 211 | stops report mode before the PR phases | judgment | - |
| 222 | leases the push against the verified sha, not the tracking ref | judgment | - |
| 231 | verifies a remnant against a closed PR head before touching it | judgment | - |
| 240 | does not silence the branch delete | judgment | - |
| 251 | forbids bypassing a repository hook on commit or push (#78) | judgment | - |
| 257 | makes a hook failure a failure result rather than something to edit around (#78) | judgment | - |
| 265 | defines --after when a removal admits several versions (#79a) | judgment | - |
| 273 | rules on a platform-binary collateral fan-out (#79b) | judgment | - |
| 279 | requires the sampled verdict to say it sampled (#79b) | judgment | - |
| 289 | validates the manifest after the edit, before list_pins (#79c) | judgment | - |
| 295 | templates a direct-commit provenance ref (#79d) | judgment | - |
| 303 | keeps still-required findings out of left_behind, in the schema (#81) | judgment | - |
| 309 | says the same in the PR body template (#81) | judgment | - |
| 315 | states the element type of fixed_alerts (#81) | judgment | - |
| 323 | says no worktree is created at the workspace root (#79) | judgment | - |
| 356 | passes no --draft, anywhere in render-pr.sh | judgment | - |
| 362 | still builds the gh pr create call, so the absence above is about the flag | judgment | - |
| 368 | fix-dependency.md calls render-pr.sh create, rather than re-deriving gh pr create itself | judgment | - |
| 377 | forbids merging its own PR or arming auto-merge | judgment | - |
| 392 | stops before phase 4 on a peer_only package | judgment | - |
| 398 | names the classification peer_only_dependency in the failure detail | judgment | - |
| 404 | reports the failure at phase classify | judgment | - |
| 410 | quotes peer_parents in the failure detail | judgment | - |
| 420 | steers the remedy at required peer parents, not optional ones | judgment | - |
| 438 | $1 | judgment | - |
| 448 | records the hook distinction in ADR 006 (#78) | judgment | - |
| 466 | offers it first in $1 | judgment | - |
| 483 | checks for open security-labeled PRs before asking the mode question | judgment | - |
| 489 | stops rather than proceeding when open security PRs exist | judgment | - |
| 502 | offers no proceed-anyway option | judgment | - |
| 515 | no longer builds an audit-pins Task dispatch in resolve-alerts | judgment | - |
| 531 | mentions audit-pins exactly twice: the phase 7 lead and the phase 8 pointer | judgment | - |
| 537 | points the phase 7 unscoped-override lead at /gh-security:audit-pins | judgment | - |
| 543 | carries the phase 8 pointer sentence to /gh-security:audit-pins | judgment | - |
| 572 | states the one env_prefix rule in $1 | judgment | - |
| 582 | runs bare when env_prefix is absent, per $1 | judgment | - |
| 592 | declares env_prefix OPTIONAL in the input contract of $1 | judgment | - |
| 612 | takes the prefix from session context in $1 | judgment | - |
| 623 | carries env_prefix into the fix-dependency Task payload | mechanical | build-dispatches.sh |
| 630 | runs a registry preflight probe once per repo before phase 6 dispatch | mechanical | preflight-repo.sh |
| 641 | composes the probe as cd repo_root, then env_prefix, in every snippet | mechanical | preflight-repo.sh |
| 649 | carries env_prefix into the audit-pins Task payload in commands/audit-pins.md | judgment | - |
| 664 | is stated in the audit agent | judgment | - |
| 670 | is stated in the fix agent | judgment | - |

### `spec/reap_agent_artifacts_spec.sh` — 24 pins (8 judgment, 16 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 544 | prescribes one post-agent.sh call carrying the --result and --repo-root arguments | mechanical | reap-batch.sh |
| 551 | passes package, major-line, and branch from the group'"'"'s own dispatch payload | mechanical | reap-batch.sh |
| 562 | invokes the script from exactly one command block | mechanical | reap-batch.sh |
| 569 | keeps the allowed-tools list accurate | mechanical | reap-batch.sh |
| 580 | no longer names reap-agent-artifacts.sh as a call site of its own | mechanical | reap-batch.sh |
| 588 | no longer prescribes a bare pr-status.sh call inside the reap step | mechanical | reap-batch.sh |
| 604 | still defines <package_path> in the agent workspace definition (untouched by the collapse) | judgment | - |
| 610 | never interpolates the raw package name into a worktree path in either document | judgment | - |
| 625 | verifies the pull request before reaping anything | mechanical | reap-batch.sh |
| 636 | makes exactly one post-agent.sh call per returned entry | mechanical | reap-batch.sh |
| 643 | reaps only on an OPEN pull request | mechanical | reap-batch.sh |
| 653 | never reaps an agent that ended without a verified open PR | mechanical | reap-batch.sh |
| 660 | carries on to the next entry even when the reap could not finish | mechanical | reap-batch.sh |
| 671 | says env_prefix reaches the PR read inside the call and never the reap | mechanical | reap-batch.sh |
| 682 | never lets a reap that printed nothing stall the run either | mechanical | reap-batch.sh |
| 691 | reports the reaped count and everything left in place, from the script'"'"'s own reports | mechanical | summarize-run.sh |
| 698 | says a leftover is recoverable only if the summary names it | mechanical | summarize-run.sh |
| 707 | says nothing here recomputes a path or branch from a template | mechanical | summarize-run.sh |
| 717 | reads a surviving work directory as a failed, crashed, or foreign run | judgment | - |
| 723 | keeps the guard from clearing it anyway | judgment | - |
| 731 | keeps agent Cleanup as the first line of defense | judgment | - |
| 737 | says the reap covers only the verified-PR exit path | judgment | - |
| 748 | tells the agent the reap re-checks only the origin tip, a narrower test | judgment | - |
| 754 | does not promise a deliberately left branch is reaped later | judgment | - |

### `spec/resolve_alerts_defect_reports_spec.sh` — 25 pins (25 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 26 | states the check-first-then-file-or-comment practice | judgment | - |
| 32 | runs the search against this repository, not the target | judgment | - |
| 38 | searches closed issues too, since a fixed-and-closed defect is still a hit | judgment | - |
| 44 | names the search itself as the reachability probe for the identity question | judgment | - |
| 50 | treats a second sighting as confirmation, not noise | judgment | - |
| 56 | requires the run'"'"'s own concrete evidence in the report | judgment | - |
| 62 | excludes target-repo defects from this path | judgment | - |
| 70 | forbids naming the target repository, owner, org, or topology | judgment | - |
| 78 | gates filing on the user'"'"'s go-ahead, or a prior in-session authorization | judgment | - |
| 84 | requires the closing report to say what was filed or proposed | judgment | - |
| 92 | resolves the reporting identity separately from the batch identity | judgment | - |
| 98 | names the EMU case as barred from contributing here | judgment | - |
| 104 | allows switching to a discoverable capable account under the same consent | judgment | - |
| 110 | never invents a switched identity silently | judgment | - |
| 116 | hands the drafted report to the user when no capable account resolves | judgment | - |
| 124 | scopes the prohibition to what this run did to pull requests | judgment | - |
| 130 | says the prohibition does not withdraw the defect-report offer | judgment | - |
| 138 | states the closing report carries the filing outcome when Filing a skill-defect report applied | judgment | - |
| 144 | covers both the filed.or-proposed issue and the hand-back-to-the-user case | judgment | - |
| 152 | grants gh issue list | judgment | - |
| 158 | grants gh issue create | judgment | - |
| 164 | grants gh issue comment | judgment | - |
| 172 | points at the same practice for a contract-violation-shaped defect | judgment | - |
| 178 | gives a readable path to resolve-alerts/SKILL.md | judgment | - |
| 184 | refers to the named Filing a skill-defect report section, not "Phase 7" generally, and says to read it first | judgment | - |

### `spec/merge_risk_labels_spec.sh` — 17 pins (17 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 40 | creates merge-risk:$1 with the pinned color and description | judgment | - |
| 55 | creates $2 with color $3 | judgment | - |
| 70 | documents $1 as $2 (#$3) | judgment | - |
| 78 | documents \`dependencies\` as \`#0366d6\` | judgment | - |
| 99 | names exactly low, medium, and high in audit-pins.md, never a fourth | judgment | - |
| 107 | never uses a bare risk: prefix in fix-dependency.md, which would read as alert severity | judgment | - |
| 113 | never uses a bare risk: prefix in audit-pins.md, which would read as alert severity | judgment | - |
| 121 | calls render-pr.sh labels with --repo and --band | judgment | - |
| 127 | calls render-pr.sh create with --band | judgment | - |
| 135 | builds --label security --label dependencies --label "merge-risk:..." in its gh pr create argv | judgment | - |
| 143 | builds no --draft flag anywhere in its gh pr create argv | judgment | - |
| 151 | adds the label only when pr.risk.band is non-null | judgment | - |
| 157 | says a null band gets no risk label, never a fake one | judgment | - |
| 165 | treats "already exists" in gh label create output as success, not an error | judgment | - |
| 171 | says creating a label is a deliberate write of repo metadata beyond the PR itself | judgment | - |
| 179 | treats a gh label create failing because the label now exists as success, not an error | judgment | - |
| 185 | says creating a label is a deliberate write of repo metadata beyond the PR itself | judgment | - |

### `spec/classify_lines_spec.sh` — 6 pins (0 judgment, 6 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 876 | pipes phase 2 discovery through classify-lines.sh at one venue | mechanical | prepare-checkout.sh |
| 885 | pins classification to origin/<default_branch> | mechanical | prepare-checkout.sh |
| 895 | names a classify failure a stop, never a cue to drop --base-ref | mechanical | prepare-checkout.sh |
| 902 | withdraws a requires_major_bump group in phase 2, before the question is asked | mechanical | prepare-checkout.sh |
| 909 | never offers a requires-major-bump group as a rankable row in phase 3 | mechanical | prepare-checkout.sh |
| 918 | reports both requires_major_bump senses together in phase 7 | mechanical | summarize-run.sh |

### `spec/fix_dependency_result_spec.sh` — 29 pins (29 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 34 | states the rule that a step is expected to terminate | judgment | - |
| 40 | treats an unreturned or repeatedly-failing verb as a failed phase | judgment | - |
| 46 | prescribes the 10-minute foreground timeout for the installing steps | judgment | - |
| 52 | prescribes the 2-minute foreground timeout for the read-only steps | judgment | - |
| 58 | scopes the repeated-failure rule to no remediation in between attempts | judgment | - |
| 66 | names the driver ladder and its one retry as the whole retry budget | judgment | - |
| 72 | treats kill-it-and-fail-closed as applying only to a timed-out verb | judgment | - |
| 78 | says an already-OOMed or non-zero-exited verb is already dead | judgment | - |
| 84 | forbids backgrounding a hung step | judgment | - |
| 90 | forbids attaching a monitor and waiting on it | judgment | - |
| 96 | cites the field failure the rule was written to prevent | judgment | - |
| 104 | requires cleanup on an abort for a hung or failing step | judgment | - |
| 110 | says killing a hung step does not excuse cleanup | judgment | - |
| 116 | says ending the turn without a result block is never valid | judgment | - |
| 122 | names a parked or waiting message as a contract violation | judgment | - |
| 130 | reads a missing result block as a contract violation, not a wait | judgment | - |
| 147 | carries cleanup as a required field in the result schema | judgment | - |
| 153 | names cleanup as the one exception to the exit-3 mapping | judgment | - |
| 159 | maps a cleanup exit 3 by what shipped, not by the exit code | judgment | - |
| 165 | keeps the PR on a cleanup failure when a PR was opened | judgment | - |
| 171 | still fails at worktree when no PR was opened | judgment | - |
| 178 | says a failure result would hide the PR and suppress the reap | judgment | - |
| 184 | requires the field on every result, null only on a clean cleanup | judgment | - |
| 190 | forbids summarizing the report into detail and leaving the field null | judgment | - |
| 196 | exempts cleanup from the fields a failure result nulls | judgment | - |
| 203 | qualifies the not-a-failure rule with whether the work shipped | judgment | - |
| 209 | says a cleanup failure with nothing shipped is a worktree failure | judgment | - |
| 217 | lists the failure phase enum without a commit member | judgment | - |
| 223 | routes a phase-6 hook commit failure to push, matching audit-pins | judgment | - |

### `spec/fix_dependency_baseline_spec.sh` — 12 pins (10 judgment, 2 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 32 | spells the drift-commit subject exactly once, as one constant | judgment | - |
| 38 | grounds the post-control ordering in the attribution it protects | judgment | - |
| 44 | keeps the never-stage-package.json rule beside the staging code | judgment | - |
| 50 | preserves residual porcelain as evidence rather than absorbing it | judgment | - |
| 56 | reports a control-install failure as phase baseline, never phase install | judgment | - |
| 66 | sanctions one retry per install invocation, on a registry-timeout shape only | judgment | - |
| 72 | keeps the drift-cleared subcase a real fix, not a no-op | judgment | - |
| 80 | names the baseline failure as ambient rather than group-specific | judgment | - |
| 86 | keeps the hook rules governing the drift commit too | judgment | - |
| 92 | carries lockfile-refresh in the result action enum | judgment | - |
| 101 | recognizes a lockfile-refresh action | mechanical | summarize-run.sh |
| 111 | routes every ambient baseline failure shape to one repo-level triage label | mechanical | summarize-run.sh |

### `spec/fix_dependency_branch_spec.sh` — 13 pins (13 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 35 | calls the driver for setup rather than prescribing the guard | judgment | - |
| 41 | calls the driver for cleanup rather than prescribing the delete | judgment | - |
| 49 | gates the delete on it being provably safe | judgment | - |
| 55 | says an unrecreatable commit is what the leave-behind protects | judgment | - |
| 63 | still forbids repository-wide git commands | judgment | - |
| 71 | names the driver as the single home of phases 1 to 5 | judgment | - |
| 89 | grounds $1 | judgment | - |
| 99 | no longer says the branch simply remains | judgment | - |
| 105 | no longer stops on the mere existence of a local branch | judgment | - |
| 120 | no longer prescribes $1 | judgment | - |
| 132 | amends the guard decision | judgment | - |
| 138 | retires the base worktree | judgment | - |
| 144 | says one tree is installed, not two | judgment | - |

### `spec/fix_dependency_scratch_spec.sh` — 10 pins (10 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 36 | says the session scratchpad is shared with agents running beside you | judgment | - |
| 43 | still states the WORK-not-tmp rule the shared-scratchpad sentence extends | judgment | - |
| 52 | names the predictable-filename hazard, not just cleanup deletion | judgment | - |
| 65 | generalizes to every scratch file and confines all of them to WORK | judgment | - |
| 76 | scopes the qualified-name requirement to collision-prone files, not every artifact | judgment | - |
| 83 | carves the fixed-purpose shim out of the qualified-name requirement | judgment | - |
| 92 | keeps the sibling-collision warning in the corepack-shim bullet | judgment | - |
| 98 | keeps the collision rationale naming the shared parallel directory | judgment | - |
| 113 | has no remaining unqualified why.json literal | judgment | - |
| 119 | no longer prescribes a why-capture redirect of its own | judgment | - |

### `spec/env_prefix_seam_spec.sh` — 21 pins (21 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 45 | defines env_prefix opaquely in $2 | judgment | - |
| 52 | gives the convention document the seam as its section title | judgment | - |
| 58 | makes where a prefix comes from the environment, not the plugin | judgment | - |
| 64 | says the plugin never names a manager, probes, or invents a prefix | judgment | - |
| 75 | scopes the opacity to the agent rather than to the dispatcher | judgment | - |
| 81 | says the dispatcher resolves once and nothing re-derives afterwards | judgment | - |
| 91 | says so once, in phase 1 | judgment | - |
| 97 | says so in the audit-pins command | judgment | - |
| 107 | instantiates a path-taking prefix against the checkout itself | judgment | - |
| 116 | gives phase 1 a recognition cue for what counts as a statement | judgment | - |
| 130 | keeps the run-bare rule in the $2 agent | judgment | - |
| 136 | keeps the verbatim rule in the $2 agent | judgment | - |
| 145 | tells the $2 agent the prefix is opaque to it specifically | judgment | - |
| 153 | keeps the builtin prohibition in the $2 agent | judgment | - |
| 159 | points the $2 agent at the renamed convention section | judgment | - |
| 167 | keeps the injects-not-chdir sentence in phase 1 | judgment | - |
| 175 | keeps the cd load-bearing in the registry preflight | judgment | - |
| 181 | keeps the composed probe shapes opaque | judgment | - |
| 195 | states it manager-agnostically in $2 | judgment | - |
| 205 | names a missed context statement as a cause of those symptoms | judgment | - |
| 211 | sends the reader back to session context on any of them | judgment | - |

### `spec/testing_skill_spec.sh` — 3 pins (3 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 170 | anchors its paths glob the way every other rule in this repo does | judgment | - |
| 182 | names the skill it points at | judgment | - |
| 197 | links from the root CLAUDE.md to the New script section | judgment | - |

### `spec/node_apply_constraint_spec.sh` — 3 pins (3 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 1277 | has a definition that treats source unsupported as a known limit, not a warning | judgment | - |
| 1283 | has a definition that keeps the warning for a lockfile-backed source | judgment | - |
| 1314 | has a definition that rejects such a value rather than opening a PR on it | judgment | - |