#!/bin/sh
# shellcheck shell=sh
# fix-group.sh `apply` and `score` — phases 4 and 5 of the fix flow (#34, #49,
# #83, #105, #132, #146, #147, #171).
#
# Every example asserts the verdict: the exit code plus the checkpoint JSON, or
# the argv the driver built. That is the point of moving this out of prose — a
# fatal cross-line move, a `no_op` reported instead of a `lockfile-refresh`, or
# a `--declared-range` flag that never got built are all silent in a document
# and loud here.
#
# The adapter and the risk scorer are both mocked with scratch executables that
# serve canned JSON and record their argv: specs never hit the network or run
# an install (root CLAUDE.md).

Describe 'fix-group.sh apply and score'
  DRIVER="$COMMON/fix-group.sh"
  After 'cleanup_fixture'

  # Deliberately a copy of the harness in spec/fix_group_spec.sh: shellspec
  # files are self-contained, and this mock indexes apply_constraint and
  # validate per call so a remediation-ladder step can answer differently from
  # the one before it.
  make_env() {
    TEST_DIR=$(mktemp -d)
    ORIGIN="$TEST_DIR/origin"
    REPO="$TEST_DIR/repo"
    BIN="$TEST_DIR/bin"
    MOCK_DIR="$TEST_DIR/mock"
    MOCK_LOG="$TEST_DIR/argv.log"
    SCORER_LOG="$TEST_DIR/scorer.log"
    export MOCK_DIR MOCK_LOG SCORER_LOG
    mkdir -p "$ORIGIN" "$BIN" "$MOCK_DIR"
    : > "$MOCK_LOG"
    : > "$SCORER_LOG"
    git -C "$ORIGIN" init -q -b main
    printf '{"name":"app","dependencies":{"lodash":"^4.17.20"}}\n' > "$ORIGIN/package.json"
    printf '{"lockfileVersion":3}\n' > "$ORIGIN/package-lock.json"
    git -C "$ORIGIN" add -A
    git -C "$ORIGIN" -c user.email=spec@example.invalid -c user.name=spec commit -qm init
    git clone -q "$ORIGIN" "$REPO"
    git -C "$REPO" config user.email spec@example.invalid
    git -C "$REPO" config user.name spec
    WORK="$REPO/.claude/worktrees/fix-dependabot-lodash-4x"
    MOCK="$BIN/adapter.sh"
    SCORER="$BIN/scorer.sh"
    write_mock
    write_scorer
    write_group '[]'
    defaults
  }

  write_mock() {
    cat > "$MOCK" <<'SH'
#!/bin/sh
{ printf 'VERB %s\n' "$1"; for a in "$@"; do printf 'ARG %s\n' "$a"; done; } >> "$MOCK_LOG"
verb=$1
shift
nth() {
  n=$(cat "$MOCK_DIR/$1.n" 2>/dev/null || echo 0)
  n=$((n + 1))
  printf '%s\n' "$n" > "$MOCK_DIR/$1.n"
  printf '%s' "$n"
}
case "$verb" in
  why|declared_ranges)
    cat "$MOCK_DIR/$verb.json" ;;
  resolved_versions)
    n=$(nth rv)
    if [ -f "$MOCK_DIR/rv.$n.json" ]; then cat "$MOCK_DIR/rv.$n.json"; else cat "$MOCK_DIR/rv.json"; fi ;;
  apply_constraint)
    n=$(nth apply)
    if [ -f "$MOCK_DIR/apply.$n.err" ]; then cat "$MOCK_DIR/apply.$n.err" >&2; exit 1; fi
    if [ -f "$MOCK_DIR/apply.$n.json" ]; then cat "$MOCK_DIR/apply.$n.json"; else cat "$MOCK_DIR/apply.json"; fi ;;
  validate)
    n=$(nth validate)
    f="$MOCK_DIR/validate.$n.json"
    [ -f "$f" ] || f="$MOCK_DIR/validate.json"
    cat "$f"
    jq -e '.ok' "$f" >/dev/null ;;
  install)
    n=$(nth install)
    if [ -f "$MOCK_DIR/install.$n.sh" ]; then . "$MOCK_DIR/install.$n.sh"
    elif [ -f "$MOCK_DIR/install.sh" ]; then . "$MOCK_DIR/install.sh"; fi
    exit "$(cat "$MOCK_DIR/install.$n.status" 2>/dev/null || cat "$MOCK_DIR/install.status" 2>/dev/null || echo 0)" ;;
  compare_versions)
    jq -n --arg a "$1" --arg b "$2" \
      '{a: $a, b: $b, result: (if $a < $b then -1 elif $a > $b then 1 else 0 end)}' ;;
  *) printf '{"error":"unknown verb"}\n' >&2; exit 1 ;;
esac
SH
    chmod +x "$MOCK"
  }

  write_scorer() {
    cat > "$SCORER" <<'SH'
#!/bin/sh
for a in "$@"; do printf '%s\n' "$a"; done >> "$SCORER_LOG"
jq -n '{package: "lodash", score: 2, max: 14, band: "Low",
        markdown: "### Merge risk", coverage: {}, ci: {},
        factors: [{id: "F4", score: 0}, {id: "F5", score: 1}]}'
SH
    chmod +x "$SCORER"
  }

  # $1 is the sibling_alerts value, or the empty string for a payload that
  # carries no such field at all (older discovery).
  write_group() {
    if [ -n "$1" ]; then
      cat > "$TEST_DIR/group.json" <<JSON
{"package": "lodash", "ecosystem": "npm", "major_line": "4",
 "highest_fixed_version": "4.17.21",
 "branch_name": "fix/dependabot-lodash-4x",
 "alerts": [{"number": 1, "vulnerable_range": "< 4.17.21"},
            {"number": 2, "vulnerable_range": "< 4.17.21"}],
 "sibling_alerts": $1}
JSON
    else
      cat > "$TEST_DIR/group.json" <<'JSON'
{"package": "lodash", "ecosystem": "npm", "major_line": "4",
 "highest_fixed_version": "4.17.21",
 "branch_name": "fix/dependabot-lodash-4x",
 "alerts": [{"number": 1, "vulnerable_range": "< 4.17.21"}]}
JSON
    fi
  }

  defaults() {
    cat > "$MOCK_DIR/why.json" <<'JSON'
{"pm": "npm", "package": "lodash", "relationship": "transitive",
 "peer_only": false, "peer_parents": [], "optional_peer_parents": [],
 "parents": ["express"], "raw": "lodash@4.17.20"}
JSON
    cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": ["^4.17.20"],
 "root_range": null, "parents_read": ["express"],
 "parents_without_range": [], "parents_unreadable": [],
 "parents_malformed": [], "parents_other_lines": []}
JSON
    # Snapshot 1 is the pre-drift read, 2 the post-control baseline, 3 the
    # post-fix read.
    rv 1 4.17.20
    rv 2 4.17.20
    rv 3 4.17.21
    apply_json 1 scoped '[{"parent":"express","path":["overrides","express","lodash"],"value":">=4.17.21 <5"}]' '[]'
    # The fallback every later apply_constraint call in a run gets, so a ladder
    # step that does not pin its own answer still has one.
    cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
    validate_json 1 true '[]' '[]'
    # The control install refreshes the lockfile; the fix install changes it
    # again, which is the ordinary non-empty-diff fix.
    cat > "$MOCK_DIR/install.sh" <<'SH'
printf '{"lockfileVersion":3,"n":%s}\n' "$n" > package-lock.json
SH
  }

  rv() {
    cat > "$MOCK_DIR/rv.$1.json" <<JSON
{"pm": "npm", "package": "lodash", "present": true, "count": 1,
 "versions": [{"version": "$2", "path": "node_modules/lodash"}],
 "lockfile_entries": 3}
JSON
  }

  # $1 call index, $2 mode, $3 written[], $4 observations[]
  apply_json() {
    cat > "$MOCK_DIR/apply.$1.json" <<JSON
{"pm": "npm", "package": "lodash", "range": ">=4.17.21 <5",
 "override_location": "overrides", "override_file": "package.json",
 "mode": "$2", "parents": ["express"], "written": $3,
 "superseded_keys": [], "alias_lookup": {"source": "lockfile", "parents_unresolved": []},
 "lockfile_invalidated": {"performed": true, "keys": ["node_modules/lodash"]},
 "observations": $4}
JSON
  }

  # $1 call index, $2 ok, $3 violations[], $4 other_line_moves
  validate_json() {
    cat > "$MOCK_DIR/validate.$1.json" <<JSON
{"ok": $2, "package": "lodash", "range": ">=4.17.21 <5", "line": "4",
 "line_present": true, "checked": 1, "resolved_count": 1,
 "violations": $3, "unresolved_alerts": [], "requires_major_bump": [],
 "other_line_moves": $4, "resolved_versions": ["4.17.21"]}
JSON
  }

  drv_jq() {
    _filter=$1
    shift
    _st=0
    _out=$("$DRIVER" "$@") || _st=$?
    if [ -n "$_out" ]; then
      printf '%s' "$_out" | jq -c "$_filter"
    fi
    return "$_st"
  }

  through_baseline() {
    "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
      --default-branch main --adapter "$MOCK" --scorer "$SCORER" >/dev/null
    "$DRIVER" classify --work "$WORK" >/dev/null
    "$DRIVER" baseline --work "$WORK" >/dev/null
  }

  Describe 'apply (phase 4)'
    It 'reaches a scoped-override success on the ordinary path'
      make_env
      through_baseline
      When call drv_jq '{status, step, action, override_scope, bare_override}' apply --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","step":"apply","action":"scoped-override","override_scope":"scoped","bare_override":"none"}'
    End

    It 'derives a major-bounded range from highest_fixed_version'
      make_env
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call grep -c '^ARG >=4.17.21 <5$' "$MOCK_LOG"
      The status should be success
      The output should not equal '0'
    End

    # Any fatal entry stops the run. The constraint and completeness checks are
    # both scoped to --line and structurally cannot see an out-of-line copy, so
    # `ok` from them is not evidence about any line but this one (#83).
    It 'stops on a fatal cross-line move and quotes the array'
      make_env
      validate_json 1 false '[]' '[{"major":1,"before":["1.1.18"],"after":[],"status":"vanished","class":"fatal"}]'
      through_baseline
      When call drv_jq '{status, phase}' apply --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"validate"}'
      The stderr should include '"class":"fatal"'
      The stderr should include 'Narrowing the key is not the remedy'
    End

    # That class is the adapter's verdict at the strictest policy, never this
    # flow's own judgement, and it proceeds (#105).
    It 'proceeds when every cross-line move is benign_dedup'
      make_env
      validate_json 1 true '[]' '[{"major":2,"before":["2.3.1","2.3.2"],"after":["2.3.2"],"status":"moved","class":"benign_dedup"}]'
      through_baseline
      When call drv_jq '{status, action, benign: (.benign_moves | length)}' apply --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","action":"scoped-override","benign":1}'
    End

    # `[]` is a real answer and is passed as `[]`; an ABSENT field means the
    # flag is omitted entirely, which makes validate class every cross-line
    # move fatal — the intended fail-safe default (#105).
    It 'passes --sibling-alerts verbatim when the group carries the field'
      make_env
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call grep -c '^ARG --sibling-alerts$' "$MOCK_LOG"
      The status should be success
      The output should equal '1'
    End

    It 'omits --sibling-alerts entirely when the field is absent from the payload'
      make_env
      write_group ''
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call grep -c '^ARG --sibling-alerts$' "$MOCK_LOG"
      The status should equal 1
      The output should equal '0'
    End

    It 'passes one --vulnerable per distinct vulnerable_range'
      make_env
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call grep -c '^ARG --vulnerable$' "$MOCK_LOG"
      The status should be success
      The output should equal '1'
    End

    # The adapter retargets a declaration that merely COLLIDES with the
    # package's name, writing a version of a different package that does not
    # exist. Neither it nor this flow can disambiguate the two senses (#49).
    It 'rejects a written npm: value naming a different package'
      make_env
      apply_json 1 scoped '[{"parent":"express","path":["overrides","express","lodash"],"value":"npm:underscore@>=4.17.21 <5"}]' '[]'
      through_baseline
      When call drv_jq '{status, phase}' apply --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"apply"}'
      The stderr should include 'npm:underscore'
      The stderr should include 'resolved by hand'
    End

    It 'does not run the fix install on that rejection'
      make_env
      apply_json 1 scoped '[{"parent":"express","path":["overrides","express","lodash"],"value":"npm:underscore@>=4.17.21 <5"}]' '[]'
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
      When call cat "$MOCK_DIR/install.n"
      The status should be success
      The output should equal '1'
    End

    # A `"."` self key carries the manifest's own pre-existing value, kept
    # while restructuring a string-valued rule. Failing the run on one aborts a
    # correct fix (#147).
    It 'exempts a preserved: true entry from the npm: rejection'
      make_env
      apply_json 1 scoped '[{"parent":"express","path":["overrides","express","."],"value":"npm:underscore@^1.13.6","preserved":true},{"parent":"express","path":["overrides","express","lodash"],"value":">=4.17.21 <5"}]' '[]'
      through_baseline
      When call drv_jq '{status, action}' apply --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","action":"scoped-override"}'
    End

    It 'passes an apply_constraint refusal through as phase apply, verbatim'
      make_env
      printf '{"error":"apply_constraint: the root manifest spec for express also admits copies on other major lines"}\n' > "$MOCK_DIR/apply.1.err"
      through_baseline
      When call drv_jq '{status, phase}' apply --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"apply"}'
      The stderr should include 'also admits copies on other major lines'
    End

    Describe 'the remediation ladder'
      # Step 1: a violating version usually arrives via a parent not in the
      # override list. Those parents come off the violating copies' paths.
      It 'adds the uncovered parent from a violating copy path and re-runs'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        apply_json 2 scoped '[{"parent":"koa","path":["overrides","koa","lodash"],"value":">=4.17.21 <5"}]' '[]'
        through_baseline
        When call drv_jq '{status, action, applied_parents}' apply --work "$WORK"
        The status should be success
        The output should equal '{"status":"ok","action":"scoped-override","applied_parents":["express","koa"]}'
      End

      # Step 2: the widest change this flow can make, so it is the last thing
      # reached for. `tightened` requires a matching pre-fix observation; the
      # observations captured BEFORE the first call are what tell the two apart.
      It 'escalates to a tightened bare override when one already targeted the package'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        apply_json 1 scoped '[]' '[{"type":"unscoped_override","key":"lodash","range":"^4.17.0","targets_this_package":true}]'
        through_baseline
        When call drv_jq '{status, action, override_scope, bare_override}' apply --work "$WORK"
        The status should be success
        The output should equal '{"status":"ok","action":"bare-override","override_scope":"bare-tightened","bare_override":"tightened"}'
      End

      It 'reports an added bare override when no pre-fix observation targeted the package'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        apply_json 1 scoped '[]' '[{"type":"unscoped_override","key":"sharp","range":">=0.35.0 <1","targets_this_package":false}]'
        through_baseline
        When call drv_jq '{action, override_scope, bare_override}' apply --work "$WORK"
        The status should be success
        The output should equal '{"action":"bare-override","override_scope":"bare-added","bare_override":"added"}'
      End

      It 'passes --tighten-bare on the escalation'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null
        When call grep -c '^ARG --tighten-bare$' "$MOCK_LOG"
        The status should be success
        The output should equal '1'
      End

      # Step 4: the line is not installed at all, so the override does nothing.
      # Never open a PR for a change with no effect, and never confuse this with
      # the no-op status.
      It 'fails on line_present false, naming requires_major_bump'
        make_env
        cat > "$MOCK_DIR/validate.1.json" <<'JSON'
{"ok": false, "package": "lodash", "range": ">=4.17.21 <5", "line": "4",
 "line_present": false, "checked": 0, "resolved_count": 1,
 "violations": [], "unresolved_alerts": [], "other_line_moves": [],
 "requires_major_bump": [{"version": "3.10.1", "path": "node_modules/test-exclude/node_modules/lodash"}],
 "resolved_versions": ["3.10.1"]}
JSON
        through_baseline
        When call drv_jq '{status, phase}' apply --work "$WORK"
        The status should equal 3
        The output should equal '{"status":"failure","phase":"validate"}'
        The stderr should include 'requires_major_bump'
        The stderr should include '3.10.1'
      End

      # An install failure the ladder does not cover is the agent's to
      # diagnose: a peer conflict needing a wider range, a version that does
      # not exist. Fail closed, never guess.
      It 'hands an undecidable install failure back as needs_judgment'
        make_env
        printf '1\n' > "$MOCK_DIR/install.2.status"
        cat > "$MOCK_DIR/install.2.sh" <<'SH'
printf 'npm ERR! notarget No matching version found for lodash@>=4.17.21\n' >&2
SH
        through_baseline
        When call drv_jq '{status, decision_point, err: (.evidence.error | test("notarget"))}' apply --work "$WORK"
        The status should equal 2
        The output should equal '{"status":"needs_judgment","decision_point":"install_failure","err":true}'
      The stderr should include 'needs judgment at install_failure'
      End

      It 'still fails validation after the ladder rather than guessing'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        validate_json 2 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        validate_json 3 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        through_baseline
        When call drv_jq '{status, decision_point}' apply --work "$WORK"
        The status should equal 2
        The output should equal '{"status":"needs_judgment","decision_point":"validate_failed_after_ladder"}'
      The stderr should include 'needs judgment at validate_failed_after_ladder'
      End
    End

    Describe 'the empty-diff case'
      # Phase 3's drift commit has already absorbed any ambient drift, so empty
      # porcelain here means the fix install itself changed nothing (#146).
      # What it does not yet say is WHICH install cleared the alerts.
      no_fix_change() {
        cat > "$MOCK_DIR/install.2.sh" <<'SH'
:
SH
      }

      It 'is a true no-op when the line resolves identically across the drift commit'
        make_env
        no_fix_change
        rv 1 4.17.21
        rv 2 4.17.21
        rv 3 4.17.21
        through_baseline
        When call drv_jq '{status, resolved_version, diff: .no_op.evidence.diff}' apply --work "$WORK"
        The status should be success
        The output should equal '{"status":"no_op","resolved_version":"4.17.21","diff":""}'
      End

      It 'carries the required no_op evidence object rather than a bare reason'
        make_env
        no_fix_change
        rv 1 4.17.21
        rv 2 4.17.21
        rv 3 4.17.21
        through_baseline
        When call drv_jq '{keys: (.no_op.evidence | keys), reason: (.no_op.reason | length > 0)}' apply --work "$WORK"
        The status should be success
        The output should equal '{"keys":["diff","merged_pr_url","resolved_version","validate"],"reason":true}'
      End

      # A real fix whose content is the drift commit: the manifest already
      # admits the fixed version and only the stale committed lockfile pinned
      # the vulnerable one. Reporting it as "already fixed" leaves the alerts
      # open with nothing to review.
      It 'is a lockfile-refresh when the control install moved the line'
        make_env
        no_fix_change
        rv 1 4.17.20
        rv 2 4.17.21
        rv 3 4.17.21
        through_baseline
        When call drv_jq '{status, action, override_scope, bare_override}' apply --work "$WORK"
        The status should be success
        The output should equal '{"status":"ok","action":"lockfile-refresh","override_scope":"none","bare_override":"none"}'
      End

      # A lone lockfile refresh that clears none of this group's alerts is not
      # this flow's mandate, so it is cleaned up like any other no-op.
      It 'stays a no-op when an unrelated drift commit left the line alone'
        make_env
        no_fix_change
        rv 1 4.17.21
        rv 2 4.17.21
        rv 3 4.17.21
        through_baseline
        When call drv_jq '{status, drift_commit}' apply --work "$WORK"
        The status should be success
        The output should equal '{"status":"no_op","drift_commit":true}'
      End
    End
  End

  Describe 'score (phase 5)'
    through_apply() {
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
    }

    flag_after() {
      grep -A1 -x -- "$1" "$SCORER_LOG" | tail -1
    }

    It 'returns ready_for_pr carrying the scorer band and the action'
      make_env
      through_apply
      When call drv_jq '{status, action, resolved_version, band: .risk.band, f5: .risk.f5}' score --work "$WORK"
      The status should be success
      The output should equal '{"status":"ready_for_pr","action":"scoped-override","resolved_version":"4.17.21","band":"Low","f5":1}'
    End

    # F1's --before comes from the post-control-install baseline, so the delta
    # it measures is fix-attributable (#146).
    It 'takes --before from the post-control baseline on an ordinary fix'
      make_env
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call flag_after '--before'
      The status should be success
      The output should equal '4.17.20'
    End

    # Except on a lockfile-refresh, where the refresh IS the change, so the
    # delta is the refresh's own.
    It 'takes --before from the pre-drift snapshot on a lockfile-refresh'
      make_env
      cat > "$MOCK_DIR/install.2.sh" <<'SH'
:
SH
      rv 1 4.17.20
      rv 2 4.17.21
      rv 3 4.17.21
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call flag_after '--before'
      The status should be success
      The output should equal '4.17.20'
    End

    It 'reports the widest override shape it applied through --override-scope'
      make_env
      validate_json 1 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
      validate_json 2 true '[]' '[]'
      apply_json 1 scoped '[]' '[{"type":"unscoped_override","key":"lodash","range":"^4.17.0","targets_this_package":true}]'
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call flag_after '--override-scope'
      The status should be success
      The output should equal 'bare-tightened'
    End

    It 'passes one --declared-range per distinct range'
      make_env
      cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": ["^4.17.20", "~4.17.0"],
 "root_range": null, "parents_read": ["express", "koa"],
 "parents_without_range": [], "parents_unreadable": [],
 "parents_malformed": [], "parents_other_lines": []}
JSON
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call grep -c -x -- '--declared-range' "$SCORER_LOG"
      The status should be success
      The output should equal '2'
    End

    # `--declared-range` is required, with an explicit `none` sentinel:
    # optional, its absence made the multi-major escalation unreachable.
    It 'passes the none sentinel when no dependent range could be read'
      make_env
      cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": [],
 "root_range": null, "parents_read": [], "parents_without_range": [],
 "parents_unreadable": ["express"], "parents_malformed": [],
 "parents_other_lines": []}
JSON
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call flag_after '--declared-range'
      The status should be success
      The output should equal 'none'
    End

    # The sentinel is the same and the reviewer's conclusion is not, so the two
    # ways of reaching it are reported apart.
    It 'distinguishes an unreadable view from parents that declared nothing'
      make_env
      cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": [],
 "root_range": null, "parents_read": ["express"],
 "parents_without_range": ["express"], "parents_unreadable": [],
 "parents_malformed": [], "parents_other_lines": []}
JSON
      through_apply
      When call drv_jq '{declared_ranges_cause}' score --work "$WORK"
      The status should be success
      The output should equal '{"declared_ranges_cause":"parents_declared_nothing"}'
    End

    # The why capture is package-qualified and lives under $WORK, never in the
    # shared session scratchpad where a sibling agent overwrites it (#133), and
    # a scoped name is slugged so the path exists at all (#161).
    It 'writes the why capture to a package-qualified path under WORK'
      make_env
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call flag_after '--why-json'
      The status should be success
      The output should equal "$WORK/why-lodash.json"
    End

    It 'refuses to score a run apply already terminated as a no-op'
      make_env
      cat > "$MOCK_DIR/install.2.sh" <<'SH'
:
SH
      rv 1 4.17.21
      rv 2 4.17.21
      rv 3 4.17.21
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call drv_jq '{has_error: (has("error"))}' score --work "$WORK"
      The status should equal 1
      The output should equal '{"has_error":true}'
      The stderr should include 'which is terminal'
    End
  End
End
