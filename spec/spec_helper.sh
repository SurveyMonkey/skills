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
