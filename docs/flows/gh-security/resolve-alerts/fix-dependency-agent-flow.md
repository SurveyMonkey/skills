---
type: Reference
description: State and branch map of the fix-dependency subagent that resolve-alerts dispatches: one group's fix, from setup through to an open pull request, with every failure and no-op terminal; boxed regions mark the steps the fix driver executes rather than the model.
owner: brianespinosa
created: 2026-08-22
stale_after: 2027-02-24
---

# resolve-alerts: the fix-dependency agent, one group

| File | Role here |
|---|---|
| [`plugins/gh-security/agents/fix-dependency.md`](../../../../plugins/gh-security/agents/fix-dependency.md) | One group's fix. |

**A boxed region is executed, not instructed.** Everything inside one runs as a tested script or
workflow — `common/fix-group.sh`, `common/audit-pins-driver.sh`, `workflows/fix-groups.mjs` — with
its branches decided in code and covered by the suite. Everything outside is prose a model reads
and follows, which is why the unboxed nodes are the ones that ask the user something, write PR
narrative, or apply judgment the driver deliberately hands back. The distinction is the point of
the drivers: a branch inside a box fails a test when it regresses, and a branch outside one is
only as reliable as the sentence describing it, so re-deriving a boxed procedure in agent prose is
a bug rather than a fallback (`docs/gh-security/GUIDE.md`).

The boxes hold the steps, not their verdicts. A driver's failure terminals sit outside its box on
purpose: the driver decides them, and the agent is what maps them onto a result block and reports
them.

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

    D2["Phase 2: ADAPTER why (no install needed)"] --> D2Q{"relationship"}
    D2Q -->|direct| D3
    D2Q -->|transitive| D2E["declared_ranges --line, to narrow parents:<br/>eligible = parents_read + parents_unreadable +<br/>parents_without_range, minus parents_other_lines"] --> D3

    D3["Phase 3: pre-drift snapshot (resolved_versions<br/>on the never-installed tree), then control install"] --> D3I{"control install"}
    D3I -->|fails| FBASE0["failure: phase baseline<br/>(ambient: fails before any fix exists)"]
    D3I -->|installed| D3P{"status --porcelain"}
    D3P -->|empty| D3S
    D3P -->|non-empty| D3D["drift commit: lockfile, .pnp.cjs/.pnp.loader.mjs,<br/>changed .yarn/cache paths; never package.json"]
    D3D --> D3DQ{"drift commit"}
    D3DQ -->|"hook fails the commit"| FBASE1["failure: phase baseline,<br/>quoting the hook"]
    D3DQ -->|"porcelain still non-empty"| FBASE2["failure: phase baseline<br/>(residual non-lockfile changes:<br/>evidence, never cleaned up)"]
    D3DQ -->|clean| D3S
    D3S["baseline snapshot: ADAPTER resolved_versions<br/>(post-control-install)"] --> D3SQ{"result"}
    D3SQ -->|"the adapter errors on<br/>an unreadable lockfile"| FBASE["failure: phase baseline<br/>(a failed parse is never an empty result)"]
    D3SQ -->|"present: false"| D3N["No baseline to record; the output is still<br/>passed to validate --baseline"] --> D4
    D3SQ -->|present| D4

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
    D4V -->|"ok, git status --porcelain empty,<br/>other_line_moves []"| D4DR{"group's line moved across<br/>the drift commit?<br/>(pre-drift snapshot vs baseline)"}
    D4DR -->|"no drift commit,<br/>or line identical"| NOOP(["no-op: already fixed on the default branch;<br/>no commit, no PR, reason + evidence"])
    D4DR -->|"line changed: the drift<br/>commit IS the fix"| D4LR["action lockfile-refresh: nothing more to commit;<br/>PR body states the no-change refresh"] --> D5
    D4V -->|"ok, diff non-empty"| D5
    D4V -->|"fails"| D4L{"remediation ladder"}
    D4L -->|"1. uncovered parents"| D4I
    D4L -->|"2. bare override"| D4B["apply_constraint --tighten-bare;<br/>bare_override = tightened or added"] --> D4I
    D4L -->|"3. stale lockfile"| FVAL["failure: phase validate<br/>(regeneration needs a human)"]
    D4L -->|"4. line_present false"| FVAL2["failure: phase validate, naming<br/>requires_major_bump; the override does nothing"]

    D5["Phase 5: declared_ranges --line, then score-merge-risk.sh<br/>(F1-F7 as the scorer defines them today;<br/>F6 from --override-scope; no repo scripts run)"] --> D6
    D6["Phase 6: commit and push from the worktree"] --> D6Q{"repo hooks"}
    D6Q -->|"pre-commit or pre-push fails"| FPUSH["failure: phase push,<br/>quoting the hook (never --no-verify)"]
    D6Q -->|pass| D6PR["gh label list / create, then gh pr create --label security<br/>--label dependencies --label merge-risk:&lt;band&gt; (ready for review;<br/>the agent never merges it or arms auto-merge)"]
    D6PR --> D6PRQ{"PR created?"}
    D6PRQ -->|no| FPR["failure: phase pr"]
    D6PRQ -->|yes| SUCC(["success: pr_url, action, risk band,<br/>requires_major_bump[], observations[]"])

    FIN --> CL
    FWT --> CL
    FWT2 --> CL
    FBASE0 --> CL
    FBASE1 --> CL
    FBASE2 --> CL
    FBASE --> CL
    FALIAS --> CL
    FINST --> CL
    FCOLL --> CL
    FVAL --> CL
    FVAL2 --> CL
    FPUSH --> CL
    FPR --> CL
    NOOP --> CL
    SUCC --> CL
    CL["Cleanup on every path: worktree remove --force, rm -rf $WORK,<br/>then branch -D only when pushed, nothing was committed,<br/>or the only commit is the drift commit;<br/>a cleanup error goes in detail, never silenced<br/>(no git worktree prune, ever)"] --> RES(["One fenced JSON result:<br/>success | no-op | failure"])

    subgraph FGBOX["common/fix-group.sh — phases 1 to 5, one stepped driver"]
        D1
        D1A
        D1B
        D1C
        D1DEL
        D2
        D2Q
        D2E
        D3
        D3I
        D3P
        D3D
        D3DQ
        D3S
        D3SQ
        D3N
        D4
        D4A
        D4I
        D4IQ
        D4VAL
        D4C
        D4VBD
        D4V
        D4DR
        D4LR
        D4L
        D4B
        D5
    end

    subgraph FGCLEAN["common/fix-group.sh — cleanup step"]
        CL
    end
```

`requires_major_bump[]` is not a state of its own. It rides on a `success` result, with its own
PR-body section, and it is also what rung 4's failure names when the group's line was never
installed. Either way the orchestrator re-reports it in phase 7; copies below the group's line
cannot be fixed from here and are never attempted.

Both defects [#89](https://github.com/SurveyMonkey/skills/issues/89) named are fixed in the agent
definition: a commit-hook failure now reports `phase push`, matching the result enum's absence of a
`commit` phase, and the `apply_constraint` comment now matches the eligible-set rule (`parents_read`
plus `parents_unreadable` plus `parents_without_range`), fixed by
[#112](https://github.com/SurveyMonkey/skills/issues/112).

