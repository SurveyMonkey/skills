#!/bin/sh
# shellcheck shell=sh
# The control-install baseline rules (issue #146), and where they live now.
#
# They used to be prose in agents/fix-dependency.md, because the adapter's
# --baseline check deliberately does not loosen for ambient drift (see
# node_validate_spec.sh) and the phase ordering was therefore the whole fix:
# classify on the never-installed tree, then a no-change control install, its
# drift committed, THEN the snapshot. `common/fix-group.sh` executes that
# ordering now, and spec/fix_group_spec.sh asserts it by running the steps and
# reading the adapter's call order back.
#
# What stays here is the contract's other two ends: the driver's own grounding
# for the ordering, and the orchestrator prose that reads the results. The
# drift-cleared subcase (the control install itself resolving the vulnerable
# copy) is pinned in both, because losing it silently reverts a real fix into a
# false "already fixed" no-op.

Describe 'the control-install baseline rules (#146, #171)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  DRIVER="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/common/fix-group.sh"
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"

  # Same two readers as spec/fix_dependency_result_spec.sh: `rule_in` counts
  # lines and suits a prescribed command or a sentence that fits on one,
  # `phrase_in` flattens the file first and suits anything the 100-column
  # wrap may split.
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the driver holds the ordering and its reasons'
    It 'spells the drift-commit subject exactly once, as one constant'
      When call rule_in "$DRIVER" "^DRIFT_SUBJECT='chore(deps): refresh lockfile (control install, no manifest change)'$"
      The status should be success
      The output should equal '1'
    End

    It 'grounds the post-control ordering in the attribution it protects'
      When call rule_in "$DRIVER" 'measures only movement the fix itself causes'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the never-stage-package.json rule beside the staging code'
      When call rule_in "$DRIVER" 'Never .package.json.: the control install had no manifest edit'
      The status should be success
      The output should equal '1'
    End

    It 'preserves residual porcelain as evidence rather than absorbing it'
      When call rule_in "$DRIVER" 'evidence, never noise to absorb'
      The status should be success
      The output should not equal '0'
    End

    It 'reports a control-install failure as phase baseline, never phase install'
      When call rule_in "$DRIVER" 'A failure here is phase .baseline., never .install.'
      The status should be success
      The output should equal '1'
    End

    It 'sanctions one retry per install invocation, on a registry-timeout shape only'
      When call rule_in "$DRIVER" 'One sanctioned retry per install invocation'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the drift-cleared subcase a real fix, not a no-op'
      When call rule_in "$DRIVER" 'real fix whose content is the drift commit, not a no-op'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the agent definition reports what the driver decided'
    It 'names the baseline failure as ambient rather than group-specific'
      When call phrase_in "$AGENT" 'ambient, not group-specific'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the hook rules governing the drift commit too'
      When call phrase_in "$AGENT" 'The hook rules in phase 6 apply here unchanged'
      The status should be success
      The output should equal '1'
    End

    It 'carries lockfile-refresh in the result action enum'
      When call rule_in "$AGENT" 'direct-update | scoped-override | bare-override | lockfile-refresh'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the orchestrator reads both outcomes'
    It 'recognizes a lockfile-refresh action'
      When call phrase_in "$SKILL" 'lockfile-refresh'
      The status should be success
      The output should not equal '0'
    End

    # Every ambient phase-baseline shape — a failed control install, residual
    # non-lockfile changes, a hook that failed the drift commit — says the
    # repository, not the group, is the problem.
    It 'routes every ambient baseline failure shape to one repo-level triage label'
      When call phrase_in "$SKILL" 'baseline could not be established (ambient, affects every group)'
      The status should be success
      The output should equal '1'
    End
  End
End
