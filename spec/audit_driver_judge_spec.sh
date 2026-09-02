#!/bin/sh
# shellcheck shell=sh
# audit-pins-driver.sh `judge` and `together` — phases 5 and 7 of the pin audit
# (#42, #46, #48, #79, #81, #174).
#
# The advisory lookup is mocked with a scratch executable serving canned
# verdicts, so no example reaches the network; the adapter is mocked the same
# way as in spec/audit_driver_spec.sh. Findings are seeded into the state file
# rather than produced by a dozen `test-pin` calls: what these examples are
# about is the verdict each finding earns, and phase 4 has its own suite.
#
# Every example asserts a VERDICT: the exit code and the JSON the agent reads.

Describe 'audit-pins-driver.sh judge and together'
  DRIVER="$COMMON/audit-pins-driver.sh"
  After 'cleanup_fixture'

  # Deliberately a copy of the harness in spec/audit_driver_spec.sh rather than
  # a shared helper: shellspec files are self-contained, and each suite tunes
  # its mock differently.
  make_env() {
    TEST_DIR=$(mktemp -d)
    WORK="$TEST_DIR/work"
    WT="$WORK/audit"
    MOCK_DIR="$TEST_DIR/mock"
    MOCK_LOG="$TEST_DIR/argv.log"
    export MOCK_DIR MOCK_LOG
    mkdir -p "$WT" "$MOCK_DIR/adv" "$TEST_DIR/bin"
    : > "$MOCK_LOG"
    MOCK="$TEST_DIR/bin/adapter.sh"
    ADV="$TEST_DIR/bin/advisories.sh"
    PREFIX="$TEST_DIR/bin/prefix.sh"
    write_mock
    write_adv
    write_prefix
    defaults
    git -C "$WT" init -q -b main
    git -C "$WT" config user.email spec@example.invalid
    git -C "$WT" config user.name spec
    git -C "$WT" add -A
    git -C "$WT" -c commit.gpgsign=false commit -qm baseline
  }

  write_mock() {
    cat > "$MOCK" <<'SH'
#!/bin/sh
{ printf 'VERB %s\n' "$1"; for a in "$@"; do printf 'ARG %s\n' "$a"; done; } >> "$MOCK_LOG"
bump() {
  n=$(cat "$MOCK_DIR/$1.n" 2>/dev/null || echo 0)
  n=$((n + 1))
  printf '%s\n' "$n" > "$MOCK_DIR/$1.n"
  printf '%s' "$n"
}
verb=$1
shift
case "$verb" in
  list_pins)
    if [ -f "$MOCK_DIR/list_pins.override" ]; then cat "$MOCK_DIR/list_pins.override"; exit 0; fi
    jq --slurpfile mf package.json '
      (.override_root // ["overrides"]) as $root
      | .pins = [ .pins[] | . as $p | select(($mf[0] | getpath($root + $p.path)) != null) ]
      | .count = (.pins | length)
      | del(.override_root)' "$MOCK_DIR/list_pins.json"
    ;;
  detect) cat "$MOCK_DIR/detect.json" ;;
  resolved_versions)
    n=$(bump "rv-$1")
    if [ -f "$MOCK_DIR/rv-$1.$n.json" ]; then cat "$MOCK_DIR/rv-$1.$n.json"
    elif [ -f "$MOCK_DIR/rv-$1.json" ]; then cat "$MOCK_DIR/rv-$1.json"
    else cat "$MOCK_DIR/rv.json"; fi ;;
  resolution_map)
    n=$(bump map)
    st=0
    if [ -f "$MOCK_DIR/map.$n.status" ]; then st=$(cat "$MOCK_DIR/map.$n.status"); fi
    if [ "$st" != "0" ]; then printf '{"error":"resolution_map: refused"}\n' >&2; exit "$st"; fi
    if [ -f "$MOCK_DIR/map.$n.json" ]; then cat "$MOCK_DIR/map.$n.json"; else cat "$MOCK_DIR/map.json"; fi ;;
  install)
    n=$(bump install)
    if [ -f "$MOCK_DIR/install.sh" ]; then . "$MOCK_DIR/install.sh"; fi
    if [ -f "$MOCK_DIR/install.$n.status" ]; then exit "$(cat "$MOCK_DIR/install.$n.status")"; fi
    exit "$(cat "$MOCK_DIR/install.status" 2>/dev/null || echo 0)" ;;
  *) printf '{"error":"unknown verb"}\n' >&2; exit 1 ;;
esac
SH
    chmod +x "$MOCK"
  }

  write_adv() {
    cat > "$ADV" <<'SH'
#!/bin/sh
pkg=""
ver=""
while [ $# -gt 0 ]; do
  case "$1" in
    --adapter) shift 2 ;;
    --version) ver=$2; shift 2 ;;
    *) pkg=$1; shift ;;
  esac
done
printf 'ADV %s %s\n' "$pkg" "$ver" >> "$MOCK_LOG"
slug=$(printf '%s@%s' "$pkg" "$ver" | tr '/' '-')
f="$MOCK_DIR/adv/$slug.json"
[ -f "$f" ] || f="$MOCK_DIR/adv/default.json"
st=0
[ ! -f "$MOCK_DIR/adv/$slug.status" ] || st=$(cat "$MOCK_DIR/adv/$slug.status")
cat "$f"
exit "$st"
SH
    chmod +x "$ADV"
  }

  # An opaque prefix that records the argv it wrapped and then runs it, which
  # is the only thing a caller may assume about one.
  write_prefix() {
    cat > "$PREFIX" <<'SH'
#!/bin/sh
printf 'PREFIX %s\n' "$1" >> "$MOCK_LOG"
exec "$@"
SH
    chmod +x "$PREFIX"
  }

  defaults() {
    printf '%s\n' '{"name":"app","overrides":{"lodash":"^4.17.21","glob":{"minimatch":"^9.0.0"}}}' > "$WT/package.json"
    printf '{"lockfileVersion":3}\n' > "$WT/package-lock.json"
    cat > "$MOCK_DIR/list_pins.json" <<'JSON'
{"pm":"npm","override_location":"overrides","override_file":"package.json",
 "block_present":true,"count":2,"bare_count":1,"override_root":["overrides"],
 "pins":[
   {"key":"lodash","path":["lodash"],"package":"lodash","parents":[],"scope":"bare",
    "value":"^4.17.21","kind":"range","selector":null,"range":"^4.17.21",
    "alias_package":null,"alias_range":null},
   {"key":"glob","path":["glob","minimatch"],"package":"minimatch","parents":["glob"],
    "scope":"scoped","value":"^9.0.0","kind":"range","selector":null,"range":"^9.0.0",
    "alias_package":null,"alias_range":null}]}
JSON
    cat > "$MOCK_DIR/detect.json" <<'JSON'
{"pm":"npm","pm_exec":"npm","lockfile":"package-lock.json","install_cmd":"npm install",
 "why_cmd":"npm explain","override_location":"overrides","override_file":"package.json",
 "override_syntax":"nested","supports_scoping":true}
JSON
    cat > "$MOCK_DIR/rv.json" <<'JSON'
{"pm":"npm","package":"x","present":true,"count":1,
 "versions":[{"version":"1.0.0","path":"node_modules/x"}],"lockfile_entries":4}
JSON
    cat > "$MOCK_DIR/map.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
    adv_verdict default safe 3 '[]'
  }

  # $1 slug (or `default`), $2 verdict, $3 advisory_count, $4 matched_ranges
  adv_verdict() {
    cat > "$MOCK_DIR/adv/$1.json" <<JSON
{"package":"p","ecosystem":"npm","advisory_count":$3,"withdrawn_excluded":0,
 "vulnerable_ranges":["<1.0.0"],"advisories":[],"version":"v",
 "matched_ranges":$4,"unevaluated_ranges":[],"adapter_errors":[],"verdict":"$2"}
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

  do_list() {
    "$DRIVER" list --work "$WORK" --worktree "$WT" --adapter "$MOCK" \
      --advisories "$ADV" "$@" >/dev/null
  }

  do_baseline() { "$DRIVER" baseline --work "$WORK" >/dev/null; }

  # A glob loop rather than `ls | wc -l`: no subshell, no external command, and
  # nothing for a quoting rule to object to.
  count_cache_tmp() {
    _n=0
    for _f in "$WORK"/advisories/*.tmp; do
      [ -e "$_f" ] && _n=$((_n + 1))
    done
    printf '%s\n' "$_n"
  }

  seed_findings() {
    jq --argjson f "$1" '.findings = $f' "$WORK/state.json" > "$WORK/s.tmp"
    mv "$WORK/s.tmp" "$WORK/state.json"
  }

  # One tested finding on `lodash`, delta `["4.17.19"]`, nothing else moved.
  one_tested() {
    seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
      "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
      "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19","4.17.21"],
      "attributable_versions":["4.17.19"],"sibling_pins":[],
      "collateral_changes":[],"collateral_verdict":null,"sampled_families":[],
      "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
      "matched_ranges":[]}]'
  }

  prepare() { make_env; do_list; do_baseline; }

  # -------------------------------------------------------------------------
  Describe 'judge (phase 5)'
    # The four verdicts, mapped exactly as the definition's table says.
    # `no-advisories` is NOT a synonym for safe: a pin may exist for a reason
    # that was never a security advisory, and a wrong package name or ecosystem
    # produces the same empty answer.
    Describe 'the advisory verdict table'
      Parameters
        safe          removable
        vulnerable    still-required
        unknown       inconclusive
        no-advisories inconclusive
      End

      It "routes a $1 verdict to $2"
        prepare
        one_tested
        adv_verdict 'lodash@4.17.19' "$1" 4 '["<4.17.20"]'
        When call drv_jq '[.findings[].status]' judge --work "$WORK"
        The status should be success
        The output should equal "[\"$2\"]"
      End

      # `advisory_verdict` carries the script's own word, never the status it
      # routed to: `inconclusive` is not a value check-advisories.sh emits, so
      # collapsing onto it loses the difference between `unknown` (a range
      # could not be read) and `no-advisories` (the query returned nothing).
      It "carries the $1 verdict through verbatim, with the advisory count"
        prepare
        one_tested
        adv_verdict 'lodash@4.17.19' "$1" 4 '["<4.17.20"]'
        When call drv_jq '{av: .findings[0].advisory_verdict, ac: .findings[0].advisory_count}' \
          judge --work "$WORK"
        The status should be success
        The output should equal "{\"av\":\"$1\",\"ac\":4}"
      End
    End

    # `advisory_count` is the package's advisory total and does not vary by
    # version, so the FIRST answer is the verbatim value the result contract
    # promises. A `max` across the delta is a synthesis of several readings of
    # one number, and the two only tell themselves apart when the readings
    # disagree — which is what this delta arranges.
    It 'carries the first advisory_count verbatim, never the largest of them'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19","4.16.0"],
        "attributable_versions":["4.17.19","4.16.0"],"sibling_pins":[],
        "collateral_changes":[],"collateral_verdict":null,"sampled_families":[],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      adv_verdict 'lodash@4.17.19' safe 2 '[]'
      adv_verdict 'lodash@4.16.0' safe 9 '[]'
      When call drv_jq '.findings[0].advisory_count' judge --work "$WORK"
      The status should be success
      The output should equal '2'
    End

    # A pin is removable only when EVERY version in the delta comes back safe.
    # One version short of that makes the whole pin still-required or
    # inconclusive; there is no partial removal.
    It 'keeps the pin still-required when one delta version of several matches'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19","4.16.0"],
        "attributable_versions":["4.17.19","4.16.0"],"sibling_pins":[],
        "collateral_changes":[],"collateral_verdict":null,"sampled_families":[],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      adv_verdict 'lodash@4.17.19' safe 4 '[]'
      adv_verdict 'lodash@4.16.0' vulnerable 4 '["<4.17.20"]'
      When call drv_jq '{s: .findings[0].status, m: .findings[0].matched_ranges}' judge --work "$WORK"
      The status should be success
      The output should equal '{"s":"still-required","m":["<4.17.20"]}'
    End

    # A non-zero exit from check-advisories.sh is not a verdict.
    It 'fails phase advisories on a non-zero exit from the advisory lookup'
      prepare
      one_tested
      printf '1\n' > "$MOCK_DIR/adv/lodash@4.17.19.status"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'never read as an absence of advisories'
    End

    # `unknown` with a non-empty adapter_errors[] describes the TOOLING and not
    # the package, and every pin after it inherits the same broken adapter. It
    # is not the honest-unknown verdict the table routes to `inconclusive`.
    It 'fails phase advisories on unknown with a non-empty adapter_errors[]'
      prepare
      one_tested
      cat > "$MOCK_DIR/adv/lodash@4.17.19.json" <<'JSON'
{"package":"lodash","ecosystem":"npm","advisory_count":4,"withdrawn_excluded":0,
 "vulnerable_ranges":["<4.17.20"],"advisories":[],"version":"4.17.19",
 "matched_ranges":[],"unevaluated_ranges":["<4.17.20"],
 "adapter_errors":[{"range":"<4.17.20","status":1,"error":"node.sh: line 9: syntax error"}],
 "verdict":"unknown"}
JSON
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'describes the tooling and not the package'
    End

    # The same contract discipline the adapter verbs get, applied to the one
    # script whose answer becomes the removal recommendation. Read straight, an
    # absent `adapter_errors` arrives as the string "null", whose `// []`
    # default is indistinguishable from an empty one — and that default is the
    # test standing between a broken adapter and an audit of `inconclusive`
    # verdicts with nothing naming the cause.
    Describe 'a promised check-advisories.sh field that is absent is a hard error'
      Parameters
        verdict
        advisory_count
        matched_ranges
        unevaluated_ranges
        adapter_errors
      End

      It "fails phase advisories naming an absent $1"
        prepare
        one_tested
        jq -c "del(.$1)" "$MOCK_DIR/adv/default.json" > "$MOCK_DIR/adv/lodash@4.17.19.json"
        When call drv_jq '{status, phase}' judge --work "$WORK"
        The status should equal 3
        The output should equal '{"status":"failure","phase":"advisories"}'
        The stderr should include "no '$1'"
      End
    End

    It 'fails when check-advisories.sh exits 0 with empty stdout'
      prepare
      one_tested
      : > "$MOCK_DIR/adv/lodash@4.17.19.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'is not a JSON object'
    End

    # `$WORK/advisories/` outlives the call that wrote it — test-pin and judge
    # are separate invocations — so a run killed mid-write leaves a half-object
    # for the next one. Read blind, it reaches `--argjson`, where jq dies exit 2
    # with NO stdout: this contract's own needs_judgment, carrying no decision
    # point at all.
    It 'fails the phase on a torn cache rather than dying exit 2 with no payload'
      prepare
      one_tested
      mkdir -p "$WORK/advisories"
      printf '{"verdict":"safe","advisory_c' > "$WORK/advisories/lodash@4.17.19.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'is not a JSON object'
      The stderr should include 'cached advisory answer'
    End

    It 'holds a cached answer to the same field contract as a fresh one'
      prepare
      one_tested
      mkdir -p "$WORK/advisories"
      jq -c 'del(.adapter_errors)' "$MOCK_DIR/adv/default.json" \
        > "$WORK/advisories/lodash@4.17.19.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include "carries no 'adapter_errors'"
    End

    It 'leaves no half-written cache entry behind'
      prepare
      one_tested
      "$DRIVER" judge --work "$WORK" >/dev/null
      When call count_cache_tmp
      The status should be success
      The output should equal '0'
    End

    # `check-advisories.sh` emits exactly four verdicts, plus a JSON null when
    # it was handed no version. Anything else fell through every verdict test
    # into a terminal `else "safe"` — a found-nothing default in the field that
    # decides whether a pin is deleted.
    It 'refuses a verdict outside the four the script emits'
      prepare
      one_tested
      jq -c '.verdict = "probably-fine"' "$MOCK_DIR/adv/default.json" \
        > "$MOCK_DIR/adv/lodash@4.17.19.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'not one of safe, vulnerable, unknown or no-advisories'
    End

    It 'refuses a null verdict rather than defaulting it to safe'
      prepare
      one_tested
      jq -c '.verdict = null' "$MOCK_DIR/adv/default.json" \
        > "$MOCK_DIR/adv/lodash@4.17.19.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'cannot be allowed to be a default'
    End

    It 'keeps an honest unknown as the inconclusive finding the table names'
      prepare
      one_tested
      cat > "$MOCK_DIR/adv/lodash@4.17.19.json" <<'JSON'
{"package":"lodash","ecosystem":"npm","advisory_count":4,"withdrawn_excluded":0,
 "vulnerable_ranges":["not a range"],"advisories":[],"version":"4.17.19",
 "matched_ranges":[],"unevaluated_ranges":["not a range"],
 "adapter_errors":[],"verdict":"unknown"}
JSON
      When call drv_jq '{s: .findings[0].status, d: .findings[0].detail}' judge --work "$WORK"
      The status should be success
      The output should equal '{"s":"inconclusive","d":"4.17.19: unknown [unreadable range: not a range]"}'
    End

    # An empty delta is its own finding, not a missing one, and the wording is
    # what stops the report implying the package was independently checked.
    It 'reports an empty delta removable, in the terms the definition sets'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.21"],
        "attributable_versions":[],"sibling_pins":[],
        "collateral_changes":[],"collateral_verdict":null,"sampled_families":[],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      When call drv_jq '{s: .findings[0].status, v: .findings[0].advisory_verdict, d: .findings[0].detail}' \
        judge --work "$WORK"
      The status should be success
      The output should include '"s":"removable"'
      The output should include '"v":null'
      The output should include 'nothing new resolved'
      The output should include 'sibling pin'
    End

    It 'asks the advisory database nothing when the delta is empty'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.21"],
        "attributable_versions":[],"sibling_pins":[],
        "collateral_changes":[],"collateral_verdict":null,"sampled_families":[],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      "$DRIVER" judge --work "$WORK" >/dev/null
      When call grep -c '^ADV ' "$MOCK_LOG"
      The status should equal 1
      The output should equal '0'
    End

    It 'reports a package that left the tree removable with no version judged'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":true,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":[],
        "attributable_versions":[],"sibling_pins":[],
        "collateral_changes":[],"collateral_verdict":null,"sampled_families":[],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      When call drv_jq '{s: .findings[0].status, d: .findings[0].detail}' judge --work "$WORK"
      The status should be success
      The output should include '"s":"removable"'
      The output should include 'no longer resolved at all'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'the collateral verdict'
    with_collateral() {
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19"],
        "attributable_versions":["4.17.19"],"sibling_pins":[],
        "collateral_changes":[{"package":"readable-stream","baseline":["3.6.2"],
          "without_pin":["2.3.8","3.6.2"],"newly_admitted":["2.3.8"],
          "judged":true,"represented_by":null,"family":null}],
        "collateral_verdict":null,"sampled_families":[],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
    }

    It 'judges each collateral version under that entry own package name'
      prepare
      with_collateral
      "$DRIVER" judge --work "$WORK" >/dev/null
      When call grep '^ADV ' "$MOCK_LOG"
      The status should be success
      The output should equal 'ADV lodash 4.17.19
ADV readable-stream 2.3.8'
    End

    # A vulnerable collateral makes the pin still-required even when its own
    # package came back clean, and the detail says so in those terms: naming the
    # package it is really holding is the finding.
    It 'turns a vulnerable collateral into still-required naming the other package'
      prepare
      with_collateral
      adv_verdict 'readable-stream@2.3.8' vulnerable 2 '["<3"]'
      When call drv_jq '{s: .findings[0].status, cv: .findings[0].collateral_verdict, d: .findings[0].detail}' \
        judge --work "$WORK"
      The status should be success
      The output should include '"s":"still-required"'
      The output should include '"cv":"vulnerable"'
      The output should include 'readable-stream 2.3.8'
      The output should include 'not required for lodash'
    End

    # `advisory_verdict`, `advisory_count` and `matched_ranges` come from
    # check-advisories.sh verbatim FOR THE TESTED PACKAGE; a collateral
    # package's result lives in `collateral_verdict` and is never folded into
    # them. Folded, a pin whose own delta came back `safe` reported
    # `advisory_verdict: "vulnerable"` with `matched_ranges: []` — "this
    # package is vulnerable, ranges unstated", which is exactly the wrong-place
    # reading `detail` exists to prevent.
    It 'never folds the collateral verdict into the tested package advisory fields'
      prepare
      with_collateral
      adv_verdict 'readable-stream@2.3.8' vulnerable 2 '["<3"]'
      When call drv_jq '{s: .findings[0].status, av: .findings[0].advisory_verdict, mr: .findings[0].matched_ranges, cv: .findings[0].collateral_verdict}' \
        judge --work "$WORK"
      The status should be success
      The output should equal '{"s":"still-required","av":"safe","mr":[],"cv":"vulnerable"}'
    End

    It 'keeps the tested package own verdict when a collateral turns it inconclusive'
      prepare
      with_collateral
      adv_verdict 'readable-stream@2.3.8' no-advisories 0 '[]'
      When call drv_jq '{s: .findings[0].status, av: .findings[0].advisory_verdict}' judge --work "$WORK"
      The status should be success
      The output should equal '{"s":"inconclusive","av":"safe"}'
    End

    It 'turns an unknown collateral into an inconclusive pin'
      prepare
      with_collateral
      adv_verdict 'readable-stream@2.3.8' no-advisories 0 '[]'
      When call drv_jq '{s: .findings[0].status, cv: .findings[0].collateral_verdict}' judge --work "$WORK"
      The status should be success
      The output should equal '{"s":"inconclusive","cv":"inconclusive"}'
    End

    It 'reports none when nothing else moved'
      prepare
      one_tested
      When call drv_jq '.findings[0].collateral_verdict' judge --work "$WORK"
      The status should be success
      The output should equal '"none"'
    End

    # `null` and `[]` are not interchangeable: one says nothing else moved, the
    # other says nobody looked (#48).
    It 'keeps not-checked, and scopes the verdict to the named package'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19"],
        "attributable_versions":["4.17.19"],"sibling_pins":[],
        "collateral_changes":null,"collateral_verdict":"not-checked","sampled_families":[],
        "whole_tree_view":false,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      When call drv_jq '{cv: .findings[0].collateral_verdict, d: .findings[0].detail}' judge --work "$WORK"
      The status should be success
      The output should include '"cv":"not-checked"'
      The output should include 'covers lodash only'
    End

    # `sampled-family` is the only verdict that stands for packages not
    # individually judged, so it says exactly how far the checking went.
    # Asserted through the rule that CONSUMES it: judge builds the collateral
    # detail out of this field, so a reason that stopped travelling would show
    # up as a verdict that says "no whole-tree view was available" for a parser
    # that refused this repository's lockfile.
    It 'reads the recorded reason into the collateral detail, rather than reconstructing one'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19"],
        "attributable_versions":["4.17.19"],"sibling_pins":[],
        "collateral_changes":null,"collateral_verdict":"not-checked",
        "collateral_not_checked_reason":"resolution_map refused this lockfile after removing lodash: parsed 0 entries",
        "sampled_families":[],"whole_tree_view":false,"advisory_verdict":null,
        "advisory_count":null,"matched_ranges":[]}]'
      When call drv_jq '.findings[0].detail' judge --work "$WORK"
      The status should be success
      The output should include 'covers lodash only'
      The output should include 'refused this lockfile'
      The output should include 'parsed 0 entries'
    End

    It 'reports sampled-family when a family stood for its members'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19"],
        "attributable_versions":["4.17.19"],"sibling_pins":[],
        "collateral_changes":[
          {"package":"@esbuild/darwin-arm64","baseline":["0.21.0"],"without_pin":["0.23.1"],
           "newly_admitted":["0.23.1"],"judged":true,"represented_by":null,
           "family":{"key":"@esbuild/","size":2,"members":["@esbuild/darwin-arm64","@esbuild/linux-x64"],
                     "sample":"@esbuild/darwin-arm64","shared_version":"0.23.1"}},
          {"package":"@esbuild/linux-x64","baseline":["0.21.0"],"without_pin":["0.23.1"],
           "newly_admitted":["0.23.1"],"judged":false,"represented_by":"@esbuild/darwin-arm64",
           "family":{"key":"@esbuild/","size":2,"members":["@esbuild/darwin-arm64","@esbuild/linux-x64"],
                     "sample":"@esbuild/darwin-arm64","shared_version":"0.23.1"}}],
        "collateral_verdict":null,
        "sampled_families":[{"key":"@esbuild/","size":2,"members":["@esbuild/darwin-arm64","@esbuild/linux-x64"],
                             "sample":"@esbuild/darwin-arm64","shared_version":"0.23.1"}],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      "$DRIVER" judge --work "$WORK" > "$TEST_DIR/judge.json"
      When call jq -c '{cv: .findings[0].collateral_verdict, adv: [inputs] }' "$TEST_DIR/judge.json"
      The status should be success
      The output should include '"cv":"sampled-family"'
    End

    It 'queries only the sampled member, never every member of the family'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "resolved_with_pin":["4.17.21"],"resolved_without_pin":["4.17.19"],
        "attributable_versions":["4.17.19"],"sibling_pins":[],
        "collateral_changes":[
          {"package":"@esbuild/darwin-arm64","baseline":["0.21.0"],"without_pin":["0.23.1"],
           "newly_admitted":["0.23.1"],"judged":true,"represented_by":null,
           "family":{"key":"@esbuild/","size":2,"members":["@esbuild/darwin-arm64","@esbuild/linux-x64"],
                     "sample":"@esbuild/darwin-arm64","shared_version":"0.23.1"}},
          {"package":"@esbuild/linux-x64","baseline":["0.21.0"],"without_pin":["0.23.1"],
           "newly_admitted":["0.23.1"],"judged":false,"represented_by":"@esbuild/darwin-arm64",
           "family":{"key":"@esbuild/","size":2,"members":["@esbuild/darwin-arm64","@esbuild/linux-x64"],
                     "sample":"@esbuild/darwin-arm64","shared_version":"0.23.1"}}],
        "collateral_verdict":null,
        "sampled_families":[{"key":"@esbuild/","size":2,"members":["@esbuild/darwin-arm64","@esbuild/linux-x64"],
                             "sample":"@esbuild/darwin-arm64","shared_version":"0.23.1"}],
        "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
        "matched_ranges":[]}]'
      "$DRIVER" judge --work "$WORK" >/dev/null
      When call grep '^ADV @esbuild' "$MOCK_LOG"
      The status should be success
      The output should equal 'ADV @esbuild/darwin-arm64 0.23.1'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'the sibling rule'
    two_on_one_package() {
      seed_findings '[
        {"key":"eslint","path":["eslint","minimatch"],"package":"minimatch","scope":"scoped",
         "value":"^3.1.5","status":"tested","tested":true,"left_tree":false,
         "resolved_with_pin":["3.1.5"],"resolved_without_pin":["3.1.5"],
         "attributable_versions":[],"sibling_pins":[],"collateral_changes":[],
         "collateral_verdict":null,"sampled_families":[],"whole_tree_view":true,
         "advisory_verdict":null,"advisory_count":null,"matched_ranges":[]},
        {"key":"glob","path":["glob","minimatch"],"package":"minimatch","scope":"scoped",
         "value":"^3.1.5","status":"tested","tested":true,"left_tree":false,
         "resolved_with_pin":["3.1.5"],"resolved_without_pin":["3.1.5"],
         "attributable_versions":[],"sibling_pins":[],"collateral_changes":[],
         "collateral_verdict":null,"sampled_families":[],"whole_tree_view":true,
         "advisory_verdict":null,"advisory_count":null,"matched_ranges":[]}]'
    }

    # One pin at a time proves each pin removable ON ITS OWN; it proves nothing
    # about a set. A reader who deletes all of them has not performed N tested
    # operations, they have performed one untested one.
    It 'downgrades two removable pins on one package to removable-individually'
      prepare
      two_on_one_package
      When call drv_jq '{s: [.findings[].status], sib: [.findings[].sibling_pins]}' judge --work "$WORK"
      The status should be success
      The output should equal '{"s":["removable-individually","removable-individually"],"sib":[["glob"],["eslint"]]}'
    End

    It 'keeps the plain removable status for a single pin on a package'
      prepare
      one_tested
      When call drv_jq '{s: [.findings[].status], sib: [.findings[].sibling_pins]}' judge --work "$WORK"
      The status should be success
      The output should equal '{"s":["removable"],"sib":[[]]}'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'together (phase 7)'
    # Seeding findings stands in for a completed `judge`, so it sets the flag
    # `judge` sets. The guard itself is asserted below.
    mark_judged() {
      jq -c '.judge_done = true' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
    }

    seed_two_removable() {
      seed_findings '[
        {"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare","value":"^4.17.21",
         "status":"removable-individually","sibling_pins":["other"]},
        {"key":"glob","path":["glob","minimatch"],"package":"minimatch","scope":"scoped",
         "value":"^9.0.0","status":"removable","sibling_pins":[]}]'
      mark_judged
    }

    # Nothing was found removable, so there is nothing to open a PR about, and
    # that is a complete answer rather than a failure.
    It 'reports an empty candidate set as no removable pins found'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash",
        "status":"still-required","sibling_pins":[]}]'
      mark_judged
      When call drv_jq '{status, pr_skipped_reason}' together --work "$WORK"
      The status should be success
      The output should equal '{"status":"no_candidates","pr_skipped_reason":"no removable pins found"}'
    End

    # Every diff is measured against the baseline map, so a partial baseline
    # makes BOTH attempts unmeasurable rather than one of them.
    It 'runs no attempt at all when the baseline map was partial'
      make_env
      do_list
      jq -c '.unreadable_entries = 2' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      do_baseline
      seed_two_removable
      When call drv_jq '{status, pr_skipped_reason}' together --work "$WORK"
      The status should be success
      The output should equal '{"status":"partial_map","pr_skipped_reason":"partial resolution map"}'
    End

    It 'installs nothing when the baseline map was partial'
      make_env
      do_list
      jq -c '.unreadable_entries = 2' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      do_baseline
      seed_two_removable
      "$DRIVER" together --work "$WORK" >/dev/null
      When call cat "$MOCK_DIR/install.n"
      The status should be success
      The output should equal '1'
    End

    # Attempt 1 is the maximal set: it includes the individually-tested pins as
    # well, because the whole point of installing them together is to settle the
    # sibling question that made them individual in the first place.
    It 'takes every removable and removable-individually pin into attempt 1'
      prepare
      seed_two_removable
      When call drv_jq '{status, attempt, keys: .removed_keys, lb: .left_behind}' together --work "$WORK"
      The status should be success
      The output should equal '{"status":"ready_for_pr","attempt":1,"keys":["lodash","glob"],"lb":[]}'
    End

    It 'leaves the passing attempt removals in the tree for phase 8 to commit'
      prepare
      seed_two_removable
      "$DRIVER" together --work "$WORK" >/dev/null
      When call jq -c '.overrides' "$WT/package.json"
      The status should be success
      The output should equal 'null'
    End

    # Attempt 2 drops every pin whose finding was removable-individually,
    # keeping the pins that were the sole removable pin on their package.
    It 'narrows to the removable pins only when attempt 1 comes back dirty'
      prepare
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.19"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
      adv_verdict 'lodash@4.17.19' vulnerable 4 '["<4.17.20"]'
      seed_two_removable
      When call drv_jq '{status, attempt, keys: .removed_keys, lb: [.left_behind[].key]}' \
        together --work "$WORK"
      The status should be success
      The output should equal '{"status":"ready_for_pr","attempt":2,"keys":["glob"],"lb":["lodash"]}'
    End

    It 'restores the tree between the attempts so attempt 2 measures itself'
      prepare
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.19"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
      adv_verdict 'lodash@4.17.19' vulnerable 4 '["<4.17.20"]'
      seed_two_removable
      "$DRIVER" together --work "$WORK" >/dev/null
      When call jq -c '.overrides' "$WT/package.json"
      The status should be success
      The output should equal '{"lodash":"^4.17.21"}'
    End

    It 'reports both attempts failing as a finding, not a failure'
      prepare
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.4"],"express":["4.18.2"]}}
JSON
      cp "$MOCK_DIR/map.2.json" "$MOCK_DIR/map.3.json"
      adv_verdict 'minimatch@9.0.4' vulnerable 1 '["<9.0.5"]'
      seed_two_removable
      When call drv_jq '{status, attempt, pr_skipped_reason}' together --work "$WORK"
      The status should be success
      The output should equal '{"status":"combined_failed","attempt":2,"pr_skipped_reason":"combined test failed"}'
    End

    # An empty attempt-2 set is still `combined test failed`, with the detail
    # saying both which attempt ran and why the second set was empty.
    It 'says the attempt 2 set was empty when every finding carried sibling ambiguity'
      prepare
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.19"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
      adv_verdict 'lodash@4.17.19' vulnerable 4 '["<4.17.20"]'
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"removable-individually","sibling_pins":["other"]}]'
      mark_judged
      When call drv_jq '{status, pr_skipped_reason, d: .pr_skipped_detail}' together --work "$WORK"
      The status should be success
      The output should include '"pr_skipped_reason":"combined test failed"'
      The output should include 'attempt 2 set was empty'
      The output should include 'lodash 4.17.19'
    End

    # An install that did not finish is a fact about the ENVIRONMENT, so it ends
    # the run rather than falling through to a narrower PR nobody asked for.
    It 'ends the run on a combined install failure, phase compose, without attempt 2'
      prepare
      printf '1\n' > "$MOCK_DIR/install.2.status"
      seed_two_removable
      When call drv_jq '{status, phase}' together --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"compose"}'
      The stderr should include 'attempt 2 was not tried'
    End

    # Every equivalent path in test-pin restores before it fails; this one has
    # a commit at the end of it, so residue left here is residue phase 8 stages.
    It 'restores the tree when the candidate edit itself could not be made'
      prepare
      seed_two_removable
      printf 'not json at all\n' > "$WT/package.json"
      "$DRIVER" together --work "$WORK" >/dev/null 2>&1 || true
      When call git -C "$WT" diff --quiet HEAD -- package.json package-lock.json
      The status should be success
    End

    It 'reports that edit failure as phase compose, quoting jq'
      prepare
      seed_two_removable
      printf 'not json at all\n' > "$WT/package.json"
      When call drv_jq '{status, phase}' together --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"compose"}'
      The stderr should include 'could not be rewritten'
    End

    It 'fails phase compose when a candidate edit did not land'
      prepare
      jq -c 'del(.override_root)' "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/list_pins.override"
      seed_two_removable
      When call drv_jq '{status, phase}' together --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"compose"}'
      The stderr should include 'still carries the candidate key'
    End

    # Before `judge` runs every finding still carries status "tested", so the
    # candidate set is empty and this step would terminate exit 0 with
    # "no removable pins found" — a claim about work that never happened,
    # which the agent reports as a successful audit.
    It 'refuses to run before judge, rather than reporting no removable pins'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "attributable_versions":["4.17.19"],"sibling_pins":[]}]'
      When run script "$DRIVER" together --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include "run 'judge' first"
    End

    It 'installs nothing when judge has not run'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"tested","tested":true,"left_tree":false,
        "attributable_versions":["4.17.19"],"sibling_pins":[]}]'
      "$DRIVER" together --work "$WORK" >/dev/null 2>&1 || true
      When call cat "$MOCK_DIR/install.n"
      The status should be success
      The output should equal '1'
    End

    # With no `removable-individually` finding attempt 2's set IS attempt 1's,
    # so running it would reinstall the set that just came back dirty and
    # report the same failure as `attempt: 2` — an install spent proving the
    # first one again, under a number that says a narrowing happened.
    It 'runs no second attempt when narrowing has nothing to drop'
      prepare
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.19"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
      adv_verdict 'lodash@4.17.19' vulnerable 4 '["<4.17.20"]'
      seed_findings '[
        {"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare","value":"^4.17.21",
         "status":"removable","sibling_pins":[]},
        {"key":"glob","path":["glob","minimatch"],"package":"minimatch","scope":"scoped",
         "value":"^9.0.0","status":"removable","sibling_pins":[]}]'
      mark_judged
      When call drv_jq '{status, attempt, d: .pr_skipped_detail}' together --work "$WORK"
      The status should be success
      The output should include '"attempt":1'
      The output should include 'narrowing had nothing to drop'
    End

    It 'spends only one combined install when narrowing has nothing to drop'
      prepare
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.19"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
      adv_verdict 'lodash@4.17.19' vulnerable 4 '["<4.17.20"]'
      seed_findings '[
        {"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare","value":"^4.17.21",
         "status":"removable","sibling_pins":[]},
        {"key":"glob","path":["glob","minimatch"],"package":"minimatch","scope":"scoped",
         "value":"^9.0.0","status":"removable","sibling_pins":[]}]'
      mark_judged
      "$DRIVER" together --work "$WORK" >/dev/null
      When call cat "$MOCK_DIR/install.n"
      The status should be success
      The output should equal '2'
    End

    # `restore_tree` reads this key with state_get + state_ok and dies on an
    # unreadable one; the ready_for_pr payload carries the same name into phase
    # 8, which stages the removal commit by it.
    It 'refuses to hand phase 8 an unreadable lockfile name'
      prepare
      seed_two_removable
      jq -c 'del(.lockfile)' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      When run script "$DRIVER" together --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include 'no usable value'
    End

    # A partial view of the tree fails the attempt closed, never into a PR.
    It 'fails an attempt closed on a partial map rather than opening a PR'
      prepare
      printf '1\n' > "$MOCK_DIR/map.2.status"
      printf '1\n' > "$MOCK_DIR/map.3.status"
      seed_two_removable
      When call drv_jq '{status, pr_skipped_reason}' together --work "$WORK"
      The status should be success
      The output should equal '{"status":"combined_failed","pr_skipped_reason":"partial resolution map"}'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'the opaque env_prefix'
    # It is prepended verbatim to every adapter and advisory invocation, and
    # composed AFTER the `cd`: it injects environment, it does not chdir.
    It 'wraps the adapter and the advisory lookup alike'
      make_env
      do_list --env-prefix "$PREFIX"
      do_baseline
      one_tested
      "$DRIVER" judge --work "$WORK" >/dev/null
      When call sort -u "$MOCK_LOG"
      The status should be success
      The output should include "PREFIX $MOCK"
      The output should include "PREFIX $ADV"
    End

    It 'runs everything bare when no prefix was given'
      prepare
      one_tested
      "$DRIVER" judge --work "$WORK" >/dev/null
      When call grep -c '^PREFIX ' "$MOCK_LOG"
      The status should equal 1
      The output should equal '0'
    End

    It 'accepts an explicitly empty prefix as no prefix'
      make_env
      When call drv_jq '.status' list --work "$WORK" --worktree "$WT" \
        --adapter "$MOCK" --advisories "$ADV" --env-prefix ''
      The status should be success
      The output should equal '"ok"'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'the state file is never read optimistically'
    It 'refuses a truncated state file rather than acting on empty strings'
      prepare
      : > "$WORK/state.json"
      When run script "$DRIVER" judge --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include 'not a readable JSON object'
    End

    # `.path` is an ARRAY, and jq's `index` with an array argument searches for
    # a subsequence of ELEMENTS, not for an element equal to that array, so the
    # predicate held for every entry and this field named every pin — fully
    # judged ones included — while the report treats it as authoritative.
    It 'lists only the pins no test-pin call covered'
      prepare
      one_tested
      When call drv_jq '.untested' judge --work "$WORK"
      The status should be success
      The output should equal '[{"key":"glob","path":["glob","minimatch"],"package":"minimatch"}]'
    End

    It 'lists nothing when every testable pin was covered'
      prepare
      seed_findings '[
        {"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare","value":"^4.17.21",
         "status":"tested","tested":true,"left_tree":false,"resolved_with_pin":["4.17.21"],
         "resolved_without_pin":["4.17.21"],"attributable_versions":[],"sibling_pins":[],
         "collateral_changes":[],"collateral_verdict":null,"sampled_families":[],
         "whole_tree_view":true,"advisory_verdict":null,"advisory_count":null,
         "matched_ranges":[]},
        {"key":"glob","path":["glob","minimatch"],"package":"minimatch","scope":"scoped",
         "value":"^9.0.0","status":"tested","tested":true,"left_tree":false,
         "resolved_with_pin":["9.0.5"],"resolved_without_pin":["9.0.5"],
         "attributable_versions":[],"sibling_pins":[],"collateral_changes":[],
         "collateral_verdict":null,"sampled_families":[],"whole_tree_view":true,
         "advisory_verdict":null,"advisory_count":null,"matched_ranges":[]}]'
      When call drv_jq '.untested' judge --work "$WORK"
      The status should be success
      The output should equal '[]'
    End

    It 'refuses judge before baseline has run'
      make_env
      do_list
      When run script "$DRIVER" judge --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include "run 'baseline' first"
    End

    # `baseline` writes findings of its own — the pins it refused on a
    # present: false — so a healthy repository has findings: [] the moment it
    # finishes, and baseline -> judge -> together with no test-pin at all used
    # to answer "no removable pins found" at exit 0: the identical false claim
    # the together guard exists to stop, reached by the route it did not cover.
    # `baseline` refuses every pin whose package answers present: false and
    # `test-pin` then dies for those by design, so counting all testable pins
    # deadlocked a repository where the baseline refused every one: judge said
    # run test-pin, every test-pin refused, and there was no route to a report.
    It 'reports rather than deadlocking when the baseline refused every pin'
      make_env
      do_list
      jq -c '.present = false | .versions = []' "$MOCK_DIR/rv.json" > "$MOCK_DIR/rv-lodash.json"
      cp "$MOCK_DIR/rv-lodash.json" "$MOCK_DIR/rv-minimatch.json"
      do_baseline
      When call drv_jq '{status, s: [.findings[].status], u: [.untested[].key]}' judge --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","s":["inconclusive","inconclusive"],"u":[]}'
    End

    # A repository whose every pin is a non-range kind has count > 0 and an
    # empty test_order: audited, nothing testable, nothing removable.
    It 'reaches no removable pins found when nothing was a version pin at all'
      make_env
      jq -c '.pins = [ .pins[] | .kind = "protocol" ]' "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/list_pins.json"
      do_list
      do_baseline
      "$DRIVER" judge --work "$WORK" >/dev/null
      When call drv_jq '{status, pr_skipped_reason}' together --work "$WORK"
      The status should be success
      The output should equal '{"status":"no_candidates","pr_skipped_reason":"no removable pins found"}'
    End

    It 'refuses judge when phase 2 found testable pins and none was tested'
      prepare
      When run script "$DRIVER" judge --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include "run 'test-pin' first"
      The stderr should include 'examined nothing'
    End

    It 'never reaches no removable pins found without a single test-pin call'
      prepare
      "$DRIVER" judge --work "$WORK" >/dev/null 2>&1 || true
      When run script "$DRIVER" together --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include "run 'judge' first"
    End

    # `judge_done` is not a one-way latch: a test-pin after it writes a finding
    # that is `tested` again, and `together` selects on status, so the pin
    # would be dropped from a candidate set the agent believes is complete.
    # `baseline`'s bulk write to `findings` was the one that did not clear the
    # flag, so a second baseline after a completed judgment reset the findings
    # to its own refused set while `judge_done` stayed true — the guard passed,
    # the candidate set was empty, and `no removable pins found` was reported
    # over an audit whose results had just been discarded.
    It 'invalidates a judgment that a later baseline discarded'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"removable","sibling_pins":[]}]'
      jq -c '.judge_done = true' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      do_baseline
      When run script "$DRIVER" together --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include "run 'judge' first"
    End

    It 'invalidates a judgment that a later test-pin overtook'
      prepare
      seed_findings '[{"key":"lodash","path":["lodash"],"package":"lodash","scope":"bare",
        "value":"^4.17.21","status":"removable","sibling_pins":[]}]'
      jq -c '.judge_done = true' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      "$DRIVER" test-pin --work "$WORK" --key glob >/dev/null
      When run script "$DRIVER" together --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include "run 'judge' first"
    End

    # `type == "array"` asserts the BOX. A `tested` finding whose
    # `attributable_versions` came back a string, an object or null is not
    # `[]`, so it skips the empty-delta arm, enters the advisory loop, and
    # `jq -r '.[]'` there errors: the heredoc feeds nothing, the loop body
    # never runs, `verdicts` stays `[]`, and `all` over an empty array is TRUE.
    # The pin earned `removable` with `advisory_verdict: "safe"` and **no
    # advisory query run at all** — the same headline rule inverted that
    # `rv_versions` shuts on the adapter's side, reached through the state file.
    Describe 'a delta that is not a list of versions never reaches a verdict'
      Parameters
        'a string' '"4.17.19"'
        'an object' '{"0":"4.17.19"}'
        'null'      'null'
        'a list of non-strings' '[{"version":"4.17.19"}]'
      End

      It "refuses attributable_versions that is $1"
        prepare
        one_tested
        jq -c --argjson v "$2" '.findings[0].attributable_versions = $v' "$WORK/state.json" \
          > "$WORK/s.tmp"
        mv "$WORK/s.tmp" "$WORK/state.json"
        When call drv_jq '{status, phase}' judge --work "$WORK"
        The status should equal 3
        The output should equal '{"status":"failure","phase":"advisories"}'
        The stderr should include 'not the shape the step that wrote it promised'
      End

      It "asks the advisory database nothing, and reports no verdict, for $1"
        prepare
        one_tested
        jq -c --argjson v "$2" '.findings[0].attributable_versions = $v' "$WORK/state.json" \
          > "$WORK/s.tmp"
        mv "$WORK/s.tmp" "$WORK/state.json"
        "$DRIVER" judge --work "$WORK" >/dev/null 2>&1 || true
        When call jq -r '.findings[0].status' "$WORK/state.json"
        The status should be success
        The output should equal 'tested'
      End
    End

    # The twin, on the collateral side: a non-indexable collateral_changes left
    # the loop with nothing judged, and an empty verdict list collapses to
    # `safe` — the strongest claim available about packages nobody looked at.
    It 'refuses a collateral list that is not a list'
      prepare
      one_tested
      jq -c '.findings[0].collateral_changes = "moved"' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'not the shape the step that wrote it promised'
    End

    It 'refuses a collateral entry with no judged flag'
      prepare
      one_tested
      jq -c '.findings[0].collateral_changes =
               [{"package":"readable-stream","baseline":["3.6.2"],
                 "without_pin":["2.3.8"],"newly_admitted":["2.3.8"]}]' \
        "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'not the shape the step that wrote it promised'
    End

    It 'refuses a collateral list where nothing at all was judged'
      prepare
      one_tested
      jq -c '.findings[0].collateral_changes =
               [{"package":"readable-stream","baseline":["3.6.2"],
                 "without_pin":["2.3.8"],"newly_admitted":["2.3.8"],
                 "judged":false,"represented_by":"other","family":null}]' \
        "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'not one of them is marked judged'
    End

    # Validating that a state value is JSON says almost nothing: every jq read
    # of a parseable object yields JSON, `null` included. The shape the step
    # that wrote it promised is the thing worth asserting.
    It 'refuses a findings list that is not a list'
      prepare
      one_tested
      jq -c '.findings = "oops"' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      When call drv_jq '{status, phase}' judge --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"advisories"}'
      The stderr should include 'not the shape the step that wrote it promised'
    End


    It 'refuses a state file with no usable worktree'
      prepare
      jq -c '.worktree = ""' "$WORK/state.json" > "$WORK/s.tmp"
      mv "$WORK/s.tmp" "$WORK/state.json"
      When run script "$DRIVER" judge --work "$WORK"
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include 'no usable value'
    End

    It 'refuses test-pin before baseline has run'
      make_env
      do_list
      When run script "$DRIVER" test-pin --work "$WORK" --key lodash
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include "run 'baseline' first"
    End

    # A manifest key is not unique — npm nests several entries under one — so an
    # ambiguous --key is refused rather than resolved by position.
    It 'refuses an ambiguous --key instead of picking one'
      make_env
      printf '%s\n' '{"name":"app","overrides":{"rimraf":{".":"^5.0.0","glob":"^10.3.0"}}}' > "$WT/package.json"
      cat > "$MOCK_DIR/list_pins.json" <<'JSON'
{"pm":"npm","override_location":"overrides","override_file":"package.json",
 "block_present":true,"count":2,"bare_count":1,"override_root":["overrides"],
 "pins":[
   {"key":"rimraf","path":["rimraf","."],"package":"rimraf","parents":[],"scope":"bare",
    "value":"^5.0.0","kind":"range","selector":null,"range":"^5.0.0",
    "alias_package":null,"alias_range":null},
   {"key":"rimraf","path":["rimraf","glob"],"package":"glob","parents":["rimraf"],
    "scope":"scoped","value":"^10.3.0","kind":"range","selector":null,"range":"^10.3.0",
    "alias_package":null,"alias_range":null}]}
JSON
      git -C "$WT" add -A
      git -C "$WT" -c commit.gpgsign=false commit -qm dup-keys
      do_list
      do_baseline
      When run script "$DRIVER" test-pin --work "$WORK" --key rimraf
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include 'does not identify one'
    End

    It 'takes the pin by --path when the key is ambiguous'
      make_env
      printf '%s\n' '{"name":"app","overrides":{"rimraf":{".":"^5.0.0","glob":"^10.3.0"}}}' > "$WT/package.json"
      cat > "$MOCK_DIR/list_pins.json" <<'JSON'
{"pm":"npm","override_location":"overrides","override_file":"package.json",
 "block_present":true,"count":2,"bare_count":1,"override_root":["overrides"],
 "pins":[
   {"key":"rimraf","path":["rimraf","."],"package":"rimraf","parents":[],"scope":"bare",
    "value":"^5.0.0","kind":"range","selector":null,"range":"^5.0.0",
    "alias_package":null,"alias_range":null},
   {"key":"rimraf","path":["rimraf","glob"],"package":"glob","parents":["rimraf"],
    "scope":"scoped","value":"^10.3.0","kind":"range","selector":null,"range":"^10.3.0",
    "alias_package":null,"alias_range":null}]}
JSON
      git -C "$WT" add -A
      git -C "$WT" -c commit.gpgsign=false commit -qm dup-keys
      do_list
      do_baseline
      cat > "$MOCK_DIR/install.sh" <<'SH'
cp package.json "$MOCK_DIR/manifest-at-install.json"
SH
      "$DRIVER" test-pin --work "$WORK" --path '["rimraf","glob"]' >/dev/null
      When call jq -c '.overrides' "$MOCK_DIR/manifest-at-install.json"
      The status should be success
      The output should equal '{"rimraf":{".":"^5.0.0"}}'
    End
  End
End
