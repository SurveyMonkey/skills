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

  Mock gh
    case "$1" in
      api)
        case "$2" in
          user)
            printf 'octocat\n'
            ;;
          orgs/*/dependabot/alerts*)
            printf 'org-agg\n' >> "$MOCK_DIR/log"
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
