#!/bin/sh
# shellcheck shell=sh
# scripts/common/check-advisories.sh: the union of every published advisory
# range for a package, and the verdict for one candidate version.
#
# The behavior under test is why the script exists at all: a pin suppresses the
# alerts that would have been raised for advisories published after it, so
# removability has to be judged against the whole advisory database. Every gh
# call is mocked; nothing here touches the network.

Describe 'check-advisories.sh'
  setup_mock() {
    MOCK_DIR="$SHELLSPEC_WORKDIR/advisories-mock"
    rm -rf "$MOCK_DIR"
    mkdir -p "$MOCK_DIR"
    : > "$MOCK_DIR/log"
    # Three advisories for lodash, spanning two different vulnerable ranges,
    # plus one withdrawn and one that reaches the query only because it also
    # affects a different package.
    cat > "$MOCK_DIR/advisories.json" <<'JSON'
[[
  {
    "ghsa_id": "GHSA-aaaa-1111-bbbb", "cve_id": "CVE-2019-10744",
    "severity": "critical", "type": "reviewed", "withdrawn_at": null,
    "published_at": "2019-07-09T00:00:00Z", "summary": "Prototype pollution",
    "html_url": "https://github.com/advisories/GHSA-aaaa-1111-bbbb",
    "vulnerabilities": [
      {"package": {"ecosystem": "npm", "name": "lodash"},
       "vulnerable_version_range": "< 4.17.12",
       "first_patched_version": "4.17.12"}
    ]
  },
  {
    "ghsa_id": "GHSA-cccc-2222-dddd", "cve_id": "CVE-2021-23337",
    "severity": "high", "type": "reviewed", "withdrawn_at": null,
    "published_at": "2021-02-15T00:00:00Z", "summary": "Command injection",
    "html_url": "https://github.com/advisories/GHSA-cccc-2222-dddd",
    "vulnerabilities": [
      {"package": {"ecosystem": "npm", "name": "lodash"},
       "vulnerable_version_range": "< 4.17.21",
       "first_patched_version": "4.17.21"},
      {"package": {"ecosystem": "npm", "name": "lodash-es"},
       "vulnerable_version_range": "< 4.17.21",
       "first_patched_version": "4.17.21"}
    ]
  },
  {
    "ghsa_id": "GHSA-eeee-3333-ffff", "cve_id": null,
    "severity": "moderate", "type": "reviewed", "withdrawn_at": null,
    "published_at": "2020-05-01T00:00:00Z", "summary": "ReDoS",
    "html_url": "https://github.com/advisories/GHSA-eeee-3333-ffff",
    "vulnerabilities": [
      {"package": {"ecosystem": "npm", "name": "lodash"},
       "vulnerable_version_range": ">= 3.0.0, < 4.17.19",
       "first_patched_version": "4.17.19"}
    ]
  },
  {
    "ghsa_id": "GHSA-gggg-4444-hhhh", "cve_id": null,
    "severity": "low", "type": "reviewed",
    "withdrawn_at": "2022-01-01T00:00:00Z",
    "published_at": "2021-12-01T00:00:00Z", "summary": "Retracted report",
    "html_url": "https://github.com/advisories/GHSA-gggg-4444-hhhh",
    "vulnerabilities": [
      {"package": {"ecosystem": "npm", "name": "lodash"},
       "vulnerable_version_range": "< 99.0.0",
       "first_patched_version": null}
    ]
  }
]]
JSON
    export MOCK_DIR
  }

  Before 'setup_mock'

  Mock gh
    printf '%s\n' "$*" >> "$MOCK_DIR/log"
    case "$1" in
      api)
        if [ -f "$MOCK_DIR/api-fail" ]; then
          printf 'gh: HTTP 503\n' >&2
          exit 1
        fi
        cat "$MOCK_DIR/advisories.json"
        ;;
      *) exit 1 ;;
    esac
  End

  advisories() {
    _filter=$1
    shift
    common_jq check-advisories.sh "$_filter" "$@"
  }

  It 'unions the ranges of every published advisory, not just one'
    When call advisories '.vulnerable_ranges' lodash
    The status should be success
    The output should equal '["< 4.17.12","< 4.17.21",">= 3.0.0, < 4.17.19"]'
  End

  It 'drops withdrawn advisories and says how many'
    When call advisories '{n: .advisory_count, withdrawn: .withdrawn_excluded, ghsa: [.advisories[].ghsa_id] | sort}' lodash
    The status should be success
    The output should equal '{"n":3,"withdrawn":1,"ghsa":["GHSA-aaaa-1111-bbbb","GHSA-cccc-2222-dddd","GHSA-eeee-3333-ffff"]}'
  End

  # `affects` filters advisories, not vulnerability entries, so an advisory
  # covering two packages arrives with both. Keeping the sibling entry would
  # union a range that says nothing about this package.
  It 'keeps only the vulnerability entries for the package asked about'
    When call advisories '[.advisories[] | select(.ghsa_id == "GHSA-cccc-2222-dddd")] | length' lodash
    The status should be success
    The output should equal '1'
  End

  It 'scopes the query to the requested ecosystem'
    When call advisories '.ecosystem' --ecosystem pip lodash
    The status should be success
    The output should equal '"pip"'
    The contents of file "$MOCK_DIR/log" should include 'ecosystem=pip'
  End

  Describe 'verdict for a candidate version'
    # Range semantics come from the adapter (ADR 001), so the real node adapter
    # evaluates these; nothing about them is reimplemented here.
    Parameters
      #  version    verdict        matched ranges
      4.17.21   safe          '[]'
      4.17.20   vulnerable    '["< 4.17.21"]'
      4.17.11   vulnerable    '["< 4.17.12","< 4.17.21",">= 3.0.0, < 4.17.19"]'
      2.4.2     vulnerable    '["< 4.17.12","< 4.17.21"]'
    End

    It "rates $1 as $2"
      When call advisories "{verdict, matched_ranges}" --adapter "$ADAPTER" --version "$1" lodash
      The status should be success
      The output should equal "{\"verdict\":\"$2\",\"matched_ranges\":$3}"
    End
  End

  # A range nobody could read is the one place an unnoticed match would hide,
  # so it is never folded into "safe".
  Describe 'ranges the adapter cannot evaluate'
    unreadable_range() {
      jq '[[.[0][0] | .vulnerabilities[0].vulnerable_version_range = "see vendor advisory"]]' \
        "$MOCK_DIR/advisories.json" > "$MOCK_DIR/tmp.json"
      mv "$MOCK_DIR/tmp.json" "$MOCK_DIR/advisories.json"
    }

    It 'reports unknown rather than safe'
      unreadable_range
      When call advisories '{verdict, unevaluated_ranges, matched_ranges}' --adapter "$ADAPTER" --version 4.17.21 lodash
      The status should be success
      The output should equal '{"verdict":"unknown","unevaluated_ranges":["see vendor advisory"],"matched_ranges":[]}'
    End
  End

  # A systemically broken adapter — a missing dependency, a bad path, the wrong
  # ecosystem's script — degrades every range to unevaluated. Swallowing its
  # stderr made that an audit where every pin came back inconclusive with
  # nothing pointing at the cause.
  Describe 'an adapter that fails'
    broken_adapter() {
      BROKEN="$SHELLSPEC_WORKDIR/broken-adapter.sh"
      printf '#!/bin/sh\nprintf "jq: command not found\\n" >&2\nexit 127\n' > "$BROKEN"
      chmod +x "$BROKEN"
    }

    It 'surfaces the adapter error text instead of only an inconclusive verdict'
      broken_adapter
      When call advisories '{verdict, adapter_errors: [.adapter_errors[] | {status, error}] | unique}' --adapter "$BROKEN" --version 4.17.21 lodash
      The status should be success
      The output should equal '{"verdict":"unknown","adapter_errors":[{"status":127,"error":"jq: command not found"}]}'
    End

    # The verdict itself must not soften: an unevaluated range is never folded
    # into "safe", however it came to be unevaluated.
    It 'still refuses to call the version safe'
      broken_adapter
      When call advisories '{unevaluated: (.unevaluated_ranges | length), matched: .matched_ranges}' --adapter "$BROKEN" --version 4.17.21 lodash
      The status should be success
      The output should equal '{"unevaluated":3,"matched":[]}'
    End
  End

  It 'carries no adapter errors on a clean run'
    When call advisories '.adapter_errors' --adapter "$ADAPTER" --version 4.17.21 lodash
    The status should be success
    The output should equal '[]'
  End

  # `--paginate --slurp` emits one array per page, so the union has to flatten
  # before it groups. A second page dropped silently would shrink the union and
  # make a pin holding back exactly that advisory look removable.
  It 'unions across pages'
    jq '[[.[0][0]], [.[0][1], .[0][2]]]' "$MOCK_DIR/advisories.json" > "$MOCK_DIR/paged.json"
    mv "$MOCK_DIR/paged.json" "$MOCK_DIR/advisories.json"
    When call advisories '{n: .advisory_count, ranges: .vulnerable_ranges}' lodash
    The status should be success
    The output should equal '{"n":3,"ranges":["< 4.17.12","< 4.17.21",">= 3.0.0, < 4.17.19"]}'
  End

  # An empty result is a real answer here (the API succeeded), but it is not
  # "safe": a pin may exist for a non-security reason, and a misspelled name
  # produces exactly this.
  It 'distinguishes no advisories from safe'
    printf '[[]]' > "$MOCK_DIR/advisories.json"
    When call advisories '{verdict, advisory_count}' --adapter "$ADAPTER" --version 1.0.0 lodash
    The status should be success
    The output should equal '{"verdict":"no-advisories","advisory_count":0}'
  End

  It 'leaves the verdict null when no version was supplied'
    When call advisories '{verdict, version}' lodash
    The status should be success
    The output should equal '{"verdict":null,"version":null}'
  End

  Describe 'usage errors'
    Parameters
      'a version without an adapter' --version 1.0.0     lodash 'requires --adapter'
      'an adapter without a version' --adapter "$ADAPTER" lodash 'requires --version'
    End

    It "refuses $1"
      When run script "$COMMON/check-advisories.sh" "$2" "$3" "$4"
      The status should equal 1
      The stderr should include "$5"
    End
  End

  It 'refuses an adapter path that is not executable'
    When run script "$COMMON/check-advisories.sh" --adapter /nonexistent-adapter.sh --version 1.0.0 lodash
    The status should equal 1
    The stderr should include 'not executable'
  End

  It 'requires a package name'
    When run script "$COMMON/check-advisories.sh"
    The status should equal 1
    The stderr should include 'Usage'
  End

  It 'reports an API failure rather than an empty advisory list'
    : > "$MOCK_DIR/api-fail"
    When run script "$COMMON/check-advisories.sh" lodash
    The status should equal 1
    The stderr should include 'Failed to fetch advisories'
  End

  It 'reports a response that is not an array'
    printf '{"message":"Not Found"}' > "$MOCK_DIR/advisories.json"
    When run script "$COMMON/check-advisories.sh" lodash
    The status should equal 1
    The stderr should include 'Not Found'
  End
End
