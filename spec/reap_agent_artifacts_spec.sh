#!/bin/sh
# shellcheck shell=sh
# The orchestrator-side reap (issue #131), as prose pins.
#
# The reap itself is `src/reap.ts`, tested in tests/plugins/gh-security/reap.test.ts
# and in the examples of `reap-batch`. Nothing executable decides *when* it
# runs or what happens to the artifacts it deliberately leaves: that is
# orchestrator prose in SKILL.md and agent prose in fix-dependency.md, so the
# sentences are the implementation and their absence is the whole regression
# (the spec/fix_dependency_branch_spec.sh pattern).

Describe 'the orchestrator-side reap (issue #131)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  # Issue #171/#173: the phase 6 reap procedure is one `reap-batch` call. The
  # path template, the `<package_path>` sanitization rule, and the two-step
  # pr-status and reap breakdown belong to the command
  # (`src/subcommands/reap-batch.ts`). SKILL.md keeps only the
  # orchestrator-level policy that still has to be decided here: when to call
  # it, and that its failure is never fatal.
  Describe 'the step in phase 6'
    It 'never interpolates the raw package name into a worktree path in either document'
      raw_path_sites() {
        grep -c 'worktrees/fix-dependabot-<package>' "$SKILL" "$AGENT" | awk -F: '{ s += $NF } END { print s }'
      }
      When call raw_path_sites
      The status should be success
      The output should equal '0'
    End
  End

  Describe 'the agent definition agrees with it'
    # The agent never clears what a `worktree` failure names: the person
    # inspects it.
    It 'keeps the guard from clearing it anyway'
      When call phrase_in "$AGENT" 'Never delete a directory or branch that a .worktree. failure names'
      The status should be success
      The output should equal '1'
    End
  End
End
