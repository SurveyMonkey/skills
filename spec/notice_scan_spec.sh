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

  # Same, but takes a pre-built stdin payload verbatim instead of wrapping
  # tool_response through payload() — for cases about the envelope shape
  # itself (missing tool_response, object-shaped stdout/stderr, non-object
  # top-level JSON, truncated JSON).
  notice_jq_raw() {
    _filter=$1; _stdin=$2
    _st=0
    _raw=$(printf '%s' "$_stdin" | "$COMMON/notice-scan.sh") || _st=$?
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

  Describe 'BashOutput events (backgrounded commands)'
    It 'fires the GitHub nudge for a Dependabot URL surfaced via BashOutput'
      When call notice_jq '{event: .hookSpecificOutput.hookEventName, offers_directly: (.hookSpecificOutput.additionalContext | test("resolve-alerts"))}' \
        "https://github.com/brianespinosa/app/security/dependabot/3" "BashOutput"
      The status should be success
      The output should equal '{"event":"PostToolUse","offers_directly":true}'
    End
  End

  Describe 'package manager audit output (text form)'
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

  # JSON-format audit output never matches a prose regex: the same
  # unmatchable-pattern bug class as the shipped v0.1.0 yarn validator
  # (plugins/gh-security/scripts/CLAUDE.md, "The rule that matters most").
  Describe 'package manager audit output (JSON form)'
    # Prose regexes can never match this shape: the same unmatchable-pattern
    # bug class as the shipped v0.1.0 yarn lockfile validator
    # (plugins/gh-security/scripts/CLAUDE.md, "The rule that matters most").
    Describe 'non-zero totals'
      # npm's own fixture is hand-authored (auditReportVersion 2, `.total`
      # present); npm's real shape is not in dispute (issue #32 notes it as
      # already correct). The pnpm and Yarn Berry fixtures below are not
      # hand-authored: they are trimmed straight from real captured
      # `pnpm audit --json` / `yarn npm audit --json` output (issue #32), so
      # an edit that drifts the detection logic back toward an invented
      # shape has real output to fail against, not another invention.
      npm_json='{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":1,"moderate":2,"high":0,"critical":0,"total":3},"dependencies":{"prod":10,"dev":5,"total":15}}}'
      pnpm_json=$(cat "$FIXTURES/notice-scan/pnpm-audit-sample.json")
      yarn_v1_ndjson='{"type":"auditAdvisory","data":{"resolution":{"id":1234,"path":"lodash"},"advisory":{"module_name":"lodash","severity":"high"}}}
{"type":"auditSummary","data":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":1,"critical":0}}}'
      yarn_berry_ndjson=$(cat "$FIXTURES/notice-scan/yarn-berry-audit-sample.ndjson")

      Parameters
        "npm audit --json"                            "$npm_json"
        "pnpm audit --json, real capture, no .total"   "$pnpm_json"
        "yarn classic audit --json NDJSON auditAdvisory" "$yarn_v1_ndjson"
        "yarn Berry audit --json NDJSON children.Severity" "$yarn_berry_ndjson"
      End

      It "nudges toward checking GitHub alerts on $1"
        When call notice_jq '{matched: (.hookSpecificOutput.additionalContext != null)}' "$2"
        The status should be success
        The output should equal '{"matched":true}'
      End
    End

    Describe 'zero-count negatives stay silent for every package manager'
      npm_json_zero='{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}}'
      pnpm_json_zero='{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}'
      yarn_berry_no_advisories='{"type":"info","data":"No named packages were audited"}'

      Parameters
        "npm audit --json with a zero total"                "$npm_json_zero"
        "pnpm audit --json with all-zero severities, no .total" "$pnpm_json_zero"
        "yarn Berry audit --json with no advisory records"  "$yarn_berry_no_advisories"
      End

      It "stays silent on $1"
        When call notice_jq '.' "$2"
        The status should be success
        The output should equal ''
      End
    End

    It 'stays silent on malformed metadata.vulnerabilities instead of crashing the hook'
      malformed='{"metadata":{"vulnerabilities":"not an object"}}'
      When call notice_jq '.' "$malformed"
      The status should be success
      The output should equal ''
    End

    # issue #41: the old detector matched `"children":\{[^}]*"Severity":"` as
    # raw text. Because `[^}]*` excludes `}` by construction, it could never
    # match a record whose text before `Severity` contains a literal brace —
    # the same unmatchable-pattern bug class the file exists to avoid. Fixed
    # by parsing each NDJSON line as its own JSON document instead.
    Describe 'Yarn Berry records containing a literal brace (issue #41)'
      # Real record from the captured sample (issue #41's own repro): the
      # `Issue` text quotes a `{}` group, which sits before `Severity` in the
      # record and defeated the old `[^}]*` regex.
      brace_in_issue='{"value":"brace-expansion","children":{"ID":1123898,"Issue":"brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups","URL":"https://github.com/advisories/GHSA-3jxr-9vmj-r5cp","Severity":"high","Vulnerable Versions":">=3.0.0 <5.0.7","Tree Versions":["5.0.5"],"Dependents":["minimatch@npm:10.2.5"]}}'
      # A brace in URL is not something real GHSA advisory URLs contain, but
      # the old regex was equally blind to one there; hand-authored to prove
      # the fix is not accidentally scoped to the Issue field alone.
      brace_in_url='{"value":"foo","children":{"ID":1,"Issue":"foo has a flaw","URL":"https://example.com/{legacy}/advisory","Severity":"high"}}'

      Parameters
        "a brace in the Issue text" "$brace_in_issue"
        "a brace in the URL"        "$brace_in_url"
      End

      It "now fires on a Yarn Berry record with $1"
        When call notice_jq '{matched: (.hookSpecificOutput.additionalContext != null)}' "$2"
        The status should be success
        The output should equal '{"matched":true}'
      End
    End

    It 'stays silent on a Yarn Berry record whose children is not an object'
      not_an_object='{"value":"foo","children":"not-an-object"}'
      When call notice_jq '.' "$not_an_object"
      The status should be success
      The output should equal ''
    End

    It 'fires on a Yarn Berry capture with a non-JSON line mixed in among valid records'
      mixed="not json at all
{\"value\":\"ajv\",\"children\":{\"ID\":1,\"Issue\":\"x\",\"URL\":\"y\",\"Severity\":\"moderate\"}}"
      When call notice_jq '{matched: (.hookSpecificOutput.additionalContext != null)}' "$mixed"
      The status should be success
      The output should equal '{"matched":true}'
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
      "GitHub zero-count push notice"         "remote: GitHub found 0 vulnerabilities on main's default branch."
      "code-scanning URL, not dependabot"     "remote:      https://github.com/brianespinosa/app/security/code-scanning/3"
    End

    It "emits nothing for $1"
      When call notice_jq '.' "$2"
      The status should be success
      The output should equal ''
    End
  End

  It 'ignores non-Bash, non-BashOutput tool calls even with matching text in the payload'
    When call notice_jq '.' "GitHub found 8 vulnerabilities on main" "Read"
    The status should be success
    The output should equal ''
  End

  # A GitHub notice and PM audit text can both appear in the same output
  # (e.g. `npm install` followed by a `git push` in one command string). The
  # GitHub branch wins: it is grounds enough to offer the skill directly
  # regardless of what else is present.
  It 'prefers the GitHub branch when both signal classes are present'
    combined="remote: GitHub found 8 vulnerabilities on main's default branch.
2 vulnerabilities (1 moderate, 1 high)
  run \`npm audit fix\` to fix them"
    When call notice_jq '{offers_directly: (.hookSpecificOutput.additionalContext | test("Offer to run"))}' "$combined"
    The status should be success
    The output should equal '{"offers_directly":true}'
  End

  Describe 'tool_response envelope shapes'
    It 'matches when the signal is only in the object-shaped stdout field'
      stdin=$(jq -n '{tool_name: "Bash", tool_response: {stdout: "https://github.com/brianespinosa/app/security/dependabot/3", stderr: ""}}')
      When call notice_jq_raw '{matched: (.hookSpecificOutput.additionalContext != null)}' "$stdin"
      The status should be success
      The output should equal '{"matched":true}'
    End

    It 'matches when the signal is only in the object-shaped stderr field'
      stdin=$(jq -n '{tool_name: "Bash", tool_response: {stdout: "", stderr: "remote: GitHub found 3 vulnerabilities on main'"'"'s default branch."}}')
      When call notice_jq_raw '{matched: (.hookSpecificOutput.additionalContext != null)}' "$stdin"
      The status should be success
      The output should equal '{"matched":true}'
    End

    It 'stays silent when tool_response is absent entirely'
      stdin=$(jq -n '{tool_name: "Bash"}')
      When call notice_jq_raw '.' "$stdin"
      The status should be success
      The output should equal ''
    End
  End

  Describe 'top-level JSON that is not an object'
    Parameters
      "a bare number"  '42'
      "an empty array" '[]'
      "a bare boolean" 'true'
      "a bare string"  '"just a string"'
    End

    It "exits cleanly on $1 instead of crashing on .tool_name indexing"
      When call notice_jq_raw '.' "$2"
      The status should be success
      The output should equal ''
    End
  End

  It 'exits cleanly on truncated JSON instead of erroring the hook'
    When call notice_jq_raw '.' '{"tool_name": "Bash",'
    The status should be success
    The output should equal ''
  End

  It 'exits cleanly on empty stdin instead of erroring the hook'
    When run script "$COMMON/notice-scan.sh"
    The status should be success
    The output should equal ''
  End
End
