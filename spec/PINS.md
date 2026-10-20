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

where `<script>` is a successor script named in issue #193. No successor has open pins now. All
seven are TypeScript commands, and their pins are gone: `prepare-checkout.sh` and
`merge-envelopes.sh` are `prepare-checkout` and `merge-envelopes` (#227), `preflight-repo.sh` and
`build-dispatches.sh` are `preflight-repo` and `build-dispatches` (#228),
`pr-status.sh --env-prefix` is `render-pr-status` (#230), and `reap-batch.sh` and
`summarize-run.sh` are `reap-batch` and `summarize-run` (#229).

The change that lands the equivalent of one of those scripts (the TypeScript port of gh-security,
which took over issue #193; the script name is the mapping key) finds every pin it must delete
with one grep:

```
grep -rn 'pin: mechanical, retired by <script>' spec/
```

`spec/pins_inventory_spec.sh` keeps this file honest: every
`phrase_in`/`count_in`/`rule_in`-style example is listed below as `judgment`, and no spec file
carries the marker. A new mechanical pin needs a new successor script, and a change to that spec.

## Totals

237 pins across 15 files: 237 `judgment`, 0 `mechanical`.

Each mechanical pin was retired in the same change that landed its successor, a command in the
TypeScript port of gh-security. No mechanical pin remains.

### `spec/resolve_alerts_scope_spec.sh`: 37 pins (37 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 41 | prescribes running discover-repos | judgment | - |
| 47 | states the rule as the checkouts on disk and nothing else | judgment | - |
| 55 | forbids the orchestrator from classifying the directory itself | judgment | - |
| 62 | stops on an empty list with the no-repositories sentence | judgment | - |
| 70 | stops on a non-zero exit because there is no checkout to exclude | judgment | - |
| 78 | states the non-goal in phase 1 | judgment | - |
| 86 | closes every form the convenience could take | judgment | - |
| 92 | puts cloning on the user | judgment | - |
| 100 | says a partial set of checkouts is the correct scope | judgment | - |
| 119 | carries no $1 | judgment | - |
| 128 | no longer asks what to operate on | judgment | - |
| 149 | no longer mentions the $1 | judgment | - |
| 156 | says there is no org, login, or question left | judgment | - |
| 167 | splits the failure rule by what the script was run for | judgment | - |
| 173 | stops the run on a run-level script | judgment | - |
| 179 | excludes the checkout on a per-checkout script | judgment | - |
| 190 | resolves every checkout before phase 3 | judgment | - |
| 196 | settles branch names and classification before the question | judgment | - |
| 202 | no longer hedges that an offered group may be withdrawn | judgment | - |
| 220 | carries no $1 | judgment | - |
| 227 | no longer speaks of a clone destination | judgment | - |
| 236 | instantiates a path-taking prefix against the checkout itself | judgment | - |
| 244 | resolves env_prefix per checkout, so neighbors can differ | judgment | - |
| 251 | withdraws a doomed group before the question is ever asked | judgment | - |
| 257 | presents branch names as final in the phase 4 plan | judgment | - |
| 265 | states the exclusion rule once | judgment | - |
| 271 | continues with the others and stops only when none survive | judgment | - |
| 278 | reads a lone excluded checkout as the old report-and-stop | judgment | - |
| 286 | reports every excluded checkout by name in phase 2 | judgment | - |
| 296 | omits the column for one checkout and shows it for several | judgment | - |
| 302 | no longer keys the column on a scope mode | judgment | - |
| 310 | branches on a null scope | judgment | - |
| 316 | drops the git_remote cross-check it can no longer make | judgment | - |
| 322 | stops on a null nwo | judgment | - |
| 332 | re-runs detect-scope against the checkout the user names | judgment | - |
| 338 | reads the second output rather than the first | judgment | - |
| 346 | stays repo-scoped in the checkout vocabulary | judgment | - |

### `spec/resolve_alerts_branch_style_spec.sh`: 1 pins (1 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 29 | forbids improvising a branch name at push time | judgment | - |

### `spec/audit_pins_scratch_spec.sh`: 7 pins (7 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 31 | names the package-qualified path three times: inventory, write, consume | judgment | - |
| 37 | writes the why capture to a package-qualified path | judgment | - |
| 44 | passes the same package-qualified path to score-merge-risk | judgment | - |
| 54 | has no remaining unqualified why.json literal | judgment | - |
| 65 | states the slash-to-dash slug rule for a scoped package name | judgment | - |
| 71 | gives the slug rule the concrete scoped-package example | judgment | - |
| 81 | grounds the slug rule in scoring many packages in the same work directory | judgment | - |

### `spec/resolve_alerts_dispatch_spec.sh`: 36 pins (36 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 60 | embeds no javascript fence in the skill any more | judgment | - |
| 75 | copies the workflow byte-for-byte from the plugin root before launch | judgment | - |
| 81 | checksums the staged copy against the source before launching | judgment | - |
| 87 | launches the workflow by scriptPath, from the staged checksum-verified copy | judgment | - |
| 97 | rules out the session scratchpad as a staging location | judgment | - |
| 105 | requires the staged copy to survive until the run, and any resume, is done | judgment | - |
| 114 | forbids inlining a copy or hand-editing a variant | judgment | - |
| 120 | explains that the staged, checksum-verified copy is not the forbidden kind | judgment | - |
| 126 | points at the tests as the reason the file is authoritative | judgment | - |
| 132 | keeps the reap and the summary outside the script | judgment | - |
| 141 | keeps the sonnet pin in the agent frontmatter ADR 004 names | judgment | - |
| 152 | says phase 4 approval covers the workflow launch and every agent in it | judgment | - |
| 158 | states plainly that nothing inside the workflow prompts | judgment | - |
| 164 | grants the Workflow tool in the frontmatter | judgment | - |
| 173 | no longer grants the Task tool | judgment | - |
| 196 | no longer carries the $1 | judgment | - |
| 210 | refuses to read an absent or short return as nothing having run | judgment | - |
| 223 | names the $1 mode | judgment | - |
| 230 | names the journal as the record of what actually returned | judgment | - |
| 236 | resumes from the runId rather than re-dispatching the batch | judgment | - |
| 242 | says a plain relaunch duplicates the branches and PRs that already succeeded | judgment | - |
| 251 | asks before resuming a run the user deliberately interrupted | judgment | - |
| 257 | reaps the whole dispatch list anyway when resume is impossible or declined | judgment | - |
| 263 | is reachable from phase 7, which otherwise keys on one entry per group | judgment | - |
| 271 | says no bounded pool can make the dispatch order repeat | judgment | - |
| 283 | still keeps repo-global git state with the orchestrator while agents are in flight | judgment | - |
| 291 | keeps the never-prune rule in the plugin guide on the entitlement, not the timing | judgment | - |
| 297 | records the widened pull-request read window in ADR 003 | judgment | - |
| 306 | no longer describes the fix agent as running from a rolling pool | judgment | - |
| 313 | describes the dispatch as a capacity-bounded workflow instead | judgment | - |
| 319 | keeps the headline bullet on the same mechanism | judgment | - |
| 331 | says the plugin scripts keep their bash, jq and gh constraint | judgment | - |
| 337 | rests the decision on the harness already being node | judgment | - |
| 343 | names the toolchain as a dev and CI dependency, not a user-facing one | judgment | - |
| 351 | scopes the scripts dependency rule to what runs on a user machine | judgment | - |
| 357 | forbids the shipped code from importing the workflow file | judgment | - |

### `spec/audit_pins_rules_spec.sh`: 44 pins (44 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 78 | requires the combined test before any PR | judgment | - |
| 88 | routes a failed combined install to the compose phase | judgment | - |
| 97 | routes a broken advisory lookup to the advisories phase, not a failed attempt | judgment | - |
| 108 | forbids the agent from merging its own PR or arming auto-merge | judgment | - |
| 114 | creates the PR on the plugin-owned head | judgment | - |
| 124 | passes no --draft, anywhere | judgment | - |
| 133 | refuses to default the mode | judgment | - |
| 141 | stops report mode before the PR phases | judgment | - |
| 152 | leases the push against the verified sha, not the tracking ref | judgment | - |
| 161 | verifies a remnant against a closed PR head before touching it | judgment | - |
| 170 | does not silence the branch delete | judgment | - |
| 181 | forbids bypassing a repository hook on commit or push (#78) | judgment | - |
| 187 | makes a hook failure a failure result rather than something to edit around (#78) | judgment | - |
| 195 | defines --after when a removal admits several versions (#79a) | judgment | - |
| 205 | requires the sampled verdict to say it sampled (#79b) | judgment | - |
| 211 | templates a direct-commit provenance ref (#79d) | judgment | - |
| 219 | keeps still-required findings out of left_behind, in the schema (#81) | judgment | - |
| 225 | says the same in the PR body template (#81) | judgment | - |
| 231 | states the element type of fixed_alerts (#81) | judgment | - |
| 239 | says no worktree is created at the workspace root (#79) | judgment | - |
| 262 | fix-dependency.md calls render-pr create, rather than re-deriving gh pr create itself | judgment | - |
| 271 | forbids merging its own PR or arming auto-merge | judgment | - |
| 286 | stops before phase 4 on a peer_only package | judgment | - |
| 292 | names the classification peer_only_dependency in the failure detail | judgment | - |
| 298 | reports the failure at phase classify | judgment | - |
| 304 | quotes peer_parents in the failure detail | judgment | - |
| 314 | steers the remedy at required peer parents, not optional ones | judgment | - |
| 332 | $1 | judgment | - |
| 342 | records the hook distinction in ADR 006 (#78) | judgment | - |
| 360 | offers it first in $1 | judgment | - |
| 377 | checks for open security-labeled PRs before asking the mode question | judgment | - |
| 383 | stops rather than proceeding when open security PRs exist | judgment | - |
| 396 | offers no proceed-anyway option | judgment | - |
| 409 | no longer builds an audit-pins Task dispatch in resolve-alerts | judgment | - |
| 425 | mentions audit-pins exactly twice: the phase 7 lead and the phase 8 pointer | judgment | - |
| 431 | points the phase 7 unscoped-override lead at /gh-security:audit-pins | judgment | - |
| 437 | carries the phase 8 pointer sentence to /gh-security:audit-pins | judgment | - |
| 466 | states the one env_prefix rule in $1 | judgment | - |
| 476 | runs bare when env_prefix is absent, per $1 | judgment | - |
| 486 | declares env_prefix OPTIONAL in the input contract of $1 | judgment | - |
| 506 | takes the prefix from session context in $1 | judgment | - |
| 516 | carries env_prefix into the audit-pins Task payload in skills/audit-pins/SKILL.md | judgment | - |
| 531 | is stated in the audit agent | judgment | - |
| 537 | is stated in the fix agent | judgment | - |

### `spec/reap_agent_artifacts_spec.sh`: 2 pins (2 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 26 | never interpolates the raw package name into a worktree path in either document | judgment | - |
| 39 | keeps the guard from clearing it anyway | judgment | - |

### `spec/resolve_alerts_defect_reports_spec.sh`: 25 pins (25 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 28 | states the check-first-then-file-or-comment practice | judgment | - |
| 34 | runs the search against this repository, not the target | judgment | - |
| 40 | searches closed issues too, since a fixed-and-closed defect is still a hit | judgment | - |
| 46 | names the search itself as the reachability probe for the identity question | judgment | - |
| 52 | treats a second sighting as confirmation, not noise | judgment | - |
| 58 | requires the run'"'"'s own concrete evidence in the report | judgment | - |
| 64 | excludes target-repo defects from this path | judgment | - |
| 72 | forbids naming the target repository, owner, org, or topology | judgment | - |
| 80 | gates filing on the user'"'"'s go-ahead, or a prior in-session authorization | judgment | - |
| 86 | requires the closing report to say what was filed or proposed | judgment | - |
| 94 | resolves the reporting identity separately from the batch identity | judgment | - |
| 100 | names the EMU case as barred from contributing here | judgment | - |
| 106 | allows switching to a discoverable capable account under the same consent | judgment | - |
| 112 | never invents a switched identity silently | judgment | - |
| 118 | hands the drafted report to the user when no capable account resolves | judgment | - |
| 126 | scopes the prohibition to what this run did to pull requests | judgment | - |
| 132 | says the prohibition does not withdraw the defect-report offer | judgment | - |
| 140 | states the closing report carries the filing outcome when Filing a skill-defect report applied | judgment | - |
| 146 | covers both the filed.or-proposed issue and the hand-back-to-the-user case | judgment | - |
| 154 | grants gh issue list | judgment | - |
| 160 | grants gh issue create | judgment | - |
| 166 | grants gh issue comment | judgment | - |
| 174 | points at the same practice for a contract-violation-shaped defect | judgment | - |
| 180 | gives a readable path to resolve-alerts/defect-report.md | judgment | - |
| 186 | forbids re-deriving the rules in the audit skill | judgment | - |

### `spec/merge_risk_labels_spec.sh`: 11 pins (11 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 29 | creates $2 with color $3 | judgment | - |
| 44 | documents $1 as $2 (#$3) | judgment | - |
| 52 | documents \`dependencies\` as \`#0366d6\` | judgment | - |
| 60 | names exactly low, medium, and high in audit-pins.md, never a fourth | judgment | - |
| 68 | never uses a bare risk: prefix in fix-dependency.md, which would read as alert severity | judgment | - |
| 74 | never uses a bare risk: prefix in audit-pins.md, which would read as alert severity | judgment | - |
| 82 | calls render-pr labels with --repo and --band | judgment | - |
| 88 | calls render-pr create with --band | judgment | - |
| 96 | adds the label only when pr.risk.band is non-null | judgment | - |
| 102 | says a null band gets no risk label, never a fake one | judgment | - |
| 110 | treats a gh label create failing because the label now exists as success, not an error | judgment | - |

### `spec/fix_dependency_result_spec.sh`: 29 pins (29 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 35 | states the rule that a step is expected to terminate | judgment | - |
| 41 | treats an unreturned or repeatedly-failing verb as a failed phase | judgment | - |
| 47 | prescribes the 10-minute foreground timeout for the installing steps | judgment | - |
| 53 | prescribes the 2-minute foreground timeout for the read-only steps | judgment | - |
| 59 | scopes the repeated-failure rule to no remediation in between attempts | judgment | - |
| 67 | names the driver ladder and its one retry as the whole retry budget | judgment | - |
| 73 | treats kill-it-and-fail-closed as applying only to a timed-out verb | judgment | - |
| 79 | says an already-OOMed or non-zero-exited verb is already dead | judgment | - |
| 85 | forbids backgrounding a hung step | judgment | - |
| 91 | forbids attaching a monitor and waiting on it | judgment | - |
| 97 | cites the field failure the rule was written to prevent | judgment | - |
| 105 | requires cleanup on an abort for a hung or failing step | judgment | - |
| 111 | says killing a hung step does not excuse cleanup | judgment | - |
| 117 | says ending the turn without a result block is never valid | judgment | - |
| 123 | names a parked or waiting message as a contract violation | judgment | - |
| 131 | reads a missing result block as a contract violation, not a wait | judgment | - |
| 148 | carries cleanup as a required field in the result schema | judgment | - |
| 154 | names cleanup as the one exception to the exit-3 mapping | judgment | - |
| 160 | maps a cleanup exit 3 by what shipped, not by the exit code | judgment | - |
| 166 | keeps the PR on a cleanup failure when a PR was opened | judgment | - |
| 172 | still fails at worktree when no PR was opened | judgment | - |
| 179 | says a failure result would hide the PR and suppress the reap | judgment | - |
| 185 | requires the field on every result, null only on a clean cleanup | judgment | - |
| 191 | forbids summarizing the report into detail and leaving the field null | judgment | - |
| 197 | exempts cleanup from the fields a failure result nulls | judgment | - |
| 204 | qualifies the not-a-failure rule with whether the work shipped | judgment | - |
| 210 | says a cleanup failure with nothing shipped is a worktree failure | judgment | - |
| 218 | lists the failure phase enum without a commit member | judgment | - |
| 224 | routes a phase-6 hook commit failure to push, matching audit-pins | judgment | - |

### `spec/fix_dependency_baseline_spec.sh`: 3 pins (3 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 27 | names the baseline failure as ambient rather than group-specific | judgment | - |
| 33 | keeps the hook rules governing the drift commit too | judgment | - |
| 39 | carries lockfile-refresh in the result action enum | judgment | - |

### `spec/fix_dependency_branch_spec.sh`: 12 pins (12 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 30 | calls the driver for setup rather than prescribing the guard | judgment | - |
| 36 | calls the driver for cleanup rather than prescribing the delete | judgment | - |
| 44 | gates the delete on it being provably safe | judgment | - |
| 50 | says an unrecreatable commit is what the leave-behind protects | judgment | - |
| 58 | still forbids repository-wide git commands | judgment | - |
| 66 | names the driver as the single home of phases 1 to 5 | judgment | - |
| 76 | no longer says the branch simply remains | judgment | - |
| 82 | no longer stops on the mere existence of a local branch | judgment | - |
| 97 | no longer prescribes $1 | judgment | - |
| 109 | amends the guard decision | judgment | - |
| 115 | retires the base worktree | judgment | - |
| 121 | says one tree is installed, not two | judgment | - |

### `spec/fix_dependency_scratch_spec.sh`: 7 pins (7 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 30 | says the session scratchpad is shared with agents running beside you | judgment | - |
| 37 | still states the WORK-not-tmp rule the shared-scratchpad sentence extends | judgment | - |
| 46 | names the predictable-filename hazard, not just cleanup deletion | judgment | - |
| 55 | keeps the sibling-collision warning in the corepack-shim bullet | judgment | - |
| 61 | keeps the collision rationale naming the shared parallel directory | judgment | - |
| 74 | has no remaining unqualified why.json literal | judgment | - |
| 80 | no longer prescribes a why-capture redirect of its own | judgment | - |

### `spec/env_prefix_seam_spec.sh`: 18 pins (18 judgment, 0 mechanical)

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
| 173 | states it manager-agnostically in $2 | judgment | - |
| 183 | names a missed context statement as a cause of those symptoms | judgment | - |
| 189 | sends the reader back to session context on any of them | judgment | - |

### `spec/testing_skill_spec.sh`: 3 pins (3 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 168 | anchors its paths glob the way every other rule in this repo does | judgment | - |
| 180 | names the skill it points at | judgment | - |
| 195 | links from the root CLAUDE.md to the New script section | judgment | - |

### `spec/node_apply_constraint_spec.sh`: 2 pins (2 judgment, 0 mechanical)

| Line | `It` title | Class | Successor script |
|---|---|---|---|
| 1277 | has a definition that treats source unsupported as a known limit, not a warning | judgment | - |
| 1283 | has a definition that keeps the warning for a lockfile-backed source | judgment | - |
