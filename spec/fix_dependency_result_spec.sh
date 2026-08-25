#!/bin/sh
# shellcheck shell=sh
# The hang-hardening rules agents/fix-dependency.md states as prose (issue
# #122). Nothing in a script enforces any of this: the agent decides, on its
# own, whether a stalled adapter verb is a failure or something to wait on, so
# the definition's sentences are the whole implementation and their absence is
# the whole regression.
#
# The failure mode: a field run hit a hung adapter verb, backgrounded it, and
# attached a monitor to wait for it to finish. The agent's turn ended with a
# prose message saying it was waiting for the background monitor to notify
# it — no fenced JSON result block, no worktree cleanup, no branch cleanup,
# and the hung process still running. The orchestrator has no way to tell
# that apart from a crash except that a crash at least frees the slot; a
# parked turn does not even do that. Each example below fails if the rule
# that prevents it goes missing again.

Describe 'the hang-hardening rules in fix-dependency (#122)'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"

  # Two readers, as in spec/fix_dependency_branch_spec.sh: `rule_in` counts
  # lines and suits a prescribed command or a sentence that fits on one,
  # `phrase_in` flattens the file first and suits anything the 100-column
  # wrap may split. Phrases are distinctive fragments, not whole sentences,
  # so a copyedit that reflows or rewords around them does not break the
  # spec — only removing the rule itself does.
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'adapter verbs are expected to terminate'
    It 'states the rule that a verb is expected to terminate'
      When call phrase_in "$AGENT" 'Adapter verbs are expected to terminate'
      The status should be success
      The output should equal '1'
    End

    It 'treats an unreturned or repeatedly-failing verb as a failed phase'
      When call phrase_in "$AGENT" 'is not still working; it has failed the phase'
      The status should be success
      The output should equal '1'
    End

    It 'forbids backgrounding a hung verb'
      When call phrase_in "$AGENT" 'Never background a hung verb'
      The status should be success
      The output should equal '1'
    End

    It 'forbids attaching a monitor and waiting on it'
      When call phrase_in "$AGENT" 'monitor and wait for it to notify you'
      The status should be success
      The output should equal '1'
    End

    It 'cites the field failure the rule was written to prevent'
      When call phrase_in "$AGENT" 'ended its turn saying it was waiting on the monitor'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'cleanup and the result block survive an abort'
    It 'requires cleanup on an abort for a hung or failing verb'
      When call phrase_in "$AGENT" 'including an abort on a hung or repeatedly failing verb'
      The status should be success
      The output should equal '1'
    End

    It 'says killing a hung verb does not excuse cleanup'
      When call phrase_in "$AGENT" 'does not excuse Cleanup; it is the reason you run it'
      The status should be success
      The output should equal '1'
    End

    It 'says ending the turn without a result block is never valid'
      When call phrase_in "$AGENT" 'without one is never a valid terminal state'
      The status should be success
      The output should equal '1'
    End

    It 'names a parked or waiting message as a contract violation'
      When call phrase_in "$AGENT" 'violation the orchestrator cannot tell apart from a crash'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the resolve-alerts result-handling mirror'
    It 'reads a missing result block as a contract violation, not a wait'
      When call phrase_in "$SKILL" 'never to park a turn waiting on a hung verb'
      The status should be success
      The output should equal '1'
    End
  End
End
