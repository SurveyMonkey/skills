#!/usr/bin/env bash
# score-merge-risk.sh — compute the merge-risk rating for a dependency fix PR
#
# Usage:
#   score-merge-risk.sh --package <pkg> --after <version> --adapter <path>
#                       --why-json <file|-> --f4 <0|1|2> --f5 <0|1|2>
#                       [--before <version>] [--f4-evidence <text>]
#                       [--f5-evidence <text>]
#
# Output: {score, band, factors: [...], markdown}
#
# Five factors, each 0-2, summed to 0-10. Bands: Low 0-3, Medium 4-6, High
# 7-10, with one escalation rule: a major version delta never rates Low.
#
# The split of labour is deliberate. F1-F3 are derivable from the repository
# and the lockfile, so they are computed here. F4 (test signal) and F5
# (verification completeness) are facts only the agent that ran the checks
# knows, so they are passed in. This script applies the bands either way.
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

while [ $# -gt 0 ]; do
  case "$1" in
    --package)     PACKAGE="${2:?}"; shift 2 ;;
    --before)      BEFORE="${2:?}"; shift 2 ;;
    --after)       AFTER="${2:?}"; shift 2 ;;
    --adapter)     ADAPTER="${2:?}"; shift 2 ;;
    --why-json)    WHY_JSON="${2:?}"; shift 2 ;;
    --f4)          F4="${2:?}"; shift 2 ;;
    --f5)          F5="${2:?}"; shift 2 ;;
    --f4-evidence) F4_EVIDENCE="${2:?}"; shift 2 ;;
    --f5-evidence) F5_EVIDENCE="${2:?}"; shift 2 ;;
    *) printf '{"error":"Unknown argument: %s"}\n' "$1" >&2; exit 1 ;;
  esac
done

for required in PACKAGE AFTER ADAPTER WHY_JSON F4 F5; do
  eval "value=\${$required}"
  if [ -z "$value" ]; then
    printf '{"error":"Missing required argument: --%s"}\n' \
      "$(printf '%s' "$required" | tr '[:upper:]' '[:lower:]' | tr '_' '-')" >&2
    exit 1
  fi
done

case "$F4" in 0|1|2) ;; *) printf '{"error":"--f4 must be 0, 1, or 2"}\n' >&2; exit 1 ;; esac
case "$F5" in 0|1|2) ;; *) printf '{"error":"--f5 must be 0, 1, or 2"}\n' >&2; exit 1 ;; esac

if [ "$WHY_JSON" = "-" ]; then
  why=$(cat)
else
  why=$(cat "$WHY_JSON")
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
  case "$DELTA" in
    major) F1=2 ;;
    minor) F1=1 ;;
    *)     F1=0 ;;
  esac
  F1_EVIDENCE="$BEFORE -> $AFTER ($DELTA)"
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

jq -n \
  --argjson f1 "$F1" --argjson f2 "$F2" --argjson f3 "$F3" \
  --argjson f4 "$F4" --argjson f5 "$F5" \
  --arg e1 "$F1_EVIDENCE" --arg e2 "$F2_EVIDENCE" --arg e3 "$F3_EVIDENCE" \
  --arg e4 "$F4_EVIDENCE" --arg e5 "$F5_EVIDENCE" \
  --arg package "$PACKAGE" --arg delta "$DELTA" '
  [
    {id: "F1", name: "Version delta",           score: $f1, evidence: $e1},
    {id: "F2", name: "Runtime exposure",        score: $f2, evidence: $e2},
    {id: "F3", name: "Usage surface",           score: $f3, evidence: $e3},
    {id: "F4", name: "Test signal",             score: $f4, evidence: $e4},
    {id: "F5", name: "Verification",            score: $f5, evidence: $e5}
  ] as $factors
  | ($factors | map(.score) | add) as $score
  | (if   $score <= 3 then "Low"
     elif $score <= 6 then "Medium"
     else "High" end) as $raw_band
  # A major bump never rates Low regardless of total: a widely imported,
  # untested runtime major belongs where a reviewer will look at it.
  | (if $f1 == 2 and $raw_band == "Low" then "Medium" else $raw_band end) as $band
  | {
      package: $package,
      score: $score,
      band: $band,
      escalated: ($band != $raw_band),
      delta: $delta,
      factors: $factors,
      markdown: (
        "## Merge risk: \($band) (\($score)/10)\n\n"
        + (if $band != $raw_band
           then "> Escalated from \($raw_band): a major version delta never rates Low.\n\n"
           else "" end)
        + "| Factor | Score | Evidence |\n|---|---|---|\n"
        + ($factors | map("| \(.name) | \(.score) | \(.evidence) |") | join("\n"))
        + "\n"
      )
    }'
