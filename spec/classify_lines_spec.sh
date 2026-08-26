#!/bin/sh
# shellcheck shell=sh
# classify-lines.sh — reconciling each group's fix line with the majors the
# repository actually resolves, before anyone approves the group.
#
# The field case is issue #101: path-to-regexp's alert (vulnerable
# ">= 0.2.0, < 1.9.0", fixed only in 1.9.0) grouped as major_line "1" because
# the fix lands in 1.x, while the repo's only copy resolved at 0.2.5, held
# there by a pre-existing bare override. The only possible fix crossed a
# major, validate's other-line check had to reject the intended move itself,
# and the user had approved doomed work. Each example below asserts the
# verdict through the routing — the group landing in `skipped` with its
# reason, or staying actionable — not just the annotation, per the repo
# doctrine.
#
# Zero network and zero installs: the adapter is a stub the spec writes,
# answering `resolved_versions` and `compare_versions` with canned JSON per
# package. Version ordering still goes through the adapter verb, exactly as
# the script does against the real one. Its contract anchors are the real
# adapter's own specs: `spec/node_lockfiles_spec.sh` pins what `node.sh
# resolved_versions` actually replies with, and `spec/node_semver_spec.sh`
# pins what `node.sh compare_versions` actually replies with — this stub's
# shapes are drawn from those, not invented independently.

Describe 'classify-lines.sh'
  STUB="$SHELLSPEC_WORKDIR/classify-stub-adapter.sh"
  REPO_ROOT="$SHELLSPEC_WORKDIR"
  CALL_LOG="$SHELLSPEC_WORKDIR/call-log"
  export CALL_LOG

  stub_adapter() {
    : > "$CALL_LOG"
    cat > "$STUB" <<'STUB_EOF'
#!/bin/sh
verb=$1; shift
if [ -n "${CALL_LOG:-}" ]; then printf '%s %s\n' "$verb" "$*" >> "$CALL_LOG"; fi
case "$verb" in
  detect)
    if [ -n "${STUB_DETECT_BROKEN:-}" ]; then
      printf '{"error":"detect: no lockfile found"}\n' >&2
      exit 1
    fi
    printf '{"pm":"npm","ecosystem":"npm","override_location":"%s"}\n' "${STUB_LOC:-overrides}" ;;
  declared_ranges)
    # $1 is --line, $2 the major, $3 the package.
    case "$3 $2" in
      "duped 1")
        printf '{"parents_read":["alpha"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["beta"]}\n' ;;
      "duped 2")
        printf '{"parents_read":["beta"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["alpha"]}\n' ;;
      "sep-ok 5")
        printf '{"parents_read":["minimatch"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["minimatch@3.1.5"]}\n' ;;
      "sep-ok 1")
        printf '{"parents_read":[],"parents_without_range":[],"parents_unreadable":["minimatch"],"parents_other_lines":["minimatch@10.2.5"]}\n' ;;
      "same-copy 5")
        printf '{"parents_read":["minimatch"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["minimatch@3.1.5"]}\n' ;;
      "same-copy 1")
        printf '{"parents_read":["minimatch"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["minimatch@3.1.5"]}\n' ;;
      "scoped-copy 5")
        printf '{"parents_read":["@npmcli/map-workspaces"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["@npmcli/map-workspaces@2.0.4"]}\n' ;;
      "scoped-copy 10")
        printf '{"parents_read":["@npmcli/map-workspaces"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["@npmcli/map-workspaces@2.0.4"]}\n' ;;
      "null-copy 5")
        printf '{"parents_read":["minimatch"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["minimatch"]}\n' ;;
      "null-copy 1")
        printf '{"parents_read":["minimatch"],"parents_without_range":[],"parents_unreadable":[],"parents_other_lines":["minimatch"]}\n' ;;
      "dr-broken "*)
        printf '{"error":"declared_ranges: parser refused the lockfile"}\n' >&2
        exit 1 ;;
      *)
        printf '{"error":"unexpected declared_ranges %s"}\n' "$*" >&2
        exit 1 ;;
    esac ;;
  resolved_versions)
    case "$1" in
      path-to-regexp)
        printf '{"pm":"npm","package":"path-to-regexp","present":true,"count":1,"versions":[{"version":"0.2.5","path":"node_modules/path-to-regexp"}],"lockfile_entries":10}\n' ;;
      lodash)
        printf '{"pm":"npm","package":"lodash","present":true,"count":1,"versions":[{"version":"4.17.21","path":"node_modules/lodash"}],"lockfile_entries":10}\n' ;;
      @babel/traverse)
        printf '{"pm":"npm","package":"@babel/traverse","present":true,"count":1,"versions":[{"version":"7.23.2","path":"node_modules/@babel/traverse"}],"lockfile_entries":10}\n' ;;
      express)
        printf '{"pm":"npm","package":"express","present":true,"count":1,"versions":[{"version":"5.1.0","path":"node_modules/express"}],"lockfile_entries":10}\n' ;;
      minimatch)
        printf '{"pm":"npm","package":"minimatch","present":true,"count":2,"versions":[{"version":"3.1.2","path":"node_modules/minimatch"},{"version":"5.1.6","path":"node_modules/glob/node_modules/minimatch"}],"lockfile_entries":10}\n' ;;
      ghost)
        printf '{"pm":"npm","package":"ghost","present":false,"count":0,"versions":[],"lockfile_entries":10}\n' ;;
      sparse)
        printf '{"pm":"npm","present":true}\n' ;;
      hollow)
        printf '{"pm":"npm","package":"hollow","present":true,"count":0,"versions":[],"lockfile_entries":10}\n' ;;
      duplo)
        printf '{"pm":"npm","package":"duplo","present":true,"count":1,"versions":[{"version":"1.0.0"}],"lockfile_entries":10}\n'
        printf '{"pm":"npm","package":"duplo","present":true,"count":1,"versions":[{"version":"1.0.0"}],"lockfile_entries":10}\n' ;;
      vbuild)
        printf '{"pm":"npm","package":"vbuild","present":true,"count":1,"versions":[{"version":"v6.2.0+build.99"}],"lockfile_entries":10}\n' ;;
      duped)
        printf '{"pm":"npm","package":"duped","present":true,"count":2,"versions":[{"version":"1.5.0"},{"version":"2.5.0"}],"lockfile_entries":10}\n' ;;
      sep-ok)
        printf '{"pm":"npm","package":"sep-ok","present":true,"count":2,"versions":[{"version":"1.1.11"},{"version":"5.0.5"}],"lockfile_entries":10}\n' ;;
      same-copy)
        printf '{"pm":"npm","package":"same-copy","present":true,"count":2,"versions":[{"version":"1.1.11"},{"version":"5.0.5"}],"lockfile_entries":10}\n' ;;
      dr-broken)
        printf '{"pm":"npm","package":"dr-broken","present":true,"count":2,"versions":[{"version":"1.1.11"},{"version":"5.0.5"}],"lockfile_entries":10}\n' ;;
      scoped-copy)
        printf '{"pm":"npm","package":"scoped-copy","present":true,"count":2,"versions":[{"version":"5.1.6"},{"version":"10.0.3"}],"lockfile_entries":10}\n' ;;
      null-copy)
        printf '{"pm":"npm","package":"null-copy","present":true,"count":2,"versions":[{"version":"1.1.11"},{"version":"5.0.5"}],"lockfile_entries":10}\n' ;;
      partial-a)
        printf '{"pm":"npm","package":"partial-a","present":true,"count":2,"versions":[{"version":"1.0.0"},{"version":"9.9.9-badcompare"}],"lockfile_entries":10}\n' ;;
      partial-b)
        printf '{"pm":"npm","package":"partial-b","present":true,"count":2,"versions":[{"version":"9.9.9-badcompare"},{"version":"10.0.0"}],"lockfile_entries":10}\n' ;;
      boom)
        printf '{"error":"resolved_versions: parser refused the lockfile"}\n' >&2
        exit 1 ;;
      *)
        printf '{"error":"unexpected package %s"}\n' "$1" >&2
        exit 1 ;;
    esac ;;
  compare_versions)
    a=$1; b=$2
    case "$a$b" in
      *9.9.9-badcompare*)
        printf '{"error":"compare_versions: unversionable input"}\n' >&2
        exit 1 ;;
    esac
    if [ "$a" = "$b" ]; then r=0
    else
      lo=$(printf '%s\n%s\n' "$a" "$b" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)
      if [ "$lo" = "$a" ]; then r=-1; else r=1; fi
    fi
    printf '{"a":"%s","b":"%s","result":%s}\n' "$a" "$b" "$r" ;;
  *)
    printf '{"error":"unexpected verb %s"}\n' "$verb" >&2
    exit 1 ;;
esac
STUB_EOF
    chmod +x "$STUB"
  }

  Before 'stub_adapter'

  # One actionable group for the stubbed package, on the given line, inside
  # the routed-discovery envelope select-adapter.sh emits.
  envelope() {
    jq -nc --arg pkg "$1" --arg line "$2" --arg a "$STUB" \
      '{actionable: [{package: $pkg, major_line: $line, ecosystem: "npm",
                      adapter_path: $a, branch_name: "sec/\($pkg)-\($line)"}],
        skipped: [{package: "old", reason: "no fix available"}],
        skipped_repos: [{repo: "octo/readonly", reason: "no push access"}]}'
  }

  classify() {
    _filter=$1; _pkg=$2; _line=$3
    shift 3
    _st=0
    _out=$(envelope "$_pkg" "$_line" \
      | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" "$@") || _st=$?
    if [ -n "$_out" ]; then
      printf '%s' "$_out" | jq -c "$_filter"
    fi
    return "$_st"
  }

  # The issue #101 shape. The verdict is the routing: the group is no longer
  # actionable, and sits in `skipped` under the reason the report reads, with
  # the annotation that lets it say "only 0.2.5 is installed; the fix line
  # is 1.x".
  Describe 'the path-to-regexp field case (issue #101)'
    It 'moves the group to skipped with reason "requires major version bump"'
      When call classify '{actionable_count: (.actionable | length), moved: [.skipped[] | select(.package == "path-to-regexp") | {package, reason, resolved_majors, line_status}]}' path-to-regexp 1
      The status should be success
      The output should equal '{"actionable_count":0,"moved":[{"package":"path-to-regexp","reason":"requires major version bump","resolved_majors":["0"],"line_status":"requires_major_bump"}]}'
    End
  End

  Describe 'a copy resolved on the line'
    It 'stays actionable as line_status "resolved"'
      When call classify '{actionable: [.actionable[] | {package, line_status, resolved_majors}], skipped_count: (.skipped | length)}' lodash 4
      The status should be success
      The output should equal '{"actionable":[{"package":"lodash","line_status":"resolved","resolved_majors":["4"]}],"skipped_count":1}'
    End
  End

  Describe 'no copy on the line but one at-or-above it'
    It 'stays actionable as line_status "line_absent"'
      When call classify '{actionable: [.actionable[] | {package, line_status, resolved_majors}], skipped_count: (.skipped | length)}' express 4
      The status should be success
      The output should equal '{"actionable":[{"package":"express","line_status":"line_absent","resolved_majors":["5"]}],"skipped_count":1}'
    End

    # Two copies, one below and one above the line: not every copy is below,
    # so the group is not a dead end — the at-or-above copy means the fix
    # would no-op there and validate settles it.
    It 'classifies a mixed below/above resolution as line_absent, not a dead end'
      When call classify '[.actionable[].line_status]' minimatch 4
      The status should be success
      The output should equal '["line_absent"]'
    End
  End

  # Every route to "unknown" stays actionable: dispatching an unknown is safe
  # (validate fail-closes later), while withholding a fixable group on a
  # broken read is the wrong direction.
  Describe 'the unknown routes stay actionable'
    Parameters
      'an adapter that fails'                        boom   2
      'a package the lockfile does not carry'        ghost  2
      'a reply missing the promised versions field'  sparse 2
      'a group with no usable line'                  lodash none
    End

    It "keeps $1 actionable as line_status unknown"
      When call classify '{statuses: [.actionable[].line_status], skipped_count: (.skipped | length)}' "$2" "$3"
      The status should be success
      The output should equal '{"statuses":["unknown"],"skipped_count":1}'
    End
  End

  Describe 'envelope integrity'
    multi() {
      jq -nc --arg a "$STUB" \
        '{actionable: [
            {package: "path-to-regexp", major_line: "1", ecosystem: "npm", adapter_path: $a},
            {package: "lodash", major_line: "4", ecosystem: "npm", adapter_path: $a},
            {package: "express", major_line: "4", ecosystem: "npm", adapter_path: $a}],
          skipped: [{package: "old", reason: "no fix available"}],
          skipped_repos: [{repo: "octo/readonly", reason: "no push access"}]}' \
        | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" | jq -c "$1"
    }

    It 'classifies each group of a multi-package envelope on its own facts'
      When call multi '{actionable: [.actionable[] | {package, line_status}], moved: [.skipped[] | select(.reason == "requires major version bump") | .package]}'
      The status should be success
      The output should equal '{"actionable":[{"package":"lodash","line_status":"resolved"},{"package":"express","line_status":"line_absent"}],"moved":["path-to-regexp"]}'
    End

    # A caller reads one list: the entries discovery and select-adapter
    # already filed must survive this stage untouched, skipped_repos with
    # them.
    It 'passes pre-existing skipped and skipped_repos through untouched'
      When call multi '{skipped_first: .skipped[0], skipped_repos}'
      The status should be success
      The output should equal '{"skipped_first":{"package":"old","reason":"no fix available"},"skipped_repos":[{"repo":"octo/readonly","reason":"no push access"}]}'
    End

    It 'requires --repo-root'
      When run sh -c "printf '{\"actionable\":[],\"skipped\":[]}' | '$COMMON/classify-lines.sh'"
      The status should not equal 0
      The stderr should include '"error"'
    End

    It 'rejects non-JSON on stdin'
      When run sh -c "printf 'not json' | '$COMMON/classify-lines.sh' --repo-root '$REPO_ROOT'"
      The status should not equal 0
      The stderr should include '"error"'
    End

    # Valid JSON of the wrong shape must surface through the error contract,
    # not as raw jq noise (the select-adapter.sh precedent, issue #39).
    It 'reports well-formed JSON of the wrong shape through the error contract'
      When run sh -c "printf '{\"actionable\":\"oops\",\"skipped\":[]}' | '$COMMON/classify-lines.sh' --repo-root '$REPO_ROOT'"
      The status should not equal 0
      The stdout should equal ''
      The stderr should include '"error":"Failed to read actionable groups'
    End

    It 'reports an empty classify_errors[] when every adapter call succeeds'
      When call multi '.classify_errors'
      The status should be success
      The output should equal '[]'
    End
  End

  # A reply of two JSON documents on one exit-0 stdout is a broken read, not
  # "the object we asked for, plus noise": unslurped, the second document
  # made the cache-building jq call choke on a multi-value string and crash
  # with raw jq noise and exit 2, never the {"error": ...} contract requires
  # (ADR 001).
  Describe 'a multi-document adapter reply'
    It 'classifies the group unknown rather than crashing on raw jq noise'
      When call classify '{status: .actionable[0].line_status, skipped_count: (.skipped | length)}' duplo 1
      The status should be success
      The output should equal '{"status":"unknown","skipped_count":1}'
    End
  End

  # This script reads one lockfile at --repo-root; an envelope whose
  # actionable groups span more than one repo would classify, and could
  # withdraw, a second repo's groups off the first repo's lockfile.
  Describe 'a multi-repo envelope'
    two_repo_envelope() {
      jq -nc --arg a "$STUB" \
        '{actionable: [
            {package: "lodash", major_line: "4", ecosystem: "npm", adapter_path: $a, repo: "octo/app"},
            {package: "express", major_line: "4", ecosystem: "npm", adapter_path: $a, repo: "octo/other"}],
          skipped: []}'
    }

    classify_two_repos() {
      two_repo_envelope | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT"
    }

    It 'hard-errors rather than classifying two repos off one lockfile'
      When call classify_two_repos
      The status should not equal 0
      The stderr should include '"error"'
      The stderr should include 'more than one repo'
    End
  End

  # "Zero resolved versions is an error, never a pass" (scripts/CLAUDE.md).
  # present: true backed by versions: [] is the parser-failure shape that
  # rule warns about, not a legitimate empty answer, and it must never reach
  # the compare loop through a single-empty-string herestring iteration and
  # land requires_major_bump on nothing.
  Describe 'present true with zero resolved versions'
    It 'classifies unknown rather than requires_major_bump'
      When call classify '{statuses: [.actionable[].line_status], moved: [.skipped[] | select(.reason == "requires major version bump")]}' hollow 4
      The status should be success
      The output should equal '{"statuses":["unknown"],"moved":[]}'
    End
  End

  # A broken adapter call otherwise turns every group unknown with nothing
  # naming the cause (the check-advisories.sh adapter_errors[] precedent).
  Describe 'classify_errors surfaces a broken adapter call'
    It 'names the package and first stderr line for a failing resolved_versions call'
      When call classify '{errs: [.classify_errors[] | {package, error}]}' boom 2
      The status should be success
      The output should equal '{"errs":[{"package":"boom","error":"{\"error\":\"resolved_versions: parser refused the lockfile\"}"}]}'
    End
  End

  # Compare-failure partial reads: a version's copy establishes nothing on
  # its own, and whichever order the copies arrive in, one broken compare
  # must make the whole group unknown.
  Describe 'a compare_versions failure mid-loop'
    It 'classifies unknown when a below reading is followed by a compare error'
      When call classify '{status: .actionable[0].line_status, errs: [.classify_errors[] | .package]}' partial-a 5
      The status should be success
      The output should equal '{"status":"unknown","errs":["partial-a"]}'
    End

    # Pins the `[ "$status" = "unknown" ] ||` guard: once a compare error has
    # already set the group unknown, a later at-or-above reading must not
    # revert it to line_absent.
    It 'stays unknown when an at-or-above reading follows a compare error, never reverting to line_absent'
      When call classify '{status: .actionable[0].line_status, errs: [.classify_errors[] | .package]}' partial-b 5
      The status should be success
      The output should equal '{"status":"unknown","errs":["partial-b"]}'
    End
  End

  # Forces the stub's own compare/extraction path to stay honest about a
  # version shape it has to handle correctly, and pins MAJOR_OF_JQ's trim
  # rule against the same shape.
  Describe 'a v-prefixed, build-metadata resolved version'
    It 'trims to a plain major and classifies resolved'
      When call classify '{status: .actionable[0].line_status, majors: .actionable[0].resolved_majors}' vbuild 6
      The status should be success
      The output should equal '{"status":"resolved","majors":["6"]}'
    End
  End

  # One resolved_versions call per unique (adapter_path, package): two groups
  # for the same package, on different lines, must not double the adapter
  # call, and must still classify independently.
  Describe 'a duplicate-package envelope'
    duped_multi() {
      jq -nc --arg a "$STUB" \
        '{actionable: [
            {package: "duped", major_line: "1", ecosystem: "npm", adapter_path: $a},
            {package: "duped", major_line: "2", ecosystem: "npm", adapter_path: $a}],
          skipped: []}' \
        | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" | jq -c "$1"
    }

    duped_call_count() {
      jq -nc --arg a "$STUB" \
        '{actionable: [
            {package: "duped", major_line: "1", ecosystem: "npm", adapter_path: $a},
            {package: "duped", major_line: "2", ecosystem: "npm", adapter_path: $a}],
          skipped: []}' \
        | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" >/dev/null
      grep -c '^resolved_versions duped$' "$CALL_LOG"
    }

    It 'classifies each line of the shared package independently'
      When call duped_multi '[.actionable[] | {major_line, line_status}]'
      The status should be success
      The output should equal '[{"major_line":"1","line_status":"resolved"},{"major_line":"2","line_status":"resolved"}]'
    End

    It 'calls resolved_versions exactly once for the shared package, despite two groups'
      When call duped_call_count
      The status should be success
      The output should equal '1'
    End
  End

  # Issue #132: a package resolved on several major lines whose sibling
  # lines share a parent name. The field case is brace-expansion at majors
  # 1/2/5 under minimatch copies at two majors: every group's bare npm parent
  # key dragged the sibling lines, each agent burned a worktree + install +
  # validate cycle, and all failed closed on the same fact. apply_constraint
  # now writes version-qualified parent keys for npm and pnpm, so the ONLY
  # shapes withdrawn here are the ones qualification cannot express: any
  # shared parent name under yarn `resolutions` (its key cannot carry a
  # parent version), and a single parent copy resolving the package on two
  # majors at once (the entry sits in parents_other_lines of EVERY line's
  # query). Everything else must stay actionable. The verdict is asserted
  # through the routing, exactly like the requires_major_bump examples.
  Describe 'the cross-line shared-parent collision (issue #132)'
    It 'keeps a qualification-separable shared parent actionable'
      When call classify '{actionable: [.actionable[] | {package, line_status}], skipped_count: (.skipped | length), errs: .classify_errors}' sep-ok 5
      The status should be success
      The output should equal '{"actionable":[{"package":"sep-ok","line_status":"resolved"}],"skipped_count":1,"errs":[]}'
    End

    It 'skips the same-copy-on-two-majors shape with the shared-parent reason'
      When call classify '{actionable_count: (.actionable | length), moved: [.skipped[] | select(.package == "same-copy") | {package, reason, line_status, collision_parents}]}' same-copy 5
      The status should be success
      The output should equal '{"actionable_count":0,"moved":[{"package":"same-copy","reason":"shared parent across major lines","line_status":"cross_line_collision","collision_parents":["minimatch"]}]}'
    End

    # yarn resolutions cannot version-qualify at all, so the separable shape
    # npm keeps actionable is the collapse shape there.
    classify_yarn() {
      STUB_LOC=resolutions
      export STUB_LOC
      classify "$@"
      _st=$?
      unset STUB_LOC
      return "$_st"
    }

    It 'skips any shared parent name under yarn resolutions'
      When call classify_yarn '{actionable_count: (.actionable | length), moved: [.skipped[] | select(.package == "sep-ok") | {reason, collision_parents}]}' sep-ok 5
      The status should be success
      The output should equal '{"actionable_count":0,"moved":[{"reason":"shared parent across major lines","collision_parents":["minimatch"]}]}'
    End

    # Withdrawing on a broken read is this stage's one unsafe act: a failing
    # declared_ranges leaves the group dispatched (validate fail-closes
    # later) and names what broke.
    It 'keeps the group actionable and names the error when declared_ranges fails'
      When call classify '{statuses: [.actionable[].line_status], errs: [.classify_errors[] | {package, error}]}' dr-broken 5
      The status should be success
      The output should equal '{"statuses":["resolved"],"errs":[{"package":"dr-broken","error":"{\"error\":\"declared_ranges: parser refused the lockfile\"}"}]}'
    End

    # Two groups of the same package must not double the new reads: one
    # detect per adapter, one declared_ranges per (package, line), exactly
    # like the resolved_versions cache above.
    collision_call_counts() {
      jq -nc --arg a "$STUB" \
        '{actionable: [
            {package: "sep-ok", major_line: "1", ecosystem: "npm", adapter_path: $a},
            {package: "sep-ok", major_line: "5", ecosystem: "npm", adapter_path: $a}],
          skipped: []}' \
        | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" >/dev/null
      printf 'detect=%s line1=%s line5=%s\n' \
        "$(grep -c '^detect $' "$CALL_LOG")" \
        "$(grep -c -- '^declared_ranges --line 1 sep-ok$' "$CALL_LOG")" \
        "$(grep -c -- '^declared_ranges --line 5 sep-ok$' "$CALL_LOG")"
    }

    It 'caches the detect and declared_ranges reads across sibling groups'
      When call collision_call_counts
      The status should be success
      The output should equal 'detect=1 line1=1 line5=1'
    End

    # A broken detect is the same rule as a broken declared_ranges: the
    # group stays dispatched and the error is named, because withdrawing on
    # a broken read is this stage's one unsafe act.
    classify_broken_detect() {
      STUB_DETECT_BROKEN=1
      export STUB_DETECT_BROKEN
      classify "$@"
      _st=$?
      unset STUB_DETECT_BROKEN
      return "$_st"
    }

    It 'keeps the group actionable and names the error when detect fails'
      When call classify_broken_detect '{statuses: [.actionable[].line_status], errs: [.classify_errors[] | {package, error}]}' sep-ok 5
      The status should be success
      The output should equal '{"statuses":["resolved"],"errs":[{"package":"sep-ok","error":"{\"error\":\"detect: no lockfile found\"}"}]}'
    End

    # A scoped parent entry splits on its LAST @: the leading @ of the scope
    # is index 0 and never splits, so `@npmcli/map-workspaces@2.0.4` names
    # the parent `@npmcli/map-workspaces`.
    It 'skips a scoped shared parent and names it without its version'
      When call classify '{moved: [.skipped[] | select(.package == "scoped-copy") | {reason, collision_parents}]}' scoped-copy 5
      The status should be success
      The output should equal '{"moved":[{"reason":"shared parent across major lines","collision_parents":["@npmcli/map-workspaces"]}]}'
    End

    # A version-less entry riding the intersection is the conservative
    # branch: a copy no version can name is a copy no qualifier can
    # exclude, so it skips like the same-copy shape.
    It 'skips a version-less shared parent entry conservatively'
      When call classify '{moved: [.skipped[] | select(.package == "null-copy") | {reason, collision_parents}]}' null-copy 5
      The status should be success
      The output should equal '{"moved":[{"reason":"shared parent across major lines","collision_parents":["minimatch"]}]}'
    End
  End

  # An unknown group is still annotated, not left bare: a caller building the
  # skip report reads resolved_majors regardless of line_status.
  Describe 'resolved_majors on an unknown group'
    It 'is present as an empty array'
      When call classify '.actionable[0].resolved_majors' boom 2
      The status should be success
      The output should equal '[]'
    End
  End

  # Issue #123 at cross-repo scope: a remote branch literally named `fix`
  # rejects every `fix/*` push with a `(directory file conflict)`, and the
  # orchestrator learns it per repo only in phase 5, after discovery has
  # already named every branch. This script is the one stage that runs once
  # per repo with that repo's groups on stdin, so `--branch-style flat` here
  # is where the flip lands: the rewritten `branch_name` is what the dispatch
  # payload carries, and the fix agents consume it verbatim.
  Describe 'the flat branch rewrite (issue #123)'
    plugin_envelope() {
      jq -nc --arg a "$STUB" \
        '{actionable: [{package: "lodash", major_line: "4", ecosystem: "npm",
                        adapter_path: $a,
                        branch_name: "fix/dependabot-lodash-4x"}],
          skipped: [{package: "left-pad", reason: "no fix available",
                     branch_name: "fix/dependabot-left-pad-unfixed"}]}'
    }

    classify_plugin() {
      _filter=$1
      shift
      _st=0
      _out=$(plugin_envelope \
        | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" "$@") || _st=$?
      if [ -n "$_out" ]; then
        printf '%s' "$_out" | jq -c "$_filter"
      fi
      return "$_st"
    }

    It 'rewrites actionable and skipped names under --branch-style flat'
      When call classify_plugin '{a: [.actionable[].branch_name], s: [.skipped[].branch_name]}' --branch-style flat
      The status should be success
      The output should equal '{"a":["fix-dependabot-lodash-4x"],"s":["fix-dependabot-left-pad-unfixed"]}'
    End

    It 'accepts the --branch-style=flat equals-form, consistent with discover-alerts.sh'
      When call classify_plugin '{a: [.actionable[].branch_name], s: [.skipped[].branch_name]}' --branch-style=flat
      The status should be success
      The output should equal '{"a":["fix-dependabot-lodash-4x"],"s":["fix-dependabot-left-pad-unfixed"]}'
    End

    # Scoped package names are not sanitized anywhere in the pipeline: the
    # rewrite is a literal prefix substitution, so a scoped package's own `/`
    # rides straight through in both styles. Pin what the code actually
    # produces (discover-alerts.sh's slash-style output is the input here).
    scoped_envelope() {
      jq -nc --arg a "$STUB" \
        '{actionable: [{package: "@babel/traverse", major_line: "7", ecosystem: "npm",
                        adapter_path: $a,
                        branch_name: "fix/dependabot-@babel/traverse-7x"}],
          skipped: []}'
    }

    classify_scoped() {
      _filter=$1
      shift
      _st=0
      _out=$(scoped_envelope \
        | "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" "$@") || _st=$?
      if [ -n "$_out" ]; then
        printf '%s' "$_out" | jq -c "$_filter"
      fi
      return "$_st"
    }

    It 'rewrites a scoped package name to the flat prefix without sanitizing the internal slash'
      When call classify_scoped '[.actionable[].branch_name]' --branch-style flat
      The status should be success
      The output should equal '["fix-dependabot-@babel/traverse-7x"]'
    End

    # The regression pin: without the flag nothing is renamed, so the
    # ordinary run's dispatch names stay byte-identical to discovery's.
    It 'leaves every name untouched by default'
      When call classify_plugin '{a: [.actionable[].branch_name], s: [.skipped[].branch_name]}'
      The status should be success
      The output should equal '{"a":["fix/dependabot-lodash-4x"],"s":["fix/dependabot-left-pad-unfixed"]}'
    End

    # The rewrite is targeted at the plugin's own prefix, never a general
    # slash-flattening: another tool's branch name passes through even when
    # the flag is set.
    It 'passes a non-plugin branch name through unchanged under flat'
      When call classify '[.actionable[].branch_name]' lodash 4 --branch-style flat
      The status should be success
      The output should equal '["sec/lodash-4"]'
    End

    It 'rejects an unknown branch style'
      When run script "$COMMON/classify-lines.sh" --repo-root "$REPO_ROOT" --branch-style diagonal
      The status should be failure
      The stderr should include 'Unknown branch style'
    End
  End

  # The orchestration halves of the fix: the sentences SKILL.md acts on,
  # pinned the way spec/audit_pins_rules_spec.sh pins agent prose.
  Describe 'the SKILL.md prose that consumes the classification'
    SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"

    phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }

    It 'pipes phase 2 discovery through classify-lines.sh at repo scope'
      When call phrase_in "$SKILL" 'classify-lines.sh --repo-root <repo_root>'
      The status should be success
      The output should equal '2'
    End

    It 'withdraws a post-approval requires_major_bump group in phase 5'
      When call phrase_in "$SKILL" 'withdrawn from the phase 6 queue'
      The status should be success
      The output should equal '1'
    End

    It 'never offers a requires-major-bump group as a rankable row in phase 3'
      When call phrase_in "$SKILL" 'never as a rankable row'
      The status should be success
      The output should equal '1'
    End

    It 'reports both requires_major_bump senses together, first, in phase 7'
      When call phrase_in "$SKILL" 'two different senses of the same name'
      The status should be success
      The output should equal '1'
    End
  End
End
