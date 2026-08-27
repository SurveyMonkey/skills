#!/bin/sh
# shellcheck shell=sh
# The control-install baseline rules agents/fix-dependency.md states as prose
# (issue #146). Nothing in a script enforces the sequencing: the adapter's
# --baseline check deliberately does not loosen for ambient drift (see
# node_validate_spec.sh), so the agent definition's phase 2 ordering — a
# no-change control install, its drift committed, THEN the snapshot — is the
# whole fix, and its absence is the whole regression: a stale default-branch
# lockfile makes validate blame ambient re-resolution on the fix and
# fail-close groups whose own override is correct.

Describe 'the control-install baseline rules in fix-dependency (#146)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  # Same two readers as spec/fix_dependency_result_spec.sh: `rule_in` counts
  # lines and suits a prescribed command or a sentence that fits on one,
  # `phrase_in` flattens the file first and suits anything the 100-column
  # wrap may split.
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  # The sequencing itself: within phase 2, the control install comes before
  # the `resolved_versions` snapshot. Order is the fix — a snapshot taken
  # first attributes the ambient drift to the fix.
  phase2_order() {
    section=$(sed -n '/^## Phase 2:/,/^## Phase 3:/p' "$AGENT")
    inst=$(printf '%s\n' "$section" | grep -n 'ADAPTER install' | head -1 | cut -d: -f1)
    snap=$(printf '%s\n' "$section" | grep -n 'ADAPTER resolved_versions' | head -1 | cut -d: -f1)
    [ -n "$inst" ] && [ -n "$snap" ] && [ "$inst" -lt "$snap" ] && echo 'control install first'
  }

  It 'runs the control install before the baseline snapshot in phase 2'
    When call phase2_order
    The status should be success
    The output should equal 'control install first'
  End

  It 'reports a control-install failure as phase baseline, never phase install'
    When call phrase_in "$AGENT" 'control install that fails is a failure with phase .baseline., ..not.. .install.'
    The status should be success
    The output should equal '1'
  End

  It 'prescribes the drift-commit message naming the no-change control install'
    When call rule_in "$AGENT" 'control install, no manifest change'
    The status should be success
    The output should equal '1'
  End

  It 'sanctions one retry per install invocation, not one for the whole flow'
    When call phrase_in "$AGENT" 'one sanctioned retry per install invocation'
    The status should be success
    The output should equal '1'
  End

  It 'keeps a lone drift commit from opening a PR on the no-op path'
    When call phrase_in "$AGENT" 'no-op still opens no PR even when a drift commit exists'
    The status should be success
    The output should equal '1'
  End
End
