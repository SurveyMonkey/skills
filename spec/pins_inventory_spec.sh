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
#
# The reconciliation check discovers spec files itself (other_spec_files)
# rather than checking a fixed list: a fixed list only catches drift in the
# files someone remembers to add to it, so a brand-new spec file that gains
# a phrase_in/count_in/rule_in example the day it is written would otherwise
# be invisible to this gate until somebody thought to list it here.

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
    # A one-line ad hoc helper that greps a literal doc-file path directly,
    # never assigning it to a path variable first (spec/node_apply_constraint_spec.sh's
    # `definition()`, which greps fix-dependency.md inline). Named the same
    # way file_vars is: the declaring line, not the call site, so a helper
    # declared once and called from several `It` blocks is found from either.
    inline_fns=$(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{.*\.md"' "$f" \
      | sed -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)\(\).*/\1/' | sort -u)
    fnpat=$(printf '%s\n' "$inline_fns" | paste -sd'|' -)
    pat='phrase_in|count_in|rule_in'
    if [ -n "$varpat" ]; then
      # Two literal backslashes: awk -v unescapes one level, so the regex
      # it evaluates ends up with the single \$( that matches a quoted
      # "$VAR" reference.
      pat="$pat|\\\\\$($varpat)"
    fi
    if [ -n "$fnpat" ]; then
      # No \< \> word boundaries: BSD awk (the macOS default) does not
      # support them. A bare substring match is safe here because the name
      # comes from an actual declared helper in this same file, not a guess.
      pat="$pat|($fnpat)"
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
  # `### `spec/<file>`` heading and the next heading (or EOF). A file with
  # no such heading (nothing to reconcile) yields an empty section.
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
  # documents. A file with zero examples and no PINS.md section reconciles
  # trivially (0 + 0 == 0), so this needs no exclusion list of its own.
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

  # Every spec file (this one excepted), discovered dynamically rather than
  # from a fixed list, that is not reconciled: "<file>: <reconciled's own
  # unreconciled message>", one per offending file. Empty when every file
  # reconciles.
  unreconciled_files() {
    other_spec_files | while IFS= read -r f; do
      name=$(basename "$f")
      result=$(reconciled "$name")
      [ "$result" = reconciled ] || printf '%s: %s\n' "$name" "$result"
    done
  }

  It 'keeps every phrase_in/count_in/rule_in example, in every spec file, marked or inventoried'
    When call unreconciled_files
    The output should equal ''
  End
End
