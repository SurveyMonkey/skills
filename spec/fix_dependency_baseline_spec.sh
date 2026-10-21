#!/bin/sh
# shellcheck shell=sh
# The control-install baseline rules (issue #146), and where they live now.
#
# They were prose in agents/fix-dependency.md. The adapter's --baseline check
# does not loosen for ambient drift (see node_validate_spec.sh). So the phase
# order is the whole fix. First classify on the never-installed tree. Then do
# a no-change control install and commit its drift. THEN take the snapshot. The
# `gh-security fix-group` command runs that order, and
# tests/plugins/gh-security/subcommands/fix-group.test.ts covers it.
#
# What stays here is the agent prose. The orchestrator half is code since #229:
# `summarize-run` labels a baseline failure and a lockfile-refresh action
# (tests/plugins/gh-security/subcommands/summarize-run.test.ts).

Describe 'the control-install baseline rules (#146, #171)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  # Same two readers as spec/fix_dependency_result_spec.sh: `rule_in` counts
  # lines and suits a prescribed command or a sentence that fits on one,
  # `phrase_in` flattens the file first and suits anything the 100-column
  # wrap may split.
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | tr -s ' ' | grep -o -e "$2" | wc -l | tr -d ' '; }

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
End
