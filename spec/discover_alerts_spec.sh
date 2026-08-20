#!/bin/sh
# shellcheck shell=sh
# scripts/common/discover-alerts.sh: grouping, branch naming, and skip reasons.
#
# The regression that motivated this suite: grouping by package name alone
# collapsed every patched version into one highest_fixed_version, so a package
# resolved at several majors at once got a fix for the newest line only and the
# rest stayed vulnerable under a group reported as fixed (issue #19).
#
# The fixture mirrors that report: undici with alerts patched in both the 6.x
# and 7.x lines, one package with a single line, and one with no patched
# version at all. Every gh call is mocked; nothing here touches the network.

Describe 'discover-alerts.sh'
  REPO='octo/app'

  setup_mock() {
    MOCK_DIR="$SHELLSPEC_WORKDIR/discover-mock"
    rm -rf "$MOCK_DIR"
    mkdir -p "$MOCK_DIR"
    : > "$MOCK_DIR/log"
    cp "$FIXTURES/alerts/multi-major.json" "$MOCK_DIR/alerts.json"
    export MOCK_DIR
  }

  Before 'setup_mock'

  # `gh pr list` replies are scripted per branch: a file named after the branch
  # (slashes flattened) holds the URL to report, its absence means no open PR.
  Mock gh
    case "$1" in
      api)
        printf 'api\n' >> "$MOCK_DIR/log"
        cat "$MOCK_DIR/alerts.json"
        ;;
      pr)
        br=''
        for arg in "$@"; do
          case "$arg" in head:*) br="${arg#head:}" ;; esac
        done
        printf 'pr-list %s\n' "$br" >> "$MOCK_DIR/log"
        if [ -f "$MOCK_DIR/pr-fail" ]; then
          printf 'gh: could not resolve to a Repository\n' >&2
          exit 1
        fi
        key=$(printf '%s' "$br" | tr / _)
        if [ -f "$MOCK_DIR/pr-$key" ]; then
          cat "$MOCK_DIR/pr-$key"
        fi
        ;;
      *) exit 1 ;;
    esac
  End

  stub_open_pr() {
    printf '%s\n' "$2" > "$MOCK_DIR/pr-$(printf '%s' "$1" | tr / _)"
  }

  discover() { common_jq discover-alerts.sh "$1" "$REPO"; }

  # The leading label is not decoration: a Parameters row whose first field
  # starts with `[` reads as a command name ending in `]` (SC2288).
  Describe 'one group per package major line'
    Parameters
      lines  '[.actionable[] | .package + "@" + .major_line]' '["undici@7","undici@6","lodash@4"]'
      7x     '[.actionable[] | select(.major_line == "7") | .alert_count]' '[2]'
      6x     '[.actionable[] | select(.major_line == "6") | .alert_count]' '[3]'
      fixes  '[.actionable[] | select(.package == "undici") | .highest_fixed_version]' '["7.29.0","6.28.0"]'
      branch '[.actionable[] | select(.package == "undici") | .branch_name]' '["fix/dependabot-undici-7x","fix/dependabot-undici-6x"]'
    End

    It "splits $1"
      When call discover "$2"
      The status should be success
      The output should equal "$3"
    End
  End

  # The whole point of the split: the 6.x line keeps its own patched version
  # instead of being described by the 7.x one, and its alerts are exactly the
  # ones whose fix lands in 6.x.
  It 'keeps each line alert numbers separate'
    When call discover '[.actionable[] | select(.major_line == "6") | .alerts[].number] | sort'
    The status should be success
    The output should equal '[93,148,151]'
  End

  It 'carries every alert into exactly one group'
    When call discover '[(.actionable[], .skipped[]) | .alerts[].number] | sort'
    The status should be success
    The output should equal '[41,60,93,145,148,151,152]'
  End

  It 'suffixes the line even when a package has only one'
    When call discover '[.actionable[] | select(.package == "lodash") | .branch_name]'
    The status should be success
    The output should equal '["fix/dependabot-lodash-4x"]'
  End

  It 'ranks by severity then EPSS, with package and line breaking ties'
    When call discover '[.actionable[] | {s: .max_severity, e: .max_epss_percentile}]'
    The status should be success
    The output should equal '[{"s":"high","e":0.9},{"s":"high","e":0.5},{"s":"medium","e":0.3}]'
  End

  Describe 'alerts with no patched version'
    It 'skips the line as unfixable rather than dropping it'
      When call discover '[.skipped[] | {package, major_line, reason, branch_name}]'
      The status should be success
      The output should equal '[{"package":"left-pad","major_line":"none","reason":"no fix available","branch_name":"fix/dependabot-left-pad-unfixed"}]'
    End
  End

  Describe 'open PR detection'
    It 'skips only the line whose branch already has a PR'
      stub_open_pr 'fix/dependabot-undici-6x' 'https://github.com/octo/app/pull/7'
      When call discover '{actionable: [.actionable[].branch_name], skipped: [.skipped[] | select(.reason == "open PR exists") | .open_pr_url]}'
      The status should be success
      The output should equal '{"actionable":["fix/dependabot-undici-7x","fix/dependabot-lodash-4x"],"skipped":["https://github.com/octo/app/pull/7"]}'
    End

    # An upgrade must not open a second PR next to one the previous naming
    # already produced.
    It 'recognizes a PR opened under the pre-per-line branch name'
      stub_open_pr 'fix/dependabot-lodash' 'https://github.com/octo/app/pull/3'
      When call discover '[.skipped[] | select(.open_pr_url) | {package, reason, open_pr_url}]'
      The status should be success
      The output should equal '[{"package":"lodash","reason":"open PR exists (legacy branch fix/dependabot-lodash)","open_pr_url":"https://github.com/octo/app/pull/3"}]'
    End

    # A legacy PR was produced by the grouping that described a package by one
    # highest_fixed_version, so it fixed the newest line only. Matching it
    # against every line would re-suppress the older vulnerable ones, which is
    # the bug this whole branch exists to fix.
    It 'applies a legacy PR to the newest line only'
      stub_open_pr 'fix/dependabot-undici' 'https://github.com/octo/app/pull/5'
      When call discover '{actionable: [.actionable[].branch_name], skipped: [.skipped[] | select(.open_pr_url) | {major_line, reason}]}'
      The status should be success
      The output should equal '{"actionable":["fix/dependabot-undici-6x","fix/dependabot-lodash-4x"],"skipped":[{"major_line":"7","reason":"open PR exists (legacy branch fix/dependabot-undici)"}]}'
    End

    It 'reports a failed PR lookup as a skip reason, not a crash'
      : > "$MOCK_DIR/pr-fail"
      When call discover '{actionable: (.actionable | length), reasons: ([.skipped[].reason] | unique)}'
      The status should be success
      The output should equal '{"actionable":0,"reasons":["PR check failed","no fix available"]}'
    End
  End

  # `first_patched_version.identifier` is advisory-supplied text, not a
  # validated version. Anything without a plain integer leading component would
  # otherwise reach a group key, a branch name, and a `gh pr list --search`
  # whose embedded space returns no results, leaving a malformed group
  # actionable.
  Describe 'patched version identifiers'
    stub_single_alert() {
      jq -n --arg id "$1" '[[{
        number: 1,
        dependency: {
          package: {ecosystem: "npm", name: "undici"},
          manifest_path: "package.json",
          relationship: "transitive"
        },
        security_advisory: {
          ghsa_id: "GHSA-undici-x", cve_id: "CVE-2000-0009",
          severity: "high", summary: "s", epss: {percentile: 0.1}
        },
        security_vulnerability: {
          vulnerable_version_range: "< 7.29.0",
          first_patched_version: {identifier: $id}
        }
      }]]' > "$MOCK_DIR/alerts.json"
    }

    Parameters
      v-prefixed 'v7.29.0'             '{"a":[{"major_line":"7","branch_name":"fix/dependabot-undici-7x"}],"s":[]}'
      whitespace '  7.29.0 '           '{"a":[{"major_line":"7","branch_name":"fix/dependabot-undici-7x"}],"s":[]}'
      prose      'See vendor advisory' '{"a":[],"s":[{"major_line":"none","reason":"no fix available"}]}'
      empty      ''                    '{"a":[],"s":[{"major_line":"none","reason":"no fix available"}]}'
    End

    It "reads the line from a $1 identifier"
      stub_single_alert "$2"
      When call discover '{a: [.actionable[] | {major_line, branch_name}], s: [.skipped[] | {major_line, reason}]}'
      The status should be success
      The output should equal "$3"
    End
  End

  It 'emits empty arrays when there are no alerts'
    printf '[]' > "$MOCK_DIR/alerts.json"
    When call discover '{a: (.actionable | length), s: (.skipped | length)}'
    The status should be success
    The output should equal '{"a":0,"s":0}'
  End

  It 'fails loudly when the API response is not an array'
    printf '{"message":"Not Found"}' > "$MOCK_DIR/alerts.json"
    When run script "$COMMON/discover-alerts.sh" "$REPO"
    The status should not equal 0
    The stderr should include 'Not Found'
  End
End
