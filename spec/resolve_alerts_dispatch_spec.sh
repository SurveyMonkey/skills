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
#
# **Know what that cannot do.** These are textual pins, not execution. No
# JSON Schema validator runs here, so a schema that is well-formed but
# UNSATISFIABLE — the state `allOf` was in before issue #175's final review,
# where a truthful `status: "failure"` carrying `bare_override: "added"`
# matched no value of `action` — passes every per-line pin. Adding a
# JavaScript runtime to the repo-wide gate for one spec file is an ADR-level
# dependency change and was declined; the script's real verification is the
# post-merge field run. Two habits compensate, and both are load-bearing:
#   * **Pin guard BODIES, never just their `if` lines.** A `throw` gutted to
#     nothing leaves the condition byte-identical, and a pin on the condition
#     alone stays green against a guard that no longer guards.
#   * **Pin the cross-field rules relationally** (every `allOf` gate reachable
#     for the branch it constrains), not by presence, since presence is
#     exactly what an unsatisfiable combination also has.
# The pins fall into three groups: the template's own load-bearing lines, the
# invariants #175 introduced, and the phase 6 rules that survived the rewrite
# and would otherwise be deleted by a later editor as pool-era leftovers.

Describe 'phase 6 dispatches one workflow (issue #175)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  SCRIPTS_DOC="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/CLAUDE.md"
  REAP="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/common/reap-agent-artifacts.sh"
  ADR="$SHELLSPEC_PROJECT_ROOT/docs/adr/003-worktree-isolation-and-concurrency-cap.md"
  README="$SHELLSPEC_PROJECT_ROOT/README.md"

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
        meta-entry           "{ title: 'Fix groups', detail: 'one fix-dependency agent per approved group', model: 'sonnet' },"
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
      When call rule_in "$SKILL" '^const WORKERS = Math\.min(args\.cap, DISPATCHES\.length)$'
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
      When call blob_in "$SKILL" 'return { dispatch: d, result: r, mispaired: Boolean(r) && !paired }'
      The status should be success
      The output should equal '1'
    End

    # Phase 7 promises entries "in the order they were dispatched", and the
    # only thing holding that is the indexed write: workers finish out of
    # order, so a refactor to results.push() would scramble the order
    # silently while every other pin here still passed.
    It 'writes each result at its own index rather than appending'
      When call rule_in "$SKILL" '^    results\[i\] = await agent($'
      The status should be success
      The output should equal '1'
    End

    It 'never appends results in completion order'
      no_push() { grep -c 'results\.push' "$1" || true; }
      When call no_push "$SKILL"
      The status should be success
      The output should equal '0'
    End

    It 'promises that order to phase 7'
      When call phrase_in "$SKILL" 'in the order they were dispatched'
      The status should be success
      The output should equal '1'
    End

    # Position alone is not a safe pairing. Workers steal from a shared
    # cursor, so the order agent() calls are initiated varies run to run, and
    # resume caches "the longest unchanged prefix of agent() calls" without
    # saying whether a call is matched by content or by position. If
    # positional, a resumed run hands entry i another group's result and the
    # reap deletes the wrong branch. The script checks instead of assuming.
    It 'checks each result against the identity its own dispatch names'
      When call blob_in "$SKILL" "const paired = r && r.package === d.group.package && r.major_line === d.group.major_line && r.repo === d.group.repo"
      The status should be success
      The output should equal '1'
    End

    It 'flags a mispaired entry rather than trusting it'
      When call rule_in "$SKILL" 'mispaired: Boolean(r) && !paired'
      The status should be success
      The output should equal '1'
    End

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
        action             "action: { enum: \['direct-update', 'scoped-override', 'bare-override', 'lockfile-refresh', null\] },"
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

    It 'still omits env_prefix rather than sending null'
      When call phrase_in "$SKILL" 'omit the key rather than send null'
      The status should be success
      The output should equal '1'
    End
  End
  Describe 'the model pin (ADR 004)'
    # agents/fix-dependency.md pins `model: sonnet` in its frontmatter, which
    # is what a Task dispatch honors. A workflow agent() with no `model`
    # inherits the session model, and whether agentType composes with the
    # target definition's frontmatter is unspecified — so the pin is stated
    # at the call site. Losing it would put a 33-group field run on whatever
    # model the session held, voiding ADR 004 with nothing to notice.
    It 'passes sonnet explicitly on the agent call'
      When call rule_in "$SKILL" "^        model: 'sonnet',$"
      The status should be success
      The output should equal '1'
    End

    It 'mirrors it on the meta phase entry'
      When call rule_in "$SKILL" "detail: 'one fix-dependency agent per approved group', model: 'sonnet'"
      The status should be success
      The output should equal '1'
    End

    It 'says which mechanism holds the pin here'
      When call phrase_in "$SKILL" 'that is what holds ADR 004.s pin here'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the agent frontmatter pin ADR 004 names'
      When call rule_in "$AGENT" '^model: sonnet$'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the args guard'
    # Every one of these failures is otherwise silent, and the worst of them
    # inverts the report: an absent `cap` makes the worker count NaN,
    # Array.from({length: NaN}) empty, parallel([]) return at once, and every
    # entry stay null — which phase 7 reads as a whole batch of crashed
    # agents when nothing was ever dispatched.
    It 'rejects a missing or stringified dispatches list'
      When call rule_in "$SKILL" 'if (!args || !Array\.isArray(args\.dispatches) || !args\.dispatches\.length) {'
      The status should be success
      The output should equal '1'
    End

    It 'rejects a cap that is not a number of at least one'
      When call rule_in "$SKILL" "if (typeof args\.cap !== 'number' || !(args\.cap >= 1)) {"
      The status should be success
      The output should equal '1'
    End

    # Pin the THROW, not only the `if`. Gutting the body while leaving the
    # condition byte-identical is the mutation that survives a condition-only
    # pin, and it produces exactly the silent empty batch the guard exists
    # for.
    It 'throws on a missing or stringified dispatches list rather than proceeding'
      When call blob_in "$SKILL" "throw new Error('args.dispatches must be a non-empty array of dispatch payloads"
      The status should be success
      The output should equal '1'
    End

    It 'throws on a bad cap rather than proceeding'
      When call blob_in "$SKILL" "throw new Error('args.cap must be a number >= 1, from detect-capacity.sh')"
      The status should be success
      The output should equal '1'
    End

    # An empty dispatch list is refused by the same guard: Array.from({length:
    # 0}) and parallel([]) both succeed silently, so an empty batch would
    # return zero entries and read as a clean run over nothing.
    It 'refuses an empty dispatch list, not just an absent one'
      When call rule_in "$SKILL" '|| !args\.dispatches\.length) {'
      The status should be success
      The output should equal '1'
    End

    It 'announces what it is dispatching and at what width'
      When call rule_in "$SKILL" "^log('Dispatching '"
      The status should be success
      The output should equal '1'
    End

    It 'tells the caller to pass args as JSON, never as a JSON-encoded string'
      When call phrase_in "$SKILL" 'Pass .args. as an actual JSON value, never as a JSON-encoded string'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the cross-field rules the Result contract fixes'
    # Field-for-field validation is not enough: {"status":"failure",
    # "failure":null} passes every per-field check, clears post-agent.sh's
    # gate (branch/package/major_line only), and reaches phase 7's "failures
    # get their phase and detail" with no data source.
    It 'encodes exactly-one-of no_op and failure, agreeing with status'
      When call rule_in "$SKILL" '^  oneOf: \['
      The status should be success
      The output should equal '1'
    End

    Describe 'one branch per status value'
      Parameters
        # Each branch is identified with its own pr_url nullability, because
        # `status: { const: 'success' }` alone now also matches both allOf
        # gates.
        success   "status: { const: 'success' }, pr_url: { type: 'string' },"
        no-op     "status: { const: 'no-op' }, pr_url: { type: 'null' },"
        failure   "status: { const: 'failure' }, pr_url: { type: 'null' },"
      End

      It "pins the $1 branch"
        When call blob_in "$SKILL" "$2"
        The status should be success
        The output should equal '1'
      End
    End

    # The failure branch nulls `action`. That is what makes the gate below
    # mandatory rather than tidy, so pin it here where the two rules meet.
    It 'nulls action on the failure branch'
      When call blob_in "$SKILL" "status: { const: 'failure' }, pr_url: { type: 'null' }, action: { type: 'null' },"
      The status should be success
      The output should equal '1'
    End

    Describe 'the bare_override to action agreement, in both directions' 
      Parameters
        bare_override-implies-action  "then: { properties: { action: { const: 'bare-override' } } },"
        action-implies-bare_override  "then: { properties: { bare_override: { enum: \['added', 'tightened'\] } } },"
      End

      It "encodes $1"
        When call rule_in "$SKILL" "$2"
        The status should be success
        The output should equal '1'
      End
    End

    # The mutation this file cannot execute its way to, so it is checked
    # structurally instead: every `allOf` gate must be reachable only on
    # success. Ungated, the agreement rule demands action === 'bare-override'
    # while the failure branch demands action === null, so a truthful failure
    # carrying bare_override "added" satisfies NO value of action. The schema
    # stays well-formed and every presence pin stays green, which is exactly
    # why presence pins are not enough here. The census fails loudly if the
    # block moves rather than reporting a vacuous zero.
    It 'gates every allOf rule on success, so no branch is unsatisfiable'
      allof_gate_census() {
        allof_window=$(awk '/^  allOf: \[/{f=1} f{print} f && /^  \],$/{exit}' "$1" | tr '\n' ' ' | tr -s ' ')
        [ -n "$allof_window" ] || { echo 'allOf block not found'; return 0; }
        allof_total=$(printf '%s\n' "$allof_window" | grep -o 'if: {' | wc -l | tr -d ' ')
        allof_gated=$(printf '%s\n' "$allof_window" | grep -o "if: { properties: { status: { const: 'success' }" | wc -l | tr -d ' ')
        echo "$allof_gated/$allof_total"
      }
      When call allof_gate_census "$SKILL"
      The status should be success
      The output should equal '2/2'
    End

    It 'records why the gate exists, against the escalation that reaches it'
      When call rule_in "$SKILL" 'hook-rejected push and a failed pr all reach'
      The status should be success
      The output should equal '1'
    End

    It 'names the silent under-report the ungated rule invites'
      When call blob_in "$SKILL" 'the likelier repair it finds is to report'
      The status should be success
      The output should equal '1'
    End

    # The two arrays phase 7 actually reads element-by-element.
    It 'validates the element shape of observations'
      When call blob_in "$SKILL" "observations: { type: 'array', items: { type: 'object', required: \['type'\],"
      The status should be success
      The output should equal '1'
    End

    # The specimen is node.sh's own `$bump` array (spec/node_validate_spec.sh:
    # {"version":"5.29.0","vulnerable_ranges":["< 6.28.0"]}), not an invented
    # {package, resolved_version} shape.
    It 'validates the element shape of requires_major_bump against the adapter it comes from'
      When call blob_in "$SKILL" "required: \['version', 'vulnerable_ranges'\],"
      The status should be success
      The output should equal '1'
    End

    # Narrowing observations.type to an enum would reject three types the
    # adapter really emits. The comment is the guard against a future editor
    # "tightening" it.
    It 'refuses to narrow the observation type to an enum'
      When call phrase_in "$SKILL" 'Do NOT narrow this to an enum'
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

  Describe 'the interruption contract'
    # The largest way a group can now disappear: a barrier loses every result
    # at once, and the agents that ran had already pushed branches and opened
    # PRs. Under the old pool each completion arrived on its own, so an abort
    # still left the orchestrator holding everything received so far.
    # Pinned on the two words that carry the rule, not on the whole sentence:
    # the earlier form quoted an inline aside and broke on a meaning-
    # preserving reword.
    It 'refuses to read an absent or short return as nothing having run'
      When call phrase_in "$SKILL" 'absent or short return'
      The status should be success
      The output should equal '1'
    End

    # All three abort modes, named. Only the short-return mode was pinned
    # before; a contract that covers one of three is a contract with two
    # silent holes.
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
End
