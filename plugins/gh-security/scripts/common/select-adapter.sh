#!/usr/bin/env bash
# select-adapter.sh — route a Dependabot alert to its ecosystem adapter
#
# Usage:
#   select-adapter.sh --ecosystem <eco> [--manifest <path>]
#   select-adapter.sh --from-discovery < discovery.json
#
# Output (single):  {ecosystem, supported, adapter, adapter_path, manifest}
# Output (batch):   the discovery JSON with each group annotated, plus groups
#                   for unsupported ecosystems moved into `skipped`.
#
# Routing keys on the alert's own `dependency.package.ecosystem` and
# `manifest_path`, never on scanning the repository root. A polyglot repo has
# one lockfile per toolchain, and only the alert knows which one it belongs to.
#
# Unsupported ecosystems are reported, never treated as an error: exit stays 0
# and `supported` is false. GitHub's advisory ecosystem enum is rubygems, npm,
# pip, maven, nuget, composer, go, rust, erlang, actions, pub, swift, other.
# Only `npm` ships an adapter today; `pip` arrives in Phase 6 (issue #9).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ECOSYSTEMS_DIR=$(cd "$SCRIPT_DIR/../ecosystems" && pwd)

ECOSYSTEM=""
MANIFEST=""
FROM_DISCOVERY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --ecosystem)      ECOSYSTEM="${2:?--ecosystem requires a value}"; shift 2 ;;
    --manifest)       MANIFEST="${2:?--manifest requires a value}"; shift 2 ;;
    --from-discovery) FROM_DISCOVERY=true; shift ;;
    *)
      printf '{"error":"Unknown argument: %s"}\n' "$1" >&2
      exit 1
      ;;
  esac
done

# Ecosystem -> adapter basename. The single place routing is decided.
adapter_for() {
  case "$1" in
    npm) printf 'node\n' ;;
    *)   printf '\n' ;;
  esac
}

emit_one() {
  eco="$1"
  manifest="$2"
  adapter=$(adapter_for "$eco")

  if [ -z "$adapter" ]; then
    jq -n --arg eco "$eco" --arg manifest "$manifest" \
      '{ecosystem: $eco, supported: false, adapter: null, adapter_path: null,
        manifest: (if $manifest == "" then null else $manifest end),
        skip: true, reason: "ecosystem not supported yet"}'
    return 0
  fi

  path="$ECOSYSTEMS_DIR/$adapter.sh"
  if [ ! -x "$path" ]; then
    printf '{"error":"Adapter for ecosystem %s resolved to %s, which is missing or not executable"}\n' \
      "$eco" "$path" >&2
    exit 1
  fi

  jq -n --arg eco "$eco" --arg adapter "$adapter" --arg path "$path" --arg manifest "$manifest" \
    '{ecosystem: $eco, supported: true, adapter: $adapter, adapter_path: $path,
      manifest: (if $manifest == "" then null else $manifest end),
      skip: false, reason: null}'
}

if [ "$FROM_DISCOVERY" = true ]; then
  input=$(cat)
  printf '%s' "$input" | jq empty 2>/dev/null || {
    printf '{"error":"--from-discovery expects discovery JSON on stdin"}\n' >&2
    exit 1
  }

  # Annotate in place. Groups whose ecosystem has no adapter move to `skipped`
  # with the same shape the discovery script already uses, so a caller handles
  # "no adapter" and "no fix available" through one code path.
  printf '%s' "$input" | jq --arg dir "$ECOSYSTEMS_DIR" '
    def adapter_of:
      if . == "npm" then "node" else null end;

    def annotate:
      . as $g
      | ($g.ecosystem | adapter_of) as $a
      | $g + {
          adapter: $a,
          adapter_path: (if $a == null then null else "\($dir)/\($a).sh" end),
          supported: ($a != null)
        };

    . as $input
    | (($input.actionable // []) | map(annotate)) as $all
    | {
        actionable: [ $all[] | select(.supported) ],
        skipped: (($input.skipped // []) + [
          $all[] | select(.supported | not)
                 | . + {reason: "ecosystem not supported yet"}
        ])
      }
    '
  exit 0
fi

if [ -z "$ECOSYSTEM" ]; then
  printf '{"error":"Usage: select-adapter.sh --ecosystem <eco> [--manifest <path>] | --from-discovery"}\n' >&2
  exit 1
fi

emit_one "$ECOSYSTEM" "$MANIFEST"
