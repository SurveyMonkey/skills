#!/usr/bin/env bash
# score-merge-risk.sh: compute the merge-risk rating for a dependency fix PR
#
# Usage:
#   score-merge-risk.sh --package <pkg> --after <version> --adapter <path>
#                       --why-json <file|->
#                       --override-scope <none|scoped|bare-tightened|bare-added>
#                       --declared-range <range|none> [--declared-range <range>]...
#                       [--before <version>]
#
# Run from the root of the tree being scored: F3, F4 and F5 read that tree.
#
# Output: {package, score, max, band, escalated, escalation_reason, delta,
#          majors_crossed, declared_ranges, override_scope, coverage, ci,
#          factors: [...], markdown}
#
# Seven factors, each 0-2, summed to 0-14. Bands: Low 0-3, Medium 4-6, High 7+,
# with three escalation rules: neither a major version delta nor a newly added
# unscoped override ever rates Low, and a multi-major jump on a runtime
# dependency with no test signal never rates below High.
#
# The band thresholds are absolute risk points, not proportions of the maximum,
# so they did not move when F6 was added (issue #20), did not move for F7
# (issue #21), and did not move when F4 and F5 were redefined as static
# analysis (issue #71, ADR 006): that redefinition changed what the two factors
# measure, not how many there are, so the maximum stays 14 and every threshold
# stays where it was. What changes a band is a fix that scores on a factor or
# trips an escalation, which is the point of having them: the sweep case
# bork#350 rates High on exactly that route. A fix that scores 0 on F6 and F7,
# as every direct update or scoped override crossing at most one major line and
# no pin does, keeps the band it had. The "no pin" half is not decoration: a
# single-major bump past a dependent's `~1.2.3` scores 1 on F7 and can move
# Medium to High on that alone.
#
# `--declared-range` is required, with an explicit `none` sentinel for "no
# dependent range could be read". Left optional, its absence made the
# multi-major escalation unreachable without saying so, and a caller whose
# collection step half-failed looked identical to one with nothing to report.
#
# The split of labour is deliberate. F1 and F7 come from the version pair and
# the ranges, F2 from the classification the adapter's `why` already produced,
# and F3, F4 and F5 from the files in the tree, so all of them are computed
# here. F6 (which
# remediation shape was applied) is a fact only the agent that did the work
# knows, so it is passed in. F7 is both: the caller states the ranges its
# dependents declared, the adapter says what those ranges mean, and this script
# decides what that is worth. This script applies the bands either way.
#
# F4 and F5 used to be passed in too, as "did the tests pass" and "did every
# repo script run", which meant the agent had to run the repository's checks
# before a score existed. That collapsed "this repo has no tests" and "one
# check could not start in this sandbox" into the same 2, and it did not scale:
# at hundreds of alerts, running every repo's suite per fix is CI's job, not an
# agent's (issue #71, ADR 006). Both are static analysis now, and CI on the
# pull request is the verifier. A High that CI later contradicts is the tests
# working, not a scoring defect.
#
# F4 asks whether anything tests the surface this fix touches, reusing F3's
# importing modules. A module counts as covered when a test file imports it by
# a specifier whose last path segment is the module's basename, or when a
# `<basename>.test.*` / `<basename>.spec.*` sibling or `__tests__/<basename>.*`
# entry sits next to it, or when a test file imports the package itself by
# name. The specifier match is a **basename heuristic**: `../src/util`,
# `./util.js` and `@/lib/util` all count as covering `src/util.js`, and so
# would a test importing an unrelated `lib/util.js`. Two modules with the same
# basename in different directories are not told apart, which overstates
# coverage rather than understating it; a resolver would fix that and needs a
# module graph this script deliberately does not build.
#
# "Is this a test file" is the same path regex F3 excludes by, so the two
# factors always talk about the same files. One regex, not two: a path that
# counted as neither a source module nor a test file would disappear from both
# factors at once. It is anchored to whole path segments and to the
# conventional double-extension suffixes, because a substring match classified
# `src/latest`, `src/inspector`, `src/contest` and `packages/attestation` as
# tests, dropped them out of the usage surface, and then let them cover it.
#
# Two more F4 limits, both leaving coverage *understated*, which is the safe
# direction:
#
#   - **A specifier split across lines is not seen.** Prettier writes
#     `import { a } from\n  '../src/a'`, and the import scan reads one line at
#     a time, so that module reads as uncovered. A multi-line scan would need
#     to know where a statement ends, which is a parser.
#   - **A test importing a directory by its path does not cover its index.**
#     `require('../src/feature')` resolving to `src/feature/index.js` compares
#     `feature` against `index` and misses; `require('../lib/index')` covers it
#     for the opposite reason, by basename collision.
#
# F5 asks whether CI will run on the pull request, read straight out of
# `.github/workflows/*.yml` and `*.yaml` with grep. **Only GitHub Actions is
# read.** A repo on CircleCI, Buildkite, Jenkins or a self-hosted runner scores
# 2 here even though its checks will run. That is a documented limit, not a gap
# to paper over: this flow opens GitHub pull requests and reads the GitHub
# check rollup, so an Actions workflow is the one verifier it can see before
# the PR exists. A repo scoring 2 on F5 gets a PR
# whose merge risk says "nothing here proves CI runs", which is the honest
# reading.
#
# Parsing is grep and awk, not YAML, and the limits that leaves are:
#
#   - All four `on:` spellings are recognized (scalar, flow sequence
#     `[push, pull_request]`, flow map `{pull_request: ...}`, and the block
#     form), and `pull_request_target` counts alongside `pull_request` because
#     it also runs on pull requests. A *job* named `pull_request:` under
#     `on: push` does not, because the block form additionally requires a bare
#     `on:` line above it.
#   - Only `run:` scalars and `run: |` block bodies are read as steps, so a
#     commented-out line, a step *name*, and a `cmd:` handed to an action under
#     `with:` no longer count. A check invoked *inside* a composite action, or
#     through a reusable workflow, is invisible from the caller's file and
#     scores as absent.
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
OVERRIDE_SCOPE=""
DECLARED_RANGES=""
DECLARED_RANGES_SEEN=false
DECLARED_RANGES_STATED=false
DECLARED_RANGES_NONE=false

# Every failure this script reports leaves the same shape behind, so a caller
# parsing stdout+stderr never has to special-case one of them. `${2:?}` did not:
# an empty-string argument tripped bash's own "parameter null or not set"
# message, which is neither JSON nor named after the flag that was wrong
# (review follow-up on issue #21).
json_error() {
  printf '{"error":%s}\n' "$(printf '%s' "$1" | jq -Rs .)" >&2
  exit 1
}

need_value() {
  [ -n "${2:-}" ] || json_error "$1 requires a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --package)        need_value "$1" "${2-}"; PACKAGE="$2"; shift 2 ;;
    --before)         need_value "$1" "${2-}"; BEFORE="$2"; shift 2 ;;
    --after)          need_value "$1" "${2-}"; AFTER="$2"; shift 2 ;;
    --adapter)        need_value "$1" "${2-}"; ADAPTER="$2"; shift 2 ;;
    --why-json)       need_value "$1" "${2-}"; WHY_JSON="$2"; shift 2 ;;
    --override-scope) need_value "$1" "${2-}"; OVERRIDE_SCOPE="$2"; shift 2 ;;
    # Repeatable and required: one flag per distinct range a dependent declares
    # for the package, or the single sentinel `none`. Ranges may contain spaces
    # (">=1 <2"), so they accumulate one per line rather than space-separated.
    --declared-range)
      need_value "$1" "${2-}"
      DECLARED_RANGES_SEEN=true
      if [ "$2" = "none" ]; then
        DECLARED_RANGES_NONE=true
      else
        DECLARED_RANGES_STATED=true
        DECLARED_RANGES="${DECLARED_RANGES}$2
"
      fi
      shift 2 ;;
    *) json_error "Unknown argument: $1" ;;
  esac
done

for required in PACKAGE AFTER ADAPTER WHY_JSON OVERRIDE_SCOPE; do
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

case "$OVERRIDE_SCOPE" in
  none|scoped|bare-tightened|bare-added) ;;
  *) printf '{"error":"--override-scope must be none, scoped, bare-tightened, or bare-added"}\n' >&2
     exit 1 ;;
esac

if [ "$WHY_JSON" = "-" ]; then
  why=$(cat)
else
  [ -f "$WHY_JSON" ] || json_error "--why-json file not found: $WHY_JSON. The classification it carries decides F2 and the whole affected surface, so there is nothing to fall back to."
  why=$(cat "$WHY_JSON")
fi

# The same rule the adapter answers are held to. Every field below is read
# through jq with a default, and the defaults are the low-risk ones: an empty
# or malformed payload scores a direct runtime dependency as a transitive with
# no parents, which is the worst thing it could quietly become.
printf '%s' "$why" | jq -e 'type == "object"' >/dev/null 2>&1 \
  || json_error "--why-json $WHY_JSON did not contain a JSON object. Read through jq, a malformed payload answers every field with a default and the fix scores against a classification nobody supplied."

# package.json is the manifest every node repository has, and both F3's entry
# points and F4's scripts are read from it. Absent or unparseable it read as
# "no entry points, no test script", which is a score rather than a reading.
[ -f package.json ] || json_error "no package.json in $PWD. The scorer runs from the root of the tree being scored, and F3 and F4 read the manifest there; without it the fix would score as a repository that declares no scripts."
jq -e 'type == "object"' package.json >/dev/null 2>&1 \
  || json_error "package.json in $PWD does not parse as a JSON object. Read as an absent manifest it scores the fix as having no test script and no entry points, which is lower risk than the truth."

# Checked here rather than in F5 so it fails before the usage-surface grep,
# which walks the same directory and would report the same problem as an
# unreadable *tree*, burying the specific cause.
WORKFLOW_DIR=".github/workflows"
if [ -d "$WORKFLOW_DIR" ] && [ ! -r "$WORKFLOW_DIR" ]; then
  json_error "$WORKFLOW_DIR exists but cannot be read, so whether CI runs on this pull request could not be determined. Reported as 'no workflow' it would be indistinguishable from a repository that has none, which is the lower-risk answer."
fi

# ---------------------------------------------------------------------------
# Declared ranges: asked of the adapter, because what "^9" admits is a semver
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

contract_error() { json_error "$1"; }

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

# Every check below reads the adapter's answer through jq, so "is there an
# answer at all" has to be settled first. An adapter exiting 0 with empty
# stdout sailed past all of it: jq on empty input emits nothing, `read_field`
# hands back the empty string, the `__absent__` case never matches, and the
# integer test that follows fails on stderr only, inside an `if` that `set -e`
# never sees. A 1.0.0 -> 3.0.0 bump scored majors_crossed 0 and exited 0.
# Non-JSON garbage and a non-zero exit already die (jq under `set -e`, and the
# assignment itself); empty-or-not-an-object was the hole.
require_object() {
  printf '%s' "$1" | jq -e 'type == "object"' >/dev/null 2>&1 \
    || contract_error "adapter $ADAPTER: $2 emitted no JSON object on stdout. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); an adapter that cannot answer must exit non-zero, not answer with nothing and let the fix score as low risk."
}

# The type a field carries is as much of the promise as the key. A present but
# non-numeric `"major_distance":"lots"` passes `has()`, and `[ "lots" -ge 2 ]`
# then errors only on stderr: the same silent zero the absence check exists to
# prevent, reached by a different route.
require_count() {
  case "$2" in
    ''|*[!0-9]*)
      contract_error "adapter $ADAPTER: $1 must be a non-negative integer, got '$2'. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); a value the script cannot compare with would silently score the fix as crossing nothing." ;;
  esac
}

# Same promise for booleans. `[ "$satisfied" = "false" ]` puts every value
# that is not the exact string in the risk-lowering branch, so a `"no"` or a
# null reads as "satisfied, not pinned" and the range contributes nothing.
require_bool() {
  case "$2" in
    true|false) ;;
    *)
      contract_error "adapter $ADAPTER: $1 must be true or false, got '$2'. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); any other value lands in the risk-lowering branch and the range stops counting." ;;
  esac
}

if [ "$DECLARED_RANGES_STATED" = true ]; then
  # Duplicates are expected: several parents commonly declare the same range,
  # and repeating it in the evidence tells a reviewer nothing.
  deduped=$(printf '%s' "$DECLARED_RANGES" | awk 'NF && !seen[$0]++')
  while IFS= read -r declared; do
    [ -n "$declared" ] || continue
    facts=$("$ADAPTER" range_facts "$declared" "$AFTER")
    require_object "$facts" "range_facts '$declared' '$AFTER'"
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
    [ "$ahead" = "__null__" ] || require_count "range_facts majors_ahead for '$declared'" "$ahead"
    satisfied=$(read_field satisfied "$facts")
    require_bool "range_facts satisfied for '$declared'" "$satisfied"
    pinned=$(read_field pinned "$facts")
    require_bool "range_facts pinned for '$declared'" "$pinned"
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
# F1: version delta
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
  require_object "$cmp" "compare_versions '$BEFORE' '$AFTER'"
  case "$(read_field delta "$cmp")" in
    __absent__|__null__)
      contract_error "adapter $ADAPTER: compare_versions '$BEFORE' '$AFTER' emitted no usable 'delta'. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); read as a default it would score every unanswered bump as a patch." ;;
  esac
  DELTA=$(printf '%s' "$cmp" | jq -r '.delta')
  # The `case` below maps anything unrecognized to F1=0, so an adapter
  # answering "breaking" or "MAJOR" would score as a patch. Only the contract
  # enum passes; prerelease and none are the legitimate zeros.
  case "$DELTA" in
    major|minor|patch|prerelease|none) ;;
    *)
      contract_error "adapter $ADAPTER: compare_versions '$BEFORE' '$AFTER' answered delta '$DELTA', which is not in the contract enum major|minor|patch|prerelease|none (docs/adr/001-ecosystem-adapter-contract.md); an unrecognized delta would score as a patch." ;;
  esac
  # An adapter that does not report the distance cannot be scored against it.
  # Read straight, jq hands back the string "null", `[ "null" -ge 2 ]` errors
  # only on stderr inside an `if`, `set -e` does not see it, and the script
  # exits 0 reporting majors_crossed: 0, silently switching off the escalation
  # this factor exists for (review follow-up on issue #21).
  distance=$(read_field major_distance "$cmp")
  case "$distance" in
    __absent__|__null__)
      contract_error "adapter $ADAPTER: compare_versions '$BEFORE' '$AFTER' emitted no usable 'major_distance'. It is part of the adapter contract (docs/adr/001-ecosystem-adapter-contract.md); without it the multi-major escalation cannot fire and the fix would score as though it crossed nothing." ;;
  esac
  require_count "compare_versions major_distance" "$distance"
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
# F2: runtime exposure
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
# F3: usage surface
#
# For a direct dependency, count source modules importing it. For a transitive
# one, count modules importing its direct parents: nothing imports a transitive
# package by name, so grepping for it would score zero every time.
# ---------------------------------------------------------------------------
PARENTS_KNOWN=true
if [ "$relationship" = "direct" ]; then
  targets="$PACKAGE"
  target_desc="$PACKAGE"
else
  targets=$(printf '%s' "$why" | jq -r '.parents[]?' | head -20)
  target_desc="parents of $PACKAGE"
  # A transitive whose parents nobody could name leaves nothing to grep for.
  # Built into an empty pattern, that read as "nothing in this tree imports
  # it" and scored F3 0 and F4 0 on a measurement that never happened, which
  # is the risk-lowering direction. `why` legitimately answers with an empty
  # `parents[]` (a package manager that cannot walk the tree), so this is the
  # worst case rather than an error.
  [ -n "$targets" ] || PARENTS_KNOWN=false
fi

# `.claude` is excluded alongside the build outputs: fix worktrees live at
# `.claude/worktrees/<name>` inside the repository being fixed (ADR 003), so a
# tree with one checked out counts every module in it a second time. Observed
# on tacoma.fyi, where two source files became eight affected modules and the
# same file appeared twice in the uncovered list.
#
# Build one ERE alternation over every target, matching ESM, CJS, and dynamic
# import forms plus subpath imports. Dots are escaped so `sha.js` does not
# match `shaXjs`.
build_import_pattern() {
  _pat=""
  for _target in $1; do
    # `$` sits after `(` deliberately. These are regex metacharacters in a sed
    # character class, but ordering them so `$` precedes `(` spells the literal
    # substring `$(`, which ShellCheck reads as a command substitution smuggled
    # into single quotes (SC2016). This ordering is equivalent and needs no
    # suppression, so keep `$` away from `(`.
    _escaped=$(printf '%s' "$_target" | sed 's/[.[\*^()+?{}|$\\]/\\&/g')
    _alt="(from|import)[[:space:]]*\\(?[[:space:]]*['\"]${_escaped}(/[^'\"]*)?['\"]"
    _alt="${_alt}|require[[:space:]]*\\([[:space:]]*['\"]${_escaped}(/[^'\"]*)?['\"]"
    if [ -z "$_pat" ]; then _pat="$_alt"; else _pat="$_pat|$_alt"; fi
  done
  printf '%s' "$_pat"
}

# Two patterns, deliberately. `pattern` is what defines the affected surface
# (the package for a direct fix, its parents for a transitive one). The second
# is the package alone, and only it may stand in for coverage of the whole
# surface: a test that imports `express` says nothing about whether `lodash`
# underneath it is exercised, and treating it as though it did switched off
# the multi-major escalation for exactly the shape it exists to catch.
pattern=$(build_import_pattern "$targets")
package_pattern=$(build_import_pattern "$PACKAGE")

# One definition of "this path is a test", used to exclude test files from the
# usage surface (F3) and to select them as coverage evidence (F4). Two copies
# would let a path count as neither, or as both.
#
# Anchored, because a bare substring match is not a classification: `src/latest`,
# `src/inspector`, `src/contest` and `packages/attestation` all contain one of
# these words, and every one of them dropped out of the usage surface *and*
# counted as a test file. A repository with no tests at all scored F4 0 that
# way. Directory names match as whole path segments; file names match as the
# conventional double-extension suffixes.
TEST_PATH_RE='(^|/)(__tests__|__mocks__|e2e|cypress|tests?|specs?)/|\.(test|spec|stories)\.'

importing_files=""
if [ "$PARENTS_KNOWN" = true ] && [ -n "$pattern" ]; then
  set +e
  matched=$(grep -rlE "$pattern" . \
    --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' \
    --include='*.mjs' --include='*.cjs' --include='*.vue' --include='*.svelte' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
    --exclude-dir=.next --exclude-dir=coverage --exclude-dir=out \
    --exclude-dir=.yarn --exclude-dir=.git --exclude-dir=storybook-static \
    --exclude-dir=.claude \
    2>/dev/null)
  grep_status=$?
  set -e
  # grep exits 1 for "nothing matched" and 2 for "something went wrong":
  # an unreadable file, an I/O error. `|| true` folded the two together, so a
  # tree the scorer could not read scored identically to a tree that imports
  # nothing, taking F4 down with it. This recursive pass visits every file F4
  # greps later, so catching it here catches it for both factors.
  if [ "$grep_status" -ge 2 ]; then
    json_error "could not read the tree under $PWD while searching for imports of $target_desc (grep exited $grep_status). A partial read scores the usage surface and its test coverage as zero, so this fails instead of guessing."
  fi
  importing_files=$(printf '%s\n' "$matched" | grep -vE "$TEST_PATH_RE" || true)
fi

if [ -z "$importing_files" ]; then
  import_count=0
else
  import_count=$(printf '%s\n' "$importing_files" | grep -c . || true)
fi

# An import in a declared entry point outweighs raw file count: it means the
# package loads on every code path, not just in one corner of the tree.
entry_hit=false
if [ -n "$importing_files" ]; then
  entries=$(jq -r '[.main?, .module?, .browser?, (.bin? | if type == "object" then .[] else . end)]
                   | map(select(type == "string")) | .[]' package.json)
  for entry in $entries; do
    normalized="${entry#./}"
    if printf '%s\n' "$importing_files" | sed 's|^\./||' | grep -qxF "$normalized"; then
      entry_hit=true
      break
    fi
  done
fi

if [ "$PARENTS_KNOWN" != true ]; then
  F3=2
  F3_EVIDENCE="no parents known for $PACKAGE; usage surface could not be measured"
elif [ "$import_count" -eq 0 ]; then
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
# F4: test coverage of the affected surface
#
# The affected surface is F3's importing modules, so the two factors always
# talk about the same files: F3 says how much of the tree touches the package,
# F4 says how much of that anything tests. When F3 is 0 there is no surface to
# cover and the question becomes what would catch a broken tooling pin instead,
# which is the build script.
#
# When there *are* affected modules, a repository with no `test` script scores
# 2 whatever its files look like: a test file nothing ever runs is not
# coverage, and the pull request this feeds has no way to run it either.
# ---------------------------------------------------------------------------
# A script is a non-empty string under `.scripts`. `has()` alone accepted
# `"test": null` and `"test": {}`, neither of which is a runnable script.
has_script() {
  jq -e --arg s "$1" \
    '(.scripts // {})[$s] as $v | ($v | type) == "string" and ($v | length) > 0' \
    package.json >/dev/null 2>&1
}

# The same tree F3 walked, listed rather than searched, so the test files can
# be selected by path. `find` with prunes rather than a second `grep -r`
# because nothing here needs the file contents yet.
source_files() {
  find . \
    \( -type d \( -name node_modules -o -name dist -o -name build \
       -o -name .next -o -name coverage -o -name out -o -name .yarn \
       -o -name .git -o -name .claude -o -name storybook-static \) -prune \) -o \
    -type f \( -name '*.js' -o -name '*.jsx' -o -name '*.ts' -o -name '*.tsx' \
       -o -name '*.mjs' -o -name '*.cjs' -o -name '*.vue' -o -name '*.svelte' \) \
    -print 2>/dev/null
}

test_files=$(source_files | grep -E "$TEST_PATH_RE" || true)

# Every module basename the test files import, collected in one pass rather
# than one grep per affected module: a repository with 400 test files and 30
# affected modules would otherwise fork 12,000 greps.
#
# Only quoted strings on lines that carry `from`, `import` or `require` are
# read, and only those containing a `/`: a bare `'util'` is a package name, not
# a sibling module, and a quoted URL on a `const endpoint =` line is neither.
TEST_IMPORT_BASES=""
if [ -n "$test_files" ]; then
  TEST_IMPORT_BASES=$(printf '%s\n' "$test_files" | while IFS= read -r tf; do
      [ -n "$tf" ] || continue
      grep -hE "(^|[^A-Za-z0-9_])(from|import|require)([^A-Za-z0-9_]|$)" "$tf" 2>/dev/null || true
    done \
    | grep -oE "['\"][^'\"]*/[^'\"]*['\"]" \
    | sed "s/^['\"]//; s/['\"]\$//; s|.*/||; s|\\.[A-Za-z0-9]\\{1,5\\}\$||" \
    | sort -u || true)
fi

# A test that imports the package *itself* by name exercises the package
# surface directly, whatever the importing modules look like. `usage-app`'s
# `tests/util.test.js` is exactly this shape. Only the package counts here,
# never its parents: see `package_pattern` above.
package_tested=false
if [ -n "$package_pattern" ] && [ -n "$test_files" ]; then
  hits=$(printf '%s\n' "$test_files" | while IFS= read -r tf; do
      [ -n "$tf" ] || continue
      grep -lE "$package_pattern" "$tf" 2>/dev/null || true
    done || true)
  [ -z "$hits" ] || package_tested=true
fi

module_covered() {
  if [ "$package_tested" = true ]; then return 0; fi
  _m="${1#./}"
  _dir=$(dirname "$_m")
  _base=$(basename "$_m")
  _base="${_base%.*}"
  for _cand in "$_dir/$_base".test.* "$_dir/$_base".spec.* "$_dir/__tests__/$_base".*; do
    if [ -f "$_cand" ]; then return 0; fi
  done
  if [ -n "$TEST_IMPORT_BASES" ] \
     && printf '%s\n' "$TEST_IMPORT_BASES" | grep -qxF "$_base"; then
    return 0
  fi
  return 1
}

COVERED_COUNT=0
UNCOVERED=""
if [ "$import_count" -gt 0 ]; then
  while IFS= read -r module; do
    [ -n "$module" ] || continue
    if module_covered "$module"; then
      COVERED_COUNT=$((COVERED_COUNT + 1))
    else
      UNCOVERED="${UNCOVERED}${module#./}
"
    fi
  done <<EOF
$importing_files
EOF
fi

# Sorted, because the order `grep -rl` walks a directory is the filesystem's
# and differs between machines: unsorted, the same repository produced a
# different "first five" on macOS and on ubuntu.
UNCOVERED=$(printf '%s' "$UNCOVERED" | awk 'NF' | sort || true)

# Five names is enough for a reviewer to recognize the shape of what is
# uncovered; the full list is in the `coverage` object for anyone who wants it.
uncovered_names=$(printf '%s\n' "$UNCOVERED" | awk 'NF' | head -5 | tr '\n' ',' | sed 's/,$//; s/,/, /g' || true)
uncovered_total=$(printf '%s\n' "$UNCOVERED" | awk 'NF' | grep -c . || true)
if [ "$uncovered_total" -gt 5 ]; then
  uncovered_names="$uncovered_names, and $((uncovered_total - 5)) more"
fi

if [ "$PARENTS_KNOWN" != true ]; then
  F4=2
  F4_EVIDENCE="no parents known for $PACKAGE; nothing could be checked for test coverage"
elif [ "$import_count" -eq 0 ]; then
  if has_script build; then
    F4=0
    F4_EVIDENCE="no source imports; a build script exists, so a broken tooling pin fails at build"
  elif has_script test; then
    F4=1
    F4_EVIDENCE="no source imports and no build script; the test script is the only thing that would notice"
  else
    F4=2
    F4_EVIDENCE="no source imports, and neither a build nor a test script exists"
  fi
elif ! has_script test; then
  F4=2
  F4_EVIDENCE="$import_count affected module(s), and package.json declares no test script"
elif [ "$COVERED_COUNT" -eq "$import_count" ]; then
  F4=0
  F4_EVIDENCE="all $import_count affected module(s) are covered by a test"
elif [ "$COVERED_COUNT" -gt 0 ]; then
  F4=1
  F4_EVIDENCE="$COVERED_COUNT of $import_count affected modules are imported by a test ($uncovered_names uncovered)"
else
  F4=2
  F4_EVIDENCE="none of the $import_count affected module(s) is covered by a test ($uncovered_names uncovered)"
fi

# ---------------------------------------------------------------------------
# F5: CI presence
#
# grep over `.github/workflows/*.yml` and `*.yaml`, never a YAML parser: this
# ships to machines that have jq and nothing else, and the question is coarse
# enough that a parser would buy accuracy nobody spends. See the header for
# what that costs.
# ---------------------------------------------------------------------------
# `pull_request_target` counts: it runs on pull requests, which is all this
# factor asks. The event token is terminated so a key merely starting with the
# word does not match, and the four spellings GitHub accepts on the `on:` line
# (scalar, flow sequence `[push, pull_request]`, flow map `{pull_request: ...}`,
# and the block form below) all land on the same test.
PR_EVENT_RE='pull_request(_target)?([[:space:],]|\]|\}|:|$)'
pr_trigger() {
  _m=$(grep -m1 -E "^[\"']?on[\"']?:[[:space:]]*.*$PR_EVENT_RE" "$1" 2>/dev/null || true)
  if [ -n "$_m" ]; then
    # The trigger, not the line it sits on: "on: [push, pull_request]" reads
    # back as "on on: [push, pull_request]" once the evidence puts "on" in
    # front of it.
    printf '%s' "$_m" | sed "s/^[\"']*on[\"']*:[[:space:]]*//; s/[[:space:]]*\$//"
    return 0
  fi
  # Block form: a bare `on:` line, then the event as an indented key. The bare
  # `on:` is what distinguishes a trigger from a *job* named `pull_request:` in
  # a workflow triggered `on: push`; indentation alone cannot tell those apart.
  # Eight is the indent ceiling because two- and four-space YAML styles both
  # nest the event one level under `on:`, and some files indent further.
  if grep -qE "^[\"']?on[\"']?:[[:space:]]*(#.*)?\$" "$1" 2>/dev/null; then
    _b=$(grep -m1 -E "^[[:space:]]{1,8}pull_request(_target)?:" "$1" 2>/dev/null || true)
    if [ -n "$_b" ]; then
      printf '%s' "$_b" | sed 's/^[[:space:]]*//; s/:.*$//'
      return 0
    fi
  fi
  return 1
}

# The commands a workflow actually runs: `run:` scalars, plus the bodies of
# `run: |` and `run: >` blocks. Reading every line of the file instead matched
# a commented-out `# - run: npm test`, a step *named* after a check, and a
# `cmd: npm test` passed to an action under `with:`, each of which scored F5 0
# for a workflow that runs no check at all.
run_commands() {
  awk '
    { line = $0 }
    line ~ /^[[:space:]]*#/ { next }
    { match(line, /^[[:space:]]*/); ind = RLENGTH }
    inblock == 1 && line !~ /[^[:space:]]/ { next }
    inblock == 1 && ind > blockind { print; next }
    { inblock = 0 }
    line ~ /^[[:space:]]*(-[[:space:]]+)?run:/ {
      rest = line
      sub(/^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*/, "", rest)
      if (rest ~ /^[|>]/) { inblock = 1; blockind = ind; next }
      print rest
    }
  ' "$1" 2>/dev/null
}

# A step that would exercise this fix: a package-manager invocation of one of
# the five conventional script names, or a runner invoked directly. The
# optional `[:-]` tail is what admits the names repositories actually use:
# `test:unit`, `test:ci`, `lint:fix`, `check-types`. `echo` lines are dropped
# because a workflow whose only step announces itself runs nothing.
CI_STEP_RE='(^|[[:space:]&|;(])(npm|pnpm|yarn|bun|npx|bunx)[[:space:]]+(run[[:space:]]+)?(test|build|typecheck|check|lint)([:-][^[:space:]]*)?([[:space:]]|$)|(^|[[:space:]&|;(/])(vitest|jest|playwright|cypress|tsc)([[:space:]]|$)'
ci_step() {
  run_commands "$1" \
    | grep -vE '^[[:space:]]*echo([[:space:]]|$)' \
    | grep -m1 -E "$CI_STEP_RE" \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    || true
}

CI_WORKFLOW=""
CI_TRIGGER=""
CI_STEP=""
pr_workflow=""
pr_workflow_trigger=""
workflow_count=0
for wf in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  [ -f "$wf" ] || continue
  [ -r "$wf" ] || json_error "$wf cannot be read, so whether it runs a check on this pull request could not be determined. Skipped silently it would score as a repository with less CI than it has."
  workflow_count=$((workflow_count + 1))
  trigger=$(pr_trigger "$wf" || true)
  [ -n "$trigger" ] || continue
  step=$(ci_step "$wf" || true)
  if [ -n "$step" ] && [ -z "$CI_WORKFLOW" ]; then
    CI_WORKFLOW="$wf"
    CI_TRIGGER="$trigger"
    CI_STEP="$step"
  elif [ -z "$pr_workflow" ]; then
    pr_workflow="$wf"
    pr_workflow_trigger="$trigger"
  fi
done

if [ -n "$CI_WORKFLOW" ]; then
  F5=0
  F5_EVIDENCE="$CI_WORKFLOW triggers on $CI_TRIGGER and runs: $CI_STEP"
elif [ -n "$pr_workflow" ]; then
  F5=1
  CI_WORKFLOW="$pr_workflow"
  CI_TRIGGER="$pr_workflow_trigger"
  F5_EVIDENCE="$CI_WORKFLOW triggers on $CI_TRIGGER, but no test, build, typecheck, check, or lint step is visible in it"
elif [ "$workflow_count" -gt 0 ]; then
  F5=2
  F5_EVIDENCE="$workflow_count GitHub Actions workflow file(s), none triggering on a pull request"
else
  F5=2
  F5_EVIDENCE="no GitHub Actions workflow triggers on this pull request; another CI vendor is not read"
fi

# ---------------------------------------------------------------------------
# F6: override blast radius
#
# Categorical rather than a bare number, so the caller states what it did and
# the script decides what that is worth. The evidence says which shape was
# applied, because the whole point of the factor is that a reviewer can see a
# global pin without reading the diff.
# ---------------------------------------------------------------------------
case "$OVERRIDE_SCOPE" in
  none)
    F6=0
    # States only what the scope value attests to, which is that this change
    # applies no override. `none` is also what the audit-pins agent passes for
    # a pin *removal* (plugins/gh-security/agents/audit-pins.md), where no
    # version moved at all, so the old "the direct dependency was updated"
    # clause asserted a bump the scorer has no input for and that those runs
    # never made ([#80](https://github.com/SurveyMonkey/skills/issues/80)).
    F6_EVIDENCE="no override applied by this change" ;;
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
# F7: distance from the declared ranges
#
# Distance is the widest of two measures: the majors between the resolved
# versions, and the majors between any dependent's declared floor and where
# the fix lands. The second catches what the first cannot: a parent stuck on
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

# The counts and the workflow the score rests on, so a PR body can cite them
# without re-deriving anything and a reviewer can check the verdict against
# what was actually read.
UNCOVERED_JSON=$(printf '%s\n' "$UNCOVERED" | jq -Rs 'split("\n") | map(select(length > 0))')
# Null, not zero, when the surface could not be measured: "no affected modules"
# and "nobody could say which modules are affected" are different facts, and
# only one of them is evidence the fix is small.
if [ "$PARENTS_KNOWN" = true ]; then
  AFFECTED_JSON="$import_count"
  COVERED_JSON="$COVERED_COUNT"
else
  AFFECTED_JSON=null
  COVERED_JSON=null
fi

jq -n \
  --argjson declared_ranges "$DECLARED_JSON" \
  --argjson affected "$AFFECTED_JSON" --argjson covered "$COVERED_JSON" \
  --argjson uncovered "$UNCOVERED_JSON" \
  --arg ci_workflow "$CI_WORKFLOW" --arg ci_trigger "$CI_TRIGGER" \
  --arg ci_step "$CI_STEP" \
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
    {id: "F4", name: "Test coverage",           score: $f4, evidence: $e4},
    {id: "F5", name: "CI presence",             score: $f5, evidence: $e5},
    {id: "F6", name: "Override blast radius",   score: $f6, evidence: $e6},
    {id: "F7", name: "Declared-range distance", score: $f7, evidence: $e7}
  ] as $factors
  | ($factors | map(.score) | add) as $score
  # Fully parenthesized: jq 1.7 binds `as` tighter than `*`, reading
  # `E * 2 as $max | rest` like `E * (2 as $max | rest)`, which multiplies the
  # factor count by the final object of the pipeline and aborts. jq 1.8 reads
  # it as intended, which is how this passed everywhere but ubuntu (issue #59).
  # This is a jq comment inside a single-quoted shell string; no apostrophes.
  | (($factors | length) * 2) as $max
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
      coverage: {affected: $affected, covered: $covered, uncovered: $uncovered},
      ci: {
        workflow: (if $ci_workflow == "" then null else $ci_workflow end),
        trigger:  (if $ci_trigger == ""  then null else $ci_trigger end),
        step:     (if $ci_step == ""     then null else $ci_step end)
      },
      factors: $factors,
      markdown: (
        (if   $band == "Low"    then "🟢"
         elif $band == "Medium" then "🟡"
         elif $band == "High"   then "🔴"
         else error("unknown band: \($band)") end) as $emoji
        | "## Merge risk: \($emoji) \($band) (\($score)/\($max))\n\n"
        + (if $band != $raw_band
           then "> Escalated from \($raw_band): \($applied | join("; ")).\n\n"
           else "" end)
        + "| Factor | Score | Evidence |\n|---|---|---|\n"
        + ($factors | map("| \(.name) | \(.score) | \(.evidence) |") | join("\n"))
        + "\n"
      )
    }'
