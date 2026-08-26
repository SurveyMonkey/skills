#!/bin/sh
# shellcheck shell=sh
# Scope comes from git, and where a clone lands is asked, not derived
# (issue #134).
#
# The executable half is spec/common_scripts_spec.sh: detect-scope.sh answers
# `repo` inside a repository with an nwo parsed from origin, and a null scope
# outside one. This file pins the half that lives in prose, because the
# orchestrator is the only thing that consumes a null scope and the only thing
# that decides where a new checkout goes. The @-owner layout is allowed to
# survive as a suggested default in that question and nowhere else; a
# reintroduced path computation, or a returning "the user can override the
# detected scope" carve-out, is exactly the regression the issue is about, and
# neither is visible to any script (the spec/fix_dependency_branch_spec.sh
# pattern).

Describe 'scope and checkout resolution in prose (issue #134)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  CMD="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/commands/audit-pins.md"

  # A wrapped paragraph is not one grep line, so the file is flattened first.
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  # Same reader, named for its other use: a shape that must be ABSENT. `grep
  # -o | wc -l` reports zero without failing on it, which `grep -c` would.
  count_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'phase 1 states the git-derived rule'
    It 'says scope comes from git rather than from directory names'
      When call phrase_in "$SKILL" 'Scope comes from git, never from what the directories are named'
      The status should be success
      The output should equal '1'
    End

    # nwo has one source now, so the old cross-check has nothing to compare
    # against and the old carve-out has nothing to override.
    It 'makes origin the only source of nwo'
      When call phrase_in "$SKILL" 'which is now its only source'
      The status should be success
      The output should equal '1'
    End

    It 'stops when the checkout has no usable origin'
      When call phrase_in "$SKILL" 'the repository has no usable .origin.; report that and stop'
      The status should be success
      The output should equal '1'
    End

    It 'no longer offers a scope override'
      When call count_in "$SKILL" 'The user can override this'
      The status should be success
      The output should equal '0'
    End

    It 'no longer tiebreaks git_remote against nwo'
      When call count_in "$SKILL" 'disagrees with .nwo., trust'
      The status should be success
      The output should equal '0'
    End
  End

  Describe 'a null scope becomes a question, never a guess'
    It 'asks what to operate on'
      When call phrase_in "$SKILL" 'Ask what to operate on'
      The status should be success
      The output should equal '1'
    End

    # Three answers, because org, the user's own repos, and one named repo are
    # what the old path walk used to infer from a segment.
    It 'offers the org, the user own repos, and one named repo'
      When call phrase_in "$SKILL" 'This org.. — org scope'
      The status should be success
      The output should equal '1'
    End

    It 'routes a named repo through the same checkout resolution as any other'
      When call phrase_in "$SKILL" 'for the single repo a user named when phase 1.s scope came back null'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'phase 5 asks once where clones go'
    It 'asks before the first repo is resolved'
      When call phrase_in "$SKILL" 'Ask once, before the first repo is resolved, where new clones go'
      The status should be success
      The output should equal '1'
    End

    It 'makes it one question for the whole run rather than one per repo'
      When call phrase_in "$SKILL" 'one question for the whole run'
      The status should be success
      The output should equal '1'
    End

    It 'offers a directory the user keeps and a temporary one'
      When call phrase_in "$SKILL" 'A temporary directory, cleaned up when the run ends'
      The status should be success
      The output should equal '1'
    End

    # The whole surviving role of the workspace convention.
    It 'keeps the @-owner layout as a suggested default only'
      When call phrase_in "$SKILL" 'as the suggested default'
      The status should be success
      The output should equal '1'
    End

    It 'says nothing else reads that convention'
      When call phrase_in "$SKILL" 'Nothing else in this skill reads that convention'
      The status should be success
      The output should equal '1'
    End

    # The computation the issue removed: an expected path built out of an owner
    # directory and a repo name.
    It 'computes no checkout path from an owner directory'
      When call count_in "$SKILL" '<owner-directory>'
      The status should be success
      The output should equal '0'
    End

    It 'reuses an existing checkout wherever one is found'
      When call phrase_in "$SKILL" 'Reuse a checkout wherever one is found; clone only what is missing'
      The status should be success
      The output should equal '1'
    End

    # A checkout the run did not create outlives it under either answer, which
    # is what makes the temporary option safe to offer at all.
    It 'never removes a checkout it did not create'
      When call phrase_in "$SKILL" 'A checkout the run did not create is never removed by it'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'phase 7 cleans up the temporary destination'
    It 'removes it and says so'
      When call phrase_in "$SKILL" 'when phase 5.s clone destination was the temporary one, remove it and say so'
      The status should be success
      The output should equal '1'
    End

    It 'prescribes the removal against the destination path'
      When call phrase_in "$SKILL" 'rm -rf <clone-destination>'
      The status should be success
      The output should equal '1'
    End

    It 'scopes the removal to the directory this run created'
      When call phrase_in "$SKILL" 'only the directory this run created for its own clones'
      The status should be success
      The output should equal '1'
    End

    It 'says a named destination is left alone'
      When call phrase_in "$SKILL" 'removes nothing and says nothing here'
      The status should be success
      The output should equal '1'
    End

    It 'grants the two commands the phase needs'
      When call phrase_in "$SKILL" 'allowed-tools:.*Bash(mktemp -d.*Bash(rm -rf '
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the audit command reads the same contract'
    It 'branches on a null scope rather than on org or user'
      When call phrase_in "$CMD" 'If .scope. is null'
      The status should be success
      The output should equal '1'
    End

    It 'drops the git_remote cross-check it can no longer make'
      When call count_in "$CMD" 'disagrees with .nwo., trust'
      The status should be success
      The output should equal '0'
    End

    It 'stops on a null nwo'
      When call phrase_in "$CMD" 'this checkout has no usable .origin.; report that and stop'
      The status should be success
      The output should equal '1'
    End
  End
End
