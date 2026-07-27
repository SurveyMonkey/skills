#!/bin/sh
# shellcheck shell=sh
# scripts/common/preflight-permissions.sh: one-decision permission grants.

Describe 'preflight-permissions.sh'
  After 'cleanup_fixture'

  make_repo() {
    TEST_DIR=$(mktemp -d)
    REPO="$TEST_DIR/repo"
    mkdir -p "$REPO"
  }

  settings() { cat "$REPO/.claude/settings.local.json"; }

  It 'reports every rule missing for a repo with no settings file'
    make_repo
    When call common_jq preflight-permissions.sh '{exists, missing_count, present}' check "$REPO"
    The status should be success
    The output should equal '{"exists":false,"missing_count":8,"present":[]}'
  End

  It 'adds the gh rules only when an nwo is supplied'
    make_repo
    When call common_jq preflight-permissions.sh '[.missing[] | select(startswith("Bash(gh"))] | length' check "$REPO" octo/app
    The status should be success
    The output should equal '2'
  End

  It 'covers every bundled script with one absolute-path rule'
    make_repo
    When call common_jq preflight-permissions.sh '.missing[0]' check "$REPO"
    The status should be success
    The output should include 'gh-security/scripts/*'
  End

  It 'check is read-only'
    make_repo
    When call common_jq preflight-permissions.sh '.exists' check "$REPO"
    The status should be success
    The output should equal 'false'
    The path "$REPO/.claude/settings.local.json" should not be exist
  End

  It 'apply creates the settings file with all rules and the plugin directory'
    make_repo
    When call common_jq preflight-permissions.sh '{added: (.added | length), dirs: (.additional_directories_added | length)}' apply "$REPO"
    The status should be success
    The output should equal '{"added":8,"dirs":1}'
    The path "$REPO/.claude/settings.local.json" should be exist
  End

  It 'is idempotent: a second apply adds nothing'
    make_repo
    "$COMMON/preflight-permissions.sh" apply "$REPO" octo/app > /dev/null
    When call common_jq preflight-permissions.sh '{added, additional_directories_added}' apply "$REPO" octo/app
    The status should be success
    The output should equal '{"added":[],"additional_directories_added":[]}'
  End

  It 'appends only missing rules and preserves user content and order'
    make_repo
    mkdir -p "$REPO/.claude"
    printf '%s\n' '{"model":"opus","permissions":{"allow":["Bash(ls *)","Bash(git status)"],"deny":["Read(.env)"]}}' \
      > "$REPO/.claude/settings.local.json"
    "$COMMON/preflight-permissions.sh" apply "$REPO" > /dev/null
    When call jq -c '{model, first: .permissions.allow[0], second: .permissions.allow[1], deny: .permissions.deny, total: (.permissions.allow | length)}' "$REPO/.claude/settings.local.json"
    The status should be success
    The output should equal '{"model":"opus","first":"Bash(ls *)","second":"Bash(git status)","deny":["Read(.env)"],"total":10}'
  End

  It 'counts pre-existing catalog rules as present, not missing'
    make_repo
    "$COMMON/preflight-permissions.sh" apply "$REPO" > /dev/null
    When call common_jq preflight-permissions.sh '{missing_count, present: (.present | length)}' check "$REPO"
    The status should be success
    The output should equal '{"missing_count":0,"present":8}'
  End

  It 'refuses to touch a settings file that is not valid JSON'
    make_repo
    mkdir -p "$REPO/.claude"
    printf 'not json{' > "$REPO/.claude/settings.local.json"
    When call common_jq preflight-permissions.sh '.' apply "$REPO"
    The status should equal 1
    The stderr should include 'not valid JSON'
    The contents of file "$REPO/.claude/settings.local.json" should equal 'not json{'
  End

  It 'rejects a missing repo_root'
    When call common_jq preflight-permissions.sh '.' check /nonexistent-repo-root
    The status should equal 1
    The stderr should include 'does not exist'
  End

  It 'rejects an unknown verb'
    When run script "$COMMON/preflight-permissions.sh" frobnicate /tmp
    The status should not equal 0
    The stderr should be present
  End
End
