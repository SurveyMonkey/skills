#!/bin/sh
# shellcheck shell=sh
# The grep dialect this suite writes in, enforced rather than left to review.
#
# BSD grep, which is what macOS ships and what one of the two CI legs runs,
# reads a BRE `\|` as a literal bar and does not support `\s` at all. A
# pattern carrying either matches nothing there, so an example asserting a
# count of zero passes for the wrong reason and an example asserting a
# non-zero count fails on one platform only. Both shapes have shipped here:
# spec/resolve_alerts_scope_spec.sh's alternation over three spellings was
# vacuously green on macOS, green for the prose it was written to forbid
# (spec/PINS.md, and the worked example in the `testing` skill's tests.md).
#
# The rule was a line in that skill's review checklist, which is to say it
# held for exactly as long as a reviewer remembered it. Issue #216 replaced
# the line with this gate: a mechanical rule that needs a reviewer to stay
# alive wants to be an executable example instead, which is the skill's own
# rule about prose pins turned on the skill.
#
# Scope and lifetime. It scans every tracked shell file under spec/, the
# helpers in spec_helper.sh and spec/support/ included, for a forbidden
# character sitting on the same line as a `grep` call or a `*_in` pin helper.
# It lives until the last shellspec prose pin is retired (#197, #231,
# RFC 002): once nothing under spec/ hands a pattern to grep any more, this
# file goes with them.
#
# Two shapes it cannot see, stated here rather than left to be discovered, the
# way spec/reference_scrub_spec.sh states the half of its own rule that stays
# on review. The scan matches one physical line at a time, so a pattern
# written on a line continuing from the call above it is invisible; and the
# only two triggers are the literal `grep` and a name ending in `_in`, so a
# pin helper named anything else is invisible too. Both stay on review.
#
# Self-exclusion, in the shape of spec/reference_scrub_spec.sh: this file
# necessarily spells the shapes it forbids, so the scan excludes it, and the
# two examples below it prove the scan is not passing because it matches
# nothing at all.

Describe 'the grep dialect in spec/'
  # A pattern argument, not prose about one: the line must carry `grep` or a
  # `*_in` pin helper call, and the match must not be a comment. Comments are
  # dropped deliberately, because several spec files document this very rule
  # by quoting the shapes it forbids, and a gate that cannot tell a pattern
  # from a sentence about a pattern would forbid explaining itself. `[|s]` is a
  # bracket expression rather than an alternation, which is the same dialect
  # discipline this file exists to enforce.
  DIALECT='(grep|_in ).*\\[|s]'

  # Drops the comment lines out of a `path:line:content` scan. Separate from
  # the scan rather than folded into its pattern: an anchored not-a-comment
  # prefix would have to consume the `grep` token it is looking for.
  drop_comments() { grep -vE '^[^:]*:[0-9][0-9]*:[[:space:]]*#'; }

  # `git grep` (no `--cached`) scans the working-tree content of tracked
  # files, so a pattern added but not yet committed is caught too. The
  # pathspec is every shell file under spec/, not only the `*_spec.sh` ones:
  # the pin helpers are duplicated across a dozen spec files today and the
  # obvious next refactor hoists one into spec_helper.sh, which a spec-file
  # pathspec would stop watching at exactly that moment.
  gnu_only_patterns() {
    git -C "$SHELLSPEC_PROJECT_ROOT" grep -nE "$DIALECT" \
      -- 'spec/*.sh' ':!:spec/grep_dialect_spec.sh' | drop_comments
  }

  # The same scan without the self-exclusion: the positive control. The
  # specimen below is what it must find.
  gnu_only_patterns_unfiltered() {
    git -C "$SHELLSPEC_PROJECT_ROOT" grep -nE "$DIALECT" \
      -- 'spec/*.sh' | drop_comments
  }

  # Any unfiltered match from another file would be a real violation the
  # exclusion above is hiding. There should be none.
  foreign_patterns() {
    gnu_only_patterns_unfiltered | grep -v '^spec/grep_dialect_spec\.sh:'
  }

  # The specimen the control needs: one real, non-comment line carrying each
  # forbidden shape. A comment would not serve, because the scan skips
  # comments by design. Nothing calls this function, and nothing should.
  gnu_only_specimen() {
    grep -c 'alpha\|beta' /dev/null
    grep -c 'alpha\sbeta' /dev/null
  }

  # The specimen the comment filter needs, owned here rather than borrowed
  # from whichever unrelated spec file happens to spell both tokens in one
  # sentence. The indented line below is prose about a pattern:
  #   grep -c 'gamma\|delta' /dev/null
  # and the last two examples assert that the raw scan finds it and the
  # filtered scan does not.
  commented_specimen() {
    git -C "$SHELLSPEC_PROJECT_ROOT" grep -nE "$DIALECT" \
      -- 'spec/grep_dialect_spec.sh'
  }

  commented_specimen_hits() {
    commented_specimen | grep -cE '^[^:]*:[0-9][0-9]*:[[:space:]]*#'
  }

  surviving_comment_hits() {
    commented_specimen | drop_comments | grep -cE '^[^:]*:[0-9][0-9]*:[[:space:]]*#' || true
  }

  It 'passes no grep pattern written in a GNU-only dialect'
    When call gnu_only_patterns
    The status should equal 1
    The output should equal ''
    The stderr should equal ''
  End

  It 'finds its own specimen when the self-exclusion is removed'
    When call gnu_only_patterns_unfiltered
    The status should equal 0
    The output should include 'spec/grep_dialect_spec.sh:'
    The stderr should equal ''
  End

  It 'confines every unfiltered match to its own specimen'
    When call foreign_patterns
    The status should equal 1
    The output should equal ''
    The stderr should equal ''
  End

  It 'sees its own commented specimen before the comment filter'
    When call commented_specimen_hits
    The status should be success
    The output should not equal '0'
    The stderr should equal ''
  End

  It 'drops that commented specimen'
    When call surviving_comment_hits
    The status should be success
    The output should equal '0'
    The stderr should equal ''
  End
End
