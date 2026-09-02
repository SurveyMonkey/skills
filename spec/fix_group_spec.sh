#!/bin/sh
# shellcheck shell=sh
# fix-group.sh `classify` and `baseline` — phases 2 and 3 of the fix flow
# (#103, #76, #83, #85, #146, #171).
#
# The adapter is mocked with a scratch executable that serves canned JSON per
# verb and records its argv: specs never hit the network or run an install
# (root CLAUDE.md). The verdicts asserted here are the ones the prose used to
# only describe — the peer-only stop, which parents become eligible, what the
# drift commit is allowed to carry, and what a residual working tree does.

Describe 'fix-group.sh classify and baseline'
  DRIVER="$COMMON/fix-group.sh"
  After 'cleanup_fixture'

  # Deliberately a copy of the harness in spec/fix_group_setup_spec.sh and
  # spec/fix_group_apply_spec.sh rather than a shared helper: shellspec files
  # are self-contained, and each suite tunes its mock differently.
  make_env() {
    TEST_DIR=$(mktemp -d)
    ORIGIN="$TEST_DIR/origin"
    REPO="$TEST_DIR/repo"
    BIN="$TEST_DIR/bin"
    MOCK_DIR="$TEST_DIR/mock"
    MOCK_LOG="$TEST_DIR/argv.log"
    export MOCK_DIR MOCK_LOG
    mkdir -p "$ORIGIN" "$BIN" "$MOCK_DIR"
    : > "$MOCK_LOG"
    git -C "$ORIGIN" init -q -b main
    printf '{"name":"app","dependencies":{"lodash":"^4.17.20"}}\n' > "$ORIGIN/package.json"
    printf '{"lockfileVersion":3}\n' > "$ORIGIN/package-lock.json"
    # A committed zero-install cache archive, so a change to it shows in
    # porcelain as its own path the way a real Yarn Berry repository's does.
    mkdir -p "$ORIGIN/.yarn/cache"
    printf 'old\n' > "$ORIGIN/.yarn/cache/lodash-npm-4.17.20.zip"
    git -C "$ORIGIN" add -A
    git -C "$ORIGIN" -c user.email=spec@example.invalid -c user.name=spec commit -qm init
    git clone -q "$ORIGIN" "$REPO"
    git -C "$REPO" config user.email spec@example.invalid
    git -C "$REPO" config user.name spec
    WORK="$REPO/.claude/worktrees/fix-dependabot-lodash-4x"
    MOCK="$BIN/adapter.sh"
    write_mock
    write_group
    defaults
  }

  # One argument per line, so an assertion about the argv is an assertion about
  # argv and not about how the words happened to join.
  write_mock() {
    cat > "$MOCK" <<'SH'
#!/bin/sh
{ printf 'VERB %s\n' "$1"; for a in "$@"; do printf 'ARG %s\n' "$a"; done; } >> "$MOCK_LOG"
verb=$1
shift
case "$verb" in
  why|declared_ranges|apply_constraint)
    if [ -f "$MOCK_DIR/$verb.err" ]; then cat "$MOCK_DIR/$verb.err" >&2; exit 1; fi
    cat "$MOCK_DIR/$verb.json" ;;
  resolved_versions)
    n=$(cat "$MOCK_DIR/rv.n" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s\n' "$n" > "$MOCK_DIR/rv.n"
    if [ -f "$MOCK_DIR/rv.$n.err" ]; then cat "$MOCK_DIR/rv.$n.err" >&2; exit 1; fi
    if [ -f "$MOCK_DIR/rv.$n.json" ]; then cat "$MOCK_DIR/rv.$n.json"; else cat "$MOCK_DIR/rv.json"; fi ;;
  install)
    n=$(cat "$MOCK_DIR/install.n" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s\n' "$n" > "$MOCK_DIR/install.n"
    if [ -f "$MOCK_DIR/install.sh" ]; then . "$MOCK_DIR/install.sh"; fi
    exit "$(cat "$MOCK_DIR/install.status" 2>/dev/null || echo 0)" ;;
  validate)
    cat "$MOCK_DIR/validate.json"
    jq -e '.ok' "$MOCK_DIR/validate.json" >/dev/null ;;
  compare_versions)
    jq -n --arg a "$1" --arg b "$2" '
      def parts: split(".") | map(tonumber? // 0);
      ($a | parts) as $x | ($b | parts) as $y
      | {a: $a, b: $b, result: (if $x < $y then -1 elif $x > $y then 1 else 0 end)}' ;;
  *) printf '{"error":"unknown verb"}\n' >&2; exit 1 ;;
esac
SH
    chmod +x "$MOCK"
  }

  write_group() {
    cat > "$TEST_DIR/group.json" <<'JSON'
{"package": "lodash", "ecosystem": "npm", "major_line": "4",
 "highest_fixed_version": "4.17.21",
 "branch_name": "fix/dependabot-lodash-4x",
 "alerts": [{"number": 1, "vulnerable_range": "< 4.17.21"}],
 "sibling_alerts": []}
JSON
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
    cat > "$MOCK_DIR/rv.json" <<'JSON'
{"pm": "npm", "package": "lodash", "present": true, "count": 1,
 "versions": [{"version": "4.17.20", "path": "node_modules/lodash"}],
 "lockfile_entries": 3}
JSON
    # The default install rewrites the lockfile, which is the stale-lockfile
    # case the drift commit exists for. Examples that need the no-drift path
    # blank this out.
    cat > "$MOCK_DIR/install.sh" <<'SH'
printf '{"lockfileVersion":3,"n":1}\n' > package-lock.json
SH
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

  do_setup() {
    "$DRIVER" setup --group-json "$TEST_DIR/group.json" --repo-root "$REPO" \
      --default-branch main --adapter "$MOCK" >/dev/null
  }

  Describe 'classify (phase 2)'
    # A peer_only package is a structural dead end and it is named before any
    # install runs: one field run burned four install cycles (~17 minutes)
    # proving a shape `why` can answer for free (#103).
    It 'stops on a peer_only package with the documented detail fields'
      make_env
      cat > "$MOCK_DIR/why.json" <<'JSON'
{"pm": "pnpm", "package": "lodash", "relationship": "transitive",
 "peer_only": true, "peer_parents": ["react-dom"],
 "optional_peer_parents": ["eslint"], "parents": ["react-dom"], "raw": "x"}
JSON
      do_setup
      When call drv_jq '{status, phase}' classify --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"classify"}'
      The stderr should include 'peer_only_dependency'
      The stderr should include '["react-dom"]'
      The stderr should include '["eslint"]'
    End

    It 'never reaches declared_ranges or an install on the peer_only stop'
      make_env
      cat > "$MOCK_DIR/why.json" <<'JSON'
{"pm": "pnpm", "package": "lodash", "relationship": "transitive",
 "peer_only": true, "peer_parents": ["react-dom"],
 "optional_peer_parents": [], "parents": ["react-dom"], "raw": "x"}
JSON
      do_setup
      "$DRIVER" classify --work "$WORK" >/dev/null 2>&1 || true
      When call grep -c '^VERB ' "$MOCK_LOG"
      The status should be success
      The output should equal '1'
    End

    # The eligible set is parents_read + parents_unreadable +
    # parents_without_range, minus nothing else (#76, #83).
    It 'unions the three eligible parent lists and excludes parents_other_lines'
      make_env
      cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": ["^4.17.20"],
 "root_range": null,
 "parents_read": ["express"],
 "parents_without_range": ["koa"],
 "parents_unreadable": ["fastify"],
 "parents_malformed": [],
 "parents_other_lines": ["minimatch@3.1.5"]}
JSON
      do_setup
      When call drv_jq '{eligible_parents}' classify --work "$WORK"
      The status should be success
      The output should equal '{"eligible_parents":["express","fastify","koa"]}'
    End

    # An undeterminable line is not evidence of a different one, and dropping
    # those parents abandons the fix on exactly the repositories where the copy
    # is hardest to find (#76).
    It 'keeps every parent eligible when parents_read is empty'
      make_env
      cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "npm", "package": "lodash", "line": 4, "ranges": [],
 "root_range": null, "parents_read": [], "parents_without_range": [],
 "parents_unreadable": ["express"], "parents_malformed": ["express"],
 "parents_other_lines": []}
JSON
      do_setup
      When call drv_jq '{eligible_parents, parents_malformed}' classify --work "$WORK"
      The status should be success
      The output should equal '{"eligible_parents":["express"],"parents_malformed":["express"]}'
    End

    # A parent in the tree at several versions appears in BOTH lists and is
    # eligible: one of its copies is on this line. The bare name is what gets
    # passed; the adapter decides key qualification internally (#85, #100).
    It 'scopes by parent name, dropping a resolved-version qualifier'
      make_env
      cat > "$MOCK_DIR/declared_ranges.json" <<'JSON'
{"pm": "pnpm", "package": "lodash", "line": 4, "ranges": [],
 "root_range": null, "parents_read": ["minimatch@10.2.5"],
 "parents_without_range": [], "parents_unreadable": [],
 "parents_malformed": [], "parents_other_lines": ["minimatch@3.1.5"]}
JSON
      do_setup
      When call drv_jq '{eligible_parents}' classify --work "$WORK"
      The status should be success
      The output should equal '{"eligible_parents":["minimatch"]}'
    End

    It 'passes --line to declared_ranges so off-line parents are never collected'
      make_env
      do_setup
      "$DRIVER" classify --work "$WORK" >/dev/null
      When call grep -A4 '^VERB declared_ranges' "$MOCK_LOG"
      The status should be success
      The output should include 'ARG --line'
      The output should include 'ARG 4'
    End

    # "A field the contract promises arrives present and of the promised type,
    # or it is a hard error, never a default" (scripts/CLAUDE.md). Read with a
    # bare `jq -r`, an absent field is the STRING "null": `.peer_only` stops
    # being "true" so the #103 dead-end check silently vanishes, and
    # `.relationship` stores "null" while `classify` still reports ok.
    Describe 'a promised field that is absent is a hard error, not a default'
      Parameters
        'peer_only'      'peer_only'
        'relationship'   'relationship'
      End

      It "fails the phase naming an absent $1 rather than branching on \"null\""
        make_env
        jq -c "del(.$1)" "$MOCK_DIR/why.json" > "$MOCK_DIR/w.tmp"
        mv "$MOCK_DIR/w.tmp" "$MOCK_DIR/why.json"
        do_setup
        When call drv_jq '{status, phase}' classify --work "$WORK"
        The status should equal 3
        The output should equal '{"status":"failure","phase":"classify"}'
        The stderr should include "no '$2' field"
      End
    End

    # An adapter exiting 0 with EMPTY stdout is the third route to the same
    # silent zero: jq on empty input emits nothing, so every has() check
    # downstream is skipped rather than failed.
    It 'fails when why exits 0 with empty stdout'
      make_env
      : > "$MOCK_DIR/why.json"
      do_setup
      When call drv_jq '{status, phase}' classify --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"classify"}'
      The stderr should include 'no JSON object on stdout'
    End

    # Anything outside the contract enum falls off the `direct` branch, so a
    # direct dependency would be pinned through parents it does not have.
    It 'refuses a relationship outside the contract enum'
      make_env
      jq -c '.relationship = "peer"' "$MOCK_DIR/why.json" > "$MOCK_DIR/w.tmp"
      mv "$MOCK_DIR/w.tmp" "$MOCK_DIR/why.json"
      do_setup
      When call drv_jq '{status, phase}' classify --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"classify"}'
      The stderr should include 'contract enum direct|transitive'
    End
  End

  Describe 'baseline (phase 3)'
    prepare() {
      make_env
      do_setup
      "$DRIVER" classify --work "$WORK" >/dev/null
    }

    It 'commits the drift when the control install rewrites the lockfile'
      prepare
      When call drv_jq '{status, step, drift_commit, baseline_present}' baseline --work "$WORK"
      The status should be success
      The output should equal '{"status":"ok","step":"baseline","drift_commit":true,"baseline_present":true}'
    End

    # Empty porcelain means the committed lockfile was current: no drift, no
    # drift commit, straight to the baseline snapshot.
    It 'makes no drift commit when the control install changes nothing'
      prepare
      : > "$MOCK_DIR/install.sh"
      When call drv_jq '{drift_commit}' baseline --work "$WORK"
      The status should be success
      The output should equal '{"drift_commit":false}'
    End

    # The lockfile always; the PnP artifacts and the zero-install cache paths
    # when they changed; NEVER package.json — a modified manifest here is the
    # anomaly the residual check exists to catch, not something to absorb.
    It 'stages the lockfile and the tracked install artifacts, and nothing else'
      prepare
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf '{"lockfileVersion":3,"n":1}\n' > package-lock.json
printf 'module.exports={}\n' > .pnp.cjs
mkdir -p .yarn/cache
printf 'zip\n' > .yarn/cache/lodash-npm-4.17.20.zip
SH
      "$DRIVER" baseline --work "$WORK" >/dev/null
      When call git -C "$WORK/fix" show --name-only --format=%s HEAD
      The status should be success
      The output should equal 'chore(deps): refresh lockfile (control install, no manifest change)

.pnp.cjs
.yarn/cache/lodash-npm-4.17.20.zip
package-lock.json'
    End

    It 'never stages package.json, and fails closed on the residual it leaves'
      prepare
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf '{"lockfileVersion":3,"n":1}\n' > package-lock.json
printf '{"name":"app","touched":true}\n' > package.json
SH
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"baseline"}'
      The stderr should include 'package.json'
      The stderr should include 'evidence, never noise to absorb'
    End

    It 'leaves the residual change in the tree rather than cleaning it up'
      prepare
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf 'unexpected\n' > stray.txt
SH
      "$DRIVER" baseline --work "$WORK" >/dev/null 2>&1 || true
      When call cat "$WORK/fix/stray.txt"
      The status should be success
      The output should equal 'unexpected'
    End

    # A control install that fails is phase `baseline`, never `install`: that
    # name stays reserved for the fix-attributable install, and this one is
    # ambient and will hit every group dispatched against the repo.
    It 'reports a failed control install as phase baseline, quoting the error'
      prepare
      printf '1\n' > "$MOCK_DIR/install.status"
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf 'npm ERR! code ERESOLVE\n' >&2
SH
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"baseline"}'
      The stderr should include 'ERESOLVE'
      The stderr should include 'no manifest change'
    End

    # A failed parse is never an empty result (scripts/CLAUDE.md, "the rule
    # that matters most").
    It 'reports an unreadable lockfile as phase baseline'
      prepare
      printf '{"error":"resolved_versions: parsed zero entries"}\n' > "$MOCK_DIR/rv.1.err"
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"baseline"}'
      The stderr should include 'parsed zero entries'
    End

    # A rename keeps its destination path, and a path git quotes (one carrying
    # bytes it escapes) is emitted verbatim so `drift_path_allowed` refuses it
    # and it lands in the residual report rather than in a commit.
    It 'stages a renamed lockfile under its destination path'
      prepare
      cat > "$MOCK_DIR/install.sh" <<'SH'
git mv package-lock.json npm-shrinkwrap.json
printf '{"lockfileVersion":3,"n":1}\n' > npm-shrinkwrap.json
SH
      "$DRIVER" baseline --work "$WORK" >/dev/null
      When call git -C "$WORK/fix" show --name-only --format=%s HEAD
      The status should be success
      The output should include 'npm-shrinkwrap.json'
      The output should include 'chore(deps): refresh lockfile'
    End

    It 'refuses a quoted path rather than absorbing it into the drift commit'
      prepare
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf 'x\n' > "$(printf 'we\xc3\xafrd.txt')"
SH
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"baseline"}'
      The stderr should include 'evidence, never noise to absorb'
    End

    # The repository's own hooks are the repository's, and they run. A hook
    # that fails the drift commit is a phase `baseline` failure quoting the
    # hook's output; never bypassed, never edited around.
    It 'reports a pre-commit hook failing the drift commit, quoting it'
      prepare
      mkdir -p "$WORK/fix/.githooks"
      cat > "$WORK/fix/.githooks/pre-commit" <<'SH'
#!/bin/sh
printf 'lint: 3 problems\n' >&2
exit 1
SH
      chmod +x "$WORK/fix/.githooks/pre-commit"
      git -C "$WORK/fix" config core.hooksPath .githooks
      When call drv_jq '{status, phase}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure","phase":"baseline"}'
      The stderr should include 'lint: 3 problems'
      The stderr should include 'never bypass a hook'
    End

    # Sanctioned exactly once, and only on a registry-timeout shape. Everything
    # else is a verb that exited non-zero twice on the same inputs with no
    # remediation in between, which has failed its phase (#122). `ENOTFOUND`
    # and a bare `request to ... failed` are deliberately NOT timeout shapes:
    # the first is a wrong registry host far more often than a DNS blip, and
    # npm prints the second for a self-signed certificate chain and for a proxy
    # refusing the connection.
    Describe 'the one sanctioned install retry'
      Parameters
        'ETIMEDOUT'       'npm ERR! network request to https://registry.npmjs.org/lodash failed, reason: connect ETIMEDOUT'  2
        'EAI_AGAIN'       'npm ERR! errno EAI_AGAIN'                                                                        2
        'socket hang up'  'npm ERR! network socket hang up'                                                                 2
        'ECONNRESET'      'npm ERR! read ECONNRESET'                                                                        2
        'self-signed'     'npm ERR! request to https://registry.npmjs.org/lodash failed, reason: self signed certificate in certificate chain' 1
        'ENOTFOUND'       'npm ERR! getaddrinfo ENOTFOUND registry.internal.invalid'                                        1
        'ERESOLVE'        'npm ERR! code ERESOLVE'                                                                          1
        'EOVERRIDE'       'npm ERR! code EOVERRIDE'                                                                         1
      End

      It "runs the install $3 time(s) on a $1 failure"
        prepare
        printf '1\n' > "$MOCK_DIR/install.status"
        printf 'printf %s >&2\n' "'$2\n'" > "$MOCK_DIR/install.sh"
        "$DRIVER" baseline --work "$WORK" >/dev/null 2>&1 || true
        When call cat "$MOCK_DIR/install.n"
        The status should be success
        The output should equal "$3"
      End
    End

    It 'says in the failure detail when the sanctioned retry was spent'
      prepare
      printf '1\n' > "$MOCK_DIR/install.status"
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf 'npm ERR! network socket hang up\n' >&2
SH
      When call drv_jq '{status}' baseline --work "$WORK"
      The status should equal 3
      The output should equal '{"status":"failure"}'
      The stderr should include 'including one sanctioned retry'
    End

    # `run_install` used to capture the install's output and discard it on
    # success, and no payload carried it — so the pnpm 11 reaction
    # agents/fix-dependency.md requires was unreachable by the agent that had
    # to make it (issue #159).
    It 'carries the pnpm 11 signal an install printed into the state'
      prepare
      cat > "$MOCK_DIR/install.sh" <<'SH'
printf '{"lockfileVersion":3,"n":1}\n' > package-lock.json
printf ' WARN  The "pnpm" field in package.json is no longer read by pnpm\n' >&2
SH
      "$DRIVER" baseline --work "$WORK" >/dev/null
      When call jq -c '.install_signals' "$WORK/state.json"
      The status should be success
      The output should equal '["pnpm_field_no_longer_read"]'
    End

    It 'carries no signal when no install printed one'
      prepare
      "$DRIVER" baseline --work "$WORK" >/dev/null
      When call jq -c '.install_signals' "$WORK/state.json"
      The status should be success
      The output should equal '[]'
    End

    # The ordering is the point (#146): snapshotted before the install, a stale
    # default-branch lockfile's ambient re-resolution gets attributed to the fix.
    It 'snapshots the baseline after the control install, not before'
      prepare
      "$DRIVER" baseline --work "$WORK" >/dev/null
      When call grep -e '^VERB resolved_versions' -e '^VERB install' "$MOCK_LOG"
      The status should be success
      The output should equal 'VERB resolved_versions
VERB install
VERB resolved_versions'
    End
  End
End
