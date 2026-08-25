---
type: Reference
description: State and branch map of the resolve-alerts skill (fix pooling only) and its fix-dependency subagent, plus the standalone /gh-security:audit-pins command and its audit-pins agent, as three mermaid flowcharts covering the orchestrator's phases and user decision points, one group's fix through to an open pull request, and the pin audit's own security-PR preflight, findings, guards, and the ways a completed audit opens no PR.
owner: brianespinosa
created: 2026-08-22
stale_after: 2027-02-24
---

# resolve-alerts state flow

Every state the `resolve-alerts` skill and its two subagents can reach, and every branch between
them. The skill is the source of truth; this is a map of it, kept beside it rather than inside it
because the phase prose is written to be executed in order and a reader tracing "where can this
stop?" needs the shape instead.

Sources, in the order the flow reads them:

| File | Role here |
|---|---|
| [`plugins/gh-security/commands/resolve-alerts.md`](../../plugins/gh-security/commands/resolve-alerts.md) | Entry point; runs the skill from phase 1. |
| [`plugins/gh-security/skills/resolve-alerts/SKILL.md`](../../plugins/gh-security/skills/resolve-alerts/SKILL.md) | The orchestrator's phases, diagram 1. |
| [`plugins/gh-security/agents/fix-dependency.md`](../../plugins/gh-security/agents/fix-dependency.md) | One group's fix, diagram 2. |
| [`plugins/gh-security/commands/audit-pins.md`](../../plugins/gh-security/commands/audit-pins.md) | The standalone audit entry point, including its open-security-PR preflight; diagram 3. |
| [`plugins/gh-security/agents/audit-pins.md`](../../plugins/gh-security/agents/audit-pins.md) | The pin audit itself, dispatched only from that command, diagram 3. |

Three diagrams rather than one: the orchestrator and the two agents are separate control flows that
meet only at a dispatch payload and a JSON result block, and the agents cannot ask the user
anything, so where they stop is a different question from where the orchestrator does.

## Diagram 1: the orchestrator

Rounded nodes end the run. Diamonds are branches; diamonds labelled **ask** are where the user
decides, and nothing dispatches without one. The ask sites are phase 3's how-much, phase 4's batch
approval, and phase 8's offer of the groups declined at phase 3.

**No ask is about a pull request that already exists.** Phase 4 is the last one that gates a fix PR
into being, and phase 8's offer dispatches further work, the groups declined at phase 3, rather
than deciding anything about a PR already on the page. PRs
open ready for review and no phase acts on one afterwards ([ADR
008](../adr/008-prs-open-ready-for-review.md)). The pin audit is no longer part of this flow at
all ([issue #108](https://github.com/SurveyMonkey/skills/issues/108)): it is entered only via
`/gh-security:audit-pins`, diagram 3.

Three branches exclude one repo's groups without ending the run — phase 5's checkout conflict and
unresolvable default branch, and phase 6's failed registry probe; they are drawn as plain nodes
for that reason.

```mermaid
flowchart TD
    START["/gh-security:resolve-alerts, or a natural-language ask"] --> P1
    P1["Phase 1: detect-scope.sh"] --> P1Q{"scope, or the user's own<br/>if the request names a different one"}
    P1Q -->|repo| P1R{"git_remote agrees with nwo?"}
    P1Q -->|"org / user"| P2
    P1R -->|no| P1RT["Trust git_remote, say so"] --> P1D
    P1R -->|yes| P1D{"default_branch resolved?"}
    P1D -->|null| STOP1(["Stop: origin's default branch<br/>could not be resolved"])
    P1D -->|yes| P1E["Resolve env_prefix at repo scope: .envrc at or above<br/>repo_root? The orchestrator's own gh/git/script<br/>calls for the repo run under it from here on"] --> P2

    P2["Phase 2: discover-alerts.sh | select-adapter.sh<br/>| classify-lines.sh (repo scope only)"] --> P2REP["Report every skipped_repos entry by name,<br/>every time it is non-empty"]
    P2REP --> P2Q{"actionable groups?"}
    P2Q -->|none| STOP2(["Stop: report every skipped group<br/>and skipped repo"])
    P2Q -->|"one or more"| P3

    P3["Phase 3: ranked table<br/>(Repo column at org/user scope only)"] --> P3ASK{"ask: how much to fix?"}
    P3ASK -->|One| P4
    P3ASK -->|"Highest tier"| P4
    P3ASK -->|Everything| P4

    P4["Phase 4: detect-capacity.sh, present the plan"] --> P4ASK1{"ask: approve the batch?"}
    P4ASK1 -->|approve| P4OK
    P4ASK1 -->|decline| STOP3(["Stop: nothing dispatched"])
    P4OK["Batch approved"] --> P5Q{"scope"}

    P5Q -->|repo| P6
    P5Q -->|"org / user"| P5["Phase 5: per distinct repo in the batch"]
    P5 --> P5E["Resolve env_prefix per repo from the conventional<br/>path's .envrc; clone, fetch and the calls below run under it"]
    P5E --> P5A{"checkout at the conventional path?"}
    P5A -->|"git repo exists"| P5F["git -C fetch origin"] --> P5B
    P5A -->|"nothing there"| P5C["gh repo clone into the @owner convention"] --> P5B
    P5A -->|"wrong remote / not a repo"| P5X["Report the conflict, exclude that repo's<br/>groups; the other repos continue"]
    P5B{"detect-scope.sh default_branch?"}
    P5B -->|null| P5Y["Report that repo blocked, exclude its<br/>groups; the other repos continue"]
    P5B -->|yes| P5R["Reconcile: classify-lines.sh --repo-root<br/>on that repo's approved groups"]
    P5R --> P5RQ{"any group reclassifies<br/>requires_major_bump?"}
    P5RQ -->|yes| P5W["Withdraw from the phase 6 queue;<br/>reported in phase 7 with resolved_majors context"] --> P7AGG
    P5RQ -->|"remaining groups"| P6
    P5X --> P6
    P5Y --> P6

    P6["Phase 6: ensure-worktree-exclude.sh once per repo, before<br/>the first agent for that repo (failure non-fatal, dispatch anyway)"] --> P6P{"Registry probe per repo, from inside repo_root,<br/>under env_prefix: pm_exec view on a scoped dependency,<br/>or the top-ranked package; one retry"}
    P6P -->|"fails twice: auth 401/403, not-found 404,<br/>or network"| P6X["Exclude that repo's groups; reported in phase 7<br/>as possibly transient, re-running re-probes"] --> P7AGG
    P6P -->|green| P6Q["Work queue: every approved group across every repo,<br/>in ranked order"]
    P6Q --> P6D["Rolling pool, machine-wide: dispatch queued items until cap<br/>are in flight, one message, one Task call per item;<br/>on each completion refill to cap the same way"]
    P6D --> P6DQ{"queue empty and every agent returned?"}
    P6DQ -->|"no: refill while the queue holds work<br/>(a failure or unparseable result frees a slot too)"| P6D
    P6DQ -->|yes| P7

    P7["Phase 7: parse each fenced JSON result"] --> P7Q{"per result"}
    P7Q -->|success| P7S["Fix table row: PR, risk, F4/F5, bare-override note"]
    P7Q -->|"no-op"| P7N["Its own 'already fixed' line,<br/>never the failure list"]
    P7Q -->|failure| P7F["Failure list: phase + detail"]
    P7Q -->|"missing or unparseable block"| P7U["Recorded as a failure; never guess fields"]
    P7S --> P7AGG
    P7N --> P7AGG
    P7F --> P7AGG
    P7U --> P7AGG
    P7AGG["requires_major_bump[] first, then unaddressed skipped_repos<br/>and registry-preflight exclusions,<br/>then deduplicated observations split by type"] --> P8

    P8{"Phase 8: actionable groups remain?"}
    P8 -->|yes| P8ASK0{"ask: fix the groups declined at phase 3?"}
    P8ASK0 -->|yes| P3
    P8ASK0 -->|no| P8REP
    P8 -->|no| P8REP["Point at /gh-security:audit-pins as separate<br/>follow-up work, run once these fix PRs have<br/>landed (#108); pr-status.sh on every success PR:<br/>checks, merge_state, reported as information"]
    P8REP --> DONE
    DONE(["Done: every PR URL with its band and check state,<br/>remaining skipped_repos, and what would unblock each"])
```

Two cycles, and no others. The drain loop (`P6DQ` back to `P6D`) is the concurrency cap enforced as
a rolling pool: it turns once per completion, refilling to `cap` from the queue, rather than once
per barrier. Nothing waits for a slower sibling, and a failed or unparseable result refills exactly
like a success. The declined-groups loop (phase 8 to phase 3) is reached only when groups
remain *and* the user accepts the offer, and it re-enters the how-much question with what is left;
those groups were never approved at phase 4, so it is a scope question rather than a resumption of
approved work. There is no third: this flow dispatches no other agent kind and asks no other
question.

Phase 8 has one offer, not two: the groups declined at phase 3. The pin audit is not part of this
run at all ([#108](https://github.com/SurveyMonkey/skills/issues/108)) — the closing report points
at `/gh-security:audit-pins` as separate follow-up work instead, run once this run's fix PRs have
landed, because the two flows edit the same overrides block and running them together produces
exactly the conflict a field case demonstrated
(the field test's audit PR).

## Diagram 2: fix-dependency, one group

One agent per group, where a group is one major line of one package in one repo. It never asks
anything: every place the interactive flow would ask, it cleans up and returns a failure. Cleanup
runs on every path, success and failure alike, which is why the terminal states below are results
rather than exits.

```mermaid
flowchart TD
    D0["Dispatch payload: group, adapter_path, nwo,<br/>default_branch, repo_root, scripts_dir,<br/>env_prefix (optional)"] --> D0Q{"any required field missing?"}
    D0Q -->|yes| FIN["failure: phase input"]
    D0Q -->|no| D1

    D1["Phase 1: $WORK container at<br/>.claude/worktrees/fix-dependabot-PKG-LINEx;<br/>the checkout is $WORK/fix"] --> D1A{"$WORK already exists?"}
    D1A -->|"yes: previous run crashed"| FWT["failure: phase worktree<br/>(never reuse, never delete)"]
    D1A -->|no| D1B{"local branch of this name?"}
    D1B -->|none| D1C
    D1B -->|"tip = origin/default_branch<br/>or origin/branch_name"| D1DEL["This flow's own leftover: branch -D, recreate"] --> D1C
    D1B -->|"tip is neither"| FWT2["failure: phase worktree,<br/>quoting the three shas (unpushed work)"]
    D1C["worktree add $WORK/fix -b branch_name origin/default_branch"] --> D2

    D2["Phase 2: ADAPTER resolved_versions (baseline)"] --> D2Q{"result"}
    D2Q -->|"the adapter errors on<br/>an unreadable lockfile"| FBASE["failure: phase baseline<br/>(a failed parse is never an empty result)"]
    D2Q -->|"present: false"| D3["No baseline to record; the output is still<br/>passed to validate --baseline"]
    D2Q -->|present| D3
    D3["Phase 3: ADAPTER why"] --> D3Q{"relationship"}
    D3Q -->|direct| D4
    D3Q -->|transitive| D3E["declared_ranges --line, to narrow parents:<br/>eligible = parents_read + parents_unreadable +<br/>parents_without_range, minus parents_other_lines"] --> D4

    D4["Phase 4: apply_constraint with a major-bounded range"] --> D4A{"written[] npm: value<br/>names another package?"}
    D4A -->|yes| FALIAS["failure: alias collision,<br/>no install, no PR (#49)"]
    D4A -->|no| D4I["ADAPTER install"]
    D4I --> D4IQ{"install result"}
    D4IQ -->|"peer conflict, missing version,<br/>timeout past one retry"| FINST["failure: phase install"]
    D4IQ -->|installed| D4VAL["validate --line --vulnerable...<br/>--baseline --sibling-alerts"]
    D4VAL --> D4C{"other_line_moves"}
    D4C -->|"any fatal"| FCOLL["failure: phase validate, fail-closed;<br/>quote the array (#83)"]
    D4C -->|"all benign_dedup"| D4VBD["disclosed in the PR body's<br/>Collateral section"] --> D4V
    D4C -->|"null: no baseline passed,<br/>the question went unasked"| D4V
    D4C -->|"[]"| D4V
    D4V{"validate ok?"}
    D4V -->|"ok, git status --porcelain empty,<br/>other_line_moves []"| NOOP(["no-op: already fixed on the default branch;<br/>no commit, no PR, reason + evidence"])
    D4V -->|"ok, diff non-empty"| D5
    D4V -->|"fails"| D4L{"remediation ladder"}
    D4L -->|"1. uncovered parents"| D4I
    D4L -->|"2. bare override"| D4B["apply_constraint --tighten-bare;<br/>bare_override = tightened or added"] --> D4I
    D4L -->|"3. stale lockfile"| FVAL["failure: phase validate<br/>(regeneration needs a human)"]
    D4L -->|"4. line_present false"| FVAL2["failure: phase validate, naming<br/>requires_major_bump; the override does nothing"]

    D5["Phase 5: declared_ranges --line, then score-merge-risk.sh<br/>(F1-F7 as the scorer defines them today;<br/>F6 from --override-scope; no repo scripts run)"] --> D6
    D6["Phase 6: commit and push from the worktree"] --> D6Q{"repo hooks"}
    D6Q -->|"pre-commit fails"| FCOM["failure: phase commit,<br/>quoting the hook (never --no-verify)"]
    D6Q -->|"pre-push fails"| FPUSH["failure: phase push"]
    D6Q -->|pass| D6PR["gh label list / create, then gh pr create --label security<br/>(ready for review; the agent never merges it<br/>or arms auto-merge)"]
    D6PR --> D6PRQ{"PR created?"}
    D6PRQ -->|no| FPR["failure: phase pr"]
    D6PRQ -->|yes| SUCC(["success: pr_url, action, risk band,<br/>requires_major_bump[], observations[]"])

    FIN --> CL
    FWT --> CL
    FWT2 --> CL
    FBASE --> CL
    FALIAS --> CL
    FINST --> CL
    FCOLL --> CL
    FVAL --> CL
    FVAL2 --> CL
    FCOM --> CL
    FPUSH --> CL
    FPR --> CL
    NOOP --> CL
    SUCC --> CL
    CL["Cleanup on every path: worktree remove --force, rm -rf $WORK,<br/>then branch -D only when pushed or nothing was committed;<br/>a cleanup error goes in detail, never silenced<br/>(no git worktree prune, ever)"] --> RES(["One fenced JSON result:<br/>success | no-op | failure"])
```

`requires_major_bump[]` is not a state of its own. It rides on a `success` result, with its own
PR-body section, and it is also what rung 4's failure names when the group's line was never
installed. Either way the orchestrator re-reports it in phase 7; copies below the group's line
cannot be fixed from here and are never attempted.

Two things in this diagram follow the source's prose where its own schema disagrees, and are worth
fixing in the agent definition rather than here
([#89](https://github.com/SurveyMonkey/skills/issues/89)): a commit-hook failure is `phase commit`
in the prose while `commit` is absent from the result enum, and the inline comment beside
`apply_constraint` still says to pass `parents_read` "and only those", which the eligible-set rule
above it contradicts.

## Diagram 3: audit-pins

Reached only through `/gh-security:audit-pins`, never through `resolve-alerts` ([#108](https://github.com/SurveyMonkey/skills/issues/108)).
The command's own preflight — an open-PR check for the `security` label this plugin's own fix PRs
carry — runs before the mode question and before the agent is ever dispatched: an unmerged fix PR
may be adding or tightening an override the audit is about to judge removable, and the command
stops rather than risk the inversion the field test's audit PR demonstrated. There is no
proceed-anyway path; a user who wants the audit to run anyway says so in conversation.

Once dispatched, the agent carries the repo (`nwo` in both the command's dispatch payload and the
agent's own input contract; only the result renames it to `repo`), `repo_root`, `default_branch`, an `adapter_path`,
`scripts_dir`, an optional `env_prefix` resolved at the command's step 1, and a `mode` that the
user decides at the command's step 5 and that is never defaulted. In `pr` mode the distinction that matters is between a *failure* and one of the five
ways a completed audit declines to open a PR: both leave `pr` null, and only the first is a broken
run.

```mermaid
flowchart TD
    CMD1["/gh-security:audit-pins: detect-scope.sh,<br/>then resolve env_prefix from a .envrc<br/>at or above repo_root"] --> CMD1Q{"scope?"}
    CMD1Q -->|"org / user"| CMD1A["Ask which repo, or ask the user<br/>to run it from that repo's checkout"] --> CMD1D
    CMD1Q -->|repo| CMD1D{"default_branch resolved?"}
    CMD1D -->|null| CSTOP0(["Stop: default_branch<br/>could not be resolved"])
    CMD1D -->|yes| CMD2{"manifest present?"}
    CMD2 -->|no| CSTOP1(["Stop: nothing this command can audit"])
    CMD2 -->|yes| CMD3["select-adapter.sh"]
    CMD3 --> CMD4{"open security-labeled PRs?<br/>env_prefix gh pr list --label security --state open"}
    CMD4 -->|"one or more"| CSTOP2(["Stop: report each PR by number and title;<br/>merge or close first, no proceed-anyway (#108)"])
    CMD4 -->|none| CMD5["ensure-worktree-exclude.sh"]
    CMD5 --> CMD6{"ask: mode?"}
    CMD6 -->|"pr / report"| A0

    A0["Dispatch payload incl. mode"] --> A0Q{"mode present and recognized?"}
    A0Q -->|no| AFIN["failure: phase input"]
    A0Q -->|"report / pr"| A1{"$WORK exists?"}
    A1 -->|"yes: crashed run"| AFWT["failure: phase worktree"]
    A1 -->|no| A1B{"mode = pr?"}
    A1B -->|report| A1C
    A1B -->|yes| A1G{"guard 1: gh pr list --head, open?"}
    A1G -->|"non-zero exit"| AFWT
    A1G -->|"open PR exists"| APR1["Run exactly as report mode;<br/>phases 7 and 8 are skipped, guard 2 does not run.<br/>existing_pr_url recorded"]
    A1G -->|"none open"| A1R{"guard 2: local or remote<br/>chore/dependabot-remove-pins?"}
    A1R -->|"neither exists"| A1C
    A1R -->|"proven remnant: remote sha = a closed<br/>PR's headRefOid, local tip equal or absent"| A1RM["Record the verified sha; phase 8 may<br/>force-with-lease and delete the local branch"] --> A1C
    A1R -->|"anything else, or a lookup that failed"| AFWT
    A1C["worktree add --detach $WORK/audit from origin/default_branch<br/>(no branch until phase 8)"] --> A2
    APR1 --> A1C

    A2["Phase 2: ADAPTER list_pins"] --> A2Q{"result"}
    A2Q -->|"non-zero exit"| AFL["failure: phase list<br/>(a refused manifest is not zero pins)"]
    A2Q -->|"count = 0"| APINS(["This repo pins nothing.<br/>pr mode: pr null, reason no pins"])
    A2Q -->|"pins found"| A2K{"kind per pin"}
    A2K -->|"alias / protocol / reference / unparseable"| ANV["finding: not-a-version-pin"]
    A2K -->|range| A3["Phase 3: provenance (commit, PR, fixed_alerts[])"]

    A3 --> A4B["Phase 4: baseline install, resolved_versions,<br/>resolution_map, all with every pin in place"]
    A4B --> A4BQ{"baseline"}
    A4BQ -->|"install, resolved_versions or<br/>resolution_map errors"| AFI["failure: phase install"]
    A4BQ -->|"resolution_map unavailable"| A4NC["collateral_changes null,<br/>verdict not-checked; testing continues"] --> A4
    A4BQ -->|whole| A4
    A4["Per pin, bare pins first: remove the entry,<br/>verify with jq and list_pins, install,<br/>resolved_versions, resolution_map, restore"]
    A4 --> A4Q{"per pin"}
    A4Q -->|"baseline present: false"| AINC["finding: inconclusive"]
    A4Q -->|"jq parse error, or the edit<br/>did not land in list_pins"| AFI
    A4Q -->|"install fails"| AINC
    A4Q -->|"the two parsers disagree,<br/>or the pin is keyed on an alias"| AINC
    A4Q -->|"restore fails"| AFRES["failure: phase restore"]
    A4Q -->|"more pins than one session can install"| ANT["finding: not-tested"]
    A4Q -->|"present: false after removal:<br/>the package left the tree"| AREM["removable candidate"]
    A4Q -->|"empty delta: a sibling pin<br/>holds the tree"| AREM
    A4Q -->|"delta produced"| A5["Phase 5: check-advisories.sh on every<br/>version in the delta"]
    A5 --> A5Q{"verdict"}
    A5Q -->|"non-zero exit, or unknown with<br/>a non-empty adapter_errors[]"| AFA["failure: phase advisories"]
    A5Q -->|"every version safe"| A5C
    A5Q -->|"any vulnerable"| AREQ["finding: still-required,<br/>naming the ranges"]
    A5Q -->|"any unknown or no-advisories"| AINC
    A5C{"collateral verdict on<br/>every newly-admitted version"}
    A5C -->|"none / safe"| AREM
    A5C -->|vulnerable| AREQ
    A5C -->|"unknown / no-advisories"| AINC
    A5C -->|"not-checked"| AREM

    ANV --> A6
    AINC --> A6
    ANT --> A6
    AREQ --> A6
    AREM --> A6
    A6["Phase 6: every pin reported exactly once, grouped by package.<br/>A package with more than one removable pin: each is<br/>removable-individually, with its sibling_pins"] --> A6Q{"mode"}
    A6Q -->|report| ADONE(["success, pr null by definition"])
    A6Q -->|"pr, and guard 1 found an open PR"| APR1B(["success, pr null:<br/>open PR already exists"])
    A6Q -->|pr| A7{"baseline resolution_map whole?"}
    A7 -->|"unavailable, or unreadable_entries<br/>absent or non-zero"| APR2(["success, pr null:<br/>partial resolution map"])
    A7 -->|yes| A7C{"candidates: removable +<br/>removable-individually"}
    A7C -->|none| APR3(["success, pr null:<br/>no removable pins found"])
    A7C -->|"one or more"| A7A1["Attempt 1: remove every candidate,<br/>verify the edits, install, diff the map,<br/>check advisories on what it newly admits"]
    A7A1 --> A7Q{"attempt 1"}
    A7Q -->|"edits did not land,<br/>or the install did not finish"| AFC["failure: phase compose<br/>(never falls through to attempt 2)"]
    A7Q -->|"advisory lookup broke"| AFA
    A7Q -->|"clean: everything safe"| A8
    A7Q -->|"partial map, or a version<br/>no advisory clears"| A7A2["Attempt 2: the removable pins only;<br/>dropped candidates become left_behind[]"]
    A7A2 --> A7Q2{"attempt 2"}
    A7Q2 -->|"compose / advisories failure"| AFC2["failure, as attempt 1"]
    A7Q2 -->|"empty candidate set, or<br/>failed the same way again"| APR4(["success, pr null: combined test failed<br/>(which attempt, which package and version)"])
    A7Q2 -->|clean| A8

    A8["Phase 8: score-merge-risk.sh per removed package,<br/>highest band wins; stage, branch, commit,<br/>push leased or plain per guard 2"] --> A8Q{"outcome"}
    A8Q -->|"scorer usage error, or an<br/>unexplained status --porcelain"| AFV["failure: phase verify"]
    A8Q -->|"push refused, lease included"| AFP["failure: phase push"]
    A8Q -->|"gh pr create fails"| AFPR["failure: phase pr"]
    A8Q -->|created| APRD(["success with pr, open for review: url, attempt,<br/>removed_keys[], left_behind[], risk band"])

    AFIN --> ACL
    AFWT --> ACL
    AFL --> ACL
    AFI --> ACL
    AFRES --> ACL
    AFA --> ACL
    AFC --> ACL
    AFC2 --> ACL
    AFV --> ACL
    AFP --> ACL
    AFPR --> ACL
    APINS --> ACL
    ADONE --> ACL
    APR1B --> ACL
    APR2 --> ACL
    APR3 --> ACL
    APR4 --> ACL
    APRD --> ACL
    ACL["Cleanup: worktree remove --force, rm -rf $WORK;<br/>a cleanup failure is reported, not hidden"] --> ARES(["One fenced JSON result:<br/>success | failure"])
```

`pr_skipped_reason` carries **one** value chosen by precedence, not by which node was drawn last:
`open PR already exists` first, then `no pins` or `no removable pins found`, then whatever the last
attempt that ran ended with (`partial resolution map` or `combined test failed`). A second reason
that also applied travels in `pr_skipped_detail`, along with the attempt number, since there is no
`pr.attempt` to read when `pr` is null. So the `no pins` node above carries that reason only when
guard 1 found no open PR.

Guard 1 is the one branch that changes what the audit may do at the end rather than where it goes:
the findings are produced either way, and only phases 7 and 8 are skipped. Guard 2 is the opposite,
and is why phase 8 is allowed to force-push and delete a local branch at all: without a proven
remnant it pushes plainly, and anything it cannot prove ends the run.

## Where the flow can stop

Run outcomes for the orchestrator:

| Terminal state | Reached from | What the user sees |
|---|---|---|
| Unresolvable default branch | Phase 1, repo scope | Stop before discovery |
| No actionable groups | Phase 2 | Every skipped group and skipped repo, by name |
| Batch declined | Phase 4 | Nothing dispatched; no agent ever ran |
| Done | Phase 8 | Every PR URL with its band and check state, remaining skipped repos, what unblocks each |

Everything else is per repo, and the run continues past it: a phase 5 checkout conflict, an
unresolvable default branch, or a phase 6 registry probe that fails twice excludes that repo's
groups only. Nothing about a PR can withhold
anything any more — there is no offer left to withhold, so a red check is reported and the run ends
normally.

Agent results are the other terminals: `success`, `no-op` or `failure` from a fix agent, `success`
or `failure` from the audit. The three easiest to misread as each other are a fix agent's `failure`,
its `no-op`, and an audit's null `pr`. `no-op` is a clean outcome the orchestrator reports on its own
line. A `pr`-mode audit that succeeded with a null `pr` and one of the five reasons is a completed
audit. A `pr`-mode **success** with a null `pr` and no reason is the contract violation, to report as
a failure of the agent; a null `pr` on a `failure` result is not, because there the phase and detail
carry the story.
