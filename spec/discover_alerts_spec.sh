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

  # `sibling_alerts` is what the fix agent hands validate --sibling-alerts:
  # every OTHER line of the same package with its open alerts' unique ranges,
  # so a within-major dedup move can be classed benign only when the moved
  # line provably carries no open alerts (issue #105). Both directions of the
  # two-line package are asserted, and [] is the positive claim a single-group
  # package makes: no other line of it has open alerts.
  Describe 'sibling alerts per group'
    Parameters
      undici-7x '[.actionable[] | select(.package == "undici" and .major_line == "7") | .sibling_alerts]' '[[{"major":6,"vulnerable_ranges":["< 6.24.0","< 6.28.0"]}]]'
      undici-6x '[.actionable[] | select(.package == "undici" and .major_line == "6") | .sibling_alerts]' '[[{"major":7,"vulnerable_ranges":[">= 7.0.0, < 7.29.0"]}]]'
      lodash-4x '[.actionable[] | select(.package == "lodash") | .sibling_alerts]' '[[]]'
    End

    It "names every other line of the package for $1"
      When call discover "$2"
      The status should be success
      The output should equal "$3"
    End
  End

  # A skipped group is still a line of its package: it carries the field too,
  # because a no-fix-available line still holds open alerts that a sibling's
  # dedup classification has to know about.
  It 'gives skipped groups the field as well'
    When call discover '[.skipped[] | select(.package == "left-pad") | .sibling_alerts]'
    The status should be success
    The output should equal '[[]]'
  End

  # The routing-independence half of the rule: a package with a fixable line
  # AND a no-fix line. The skipped "none" group still surfaces in the fixable
  # line's siblings, as major: null with its range intact, because pnpm dedups
  # a line whether or not a fix for it exists.
  It 'includes a no-fix sibling line as major null'
    jq -n '[[
      {number: 1,
       dependency: {package: {ecosystem: "npm", name: "undici"},
                    manifest_path: "package.json", relationship: "transitive"},
       security_advisory: {ghsa_id: "GHSA-undici-a", cve_id: "CVE-2000-0001",
                           severity: "high", summary: "s",
                           epss: {percentile: 0.1}},
       security_vulnerability: {vulnerable_version_range: "< 7.29.0",
                                first_patched_version: {identifier: "7.29.0"}}},
      {number: 2,
       dependency: {package: {ecosystem: "npm", name: "undici"},
                    manifest_path: "package.json", relationship: "transitive"},
       security_advisory: {ghsa_id: "GHSA-undici-b", cve_id: "CVE-2000-0002",
                           severity: "low", summary: "s",
                           epss: {percentile: 0.1}},
       security_vulnerability: {vulnerable_version_range: "<= 5.28.0",
                                first_patched_version: null}}
    ]]' > "$MOCK_DIR/alerts.json"
    When call discover '{a: [.actionable[].sibling_alerts], s: [.skipped[].sibling_alerts]}'
    The status should be success
    The output should equal '{"a":[[{"major":null,"vulnerable_ranges":["<= 5.28.0"]}]],"s":[[{"major":7,"vulnerable_ranges":["< 7.29.0"]}]]}'
  End

  # Every group now carries its own `repo`, the field cross-repo scopes key on
  # (issue #6). Repo scope pins it to the target passed on the command line.
  It 'tags every group with the repo scope target'
    When call discover '[(.actionable[], .skipped[]) | .repo] | unique'
    The status should be success
    The output should equal '["octo/app"]'
  End

  It 'suffixes the line even when a package has only one'
    When call discover '[.actionable[] | select(.package == "lodash") | .branch_name]'
    The status should be success
    The output should equal '["fix/dependabot-lodash-4x"]'
  End

  # Issue #123: git refs are a filesystem namespace, so a remote branch
  # literally named `fix` (`refs/heads/fix`) rejects every `fix/*` push —
  # the field specimen is `! [remote rejected] fix/dependabot-postcss-8x ->
  # fix/dependabot-postcss-8x (directory file conflict)`, hit only after each
  # agent had finished its whole fix. The orchestrator probes the remote
  # (`git ls-remote --heads origin fix`, resolve-alerts SKILL.md phase 1) and
  # passes --branch-style flat when the namespace is blocked; these examples
  # pin the mechanical half of that flip, and pin that the ordinary run's
  # names stay byte-identical to today's.
  Describe 'the flat fallback branch scheme (issue #123)'
    discover_flat() { common_jq discover-alerts.sh "$1" --branch-style flat "$REPO"; }

    It 'emits flat names for every group when flat is selected'
      When call discover_flat '[.actionable[].branch_name]'
      The status should be success
      The output should equal '["fix-dependabot-undici-7x","fix-dependabot-undici-6x","fix-dependabot-lodash-4x"]'
    End

    It 'flattens the unfixed variant too'
      When call discover_flat '[.skipped[] | select(.package == "left-pad") | .branch_name]'
      The status should be success
      The output should equal '["fix-dependabot-left-pad-unfixed"]'
    End

    # The regression pin: nothing about adding the fallback may move the
    # default. A renamed default would strand every open slash-named PR and
    # every stale-branch check keyed on the recorded names.
    It 'keeps the slash scheme exactly as-is by default'
      When call discover '[(.actionable[], .skipped[]) | .branch_name]'
      The status should be success
      The output should equal '["fix/dependabot-undici-7x","fix/dependabot-undici-6x","fix/dependabot-lodash-4x","fix/dependabot-left-pad-unfixed"]'
    End

    It 'rejects an unknown branch style'
      When run script "$COMMON/discover-alerts.sh" --branch-style diagonal "$REPO"
      The status should be failure
      The stderr should include 'Unknown branch style'
    End
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

    # A repo that once carried a branch named `fix` had its PRs opened under
    # the flat scheme (issue #123); deleting that branch later flips discovery
    # back to the slash default while such a PR can still be open. Missing it
    # would open a duplicate PR for the same line — the verdict asserted is
    # the skip, not just the candidate list.
    It 'recognizes a PR opened under the flat scheme after the style flips back'
      stub_open_pr 'fix-dependabot-undici-6x' 'https://github.com/octo/app/pull/9'
      When call discover '{actionable: [.actionable[].branch_name], skipped: [.skipped[] | select(.open_pr_url) | {major_line, reason, open_pr_url}]}'
      The status should be success
      The output should equal '{"actionable":["fix/dependabot-undici-7x","fix/dependabot-lodash-4x"],"skipped":[{"major_line":"6","reason":"open PR exists (flat-scheme branch fix-dependabot-undici-6x)","open_pr_url":"https://github.com/octo/app/pull/9"}]}'
    End

    It 'skips a line whose flat-named PR is open when running flat'
      stub_open_pr 'fix-dependabot-undici-6x' 'https://github.com/octo/app/pull/9'
      When call common_jq discover-alerts.sh '{actionable: [.actionable[].branch_name], skipped: [.skipped[] | select(.open_pr_url) | {reason, open_pr_url}]}' --branch-style flat "$REPO"
      The status should be success
      The output should equal '{"actionable":["fix-dependabot-undici-7x","fix-dependabot-lodash-4x"],"skipped":[{"reason":"open PR exists","open_pr_url":"https://github.com/octo/app/pull/9"}]}'
    End

    # While `refs/heads/fix` exists — the flat style's precondition — the
    # remote cannot also hold any `fix/*` ref, so under flat the slash
    # candidate is never queried at all.
    flat_slash_queries() {
      common_jq discover-alerts.sh '.' --branch-style flat "$REPO" >/dev/null || return 1
      grep -c 'pr-list fix/' "$MOCK_DIR/log" || true
    }

    It 'queries no slash-named candidate under the flat style'
      When call flat_slash_queries
      The status should be success
      The output should equal '0'
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

  # `highest_fixed_version` is picked by asking the ecosystem adapter, and the
  # call used to sit inside `if [ "$(...)" = "1" ]`: a non-zero adapter exit was
  # invisible to `set -e`, and an `{"error":...}` reply reduced through
  # `.result` to `null`, read as "not higher". Either way discovery came back
  # exit 0 with a silently wrong version (issue #39).
  #
  # The shipped node.sh has no input that makes compare_versions fail, so the
  # two scripts are copied beside a stub adapter and the copy is run; discovery
  # resolves the adapter relative to its own directory.
  Describe 'adapter version comparison failures'
    stub_adapter() {
      mkdir -p "$MOCK_DIR/scripts/common" "$MOCK_DIR/scripts/ecosystems"
      cp "$COMMON/discover-alerts.sh" "$COMMON/select-adapter.sh" "$MOCK_DIR/scripts/common/"
      printf '#!/usr/bin/env sh\n%s\n' "$1" > "$MOCK_DIR/scripts/ecosystems/node.sh"
      chmod +x "$MOCK_DIR/scripts/ecosystems/node.sh"
    }

    It 'fails when the adapter exits non-zero on a comparison'
      stub_adapter 'printf "{\"error\":\"adapter exploded\"}\n" >&2; exit 1'
      When run script "$MOCK_DIR/scripts/common/discover-alerts.sh" "$REPO"
      The status should not equal 0
      The stderr should include 'compare_versions failed'
    End

    It 'fails when the adapter answers 0 with an error object instead of a result'
      stub_adapter 'printf "{\"error\":\"adapter refused\"}\n"; exit 0'
      When run script "$MOCK_DIR/scripts/common/discover-alerts.sh" "$REPO"
      The status should not equal 0
      The stderr should include 'no usable result'
    End

    It 'fails when the adapter answers 0 with empty stdout'
      stub_adapter 'exit 0'
      When run script "$MOCK_DIR/scripts/common/discover-alerts.sh" "$REPO"
      The status should not equal 0
      The stderr should include 'no usable result'
    End
  End

  It 'fails loudly when the API response is not an array'
    printf '{"message":"Not Found"}' > "$MOCK_DIR/alerts.json"
    When run script "$COMMON/discover-alerts.sh" "$REPO"
    The status should not equal 0
    The stderr should include 'Not Found'
  End

  # The two shapes are typed and validated independently — discovery's
  # `sibling_alerts` field and the adapter's `--sibling-alerts` parse — and a
  # comment asserting they match is not a mechanism. This pins them together:
  # discovery's actual output for the field-case dedup fixture (issue #105),
  # taken verbatim, is accepted by validate and classifies the same move
  # `node_validate_spec.sh` classifies benign_dedup by hand.
  Describe 'sibling_alerts producer/consumer contract (issue #105)'
    After 'cleanup_fixture'

    It 'accepts discover-alerts.sh sibling_alerts verbatim and classifies the dedup as benign'
      jq -n '[[
        {number: 1,
         dependency: {package: {ecosystem: "npm", name: "picomatch"},
                      manifest_path: "package.json", relationship: "direct"},
         security_advisory: {ghsa_id: "GHSA-picomatch-4", cve_id: "CVE-2000-0020",
                             severity: "medium", summary: "s",
                             epss: {percentile: 0.2}},
         security_vulnerability: {vulnerable_version_range: "< 4.0.3",
                                  first_patched_version: {identifier: "4.0.3"}}}
      ]]' > "$MOCK_DIR/alerts.json"
      siblings=$(discover '.actionable[] | select(.package == "picomatch") | .sibling_alerts')

      DEDUP_BASELINE='{"pm":"pnpm","package":"picomatch","present":true,"count":3,"versions":[{"version":"2.3.1","path":"picomatch@2.3.1"},{"version":"2.3.2","path":"picomatch@2.3.2"},{"version":"4.0.1","path":"picomatch@4.0.1"}],"lockfile_entries":5}'
      use_fixture pnpm-benign-dedup
      When call adapter_jq '{ok, other_line_moves}' \
        validate --line 4 --vulnerable '< 4.0.3' --baseline "$DEDUP_BASELINE" \
        --sibling-alerts "$siblings" picomatch '>=4.0.3 <5'
      The status should be success
      The output should equal '{"ok":true,"other_line_moves":[{"major":2,"before":["2.3.1","2.3.2"],"after":["2.3.2"],"status":"moved","class":"benign_dedup"}]}'
    End
  End

  # Branch naming does not sanitize the package name: a scoped package's `/`
  # rides straight through into the ref. Pin what the code actually emits
  # rather than assume a sanitizer exists. A residual `/` inside a flat-style
  # name (`fix-dependabot-@babel/traverse-7x`) does not recreate the issue
  # #123 collision, since that requires a pre-existing sibling ref at the
  # exact `fix-dependabot-...` prefix, and the plugin only ever creates one
  # such ref per package/line.
  Describe 'a scoped package name (issue #123 follow-up)'
    setup_scoped_mock() {
      cp "$FIXTURES/alerts/scoped-package.json" "$MOCK_DIR/alerts.json"
    }
    Before 'setup_scoped_mock'

    It 'emits the unsanitized scoped name under the slash default'
      When call discover '[.actionable[].branch_name]'
      The status should be success
      The output should equal '["fix/dependabot-@babel/traverse-7x"]'
    End

    It 'emits the unsanitized scoped name under the flat fallback'
      When call common_jq discover-alerts.sh '[.actionable[].branch_name]' --branch-style flat "$REPO"
      The status should be success
      The output should equal '["fix-dependabot-@babel/traverse-7x"]'
    End
  End
End
