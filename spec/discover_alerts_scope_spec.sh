#!/bin/sh
# shellcheck shell=sh
# scripts/common/discover-alerts.sh: --scope repo|org|user (RFC 001 Phase 3,
# issue #6).
#
# Org scope prefers the aggregate `/orgs/{org}/dependabot/alerts` endpoint and
# falls back to per-repo enumeration on a 403 (no org-level security
# visibility). User scope has no aggregate endpoint at all and always fans out
# per repo. *Every* cross-repo path filters on push access — the aggregate one
# included, since org alert visibility and per-repo push access are separate
# grants — and a repo the authenticated user cannot push to is reported by name
# in `skipped_repos` rather than dropped silently.

Describe 'discover-alerts.sh --scope'
  setup_mock() {
    MOCK_DIR="$SHELLSPEC_WORKDIR/discover-scope-mock"
    rm -rf "$MOCK_DIR"
    mkdir -p "$MOCK_DIR"
    : > "$MOCK_DIR/log"
    export MOCK_DIR
    # The aggregate path consults the org repo listing purely to read push
    # permission, so every aggregate example needs one. This default grants
    # push on the two repos `write_org_agg` names; examples that exercise
    # filtering overwrite it.
    write_repo_listing "$MOCK_DIR/org-repos.json" \
      'octo/app:true:false:false' \
      'octo/other:true:false:false'
  }

  Before 'setup_mock'

  # A single alert for one package, wrapped in the page-array shape
  # `--paginate --slurp` leaves alert-listing responses in.
  write_repo_alerts() {
    key=$(printf '%s' "$1" | tr / _)
    jq -n --arg pkg "$2" --arg rel "$3" --arg sev "$4" --arg fixed "$5" \
      '[[{
        number: 1,
        dependency: {
          package: {ecosystem: "npm", name: $pkg},
          manifest_path: "package.json",
          relationship: $rel
        },
        security_advisory: {
          ghsa_id: ("GHSA-" + $pkg), cve_id: "CVE-2000-0001",
          severity: $sev, summary: "s", epss: {percentile: 0.5}
        },
        security_vulnerability: {
          vulnerable_version_range: ("< " + $fixed),
          first_patched_version: {identifier: $fixed}
        }
      }]]' > "$MOCK_DIR/repo-$key.json"
  }

  # `gh api orgs/<org>/dependabot/alerts` items carry `.repository.full_name`;
  # per-repo endpoints do not, since the repo is implied by the URL.
  write_org_agg() {
    jq -n '[[
      {
        number: 10,
        repository: {full_name: "octo/app"},
        dependency: {package: {ecosystem: "npm", name: "lodash"}, manifest_path: "package.json", relationship: "direct"},
        security_advisory: {ghsa_id: "GHSA-lodash-1", cve_id: "CVE-2000-0002", severity: "medium", summary: "Prototype pollution", epss: {percentile: 0.3}},
        security_vulnerability: {vulnerable_version_range: "< 4.17.21", first_patched_version: {identifier: "4.17.21"}}
      },
      {
        number: 20,
        repository: {full_name: "octo/other"},
        dependency: {package: {ecosystem: "npm", name: "undici"}, manifest_path: "package.json", relationship: "transitive"},
        security_advisory: {ghsa_id: "GHSA-undici-1", cve_id: "CVE-2000-0009", severity: "high", summary: "Request smuggling", epss: {percentile: 0.8}},
        security_vulnerability: {vulnerable_version_range: "< 7.29.0", first_patched_version: {identifier: "7.29.0"}}
      }
    ]]' > "$MOCK_DIR/org-alerts.json"
  }

  # One aggregate alert per named repo, all for the same package, so a single
  # example can span several repos with different push permissions.
  write_org_agg_repos() {
    items="[]"
    for r in "$@"; do
      item=$(jq -n --arg r "$r" '{
        number: 1, repository: {full_name: $r},
        dependency: {package: {ecosystem: "npm", name: "lodash"}, manifest_path: "package.json", relationship: "direct"},
        security_advisory: {ghsa_id: "GHSA-lodash-1", cve_id: "CVE-2000-0002", severity: "medium", summary: "s", epss: {percentile: 0.3}},
        security_vulnerability: {vulnerable_version_range: "< 4.17.21", first_patched_version: {identifier: "4.17.21"}}
      }')
      items=$(printf '%s' "$items" | jq --argjson i "$item" '. + [$i]')
    done
    printf '[%s]' "$items" | jq -c '.' > "$MOCK_DIR/org-alerts.json"
  }

  # Two repos, one alert each, neither with a patched version — so every group
  # lands in `skipped` rather than `actionable`.
  write_org_agg_no_fix() {
    jq -n '[[
      {
        number: 1, repository: {full_name: "octo/app"},
        dependency: {package: {ecosystem: "npm", name: "left-pad"}, manifest_path: "package.json", relationship: "direct"},
        security_advisory: {ghsa_id: "GHSA-left-pad-1", cve_id: "CVE-2000-0003", severity: "low", summary: "s", epss: {percentile: 0.1}},
        security_vulnerability: {vulnerable_version_range: "< 2.0.0", first_patched_version: null}
      },
      {
        number: 2, repository: {full_name: "octo/other"},
        dependency: {package: {ecosystem: "npm", name: "request"}, manifest_path: "package.json", relationship: "transitive"},
        security_advisory: {ghsa_id: "GHSA-request-1", cve_id: "CVE-2000-0004", severity: "high", summary: "s", epss: {percentile: 0.4}},
        security_vulnerability: {vulnerable_version_range: "< 3.0.0", first_patched_version: null}
      }
    ]]' > "$MOCK_DIR/org-alerts.json"
  }

  # Repo listing response for an org- or user-repos call, in the same
  # page-array shape. Each remaining argument is "<full_name>:<push>:<fork>:<archived>".
  write_repo_listing() {
    out="$1"
    shift
    items="[]"
    for row in "$@"; do
      fn=$(printf '%s' "$row" | cut -d: -f1)
      push=$(printf '%s' "$row" | cut -d: -f2)
      fork=$(printf '%s' "$row" | cut -d: -f3)
      archived=$(printf '%s' "$row" | cut -d: -f4)
      item=$(jq -n --arg fn "$fn" --argjson push "$push" --argjson fork "$fork" --argjson archived "$archived" \
        '{full_name: $fn, permissions: {push: $push}, fork: $fork, archived: $archived}')
      items=$(printf '%s' "$items" | jq --argjson i "$item" '. + [$i]')
    done
    printf '[%s]' "$items" | jq -c '.' > "$out"
  }

  # Same shape, but for a row that carries no `permissions` object at all —
  # distinct from a row that explicitly says push:false.
  write_repo_listing_missing_permissions() {
    out="$1"
    full_name="$2"
    jq -n --arg fn "$full_name" '[[{full_name: $fn, fork: false, archived: false}]]' > "$out"
  }

  # Same again, but with an explicit `"push": null`. Distinct from both a
  # boolean answer and an absent `permissions` object: the key is present, so a
  # `has("push")` test reads it as a definite denial when it is missing data.
  write_repo_listing_null_push() {
    out="$1"
    full_name="$2"
    jq -n --arg fn "$full_name" \
      '[[{full_name: $fn, permissions: {push: null}, fork: false, archived: false}]]' > "$out"
  }

  # A genuine two-page `--paginate --slurp` shape: the outer array holds one
  # array per page, unlike every other fixture here which uses a single page.
  # Proves `flatten` in the fan-out's repo-listing pipeline actually combines
  # pages instead of assuming there is only ever one.
  write_repo_listing_multipage() {
    out="$1"
    row1="$2"
    row2="$3"
    page_of() {
      fn=$(printf '%s' "$1" | cut -d: -f1)
      push=$(printf '%s' "$1" | cut -d: -f2)
      fork=$(printf '%s' "$1" | cut -d: -f3)
      archived=$(printf '%s' "$1" | cut -d: -f4)
      jq -n --arg fn "$fn" --argjson push "$push" --argjson fork "$fork" --argjson archived "$archived" \
        '[{full_name: $fn, permissions: {push: $push}, fork: $fork, archived: $archived}]'
    }
    jq -n --argjson p1 "$(page_of "$row1")" --argjson p2 "$(page_of "$row2")" '[$p1, $p2]' > "$out"
  }

  # A repo whose alert endpoint answers 200 with a JSON object rather than an
  # array: an *unexpected shape*, not an observed GitHub response.
  #
  # A live user-scope run over 28 repos hit seven repos with Dependabot
  # disabled and every one answered HTTP 403 with a non-zero `gh` exit, which
  # is the `alert fetch failed` path covered separately below. Nothing returned
  # 200-with-object. So this fixture exercises `classify_alerts_json`'s
  # defensive status-3 branch — a 200 body that is valid JSON but not an array
  # must be reported, never counted as zero alerts — and deliberately claims
  # nothing about what a Dependabot-disabled repo really returns (issue #40).
  write_repo_unexpected_body() {
    key=$(printf '%s' "$1" | tr / _)
    jq -n --arg msg "$2" '{message: $msg}' > "$MOCK_DIR/repo-unexpected-$key"
  }

  Mock gh
    case "$1" in
      api)
        case "$2" in
          user)
            if [ -f "$MOCK_DIR/user-lookup-fail" ]; then
              printf 'gh: Bad credentials (HTTP 401)\n' >&2
              exit 1
            fi
            printf 'octocat\n'
            ;;
          orgs/*/dependabot/alerts*)
            printf 'org-agg\n' >> "$MOCK_DIR/log"
            if [ -f "$MOCK_DIR/org-agg-error" ]; then
              cat "$MOCK_DIR/org-agg-error" >&2
              exit 1
            fi
            if [ -f "$MOCK_DIR/org-403" ]; then
              printf 'gh: Resource not accessible by integration (HTTP 403)\n' >&2
              exit 1
            fi
            cat "$MOCK_DIR/org-alerts.json"
            ;;
          orgs/*/repos*)
            cat "$MOCK_DIR/org-repos.json"
            ;;
          user/repos*)
            cat "$MOCK_DIR/user-repos.json"
            ;;
          repos/*/dependabot/alerts*)
            path="$2"
            repo=$(printf '%s' "$path" | sed -E 's#repos/([^/]+/[^/]+)/dependabot/alerts.*#\1#')
            key=$(printf '%s' "$repo" | tr / _)
            if [ -f "$MOCK_DIR/repo-fail-$key" ]; then
              printf 'gh: could not fetch alerts\n' >&2
              exit 1
            fi
            if [ -f "$MOCK_DIR/repo-unexpected-$key" ]; then
              cat "$MOCK_DIR/repo-unexpected-$key"
              exit 0
            fi
            cat "$MOCK_DIR/repo-$key.json"
            ;;
          *)
            exit 1
            ;;
        esac
        ;;
      pr)
        # No stubbed PRs in these examples: every branch is reported as
        # having no open PR, so every fixable group is actionable.
        printf '\n'
        ;;
      *)
        exit 1
        ;;
    esac
  End

  Describe 'argument validation'
    It 'rejects an unknown scope'
      When run script "$COMMON/discover-alerts.sh" --scope bogus octo/app
      The status should not equal 0
      The stderr should include 'Unknown scope'
    End

    It 'requires a target for org scope'
      When run script "$COMMON/discover-alerts.sh" --scope org
      The status should not equal 0
      The stderr should include 'Usage'
    End

    It 'requires a target for repo scope'
      When run script "$COMMON/discover-alerts.sh" --scope repo
      The status should not equal 0
      The stderr should include 'Usage'
    End

    It 'defaults to repo scope when none is given'
      write_repo_alerts 'octo/app' lodash direct medium 4.17.21
      When call common_jq discover-alerts.sh '[.actionable[].repo]' octo/app
      The status should be success
      The output should equal '["octo/app"]'
    End

    It 'accepts the --scope=org equals form'
      write_org_agg
      When call common_jq discover-alerts.sh '[.actionable[].repo] | sort' --scope=org octo
      The status should be success
      The output should equal '["octo/app","octo/other"]'
    End
  End

  Describe 'org scope: aggregate endpoint'
    It 'groups the aggregate response per repo and tags each group with repo'
      write_org_agg
      When call common_jq discover-alerts.sh '[.actionable[] | {repo, package}] | sort_by(.repo)' --scope org octo
      The status should be success
      The output should equal '[{"repo":"octo/app","package":"lodash"},{"repo":"octo/other","package":"undici"}]'
    End

    It 'reports no skipped repos when every repo in the aggregate is pushable'
      write_org_agg
      When call common_jq discover-alerts.sh '.skipped_repos' --scope org octo
      The status should be success
      The output should equal '[]'
    End

    # The aggregate response carries no permission data, so this path used to
    # group straight out of the payload with `skipped_repos` hardcoded to `[]`.
    # Org alert visibility (security manager) and per-repo push access are
    # separate grants, so a caller could be handed a repo whose fix agent only
    # discovers the problem at `git push` (issue #38). The listing is fetched
    # purely to answer the push question, and all three states are honored:
    # pushable, denied, and no usable permission data.
    It 'filters the aggregate response on push access too, not only the fallback'
      write_org_agg_repos 'octo/app' 'octo/readonly' 'octo/absent'
      write_repo_listing "$MOCK_DIR/org-repos.json" \
        'octo/app:true:false:false' \
        'octo/readonly:false:false:false'

      When call common_jq discover-alerts.sh '{groups: [.actionable[].repo], skipped: (.skipped_repos | sort_by(.repo))}' --scope org octo
      The status should be success
      The output should equal '{"groups":["octo/app"],"skipped":[{"repo":"octo/absent","reason":"permission data missing from API response"},{"repo":"octo/readonly","reason":"no push access"}]}'
    End

    It 'hard-fails when the permission listing the aggregate path needs cannot be fetched'
      write_org_agg
      rm -f "$MOCK_DIR/org-repos.json"
      When run script "$COMMON/discover-alerts.sh" --scope org octo
      The status should not equal 0
      The stderr should include 'Failed to list repos'
    End

    # `combine_results` merges `skipped: [.[].skipped[]]` across repos, and
    # every other scope fixture leaves that array empty, so nothing proved a
    # skipped group from one repo and one from another keep distinct `repo`
    # tags after combination — issue #19's regression class, covered for
    # `actionable` and not for `skipped` (issue #40).
    It 'keeps skipped groups from two repos distinctly tagged after combination'
      write_org_agg_no_fix

      When call common_jq discover-alerts.sh '[.skipped[] | {repo, package, reason}] | sort_by(.repo)' --scope org octo
      The status should be success
      The output should equal '[{"repo":"octo/app","package":"left-pad","reason":"no fix available"},{"repo":"octo/other","package":"request","reason":"no fix available"}]'
    End

    It 'ranks the combined groups by severity then EPSS across repos'
      write_org_agg
      When call common_jq discover-alerts.sh '[.actionable[].package]' --scope org octo
      The status should be success
      The output should equal '["undici","lodash"]'
    End

    # The cross-repo restatement of issue #19's lesson: grouping must key on
    # repo too, or the same package in two repos collapses into one group and
    # silently under-reports one repo's alert count.
    It 'keeps the same package in two repos as two independent groups'
      jq -n '[[
        {
          number: 1, repository: {full_name: "octo/app"},
          dependency: {package: {ecosystem: "npm", name: "lodash"}, manifest_path: "package.json", relationship: "direct"},
          security_advisory: {ghsa_id: "GHSA-lodash-1", cve_id: "CVE-2000-0002", severity: "medium", summary: "s", epss: {percentile: 0.3}},
          security_vulnerability: {vulnerable_version_range: "< 4.17.21", first_patched_version: {identifier: "4.17.21"}}
        },
        {
          number: 2, repository: {full_name: "octo/other"},
          dependency: {package: {ecosystem: "npm", name: "lodash"}, manifest_path: "package.json", relationship: "direct"},
          security_advisory: {ghsa_id: "GHSA-lodash-1", cve_id: "CVE-2000-0002", severity: "medium", summary: "s", epss: {percentile: 0.3}},
          security_vulnerability: {vulnerable_version_range: "< 4.17.21", first_patched_version: {identifier: "4.17.21"}}
        },
        {
          number: 3, repository: {full_name: "octo/other"},
          dependency: {package: {ecosystem: "npm", name: "lodash"}, manifest_path: "package.json", relationship: "direct"},
          security_advisory: {ghsa_id: "GHSA-lodash-1", cve_id: "CVE-2000-0002", severity: "medium", summary: "s2", epss: {percentile: 0.3}},
          security_vulnerability: {vulnerable_version_range: "< 4.17.21", first_patched_version: {identifier: "4.17.21"}}
        }
      ]]' > "$MOCK_DIR/org-alerts.json"

      When call common_jq discover-alerts.sh '[.actionable[] | {repo, package, alert_count, branch_name}] | sort_by(.repo)' --scope org octo
      The status should be success
      The output should equal '[{"repo":"octo/app","package":"lodash","alert_count":1,"branch_name":"fix/dependabot-lodash-4x"},{"repo":"octo/other","package":"lodash","alert_count":2,"branch_name":"fix/dependabot-lodash-4x"}]'
    End

    # Distinct code path from the fan-out's own empty case (no candidate
    # repos at all): here the aggregate call itself succeeds with zero
    # alerts.
    It 'reports the empty result shape when the aggregate call returns zero alerts'
      jq -n '[[]]' > "$MOCK_DIR/org-alerts.json"
      When call common_jq discover-alerts.sh '.' --scope org octo
      The status should be success
      The output should equal '{"actionable":[],"skipped":[],"skipped_repos":[]}'
    End
  End

  Describe 'org scope: 403 falls back to per-repo enumeration'
    It 'fans out over the repos the user can access, applying push-access filtering'
      : > "$MOCK_DIR/org-403"
      write_repo_listing "$MOCK_DIR/org-repos.json" \
        'octo/app:true:false:false' \
        'octo/readonly:false:false:false'
      write_repo_alerts 'octo/app' lodash direct medium 4.17.21

      When call common_jq discover-alerts.sh '{groups: [.actionable[] | {repo, package}], skipped: .skipped_repos}' --scope org octo
      The status should be success
      The output should equal '{"groups":[{"repo":"octo/app","package":"lodash"}],"skipped":[{"repo":"octo/readonly","reason":"no push access"}]}'
    End

    # The listing is the fan-out's whole candidate set, so a failure to fetch
    # it must abort rather than come back as an empty, clean-looking result.
    It 'hard-fails when the repo listing itself cannot be fetched'
      : > "$MOCK_DIR/org-403"
      rm -f "$MOCK_DIR/org-repos.json"
      When run script "$COMMON/discover-alerts.sh" --scope org octo
      The status should not equal 0
      The stderr should include 'Failed to list repos'
    End

    It 'excludes forks and archived repos from the fan-out without reporting them'
      : > "$MOCK_DIR/org-403"
      write_repo_listing "$MOCK_DIR/org-repos.json" \
        'octo/app:true:false:false' \
        'octo/a-fork:true:true:false' \
        'octo/archived:true:false:true'
      write_repo_alerts 'octo/app' lodash direct medium 4.17.21

      When call common_jq discover-alerts.sh '{groups: [.actionable[].repo], skipped: .skipped_repos}' --scope org octo
      The status should be success
      The output should equal '{"groups":["octo/app"],"skipped":[]}'
    End

    # `(.permissions.push) // false` alone collapses "no permissions object at
    # all" into the same reason as a genuine denial, misattributing the
    # cause — the same absent-vs-false trap scripts/CLAUDE.md documents for
    # score-merge-risk.sh.
    It 'reports missing permission data distinctly from a genuine denial'
      : > "$MOCK_DIR/org-403"
      write_repo_listing_missing_permissions "$MOCK_DIR/org-repos.json" 'octo/unknown'

      When call common_jq discover-alerts.sh '.skipped_repos' --scope org octo
      The status should be success
      The output should equal '[{"repo":"octo/unknown","reason":"permission data missing from API response"}]'
    End

    It 'reports every candidate skipped when none has push access'
      : > "$MOCK_DIR/org-403"
      write_repo_listing "$MOCK_DIR/org-repos.json" \
        'octo/a:false:false:false' \
        'octo/b:false:false:false'

      When call common_jq discover-alerts.sh '{actionable, skipped_repos: ([.skipped_repos[].repo] | sort)}' --scope org octo
      The status should be success
      The output should equal '{"actionable":[],"skipped_repos":["octo/a","octo/b"]}'
    End

    It 'combines a two-page repo listing before filtering (flatten honors pagination)'
      : > "$MOCK_DIR/org-403"
      write_repo_listing_multipage "$MOCK_DIR/org-repos.json" \
        'octo/app:true:false:false' 'octo/other:true:false:false'
      write_repo_alerts 'octo/app' lodash direct medium 4.17.21
      write_repo_alerts 'octo/other' undici transitive high 7.29.0

      When call common_jq discover-alerts.sh '[.actionable[].repo] | sort' --scope org octo
      The status should be success
      The output should equal '["octo/app","octo/other"]'
    End

    # Defensive handling of a shape the API is not observed to return: a 200
    # whose body is valid JSON but not an array. The real Dependabot-disabled
    # response is the 403 covered by 'records a repo whose alert fetch fails'
    # in the user-scope block. What this proves is only that a non-array 200
    # is reported with the body's own message instead of being counted as zero
    # alerts.
    It 'reports the body message when a repo alert endpoint answers 200 with an unexpected non-array body'
      write_repo_listing "$MOCK_DIR/org-repos.json" \
        'octo/app:true:false:false' \
        'octo/odd:true:false:false'
      write_repo_alerts 'octo/app' lodash direct medium 4.17.21
      write_repo_unexpected_body 'octo/odd' 'Something unexpected.'
      : > "$MOCK_DIR/org-403"

      When call common_jq discover-alerts.sh '[.skipped_repos[] | select(.repo == "octo/odd")]' --scope org octo
      The status should be success
      The output should equal '[{"repo":"octo/odd","reason":"invalid alert response","error":"Something unexpected."}]'
    End

    # `permissions.push: null` is missing data, not a denial. Testing for the
    # key's presence rather than the value's type classified it as a genuine
    # "no push access", the exact inversion of the fix made for the omitted
    # `permissions` object above (issue #40).
    It 'treats an explicit null push permission as missing data, not a denial'
      : > "$MOCK_DIR/org-403"
      write_repo_listing_null_push "$MOCK_DIR/org-repos.json" 'octo/nullperm'

      When call common_jq discover-alerts.sh '.skipped_repos' --scope org octo
      The status should be success
      The output should equal '[{"repo":"octo/nullperm","reason":"permission data missing from API response"}]'
    End
  End

  Describe 'org scope: aggregate failure that is not a 403'
    Mock gh
      case "$1" in
        api)
          case "$2" in
            orgs/*/dependabot/alerts*)
              printf 'gh: Internal Server Error (HTTP 500)\n' >&2
              exit 1
              ;;
            *) exit 1 ;;
          esac
          ;;
        *) exit 1 ;;
      esac
    End

    It 'fails loudly instead of silently falling back'
      When run script "$COMMON/discover-alerts.sh" --scope org octo
      The status should not equal 0
      The stderr should include 'HTTP 500'
    End
  End

  # A bare `403` substring is not proof of "no org-level security
  # visibility": a rate limit and a SAML/SSO enforcement block both surface as
  # 403s too. Reinterpreting either as the permission case fans out to
  # per-repo calls that mostly also fail, or succeed against a partial repo
  # set, and come back looking like a clean, wrong answer — exactly the field
  # failure this fix addresses. Both must hard-fail instead of falling back.
  Describe 'org scope: a 403 that is not a permission denial'
    It 'hard-fails on a rate-limited aggregate call instead of falling back'
      printf 'gh: API rate limit exceeded for user ID 12345. (HTTP 403)\n' > "$MOCK_DIR/org-agg-error"
      When run script "$COMMON/discover-alerts.sh" --scope org octo
      The status should not equal 0
      The stderr should include 'rate-limited'
    End

    It 'hard-fails on a secondary rate limit instead of falling back'
      printf 'gh: You have exceeded a secondary rate limit. (HTTP 403)\n' > "$MOCK_DIR/org-agg-error"
      When run script "$COMMON/discover-alerts.sh" --scope org octo
      The status should not equal 0
      The stderr should include 'rate-limited'
    End

    It 'hard-fails on a SAML/SSO enforcement block instead of falling back'
      printf 'gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (HTTP 403)\n' \
        > "$MOCK_DIR/org-agg-error"
      When run script "$COMMON/discover-alerts.sh" --scope org octo
      The status should not equal 0
      The stderr should include 'SAML/SSO enforcement'
    End

    # An IP allow list blocks the credential, not this endpoint, so every
    # per-repo call in the fallback is refused for the same reason. Falling
    # back would bury one clear cause under a pile of generic
    # `alert fetch failed` entries, so it hard-fails and names the cause.
    It 'hard-fails on an IP allow list block instead of falling back'
      # Double-quoted with escaped backticks: GitHub really does wrap the org
      # name in backticks here, and single quotes would read as an unexpanded
      # command substitution (SC2016).
      printf "gh: Although you appear to have the correct authorization credentials, the \`octo\` organization has an IP allow list enabled, and 203.0.113.5 is not permitted to access this resource. (HTTP 403)\n" \
        > "$MOCK_DIR/org-agg-error"
      When run script "$COMMON/discover-alerts.sh" --scope org octo
      The status should not equal 0
      The stderr should include 'IP allow list'
    End

    # Substring matching on gh's formatted stderr classified any 403 whose text
    # merely *contained* `sso` as an SSO block — an org named `tessso-corp` is
    # enough — and hard-failed a case that should fall back (issue #39). The
    # match is word-boundary anchored against the API's own message instead.
    It 'falls back on a permission-shaped 403 whose org name merely contains sso'
      printf 'gh: Resource not accessible by personal access token for the tessso-corp organization. (HTTP 403)\n' \
        > "$MOCK_DIR/org-agg-error"
      write_repo_listing "$MOCK_DIR/org-repos.json" 'tessso-corp/app:true:false:false'
      write_repo_alerts 'tessso-corp/app' lodash direct medium 4.17.21

      When call common_jq discover-alerts.sh '[.actionable[].repo]' --scope org tessso-corp
      The status should be success
      The output should equal '["tessso-corp/app"]'
    End

    # The ordinary permission-shaped 403 (no rate-limit or SAML/SSO wording)
    # must still fall back — this is the pre-existing, still-covered case,
    # named here to make the contrast with the two hard-fail cases explicit.
    It 'still falls back on an ordinary permission-shaped 403'
      : > "$MOCK_DIR/org-403"
      write_repo_listing "$MOCK_DIR/org-repos.json" 'octo/app:true:false:false'
      write_repo_alerts 'octo/app' lodash direct medium 4.17.21

      When call common_jq discover-alerts.sh '[.actionable[].repo]' --scope org octo
      The status should be success
      The output should equal '["octo/app"]'
    End
  End

  Describe 'user scope'
    It 'defaults to the authenticated user and fans out with push-access filtering'
      write_repo_listing "$MOCK_DIR/user-repos.json" \
        'octocat/mine:true:false:false' \
        'octocat/collab:false:false:false'
      write_repo_alerts 'octocat/mine' lodash direct medium 4.17.21

      When call common_jq discover-alerts.sh '{groups: [.actionable[] | {repo, package}], skipped: .skipped_repos}' --scope user
      The status should be success
      The output should equal '{"groups":[{"repo":"octocat/mine","package":"lodash"}],"skipped":[{"repo":"octocat/collab","reason":"no push access"}]}'
    End

    It 'accepts an explicit login that matches the authenticated user'
      write_repo_listing "$MOCK_DIR/user-repos.json" 'octocat/mine:true:false:false'
      write_repo_alerts 'octocat/mine' lodash direct medium 4.17.21

      When call common_jq discover-alerts.sh '[.actionable[].repo]' --scope user octocat
      The status should be success
      The output should equal '["octocat/mine"]'
    End

    # Resolving an explicit login is the one place user scope calls
    # `gh api user`; a failure there must be reported, not silently treated as
    # a mismatch or a match.
    It 'reports a failure to resolve the authenticated user'
      : > "$MOCK_DIR/user-lookup-fail"
      When run script "$COMMON/discover-alerts.sh" --scope user octocat
      The status should not equal 0
      The stderr should include 'Failed to resolve the authenticated user'
    End

    It 'refuses an explicit login that does not match the authenticated user'
      When run script "$COMMON/discover-alerts.sh" --scope user someone-else
      The status should not equal 0
      The stderr should include 'User scope only supports the authenticated user'
    End

    It 'records a repo whose alert fetch fails without aborting the batch'
      write_repo_listing "$MOCK_DIR/user-repos.json" \
        'octocat/mine:true:false:false' \
        'octocat/broken:true:false:false'
      write_repo_alerts 'octocat/mine' lodash direct medium 4.17.21
      : > "$MOCK_DIR/repo-fail-octocat_broken"

      When call common_jq discover-alerts.sh '{groups: [.actionable[].repo], skipped: [.skipped_repos[].repo]}' --scope user
      The status should be success
      The output should equal '{"groups":["octocat/mine"],"skipped":["octocat/broken"]}'
    End
  End
End
