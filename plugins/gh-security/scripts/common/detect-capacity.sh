#!/usr/bin/env bash
# detect-capacity.sh — derive the machine-wide subagent concurrency cap
#
# Usage: detect-capacity.sh [meminfo-path]
# Output: {cap, cores, total_ram_gb, cores_slots, ram_slots, limited_by,
#          fallback, fallback_reason}
#
# cap = clamp(min(floor(cores / 3), floor(total_ram_gb / 8)), 3, 6)
#
# Each fix subagent runs a dependency install plus the repository's own
# scripts, which parallelize internally across cores, so a small number of
# concurrent agents saturates a laptop well before any harness limit. Total
# RAM is used rather than available RAM so the cap is deterministic per
# machine instead of fluctuating per invocation.
#
# Reads are unprivileged: `sysctl` on macOS, `nproc` and /proc/meminfo on
# Linux. The optional positional argument overrides the meminfo path and is
# the documented test seam (precedent: detect-scope.sh [path]); specs point it
# at a fixture instead of the live file.
#
# Any detection failure — unknown OS, missing command, non-numeric output,
# unreadable meminfo — produces the fallback cap of 3 and exits 0. A cap of 3
# is a usable answer; what is never emitted is a cap derived from garbage
# (cores: 0 is a parse failure, not a machine with no cores).
#
# `limited_by` names the constraint that produced the cap: cores | ram |
# floor | ceiling | fallback. When cores and RAM tie, cores is reported.

set -euo pipefail

MEMINFO="${1:-/proc/meminfo}"

CORES=""
RAM_BYTES=""
RAM_KB=""
FALLBACK_REASON=""

# Every branch either fills CORES plus exactly one of RAM_BYTES / RAM_KB with
# digit-only values, or sets FALLBACK_REASON.
OS=$(uname -s 2>/dev/null || printf '')
case "$OS" in
  Darwin)
    CORES=$(sysctl -n hw.ncpu 2>/dev/null || printf '')
    RAM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || printf '')
    if ! printf '%s' "$CORES" | grep -Eq '^[0-9]+$'; then
      FALLBACK_REASON="sysctl hw.ncpu returned non-numeric output"
    elif ! printf '%s' "$RAM_BYTES" | grep -Eq '^[0-9]+$'; then
      FALLBACK_REASON="sysctl hw.memsize returned non-numeric output"
    fi
    ;;
  Linux)
    CORES=$(nproc 2>/dev/null || printf '')
    RAM_KB=$(awk '/^MemTotal:/ {print $2; exit}' "$MEMINFO" 2>/dev/null || printf '')
    if ! printf '%s' "$CORES" | grep -Eq '^[0-9]+$'; then
      FALLBACK_REASON="nproc returned non-numeric output"
    elif ! printf '%s' "$RAM_KB" | grep -Eq '^[0-9]+$'; then
      FALLBACK_REASON="MemTotal not found in $MEMINFO"
    fi
    ;;
  '')
    FALLBACK_REASON="uname produced no output"
    ;;
  *)
    FALLBACK_REASON="unsupported OS: $OS"
    ;;
esac

if [ -n "$FALLBACK_REASON" ]; then
  jq -n --arg reason "$FALLBACK_REASON" '{
    cap: 3,
    cores: null,
    total_ram_gb: null,
    cores_slots: null,
    ram_slots: null,
    limited_by: "fallback",
    fallback: true,
    fallback_reason: $reason
  }'
  exit 0
fi

# The math lives in jq: it carries the data structures anyway, and jq numbers
# do not overflow on hw.memsize the way 32-bit shell arithmetic could.
jq -n \
  --arg cores "$CORES" \
  --arg ram_bytes "${RAM_BYTES:-}" \
  --arg ram_kb "${RAM_KB:-}" \
  '
  ($cores | tonumber) as $c
  | (if $ram_bytes != "" then ($ram_bytes | tonumber) / 1073741824
     else ($ram_kb | tonumber) / 1048576
     end) as $gb
  | (($c / 3) | floor) as $cores_slots
  | (($gb / 8) | floor) as $ram_slots
  | ([$cores_slots, $ram_slots] | min) as $raw
  | ([3, ([$raw, 6] | min)] | max) as $cap
  | {
      cap: $cap,
      cores: $c,
      total_ram_gb: (($gb * 10 | round) / 10),
      cores_slots: $cores_slots,
      ram_slots: $ram_slots,
      limited_by: (
        if $raw < 3 then "floor"
        elif $raw > 6 then "ceiling"
        elif $cores_slots <= $ram_slots then "cores"
        else "ram"
        end
      ),
      fallback: false,
      fallback_reason: null
    }
  '
