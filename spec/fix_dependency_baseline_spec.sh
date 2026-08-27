#!/bin/sh
# shellcheck shell=sh
# The control-install baseline rules agents/fix-dependency.md states as prose
# (issue #146). Nothing in a script enforces the sequencing: the adapter's
# --baseline check deliberately does not loosen for ambient drift (see
# node_validate_spec.sh), so the agent definition's phase ordering — classify
# on the never-installed tree, then a no-change control install, its drift
# committed, THEN the snapshot — is the whole fix, and its absence is the
# whole regression: a stale default-branch lockfile makes validate blame
# ambient re-resolution on the fix and fail-close groups whose own override is
# correct. The drift-cleared subcase (the control install itself resolving the
# vulnerable copy) is prose too, and losing it silently reverts a real fix
# into a false "already fixed" no-op.

Describe 'the control-install baseline rules in fix-dependency (#146)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"

  # Same two readers as spec/fix_dependency_result_spec.sh: `rule_in` counts
  # lines and suits a prescribed command or a sentence that fits on one,
  # `phrase_in` flattens the file first and suits anything the 100-column
  # wrap may split.
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  # The sequencing itself, both halves structural. Classify (phase 2) comes
  # before the control-install phase (phase 3), so the cheap dead-ends never
  # pay for an install; and within phase 3 the control install comes before
  # the `resolved_versions` baseline snapshot, because a snapshot taken first
  # attributes the ambient drift to the fix.
  classify_before_install() {
    cls=$(grep -n '^## Phase 2: Classify the dependency$' "$AGENT" | cut -d: -f1)
    ctl=$(grep -n '^## Phase 3: Control install' "$AGENT" | cut -d: -f1)
    [ -n "$cls" ] && [ -n "$ctl" ] && [ "$cls" -lt "$ctl" ] && echo 'classify first'
  }

  baseline_phase_order() {
    section=$(sed -n '/^## Phase 3:/,/^## Phase 4:/p' "$AGENT")
    inst=$(printf '%s\n' "$section" | grep -n 'ADAPTER install' | head -1 | cut -d: -f1)
    snap=$(printf '%s\n' "$section" | grep -n 'ADAPTER resolved_versions' | tail -1 | cut -d: -f1)
    [ -n "$inst" ] && [ -n "$snap" ] && [ "$inst" -lt "$snap" ] && echo 'control install first'
  }

  It 'classifies on the never-installed tree, before the control-install phase'
    When call classify_before_install
    The status should be success
    The output should equal 'classify first'
  End

  It 'runs the control install before the baseline snapshot in phase 3'
    When call baseline_phase_order
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
    The output should not equal '0'
  End

  It 'sanctions one retry per install invocation, not one for the whole flow'
    When call phrase_in "$AGENT" 'one sanctioned retry per install invocation'
    The status should be success
    The output should equal '1'
  End

  It 'gives the control install and the fix install a retry each'
    When call phrase_in "$AGENT" 'control install and the fix install each get their own'
    The status should be success
    The output should equal '1'
  End

  It 'makes the empty-porcelain path explicit: no drift commit, straight to the snapshot'
    When call phrase_in "$AGENT" 'no drift commit is made, and you go straight to the baseline snapshot'
    The status should be success
    The output should equal '1'
  End

  It 'never stages package.json into the drift commit'
    When call phrase_in "$AGENT" 'Never stage .package.json'
    The status should be success
    The output should equal '1'
  End

  It 'stages the zero-install and PnP install artifacts beside the lockfile'
    When call phrase_in "$AGENT" 'every ..yarn/cache/. path that .status --porcelain. reports'
    The status should be success
    The output should equal '1'
  End

  It 'preserves residual porcelain as evidence rather than absorbing it'
    When call phrase_in "$AGENT" 'never clean it up, delete it, or fold it into a commit'
    The status should be success
    The output should equal '1'
  End

  It 'keeps a lone unrelated drift commit from opening a PR on the no-op path'
    When call phrase_in "$AGENT" 'still opens no PR even when an unrelated drift commit exists'
    The status should be success
    The output should equal '1'
  End

  Describe 'the drift-cleared subcase is a lockfile-refresh, never a no-op'
    It 'states the distinguisher: compare the line across the drift commit'
      When call phrase_in "$AGENT" 'Compare your line across the drift commit'
      The status should be success
      The output should equal '1'
    End

    It 'names the real fix whose content is the drift commit'
      When call phrase_in "$AGENT" 'whose content is the drift commit, not a no-op'
      The status should be success
      The output should equal '1'
    End

    It 'carries lockfile-refresh in the result action enum'
      When call rule_in "$AGENT" 'direct-update | scoped-override | bare-override | lockfile-refresh'
      The status should be success
      The output should equal '1'
    End

    It 'is recognized by the orchestrator reporting'
      When call phrase_in "$SKILL" 'lockfile-refresh'
      The status should be success
      The output should not equal '0'
    End
  End

  # The orchestrator's triage label covers every ambient phase-baseline shape:
  # a failed control install, residual non-lockfile changes, and a hook that
  # failed the drift commit all say the repository — not the group — is the
  # problem.
  It 'routes every ambient baseline failure shape to one repo-level triage label'
    When call phrase_in "$SKILL" 'baseline could not be established (ambient, affects every group)'
    The status should be success
    The output should equal '1'
  End
End
