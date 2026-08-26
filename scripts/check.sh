#!/usr/bin/env bash
# check.sh: the quality gates. One definition, three callers: the committed
# git hooks in .githooks/, the workflow in .github/workflows/gates.yml, and
# humans running it directly.
#
# Usage: scripts/check.sh <lint|validate|spec|version|fast|all|targets>
#
#   lint      ShellCheck over every tracked shell file
#   validate  claude plugin validate --strict over the marketplace manifest
#             and every plugin under plugins/*/
#   spec      the shellspec suite (serial; set SHELLSPEC_JOBS=N for parallel)
#   version   every plugin whose files changed since the merge base carries a
#             plugin.json version that differs from the base's
#   fast      lint + validate, the ~2s pair, for running by hand (the
#             pre-commit hook invokes lint and validate separately so each
#             can warn about its own missing tool)
#   all       lint + validate + spec + version
#   targets   print the lint target list, for inspection
#
# This is dev tooling, not shipped plugin code: unlike the scripts under
# plugins/gh-security/scripts/ it may assume git, jq, shellcheck, shellspec,
# and the claude CLI. It still targets bash 3.2, because the hooks run it on
# stock macOS.
#
# The version gate answers exactly one question: if the tip of this branch
# became the default branch, would users be handed changed plugin code at a
# version string they already have? Nothing else can catch that, because a
# plugin's version lives in its own plugin.json and nowhere else (root
# CLAUDE.md, "Releasing a plugin"): bumping it *is* the release, and every
# other gate is green when it is forgotten. It reads only committed state, so
# uncommitted edits in the working tree are invisible to it by design.
#
# Where it runs (ADR 005): the pull request whose base is the default branch,
# and the push that lands on the default branch. Both are moments where the
# comparison base is unambiguous. It is deliberately absent from `fast` and
# from the git hooks: a hook's base would be whatever `origin/<default>` last
# fetched, so its verdict would depend on how recently the developer fetched,
# and a mid-work commit legitimately has no bump yet. The bump is a release
# act, not a commit act.
#
# Stacked pull requests: one bump per stack is the rule, so a layer sitting
# above the bump carries it and passes, while a layer below it does not and
# fails. That is why the workflow runs this gate only for pull requests whose
# base ref IS the default branch; a stacked layer skips loudly and is
# exercised when it retargets. The bottom layer of a stack whose bump lives
# further up is flagged, correctly: merged alone it would ship plugin changes
# to the default branch at an already-released version. The remedies are to
# merge the stack as a unit or to put the bump in the bottom layer.
#
# Every gate refuses when its target discovery finds nothing. Zero shell
# files, zero plugin manifests, or zero executed spec examples means
# discovery broke, not that the tree is clean; "found nothing" reported as
# success is this repo's signature bug class (root CLAUDE.md), and shellspec
# itself exits 0 on an empty suite, so the floor has to live here.
set -euo pipefail

die() {
  printf 'check: %s\n' "$*" >&2
  exit 2
}

# git exports GIT_DIR (and sometimes GIT_WORK_TREE) to hooks, under which
# `rev-parse --show-toplevel` answers for that repository or refuses with
# "must be run in a work tree" regardless of cwd; observed live from the
# pre-push hook in a linked worktree. This script is always invoked with the
# cwd inside the repo it should check, so discovery from cwd is the correct
# behavior everywhere and the inherited environment never is.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) \
  || die 'not inside a git repository'
cd "$repo_root"

# Discovery, never a written-down list: git's index is the source of truth,
# so a newly staged script is covered the moment it exists and this script
# lints itself. The .githooks/ entries carry no .sh suffix, hence the second
# pathspec.
shell_targets() {
  git ls-files -- '*.sh' '.githooks/*'
}

cmd_targets() {
  shell_targets
}

cmd_lint() {
  # One discovery feeds both the count and the invocation, so the guard and
  # the work cannot disagree about what was found.
  local targets n=0 f
  targets=$(shell_targets)
  while IFS= read -r f; do
    if [ -n "$f" ]; then n=$((n + 1)); fi
  done < <(printf '%s\n' "$targets")
  [ "$n" -gt 0 ] || die 'no shell files discovered; refusing to report a pass'
  # Paths, never stdin: ShellCheck resolves spec/.shellcheckrc relative to
  # the file being checked, and stdin has no path.
  printf '%s\n' "$targets" | tr '\n' '\0' | xargs -0 shellcheck
}

# Enumerate plugins rather than naming any: this marketplace is built to carry
# several at independent versions, and a hardcoded name would leave plugin two
# ungated the day it lands. Callers count the result before doing any work, so
# the empty-discovery refusal never depends on a tool being installed.
#
# A directory is a plugin when it carries a manifest *now*: a plugin deleted
# since the base has none, and removing one from the marketplace is not a
# release of it.
plugin_dirs() {
  local m
  for m in plugins/*/.claude-plugin/plugin.json; do
    # bash 3.2 leaves the literal glob in place on no match
    [ -f "$m" ] || continue
    printf '%s\n' "${m%/.claude-plugin/plugin.json}"
  done
}

# Fills the caller's `plugins` array, which the caller declares `local` (bash
# scopes dynamically, so the assignment here lands in that local). An array
# cannot come back through stdout intact, and both callers want the same
# refusal on an empty result.
read_plugin_dirs() {
  local d
  plugins=()
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    plugins[${#plugins[@]}]=$d
  done < <(plugin_dirs)
  [ "${#plugins[@]}" -gt 0 ] \
    || die 'no plugin manifests found under plugins/*/; refusing to report a pass'
}

cmd_validate() {
  [ -f .claude-plugin/marketplace.json ] \
    || die 'marketplace manifest missing at .claude-plugin/marketplace.json'
  local plugins
  read_plugin_dirs
  # </dev/null: the hooks run without a TTY, and the CLI must never block on
  # a prompt there.
  claude plugin validate .claude-plugin/marketplace.json --strict </dev/null
  local p
  for p in "${plugins[@]}"; do
    claude plugin validate "$p" --strict </dev/null
  done
}

cmd_spec() {
  local specs=0 f
  for f in spec/*_spec.sh; do
    [ -f "$f" ] || continue
    specs=$((specs + 1))
  done
  [ "$specs" -gt 0 ] || die 'no spec files found under spec/; refusing to report a pass'
  # The suite's own report is the output; the copy kept aside is only for the
  # floor below. The trap covers the failing-suite path, where set -e leaves
  # the rm below unreachable.
  # Deliberately not local: the EXIT trap fires after locals are gone, where
  # an unset $report would trip set -u.
  report=$(mktemp) || die 'mktemp failed'
  trap 'rm -f "$report"' EXIT
  # CHECK_SPEC_SHELL routes to --shell on the CLI, which overrides .shellspec
  # and refuses an unknown shell. It exists because the SHELLSPEC_SHELL env
  # var is silently ignored when a config file sets --shell (verified), and a
  # shell override that silently does not apply is a misconfiguration this
  # repo refuses on principle. CI's ubuntu leg uses it: dash cannot run the
  # bash-shebanged scripts (issue #57).
  local args=()
  if [ -n "${SHELLSPEC_JOBS:-}" ]; then
    args[${#args[@]}]=--jobs
    args[${#args[@]}]=$SHELLSPEC_JOBS
  fi
  if [ -n "${CHECK_SPEC_SHELL:-}" ]; then
    args[${#args[@]}]=--shell
    args[${#args[@]}]=$CHECK_SPEC_SHELL
  fi
  # ${args[@]+...}: bash 3.2's set -u rejects expanding an empty array.
  shellspec ${args[@]+"${args[@]}"} 2>&1 | tee "$report"
  # shellspec exits 0 having run zero examples, and a skipped example is
  # green too, so a green exit alone would pass a suite that never ran or
  # one whose Skip-if predicates quietly inverted and skipped everything
  # (the bash 3.2 gate is exactly such a predicate). Read the summary and
  # require at least one example to have actually executed. ANSI codes are
  # stripped first: --color via .shellspec-local prefixes the summary line.
  local esc summary count skips
  esc=$(printf '\033')
  summary=$(awk -v esc="$esc" \
    '{ gsub(esc "\\[[0-9;]*m", "") } /^[0-9]+ examples?,/ { print; exit }' \
    "$report")
  count=$(printf '%s\n' "$summary" | awk '{ print $1 }')
  skips=$(printf '%s\n' "$summary" \
    | awk '{ for (i = 2; i <= NF; i++) if ($i ~ /^skips?$/) { print $(i - 1); exit } }')
  case "$count" in
    '' | *[!0-9]*) die 'could not read an example count from the shellspec summary' ;;
  esac
  case "$skips" in
    '') skips=0 ;;
    *[!0-9]*) die 'could not read the skip count from the shellspec summary' ;;
  esac
  [ "$count" -gt 0 ] || die 'the suite ran zero examples; zero is never a pass'
  [ "$((count - skips))" -gt 0 ] \
    || die "all $count examples were skipped; a fully skipped suite is never a pass"
  rm -f "$report"
}

# The commit-ish the version gate compares against, before the merge-base is
# taken. Every caller goes through the merge base, so an explicit
# CHECK_VERSION_BASE may be a branch, a tag, or a raw sha: the workflow passes
# the default branch's remote-tracking ref on a pull request and the push
# event's `before` sha on the default branch, and both are ancestors, for
# which the merge base is the value itself.
#
# Without that variable the base is whatever origin calls its default branch.
# `git clone` sets refs/remotes/origin/HEAD, but a repository added with
# `git remote add` never has it, and refusing outright there would break
# clones that did nothing wrong. So an unset origin/HEAD falls back to the one
# obvious candidate and says so on stderr; two candidates or none is a
# genuinely undeterminable base and refuses, naming both remedies. Nothing
# here fetches: a gate that reaches the network is a gate that fails offline.
version_base_ref() {
  local ref candidates=() c
  if [ -n "${CHECK_VERSION_BASE:-}" ]; then
    printf '%s\n' "$CHECK_VERSION_BASE"
    return 0
  fi
  if ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD); then
    printf '%s\n' "$ref"
    return 0
  fi
  for c in refs/remotes/origin/main refs/remotes/origin/master; do
    if git rev-parse --verify --quiet "$c" >/dev/null; then
      candidates[${#candidates[@]}]=$c
    fi
  done
  if [ "${#candidates[@]}" -eq 1 ]; then
    printf 'check: origin/HEAD is not set; comparing against %s.\n' "${candidates[0]}" >&2
    printf 'check: set it once with: git remote set-head origin --auto\n' >&2
    printf '%s\n' "${candidates[0]}"
    return 0
  fi
  printf 'check: origin/HEAD is unset and origin/main, origin/master are not\n' >&2
  printf 'check: exactly one candidate. Set it with: git remote set-head origin --auto\n' >&2
  printf 'check: or name the base explicitly with: CHECK_VERSION_BASE=<ref>\n' >&2
  die 'cannot determine a default branch to compare against'
}

cmd_version() {
  local plugins ref base short p touched head_manifest head_json head_v
  local base_json base_v failed=0
  read_plugin_dirs
  ref=$(version_base_ref) || exit
  git rev-parse --verify --quiet "$ref^{commit}" >/dev/null \
    || die "the comparison base $ref does not resolve to a commit in this repository"
  base=$(git merge-base HEAD "$ref") \
    || die "HEAD and $ref share no history; cannot compute a comparison base"
  short=$(git rev-parse --short "$base")
  printf 'check: comparing against %s (%s)\n' "$ref" "$short"
  for p in "${plugins[@]}"; do
    head_manifest=$p/.claude-plugin/plugin.json
    touched=$(git diff --name-only "$base" HEAD -- "$p") \
      || die "git diff failed for $p"
    if [ -z "$touched" ]; then
      printf 'check: %s: unchanged since %s; no release, no bump required\n' "$p" "$short"
      continue
    fi
    # Both sides come out of git, never the working tree: the diff above
    # already speaks for committed state, and mixing the two would pass a
    # branch whose bump is only an unsaved edit.
    head_json=$(git show "HEAD:$head_manifest") \
      || die "$head_manifest is not committed at HEAD; commit it before releasing"
    head_v=$(printf '%s\n' "$head_json" | jq -r '.version // empty') \
      || die "could not read a version from $head_manifest"
    [ -n "$head_v" ] || die "$head_manifest carries no .version"
    if ! base_json=$(git show "$base:$head_manifest" 2>/dev/null); then
      printf 'check: %s: added since %s (no manifest at the base); no bump required\n' \
        "$p" "$short"
      continue
    fi
    base_v=$(printf '%s\n' "$base_json" | jq -r '.version // empty') \
      || die "could not read a version from $head_manifest at $short"
    if [ "$head_v" != "$base_v" ]; then
      printf 'check: %s: %s -> %s\n' "$p" "$base_v" "$head_v"
      continue
    fi
    failed=1
    printf 'check: %s: files changed since %s but .version is still %s (base: %s)\n' \
      "$p" "$short" "$head_v" "$base_v" >&2
  done
  if [ "$failed" -ne 0 ]; then
    printf 'check: a plugin version lives in its own plugin.json and nowhere else,\n' >&2
    printf 'check: and bumping it IS the release: users receive the change only when\n' >&2
    printf 'check: that string changes (root CLAUDE.md, "Releasing a plugin").\n' >&2
    printf 'check: Bump the version, or, for a stack whose bump lives in another\n' >&2
    printf 'check: layer, merge the stack as a unit.\n' >&2
    exit 1
  fi
}

cmd_fast() {
  cmd_lint
  cmd_validate
}

cmd_all() {
  cmd_lint
  cmd_validate
  cmd_spec
  cmd_version
}

case "${1:-}" in
  targets) cmd_targets ;;
  lint) cmd_lint ;;
  validate) cmd_validate ;;
  spec) cmd_spec ;;
  version) cmd_version ;;
  fast) cmd_fast ;;
  all) cmd_all ;;
  *) die 'usage: scripts/check.sh <lint|validate|spec|version|fast|all|targets>' ;;
esac
