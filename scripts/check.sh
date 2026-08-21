#!/usr/bin/env bash
# check.sh: the quality gates. One definition, three callers: the committed
# git hooks in .githooks/, the workflow in .github/workflows/gates.yml, and
# humans running it directly.
#
# Usage: scripts/check.sh <lint|validate|spec|fast|all|targets>
#
#   lint      ShellCheck over every tracked shell file
#   validate  claude plugin validate --strict over the marketplace manifest
#             and every plugin under plugins/*/
#   spec      the shellspec suite (serial; set SHELLSPEC_JOBS=N for parallel)
#   fast      lint + validate, the ~2s pair, for running by hand (the
#             pre-commit hook invokes lint and validate separately so each
#             can warn about its own missing tool)
#   all       lint + validate + spec
#   targets   print the lint target list, for inspection
#
# This is dev tooling, not shipped plugin code: unlike the scripts under
# plugins/gh-security/scripts/ it may assume git, shellcheck, shellspec, and
# the claude CLI. It still targets bash 3.2, because the hooks run it on stock
# macOS.
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

cmd_validate() {
  [ -f .claude-plugin/marketplace.json ] \
    || die 'marketplace manifest missing at .claude-plugin/marketplace.json'
  # Enumerate plugins rather than naming any: this marketplace is built to
  # carry several at independent versions, and a hardcoded name would leave
  # plugin two ungated the day it lands. Count before invoking anything, so
  # the empty-discovery refusal does not depend on the CLI being installed.
  local plugins=() m
  for m in plugins/*/.claude-plugin/plugin.json; do
    # bash 3.2 leaves the literal glob in place on no match
    [ -f "$m" ] || continue
    plugins[${#plugins[@]}]=${m%/.claude-plugin/plugin.json}
  done
  [ "${#plugins[@]}" -gt 0 ] \
    || die 'no plugin manifests found under plugins/*/; refusing to report a pass'
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

cmd_fast() {
  cmd_lint
  cmd_validate
}

cmd_all() {
  cmd_lint
  cmd_validate
  cmd_spec
}

case "${1:-}" in
  targets) cmd_targets ;;
  lint) cmd_lint ;;
  validate) cmd_validate ;;
  spec) cmd_spec ;;
  fast) cmd_fast ;;
  all) cmd_all ;;
  *) die 'usage: scripts/check.sh <lint|validate|spec|fast|all|targets>' ;;
esac
