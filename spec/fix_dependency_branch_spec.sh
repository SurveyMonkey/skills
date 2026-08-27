#!/bin/sh
# shellcheck shell=sh
# The branch lifecycle rules agents/fix-dependency.md states as prose (issue
# #84). Nothing in a script decides any of this: phase 1 creates the branch and
# Cleanup disposes of it, both by instruction, so the definition's sentences are
# the whole implementation and their absence is the whole regression.
#
# The defect was the two halves read together, not either alone: Cleanup left
# the branch behind on every exit path, and phase 1 stopped on any local branch
# of that name, so every second run of a group failed at phase `worktree` on a
# leftover of the first. Each example below fails if one half returns to that
# shape.

Describe 'the fix branch lifecycle in fix-dependency (#84)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  ADR="$SHELLSPEC_PROJECT_ROOT/docs/adr/003-worktree-isolation-and-concurrency-cap.md"

  # Two readers, as in spec/audit_pins_rules_spec.sh: `rule_in` counts lines and
  # suits a prescribed command or a sentence that fits on one, `phrase_in`
  # flattens the file first and suits anything the 100-column wrap may split.
  # `count_in` reports zero without failing, which is what an absent shape needs
  # (`grep -c` exits 1 on no match).
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  count_in() { grep -c -e "$2" -- "$1" || true; }

  Describe 'Cleanup disposes of the branch it created'
    # Without the command itself the rest of the section is advice nobody can
    # follow. It names repo_root because the worktree is already gone by then.
    It 'prescribes the delete at repo_root'
      When call rule_in "$AGENT" 'git -C <repo_root> branch -D <branch_name>'
      The status should be success
      The output should not equal '0'
    End

    It 'gates the delete on it being provably safe'
      When call phrase_in "$AGENT" 'only when deleting it is provably safe'
      The status should be success
      The output should equal '1'
    End

    # The two safe cases, each of which has to survive on its own: a pushed
    # branch is a duplicate of a remote ref, and an untouched one carries
    # nothing. Losing either sentence quietly halves the cleanup and leaves the
    # deadlock open on the other path.
    It 'treats a pushed tip as safe because the remote carries it'
      When call phrase_in "$AGENT" 'the remote carries the same commits'
      The status should be success
      The output should equal '1'
    End

    It 'treats a tip still at the default branch as safe'
      When call phrase_in "$AGENT" 'there is nothing on the branch to lose'
      The status should be success
      The output should equal '1'
    End

    # The third safe case (#146, #152): a branch whose only commit is the
    # drift commit carries nothing a rerun cannot derive again. Grounded in
    # machine-derivability, not identity — hooks and timestamps make byte
    # identity a promise the flow cannot keep.
    It 'treats a drift-commit-only branch as safe to delete'
      When call phrase_in "$AGENT" "Your only commit is Phase 3's drift commit"
      The status should be success
      The output should equal '1'
    End

    It 'grounds that safety in an equivalent regenerated commit, not an identical one'
      When call phrase_in "$AGENT" 'regenerates an equivalent commit from the same manifests'
      The status should be success
      The output should not equal '0'
    End

    # Anything else is unpushed work, and the way out of a cleanup is not the
    # place to adjudicate it.
    It 'leaves an unaccounted branch in place and reports it'
      When call phrase_in "$AGENT" 'Otherwise leave the branch and say so in'
      The status should be success
      The output should equal '1'
    End

    # git refuses to delete a branch checked out in a worktree, so the reversed
    # order fails on exactly the branch it meant to clean up — and fails
    # silently if anyone ever adds `|| true` to it.
    It 'requires the worktree to come off first'
      When call phrase_in "$AGENT" 'Git refuses to delete a branch that is checked out'
      The status should be success
      The output should equal '1'
    End

    # The sentence the defect shipped as. Its return means cleanup stopped
    # deleting anything.
    It 'no longer says the branch simply remains'
      When call count_in "$AGENT" 'fix branch itself remains'
      The status should be success
      The output should equal '0'
    End
  End

  Describe 'phase 1 verifies the branch instead of stopping on sight'
    # The old guard, verbatim from the shipped definition. Any output at all
    # stopped the run, which is the unconditional stop this issue removed.
    It 'no longer stops on the mere existence of a local branch'
      When call count_in "$AGENT" 'any output => branch exists => stop'
      The status should be success
      The output should equal '0'
    End

    It 'says the guard verifies rather than stops on sight'
      When call phrase_in "$AGENT" 'verifies rather than stops on sight'
      The status should be success
      The output should equal '1'
    End

    # The tip is the whole test, and both comparisons are needed: one covers a
    # run that pushed, the other a run that committed nothing.
    It 'reads a leftover tip as this plugin.s own'
      When call phrase_in "$AGENT" 'and you may delete and recreate it'
      The status should be success
      The output should equal '1'
    End

    It 'fetches the remote fix branch before comparing against it'
      When call rule_in "$AGENT" 'git -C <repo_root> fetch origin <branch_name>'
      The status should be success
      The output should not equal '0'
    End

    It 'reads a missing remote branch as ordinary, not as an error'
      When call phrase_in "$AGENT" 'which is the ordinary case and not an error'
      The status should be success
      The output should equal '1'
    End

    # The guard's third recognized tip (#152): a leftover carrying only this
    # flow's own drift commit, identified by both its subject and its
    # lockfile/install-artifact-only paths, never by either alone.
    It 'recognizes a drift-commit-only tip as this flow.s own leftover'
      When call phrase_in "$AGENT" 'form a single drift commit'
      The status should be success
      The output should equal '1'
    End

    It 'requires both the subject check and the paths check'
      When call phrase_in "$AGENT" 'Recognize it by both checks, not either alone'
      The status should be success
      The output should equal '1'
    End

    # The guard still has to stop for the case it was written for, or the fix
    # has traded a deadlock for a discarded commit.
    It 'still stops on a tip that matches none of the recognized cases'
      When call phrase_in "$AGENT" 'is none of these is someone'
      The status should be success
      The output should equal '1'
    End

    # A shape found in the wild is the specimen: both field-test branches are
    # named so the claim stays concrete rather than vague, even though the
    # repository they came from is scrubbed (see issue #84 for the
    # verification path).
    It 'cites the field-test specimens'
      When call phrase_in "$AGENT" 'fix/dependabot-react-router-6x'
      The status should be success
      The output should equal '1'
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
