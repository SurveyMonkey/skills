#!/bin/sh
# shellcheck shell=sh
# The pin audit's restore step, run as the driver writes it.
#
# `common/audit-pins-driver.sh` restores the manifest and the lockfile between
# every pin and then verifies the restore, and that verification is the only
# thing standing between a half-completed restore and a batch result reported
# as a per-pin one. These examples lift the two commands straight out of the
# driver and run them: a shape changed there without its consequence being
# thought through fails here.
#
# The pair used to be prose in `agents/audit-pins.md` phase 4 step 7 and moved
# into the driver with the loop it belongs to (issue #174); the behavioural
# consequence — a failed verification ending the RUN — is asserted through the
# driver's own JSON in spec/audit_driver_spec.sh. What this file adds is that
# the two commands, executed, actually do what the rule claims.
#
# What used to be wrong is subtle enough to have survived review: `git checkout
# --` restores from the **index** and `git diff --quiet` compares against the
# **index**, so the restore and the check that exists to catch a failed restore
# shared one movable reference (issue #46).

Describe 'the pin-audit restore, as the driver writes it'
  After 'cleanup_fixture'

  DRIVER="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/common/audit-pins-driver.sh"

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

  # The two commands as the driver writes them, with its seams substituted
  # exactly as the driver substitutes them at run time: `git_at "$WT"` composes
  # `git -C <worktree>` (plus any env_prefix), and `"${paths[@]}"` is the
  # override file plus the lockfile the adapter named.
  #
  # The pattern requires the `"${paths[@]}"` pathspec, because the per-pin pair
  # is what this file is about and it is not the only restore the driver runs:
  # phase 7 restores `.yarn/cache` once, before the combined test, on a
  # different pathspec and for a different reason (issue #72). Matching every
  # `checkout`/`diff --quiet` would fold that one in and silently change what
  # the two examples below execute, since they run whatever `prescribed`
  # returns.
  prescribed() {
    # `[$]` rather than `\$`: the character class keeps the dollar literal for
    # grep without looking like an unexpanded variable to ShellCheck (SC2016).
    grep -oE 'git_at "[$]WT" (checkout HEAD|diff --quiet HEAD) -- "[$][{]paths\[@\][}]"' "$DRIVER" \
      | sed -e "s|git_at \"\$WT\"|git -C $REPO|" \
            -e 's|"[$]{paths\[@\]}"|package.json yarn.lock|'
  }

  # Counted, not executed: phase 7's own restore.
  cache_restore() {
    grep -cE 'git_at "[$]WT" checkout HEAD -- [.]yarn/cache' "$DRIVER"
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
  # matching line added to the driver would still pass this example, and would
  # silently change what the two examples below execute — they run whatever
  # `prescribed` returns.
  It 'writes exactly one restore and one verification'
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

  # Phase 7's cache restore is a separate, single, differently-scoped command,
  # gated on `ls-files` reporting something tracked. Folding it into the per-pin
  # pathspec would run it after every pin; dropping it would let per-pin cache
  # residue reach the removal commit.
  It 'runs the cache restore once, on its own pathspec'
    When call cache_restore
    The status should be success
    The output should equal '1'
  End

  # And the verification on its own must fail for a tree that matches only the
  # index: that is a restore which did not happen, which is exactly the case the
  # driver ends the run on.
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
