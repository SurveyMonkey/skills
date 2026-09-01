#!/bin/sh
# shellcheck shell=sh
# Phase 6 dispatch as a Workflow script rather than a scheduler the model
# keeps in prose (issue #175).
#
# What changed: the orchestrator used to hold a work queue, fill it to `cap`,
# refill on every completion notification counting the agents actually in
# flight, and never overshoot on a stale count. That is bookkeeping the
# harness does deterministically, and every token spent re-deriving it
# recurred on every run. Phase 6 now hands the whole batch to one Workflow
# script embedded in SKILL.md, whose workers are what hold the cap.
#
# Nothing executable runs here, and nothing can: the template is JavaScript
# inside a skill document, and the behavior it replaces was model-executed
# prose. So these examples pin the sentences and the template lines that ARE
# the implementation, exactly as spec/fix_dependency_branch_spec.sh and
# spec/resolve_alerts_branch_style_spec.sh do for their own prose contracts.
# The pins fall into three groups: the template's own load-bearing lines, the
# invariants #175 introduced, and the phase 6 rules that survived the rewrite
# and would otherwise be deleted by a later editor as pool-era leftovers.

Describe 'phase 6 dispatches one workflow (issue #175)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"

  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  # The template is indented JavaScript, so flattening its newlines leaves
  # runs of spaces where the prose helpers leave one. Squeeze them, so a
  # pinned literal can be written the way it reads.
  blob_in() { tr '\n' ' ' < "$1" | tr -s ' ' | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the embedded template'
    # `meta` must be a pure literal — no variables, calls, spreads or
    # interpolation — or the Workflow tool refuses the script outright. It is
    # pinned as a whole-line literal so an editor cannot quietly parameterize
    # the name.
    It 'opens with a pure-literal meta block'
      When call rule_in "$SKILL" '^export const meta = {$'
      The status should be success
      The output should equal '1'
    End

    It 'names the workflow and describes it in one line'
      When call rule_in "$SKILL" "^  name: 'gh-security-fix-dispatch',$"
      The status should be success
      The output should equal '1'
    End

    # One phase, declared in meta and started in the body with the SAME
    # title: the titles are matched exactly, and a mismatch silently splits
    # the progress display into two groups.
    Describe 'the single dispatch phase, titled identically in meta and in the body'
      Parameters
        # where it appears   the literal that must appear there
        meta-entry           "{ title: 'Fix groups', detail: 'one fix-dependency agent per approved group' },"
        body-call            "phase('Fix groups')"
        agent-option         "phase: 'Fix groups',"
      End

      It "carries the $1 form"
        When call rule_in "$SKILL" "$2"
        The status should be success
        The output should equal '1'
      End
    End

    # The dispatch itself: one agent per group, routed to the fix-dependency
    # agent definition. Losing agentType silently dispatches the generic
    # workflow subagent, which has none of the fix agent's contract.
    It 'dispatches each group to the fix-dependency subagent type'
      When call rule_in "$SKILL" "agentType: 'fix-dependency',"
      The status should be success
      The output should equal '1'
    End

    # `cap` bounds the pool by construction — the worker count IS the cap —
    # rather than by a count the model maintains. This one line is what
    # replaced the fill/refill motions and the stale-count hazard.
    It 'bounds the worker pool by the capacity cap'
      When call rule_in "$SKILL" 'Math\.min(args\.cap, DISPATCHES\.length)'
      The status should be success
      The output should equal '1'
    End

    It 'says the cap stays machine-wide because one workflow covers the whole batch'
      When call phrase_in "$SKILL" 'never one workflow per repo, is what makes'
      The status should be success
      The output should equal '1'
    End

    # Every entry returned carries its own dispatch payload beside its
    # result, which is what lets a null result still be reaped and reported
    # by name.
    It 'returns each dispatch alongside its result'
      When call rule_in "$SKILL" 'return DISPATCHES\.map((d, i) => ({ dispatch: d, result: results\[i\] }))'
      The status should be success
      The output should equal '1'
    End

    # The template is deliberately thin: dispatch and schema only. A reap or
    # a summary stage inside it would put the per-group `post-agent.sh`
    # accounting somewhere phase 7 cannot read it.
    It 'keeps the reap and the summary outside the script'
      When call phrase_in "$SKILL" 'it dispatches and it validates, and nothing else'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the schema that replaces the fenced-block parse'
    # The agent is forced through structured output, so the shape is
    # validated at the tool-call layer and retried on a mismatch. Without a
    # schema the template is just a parallel Task loop and the old "an
    # unparseable block is a failure report" prose has nothing standing in
    # its place.
    It 'passes a schema on every agent call'
      When call rule_in "$SKILL" 'schema: RESULT_SCHEMA,'
      The status should be success
      The output should equal '1'
    End

    It 'defines that schema in the template'
      When call rule_in "$SKILL" '^const RESULT_SCHEMA = {$'
      The status should be success
      The output should equal '1'
    End

    # The schema must validate agents/fix-dependency.md's Result block, not a
    # subset of it: a field dropped from `required` is a field an agent can
    # silently omit and phase 7 then reports as absent.
    It 'requires every field the agent Result contract promises'
      When call blob_in "$SKILL" "required: \[ 'status', 'package', 'major_line', 'repo', 'branch', 'pr_url', 'action', 'resolved_version', 'risk', 'observations', 'requires_major_bump', 'bare_override', 'no_op', 'failure', \],"
      The status should be success
      The output should equal '1'
    End

    Describe 'the enumerations the Result contract fixes'
      Parameters
        # field            the enumeration line the schema must carry
        status             "status: { enum: \['success', 'no-op', 'failure'\] },"
        bare_override      "bare_override: { enum: \['none', 'added', 'tightened'\] },"
        failure.phase      "enum: \['input', 'worktree', 'baseline', 'classify', 'apply', 'install', 'validate', 'push', 'pr'\],"
      End

      It "pins the $1 enumeration"
        When call rule_in "$SKILL" "$2"
        The status should be success
        The output should equal '1'
      End
    End

    # The verdict the schema replaces has to be stated, or a validation
    # failure reads as an unexplained gap. A null entry is a failure report
    # for that group and is reaped and tabled like any other.
    It 'says a group whose entry comes back null is still a failure report, and still reported'
      When call phrase_in "$SKILL" 'is a failure report for that group, and is still reported'
      The status should be success
      The output should equal '1'
    End

    It 'reaps a null entry with an empty result file so post-agent.sh reports it missing'
      When call phrase_in "$SKILL" 'with an empty result file, and .post-agent.sh. reports it .missing'
      The status should be success
      The output should equal '1'
    End

    It 'never drops, hand-retries, or counts a null entry as a success'
      When call phrase_in "$SKILL" 'never dropped, never retried by hand, and never counted as a success'
      The status should be success
      The output should equal '1'
    End

    It 'reads phase 7 off the returned entries rather than a fence'
      When call phrase_in "$SKILL" 'The workflow returns .*one entry per approved group'
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

    # The payload is unchanged from the Task-per-group era, including the
    # one field whose absence is meaningful: an omitted key, never a null.
    Describe 'the dispatch payload'
      Parameters
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

    It 'still omits env_prefix rather than sending null'
      When call phrase_in "$SKILL" 'omit the key rather than send null'
      The status should be success
      The output should equal '1'
    End
  End
End
