#!/bin/sh
# shellcheck shell=sh
# The no-internal-references rule, enforced rather than left to review.
#
# This repository is public. Naming an organization, repository, account or
# workspace topology from outside the public `@SurveyMonkey` org leaks the
# shape of private infrastructure exactly the way an internal package name
# leaks a private dependency graph, and a worked example in a comment leaks it
# as readily as a fixture does: `detect-scope.sh` documented its innermost-`@`
# rule with a real EMU workspace path, and the spec table that drives it repeated
# the same path back
# ([#120](https://github.com/SurveyMonkey/skills/issues/120)).
#
# Prose alone did not hold those two sites for the length of a milestone, so
# the slugs that identify the internal enterprise, plus the four personal-org
# slugs a later scrub removed (arsenalamerica, tacoma.fyi,
# prusa-connect-auto-ready, bork), are gated here: a reintroduction fails the
# suite instead of waiting for a reviewer to recognize a string that looks
# like any other placeholder. The `_emu` suffix is matched both `@`-prefixed
# and bare, since a workspace path can name the slug without the leading `@`.
# Only these slugs are machine-checkable. Field cases cited generically ("the
# field-test repository") and structural examples given fictitious names
# (`@example-org/example-repo`, `octo/app`) are the rule's other half, and
# that half is on review; see the reference rule in `CLAUDE.md`. The
# retained `owner: brianespinosa` frontmatter is deliberately left ungated
# too — it names an author, not a codebase or organization, and a bare
# `brianespinosa` pattern would gate that attribution along with anything
# else the reviewer needs to catch — so it stays on review as well.
#
# This file necessarily spells the slugs it forbids, so it excludes itself from
# the scan. They are already public in this repository's history and in the
# issue above, so quoting them here republishes nothing.

Describe 'references in tracked files'
  # `git grep` (no `--cached`) scans the working-tree content of tracked
  # files, fixtures and documentation included, not only the shell scripts.
  internal_slugs() {
    git -C "$SHELLSPEC_PROJECT_ROOT" grep -nEi \
      -e 'momentive|mntv|@[A-Za-z0-9_-]+_emu|[A-Za-z0-9_-]+_emu' \
      -e 'arsenalamerica|tacoma\.fyi|prusa-connect-auto-ready' \
      -e '(^|[^A-Za-z0-9_-])bork([^A-Za-z0-9_-]|$)' \
      -- ':!:spec/reference_scrub_spec.sh'
  }

  # Same pattern, deliberately without the self-exclusion pathspec: the
  # positive control that proves the pattern is not vacuously passing because
  # it matches nothing at all. This file's own header and pattern definition
  # are the specimen — they spell the forbidden slugs themselves — so the
  # scan must find them, and only them.
  internal_slugs_unfiltered() {
    git -C "$SHELLSPEC_PROJECT_ROOT" grep -nEi \
      -e 'momentive|mntv|@[A-Za-z0-9_-]+_emu|[A-Za-z0-9_-]+_emu' \
      -e 'arsenalamerica|tacoma\.fyi|prusa-connect-auto-ready' \
      -e '(^|[^A-Za-z0-9_-])bork([^A-Za-z0-9_-]|$)'
  }

  # Any line the unfiltered scan turns up that is NOT from this file would be
  # a real internal reference the main example's exclusion pathspec is
  # hiding. There should be none: this file's own slugs are the only
  # specimen in the tree.
  foreign_slugs() {
    internal_slugs_unfiltered | grep -v '^spec/reference_scrub_spec\.sh:'
  }

  It 'names no internal organization, repository or workspace'
    When call internal_slugs
    The status should equal 1
    The output should equal ''
    The stderr should equal ''
  End

  It 'finds its own slugs when the self-exclusion is removed'
    When call internal_slugs_unfiltered
    The status should equal 0
    The output should include 'spec/reference_scrub_spec.sh:'
    The stderr should equal ''
  End

  It 'confines every unfiltered match to its own definition'
    When call foreign_slugs
    The status should equal 1
    The output should equal ''
    The stderr should equal ''
  End
End
