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
#   fast      lint + validate (the ~2s pair the pre-commit hook runs)
#   all       lint + validate + spec
#   targets   print the lint target list, for inspection
#
# This is dev tooling, not shipped plugin code: unlike the scripts under
# plugins/gh-security/scripts/ it may assume git, shellcheck, shellspec, and
# the claude CLI. It still targets bash 3.2, because the hooks run it on stock
# macOS.
#
# Every gate refuses when its target discovery finds nothing. Zero shell
# files, zero plugin manifests, or zero spec examples means discovery broke,
# not that the tree is clean; "found nothing" reported as success is this
# repo's signature bug class (root CLAUDE.md), and shellspec itself exits 0
# on an empty suite, so the floor has to live here.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

die() {
  printf 'check: %s\n' "$*" >&2
  exit 2
}

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
  local n=0 f
  while IFS= read -r f; do
    if [ -n "$f" ]; then n=$((n + 1)); fi
  done < <(shell_targets)
  [ "$n" -gt 0 ] || die 'no shell files discovered; refusing to report a pass'
  # Paths, never stdin: ShellCheck resolves spec/.shellcheckrc relative to
  # the file being checked, and stdin has no path.
  shell_targets | tr '\n' '\0' | xargs -0 shellcheck
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
  # example-count floor below.
  local report
  report=$(mktemp)
  if [ -n "${SHELLSPEC_JOBS:-}" ]; then
    shellspec --jobs "$SHELLSPEC_JOBS" 2>&1 | tee "$report"
  else
    shellspec 2>&1 | tee "$report"
  fi
  # shellspec exits 0 having run zero examples, so a green exit alone would
  # claim "tests passed" for a suite that never ran. Read the count out of
  # the summary line and refuse anything that is not a positive number.
  local count
  count=$(awk '/^[0-9]+ examples?/ { print $1; exit }' "$report")
  rm -f "$report"
  case "$count" in
    '' | *[!0-9]*) die 'could not read an example count from the shellspec summary' ;;
  esac
  [ "$count" -gt 0 ] || die 'the suite ran zero examples; zero is never a pass'
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
