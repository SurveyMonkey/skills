#!/bin/sh
# shellcheck shell=sh
# The jq precedence floor, enforced rather than asserted in a comment.
#
# `as` binds its entire right-hand side, so `A // B as $x | body` parses as
# `A // (B as $x | body)`: whenever A is neither null nor false the
# alternative short-circuits, the binding never happens, and the program
# yields A instead of `body`. Parenthesizing the default — `(A // B) as $x` —
# is the only reading that means what these scripts intend.
#
# Nothing in the suite noticed. jq 1.8 (Homebrew, and what a development
# machine runs) happens to give the intended reading, while jq 1.7 —
# ubuntu-latest's, and the floor these scripts support — gives the other one.
# `node.sh`'s `NPM_COPY_ROWS_JQ` began `.packages // {} as $pkgs` and returned
# the lockfile's packages map in place of its rows, so on Linux every parent
# read from the lockfile came back `parents_unreadable` while every macOS leg
# was green ([#82](https://github.com/SurveyMonkey/skills/pull/82)).
#
# A version-specific example would pin the wrong thing: the defect is a
# construct that is ambiguous to read and version-dependent to run, so what is
# gated here is the construct, in every shipped script, on every platform.

Describe 'jq bindings in the shipped scripts'
  # A `//`-defaulted binding whose default is not closed by a `)` before the
  # `as`. Lines where the whole expression is parenthesized carry that `)`
  # between the `//` and the `as`, which is exactly what this refuses to match.
  # Comment lines are dropped: both shell and jq comment with `#`, and the
  # prose explaining this rule quotes the shape it forbids.
  unparenthesized_defaults() {
    grep -nE '//[^)]*[^)[:space:]][[:space:]]+as[[:space:]]+\$' \
      "$SCRIPTS"/ecosystems/*.sh "$SCRIPTS"/common/*.sh \
      | grep -vE '^[^:]*:[0-9]+:[[:space:]]*#'
  }

  It 'parenthesizes every default before it is bound'
    When call unparenthesized_defaults
    The status should equal 1
    The output should equal ''
    The stderr should equal ''
  End
End
