#!/bin/sh
# shellcheck shell=sh
# audit-pins-driver.sh `list`, `baseline` and `test-pin` — phases 2 and 4 of
# the pin audit (#42, #44, #46, #48, #79, #159, #174).
#
# The adapter and `check-advisories.sh` are both mocked with scratch
# executables: specs never hit the network and never run an install (root
# CLAUDE.md). The adapter's `list_pins` mock is deliberately NOT a canned
# answer — it recomputes the pin list from the manifest on disk, so the
# driver's own jq removal is what the count-minus-one verification is checked
# against. A spec that canned both sides would assert the driver against
# itself.
#
# Every example asserts a VERDICT: the exit code and the JSON the agent reads,
# never the parse that produced it.

Describe 'audit-pins-driver.sh list, baseline and test-pin'
  DRIVER="$COMMON/audit-pins-driver.sh"
  After 'cleanup_fixture'

  # Deliberately a copy of the harness in spec/audit_driver_judge_spec.sh
  # rather than a shared helper: shellspec files are self-contained, and each
  # suite tunes its mock differently.
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
    write_mock
    write_adv
    defaults
    commit_tree
  }

  commit_tree() {
    git -C "$WT" init -q -b main
    git -C "$WT" config user.email spec@example.invalid
    git -C "$WT" config user.name spec
    git -C "$WT" add -A
    git -C "$WT" -c commit.gpgsign=false commit -qm baseline
  }

  # One argument per line, so an assertion about the argv is an assertion about
  # argv and not about how the words happened to join.
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
    if [ -f "$MOCK_DIR/list_pins.err" ]; then cat "$MOCK_DIR/list_pins.err" >&2; exit 1; fi
    if [ -f "$MOCK_DIR/list_pins.override" ]; then cat "$MOCK_DIR/list_pins.override"; exit 0; fi
    if [ -f "$MOCK_DIR/yaml_mode" ]; then
      awk '/^overrides:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  [^ ]/{sub(/:.*/,"");sub(/^  /,"");print}' \
        pnpm-workspace.yaml \
        | jq -Rs --slurpfile b "$MOCK_DIR/list_pins.json" '
            (split("\n") | map(select(length > 0))) as $keys
            | $b[0]
            | .pins = [ .pins[] | select(.key as $k | $keys | index($k)) ]
            | .count = (.pins | length)
            | del(.override_root)'
      exit 0
    fi
    jq --slurpfile mf package.json '
      (.override_root // ["overrides"]) as $root
      | .pins = [ .pins[] | . as $p | select(($mf[0] | getpath($root + $p.path)) != null) ]
      | .count = (.pins | length)
      | del(.override_root)' "$MOCK_DIR/list_pins.json"
    ;;
  detect)
    if [ -f "$MOCK_DIR/detect.err" ]; then cat "$MOCK_DIR/detect.err" >&2; exit 1; fi
    cat "$MOCK_DIR/detect.json" ;;
  resolved_versions)
    n=$(bump "rv-$1")
    if [ -f "$MOCK_DIR/rv-$1.$n.err" ]; then cat "$MOCK_DIR/rv-$1.$n.err" >&2; exit 1; fi
    if [ -f "$MOCK_DIR/rv-$1.$n.json" ]; then cat "$MOCK_DIR/rv-$1.$n.json"
    elif [ -f "$MOCK_DIR/rv-$1.json" ]; then cat "$MOCK_DIR/rv-$1.json"
    else cat "$MOCK_DIR/rv.json"; fi ;;
  resolution_map)
    n=$(bump map)
    st=0
    if [ -f "$MOCK_DIR/map.$n.status" ]; then st=$(cat "$MOCK_DIR/map.$n.status")
    elif [ -f "$MOCK_DIR/map.status" ]; then st=$(cat "$MOCK_DIR/map.status"); fi
    if [ "$st" != "0" ]; then
      printf '{"error":"resolution_map: refused"}\n' >&2
      exit "$st"
    fi
    if [ -f "$MOCK_DIR/map.$n.json" ]; then cat "$MOCK_DIR/map.$n.json"; else cat "$MOCK_DIR/map.json"; fi ;;
  install)
    bump install >/dev/null
    if [ -f "$MOCK_DIR/install.sh" ]; then . "$MOCK_DIR/install.sh"; fi
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
    cat > "$MOCK_DIR/rv-lodash.json" <<'JSON'
{"pm":"npm","package":"lodash","present":true,"count":1,
 "versions":[{"version":"4.17.21","path":"node_modules/lodash"}],"lockfile_entries":4}
JSON
    cat > "$MOCK_DIR/rv-minimatch.json" <<'JSON'
{"pm":"npm","package":"minimatch","present":true,"count":1,
 "versions":[{"version":"9.0.5","path":"node_modules/minimatch"}],"lockfile_entries":4}
JSON
    cat > "$MOCK_DIR/map.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
    cat > "$MOCK_DIR/adv/default.json" <<'JSON'
{"package":"x","ecosystem":"npm","advisory_count":3,"withdrawn_excluded":0,
 "vulnerable_ranges":["<1.0.0"],"advisories":[],"version":"1.0.0",
 "matched_ranges":[],"unevaluated_ranges":[],"adapter_errors":[],"verdict":"safe"}
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
      --advisories "$ADV" >/dev/null
  }

  do_baseline() { "$DRIVER" baseline --work "$WORK" >/dev/null; }

  prepare() { make_env; do_list; do_baseline; }

  # -------------------------------------------------------------------------
  Describe 'list (phase 2)'
    # `kind` decides whether a pin is yours to test at all. Only `range` entries
    # are version pins; an alias is not a pin that has become unnecessary, it is
    # how the repository gets a substituted implementation.
    Describe 'kind routes the finding'
      Parameters
        range       testable          ''
        alias       not-a-version-pin 'redirect to a different package'
        protocol    not-a-version-pin 'patch, a local path, a workspace or git target'
        reference   not-a-version-pin 'deferring to a declared dependency'
        unparseable not-a-version-pin 'a value this adapter cannot read'
      End

      It "routes a $1 pin to $2"
        make_env
        jq -c --arg k "$1" '.pins[0].kind = $k' "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/t"
        mv "$MOCK_DIR/t" "$MOCK_DIR/list_pins.json"
        When call drv_jq '{tested: [.test_order[].key], skipped: [.not_a_version_pin[].key]}' \
          list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
        The status should be success
        if [ "$2" = testable ]; then
          The output should equal '{"tested":["lodash","glob"],"skipped":[]}'
        else
          The output should equal '{"tested":["glob"],"skipped":["lodash"]}'
        fi
      End
    End

    It 'gives each non-range kind the wording the definition prescribes'
      make_env
      jq -c '.pins[0].kind = "unparseable"' "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/list_pins.json"
      When call drv_jq '.not_a_version_pin[0].detail' \
        list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
      The status should be success
      The output should include 'a value this adapter cannot read'
    End

    # Bare pins constrain every consumer in the tree, so they are both the most
    # costly and the most likely to be over-broad.
    It 'orders bare pins before scoped ones'
      make_env
      When call drv_jq '[.test_order[] | .scope]' \
        list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
      The status should be success
      The output should equal '["bare","scoped"]'
    End

    # `count` of 0 is a complete answer, and a different one from a refused
    # manifest: an empty override block is read from structured JSON and cannot
    # mean "the parser failed".
    It 'reports a repository that pins nothing as no_pins, not as a failure'
      make_env
      printf '%s\n' '{"name":"app"}' > "$WT/package.json"
      When call drv_jq '{status, count, pr_skipped_reason}' \
        list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
      The status should be success
      The output should equal '{"status":"no_pins","count":0,"pr_skipped_reason":"no pins"}'
    End

    # A non-zero exit is NOT an empty result: the adapter fails rather than
    # reporting zero pins when the override block is present but is not an
    # object of entries.
    It 'never reports a refused manifest as a repository that pins nothing'
      make_env
      printf '{"error":"overrides is not an object of entries"}\n' > "$MOCK_DIR/list_pins.err"
      When call drv_jq '{status, phase}' \
        list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"list"}'
      The stderr should include 'not an empty result'
      The stderr should include 'overrides is not an object of entries'
    End

    # "A field the contract promises arrives present and of the promised type,
    # or it is a hard error, never a default" (scripts/CLAUDE.md).
    Describe 'a promised list_pins field that is absent is a hard error'
      Parameters
        count
        override_file
        override_location
      End

      It "fails phase list naming an absent $1"
        make_env
        jq -c "del(.$1)" "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/t"
        mv "$MOCK_DIR/t" "$MOCK_DIR/list_pins.json"
        # `count` is recomputed by the mock, so removing it from the canned
        # file only lands when the mock is bypassed entirely.
        jq -c "del(.$1)" "$MOCK_DIR/list_pins.json" \
          | jq -c 'del(.override_root)' > "$MOCK_DIR/list_pins.override"
        When call drv_jq '{status, phase}' \
          list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
        The status should equal 3
        The output should equal '{"status":"failure","phase":"list"}'
        The stderr should include "no '$1' field"
      End
    End

    # An adapter exiting 0 with EMPTY stdout is the third route to the same
    # silent zero: jq on empty input emits nothing, so every has() check
    # downstream is skipped rather than failed.
    It 'fails when list_pins exits 0 with empty stdout'
      make_env
      : > "$MOCK_DIR/list_pins.override"
      When call drv_jq '{status, phase}' \
        list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"list"}'
      The stderr should include 'no JSON object on stdout'
    End

    It 'refuses a count that disagrees with the entries beside it'
      make_env
      jq -c 'del(.override_root) | .count = 9' "$MOCK_DIR/list_pins.json" \
        > "$MOCK_DIR/list_pins.override"
      When call drv_jq '{status, phase}' \
        list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"list"}'
      The stderr should include 'verifies every later edit against that count'
    End

    # `override_file` is what every later edit, restore and staging list names
    # (issue #159: pnpm 11 keeps live overrides in pnpm-workspace.yaml).
    It 'carries override_file through so later steps target the right file'
      make_env
      When call drv_jq '{override_file, override_location}' \
        list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV"
      The status should be success
      The output should equal '{"override_file":"package.json","override_location":"overrides"}'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'baseline (phase 4 head)'
    # The lockfile NAME comes from the adapter, never from `pm`: a restore aimed
    # at a file that is not there fails in the one way the restore verification
    # cannot afford.
    It 'asks the adapter for the lockfile name rather than inferring it from pm'
      make_env
      do_list
      "$DRIVER" baseline --work "$WORK" >/dev/null
      When call grep -c '^VERB detect' "$MOCK_LOG"
      The status should be success
      The output should equal '1'
    End

    It 'installs once for the whole audit, before either snapshot'
      prepare
      When call grep -e '^VERB install' -e '^VERB resolution_map' "$MOCK_LOG"
      The status should be success
      The output should equal 'VERB install
VERB resolution_map'
    End

    # Never fall back to testing pins against a tree that could not be built.
    It 'stops on a failed baseline install, phase install, quoting the manager'
      make_env
      do_list
      printf '1\n' > "$MOCK_DIR/install.status"
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf 'npm ERR! code ERESOLVE\n' >&2
SH
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"install"}'
      The stderr should include 'ERESOLVE'
      The stderr should include 'plausible-looking verdicts'
    End

    # A parser that refuses a lockfile it could not read is ANSWERING; a diff
    # against a map that was never built reports every package unchanged.
    It 'stops on a baseline resolution_map that errors'
      make_env
      do_list
      printf '1\n' > "$MOCK_DIR/map.status"
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"install"}'
      The stderr should include 'refuses a lockfile it could not read'
    End

    It 'stops on a baseline resolved_versions that errors'
      make_env
      do_list
      printf '{"error":"parsed zero entries"}\n' > "$MOCK_DIR/rv-lodash.1.err"
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"install"}'
      The stderr should include 'parsed zero entries'
      The stderr should include 'never an empty result'
    End

    # A baseline `present: false` is a parser making a claim about ITSELF: the
    # manifest pins this package and the tree was just installed from that
    # manifest. Every later step reads `present: false` as "the package left the
    # tree", which is this flow's cue for `removable` (#44, #46).
    It 'records a baseline present:false pin inconclusive and never tests it'
      make_env
      do_list
      jq -c '.present = false | .versions = []' "$MOCK_DIR/rv-lodash.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/rv-lodash.json"
      When call drv_jq '{inc: [.inconclusive[].package], order: [.test_order[].key]}' \
        baseline --work "$WORK"
      The status should be success
      The output should equal '{"inc":["lodash"],"order":["glob"]}'
    End

    It 'refuses to test a pin the baseline recorded present:false'
      make_env
      do_list
      jq -c '.present = false | .versions = []' "$MOCK_DIR/rv-lodash.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/rv-lodash.json"
      do_baseline
      When run script "$DRIVER" test-pin --work "$WORK" --key lodash
      The status should equal 1
      The stdout should include '"error"'
      The stderr should include 'present: false'
    End

    # `unreadable_entries` must be present and a non-negative integer: read
    # straight, an absent one arrives as the string "null" and reads as full
    # coverage on every map (#48).
    It 'refuses a map whose unreadable_entries is absent'
      make_env
      do_list
      jq -c 'del(.unreadable_entries)' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"install"}'
      The stderr should include "no 'unreadable_entries' field"
    End

    # Exit 2 is the contract's "not implemented": there is no whole-tree view to
    # be had, so the audit still runs and every verdict says it covers the named
    # package only.
    It 'keeps auditing when resolution_map is unimplemented, with no whole-tree view'
      make_env
      do_list
      printf '2\n' > "$MOCK_DIR/map.status"
      When call drv_jq '{resolution_map_available, whole_tree_view}' baseline --work "$WORK"
      The status should be success
      The output should equal '{"resolution_map_available":false,"whole_tree_view":false}'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'test-pin (phase 4, one pin per install)'
    It 'removes exactly that entry and nothing else'
      prepare
      "$DRIVER" test-pin --work "$WORK" --key lodash >/dev/null
      # Restored by step 7, so the committed manifest is what is read back; the
      # edit itself is asserted through list_pins' count below.
      When call jq -c '.overrides' "$WT/package.json"
      The status should be success
      The output should equal '{"lodash":"^4.17.21","glob":{"minimatch":"^9.0.0"}}'
    End

    It 'removes the whole override block when the entry was the last one'
      prepare
      printf '%s\n' '{"name":"app","overrides":{"lodash":"^4.17.21"}}' > "$WT/package.json"
      jq -c '.pins = [.pins[0]] | .count = 1' "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/list_pins.json"
      git -C "$WT" add -A
      git -C "$WT" -c commit.gpgsign=false commit -qm one-pin
      "$DRIVER" list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV" >/dev/null
      do_baseline
      cat > "$MOCK_DIR/install.sh" <<'SH'
cp package.json "$MOCK_DIR/manifest-at-install.json"
SH
      "$DRIVER" test-pin --work "$WORK" --key lodash >/dev/null
      When call jq -c '.' "$MOCK_DIR/manifest-at-install.json"
      The status should be success
      The output should equal '{"name":"app"}'
    End

    # An edit that silently matched nothing, or that matched a similar key
    # elsewhere in the manifest, produces an install of the manifest the audit
    # started with and a verdict that reads as a tested removal.
    It 'fails when list_pins still carries the key after the removal'
      prepare
      jq -c 'del(.override_root)' "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/list_pins.override"
      When call drv_jq '{status, phase}' test-pin --work "$WORK" --key lodash
      The status should equal 3
      The output should equal '{"status":"failure","phase":"install"}'
      The stderr should include 'still present after the removal'
    End

    It 'fails when the count did not fall by exactly one'
      prepare
      jq -c 'del(.override_root) | .pins = [.pins[1]] | .count = 0' "$MOCK_DIR/list_pins.json" \
        > "$MOCK_DIR/list_pins.override"
      When call drv_jq '{status, phase}' test-pin --work "$WORK" --key lodash
      The status should equal 3
      The output should equal '{"status":"failure","phase":"install"}'
      The stderr should include 'one less is 1'
    End

    It 'never installs when the edit could not be verified'
      prepare
      jq -c 'del(.override_root)' "$MOCK_DIR/list_pins.json" > "$MOCK_DIR/list_pins.override"
      "$DRIVER" test-pin --work "$WORK" --key lodash >/dev/null 2>&1 || true
      When call cat "$MOCK_DIR/install.n"
      The status should be success
      The output should equal '1'
    End

    # A manifest that does not parse: every verdict measured against an install
    # of it would be fiction, so the file is restored and the run stops. It is
    # never repaired by re-editing around the error.
    It 'stops on a manifest that does not parse, phase install, and restores it'
      prepare
      printf '{"name":"app","overrides":{"lodash":"^4.17.21",}\n' > "$WT/package.json"
      When call drv_jq '{status, phase}' test-pin --work "$WORK" --key lodash
      The status should equal 3
      The output should equal '{"status":"failure","phase":"install"}'
      The stderr should include 'does not parse'
    End

    It 'leaves the manifest matching HEAD after that stop'
      prepare
      printf '{"name":"app","overrides":{"lodash":"^4.17.21",}\n' > "$WT/package.json"
      "$DRIVER" test-pin --work "$WORK" --key lodash >/dev/null 2>&1 || true
      When call git -C "$WT" diff --quiet HEAD -- package.json
      The status should be success
    End

    # A per-pin install failure stops that PIN, not the run — unlike the
    # baseline, whose failure stops everything.
    It 'records a per-pin install failure inconclusive and keeps the run alive'
      prepare
      printf '1\n' > "$MOCK_DIR/install.status"
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf 'npm ERR! ERESOLVE could not resolve\n' >&2
SH
      When call drv_jq '{status, s: .finding.status}' test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"status":"ok","s":"inconclusive"}'
    End

    It 'never reports a pin removable off a failed install'
      prepare
      printf '1\n' > "$MOCK_DIR/install.status"
      "$DRIVER" test-pin --work "$WORK" --key lodash >/dev/null
      When call jq -c '[.findings[] | select(.key == "lodash") | .detail]' "$WORK/state.json"
      The status should be success
      The output should include 'nothing about the removal was observed'
    End

    # Step 7's verification is what keeps "one pin per install" true. `HEAD` is
    # load-bearing in both commands (#46), and a restore that could not complete
    # ends the RUN, not the pin: a lockfile name that is not this repository's
    # is the documented way it half-completes.
    It 'ends the run, phase restore, when the restore cannot be verified'
      make_env
      do_list
      jq -c '.lockfile = "yarn.lock"' "$MOCK_DIR/detect.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/detect.json"
      do_baseline
      When call drv_jq '{status, phase}' test-pin --work "$WORK" --key lodash
      The status should equal 3
      The output should equal '{"status":"failure","phase":"restore"}'
      The stderr should include 'still carrying this removal'
    End

    # The versions attributable to THIS pin are the ones present after removal
    # and absent from the baseline. The raw list carries the sibling's
    # resolutions and unrelated copies elsewhere in the tree, and judging those
    # is how a genuinely safe scoped pin reports still-required citing a version
    # that has nothing to do with it.
    It 'takes the delta, not the raw list, so siblings and unrelated copies drop out'
      make_env
      cat > "$MOCK_DIR/rv-lodash.2.json" <<'JSON'
{"pm":"npm","package":"lodash","present":true,"count":3,
 "versions":[{"version":"4.17.21","path":"node_modules/lodash"},
             {"version":"3.10.1","path":"node_modules/a/node_modules/lodash"},
             {"version":"4.17.19","path":"node_modules/b/node_modules/lodash"}],
 "lockfile_entries":6}
JSON
      cat > "$MOCK_DIR/rv-lodash.json" <<'JSON'
{"pm":"npm","package":"lodash","present":true,"count":2,
 "versions":[{"version":"4.17.21","path":"node_modules/lodash"},
             {"version":"3.10.1","path":"node_modules/a/node_modules/lodash"}],
 "lockfile_entries":6}
JSON
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":6,"entries_read":6,"entries_expected":6,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["3.10.1","4.17.19","4.17.21"],"minimatch":["9.0.5"],"express":["4.18.2"]}}
JSON
      jq -c '.resolutions.lodash = ["3.10.1","4.17.21"]' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      do_list
      do_baseline
      When call drv_jq '{d: .finding.attributable_versions, raw: .finding.resolved_without_pin}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"d":["4.17.19"],"raw":["3.10.1","4.17.19","4.17.21"]}'
    End

    # A single unreadable locator passes the ratio guard and drops its package
    # from BOTH snapshots, so the diff sees no change and `[]` claims nothing
    # else moved — the stronger claim, about a package nobody audited (#48).
    It 'maps a non-zero unreadable_entries onto null collateral and not-checked'
      make_env
      do_list
      jq -c '.unreadable_entries = 1' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      do_baseline
      When call drv_jq '{c: .finding.collateral_changes, v: .finding.collateral_verdict}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"c":null,"v":"not-checked"}'
    End

    # The same split `baseline` draws. A `not-checked` that says only "no
    # whole-tree view was available" reads identically for an adapter that
    # lacks the verb and for a parser that refused THIS repository's lockfile,
    # and only the second is a defect to chase.
    It 'records a per-pin map refusal as a refusal, quoting the adapter'
      make_env
      do_list
      printf '1\n' > "$MOCK_DIR/map.2.status"
      do_baseline
      When call drv_jq '{v: .finding.collateral_verdict, r: .finding.collateral_not_checked_reason}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should include '"v":"not-checked"'
      The output should include 'refused this lockfile'
      The output should include 'resolution_map: refused'
    End

    It 'records an unimplemented resolution_map as an unimplemented one'
      make_env
      do_list
      printf '2\n' > "$MOCK_DIR/map.2.status"
      do_baseline
      When call drv_jq '.finding.collateral_not_checked_reason' test-pin --work "$WORK" --key lodash
      The status should be success
      The output should include 'does not implement resolution_map'
    End

    It 'names the unread entry counts when the map was merely partial'
      make_env
      do_list
      jq -c '.unreadable_entries = 3' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      do_baseline
      When call drv_jq '.finding.collateral_not_checked_reason' test-pin --work "$WORK" --key lodash
      The status should be success
      The output should include 'could not read 3 lockfile entries'
    End

    It 'falls back to the same narrow claim when resolution_map is unavailable'
      make_env
      do_list
      printf '2\n' > "$MOCK_DIR/map.status"
      do_baseline
      When call drv_jq '{c: .finding.collateral_changes, v: .finding.collateral_verdict, w: .finding.whole_tree_view}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"c":null,"v":"not-checked","w":false}'
    End

    # `present: false` after removal: the package left the tree entirely, the
    # pin was the only thing holding it in.
    It 'reads present:false after removal as the package leaving the tree'
      prepare
      jq -c '.present = false | .versions = []' "$MOCK_DIR/rv-lodash.json" \
        > "$MOCK_DIR/rv-lodash.2.json"
      jq -c 'del(.resolutions.lodash)' "$MOCK_DIR/map.json" > "$MOCK_DIR/map.2.json"
      When call drv_jq '{left: .finding.left_tree, d: .finding.attributable_versions}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"left":true,"d":[]}'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'the two verbs must agree about the tested package'
    # A pin keyed on an `npm:` alias: the map holds that copy under the real
    # package name while resolved_versions answers under both, so the normalized
    # comparison reads `[]` against a non-empty list. `removable` here would be
    # a deletion recommendation reached by that route (#46).
    It 'reports an alias-keyed pin inconclusive on [] against a non-empty list'
      prepare
      cat > "$MOCK_DIR/rv-lodash.2.json" <<'JSON'
{"pm":"npm","package":"lodash","present":true,"count":1,
 "versions":[{"version":"4.18.2","path":"node_modules/lodash-alias"}],"lockfile_entries":4}
JSON
      jq -c 'del(.resolutions.lodash)' "$MOCK_DIR/map.json" > "$MOCK_DIR/map.2.json"
      When call drv_jq '{s: .finding.status, shape: .finding.disagreement.shape}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"s":"inconclusive","shape":"alias-key"}'
    End

    # The second documented shape, and it looks different: two non-empty lists
    # where the map's is a subset. A real package sharing its name with another
    # entry's install key (#48; ADR 001's alias exception).
    It 'reports a shared install-key name inconclusive on a non-empty subset'
      prepare
      cat > "$MOCK_DIR/rv-lodash.2.json" <<'JSON'
{"pm":"npm","package":"lodash","present":true,"count":2,
 "versions":[{"version":"4.17.21","path":"node_modules/lodash"},
             {"version":"1.13.6","path":"node_modules/x/node_modules/lodash"}],
 "lockfile_entries":5}
JSON
      When call drv_jq '{s: .finding.status, shape: .finding.disagreement.shape}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"s":"inconclusive","shape":"shared-install-key"}'
    End

    # The raw shapes differ by design — resolved_versions returns one
    # {version, path} per resolution, the map holds each version once — so a
    # healthy pin installed at two paths must NOT come back inconclusive.
    It 'normalizes both sides, so one version at two paths is not a disagreement'
      prepare
      cat > "$MOCK_DIR/rv-lodash.2.json" <<'JSON'
{"pm":"npm","package":"lodash","present":true,"count":2,
 "versions":[{"version":"4.17.21","path":"node_modules/lodash"},
             {"version":"4.17.21","path":"node_modules/x/node_modules/lodash"}],
 "lockfile_entries":5}
JSON
      When call drv_jq '{s: .finding.status, dis: .finding.disagreement}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"s":"tested","dis":null}'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'the platform-binary family sample'
    # A large collateral fan-out is CHECKED, not sampled, unless it is a
    # platform-binary family. Removing one pin in a field-test audit run moved
    # 26 `@esbuild/*` packages together; a family verdict that presents itself
    # as 26 checks is the failure the rule exists to prevent, as is reporting
    # `not-checked` for a fan-out that was simply large.
    family_maps() {
      cat > "$MOCK_DIR/map.json" <<'JSON'
{"pm":"npm","lockfile_entries":9,"entries_read":9,"entries_expected":9,
 "unreadable_entries":0,"package_count":5,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.5"],
   "@esbuild/darwin-arm64":["0.21.0"],"@esbuild/linux-x64":["0.21.0"],
   "@esbuild/win32-x64":["0.21.0"]}}
JSON
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":9,"entries_read":9,"entries_expected":9,
 "unreadable_entries":0,"package_count":5,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.5"],
   "@esbuild/darwin-arm64":["0.23.1"],"@esbuild/linux-x64":["0.23.1"],
   "@esbuild/win32-x64":["0.23.1"]}}
JSON
    }

    It 'samples one member when all three conditions hold'
      make_env
      family_maps
      do_list
      do_baseline
      When call drv_jq '{judged: [.finding.collateral_changes[] | select(.judged) | .package], fam: .finding.sampled_families[0]}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"judged":["@esbuild/darwin-arm64"],"fam":{"key":"@esbuild/","size":3,"members":["@esbuild/darwin-arm64","@esbuild/linux-x64","@esbuild/win32-x64"],"sample":"@esbuild/darwin-arm64","shared_version":"0.23.1"}}'
    End

    It 'checks every member when the family does not share one version'
      make_env
      family_maps
      jq -c '.resolutions["@esbuild/win32-x64"] = ["0.23.2"]' "$MOCK_DIR/map.2.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.2.json"
      do_list
      do_baseline
      When call drv_jq '[.finding.collateral_changes[] | select(.judged) | .package]' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '["@esbuild/darwin-arm64","@esbuild/linux-x64","@esbuild/win32-x64"]'
    End

    It 'checks every member when they did not share one baseline either'
      make_env
      family_maps
      jq -c '.resolutions["@esbuild/win32-x64"] = ["0.20.0"]' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      do_list
      do_baseline
      When call drv_jq '[.finding.collateral_changes[] | select(.judged) | .package]' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '["@esbuild/darwin-arm64","@esbuild/linux-x64","@esbuild/win32-x64"]'
    End

    # The third condition, and the one an eyeball cannot check: a family member
    # that did NOT move is a family that did not move as one unit.
    It 'checks every member when a sibling in the tree did not move'
      make_env
      family_maps
      jq -c '.resolutions["@esbuild/linux-arm64"] = ["0.21.0"]' "$MOCK_DIR/map.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.json"
      jq -c '.resolutions["@esbuild/linux-arm64"] = ["0.21.0"]' "$MOCK_DIR/map.2.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/map.2.json"
      do_list
      do_baseline
      When call drv_jq '[.finding.collateral_changes[] | select(.judged) | .package]' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '["@esbuild/darwin-arm64","@esbuild/linux-x64","@esbuild/win32-x64"]'
    End

    # A prefix match alone is not a family. `@types/`, `@babel/` and `eslint-`
    # all group under it, and a two-member scope moving in lockstep is
    # ordinary — there one member's `safe` verdict would come to stand for a
    # package nothing judged. The name past the shared prefix has to end in an
    # <os>-<arch> pair.
    It 'checks every member of a two-member scope with no platform triple'
      make_env
      cat > "$MOCK_DIR/map.json" <<'JSON'
{"pm":"npm","lockfile_entries":6,"entries_read":6,"entries_expected":6,
 "unreadable_entries":0,"package_count":4,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.5"],
   "@types/node":["20.1.0"],"@types/react":["20.1.0"]}}
JSON
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":6,"entries_read":6,"entries_expected":6,
 "unreadable_entries":0,"package_count":4,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.5"],
   "@types/node":["20.4.0"],"@types/react":["20.4.0"]}}
JSON
      do_list
      do_baseline
      When call drv_jq '{judged: [.finding.collateral_changes[] | select(.judged) | .package], fams: .finding.sampled_families}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"judged":["@types/node","@types/react"],"fams":[]}'
    End

    # And the shapes the rule names really do sample: a scope-only triple, a
    # binding prefix inside the scope, and an unscoped prefix.
    Describe 'the platform-triple shapes the rule names'
      # The sampled member leads each row: a first column ending in `/` reads as
      # a command name to ShellCheck (SC2287), and the family key is the one
      # value here that ends in one.
      Parameters
        '@esbuild/darwin-arm64'          '@esbuild/linux-x64'              '@esbuild/'
        '@rolldown/binding-darwin-arm64' '@rolldown/binding-linux-x64-gnu' '@rolldown/'
        'lightningcss-darwin-arm64'      'lightningcss-linux-x64-musl'     'lightningcss-'
      End

      It "samples the $3 family"
        make_env
        jq -cn --arg a "$1" --arg b "$2" '
          {pm:"npm",lockfile_entries:6,entries_read:6,entries_expected:6,
           unreadable_entries:0,package_count:4,
           resolutions:({"lodash":["4.17.21"],"minimatch":["9.0.5"]}
                        + {($a):["0.21.0"]} + {($b):["0.21.0"]})}' > "$MOCK_DIR/map.json"
        jq -cn --arg a "$1" --arg b "$2" '
          {pm:"npm",lockfile_entries:6,entries_read:6,entries_expected:6,
           unreadable_entries:0,package_count:4,
           resolutions:({"lodash":["4.17.21"],"minimatch":["9.0.5"]}
                        + {($a):["0.23.1"]} + {($b):["0.23.1"]})}' > "$MOCK_DIR/map.2.json"
        do_list
        do_baseline
        When call drv_jq '{judged: [.finding.collateral_changes[] | select(.judged) | .package], k: .finding.sampled_families[0].key}' \
          test-pin --work "$WORK" --key lodash
        The status should be success
        The output should equal "{\"judged\":[\"$1\"],\"k\":\"$3\"}"
      End
    End

    It 'never samples a lone package that merely shares a prefix with nothing'
      make_env
      cat > "$MOCK_DIR/map.2.json" <<'JSON'
{"pm":"npm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":3,
 "resolutions":{"lodash":["4.17.21"],"minimatch":["9.0.5"],"express":["4.19.2"]}}
JSON
      do_list
      do_baseline
      When call drv_jq '{judged: [.finding.collateral_changes[] | select(.judged) | .package], fams: .finding.sampled_families}' \
        test-pin --work "$WORK" --key lodash
      The status should be success
      The output should equal '{"judged":["express"],"fams":[]}'
    End
  End

  # -------------------------------------------------------------------------
  Describe 'the override file the edits target (issue #159)'
    workspace_env() {
      make_env
      rm -f "$WT/package.json"
      printf '%s\n' '{"name":"app","packageManager":"pnpm@11.9.0"}' > "$WT/package.json"
      cat > "$WT/pnpm-workspace.yaml" <<'YAML'
packages:
  - packages/*

overrides:
  undici: '>=6.23.0'
  form-data: '>=4.0.4'
YAML
      : > "$MOCK_DIR/yaml_mode"
      cat > "$MOCK_DIR/list_pins.json" <<'JSON'
{"pm":"pnpm","override_location":"pnpm.overrides","override_file":"pnpm-workspace.yaml",
 "block_present":true,"count":2,"bare_count":2,"override_root":[],
 "pins":[
   {"key":"undici","path":["undici"],"package":"undici","parents":[],"scope":"bare",
    "value":">=6.23.0","kind":"range","selector":null,"range":">=6.23.0",
    "alias_package":null,"alias_range":null},
   {"key":"form-data","path":["form-data"],"package":"form-data","parents":[],"scope":"bare",
    "value":">=4.0.4","kind":"range","selector":null,"range":">=4.0.4",
    "alias_package":null,"alias_range":null}]}
JSON
      jq -c '.lockfile = "pnpm-lock.yaml"' "$MOCK_DIR/detect.json" > "$MOCK_DIR/t"
      mv "$MOCK_DIR/t" "$MOCK_DIR/detect.json"
      printf 'lockfileVersion: 9.0\n' > "$WT/pnpm-lock.yaml"
      rm -f "$WT/package-lock.json"
      cat > "$MOCK_DIR/rv-undici.json" <<'JSON'
{"pm":"pnpm","package":"undici","present":true,"count":1,
 "versions":[{"version":"6.23.0","path":"undici@6.23.0"}],"lockfile_entries":4}
JSON
      cat > "$MOCK_DIR/rv-form-data.json" <<'JSON'
{"pm":"pnpm","package":"form-data","present":true,"count":1,
 "versions":[{"version":"4.0.4","path":"form-data@4.0.4"}],"lockfile_entries":4}
JSON
      cat > "$MOCK_DIR/map.json" <<'JSON'
{"pm":"pnpm","lockfile_entries":4,"entries_read":4,"entries_expected":4,
 "unreadable_entries":0,"package_count":2,
 "resolutions":{"undici":["6.23.0"],"form-data":["4.0.4"]}}
JSON
      git -C "$WT" add -A
      git -C "$WT" -c commit.gpgsign=false commit -qm workspace
      do_list
      do_baseline
    }

    It 'edits pnpm-workspace.yaml, leaving every other line byte-for-byte'
      workspace_env
      cat > "$MOCK_DIR/install.sh" <<'SH'
cp pnpm-workspace.yaml "$MOCK_DIR/ws-at-install.yaml"
SH
      "$DRIVER" test-pin --work "$WORK" --key undici >/dev/null
      When call cat "$MOCK_DIR/ws-at-install.yaml"
      The status should be success
      The output should equal 'packages:
  - packages/*

overrides:
  form-data: '"'"'>=4.0.4'"'"''
    End

    It 'takes the overrides: line with the last entry'
      workspace_env
      "$DRIVER" test-pin --work "$WORK" --key undici >/dev/null
      cat > "$MOCK_DIR/install.sh" <<'SH'
cp pnpm-workspace.yaml "$MOCK_DIR/ws-last.yaml"
SH
      printf 'packages:\n  - packages/*\n\noverrides:\n  form-data: %s\n' "'>=4.0.4'" \
        > "$WT/pnpm-workspace.yaml"
      git -C "$WT" add -A
      git -C "$WT" -c commit.gpgsign=false commit -qm one-entry
      "$DRIVER" list --work "$WORK" --worktree "$WT" --adapter "$MOCK" --advisories "$ADV" >/dev/null
      do_baseline
      "$DRIVER" test-pin --work "$WORK" --key form-data >/dev/null
      When call cat "$MOCK_DIR/ws-last.yaml"
      The status should be success
      The output should equal 'packages:
  - packages/*'
    End

    It 'restores package.json as well as the workspace file'
      workspace_env
      "$DRIVER" test-pin --work "$WORK" --key undici >/dev/null
      When call git -C "$WT" diff --quiet HEAD -- package.json pnpm-workspace.yaml
      The status should be success
    End
  End
End
