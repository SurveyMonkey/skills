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
    The output should equal '{"exists":false,"missing_count":10,"present":[]}'
  End

  It 'adds the gh rules only when an nwo is supplied'
    make_repo
    When call common_jq preflight-permissions.sh '[.missing[] | select(startswith("Bash(gh"))] | length' check "$REPO" octo/app
    The status should be success
    The output should equal '4'
  End

  It 'covers every bundled script with one absolute-path rule'
    make_repo
    When call common_jq preflight-permissions.sh '.missing[0]' check "$REPO"
    The status should be success
    The output should include 'gh-security/scripts/*'
  End

  # No Bash call inherits the previous call's cwd, so every non-git command the
  # fix agent runs is prescribed as `cd <worktree> && ...` and needs a rule.
  It 'covers the cd prefix into the worktree'
    make_repo
    When call common_jq preflight-permissions.sh '[.missing[] | select(startswith("Bash(cd "))]' check "$REPO"
    The status should be success
    The output should equal "[\"Bash(cd *$REPO/.claude/worktrees/*)\"]"
  End

  # The pin audit's prescribed shapes: `git log -S <key>` for provenance, and
  # two read-only gh lookups. Prescribed shapes and this catalog move together
  # (scripts/CLAUDE.md), so an agent step added without its rule is a
  # permission prompt for spec'd behavior.
  It 'covers the pin audit provenance lookups'
    make_repo
    When call common_jq preflight-permissions.sh '[.missing[] | select(test("log |pr list|dependabot/alerts"))]' check "$REPO" octo/app
    The status should be success
    The output should equal "[\"Bash(git -C *$REPO* log *)\",\"Bash(gh pr list --repo octo/app *)\",\"Bash(gh api repos/octo/app/dependabot/alerts*)\"]"
  End

  # The pin audit's restore and its verifier both run as
  # `git -C "$WORK/audit" ... HEAD -- package.json <lockfile>`, and $WORK sits
  # under .claude/worktrees, so the worktree rule already covers them and
  # neither needs one of its own. Asserted rather than assumed, because those
  # shapes changed (issue #46) and prescribed shapes and this catalog move
  # together.
  #
  # The filter is scoped to $REPO's own worktree path. A bare test on
  # "worktrees/" also matched the catalog's plugin-scripts rule whenever the
  # checkout being tested FROM lives inside a linked worktree, so the example
  # passed on such machines and failed on any clean checkout, CI included
  # (issue #57). The repo-scoped form counts the same three rules everywhere:
  # mkdir, git -C, and cd.
  It 'covers the pin audit restore under the worktree rule alone'
    make_repo
    export REPO
    When call common_jq preflight-permissions.sh '{worktree: ([.missing[] | select(contains(env.REPO + "/.claude/worktrees"))] | length), dedicated: ([.missing[] | select(test("checkout|diff "))] | length)}' check "$REPO"
    The status should be success
    The output should equal '{"worktree":3,"dedicated":0}'
  End

  # Push is `git -C <worktree> push ...` like every other git call, so the
  # worktree rule covers it and a bare-push rule would be dead weight.
  It 'carries no bare git push rule'
    make_repo
    When call common_jq preflight-permissions.sh '[.missing[] | select(startswith("Bash(git push"))] | length' check "$REPO"
    The status should be success
    The output should equal '0'
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
    The output should equal '{"added":10,"dirs":1}'
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
    The output should equal '{"model":"opus","first":"Bash(ls *)","second":"Bash(git status)","deny":["Read(.env)"],"total":12}'
  End

  It 'counts pre-existing catalog rules as present, not missing'
    make_repo
    "$COMMON/preflight-permissions.sh" apply "$REPO" > /dev/null
    When call common_jq preflight-permissions.sh '{missing_count, present: (.present | length)}' check "$REPO"
    The status should be success
    The output should equal '{"missing_count":0,"present":10}'
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
