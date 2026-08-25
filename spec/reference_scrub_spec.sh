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
# the slugs that identify the internal enterprise are gated here: a
# reintroduction fails the suite instead of waiting for a reviewer to
# recognize a string that looks like any other placeholder. Only the internal
# slugs are machine-checkable. Field cases cited generically ("the field-test
# repository") and structural examples given fictitious names
# (`@example-org/example-repo`, `octo/app`) are the rule's other half, and that
# half is on review; see the reference rule in `CLAUDE.md`.
#
# This file necessarily spells the slugs it forbids, so it excludes itself from
# the scan. They are already public in this repository's history and in the
# issue above, so quoting them here republishes nothing.

Describe 'references in tracked files'
  # `git grep` over the index rather than a glob: the rule covers every tracked
  # file, fixtures and documentation included, not only the shell scripts.
  internal_slugs() {
    git -C "$SHELLSPEC_PROJECT_ROOT" grep -nEi \
      -e 'momentive|mntv|@[A-Za-z0-9_-]+_emu' \
      -- ':!:spec/reference_scrub_spec.sh'
  }

  It 'names no internal organization, repository or workspace'
    When call internal_slugs
    The status should equal 1
    The output should equal ''
    The stderr should equal ''
  End
End
