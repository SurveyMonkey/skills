#!/bin/sh
# shellcheck shell=sh
# The fix branch lifecycle (issue #84), and where it lives now.
#
# It used to be prose in agents/fix-dependency.md: phase 1 created the branch
# and Cleanup disposed of it, both by instruction, so the definition's
# sentences were the whole implementation and their absence was the whole
# regression. `common/fix-group.sh` is that implementation now, and the
# behavioural assertions moved with it — the three recognized tips and the
# unpushed-work refusal are in spec/fix_group_setup_spec.sh, asserted against
# real git repositories rather than against a paragraph.
#
# What stays here is what a script cannot hold: that the agent definition
# delegates rather than re-deriving (a prose re-derivation of a driver-owned
# procedure is the bug this issue's fix creates the room for), that the safety
# rule survives in both places, and that the sentences the defect shipped as
# have not come back.

Describe 'the fix branch lifecycle in fix-dependency (#84, #171)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  DRIVER="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/common/fix-group.sh"
  CONV="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/CLAUDE.md"
  ADR="$SHELLSPEC_PROJECT_ROOT/docs/adr/003-worktree-isolation-and-concurrency-cap.md"

  # Two readers, as in spec/audit_pins_rules_spec.sh: `rule_in` counts lines and
  # suits a prescribed command or a sentence that fits on one, `phrase_in`
  # flattens the file first and suits anything the 100-column wrap may split.
  # `count_in` reports zero without failing, which is what an absent shape needs
  # (`grep -c` exits 1 on no match).
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  count_in() { grep -c -e "$2" -- "$1" || true; }

  Describe 'the definition delegates the branch lifecycle to the driver'
    It 'calls the driver for setup rather than prescribing the guard'
      When call rule_in "$AGENT" 'fix-group.sh setup --group-json'
      The status should be success
      The output should not equal '0'
    End

    It 'calls the driver for cleanup rather than prescribing the delete'
      When call rule_in "$AGENT" 'fix-group.sh cleanup --work'
      The status should be success
      The output should not equal '0'
    End

    # The one rule the agent still owes a reader: the delete is conditional, and
    # a branch it left behind is a fact the result has to carry.
    It 'gates the delete on it being provably safe'
      When call phrase_in "$AGENT" 'only when deleting it is provably safe'
      The status should be success
      The output should equal '1'
    End

    It 'says an unrecreatable commit is what the leave-behind protects'
      When call phrase_in "$AGENT" 'cannot be recreated'
      The status should be success
      The output should not equal '0'
    End

    # The prohibition that has to survive in the agent even though the driver
    # is what would run the command: sibling agents share this repo_root.
    It 'still forbids repository-wide git commands'
      When call phrase_in "$AGENT" 'never run .git worktree prune'
      The status should be success
      The output should equal '1'
    End

    # And the convention document names the driver as the single home, so the
    # next reader re-derives nothing.
    It 'names the driver as the single home of phases 1 to 5'
      When call phrase_in "$CONV" 'single home of that procedure'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the driver still carries all three safe cases'
    # Each is asserted behaviourally in spec/fix_group_setup_spec.sh; these
    # pin that the reasoning stayed with the code, since a comment naming the
    # case is what stops the next reader from collapsing three branches into
    # one "delete it, it is ours".
    Parameters
      'the pushed tip'   'the remote carries the same commits'
      'the untouched tip' 'there is nothing on the branch to lose'
      'the drift commit'  'regenerates equivalently from the same manifests'
    End

    It "grounds $1"
      When call rule_in "$DRIVER" "$2"
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the sentences the defect shipped as have not returned'
    # Cleanup left the branch behind on every run, so the next run of the same
    # group always found one and always stopped.
    It 'no longer says the branch simply remains'
      When call count_in "$AGENT" 'fix branch itself remains'
      The status should be success
      The output should equal '0'
    End

    It 'no longer stops on the mere existence of a local branch'
      When call count_in "$AGENT" 'any output => branch exists => stop'
      The status should be success
      The output should equal '0'
    End

    # The procedural bodies themselves: their return to the agent definition is
    # the re-derivation the driver exists to prevent.
    Parameters
      'the stale-branch guard command' 'git -C <repo_root> branch -D <branch_name>'
      'the worktree add'               'git -C <repo_root> worktree add'
      'the drift commit message'       'control install, no manifest change'
      'the validate invocation'        'ADAPTER validate --line'
    End

    It "no longer prescribes $1"
      When call count_in "$AGENT" "$2"
      The status should be success
      The output should equal '0'
    End
  End

  # ADR 003 decided the unconditional stop and described a `$WORK/base`
  # comparison worktree that ADR 006 retired with F5's attribution discipline.
  # A decision record that still states the retired rule is what the next reader
  # implements.
  Describe 'ADR 003 records both corrections'
    It 'amends the guard decision'
      When call phrase_in "$ADR" 'compares tips instead of stopping on existence'
      The status should be success
      The output should equal '1'
    End

    It 'retires the base worktree'
      When call phrase_in "$ADR" 'nothing needs a default-branch comparison'
      The status should be success
      The output should equal '1'
    End

    It 'says one tree is installed, not two'
      When call phrase_in "$ADR" 'the fix flow installs one tree'
      The status should be success
      The output should equal '1'
    End
  End
End
