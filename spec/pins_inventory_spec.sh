#!/bin/sh
# shellcheck shell=sh
# Keeps spec/PINS.md and the mechanical-pin markers honest (issue #197).
#
# Every `phrase_in`/`count_in`/`rule_in` prose-pin example in spec/ must be
# either marked `# pin: mechanical, retired by <script>` directly above its
# `It` line, or accounted for in spec/PINS.md as `judgment`. A pin that is
# neither is invisible to the one-grep retirement promise in PINS.md's own
# header, and a marker naming a script that was never proposed is a false
# trail for whichever PR comes looking for it.
#
# The two checks below are independent: "every marker names a real successor
# script" catches a typo or an invented name; "every prose-pin example nets
# out to (its file's marker count) + (its file's judgment count)" catches a
# pin added, removed, or reclassified without PINS.md following it. Neither
# needs the file's exact `It` text, only counts, so both stay dialect-safe
# and immune to a title being reworded in a later tightening pass.

Describe 'the prose pin inventory (issue #197)'
  SPEC_DIR="$SHELLSPEC_PROJECT_ROOT/spec"
  PINS="$SPEC_DIR/PINS.md"

  # The seven successor scripts issue #193 names. Not a superset from
  # elsewhere in the repo: a marker naming a real script this list omits is
  # exactly the drift this spec exists to catch.
  SUCCESSORS='prepare-checkout.sh
merge-envelopes.sh
preflight-repo.sh
build-dispatches.sh
reap-batch.sh
summarize-run.sh
pr-status.sh --env-prefix'

  # The 14 files issue #197 scoped this inventory to (confirmed against
  # `grep -l` in the issue's own working notes). A file added to this list
  # without a PINS.md section fails the second Describe below by name.
  Parameters
    resolve_alerts_scope_spec.sh
    resolve_alerts_branch_style_spec.sh
    audit_pins_scratch_spec.sh
    resolve_alerts_dispatch_spec.sh
    audit_pins_rules_spec.sh
    reap_agent_artifacts_spec.sh
    resolve_alerts_defect_reports_spec.sh
    merge_risk_labels_spec.sh
    classify_lines_spec.sh
    fix_dependency_result_spec.sh
    fix_dependency_baseline_spec.sh
    fix_dependency_branch_spec.sh
    fix_dependency_scratch_spec.sh
    env_prefix_seam_spec.sh
  End

  # Every spec file except this one: this file's own comments and code
  # necessarily quote the marker grammar verbatim, which would otherwise
  # match itself.
  other_spec_files() {
    for f in "$SPEC_DIR"/*.sh; do
      case "$f" in
        */pins_inventory_spec.sh) ;;
        *) printf '%s\n' "$f" ;;
      esac
    done
  }

  # Every mechanical marker's successor name, across all of spec/ (this file
  # excepted), one per line.
  marker_scripts() {
    other_spec_files | while IFS= read -r f; do
      grep -ho 'pin: mechanical, retired by .*' "$f"
    done | sed 's/^pin: mechanical, retired by //'
  }

  # Marker names not found, verbatim, among the seven successors.
  unrecognized_successors() {
    marker_scripts | while IFS= read -r script; do
      printf '%s\n' "$SUCCESSORS" | grep -qxF "$script" || printf '%s\n' "$script"
    done
  }

  It 'names one of the seven #193 successor scripts on every mechanical marker'
    When call unrecognized_successors
    The output should equal ''
  End

  It 'carries at least one mechanical marker' # positive control: a scan
    # finding nothing would pass the check above vacuously.
    When call marker_scripts
    The status should be success
    The output should not equal ''
  End

  # Every `It` block in one spec file that is a prose pin: it calls
  # phrase_in, count_in or rule_in, or it greps/awks one of the file's own
  # SKILL.md/agent/command path variables (declared as
  # `VAR="$SHELLSPEC_PROJECT_ROOT/....md"`) the way
  # spec/reap_agent_artifacts_spec.sh's ad hoc `no_reap_script_mentions` and
  # spec/audit_pins_rules_spec.sh's locally named `rule()` do. Counted once
  # per block regardless of how many times a match recurs inside it.
  pin_example_count() {
    f="$SPEC_DIR/$1"
    # A path variable, not specifically the project-root one: this file's
    # own such assignment two lines up would otherwise make SC2016 read the
    # literal name in a fixed pattern as a forgotten expansion.
    file_vars=$(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*="[^"]*\.md"$' "$f" \
      | sed -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/\1/' | sort -u)
    varpat=$(printf '%s\n' "$file_vars" | paste -sd'|' -)
    pat='phrase_in|count_in|rule_in'
    if [ -n "$varpat" ]; then
      # Two literal backslashes: awk -v unescapes one level, so the regex
      # it evaluates ends up with the single \$( that matches a quoted
      # "$VAR" reference.
      pat="$pat|\\\\\$($varpat)"
    fi
    awk -v pat="$pat" '
      /^[ \t]*It / { in_it = 1; has = 0 }
      in_it && $0 ~ pat { has = 1 }
      in_it && /^[ \t]*End[ \t]*$/ {
        if (has) n++
        in_it = 0
      }
      END { print n + 0 }
    ' "$f"
  }

  # Mechanical markers physically present in the file (ground truth for
  # "retired by" grep, independent of what PINS.md claims).
  marker_count_in_file() {
    grep -c 'pin: mechanical, retired by ' "$SPEC_DIR/$1" || true
  }

  # The PINS.md section for one file: every line between its own
  # `### `spec/<file>`` heading and the next heading (or EOF).
  pins_section() {
    awk -v want="### \`spec/$1\`" '
      index($0, want) == 1 { grab = 1; next }
      grab && index($0, "### ") == 1 { grab = 0 }
      grab { print }
    ' "$PINS"
  }

  pins_judgment_count() {
    pins_section "$1" | grep -c '| judgment | -' || true
  }

  pins_mechanical_count() {
    pins_section "$1" | grep -c '| mechanical | ' || true
  }

  # file, live-marker-count, live-example-count, PINS-judgment-count,
  # PINS-mechanical-count, tab separated, for a single failure message that
  # shows all four numbers at once rather than one bare mismatch.
  pin_totals() {
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$(marker_count_in_file "$1")" \
      "$(pin_example_count "$1")" \
      "$(pins_judgment_count "$1")" \
      "$(pins_mechanical_count "$1")" \
      "$1"
  }

  # Every live example is either a marked mechanical pin or a PINS.md
  # judgment row: marker-count + judgment-count must equal the example
  # count. And PINS.md's own mechanical count must match the markers
  # actually in the file, so PINS.md cannot drift from the markers it
  # documents.
  reconciled() {
    line=$(pin_totals "$1")
    markers=$(printf '%s' "$line" | cut -f1)
    examples=$(printf '%s' "$line" | cut -f2)
    judgment=$(printf '%s' "$line" | cut -f3)
    pins_mech=$(printf '%s' "$line" | cut -f4)
    if [ "$((markers + judgment))" -eq "$examples" ] && [ "$markers" -eq "$pins_mech" ]; then
      echo reconciled
    else
      printf 'unreconciled markers=%s examples=%s judgment=%s pins_mechanical=%s\n' \
        "$markers" "$examples" "$judgment" "$pins_mech"
    fi
  }

  It "keeps every phrase_in/count_in/rule_in example in \$1 marked or inventoried"
    When call reconciled "$1"
    The output should equal 'reconciled'
  End
End
