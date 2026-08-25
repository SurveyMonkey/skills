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
if [ -n "${CALL_LOG:-}" ]; then printf '%s %s\n' "$verb" "${1:-}" >> "$CALL_LOG"; fi
case "$verb" in
  resolved_versions)
    case "$1" in
      path-to-regexp)
        printf '{"pm":"npm","package":"path-to-regexp","present":true,"count":1,"versions":[{"version":"0.2.5","path":"node_modules/path-to-regexp"}],"lockfile_entries":10}\n' ;;
      lodash)
        printf '{"pm":"npm","package":"lodash","present":true,"count":1,"versions":[{"version":"4.17.21","path":"node_modules/lodash"}],"lockfile_entries":10}\n' ;;
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

  # An unknown group is still annotated, not left bare: a caller building the
  # skip report reads resolved_majors regardless of line_status.
  Describe 'resolved_majors on an unknown group'
    It 'is present as an empty array'
      When call classify '.actionable[0].resolved_majors' boom 2
      The status should be success
      The output should equal '[]'
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
