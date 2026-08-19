#!/usr/bin/env bash
# score-merge-risk.sh — compute the merge-risk rating for a dependency fix PR
#
# Usage:
#   score-merge-risk.sh --package <pkg> --after <version> --adapter <path>
#                       --why-json <file|-> --f4 <0|1|2> --f5 <0|1|2>
#                       --override-scope <none|scoped|bare-tightened|bare-added>
#                       --declared-range <range|none> [--declared-range <range>]...
#                       [--before <version>]
#                       [--f4-evidence <text>] [--f5-evidence <text>]
#
# Output: {score, max, band, escalated, escalation_reason, delta,
#          majors_crossed, declared_ranges, override_scope, factors: [...],
#          markdown}
#
# Seven factors, each 0-2, summed to 0-14. Bands: Low 0-3, Medium 4-6, High 7+,
# with three escalation rules: neither a major version delta nor a newly added
# unscoped override ever rates Low, and a multi-major jump on a runtime
# dependency with no test signal never rates below High.
#
# The band thresholds are absolute risk points, not proportions of the maximum,
# so they did not move when F6 was added (issue #20) and did not move for F7
# (issue #21). What changes a band is a fix that scores on the new factors or
# trips the new escalation, which is the point of adding them: the sweep case
# bork#350 goes from Medium 6 to High 7 on exactly that route. A fix that
# scores 0 on both new factors, as every direct update with a scoped override
# and at most one major line crossed does, keeps the band it had.
#
# `--declared-range` is required, with an explicit `none` sentinel for "no
# dependent range could be read". Left optional, its absence made the
# multi-major escalation unreachable without saying so, and a caller whose
# collection step half-failed looked identical to one with nothing to report.
#
# The split of labour is deliberate. F1-F3 are derivable from the repository
# and the lockfile, so they are computed here. F4 (test signal), F5
# (verification completeness) and F6 (which remediation shape was applied) are
# facts only the agent that did the work knows, so they are passed in. F7 is
# both: the caller states the ranges its dependents declared, the adapter says
# what those ranges mean, and this script decides what that is worth. This
# script applies the bands either way.
#
# F6 exists because an override touching one parent and one touching the whole
# tree used to score identically. A bare, unscoped override pins the package
# for *every* consumer, including copies that were never vulnerable, so it is
# a materially wider change than a scoped entry even when the version delta is
# the same.
#
# F7 exists because F1 saturates: it says "major" whether the fix crosses one
# major line or three, so a jump that skips a whole line used to score no
# higher than a single-major bump, and could score lower when other factors
# happened to be cleaner (issue #21). What predicts breakage is the distance
# from what the dependents declared: a parent declaring ^9 has been tested
# against 9.x and never saw 10.x at all, transitively or otherwise.
#
# Rating the *fix*, not the vulnerability. EPSS sits beside this in the PR body
# and answers the other question: how urgent is the CVE.

set -euo pipefail

PACKAGE=""
BEFORE=""
AFTER=""
ADAPTER=""
WHY_JSON=""
F4=""
F5=""
F4_EVIDENCE=""
F5_EVIDENCE=""
OVERRIDE_SCOPE=""
DECLARED_RANGES=""
DECLARED_RANGES_SEEN=false
DECLARED_RANGES_STATED=false
DECLARED_RANGES_NONE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --package)        PACKAGE="${2:?}"; shift 2 ;;
    --before)         BEFORE="${2:?}"; shift 2 ;;
    --after)          AFTER="${2:?}"; shift 2 ;;
    --adapter)        ADAPTER="${2:?}"; shift 2 ;;
    --why-json)       WHY_JSON="${2:?}"; shift 2 ;;
    --f4)             F4="${2:?}"; shift 2 ;;
    --f5)             F5="${2:?}"; shift 2 ;;
    --f4-evidence)    F4_EVIDENCE="${2:?}"; shift 2 ;;
    --f5-evidence)    F5_EVIDENCE="${2:?}"; shift 2 ;;
    --override-scope) OVERRIDE_SCOPE="${2:?}"; shift 2 ;;
    # Repeatable and required: one flag per distinct range a dependent declares
    # for the package, or the single sentinel `none`. Ranges may contain spaces
    # (">=1 <2"), so they accumulate one per line rather than space-separated.
    --declared-range)
      DECLARED_RANGES_SEEN=true
      if [ "${2:?}" = "none" ]; then
        DECLARED_RANGES_NONE=true
      else
        DECLARED_RANGES_STATED=true
        DECLARED_RANGES="${DECLARED_RANGES}${2:?}
"
      fi
      shift 2 ;;
    *) printf '{"error":"Unknown argument: %s"}\n' "$1" >&2; exit 1 ;;
  esac
done

for required in PACKAGE AFTER ADAPTER WHY_JSON F4 F5 OVERRIDE_SCOPE; do
  eval "value=\${$required}"
  if [ -z "$value" ]; then
    printf '{"error":"Missing required argument: --%s"}\n' \
      "$(printf '%s' "$required" | tr '[:upper:]' '[:lower:]' | tr '_' '-')" >&2
    exit 1
  fi
done

# The multi-major escalation is the whole point of F7, and it is unreachable
# when no ranges arrive. Omitting the flag used to be silent, which made the
# safety rule opt-in; a caller that could read no ranges now has to say so.
if [ "$DECLARED_RANGES_SEEN" != true ]; then
  printf '{"error":"Missing required argument: --declared-range. Pass one per distinct range a dependent declares, or --declared-range none if none could be read."}\n' >&2
  exit 1
fi
if [ "$DECLARED_RANGES_NONE" = true ] && [ "$DECLARED_RANGES_STATED" = true ]; then
  printf '{"error":"--declared-range none states that no ranges could be read; it cannot be combined with declared ranges"}\n' >&2
  exit 1
fi

case "$F4" in 0|1|2) ;; *) printf '{"error":"--f4 must be 0, 1, or 2"}\n' >&2; exit 1 ;; esac
case "$F5" in 0|1|2) ;; *) printf '{"error":"--f5 must be 0, 1, or 2"}\n' >&2; exit 1 ;; esac
case "$OVERRIDE_SCOPE" in
  none|scoped|bare-tightened|bare-added) ;;
  *) printf '{"error":"--override-scope must be none, scoped, bare-tightened, or bare-added"}\n' >&2
     exit 1 ;;
esac

if [ "$WHY_JSON" = "-" ]; then
  why=$(cat)
else
  why=$(cat "$WHY_JSON")
fi

# ---------------------------------------------------------------------------
# Declared ranges — asked of the adapter, because what "^9" admits is a semver
# question and the next adapter answers it under PEP 440 instead.
#
# The caller states the ranges; it does not state what they are worth. A fix
# run against a package with no readable dependents still scores, on the
# version delta alone, but it has to say `--declared-range none` to get there.
#
# Only a range the landed version escapes counts as distance. A satisfied
# range, however wide, is a dependent that declared support for the line the
# fix landed on, which is the factor's own rationale.
# ---------------------------------------------------------------------------
MAJORS_CROSSED=0
PIN_CROSSED=false
PINNED_RANGE=""
DECLARED_LIST=""
UNSATISFIED_LIST=""
UNPARSEABLE_LIST=""
UNPARSEABLE_COUNT=0

join_range() {
  if [ -z "$1" ]; then printf '%s' "$2"; else printf '%s, %s' "$1" "$2"; fi
}

contract_error() {
  printf '{"error":%s}\n' "$(printf '%s' "$1" | jq -Rs .)" >&2
  exit 1
}

# Absent is not the same as null, and only one of them is survivable. A range
# with no parseable floor legitimately reports majors_ahead: null and
# contributes nothing; a missing key means the adapter does not implement this
# side of the contract, and reading it as "0 majors ahead" would silently score
# the fix low. One pass answers both: __absent__, __null__, or the value.
read_field() {
  printf '%s' "$2" | jq -r --arg k "$1" \
    'if has($k) | not then "__absent__" elif .[$k] == null then "__null__"
     else (.[$k] | tostring) end'
}

if [ "$DECLARED_RANGES_STATED" = true ]; then
  # Duplicates are expected: several parents commonly declare the same range,
  # and repeating it in the evidence tells a reviewer nothing.
  deduped=$(printf '%s' "$DECLARED_RANGES" | awk 'NF && !seen[$0]++')
  while IFS= read -r declared; do
    [ -n "$declared" ] || continue
    facts=$("$ADAPTER" range_facts "$declared" "$AFTER")
    for field in parseable satisfied pinned majors_ahead; do
      if [ "$(read_field "$field" "$facts")" = "__absent__" ]; then
        contract_error "adapter $ADAPTER: range_facts '$declared' emitted no '$field' field. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); an adapter that cannot answer must fail, not score the fix as low risk."
      fi
    done
    parseable=$(read_field parseable "$facts")
    if [ "$parseable" != "true" ]; then
      # Not a version range at all (`workspace:^`, `latest`, a git URL). It is
      # named in the evidence so it stays visible, and it is never asserted as
      # a dependent this fix left behind.
      UNPARSEABLE_LIST=$(join_range "$UNPARSEABLE_LIST" "$declared")
      UNPARSEABLE_COUNT=$((UNPARSEABLE_COUNT + 1))
      continue
    fi
    ahead=$(read_field majors_ahead "$facts")
    satisfied=$(read_field satisfied "$facts")
    pinned=$(read_field pinned "$facts")
    if [ "$satisfied" = "false" ]; then
      # Only a range the landed version *escapes* contributes its distance. A
      # satisfied range is a dependent declaring support for the line the fix
      # landed on, however permissive the declaration: `>=1` against an 11.1.1
      # patch bump used to score ten major lines crossed and force the PR to
      # High (review follow-up on issue #21).
      if [ "$ahead" != "__null__" ] && [ "$ahead" -gt "$MAJORS_CROSSED" ]; then
        MAJORS_CROSSED=$ahead
      fi
      UNSATISFIED_LIST=$(join_range "$UNSATISFIED_LIST" "$declared")
      if [ "$pinned" = "true" ]; then
        PIN_CROSSED=true
        [ -n "$PINNED_RANGE" ] || PINNED_RANGE="$declared"
      fi
    fi
    DECLARED_LIST=$(join_range "$DECLARED_LIST" "$declared")
  done <<EOF
$deduped
EOF
fi

# ---------------------------------------------------------------------------
# F1 — version delta
# ---------------------------------------------------------------------------
if [ -z "$BEFORE" ]; then
  # No baseline: the package was absent, or the pre-fix lockfile could not be
  # read. Score the worst case rather than guessing. The escalation rule below
  # then keeps the PR out of the Low band, which is the safe direction.
  F1=2
  F1_EVIDENCE="no pre-fix baseline available; scored as major"
  DELTA="unknown"
else
  cmp=$("$ADAPTER" compare_versions "$BEFORE" "$AFTER")
  DELTA=$(printf '%s' "$cmp" | jq -r '.delta')
  # An adapter that does not report the distance cannot be scored against it.
  # Read straight, jq hands back the string "null", `[ "null" -ge 2 ]` errors
  # only on stderr inside an `if`, `set -e` does not see it, and the script
  # exits 0 reporting majors_crossed: 0 — the escalation this factor exists
  # for, silently switched off (review follow-up on issue #21).
  distance=$(read_field major_distance "$cmp")
  case "$distance" in
    __absent__|__null__)
      contract_error "adapter $ADAPTER: compare_versions '$BEFORE' '$AFTER' emitted no usable 'major_distance'. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); without it the multi-major escalation cannot fire and the fix would score as though it crossed nothing." ;;
  esac
  case "$DELTA" in
    major) F1=2 ;;
    minor) F1=1 ;;
    *)     F1=0 ;;
  esac
  # F1 keeps its 0-2 shape; only what it *says* gets sharper. The count and
  # the ranges being left behind go in the evidence, where a reviewer reads
  # them, and the weighting of the distance is F7's job.
  if [ "$distance" -ge 2 ]; then
    label="$distance majors"
  else
    label="$DELTA"
  fi
  if [ -n "$UNSATISFIED_LIST" ]; then
    label="$label; parents declare $UNSATISFIED_LIST"
  fi
  F1_EVIDENCE="$BEFORE -> $AFTER ($label)"
  if [ "$distance" -gt "$MAJORS_CROSSED" ]; then MAJORS_CROSSED=$distance; fi
fi

# ---------------------------------------------------------------------------
# F2 — runtime exposure
# ---------------------------------------------------------------------------
relationship=$(printf '%s' "$why" | jq -r '.relationship // "transitive"')
dev_only=$(printf '%s' "$why" | jq -r '.dev_only // false')

if [ "$dev_only" = "true" ]; then
  F2=0
  F2_EVIDENCE="dev-only dependency chain"
elif [ "$relationship" = "direct" ]; then
  F2=2
  F2_EVIDENCE="direct runtime dependency"
else
  F2=1
  F2_EVIDENCE="transitive under a runtime dependency"
fi

# ---------------------------------------------------------------------------
# F3 — usage surface
#
# For a direct dependency, count source modules importing it. For a transitive
# one, count modules importing its direct parents: nothing imports a transitive
# package by name, so grepping for it would score zero every time.
# ---------------------------------------------------------------------------
if [ "$relationship" = "direct" ]; then
  targets="$PACKAGE"
  target_desc="$PACKAGE"
else
  targets=$(printf '%s' "$why" | jq -r '.parents[]?' | head -20)
  target_desc="parents of $PACKAGE"
fi

# Build one ERE alternation over every target, matching ESM, CJS, and dynamic
# import forms plus subpath imports. Dots are escaped so `sha.js` does not
# match `shaXjs`.
pattern=""
for target in $targets; do
  # `$` sits after `(` deliberately. These are regex metacharacters in a sed
  # character class, but ordering them so `$` precedes `(` spells the literal
  # substring `$(`, which ShellCheck reads as a command substitution smuggled
  # into single quotes (SC2016). This ordering is equivalent and needs no
  # suppression, so keep `$` away from `(`.
  escaped=$(printf '%s' "$target" | sed 's/[.[\*^()+?{}|$\\]/\\&/g')
  alt="(from|import)[[:space:]]*\\(?[[:space:]]*['\"]${escaped}(/[^'\"]*)?['\"]"
  alt="${alt}|require[[:space:]]*\\([[:space:]]*['\"]${escaped}(/[^'\"]*)?['\"]"
  if [ -z "$pattern" ]; then pattern="$alt"; else pattern="$pattern|$alt"; fi
done

importing_files=""
if [ -n "$pattern" ]; then
  importing_files=$(grep -rlE "$pattern" . \
    --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' \
    --include='*.mjs' --include='*.cjs' --include='*.vue' --include='*.svelte' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
    --exclude-dir=.next --exclude-dir=coverage --exclude-dir=out \
    --exclude-dir=.yarn --exclude-dir=.git --exclude-dir=storybook-static \
    2>/dev/null | grep -vE '(test|spec|__tests__|__mocks__|e2e|cypress|\.stories\.)' \
    || true)
fi

if [ -z "$importing_files" ]; then
  import_count=0
else
  import_count=$(printf '%s\n' "$importing_files" | grep -c . || true)
fi

# An import in a declared entry point outweighs raw file count: it means the
# package loads on every code path, not just in one corner of the tree.
entry_hit=false
if [ -n "$importing_files" ] && [ -f package.json ]; then
  entries=$(jq -r '[.main?, .module?, .browser?, (.bin? | if type == "object" then .[] else . end)]
                   | map(select(type == "string")) | .[]' package.json 2>/dev/null || true)
  for entry in $entries; do
    normalized="${entry#./}"
    if printf '%s\n' "$importing_files" | sed 's|^\./||' | grep -qxF "$normalized"; then
      entry_hit=true
      break
    fi
  done
fi

if [ "$import_count" -eq 0 ]; then
  F3=0
  F3_EVIDENCE="no source imports found for $target_desc (build or tooling only)"
elif [ "$entry_hit" = true ]; then
  F3=2
  F3_EVIDENCE="imported in $import_count module(s) for $target_desc, including a declared entry point"
elif [ "$import_count" -le 5 ]; then
  F3=1
  F3_EVIDENCE="imported in $import_count module(s) for $target_desc"
else
  F3=2
  F3_EVIDENCE="imported in $import_count module(s) for $target_desc"
fi

# ---------------------------------------------------------------------------
# F4 / F5 — supplied by the agent that ran verification
# ---------------------------------------------------------------------------
if [ -z "$F4_EVIDENCE" ]; then
  case "$F4" in
    0) F4_EVIDENCE="tests pass and exercise the affected modules" ;;
    1) F4_EVIDENCE="tests pass; affected modules not clearly exercised" ;;
    2) F4_EVIDENCE="no test script, or tests could not run" ;;
  esac
fi
if [ -z "$F5_EVIDENCE" ]; then
  case "$F5" in
    0) F5_EVIDENCE="all repo scripts ran clean" ;;
    1) F5_EVIDENCE="scripts ran; pre-existing failures noted" ;;
    2) F5_EVIDENCE="one or more scripts skipped or partially run" ;;
  esac
fi

# ---------------------------------------------------------------------------
# F6 — override blast radius
#
# Categorical rather than a bare number, so the caller states what it did and
# the script decides what that is worth. The evidence says which shape was
# applied, because the whole point of the factor is that a reviewer can see a
# global pin without reading the diff.
# ---------------------------------------------------------------------------
case "$OVERRIDE_SCOPE" in
  none)
    F6=0
    F6_EVIDENCE="no override introduced; the direct dependency was updated" ;;
  scoped)
    F6=0
    F6_EVIDENCE="scoped override: only the dependency paths that carried the alerts are pinned" ;;
  bare-tightened)
    F6=1
    F6_EVIDENCE="pre-existing unscoped override for $PACKAGE tightened; the global pin already governed every consumer" ;;
  bare-added)
    F6=2
    F6_EVIDENCE="new unscoped override pins $PACKAGE for every consumer, including copies that were never vulnerable" ;;
esac

# ---------------------------------------------------------------------------
# F7 — distance from the declared ranges
#
# Distance is the widest of two measures: the majors between the resolved
# versions, and the majors between any dependent's declared floor and where
# the fix lands. The second catches what the first cannot — a parent stuck on
# ^9 while the lockfile already moved to 11.x means a patch bump still leaves
# two unexercised major lines behind it.
#
# Crossing a pin counts on top. A dependent that wrote ~6.14.0 or an exact
# version asked for one line and got another; a caret did not.
# ---------------------------------------------------------------------------
F7=0
if [ "$MAJORS_CROSSED" -ge 2 ]; then F7=$((MAJORS_CROSSED - 1)); fi
if [ "$PIN_CROSSED" = true ]; then F7=$((F7 + 1)); fi
if [ "$F7" -gt 2 ]; then F7=2; fi

# "no major line crossed; ...; crosses the pinned range ^5" contradicted
# itself: a crossed pin below the two-major threshold is the whole finding, so
# it stands on its own rather than behind a denial of it.
if [ "$MAJORS_CROSSED" -eq 0 ] && [ "$PIN_CROSSED" = true ]; then
  F7_EVIDENCE="crosses the pinned range $PINNED_RANGE"
  PIN_STATED=true
else
  PIN_STATED=false
  case "$MAJORS_CROSSED" in
    0) F7_EVIDENCE="no major line crossed" ;;
    1) F7_EVIDENCE="one major line crossed" ;;
    *) F7_EVIDENCE="$MAJORS_CROSSED major lines crossed" ;;
  esac
fi
if [ -n "$DECLARED_LIST" ]; then
  F7_EVIDENCE="$F7_EVIDENCE; dependents declare $DECLARED_LIST"
elif [ "$DECLARED_RANGES_STATED" = true ]; then
  F7_EVIDENCE="$F7_EVIDENCE; no dependent range could be evaluated"
else
  F7_EVIDENCE="$F7_EVIDENCE; caller stated no dependent ranges could be read"
fi
if [ "$UNPARSEABLE_COUNT" -gt 0 ]; then
  if [ "$UNPARSEABLE_COUNT" -eq 1 ]; then
    F7_EVIDENCE="$F7_EVIDENCE; 1 dependent range not evaluated ($UNPARSEABLE_LIST)"
  else
    F7_EVIDENCE="$F7_EVIDENCE; $UNPARSEABLE_COUNT dependent ranges not evaluated ($UNPARSEABLE_LIST)"
  fi
fi
if [ "$PIN_CROSSED" = true ] && [ "$PIN_STATED" = false ]; then
  F7_EVIDENCE="$F7_EVIDENCE; crosses the pinned range $PINNED_RANGE"
fi

# Either the ranges the caller stated, in the order it stated them, or the
# sentinel: "nobody could read a range here" is a different fact from "no range
# is out of date", and the output says which one this score rests on.
if [ "$DECLARED_RANGES_STATED" = true ]; then
  DECLARED_JSON=$(printf '%s' "$DECLARED_RANGES" | jq -Rs '
    split("\n") | map(select(length > 0))
    | reduce .[] as $r ([]; if index($r) then . else . + [$r] end)')
else
  DECLARED_JSON='"none-stated"'
fi

jq -n \
  --argjson declared_ranges "$DECLARED_JSON" \
  --argjson f1 "$F1" --argjson f2 "$F2" --argjson f3 "$F3" \
  --argjson f4 "$F4" --argjson f5 "$F5" --argjson f6 "$F6" \
  --argjson f7 "$F7" --argjson majors "$MAJORS_CROSSED" \
  --arg e1 "$F1_EVIDENCE" --arg e2 "$F2_EVIDENCE" --arg e3 "$F3_EVIDENCE" \
  --arg e4 "$F4_EVIDENCE" --arg e5 "$F5_EVIDENCE" --arg e6 "$F6_EVIDENCE" \
  --arg e7 "$F7_EVIDENCE" \
  --arg package "$PACKAGE" --arg delta "$DELTA" \
  --arg override_scope "$OVERRIDE_SCOPE" '
  [
    {id: "F1", name: "Version delta",           score: $f1, evidence: $e1},
    {id: "F2", name: "Runtime exposure",        score: $f2, evidence: $e2},
    {id: "F3", name: "Usage surface",           score: $f3, evidence: $e3},
    {id: "F4", name: "Test signal",             score: $f4, evidence: $e4},
    {id: "F5", name: "Verification",            score: $f5, evidence: $e5},
    {id: "F6", name: "Override blast radius",   score: $f6, evidence: $e6},
    {id: "F7", name: "Declared-range distance", score: $f7, evidence: $e7}
  ] as $factors
  | ($factors | map(.score) | add) as $score
  | ($factors | length) * 2 as $max
  | (if   $score <= 3 then "Low"
     elif $score <= 6 then "Medium"
     else "High" end) as $raw_band
  # Two things never rate Low regardless of total: a widely imported, untested
  # runtime major, and a global pin this PR introduced over consumers that
  # were never vulnerable. Both belong where a reviewer will look at them.
  | [ (if $f1 == 2 then "a major version delta never rates Low" else empty end),
      (if $override_scope == "bare-added"
       then "a newly added unscoped override never rates Low" else empty end)
    ] as $blockers
  # And one thing never rates below High: a fix that drags a runtime
  # dependency across two or more major lines with nothing verifying the
  # result. Each half is survivable alone; together, nobody has evidence the
  # tree still works, and Medium reads as "skim it" (issue #21).
  | [ (if $majors >= 2 and $f2 >= 1 and $f4 == 2
       then "a multi-major jump on a runtime dependency with no test signal never rates below High"
       else empty end)
    ] as $high_blockers
  | (if   ($high_blockers | length) > 0 then "High"
     elif ($blockers | length) > 0 and $raw_band == "Low" then "Medium"
     else $raw_band end) as $band
  | (if ($high_blockers | length) > 0 then $high_blockers else $blockers end)
    as $applied
  | {
      package: $package,
      score: $score,
      max: $max,
      band: $band,
      escalated: ($band != $raw_band),
      escalation_reason: (
        if $band != $raw_band then ($applied | join("; ")) else null end
      ),
      delta: $delta,
      majors_crossed: $majors,
      declared_ranges: $declared_ranges,
      override_scope: $override_scope,
      factors: $factors,
      markdown: (
        "## Merge risk: \($band) (\($score)/\($max))\n\n"
        + (if $band != $raw_band
           then "> Escalated from \($raw_band): \($applied | join("; ")).\n\n"
           else "" end)
        + "| Factor | Score | Evidence |\n|---|---|---|\n"
        + ($factors | map("| \(.name) | \(.score) | \(.evidence) |") | join("\n"))
        + "\n"
      )
    }'
