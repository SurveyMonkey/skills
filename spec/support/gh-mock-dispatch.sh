#!/bin/sh
# shellcheck shell=sh
# The gh mock's dispatcher: one process per `gh` call, driven entirely by the
# registry spec_helper.sh's mock_gh_reply / mock_gh_fail append to. See the
# comment on GH_MOCK_DISPATCH in spec_helper.sh for why this is a standalone
# script rather than a shell function.
#
# $GH_MOCK_DIR (exported by mock_gh_reset) holds:
#   registry  - one line per mock_gh_reply/mock_gh_fail call, tab-separated:
#               type, exit, key, payload, extra
#   requests  - one line per gh call actually made, request shape only
#
# A call is logged before it is matched, deliberately: an unhandled call must
# still show up in mock_gh_requests, the same rule the per-file blocks this
# replaces already got right (a silently rejected mutating call must not read
# as a clean log).

set -eu

argv_file=$(mktemp)
trap 'rm -f "$argv_file"' EXIT

for arg in "$@"; do
  printf '%s\n' "$arg" >> "$argv_file"
done
printf '%s\n' "$*" >> "$GH_MOCK_DIR/requests"

# Does every space-separated token of `key` match an argument of the call, in
# order? Tokens need not match contiguous arguments (`pr list --search
# head:<branch>` matches past `--repo`). A token matches either the whole
# argument, or a leading part of it followed immediately by `?` (a key with
# no query string matches an `api` call whose path carries one) — never an
# arbitrary prefix, or `fix/dependabot-lodash` would also match the unrelated
# branch `fix/dependabot-lodash-4x`.
key_matches() {
  awk -v key="$1" '
    BEGIN { n = split(key, toks, " ") }
    { argv[NR] = $0 }
    END {
      # An empty key (no tokens) must never match: awk finds nothing to fail
      # on and would otherwise fall through to the unconditional exit 0
      # below, turning a key-less registry row into a match-everything
      # catch-all.
      if (n == 0) exit 1
      ai = 1
      for (ti = 1; ti <= n; ti++) {
        found = 0
        while (ai <= NR) {
          tok = toks[ti]
          if (index(argv[ai], tok) == 1) {
            rest = substr(argv[ai], length(tok) + 1)
            if (rest == "" || substr(rest, 1, 1) == "?") {
              found = 1; ai++; break
            }
          }
          ai++
        }
        if (!found) exit 1
      }
      exit 0
    }
  ' "$argv_file"
}

match_type=
match_exit=
match_payload=
match_extra=

if [ -s "$GH_MOCK_DIR/registry" ]; then
  while IFS="$(printf '\t')" read -r type xit key payload extra; do
    # A registration guard in spec_helper.sh already refuses a key or text
    # that would corrupt this format, but the dispatcher checks its own input
    # rather than trusting that: a row whose type is neither is skipped
    # rather than treated as a candidate match.
    case $type in
      reply|fail) ;;
      *) continue ;;
    esac
    if key_matches "$key"; then
      match_type=$type
      match_exit=$xit
      match_payload=$payload
      match_extra=$extra
    fi
  done < "$GH_MOCK_DIR/registry"
fi

if [ -z "$match_type" ]; then
  printf 'unhandled: %s\n' "$*" >&2
  exit 1
fi

if [ "$match_type" = fail ]; then
  printf '%s\n' "$match_payload" >&2
  exit "$match_exit"
fi

[ -z "$match_extra" ] || cat "$match_extra" >&2
cat "$match_payload"
