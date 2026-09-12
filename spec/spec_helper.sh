#!/bin/sh
# shellcheck shell=sh
# shellspec helper for the gh-security suites.

spec_helper_precheck() {
  minimum_version "0.28.0"
  if ! command -v jq >/dev/null 2>&1; then
    abort "jq is required to run these specs"
  fi
}

spec_helper_loaded() { :; }
spec_helper_configure() { :; }

export SCRIPTS="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts"
export ADAPTER="$SCRIPTS/ecosystems/node.sh"
export COMMON="$SCRIPTS/common"
export FIXTURES="$SHELLSPEC_PROJECT_ROOT/spec/fixtures"

# Copy a fixture into a scratch directory and cd there.
#
# Specs that mutate a manifest (apply_constraint writes package.json) must never
# touch the committed fixture, so every example gets its own copy.
use_fixture() {
  TEST_DIR=$(mktemp -d)
  cp -R "$FIXTURES/$1/." "$TEST_DIR/"
  cd "$TEST_DIR" || return 1
  fake_linked_worktree
}

# Make the current directory look like the root of a linked git worktree.
#
# The cwd guard (common/require-linked-worktree.sh) classifies by inspecting
# the enclosing repository's `.git`, so a worktree is faked with the pointer
# file `git worktree add` writes. Scratch directories are otherwise outside
# any repository, which the guard refuses, and the mutating verbs are the ones
# most fixtures exercise.
fake_linked_worktree() {
  printf 'gitdir: %s\n' "${1:-/elsewhere/.git/worktrees/fix}" > .git
}

# The opposite: the user's own checkout, which every cwd-sensitive script must
# refuse to touch.
fake_primary_checkout() {
  rm -f .git
  mkdir -p .git
}

cleanup_fixture() {
  if [ -n "${TEST_DIR:-}" ] && [ -d "$TEST_DIR" ]; then
    cd "$SHELLSPEC_PROJECT_ROOT" || return 0
    rm -rf "$TEST_DIR"
  fi
}

# Run the adapter and reduce stdout to a compact jq projection, so examples
# assert exact JSON rather than string-matching pretty-printed output.
#
# The adapter's exit status is preserved on failure; on success the status is
# jq's. Examples that care about a specific non-zero exit assert it with
# `When run script "$ADAPTER" ...` instead.
adapter_jq() {
  _filter=$1
  shift
  _st=0
  _out=$("$ADAPTER" "$@") || _st=$?
  # Print the projection even on a non-zero exit: validate deliberately emits
  # its report *and* fails, so returning early here would hide the report.
  if [ -n "$_out" ]; then
    printf '%s' "$_out" | jq -c "$_filter"
  fi
  return "$_st"
}

# Same, for a script under scripts/common/.
common_jq() {
  _script=$1
  _filter=$2
  shift 2
  _st=0
  _out=$("$COMMON/$_script" "$@") || _st=$?
  if [ -n "$_out" ]; then
    printf '%s' "$_out" | jq -c "$_filter"
  fi
  return "$_st"
}

# The one shared, SDK-style mock for `gh` (mocking.md, issue #196). The
# matching and reply logic lives in a standalone script,
# spec/support/gh-mock-dispatch.sh, rather than a function here: a
# command-based `Mock gh` block runs as a real subprocess whenever the script
# under test invokes gh itself (`When run script`), and shellspec's own docs
# say a command-based mock cannot call a shell function defined outside the
# block except an exported bash function — not portable to the `sh` this
# suite targets (bash 3.2 on macOS, dash-shaped elsewhere). An external
# command has no such restriction, so every migrated spec's `Mock gh` block
# is one line delegating to it.
export GH_MOCK_DISPATCH="$SHELLSPEC_PROJECT_ROOT/spec/support/gh-mock-dispatch.sh"

# Fresh scratch dir plus an empty registry and request log. Call once per
# example, before any mock_gh_reply / mock_gh_fail registration — typically
# from the spec file's own `Before` hook, alongside whatever fixture setup
# that file also needs.
mock_gh_reset() {
  GH_MOCK_DIR=$(mktemp -d)
  : > "$GH_MOCK_DIR/registry"
  : > "$GH_MOCK_DIR/requests"
  export GH_MOCK_DIR
}

# Register the stdout for one endpoint, keyed by the leading `gh` arguments
# (`api repos/octo/app/dependabot/alerts`, `pr list`, `label create
# merge-risk:low`): each space-separated token in the key must match an
# argument of the call whole, or match a leading part of it immediately
# followed by `?`, in order though not necessarily contiguous — so `pr list
# --search head:<branch>` matches past `--repo`, and a key with no query
# string matches an `api` call whose path carries one, without also matching
# an unrelated branch that merely shares a name prefix. `file` is read
# at call time, not copied, so a test that later overwrites the same path
# (many discover-alerts.sh examples rewrite $GH_MOCK_DIR/alerts.json in
# place) is answered with the new content. The optional third argument is a
# file of stderr chatter gh should still emit on this otherwise-successful
# call (the release-upgrade notice pr-status.sh must tolerate).
#
# The last registration whose key matches a given call wins, so a `Before`
# hook can register a default and one example can override it.
mock_gh_reply() {
  # The exit field is unused for a reply, but it still needs a placeholder
  # ("-"): two adjacent tabs are indistinguishable from one under `read`'s
  # IFS-whitespace field splitting, which silently swallows the empty field
  # between them and shifts every field after it by one.
  printf 'reply\t-\t%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$GH_MOCK_DIR/registry"
}

# Register a per-endpoint failure: `text` is what gh writes to stderr for
# this endpoint (the real wording the script under test classifies —
# `gh: Not Found (HTTP 404)` from `gh api`, `HTTP 422: Validation Failed: ...`
# with no `gh:` prefix from a `gh` subcommand), `exit` defaults to 1.
mock_gh_fail() {
  printf 'fail\t%s\t%s\t%s\t\n' "${3:-1}" "$1" "$2" >> "$GH_MOCK_DIR/registry"
}

# The request-shape log, one line per call, in call order. Assert request
# shape only (an endpoint was reached with a given argument, or never reached
# at all) per the testing skill; never call count or order.
mock_gh_requests() {
  cat "$GH_MOCK_DIR/requests"
}
