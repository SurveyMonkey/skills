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
    # Numeric, segment by segment. A lexical string compare — which this mock
    # used to be — answers 4.17.9 > 4.17.10, so every example that depended on
    # it agreed with a `lowest_on_line` that was picking the wrong version.
    jq -n --arg a "$1" --arg b "$2" '
      def parts: split(".") | map(tonumber? // 0);
      ($a | parts) as $x | ($b | parts) as $y
      | {a: $a, b: $b, result: (if $x < $y then -1 elif $x > $y then 1 else 0 end)}' ;;
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
    write_validate "$MOCK_DIR/validate.$1.json" "$2" "$3" "$4"
  }

  # The answer every unindexed validate call in a run gets, for examples that
  # run the ladder past the indices they pinned.
  validate_fallback() {
    write_validate "$MOCK_DIR/validate.json" "$1" "$2" "$3"
  }

  write_validate() {
    cat > "$1" <<JSON
{"ok": $2, "package": "lodash", "range": ">=4.17.21 <5", "line": "4",
 "line_present": true, "checked": 1, "resolved_count": 1,
 "violations": $3, "unresolved_alerts": [], "requires_major_bump": [],
 "other_line_moves": $4, "resolved_versions": ["4.17.21"]}
JSON
  }

  # A resolved_versions payload carrying an arbitrary versions[] array, for the
  # multi-version shapes the single-version helper above cannot express.
  rv_versions() {
    cat > "$MOCK_DIR/rv.$1.json" <<JSON
{"pm": "npm", "package": "lodash", "present": true, "count": 2,
 "versions": $2, "lockfile_entries": 4}
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

    # Both preconditions used to be checked (or not checked) too late: the
    # baseline not at all, and the alert set only once package.json had been
    # rewritten and a full install had run.
    It 'refuses to run without a baseline, before anything is written'
      make_env
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$MOCK" --scorer "$SCORER" >/dev/null
      "$DRIVER" classify --work "$WORK" >/dev/null
      When call drv_jq '{has_error: has("error")}' apply --work "$WORK"
      The status should equal 1
      The output should equal '{"has_error":true}'
      The stderr should include "run 'baseline' first"
    End

    It 'runs no apply_constraint and no install when the baseline is missing'
      make_env
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$MOCK" --scorer "$SCORER" >/dev/null
      "$DRIVER" classify --work "$WORK" >/dev/null
      "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
      When call grep -c -e '^VERB apply_constraint' -e '^VERB install' "$MOCK_LOG"
      The status should equal 1
      The output should equal '0'
    End

    # `--vulnerable` is what lets validate answer whether the alerts were
    # CLEARED rather than merely whether the constraint holds. An alert whose
    # range is dropped from the set lets `unresolved_alerts` come back empty
    # for an alert nothing ever checked — the silent partial fix.
    It 'fails on an alert carrying no vulnerable_range rather than dropping it'
      make_env
      cat > "$TEST_DIR/group.json" <<'JSON'
{"package": "lodash", "ecosystem": "npm", "major_line": "4",
 "highest_fixed_version": "4.17.21",
 "branch_name": "fix/dependabot-lodash-4x",
 "alerts": [{"number": 1, "vulnerable_range": "< 4.17.21"},
            {"number": 2, "vulnerable_range": null}],
 "sibling_alerts": []}
JSON
      through_baseline
      When call drv_jq '{status, phase}' apply --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"apply"}'
      The stderr should include '[2]'
      The stderr should include 'nothing checked'
    End

    It 'writes nothing on that refusal'
      make_env
      cat > "$TEST_DIR/group.json" <<'JSON'
{"package": "lodash", "ecosystem": "npm", "major_line": "4",
 "highest_fixed_version": "4.17.21",
 "branch_name": "fix/dependabot-lodash-4x",
 "alerts": [{"number": 2, "vulnerable_range": null}],
 "sibling_alerts": []}
JSON
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
      When call grep -c '^VERB apply_constraint' "$MOCK_LOG"
      The status should equal 1
      The output should equal '0'
    End

    # `[]` is a real answer and is passed as `[]`. The flag's VALUE is the
    # assertion, not its presence: passed as anything else, validate's benign
    # classification silently changes.
    It 'passes the sibling_alerts value verbatim, not merely the flag'
      make_env
      write_group '[{"number": 9, "package": "lodash", "major": 3}]'
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call grep -A1 -x -- 'ARG --sibling-alerts' "$MOCK_LOG"
      The status should be success
      The output should include '[{"number":9,"package":"lodash","major":3}]'
    End

    It 'passes an empty sibling_alerts array as []'
      make_env
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call grep -A1 -x -- 'ARG --sibling-alerts' "$MOCK_LOG"
      The status should be success
      The output should include 'ARG []'
    End

    # A direct dependency passes no parents at all, and the adapter retargets
    # the manifest's own declaration. `written[]` says so — `dependencies`,
    # not `overrides` — and that is what makes it a direct-update.
    It 'reports a direct dependency retarget as direct-update, end to end'
      make_env
      cat > "$MOCK_DIR/why.json" <<'JSON'
{"pm": "npm", "package": "lodash", "relationship": "direct",
 "peer_only": false, "peer_parents": [], "optional_peer_parents": [],
 "parents": [], "raw": "lodash@4.17.20"}
JSON
      apply_json 1 direct '[{"parent":null,"path":["dependencies","lodash"],"value":">=4.17.21 <5"}]' '[]'
      cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
      through_baseline
      When call drv_jq '{action, override_scope, bare_override, applied_parents}' apply --work "$WORK"
      The status should be success
      The output should equal '{"action":"direct-update","override_scope":"none","bare_override":"none","applied_parents":[]}'
    End

    It 'passes no parent arguments on the direct path'
      make_env
      cat > "$MOCK_DIR/why.json" <<'JSON'
{"pm": "npm", "package": "lodash", "relationship": "direct",
 "peer_only": false, "peer_parents": [], "optional_peer_parents": [],
 "parents": [], "raw": "lodash@4.17.20"}
JSON
      through_baseline
      "$DRIVER" apply --work "$WORK" >/dev/null
      When call grep -A3 '^VERB apply_constraint' "$MOCK_LOG"
      The status should be success
      The output should not include 'ARG express'
    End

    # `mode` reports the call's INPUT — "direct" means zero parents were passed
    # — and a TRANSITIVE package whose eligible set came back empty takes that
    # same branch, where the adapter writes a top-level BARE override when the
    # root declares no key for it. Keyed off `mode`, that pin was reported as
    # `direct-update` / `--override-scope none` / `bare_override: none`: F6
    # scored 0 instead of 2, the PR body owed no Global-override section, and
    # the `unscoped_override_added` observation the pin audit reads was never
    # recorded — the audit losing the record of a pin this run created.
    Describe 'a bare override is never labelled by apply_constraint mode'
      no_eligible_parents() {
        cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": [],
 "root_range": null, "parents_read": [], "parents_without_range": [],
 "parents_unreadable": [], "parents_malformed": [],
 "parents_other_lines": ["express@3.1.5"]}
JSON
      }

      Parameters
        'overrides'      '["overrides","lodash"]'
        'resolutions'    '["resolutions","lodash"]'
        'pnpm.overrides' '["pnpm","overrides","lodash"]'
      End

      It "reports a top-level $1 write as bare-added despite mode direct"
        make_env
        no_eligible_parents
        apply_json 1 direct "[{\"parent\":null,\"path\":$2,\"value\":\">=4.17.21 <5\"}]" '[]'
        cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
        through_baseline
        When call drv_jq '{action, override_scope, bare_override}' apply --work "$WORK"
        The status should be success
        The output should equal '{"action":"bare-override","override_scope":"bare-added","bare_override":"added"}'
      End
    End

    It 'reports it as bare-tightened when a pre-fix observation targeted the package'
      make_env
      cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": [],
 "root_range": null, "parents_read": [], "parents_without_range": [],
 "parents_unreadable": [], "parents_malformed": [], "parents_other_lines": []}
JSON
      apply_json 1 direct '[{"parent":null,"path":["overrides","lodash"],"value":">=4.17.21 <5"}]' \
        '[{"type":"unscoped_override","key":"lodash","range":"^4.17.0","targets_this_package":true}]'
      cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
      through_baseline
      When call drv_jq '{action, override_scope, bare_override}' apply --work "$WORK"
      The status should be success
      The output should equal '{"action":"bare-override","override_scope":"bare-tightened","bare_override":"tightened"}'
    End

    # A nested key under the same container is scoped, however the mode reads.
    It 'keeps a nested override key scoped'
      make_env
      apply_json 1 direct '[{"parent":"express","path":["overrides","express","lodash"],"value":">=4.17.21 <5"}]' '[]'
      cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
      through_baseline
      When call drv_jq '{action, override_scope}' apply --work "$WORK"
      The status should be success
      The output should equal '{"action":"scoped-override","override_scope":"scoped"}'
    End

    # A `"."` self key quotes the manifest's own pre-existing value; it is not
    # a shape this call chose, so it never decides the widest shape either.
    It 'ignores a preserved entry when deciding the widest shape'
      make_env
      apply_json 1 scoped '[{"parent":"express","path":["overrides","lodash"],"value":"^4.0.0","preserved":true},{"parent":"express","path":["overrides","express","lodash"],"value":">=4.17.21 <5"}]' '[]'
      cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
      through_baseline
      When call drv_jq '{action, override_scope}' apply --work "$WORK"
      The status should be success
      The output should equal '{"action":"scoped-override","override_scope":"scoped"}'
    End

    # Defaulted to 0 on an absent or unreadable value, the persisted counter
    # re-opens the exact hole persisting it closed: the budget stops bounding
    # the run and `install_budget_exhausted` becomes unreachable again, with
    # nothing said about it.
    Describe 'the persisted install budget is read strictly'
      Parameters
        absent        'del(.fix_installs)'
        null          '.fix_installs = null'
        not-a-number  '.fix_installs = "lots"'
        negative      '.fix_installs = "-1"'
      End

      It "refuses to run when fix_installs is $1 rather than defaulting to zero"
        make_env
        through_baseline
        jq -c "$2" "$WORK/state.json" > "$WORK/s.tmp"
        mv "$WORK/s.tmp" "$WORK/state.json"
        When call drv_jq '{has_error: has("error")}' apply --work "$WORK"
        The status should equal 1
        The output should equal '{"has_error":true}'
        The stderr should be present
      End
    End

    # `drift_commit` is the third input to the no_op-versus-lockfile-refresh
    # decision. Read leniently, an unreadable or absent value mapped to "",
    # which is not "true", which takes the **no_op** branch — the one that
    # cleans up and leaves the alerts open. The two snapshots beside it already
    # fail hard for exactly this reason (#146).
    Describe 'the drift flag fails away from no_op, never toward it'
      Parameters
        absent        'del(.drift_commit)'
        null          '.drift_commit = null'
        not-a-boolean '.drift_commit = "yes"'
      End

      It "refuses to decide the empty-diff case when drift_commit is $1"
        make_env
        cat > "$MOCK_DIR/install.2.sh" <<'SH'
:
SH
        rv 1 4.17.21
        rv 2 4.17.21
        rv 3 4.17.21
        through_baseline
        jq -c "$2" "$WORK/state.json" > "$WORK/s.tmp"
        mv "$WORK/s.tmp" "$WORK/state.json"
        When call drv_jq '{status}' apply --work "$WORK"
        The status should not equal 0
        The output should not equal '{"status":"no_op"}'
        The stderr should be present
      End
    End

    # The evidence for "already fixed on the default branch" is the resolved
    # version. Read with `[]?`, an absent one became the empty string and was
    # interpolated into the reason as "against the resolved ".
    It 'never reports a no_op whose resolved_version is empty'
      make_env
      cat > "$MOCK_DIR/install.2.sh" <<'SH'
:
SH
      rv 1 4.17.21
      rv 2 4.17.21
      rv 3 4.17.21
      cat > "$MOCK_DIR/validate.1.json" <<'JSON'
{"ok": true, "package": "lodash", "range": ">=4.17.21 <5", "line": "4",
 "line_present": true, "checked": 1, "resolved_count": 1,
 "violations": [], "unresolved_alerts": [], "requires_major_bump": [],
 "other_line_moves": [], "resolved_versions": []}
JSON
      through_baseline
      When call drv_jq '{status, phase}' apply --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"validate"}'
      The stderr should include 'no evidence'
    End

    It 'fails the same way when validate omits resolved_versions entirely'
      make_env
      cat > "$MOCK_DIR/install.2.sh" <<'SH'
:
SH
      rv 1 4.17.21
      rv 2 4.17.21
      rv 3 4.17.21
      validate_json 1 true '[]' '[]'
      jq -c 'del(.resolved_versions)' "$MOCK_DIR/validate.1.json" > "$MOCK_DIR/v.tmp"
      mv "$MOCK_DIR/v.tmp" "$MOCK_DIR/validate.1.json"
      through_baseline
      When call drv_jq '{status, phase}' apply --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"validate"}'
      The stderr should include "no 'resolved_versions' field"
    End

    # `state_json` returning `null` at status 0 put `state_ok` in the code
    # without the thing it checks for: absence became a *value*, and a
    # `--argjson applied null` then reached jq's `- $applied`, which refuses —
    # reported as "validate's violations[] could not be read", blaming the
    # adapter for a state hole.
    It 'names the missing classify step rather than blaming the adapter'
      make_env
      through_baseline
      jq -c 'del(.eligible_parents) | .relationship = "transitive"' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      When call drv_jq '{has_error: has("error")}' apply --work "$WORK"
      The status should equal 1
      The output should equal '{"has_error":true}'
      The stderr should include 'eligible_parents'
      The stderr should not include 'violations'
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

      # A parent on another major line never receives a scoped entry: its copy
      # is on another major and a sibling agent owns it (#83). Delete the
      # subtraction and this is the only example that notices.
      It 'never derives a parent that is on another major line'
        make_env
        cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": ["^4.17.20"],
 "root_range": null, "parents_read": ["express"],
 "parents_without_range": [], "parents_unreadable": [],
 "parents_malformed": [], "parents_other_lines": ["koa@1.4.0"]}
JSON
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        through_baseline
        When call drv_jq '{applied_parents, action}' apply --work "$WORK"
        The status should be success
        The output should equal '{"applied_parents":["express"],"action":"bare-override"}'
      End

      # Step 1 exhausted with parents still uncovered, then step 2. The whole
      # ladder in one run, with the argv of each apply_constraint call asserted
      # through the parents it carried.
      It 'runs step 1 and then step 2 when the added parent is not enough'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        validate_json 2 false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        validate_json 3 true '[]' '[]'
        through_baseline
        When call drv_jq '{action, applied_parents, step1: .parent_derivation.possible}' apply --work "$WORK"
        The status should be success
        The output should equal '{"action":"bare-override","applied_parents":["express","koa"],"step1":true}'
      End

      It 'spends exactly three fix installs across a full step1-then-step2 run'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        validate_json 2 false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        validate_json 3 true '[]' '[]'
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null
        When call jq -r '.fix_installs' "$WORK/state.json"
        The status should be success
        The output should equal '3'
      End

      # **Only npm's violation path names a parent.** node.sh emits the
      # lockfile key `node_modules/...` for npm, `<name>@<version>` for pnpm
      # and the resolution locator `<name>@npm:<version>` for Yarn Berry — the
      # last two name the violating COPY. Assuming npm's shape for all three
      # made `uncovered_parents` `[]` on every pnpm and Yarn repository, so the
      # run escalated straight to `--tighten-bare` — the widest change the flow
      # can make — with step 1 reported as exhausted.
      Describe 'a violation path that names only the copy'
        Parameters
          'pnpm'  '"lodash@4.17.20"'
          'yarn'  '"lodash@npm:4.17.20"'
        End

        It "records that step 1 was impossible under $1 instead of faking it"
          make_env
          validate_json 1 false "[{\"version\":\"4.17.20\",\"path\":$2}]" '[]'
          validate_json 2 true '[]' '[]'
          through_baseline
          When call drv_jq '{p: .parent_derivation.possible, parents: .parent_derivation.parents, opaque: .parent_derivation.paths_naming_only_the_copy, named: .parent_derivation.paths_naming_a_parent}' apply --work "$WORK"
          The status should be success
          The output should equal '{"p":false,"parents":[],"opaque":1,"named":0}'
        End

        It "names the reason in the $1 escalation evidence"
          make_env
          validate_fallback false "[{\"version\":\"4.17.20\",\"path\":$2}]" '[]'
          rm -f "$MOCK_DIR/validate.1.json"
          through_baseline
          When call drv_jq '{dp: .decision_point, p: .evidence.parent_derivation.possible, r: (.evidence.parent_derivation.reason | test("name the copy itself"))}' apply --work "$WORK"
          The status should equal 2
          The output should equal '{"dp":"validate_failed_after_ladder","p":false,"r":true}'
          The stderr should include 'needs judgment at validate_failed_after_ladder'
        End
      End

      # A SCOPED parent occupies two path segments. Read as one,
      # `node_modules/@nestjs/core/node_modules/lodash` yielded `core` — a
      # package npm has never heard of — and that name went to
      # `apply_constraint`, so the scoped entry moved nothing, validate still
      # failed, and the run escalated to a tree-wide bare pin. No fixture in
      # any of the three managers carried a scoped name, which is why the
      # suite never saw it.
      Describe 'the parent name is the whole name, scope included'
        Parameters
          nested-scoped-parent    'node_modules/@nestjs/core/node_modules/lodash'   '["@nestjs/core"]'
          nested-plain-parent     'node_modules/koa/node_modules/lodash'            '["koa"]'
          deep-scoped-parent      'node_modules/a/node_modules/@types/node/node_modules/lodash' '["@types/node"]'
          deep-plain-parent       'node_modules/a/node_modules/koa/node_modules/lodash'         '["koa"]'
          top-level-copy          'node_modules/lodash'                             '[]'
        End

        It "derives $3 from an npm $1"
          make_env
          validate_json 1 false "[{\"version\":\"4.17.20\",\"path\":\"$2\"}]" '[]'
          validate_json 2 true '[]' '[]'
          through_baseline
          When call drv_jq '{parents: .parent_derivation.parents}' apply --work "$WORK"
          The status should be success
          The output should equal "{\"parents\":$3}"
        End
      End

      # The verdict, not just the derivation: the scoped name has to reach
      # apply_constraint's argv, because that is what makes the override name
      # a parent that exists.
      It 'passes the scoped parent to apply_constraint verbatim'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/@nestjs/core/node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null
        When call grep -c -x -- 'ARG @nestjs/core' "$MOCK_LOG"
        The status should be success
        The output should equal '1'
      End

      It 'never passes the scope-stripped remainder as a parent'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/@nestjs/core/node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null
        When call grep -c -x -- 'ARG core' "$MOCK_LOG"
        The status should equal 1
        The output should equal '0'
      End

      It 'reports the scoped parent in applied_parents'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/@nestjs/core/node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        through_baseline
        When call drv_jq '{applied_parents}' apply --work "$WORK"
        The status should be success
        The output should equal '{"applied_parents":["@nestjs/core","express"]}'
      End

      # A scoped parent already carrying an entry is not derived again, which
      # only holds if both sides spell the name the same way.
      It 'excludes a scoped parent that already carries an entry'
        make_env
        cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": ["^4.17.20"],
 "root_range": null, "parents_read": ["@nestjs/core@10.4.1"],
 "parents_without_range": [], "parents_unreadable": [],
 "parents_malformed": [], "parents_other_lines": []}
JSON
        validate_fallback false '[{"version":"4.17.20","path":"node_modules/@nestjs/core/node_modules/lodash"}]' '[]'
        rm -f "$MOCK_DIR/validate.1.json"
        through_baseline
        When call drv_jq '{parents: .evidence.parent_derivation.parents, applied: .evidence.applied_parents}' apply --work "$WORK"
        The status should equal 2
        The output should equal '{"parents":[],"applied":["@nestjs/core"]}'
        The stderr should include 'needs judgment'
      End

      # The same name, in the shapes pnpm and Yarn Berry report. Neither names
      # a parent at all, and a scoped package name must not be mistaken for
      # one on either.
      Describe 'a scoped package in the copy-only path shapes'
        Parameters
          pnpm  '"@babel/traverse@7.23.0"'
          yarn  '"@babel/traverse@npm:7.23.0"'
        End

        It "reads a scoped $1 path as naming no parent"
          make_env
          validate_json 1 false "[{\"version\":\"4.17.20\",\"path\":$2}]" '[]'
          validate_json 2 true '[]' '[]'
          through_baseline
          When call drv_jq '{p: .parent_derivation.possible, parents: .parent_derivation.parents, opaque: .parent_derivation.paths_naming_only_the_copy}' apply --work "$WORK"
          The status should be success
          The output should equal '{"p":false,"parents":[],"opaque":1}'
        End
      End

      # `path` is promised on every violation. Dropped instead of failed, the
      # entry counted in neither `paths_naming_a_parent` nor `opaque_paths`, so
      # the run reported `possible: false` carrying the pnpm-and-Yarn reason —
      # a wrong diagnosis presented as a checked fact about a report that had
      # simply stopped answering.
      Describe 'a violation with no readable path'
        Parameters
          absent    '[{"version":"4.17.20"}]'
          null      '[{"version":"4.17.20","path":null}]'
          not-text  '[{"version":"4.17.20","path":["node_modules","lodash"]}]'
        End

        It "fails the phase when a violation path is $1"
          make_env
          validate_json 1 false "$2" '[]'
          validate_json 2 true '[]' '[]'
          through_baseline
          When call drv_jq '{status, phase}' apply --work "$WORK"
          The status should equal 3
          The output should equal '{"status":"failure","phase":"validate"}'
          The stderr should include "no readable 'path'"
          The stderr should not include 'Yarn Berry the resolution locator'
        End
      End

      It 'reports step 1 as possible on an npm install path'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        validate_json 2 true '[]' '[]'
        through_baseline
        When call drv_jq '{p: .parent_derivation.possible, parents: .parent_derivation.parents}' apply --work "$WORK"
        The status should be success
        The output should equal '{"p":true,"parents":["koa"]}'
      End

      # Step 3: the lockfile-invalidation pass cannot account for the failure,
      # and deleting a whole lockfile needs confirmation this flow cannot get.
      Describe 'the stale-lockfile stop'
        Parameters
          refused-with-a-reason  '{"performed": false, "reason": "npm only"}'
          performed-no-keys      '{"performed": true, "keys": []}'
        End

        It "stops when the lockfile-invalidation pass was $1"
          make_env
          validate_fallback false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
          rm -f "$MOCK_DIR/validate.1.json"
          apply_json 1 scoped '[]' '[]'
          jq -c ".lockfile_invalidated = $2" "$MOCK_DIR/apply.1.json" > "$MOCK_DIR/apply.json"
          cp "$MOCK_DIR/apply.json" "$MOCK_DIR/apply.1.json"
          through_baseline
          When call drv_jq '{status, phase}' apply --work "$WORK"
          The status should equal 3
          The output should equal '{"status":"failure","phase":"validate"}'
          The stderr should include 'needs a human-driven session'
        End
      End

      # The count lives in state.json, which is what makes the budget real: one
      # `apply` spends at most three of the four, and the agent doc sanctions
      # re-running `apply` once — a process-local counter reset on that re-run
      # and bounded nothing, leaving `install_budget_exhausted` unreachable.
      It 'resumes the fix-install count across a re-run rather than resetting it'
        make_env
        validate_fallback false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        rm -f "$MOCK_DIR/validate.1.json"
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
        "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
        When call jq -r '.fix_installs' "$WORK/state.json"
        The status should be success
        The output should equal '4'
      End

      It 'reaches install_budget_exhausted on the re-run rather than installing a fifth time'
        make_env
        validate_fallback false '[{"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]' '[]'
        rm -f "$MOCK_DIR/validate.1.json"
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
        When call drv_jq '{status, decision_point, n: .evidence.fix_installs, b: .evidence.budget}' apply --work "$WORK"
        The status should equal 2
        The output should equal '{"status":"needs_judgment","decision_point":"install_budget_exhausted","n":4,"b":4}'
        The stderr should include 'needs judgment at install_budget_exhausted'
      End

      # Recomputed on the budgeted re-run, the pre-fix observations describe a
      # manifest this flow has already written the override into, so
      # `targets_this_package` reads true and a bare override this run ADDED is
      # reported as `tightened` — the pin audit then reads a global pin nobody
      # created. The stored capture is the run's, not the call's.
      It 'keeps the first run pre-fix observations across a re-run'
        make_env
        validate_fallback false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        rm -f "$MOCK_DIR/validate.1.json"
        apply_json 1 scoped '[]' '[]'
        cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
        # The second run's adapter now reports the override it already wrote.
        apply_json 9 scoped '[]' '[{"type":"unscoped_override","key":"lodash","range":">=4.17.21 <5","targets_this_package":true}]'
        cp "$MOCK_DIR/apply.9.json" "$MOCK_DIR/apply.json"
        "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
        When call jq -c '.observations_first' "$WORK/state.json"
        The status should be success
        The output should equal '[]'
      End

      # The verdict the stored capture protects. On the re-run the ladder
      # escalates to `--tighten-bare` again, and the adapter now reports the
      # unscoped override THIS FLOW wrote on the first run. Recomputed, that
      # observation makes the run report `tightened`; the run's own stored
      # capture keeps it `added`, which is what the pin audit needs to see.
      It 'reports a re-run bare override as added, not as tightened'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        validate_json 2 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        validate_json 3 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        apply_json 1 scoped '[]' '[]'
        cp "$MOCK_DIR/apply.1.json" "$MOCK_DIR/apply.json"
        through_baseline
        "$DRIVER" apply --work "$WORK" >/dev/null 2>&1 || true
        # The re-run: validate clears on the escalation, and the adapter now
        # sees the override the first run wrote.
        validate_fallback true '[]' '[]'
        apply_json 9 scoped '[]' '[{"type":"unscoped_override","key":"lodash","range":">=4.17.21 <5","targets_this_package":true}]'
        cp "$MOCK_DIR/apply.9.json" "$MOCK_DIR/apply.json"
        When call drv_jq '{action, bare_override}' apply --work "$WORK"
        The status should be success
        The output should equal '{"action":"bare-override","bare_override":"added"}'
      End

      # Exit 2 is the contracted `needs_judgment`. Unvalidated, a jq failure
      # assembling the evidence printed nothing and the `exit 2` still ran:
      # the contracted code with no payload at all, which the agent reads as a
      # judgment escape naming no decision point. The install error is the one
      # evidence field carrying arbitrary bytes from outside this flow.
      It 'never exits 2 without a decision point and an evidence object'
        make_env
        printf '1\n' > "$MOCK_DIR/install.2.status"
        cat > "$MOCK_DIR/install.2.sh" <<'SH'
printf 'npm ERR! notarget \001\002 no matching version\n' >&2
SH
        through_baseline
        When call drv_jq '{status, dp: (.decision_point | length > 0), ev: (.evidence | type)}' apply --work "$WORK"
        The status should equal 2
        The output should equal '{"status":"needs_judgment","dp":true,"ev":"object"}'
        The stderr should include 'needs judgment at install_failure'
      End

      # The contract reserves `install` for the fix-attributable install
      # (`baseline` covers the ambient control one), and this is the value the
      # agent copies straight into its own result block.
      It 'names the install_failure evidence phase install, not apply'
        make_env
        printf '1\n' > "$MOCK_DIR/install.2.status"
        cat > "$MOCK_DIR/install.2.sh" <<'SH'
printf 'npm ERR! notarget No matching version found for lodash@>=4.17.21\n' >&2
SH
        through_baseline
        When call drv_jq '{p: .evidence.phase, retry: .evidence.registry_timeout_retry}' apply --work "$WORK"
        The status should equal 2
        The output should equal '{"p":"install","retry":false}'
        The stderr should include 'needs judgment at install_failure'
      End

      # `line_present` is a promised field: read straight, an absent one is the
      # string "null" and the stop is simply bypassed.
      It 'fails when validate omits line_present rather than bypassing its stop'
        make_env
        validate_json 1 false '[{"version":"4.17.20","path":"node_modules/lodash"}]' '[]'
        jq -c 'del(.line_present)' "$MOCK_DIR/validate.1.json" > "$MOCK_DIR/v.tmp"
        mv "$MOCK_DIR/v.tmp" "$MOCK_DIR/validate.1.json"
        through_baseline
        When call drv_jq '{status, phase}' apply --work "$WORK"
        The status should equal 3
        The output should equal '{"status":"failure","phase":"validate"}'
        The stderr should include "no 'line_present' field"
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

      # The specimen is the field shape: an in-range patch bump the control
      # install alone produced, with the line resolved at two versions before
      # it, so the comparison is between ARRAYS and not two scalars. The
      # invented single-version shape could not tell an array comparison from
      # a string one.
      It 'is a lockfile-refresh when a multi-version line deduped across the drift'
        make_env
        no_fix_change
        rv_versions 1 '[{"version":"4.17.15","path":"node_modules/lodash"},
                        {"version":"4.17.20","path":"node_modules/koa/node_modules/lodash"}]'
        rv_versions 2 '[{"version":"4.17.21","path":"node_modules/lodash"},
                        {"version":"4.17.21","path":"node_modules/koa/node_modules/lodash"}]'
        rv_versions 3 '[{"version":"4.17.21","path":"node_modules/lodash"},
                        {"version":"4.17.21","path":"node_modules/koa/node_modules/lodash"}]'
        through_baseline
        When call drv_jq '{status, action, override_scope}' apply --work "$WORK"
        The status should be success
        The output should equal '{"status":"ok","action":"lockfile-refresh","override_scope":"none"}'
      End

      It 'is a no-op when a multi-version line resolves identically across the drift'
        make_env
        no_fix_change
        rv_versions 1 '[{"version":"4.17.21","path":"node_modules/lodash"},
                        {"version":"4.17.21","path":"node_modules/koa/node_modules/lodash"}]'
        rv_versions 2 '[{"version":"4.17.21","path":"node_modules/koa/node_modules/lodash"},
                        {"version":"4.17.21","path":"node_modules/lodash"}]'
        rv 3 4.17.21
        through_baseline
        When call drv_jq '{status}' apply --work "$WORK"
        The status should be success
        The output should equal '{"status":"no_op"}'
      End

      # Two failed reads compare equal. Read through `2>/dev/null` with the
      # status discarded, that manufactured "already fixed on the default
      # branch" out of nothing — discarding the drift commit that WAS the fix
      # and leaving the alerts open (#146's inversion).
      Describe 'a snapshot that could not be read is never evidence of equality'
        Parameters
          'a null version'   '{"pm":"npm","package":"lodash","present":true,"count":1,"versions":[{"version":null,"path":"node_modules/lodash"}],"lockfile_entries":3}'
          'no versions key'  '{"pm":"npm","package":"lodash","present":true,"count":1,"lockfile_entries":3}'
          'zero versions'    '{"pm":"npm","package":"lodash","present":true,"count":0,"versions":[],"lockfile_entries":3}'
        End

        It "refuses to report no_op when the pre-drift snapshot carries $1"
          make_env
          no_fix_change
          printf '%s\n' "$2" > "$MOCK_DIR/rv.1.json"
          rv 2 4.17.21
          rv 3 4.17.21
          through_baseline
          When call drv_jq '{status, phase}' apply --work "$WORK"
          The status should equal 3
          The output should equal '{"status":"failure","phase":"validate"}'
          The stderr should be present
        End

        It "refuses to report no_op when the baseline snapshot carries $1"
          make_env
          no_fix_change
          rv 1 4.17.21
          printf '%s\n' "$2" > "$MOCK_DIR/rv.2.json"
          rv 3 4.17.21
          through_baseline
          When call drv_jq '{status, phase}' apply --work "$WORK"
          The status should equal 3
          The output should equal '{"status":"failure","phase":"validate"}'
          The stderr should be present
        End
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

    # `lowest_on_line` is a comparison, and the mock's `compare_versions` is
    # numeric per segment: read lexically, 4.17.9 sorts above 4.17.10 and the
    # lowest-on-line answer comes back inverted.
    It 'reports the numerically lowest version on the line, not the lexical one'
      make_env
      rv_versions 3 '[{"version":"4.17.10","path":"node_modules/lodash"},
                      {"version":"4.17.9","path":"node_modules/koa/node_modules/lodash"}]'
      through_apply
      When call drv_jq '{resolved_version}' score --work "$WORK"
      The status should be success
      The output should equal '{"resolved_version":"4.17.9"}'
    End

    # There is no fall back to the lowest version overall. That reported a
    # version from a major line this group does not own as its `after`, which
    # then flowed into --after, resolved_version and F1 (#76).
    It 'fails rather than reporting an off-line version as the resolved version'
      make_env
      rv_versions 3 '[{"version":"3.10.1","path":"node_modules/test-exclude/node_modules/lodash"}]'
      through_apply
      When call drv_jq '{status, phase}' score --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"validate"}'
      The stderr should include 'no comparable 4.x version'
    End

    It 'never passes an empty --after to the scorer'
      make_env
      rv_versions 3 '[{"version":"3.10.1","path":"node_modules/test-exclude/node_modules/lodash"}]'
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null 2>&1 || true
      When call cat "$SCORER_LOG"
      The status should be success
      The output should equal ''
    End

    # A package absent from the pre-fix tree has no baseline, and the scorer's
    # own no-baseline branch scores F1 as a major — the safe direction. What is
    # never done is substituting a version from another line.
    It 'omits --before entirely when the pre-fix snapshot reports present false'
      make_env
      cat > "$MOCK_DIR/rv.2.json" <<'JSON'
{"pm": "npm", "package": "lodash", "present": false, "count": 0,
 "versions": [], "lockfile_entries": 3}
JSON
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call grep -c -x -- '--before' "$SCORER_LOG"
      The status should equal 1
      The output should equal '0'
    End

    It 'omits --before when the package is present but not on this line'
      make_env
      cat > "$MOCK_DIR/rv.2.json" <<'JSON'
{"pm": "npm", "package": "lodash", "present": true, "count": 1,
 "versions": [{"version": "3.10.1", "path": "node_modules/lodash"}],
 "lockfile_entries": 3}
JSON
      through_apply
      "$DRIVER" score --work "$WORK" >/dev/null
      When call grep -c -x -- '--before' "$SCORER_LOG"
      The status should equal 1
      The output should equal '0'
    End

    # An adapter exiting 0 with EMPTY stdout used to make `jq -n --argjson`
    # die with exit 2 and NO stdout — and exit 2 is this contract's
    # `needs_judgment`, so the agent read it as a judgment escape carrying no
    # decision point and hunted for evidence fields that do not exist.
    Describe 'an adapter answering with nothing at score'
      Parameters
        'why'
        'declared_ranges'
      End

      It "fails the phase when $1 exits 0 with empty stdout"
        make_env
        through_apply
        : > "$MOCK_DIR/$1.json"
        When call drv_jq '{status, phase}' score --work "$WORK"
        The status should equal 3
        The output should equal '{"status":"failure","phase":"validate"}'
        The stderr should include 'no JSON object on stdout'
      End
    End

    It 'fails the phase when the post-fix resolved_versions omits present'
      make_env
      through_apply
      rv_versions 3 '[{"version":"4.17.21","path":"node_modules/lodash"}]'
      jq -c 'del(.present)' "$MOCK_DIR/rv.3.json" > "$MOCK_DIR/r.tmp"
      mv "$MOCK_DIR/r.tmp" "$MOCK_DIR/rv.3.json"
      printf '2\n' > "$MOCK_DIR/rv.n"
      When call drv_jq '{status, phase}' score --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"validate"}'
      The stderr should include "no 'present' field"
    End

    # A scorer that ran and failed is a phase failure, not this script's
    # usage-and-internal exit 1: reported under 1 it lands in a different
    # bucket from every other failure of the same phase.
    It 'reports a failed risk scorer as a phase failure, not an internal error'
      make_env
      cat > "$SCORER" <<'SH'
#!/bin/sh
printf 'score-merge-risk.sh: adapter contract violation\n' >&2
exit 1
SH
      chmod +x "$SCORER"
      through_apply
      When call drv_jq '{status, phase}' score --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"validate"}'
      The stderr should include 'adapter contract violation'
    End

    It 'reports a scorer answering without a band the same way'
      make_env
      cat > "$SCORER" <<'SH'
#!/bin/sh
printf '{"package": "lodash"}\n'
SH
      chmod +x "$SCORER"
      through_apply
      When call drv_jq '{status, phase}' score --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"validate"}'
      The stderr should include 'no usable report'
    End

    It 'carries the install signals through to the ready_for_pr payload'
      make_env
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf '{"lockfileVersion":3,"n":%s}\n' "$n" > package-lock.json
printf ' WARN  The "pnpm" field in package.json is no longer read by pnpm\n' >&2
SH
      through_apply
      When call drv_jq '{install_signals}' score --work "$WORK"
      The status should be success
      The output should equal '{"install_signals":["pnpm_field_no_longer_read"]}'
    End

    # `cmd_apply` writes `override_scope` and `apply_result` three statements
    # apart. A run interrupted in that window leaves the first present — so the
    # `state_get` guard does not fire — and the second absent. Read as a null
    # value, `null.written` is `null` rather than an error, so `score` emitted
    # `status: "ready_for_pr"` with `written: []`, `override_file: null` and
    # `observations: []` at exit 0: a PR-ready verdict naming no edit at all.
    Describe 'a state write interrupted between override_scope and apply_result'
      Parameters
        apply_result       'del(.apply_result)'
        validate           'del(.validate)'
        observations_first 'del(.observations_first)'
        applied_parents    'del(.applied_parents) | del(.eligible_parents)'
      End

      It "refuses to report ready_for_pr when $1 was never written"
        make_env
        through_apply
        jq -c "$2" "$WORK/state.json" > "$WORK/s.tmp"
        mv "$WORK/s.tmp" "$WORK/state.json"
        When call drv_jq '{has_error: has("error"), s: .status}' score --work "$WORK"
        The status should equal 1
        The output should equal '{"has_error":true,"s":null}'
        The stderr should include 'no usable value'
      End
    End

    It 'never reports ready_for_pr carrying an empty written[]'
      make_env
      through_apply
      jq -c 'del(.apply_result)' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      "$DRIVER" score --work "$WORK" >"$TEST_DIR/out.json" 2>/dev/null || true
      When call grep -c 'ready_for_pr' "$TEST_DIR/out.json"
      The status should equal 1
      The output should equal '0'
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

  # `env_prefix` is prepended to every git, adapter and package-manager call,
  # composed AFTER any `cd`: it injects environment, it does not chdir. The
  # shim records both, so the log is the verdict on the composition as well as
  # on the reach.
  Describe 'env_prefix reaches every adapter, install and scorer call'
    prefixed_run() {
      make_env
      cat > "$BIN/prefix" <<'SH'
#!/bin/sh
printf '%s|%s\n' "$PWD" "$1" >> "$PREFIX_LOG"
exec "$@"
SH
      chmod +x "$BIN/prefix"
      PREFIX_LOG="$TEST_DIR/prefix.log"
      export PREFIX_LOG
      : > "$PREFIX_LOG"
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$MOCK" --scorer "$SCORER" \
        --env-prefix "$BIN/prefix" >/dev/null
      "$DRIVER" classify --work "$WORK" >/dev/null
      "$DRIVER" baseline --work "$WORK" >/dev/null
      "$DRIVER" apply --work "$WORK" >/dev/null
      "$DRIVER" score --work "$WORK" >/dev/null
    }

    # The `/fix|` half is the composition assertion: the logged cwd is the
    # worktree, so the prefix ran AFTER the `cd` rather than instead of it.
    # (`git` locates itself with `-C` and needs no cd, so only its command is
    # asserted.)
    Describe 'every wrapped call'
      Parameters
        adapter-and-install  '/fix|MOCK'
        risk-scorer          '/fix|SCORER'
        git                  '|git'
      End

      It "prepends the prefix to $1"
        prefixed_run
        _want=$2
        case "$_want" in
          */fix\|MOCK)   _want="/fix|$MOCK" ;;
          */fix\|SCORER) _want="/fix|$SCORER" ;;
        esac
        When call grep -c -F -- "$_want" "$PREFIX_LOG"
        The status should be success
        The output should not equal '0'
      End
    End

    # A version comparison goes through the adapter too, so it takes the same
    # wrapping — and from inside the worktree.
    It 'wraps compare_versions from inside the worktree'
      make_env
      rv_versions 3 '[{"version":"4.17.10","path":"node_modules/lodash"},
                      {"version":"4.17.9","path":"node_modules/koa/node_modules/lodash"}]'
      cat > "$BIN/prefix" <<'SH'
#!/bin/sh
printf '%s|%s\n' "$PWD" "$*" >> "$PREFIX_LOG"
exec "$@"
SH
      chmod +x "$BIN/prefix"
      PREFIX_LOG="$TEST_DIR/prefix.log"
      export PREFIX_LOG
      : > "$PREFIX_LOG"
      "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
        --default-branch main --adapter "$MOCK" --scorer "$SCORER" \
        --env-prefix "$BIN/prefix" >/dev/null
      "$DRIVER" classify --work "$WORK" >/dev/null
      "$DRIVER" baseline --work "$WORK" >/dev/null
      "$DRIVER" apply --work "$WORK" >/dev/null
      "$DRIVER" score --work "$WORK" >/dev/null
      When call grep -c -F -- "/fix|$MOCK compare_versions" "$PREFIX_LOG"
      The status should be success
      The output should not equal '0'
    End

    It 'never composes the prefix in front of the cd'
      prefixed_run
      When call grep -c -e '|cd' "$PREFIX_LOG"
      The status should equal 1
      The output should equal '0'
    End
  End
End
