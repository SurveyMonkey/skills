#!/bin/sh
# shellcheck shell=sh
# scripts/common/notice-scan.sh: PostToolUse hook that nudges toward
# gh-security resolve-alerts on GitHub vulnerability notices or non-zero
# package manager audit output.

Describe 'notice-scan.sh'
  # Build the PostToolUse stdin payload the hook receives, with the given
  # tool_response text. jq -n --arg keeps embedded quotes/newlines intact,
  # which raw shell interpolation into a heredoc would not.
  payload() {
    jq -n --arg name "${2:-Bash}" --arg out "$1" \
      '{tool_name: $name, tool_input: {command: "irrelevant"}, tool_response: $out}'
  }

  # Run the hook and reduce stdout to a compact jq projection, same pattern
  # as adapter_jq/common_jq: assert exact JSON, not pretty-printed spacing.
  # Preserves exit status.
  notice_jq() {
    _filter=$1; _out_text=$2; _tool=${3:-Bash}
    _st=0
    _raw=$(payload "$_out_text" "$_tool" | "$COMMON/notice-scan.sh") || _st=$?
    if [ -n "$_raw" ]; then
      printf '%s' "$_raw" | jq -c "$_filter"
    fi
    return "$_st"
  }

  Describe 'GitHub-sourced notices'
    Parameters
      "push-time notice"        "remote: GitHub found 8 vulnerabilities on brianespinosa/app's default branch (2 critical, 3 high, 2 moderate, 1 low). To find out more, visit:"
      "dependabot alert url"    "remote:      https://github.com/brianespinosa/app/security/dependabot/3"
      "dependabot overview url" "remote:      https://github.com/brianespinosa/app/security/dependabot"
    End

    It "matches a $1 and offers resolve-alerts directly"
      When call notice_jq '{event: .hookSpecificOutput.hookEventName, offers_directly: (.hookSpecificOutput.additionalContext | test("resolve-alerts"))}' "$2"
      The status should be success
      The output should equal '{"event":"PostToolUse","offers_directly":true}'
    End
  End

  Describe 'package manager audit output'
    npm_summary="2 vulnerabilities (1 moderate, 1 high)
  run \`npm audit fix\` to fix them"
    pnpm_summary="3 vulnerabilities found
Severity: 1 low | 2 moderate"

    Parameters
      "npm audit summary"        "$npm_summary"
      "npm install-time warning" "found 5 vulnerabilities (2 low, 3 high) in 1850 scanned packages"
      "pnpm audit summary"       "$pnpm_summary"
      "yarn audit summary"       "1 vulnerability found - Packages audited: 942"
    End

    # PM audit findings only nudge toward checking GitHub; they never claim a
    # fix is available, since GitHub is the sole data source (RFC 001 Phase 5).
    It "nudges toward checking GitHub alerts on $1, without offering directly"
      When call notice_jq '{event: .hookSpecificOutput.hookEventName, mentions_github: (.hookSpecificOutput.additionalContext | test("GitHub")), offers_directly: (.hookSpecificOutput.additionalContext | test("Offer to run"))}' "$2"
      The status should be success
      The output should equal '{"event":"PostToolUse","mentions_github":true,"offers_directly":false}'
    End
  End

  Describe 'non-matching output stays silent'
    ordinary_output="ok
nothing interesting here"
    clean_status="On branch main
nothing to commit, working tree clean"

    Parameters
      "ordinary command output"               "$ordinary_output"
      "clean git status"                      "$clean_status"
      "zero npm vulnerabilities"              "found 0 vulnerabilities"
      "zero pnpm vulnerabilities"             "0 vulnerabilities found"
      "vulnerability mentioned without count" "No known vulnerabilities found"
      "the word vulnerability with no digit"  "Checking for vulnerability disclosures policy"
    End

    It "emits nothing for $1"
      When call notice_jq '.' "$2"
      The status should be success
      The output should equal ''
    End
  End

  It 'ignores non-Bash tool calls even with matching text in the payload'
    When call notice_jq '.' "GitHub found 8 vulnerabilities on main" "Read"
    The status should be success
    The output should equal ''
  End

  It 'exits cleanly on malformed stdin instead of erroring the hook'
    When run script "$COMMON/notice-scan.sh"
    The status should be success
    The output should equal ''
  End
End
