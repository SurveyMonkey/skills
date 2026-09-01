#!/bin/sh
# shellcheck shell=sh
# Phase 6 dispatches one Workflow script rather than a schedule the model
# keeps in prose (issue #175).
#
# What changed: the orchestrator used to hold a work queue, fill it to `cap`,
# refill on every completion notification counting the agents actually in
# flight, and never overshoot on a stale count. That is bookkeeping the
# harness does deterministically, and every token spent re-deriving it
# recurred on every run. Phase 6 now hands the whole approved batch to
# plugins/gh-security/workflows/fix-groups.mjs.
#
# **What this file may and may not pin, after ADR 010.** The workflow used to
# live in a ```javascript fence in SKILL.md, so the only verification
# available was grepping the document — 93 textual assertions and zero
# behavioral tests, which is exactly how a well-formed but UNSATISFIABLE
# result schema passed every one of them. The script is a real file now, and
# spec/js/fix-groups.test.mjs runs it: the args guards, the worker count, the
# payload construction, the identity check, and the schema executed against
# ajv. Every pin here that was standing in for that coverage has been
# deleted, because two sources of truth for one behavior is worse than
# either alone.
#
# What remains is the prose that IS the implementation, because a model
# executes it and nothing else can: the approval boundary, the interruption
# and resume contract, the reap cadence, the payload the orchestrator
# assembles, and the phase 6 rules that predate the workflow. Those follow
# the spec/fix_dependency_branch_spec.sh pattern — the sentence is the code,
# and its absence is the whole regression.
#
# The dividing question for anything added later: does a MODEL do it, or does
# the SCRIPT? A script behavior belongs in spec/js/, run rather than read.

Describe 'phase 6 dispatches one workflow (issue #175)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  SCRIPTS_DOC="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/CLAUDE.md"
  REAP="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/common/reap-agent-artifacts.sh"
  ADR="$SHELLSPEC_PROJECT_ROOT/docs/adr/003-worktree-isolation-and-concurrency-cap.md"
  ADR010="$SHELLSPEC_PROJECT_ROOT/docs/adr/010-workflow-scripts-are-files-with-a-js-toolchain.md"
  WORKFLOW="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/workflows/fix-groups.mjs"
  README="$SHELLSPEC_PROJECT_ROOT/README.md"

  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  blob_in() { tr '\n' ' ' < "$1" | tr -s ' ' | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the workflow is a file, not a fence (ADR 010)'
    It 'ships the workflow as a real file'
      When call test -f "$WORKFLOW"
      The status should be success
    End

    # The fence is what made the whole layer untestable. Its return would
    # take the vitest suite's subject with it.
    It 'embeds no javascript fence in the skill any more'
      no_fence() { grep -c '```javascript' "$1" || true; }
      When call no_fence "$SKILL"
      The status should be success
      The output should equal '0'
    End

    # The `$` is written as `.` so the pattern does not spell `${`, which
    # SC2016 reads as an expansion someone forgot to double-quote. Same fix
    # the repo already uses for a sed character class (root CLAUDE.md), and
    # `.` matches the literal `$` here: no directive needed.
    It 'launches the workflow by scriptPath, from the plugin root'
      When call rule_in "$SKILL" 'scriptPath: ".{CLAUDE_PLUGIN_ROOT}/workflows/fix-groups.mjs"'
      The status should be success
      The output should equal '1'
    End

    # A hand-inlined variant would not be the tested file, which is the one
    # thing ADR 010 buys.
    It 'forbids inlining a copy or hand-editing a variant'
      When call phrase_in "$SKILL" 'Never inline a copy of it, and never hand-edit a variant for one run'
      The status should be success
      The output should equal '1'
    End

    It 'points at the tests as the reason the file is authoritative'
      When call blob_in "$SKILL" 'unit-tested by .spec/js/., and its result schema is executed against a validator rather than read'
      The status should be success
      The output should equal '1'
    End

    # The guarantees the model is told not to re-derive. Each is enforced by
    # a real test in spec/js/; these pins only keep the skill from growing a
    # second, drifting statement of them.
    Describe 'the guarantees the skill defers to the script for'
      Parameters
        worker-pool   'min(cap, N). workers hold the pool'
        args-guard    'Malformed .args. is refused loudly'
        model-pin     'Each agent runs as .fix-dependency. on .sonnet.'
        ordering      'Entries come back in dispatch order'
        mispairing    'A result that does not name its own dispatch is dropped, not trusted'
      End

      It "states the $1 guarantee once"
        When call blob_in "$SKILL" "$2"
        The status should be success
        The output should equal '1'
      End
    End

    It 'keeps the reap and the summary outside the script'
      When call phrase_in "$SKILL" 'it dispatches and it validates, and nothing else'
      The status should be success
      The output should equal '1'
    End

    # ADR 004's pin lives in two places now: the agent definition (for a Task
    # dispatch) and the workflow's agent() call (tested in spec/js/). This
    # guards the half that is not JavaScript.
    It 'keeps the sonnet pin in the agent frontmatter ADR 004 names'
      When call rule_in "$AGENT" '^model: sonnet$'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'what the model still has to get right about args'
    # The script refuses a malformed args object (spec/js/), but only the
    # model can pass a well-formed one in the first place, and a stringified
    # args is a caller mistake no callee can prevent.
    It 'tells the caller to pass args as JSON, never as a JSON-encoded string'
      When call phrase_in "$SKILL" 'Pass .args. as an actual JSON value, never as a JSON-encoded string'
      The status should be success
      The output should equal '1'
    End

    It 'names the silent empty-batch inversion that guard prevents'
      When call blob_in "$SKILL" 'report as a whole batch of crashed agents when nothing was ever dispatched'
      The status should be success
      The output should equal '1'
    End

    # The payload is assembled by the model from phases 1, 2 and 5, so its
    # field list is prose, not script.
    Describe 'the dispatch payload the orchestrator assembles'
      Parameters
        'nwo'
        'adapter_path'
        'default_branch'
        'repo_root'
        'scripts_dir'
      End

      It "still carries $1"
        When call phrase_in "$SKILL" "Each payload is the group JSON verbatim under .group., plus .*$1"
        The status should be success
        The output should equal '1'
      End
    End

    # An omitted key, never a null: the one field whose absence is meaningful.
    It 'still omits env_prefix rather than sending null'
      When call phrase_in "$SKILL" 'omit the key rather than send null'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the approval that covers the launch'
    # The retired paragraph said "refilling a slot is not a new dispatch
    # decision, so it never prompts". Its meaning is now phase 4's, where the
    # single approval is given, plus the flat statement in phase 6.
    It 'says phase 4 approval covers the workflow launch and every agent in it'
      When call phrase_in "$SKILL" 'That one approval covers the workflow launch and every agent inside it'
      The status should be success
      The output should equal '1'
    End

    It 'states plainly that nothing inside the workflow prompts'
      When call phrase_in "$SKILL" 'Nothing inside the workflow prompts'
      The status should be success
      The output should equal '1'
    End

    It 'grants the Workflow tool in the frontmatter'
      When call rule_in "$SKILL" 'allowed-tools:.*Read, Workflow, AskUserQuestion'
      The status should be success
      The output should equal '1'
    End

    # The Task grant went with the scheduler. Leaving it would let a model
    # fall back to hand-dispatching a group beside the workflow, which is
    # exactly the double-dispatch the cap can no longer see.
    It 'no longer grants the Task tool'
      no_task_grant() { grep -c 'Read, Task,' "$1" || true; }
      When call no_task_grant "$SKILL"
      The status should be success
      The output should equal '0'
    End
  End

  Describe 'the pool bookkeeping the harness now owns'
    # Each of these was a sentence or a motion the model executed. They are
    # pinned at zero because their reappearance means the scheduler came
    # back, and a hand-kept count running beside the workflow's own workers
    # is how the cap gets overshot.
    Parameters
      # what it was          the pattern that must not appear
      fill-motion            'Fill\.'
      refill-motion          'Refill\.'
      in-flight-count        'in flight again'
      stale-count-hazard     'stale count'
      slot-freed-signal      'completion notification'
      per-item-task-call     'one Task tool call'
    End

    It "no longer carries the $1"
      absent_in() { grep -c -e "$2" -- "$1" || true; }
      When call absent_in "$SKILL" "$2"
      The status should be success
      The output should equal '0'
    End
  End

  Describe 'the interruption contract'
    # The largest way a group can now disappear: a single call loses every
    # result at once, and the agents that ran had already pushed branches and
    # opened PRs. Under the old pool each completion arrived on its own, so
    # an abort still left the orchestrator holding everything received so
    # far. Nothing in the script can help here; recovery is the model's.
    It 'refuses to read an absent or short return as nothing having run'
      When call phrase_in "$SKILL" 'absent or short return'
      The status should be success
      The output should equal '1'
    End

    Describe 'every mode the contract must cover'
      Parameters
        throws     'the call errors'
        cancelled  'the user interrupts'
        short      'returns fewer entries than .dispatches'
      End

      It "names the $1 mode"
        When call phrase_in "$SKILL" "$2"
        The status should be success
        The output should equal '1'
      End
    End

    It 'names the journal as the record of what actually returned'
      When call rule_in "$SKILL" '<transcriptDir>/journal.jsonl'
      The status should be success
      The output should equal '1'
    End

    It 'resumes from the runId rather than re-dispatching the batch'
      When call rule_in "$SKILL" 'resumeFromRunId: <runId>'
      The status should be success
      The output should equal '1'
    End

    It 'says a plain relaunch duplicates the branches and PRs that already succeeded'
      When call blob_in "$SKILL" 'how a second branch and a second PR appear for work that already succeeded'
      The status should be success
      The output should equal '1'
    End

    # Resuming the approved batch is not a new dispatch decision; a run the
    # user deliberately stopped is, which is the one place the approval
    # boundary genuinely moves.
    It 'asks before resuming a run the user deliberately interrupted'
      When call phrase_in "$SKILL" 'a run the user deliberately interrupted is.*so there, ask first'
      The status should be success
      The output should equal '1'
    End

    It 'reaps the whole dispatch list anyway when resume is impossible or declined'
      When call phrase_in "$SKILL" 'reap the whole .dispatches. list anyway'
      The status should be success
      The output should equal '1'
    End

    It 'reports groups with no result as unknown rather than as failures'
      When call phrase_in "$SKILL" 'names the groups with no result at all as unknown rather than as'
      The status should be success
      The output should equal '1'
    End

    It 'is reachable from phase 7, which otherwise keys on one entry per group'
      When call phrase_in "$SKILL" "phase 6.s interruption contract is what fills the gap"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'how the model handles the entries it gets back'
    It 'reads phase 7 off the returned entries rather than a fence'
      When call phrase_in "$SKILL" 'The workflow returns .*one entry per approved group'
      The status should be success
      The output should equal '1'
    End

    It 'treats a null entry as that group failure report, still reported'
      When call phrase_in "$SKILL" 'is a failure report for that group, and is still reported'
      The status should be success
      The output should equal '1'
    End

    It 'reaps a null entry with an empty result file so post-agent.sh reports it missing'
      When call phrase_in "$SKILL" 'with an empty result file, and .post-agent.sh. reports it .missing'
      The status should be success
      The output should equal '1'
    End

    It 'never drops, hand-retries, or counts a null or mispaired entry as a success'
      When call blob_in "$SKILL" 'never dropped, never retried by hand, and never counted as a success, and neither is a .mispaired. one'
      The status should be success
      The output should equal '1'
    End

    # The script empties a mispaired result (spec/js/); the model still has
    # to route the group somewhere, and this is where that is said.
    It 'handles a mispaired entry exactly like a null one'
      When call blob_in "$SKILL" 'Treat a .mispaired. entry exactly like a .null. one'
      The status should be success
      The output should equal '1'
    End

    It 'never reads a mispaired entry pr_url or branch'
      When call blob_in "$SKILL" 'never read its .pr_url. or .branch., which belong to a different group'
      The status should be success
      The output should equal '1'
    End

    It 'says no bounded pool can make the dispatch order repeat'
      When call blob_in "$SKILL" 'no bounded pool can make that order repeat'
      The status should be success
      The output should equal '1'
    End

    # The prose must not claim more than the schema does.
    It 'says plainly what the schema cannot check'
      When call phrase_in "$SKILL" 'It does not and cannot check that a .pr_url. names a real pull request'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the cleanup report a shipped PR can still carry'
    # fix-group.sh cleanup runs after the commit, push and gh pr create, and
    # exits 3 when it leaves a worktree behind. A success carrying a cleanup
    # report is the expected shape, and burying it would hide exactly the
    # leak that exit code exists to surface.
    It 'reports every non-null cleanup alongside the reap accounting'
      When call blob_in "$SKILL" 'report every non-null .cleanup. on a result, in the same breath'
      The status should be success
      The output should equal '1'
    End

    It 'singles out a success whose cleanup failed'
      When call blob_in "$SKILL" 'A .success. with a non-null .cleanup. is the case to say out loud'
      The status should be success
      The output should equal '1'
    End

    It 'refuses to report a leaked worktree as a failed group'
      When call blob_in "$SKILL" 'never as a failed group, and never let the leak go unmentioned'
      The status should be success
      The output should equal '1'
    End

    # The two sources must be related, not printed twice: left_behind stays
    # the key, cleanup explains it and covers what the reap never saw.
    It 'relates cleanup to post-agent.sh left_behind rather than duplicating it'
      When call blob_in "$SKILL" 'two views of the same disk, not two lists to print twice'
      The status should be success
      The output should equal '1'
    End

    It 'keeps left_behind as the key and cleanup as the explanation'
      When call blob_in "$SKILL" 'key the report on .left_behind., as above, and use .cleanup. to explain it'
      The status should be success
      The output should equal '1'
    End

    It 'names the case where the reap cleared what the agent could not'
      When call blob_in "$SKILL" 'the reap cleared what the agent could not'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the phase 6 rules that survive the rewrite'
    # These predate #175 and are not pool bookkeeping: they are facts about
    # the repository and the batch that hold however dispatch is scheduled.
    # Pinned here because a later editor clearing out pool-era prose is
    # exactly who would take them by mistake.
    It 'still writes the worktree exclude once per repo, before any dispatch for it'
      When call phrase_in "$SKILL" 'Once per distinct repo in the approved batch, before the first agent for that repo is'
      The status should be success
      The output should equal '1'
    End

    It 'still gives the registry preflight one retry before it means anything'
      When call phrase_in "$SKILL" 'one retry.. before it means anything'
      The status should be success
      The output should equal '1'
    End

    It 'still keeps repo-global git state with the orchestrator while agents are in flight'
      When call phrase_in "$SKILL" 'while any agent is in flight no agent may touch it'
      The status should be success
      The output should equal '1'
    End

    It 'still allows two lines of the same package to run together'
      When call phrase_in "$SKILL" 'Two lines of the same package may be in flight together'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the reap timing this layer changed'
    # Precisely the sentence a later editor would "restore" to the old
    # wording. The reap moved from per-completion (inside a refill motion the
    # model kept) to per-returned-entry after the workflow returns, and both
    # binding documents that carried the old reason were corrected with it.
    It 'ties the reap to the result being in hand, not to a completion notification'
      When call phrase_in "$SKILL" 'Reap each group.s local artifacts once its result is in hand'
      The status should be success
      The output should equal '1'
    End

    It 'no longer claims in scripts/CLAUDE.md that the reap runs on each completion'
      no_completion_reap() { grep -c 'on each completion' "$1" || true; }
      When call no_completion_reap "$SCRIPTS_DOC"
      The status should be success
      The output should equal '0'
    End

    It 'keeps the never-prune rule in scripts/CLAUDE.md on the entitlement, not the timing'
      When call phrase_in "$SCRIPTS_DOC" 'the local-scope\s*rule is what makes it safe, not the timing'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the never-prune rule in reap-agent-artifacts.sh on the entitlement too'
      When call phrase_in "$REAP" 'a property of what.*this script is entitled to touch, not of when it happens to be called'
      The status should be success
      The output should equal '1'
    End

    It 'records the widened pull-request read window in ADR 003'
      When call phrase_in "$ADR" 'widens the window'
      The status should be success
      The output should equal '1'
    End

    # README describes the same dispatch to a reader who will never open
    # SKILL.md, and the zero-pin table above runs against SKILL.md only — so
    # reverting README's wording alone left the suite green.
    It 'no longer describes the fix agent as running from a rolling pool'
      no_rolling_pool() { grep -c 'rolling pool' "$1" || true; }
      When call no_rolling_pool "$README"
      The status should be success
      The output should equal '0'
    End

    It 'describes the dispatch as a capacity-bounded workflow instead'
      When call blob_in "$README" 'parallel from a capacity-bounded workflow'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the headline bullet on the same mechanism'
      When call blob_in "$README" 'dispatched by a single workflow that keeps the pool at the machine.s capacity'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'ADR 010 records the boundary the toolchain change rests on'
    # The whole argument for adding node to this repo: the workflow runs
    # inside the harness, which is already node, so no shipped script gained
    # a runtime. Losing that sentence turns the ADR into a bare dependency
    # addition and invites the next one.
    It 'says the plugin scripts keep their bash, jq and gh constraint'
      When call blob_in "$ADR010" 'remain .bash. + .jq. + .gh.'
      The status should be success
      The output should equal '1'
    End

    It 'rests the decision on the harness already being node'
      When call blob_in "$ADR010" 'a node process already running on that machine'
      The status should be success
      The output should equal '1'
    End

    It 'names the toolchain as a dev and CI dependency, not a user-facing one'
      When call blob_in "$ADR010" 'a .*dev and CI.* dependency'
      The status should be success
      The output should equal '1'
    End

    # The scripts/CLAUDE.md rule is still absolute for what it governs; what
    # it gained is a statement of what that is.
    It 'scopes the scripts dependency rule to what runs on a user machine'
      When call blob_in "$SCRIPTS_DOC" 'this rule governs what runs on a user.s machine'
      The status should be success
      The output should equal '1'
    End

    It 'forbids a plugin script from calling into the workflow file'
      When call blob_in "$SCRIPTS_DOC" 'Nothing here may call it, import it, or acquire a runtime because it exists'
      The status should be success
      The output should equal '1'
    End
  End
End
