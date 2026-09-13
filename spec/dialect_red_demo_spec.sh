#!/bin/sh
# shellcheck shell=sh
# TEMPORARY: the deliberately bad line that shows spec/grep_dialect_spec.sh
# can fail. Removed in the next commit.

Describe 'a pattern in the dialect the guard forbids'
  It 'counts nothing on macOS, and says so nowhere'
    When call grep -c 'alpha\|beta' /dev/null
    The status should equal 1
    The output should equal '0'
  End
End
