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

    # Discovery for a named repo happens in phase 2, before phase 5 resolves
    # that repo's environment, so the call runs with whatever identity the
    # shell has. Saying so is the honest version; the alternative is a reader
    # assuming a prefix that does not exist yet.
    It 'admits discovery for a named repo precedes per-repo environment resolution'
      When call phrase_in "$SKILL" 'runs before any per-repo environment resolution exists'
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
      When call phrase_in "$SKILL" 'A temporary directory, cleaned up when every group in it opens a PR'
      The status should be success
      The output should equal '1'
    End

    # The temporary directory sits outside every workspace directory by
    # construction, so nothing above it can supply directory-scoped
    # credentials and every command for those repos runs unprefixed. That is
    # the issue #33 failure class — a fetch that reports the repository as
    # missing, an install that 401s — so the cost is stated in the question
    # rather than discovered mid-batch.
    It 'warns that the temporary option voids a directory-scoped command prefix'
      When call phrase_in "$SKILL" 'runs without the command prefix your environment requires'
      The status should be success
      The output should equal '1'
    End

    It 'tells the user to name a directory in such a workspace'
      When call phrase_in "$SKILL" 'In such a workspace, name a directory instead'
      The status should be success
      The output should equal '1'
    End

    # The temporary path is created with a greppable prefix and recorded, so
    # the removal in phase 7 is one literal string rather than a computed
    # path, and the tool grant can name the shape.
    It 'creates the temporary directory with a recognizable prefix'
      When call phrase_in "$SKILL" 'mktemp -d -t gh-security-clones'
      The status should be success
      The output should equal '2'
    End

    It 'records that path as the only removable one'
      When call phrase_in "$SKILL" "treat it as this run's only removable"
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

  Describe 'phase 7 cleans up the temporary destination only when it is safe'
    It 'decides rather than removing unconditionally'
      When call phrase_in "$SKILL" 'clone destination was the temporary one, decide whether it can be'
      The status should be success
      The output should equal '1'
    End

    # The defect this replaced: an unconditional `rm -rf` destroyed exactly
    # what phase 6's reap deliberately preserves. A group whose agent ended
    # without a verified open PR never pushed, so its worktree and branch
    # inside the temporary directory are the only copies of that work.
    It 'states why an unverified group makes the directory unremovable'
      When call phrase_in "$SKILL" 'agent ended without a verified open PR has nothing on the remote'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the whole directory when any group ended another way'
      When call phrase_in "$SKILL" 'keep the whole directory'
      The status should be success
      The output should equal '1'
    End

    It 'reports the kept path and the groups that are the reason'
      When call phrase_in "$SKILL" 'where it is, and which groups are the reason'
      The status should be success
      The output should equal '1'
    End

    It 'refuses to read the temporary destination as a licence to delete work'
      When call phrase_in "$SKILL" 'never in the sense that this skill deletes unpushed work'
      The status should be success
      The output should equal '1'
    End

    # The removal names the recorded mktemp path and nothing else: no parent,
    # no glob, no path the user named.
    It 'prescribes the removal against the recorded path'
      When call phrase_in "$SKILL" 'rm -rf <the recorded gh-security-clones path>'
      The status should be success
      The output should equal '1'
    End

    It 'forbids widening or substituting that path'
      When call phrase_in "$SKILL" 'Never widen that path and never substitute another'
      The status should be success
      The output should equal '1'
    End

    It 'says a named destination is left alone'
      When call phrase_in "$SKILL" 'removes nothing and says nothing here'
      The status should be success
      The output should equal '1'
    End

    # The grant is as narrow as every other entry on that line: a verb plus a
    # fixed component, not `rm -rf` over the filesystem.
    It 'grants the two commands the phase needs, narrowed to that prefix'
      When call phrase_in "$SKILL" 'allowed-tools:.*Bash(mktemp -d -t gh-security-clones.*Bash(rm -rf .gh-security-clones'
      The status should be success
      The output should equal '1'
    End

    It 'grants no unqualified recursive removal'
      When call count_in "$SKILL" 'Bash(rm -rf .), '
      The status should be success
      The output should equal '0'
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

    # The first detect-scope output described a path in no repository, so
    # every field of it is null. Continuing from the checkout the user names
    # means reading a second output, or the two paragraphs below stop the
    # audit on a null that describes the wrong path.
    It 're-runs detect-scope against the checkout the user names'
      When call phrase_in "$CMD" 'Re-run .detect-scope.sh <that checkout>. and read .nwo., .default_branch.'
      The status should be success
      The output should equal '1'
    End

    It 'reads the second output rather than the first'
      When call phrase_in "$CMD" 'from the second output.., never from the first'
      The status should be success
      The output should equal '1'
    End
  End
End
