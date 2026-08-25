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
# the script does against the real one.

Describe 'classify-lines.sh'
  STUB="$SHELLSPEC_WORKDIR/classify-stub-adapter.sh"
  REPO_ROOT="$SHELLSPEC_WORKDIR"

  stub_adapter() {
    cat > "$STUB" <<'STUB_EOF'
#!/bin/sh
verb=$1; shift
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
      boom)
        printf '{"error":"resolved_versions: parser refused the lockfile"}\n' >&2
        exit 1 ;;
      *)
        printf '{"error":"unexpected package %s"}\n' "$1" >&2
        exit 1 ;;
    esac ;;
  compare_versions)
    a=$1; b=$2
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
  End
End
