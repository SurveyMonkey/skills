#!/bin/sh
# shellcheck shell=sh
# The pin audit's restore step, run as prescribed.
#
# agents/audit-pins.md phase 4 step 7 restores the manifest and the lockfile
# between every pin and then verifies the restore, and that verification is the
# only thing standing between a half-completed restore and a batch result
# reported as a per-pin one. It is prose rather than a script, so these examples
# lift the two commands straight out of the definition and run them: a shape
# changed there without its consequence being thought through fails here.
#
# What used to be wrong is subtle enough to have survived review: `git checkout
# --` restores from the **index** and `git diff --quiet` compares against the
# **index**, so the restore and the check that exists to catch a failed restore
# shared one movable reference (issue #46).

Describe 'the prescribed pin-audit restore'
  After 'cleanup_fixture'

  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"

  # A repository with one commit: package.json and yarn.lock as HEAD holds them.
  audit_repo() {
    TEST_DIR=$(mktemp -d)
    REPO="$TEST_DIR/repo"
    mkdir -p "$REPO"
    git -C "$REPO" init -q
    printf '{"name":"demo","overrides":{"lodash":"^4.17.21"}}\n' > "$REPO/package.json"
    printf 'lodash@npm:4.17.21\n' > "$REPO/yarn.lock"
    git -C "$REPO" add package.json yarn.lock
    git -C "$REPO" -c user.name=spec -c user.email=spec@example.invalid \
      -c commit.gpgsign=false commit -qm baseline
  }

  # Edit the manifest the way testing a pin does, and stage it — the state that
  # makes the index a different answer from HEAD.
  stage_removal() {
    printf '{"name":"demo"}\n' > "$REPO/package.json"
    git -C "$REPO" add package.json
  }

  # The two commands as the definition writes them, with the placeholders
  # substituted exactly as the agent is told to substitute them.
  prescribed() {
    # `[$]` rather than `\$`: the character class keeps the dollar literal for
    # grep without looking like an unexpanded variable to ShellCheck (SC2016).
    grep -E 'git -C .[$]WORK/audit. (checkout|diff --quiet)' "$AGENT" \
      | sed -e 's/^[[:space:]]*//' \
            -e "s|\"\$WORK/audit\"|$REPO|" \
            -e 's|<lockfile>|yarn.lock|'
  }

  # stderr is NOT discarded: a git that fails for some reason other than the one
  # under test would otherwise be invisible, and the exit status alone cannot
  # tell the two apart. It flows to the example's own stderr, which each caller
  # asserts is empty.
  run_lines() {
    _st=0
    while IFS= read -r _cmd; do
      [ -n "$_cmd" ] || continue
      eval "$_cmd" >/dev/null || _st=$?
    done <<EOF
$1
EOF
    printf '%s\n' "$_st"
  }

  # The line count is asserted, not just the two lines. Without it a third
  # matching line added to the definition would still pass this example, and
  # would silently change what the two examples below execute — they run
  # whatever `prescribed` returns.
  It 'prescribes exactly one restore and one verification'
    audit_repo
    When call prescribed
    The status should be success
    The lines of output should equal 2
    The line 1 should equal "git -C $REPO checkout HEAD -- package.json yarn.lock"
    The line 2 should equal "git -C $REPO diff --quiet HEAD -- package.json yarn.lock"
  End

  # The restore has to return the file HEAD holds. Restoring from the index
  # returns the bytes of the very edit being undone, and the verifier then
  # agrees, because it is asking the same movable reference.
  It 'returns the manifest to HEAD even when the index holds the removal'
    audit_repo
    stage_removal
    exit_and_manifest() {
      _st=$(run_lines "$(prescribed)")
      printf 'exit=%s manifest=%s\n' "$_st" "$(cat "$REPO/package.json")"
    }
    When call exit_and_manifest
    The status should be success
    The stderr should equal ''
    The output should equal 'exit=0 manifest={"name":"demo","overrides":{"lodash":"^4.17.21"}}'
  End

  # And the verification on its own must fail for a tree that matches only the
  # index: that is a restore which did not happen, which is exactly the case
  # step 7 exists to stop the run on.
  It 'fails verification on a tree that matches the index but not HEAD'
    audit_repo
    stage_removal
    verify_only() { run_lines "$(prescribed | tail -1)"; }
    When call verify_only
    The status should be success
    The stderr should equal ''
    The output should equal '1'
  End
End
