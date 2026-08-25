#!/bin/sh
# shellcheck shell=sh
# The branch-namespace preflight and flat fallback scheme (issue #123).
#
# The field failure: a target repo carried a pre-existing branch literally
# named `fix` (`refs/heads/fix`). Git refs are a filesystem namespace, so that
# file blocks every `fix/*` ref, and each fix agent finished its entire fix —
# bump, install, validate ok, local commit — before the push failed with
#   ! [remote rejected] fix/dependabot-postcss-8x -> fix/dependabot-postcss-8x (directory file conflict)
# The fix is one probe per repo before dispatch plus a slash-free fallback
# naming scheme, and both halves live where their kind of logic lives: the
# probe is orchestrator prose in resolve-alerts SKILL.md, the same venue as
# the phase 6 registry preflight it is modeled on, while the mechanical scheme
# selection is scripted and executable-spec'd — discover-alerts.sh
# --branch-style (spec/discover_alerts_spec.sh, spec/discover_alerts_scope_spec.sh),
# classify-lines.sh --branch-style (spec/classify_lines_spec.sh), and the
# notice hook's recognition of flat pushes (spec/notice_scan_spec.sh). No
# `Mock git` here for the same reason there is none for the registry probe:
# nothing executable runs `ls-remote`, so these examples pin the sentences
# the orchestrator acts on, per the spec/fix_dependency_branch_spec.sh
# pattern.

Describe 'the branch-namespace preflight (issue #123)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the probe in SKILL.md'
    # Once at repo scope (phase 1) and once per repo at org/user scope
    # (phase 5 step 4): exactly one probe per repo at every scope, resolved
    # alongside env_prefix and default_branch.
    It 'prescribes one fully-qualified ls-remote probe at each scope resolution point'
      When call phrase_in "$SKILL" 'git -C <repo_root> ls-remote --heads origin refs/heads/fix'
      The status should be success
      The output should equal '2'
    End

    # The hit flips the batch's naming, it never excludes the repo: the
    # semantics that distinguish this preflight from the registry one.
    # Phase 1 states the mapping, phase 2 applies it to discovery, phase 5
    # step 4 states it per repo and step 5 applies it to classify-lines.
    It 'maps a refs/heads/fix hit onto --branch-style flat at every consuming site'
      When call phrase_in "$SKILL" '--branch-style flat'
      The status should be success
      The output should equal '4'
    End

    It 'gives the probe the registry preflight retry'
      When call phrase_in "$SKILL" 'exactly like phase 6.s registry probe'
      The status should be success
      The output should equal '1'
    End

    # A probe that fails twice means origin is unreachable for the fetch and
    # push every agent needs — the exclusion route, mirroring a null
    # default_branch, not the flip route.
    It 'excludes a repo whose probe fails twice, reporting the probe stderr rather than a diagnosis'
      When call phrase_in "$SKILL" 'excluded from dispatch and reported in phase 7 with the probe.s stderr verbatim'
      The status should be success
      The output should equal '1'
    End

    It 'names the unprobed inverse collision instead of claiming coverage'
      When call phrase_in "$SKILL" 'inverse collision'
      The status should be success
      The output should equal '2'
    End

    It 'reports every flat-scheme repo in the phase 7 summary'
      When call phrase_in "$SKILL" 'name every repo whose batch ran under the flat branch scheme'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the fix agent stays a dumb consumer of branch_name'
    It 'consumes either spelling verbatim'
      When call phrase_in "$AGENT" 'you never choose or rewrite the spelling'
      The status should be success
      The output should equal '1'
    End

    # The field push-rejection string is the specimen for the one
    # classification the agent makes: this rejection is a preflight miss,
    # never a transient push failure.
    It 'classifies the field rejection shape as a namespace collision'
      When call phrase_in "$AGENT" '! \[remote rejected\] fix/dependabot-postcss-8x -> fix/dependabot-postcss-8x (directory file conflict)'
      The status should be success
      The output should equal '1'
    End

    It 'forbids improvising a branch name at push time'
      When call phrase_in "$AGENT" 'never rename the branch yourself'
      The status should be success
      The output should equal '1'
    End
  End
End
