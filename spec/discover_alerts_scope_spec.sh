#!/bin/sh
# shellcheck shell=sh
# scripts/common/discover-alerts.sh: --scope repo|org|user (RFC 001 Phase 3,
# issue #6).
#
# Org scope prefers the aggregate `/orgs/{org}/dependabot/alerts` endpoint and
# falls back to per-repo enumeration on a 403 (no org-level security
# visibility). User scope has no aggregate endpoint at all and always fans out
# per repo. Both fan-out paths filter on push access, and a repo the
# authenticated user cannot push to is reported by name in `skipped_repos`
# rather than dropped silently.

Describe 'discover-alerts.sh --scope'
  setup_mock() {
    MOCK_DIR="$SHELLSPEC_WORKDIR/discover-scope-mock"
    rm -rf "$MOCK_DIR"
    mkdir -p "$MOCK_DIR"
    : > "$MOCK_DIR/log"
    export MOCK_DIR
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
  # array (e.g. Dependabot disabled for that repo) — not a `gh api` failure,
  # so it must be classified by content, not treated as a fetch error.
  write_repo_disabled() {
    key=$(printf '%s' "$1" | tr / _)
    jq -n --arg msg "$2" '{message: $msg}' > "$MOCK_DIR/repo-disabled-$key"
  }

  Mock gh
    case "$1" in
      api)
        case "$2" in
          user)
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
            if [ -f "$MOCK_DIR/repo-disabled-$key" ]; then
              cat "$MOCK_DIR/repo-disabled-$key"
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

    It 'reports no skipped repos on a clean aggregate call'
      write_org_agg
      When call common_jq discover-alerts.sh '.skipped_repos' --scope org octo
      The status should be success
      The output should equal '[]'
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

    It 'reports the API message when a repo alert endpoint answers 200 with a non-array body'
      write_repo_listing "$MOCK_DIR/org-repos.json" \
        'octo/app:true:false:false' \
        'octo/disabled:true:false:false'
      write_repo_alerts 'octo/app' lodash direct medium 4.17.21
      write_repo_disabled 'octo/disabled' 'Dependabot alerts are disabled for this repository.'
      : > "$MOCK_DIR/org-403"

      When call common_jq discover-alerts.sh '[.skipped_repos[] | select(.repo == "octo/disabled")]' --scope org octo
      The status should be success
      The output should equal '[{"repo":"octo/disabled","reason":"invalid alert response","error":"Dependabot alerts are disabled for this repository."}]'
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
