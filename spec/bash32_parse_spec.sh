#!/bin/sh
# shellcheck shell=sh
# The bash 3.2 floor, enforced rather than asserted in a comment.
#
# scripts/CLAUDE.md targets bash 3.2 — the default macOS /bin/bash — and
# node.sh depends on it concretely: 3.2 scans for the closing `)` of a command
# substitution while tracking double quotes, so a heredoc body carrying an
# unpaired `"` is cut short and the rest of the file is parsed as shell. The
# awk programs work around it with `sprintf("%c", 34)`.
#
# Nothing in the suite noticed. `.shellspec` runs the examples under
# `--shell sh`, and the adapter runs under whatever `bash` leads PATH, which on
# a development machine is Homebrew's 5.x — so a reintroduced unpaired quote
# went green everywhere modern bash is installed, while the comment claimed the
# suite was the protection ([#49](https://github.com/SurveyMonkey/skills/issues/49)).
#
# `-n` is a parse-only check: it reads the whole file and executes none of it,
# which is the entire claim being made.

Describe 'the shipped scripts parse under bash 3.2'
  # Only /bin/bash on macOS is the 3.2 this targets. A Linux runner has no
  # /bin/bash 3.x (often no /bin/bash at all), and parsing under 5.x is not the
  # claim, so the example skips there rather than passing for the wrong reason
  # or failing for one.
  no_bash32() {
    [ -x /bin/bash ] || return 0
    ! /bin/bash --version 2>/dev/null | head -1 | grep -q 'version 3\.'
  }
  Skip if 'no bash 3.x at /bin/bash' no_bash32

  parse_all() {
    # scripts/check.sh targets 3.2 too: the pre-commit hook runs it on stock
    # macOS.
    for _f in "$SCRIPTS"/ecosystems/*.sh "$SCRIPTS"/common/*.sh \
        "$SHELLSPEC_PROJECT_ROOT"/scripts/*.sh; do
      /bin/bash -n "$_f" || return 1
    done
  }

  It 'parses every adapter and common script'
    When call parse_all
    The status should be success
    The stderr should equal ''
  End
End

# CI's macOS leg sets REQUIRE_BASH32=1: that platform is supposed to supply
# bash 3.2, so its absence there must fail rather than skip. The Skip above is
# green, and without this example the parse gate could quietly stop running on
# the one runner that exists to run it while the job stays green
# (.github/workflows/gates.yml).
Describe 'the platform expected to supply bash 3.2'
  Skip if 'REQUIRE_BASH32 not set' [ "${REQUIRE_BASH32:-}" != 1 ]

  It 'actually has it at /bin/bash'
    When call /bin/bash --version
    The line 1 of output should include 'version 3.2'
  End
End
