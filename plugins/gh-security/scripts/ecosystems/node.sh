#!/usr/bin/env bash
# node.sh — ecosystem adapter for GitHub advisory ecosystem `npm`
#
# Usage: node.sh <verb> [args]
# Contract: docs/adr/001-ecosystem-adapter-contract.md
#
# Verbs:
#   detect                                     -> toolchain metadata
#   why <pkg>                                  -> {relationship, parents[], raw}
#   resolved_versions <pkg>                    -> {present, versions[], lockfile_entries}
#   apply_constraint <pkg> <range> [parent...] -> {changes, observations[]}
#   install                                    -> pass-through, exit code is the signal
#   validate [--line <major>] [--vulnerable <range>]... <pkg> <range>
#                                              -> {ok, line_present, checked,
#                                                  violations[],
#                                                  unresolved_alerts[],
#                                                  requires_major_bump[]}
#                                                 (--line requires --vulnerable)
#   verification_commands                      -> {commands[], skipped[]}
#   compare_versions <a> <b>                   -> {result, delta}
#   shim <dir> [runner]                        -> {created, pm, shim?, path_prefix?}
#   list_pins                                  -> reserved, exits 2 (see issue #7)
#
# Exit codes: 0 ok | 1 error | 2 not implemented | 3 unsupported toolchain
#
# Run from the repository root. Targets bash 3.2; depends only on bash, jq, gh.

set -euo pipefail

# corepack prompts before downloading a package manager version; a fix run is
# not an interactive session.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

VERB="${1:-}"
if [ -z "$VERB" ]; then
  printf '{"error":"Usage: node.sh <verb> [args]"}\n' >&2
  exit 1
fi
shift || true

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

die() {
  printf '{"error":%s}\n' "$(printf '%s' "$1" | jq -Rs .)" >&2
  exit "${2:-1}"
}

# ---------------------------------------------------------------------------
# Semver, in jq.
#
# Lives in the adapter rather than common/ because Phase 6's Python adapter
# implements PEP 440 behind the same verb. Rules follow semver.org: numeric
# core, a prerelease sorts below its release, dotted identifiers compare left
# to right with numeric ranking below alphanumeric, build metadata ignored.
# ---------------------------------------------------------------------------
SEMVER_JQ=$(cat <<'JQLIB'
def semver_parse:
  (. // "") | tostring
  | sub("^[[:space:]]+"; "") | sub("[[:space:]]+$"; "")
  | sub("^[v=]+"; "")
  # `"" | split("+")` is [], so an empty version would index to null and the
  # next split would abort the whole program rather than compare as 0.0.0.
  | (split("+")[0] // "")
  | (split("-")) as $parts
  | {
      core: ($parts[0] | split(".") | map(tonumber? // 0)),
      pre:  (if ($parts | length) > 1
             then ($parts[1:] | join("-") | split("."))
             else [] end)
    };

def cmp_num($a; $b): if $a < $b then -1 elif $a > $b then 1 else 0 end;

def cmp_core($a; $b):
  ([range(0;3)] | map(cmp_num($a[.] // 0; $b[.] // 0))
   | map(select(. != 0)) | first) // 0;

def cmp_id($x; $y):
  # `tonumber?` emits *empty* for a non-numeric string, not null. Without the
  # `// null` the `as` binding would produce no output at all and the whole
  # identifier would vanish from the comparison, silently reversing results
  # like rc.1 vs beta.11.
  ($x | tonumber? // null) as $nx | ($y | tonumber? // null) as $ny
  | if $nx != null and $ny != null then cmp_num($nx; $ny)
    elif $nx != null then -1
    elif $ny != null then 1
    else (if $x < $y then -1 elif $x > $y then 1 else 0 end)
    end;

def cmp_pre($a; $b):
  if ($a | length) == 0 and ($b | length) == 0 then 0
  elif ($a | length) == 0 then 1
  elif ($b | length) == 0 then -1
  else
    ([range(0; ([($a | length), ($b | length)] | max))]
     | map(. as $i
           | if   $i >= ($a | length) then -1
             elif $i >= ($b | length) then 1
             else cmp_id($a[$i]; $b[$i]) end)
     | map(select(. != 0)) | first) // 0
  end;

def semver_cmp($a; $b):
  ($a | semver_parse) as $pa | ($b | semver_parse) as $pb
  | (cmp_core($pa.core; $pb.core)) as $c
  | if $c != 0 then $c else cmp_pre($pa.pre; $pb.pre) end;

def semver_delta($a; $b):
  ($a | semver_parse) as $pa | ($b | semver_parse) as $pb
  | if cmp_core($pa.core; $pb.core) != 0 then
      (if   ($pa.core[0] // 0) != ($pb.core[0] // 0) then "major"
       elif ($pa.core[1] // 0) != ($pb.core[1] // 0) then "minor"
       else "patch" end)
    elif cmp_pre($pa.pre; $pb.pre) != 0 then "prerelease"
    else "none" end;

def caret_upper:
  semver_parse | .core as $c
  | if   ($c[0] // 0) > 0 then "\($c[0] + 1).0.0"
    elif ($c[1] // 0) > 0 then "0.\($c[1] + 1).0"
    else "0.0.\(($c[2] // 0) + 1)" end;

def tilde_upper:
  semver_parse | .core as $c | "\($c[0] // 0).\(($c[1] // 0) + 1).0";

def expand_token:
  . as $t
  | if   ($t | startswith("^")) then [(">=" + $t[1:]), ("<" + ($t[1:] | caret_upper))]
    elif ($t | startswith("~")) then [(">=" + $t[1:]), ("<" + ($t[1:] | tilde_upper))]
    else [$t] end;

def eval_token($version):
  . as $tok
  | (if   ($tok | startswith(">=")) then {op: ">=", v: $tok[2:]}
     elif ($tok | startswith("<=")) then {op: "<=", v: $tok[2:]}
     elif ($tok | startswith(">"))  then {op: ">",  v: $tok[1:]}
     elif ($tok | startswith("<"))  then {op: "<",  v: $tok[1:]}
     elif ($tok | startswith("="))  then {op: "=",  v: $tok[1:]}
     else {op: "=", v: $tok} end)
  | (semver_cmp($version; .v)) as $c
  | if   .op == ">=" then $c >= 0
    elif .op == "<=" then $c <= 0
    elif .op == ">"  then $c >  0
    elif .op == "<"  then $c <  0
    else $c == 0 end;

# Alternatives separated by || are OR'd; comparators within one are AND'd.
# Covers every range this adapter emits (">=X <Y"), the common forms already
# present in real manifests, and GitHub advisory syntax (">= 7.0.0, < 7.29.0").
#
# The space after an operator has to go before tokenizing: the token separator
# is whitespace, so "< 6.28.0" would otherwise split into a bare "<" and a bare
# "6.28.0" and be read as "less than nothing, and exactly 6.28.0", which is both
# wrong and, with an empty version to parse, fatal.
def satisfies($version; $range):
  ($range // "") | tostring
  | gsub("(?<o>[<>=~^]+)[[:space:]]+"; "\(.o)")
  | split("||")
  | map(
      [splits("[[:space:],]+")]
      | map(select(length > 0))
      | map(expand_token) | add
      | map(eval_token($version))
      | all
    )
  | any;
JQLIB
)

# ---------------------------------------------------------------------------
# detect
# ---------------------------------------------------------------------------
detect_raw() {
  if [ -f pnpm-lock.yaml ]; then
    printf 'pnpm\n'
  elif [ -f yarn.lock ]; then
    # Berry (v2+) lockfiles carry a __metadata block. Classic v1 does not, and
    # its format is entirely different: `pkg@^1.0.0:` keys with `version "X"`
    # values rather than `"pkg@npm:range":` keys with `version: X`.
    if grep -q '^__metadata:' yarn.lock 2>/dev/null; then
      printf 'yarn-berry\n'
    else
      printf 'yarn-classic\n'
    fi
  elif [ -f package-lock.json ]; then
    printf 'npm\n'
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then
    printf 'bun\n'
  else
    printf 'none\n'
  fi
}

# How to actually invoke the package manager.
#
# Order matters. A bare binary on PATH comes first: when yarnPath is set it
# re-execs the vendored release anyway, and it matches whatever permission
# rules the user already has. Second, Yarn Berry repos commonly vendor the
# exact release they pin — `yarnPath` in .yarnrc.yml names a checked-in
# bundle that node runs directly, with no corepack indirection and no
# cold-cache download. Corepack is the last resort, not the default: it can
# prompt to download a package manager mid-run.
pm_runner() {
  candidate="$1"
  if command -v "$candidate" >/dev/null 2>&1; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [ "$candidate" = "yarn" ] && [ -f .yarnrc.yml ] \
    && command -v node >/dev/null 2>&1; then
    yarn_path=$(sed -n 's/^yarnPath:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' .yarnrc.yml | head -1)
    if [ -n "$yarn_path" ] && [ -f "$yarn_path" ]; then
      printf 'node %s\n' "$yarn_path"
      return 0
    fi
  fi
  if command -v corepack >/dev/null 2>&1 \
    && jq -e '.packageManager // empty' package.json >/dev/null 2>&1; then
    printf 'corepack %s\n' "$candidate"
  else
    printf '%s\n' "$candidate"
  fi
}

verb_detect() {
  pm=$(detect_raw)
  case "$pm" in
    pnpm)
      run=$(pm_runner pnpm)
      jq -n --arg run "$run" \
             '{pm:"pnpm", pm_exec:$run, lockfile:"pnpm-lock.yaml",
               install_cmd:"\($run) install", why_cmd:"\($run) why",
               override_location:"pnpm.overrides",
               override_syntax:"parent>dep", supports_scoping:true}'
      ;;
    yarn-berry)
      run=$(pm_runner yarn)
      jq -n --arg run "$run" \
             '{pm:"yarn", pm_exec:$run, lockfile:"yarn.lock",
               install_cmd:"\($run) install", why_cmd:"\($run) why",
               override_location:"resolutions",
               override_syntax:"parent/dep", supports_scoping:true}'
      ;;
    npm)
      run=$(pm_runner npm)
      jq -n --arg run "$run" \
             '{pm:"npm", pm_exec:$run, lockfile:"package-lock.json",
               install_cmd:"\($run) install", why_cmd:"\($run) explain",
               override_location:"overrides",
               override_syntax:"nested", supports_scoping:true}'
      ;;
    bun)
      printf '{"error":"bun is not a supported package manager. See .github/CONTRIBUTING.md to request support.","unsupported":"bun"}\n' >&2
      exit 3
      ;;
    yarn-classic)
      printf '{"error":"Yarn Classic (v1) is not supported; only Yarn Berry (v2+). See .github/CONTRIBUTING.md to request support.","unsupported":"yarn-classic"}\n' >&2
      exit 3
      ;;
    *)
      die "No supported lockfile found in $(pwd). Expected pnpm-lock.yaml, yarn.lock, or package-lock.json."
      ;;
  esac
}

pm_of() { verb_detect | jq -r '.pm'; }

# ---------------------------------------------------------------------------
# resolved_versions
#
# Parses the lockfile rather than querying the package manager. The lockfile is
# the artifact the PR commits, and parsing works before any install, which the
# pre-fix merge-risk baseline needs.
#
# `lockfile_entries` exists so callers can distinguish "this package is absent"
# from "the parser is broken". v0.1.0 could not make that distinction: its yarn
# regex could never match, so every yarn repo got a validation claim backed by
# nothing.
# ---------------------------------------------------------------------------
npm_versions() {
  jq --arg pkg "$1" '
    if (.packages | type) != "object" then
      error("package-lock.json has no .packages object (lockfileVersion 1 is unsupported)")
    else
      [ .packages | to_entries[]
        | select(.key | endswith("node_modules/" + $pkg))
        | select(.value.version != null)
        | {version: .value.version, path: .key} ]
    end' package-lock.json
}

npm_entry_count() {
  jq '[.packages // {} | keys[] | select(. != "")] | length' package-lock.json
}

pnpm_versions() {
  awk -v pkg="$1" '
    /^packages:/ { inpkgs = 1; next }
    /^[a-zA-Z]/  { inpkgs = 0 }
    inpkgs {
      line = $0
      sub(/^  /, "", line)
      gsub(/^\x27|\x27$/, "", line)
      prefix = pkg "@"
      if (substr(line, 1, length(prefix)) == prefix) {
        rest = substr(line, length(prefix) + 1)
        p = index(rest, "(")
        if (p > 0) rest = substr(rest, 1, p - 1)
        sub(/:$/, "", rest)
        gsub(/\x27/, "", rest)
        if (rest ~ /^[0-9]/) printf "%s\t%s@%s\n", rest, pkg, rest
      }
    }
  ' pnpm-lock.yaml \
    | jq -Rs 'split("\n") | map(select(length > 0) | split("\t") | {version: .[0], path: .[1]})'
}

pnpm_entry_count() {
  awk '/^packages:/ { inpkgs = 1; next }
       /^[a-zA-Z]/  { inpkgs = 0 }
       inpkgs && /^  [^ ]/ { n++ }
       END { print n + 0 }' pnpm-lock.yaml
}

# Berry keys the canonical resolution on a `resolution:` line, which stays
# stable even when several descriptors share a single block.
yarn_versions() {
  awk -v pkg="$1" '
    {
      i = index($0, "resolution: \"")
      if (i == 0) next
      rest = substr($0, i + 13)
      j = index(rest, "\"")
      if (j == 0) next
      res = substr(rest, 1, j - 1)
      prefix = pkg "@npm:"
      if (substr(res, 1, length(prefix)) == prefix)
        printf "%s\t%s\n", substr(res, length(prefix) + 1), res
    }
  ' yarn.lock \
    | jq -Rs 'split("\n") | map(select(length > 0) | split("\t") | {version: .[0], path: .[1]})'
}

yarn_entry_count() {
  # `grep -c` prints 0 *and* exits 1 when there are no matches, so a `|| echo 0`
  # fallback fires on top of the 0 grep already printed and yields "0\n0".
  count=$(grep -c 'resolution: "' yarn.lock 2>/dev/null) || true
  printf '%s\n' "${count:-0}"
}

verb_resolved_versions() {
  pkg="${1:?resolved_versions requires a package name}"
  pm=$(pm_of)
  case "$pm" in
    npm)  versions=$(npm_versions "$pkg");  entries=$(npm_entry_count)  ;;
    pnpm) versions=$(pnpm_versions "$pkg"); entries=$(pnpm_entry_count) ;;
    yarn) versions=$(yarn_versions "$pkg"); entries=$(yarn_entry_count) ;;
    *)    die "resolved_versions: unsupported pm '$pm'" ;;
  esac

  # A lockfile that yields nothing at all means the parser failed, not that the
  # repo has no dependencies. Never report that as a clean result.
  if [ "$entries" -eq 0 ]; then
    die "Parsed 0 entries from the lockfile for pm '$pm'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result."
  fi

  printf '%s' "$versions" \
    | jq --arg pkg "$pkg" --arg pm "$pm" --argjson entries "$entries" \
        'unique_by(.version + .path)
         | {pm: $pm, package: $pkg, present: (length > 0), count: length,
            versions: ., lockfile_entries: $entries}'
}

# ---------------------------------------------------------------------------
# why — relationship plus the parents a scoped override must target
#
# Parents come from the lockfile, not from parsing `pnpm why` tree output. The
# PM's own text is captured as `raw` so an agent can sanity-check the result.
# ---------------------------------------------------------------------------
npm_parents() {
  jq --arg pkg "$1" '
    [ .packages | to_entries[]
      | select((.value.dependencies // {}) | has($pkg))
      | .key
      | if . == "" then "__root__" else (split("node_modules/") | last) end ]
    | unique' package-lock.json
}

pnpm_parents() {
  awk -v pkg="$1" '
    /^snapshots:/ { insnap = 1; next }
    /^[a-zA-Z]/   { insnap = 0 }
    insnap {
      if ($0 ~ /^  [^ ]/) {
        cur = $0
        sub(/^  /, "", cur)
        sub(/:[[:space:]]*(\{\})?[[:space:]]*$/, "", cur)
        gsub(/\x27/, "", cur)
        p = index(cur, "(")
        if (p > 0) cur = substr(cur, 1, p - 1)
        indeps = 0
        next
      }
      if ($0 ~ /^    dependencies:/) { indeps = 1; next }
      if ($0 ~ /^    [a-zA-Z]/)      { indeps = 0 }
      if (indeps && $0 ~ /^      /) {
        dep = $0
        sub(/^      /, "", dep)
        c = index(dep, ":")
        if (c == 0) next
        name = substr(dep, 1, c - 1)
        gsub(/\x27/, "", name)
        if (name == pkg && cur != "") {
          at = 0
          for (k = length(cur); k > 1; k--) {
            if (substr(cur, k, 1) == "@") { at = k; break }
          }
          if (at > 1) print substr(cur, 1, at - 1); else print cur
        }
      }
    }
  ' pnpm-lock.yaml | sort -u | jq -Rs 'split("\n") | map(select(length > 0))'
}

yarn_parents() {
  awk -v pkg="$1" '
    /^[^[:space:]#]/ { cur = ""; indeps = 0 }
    /resolution: "/ {
      i = index($0, "resolution: \"")
      rest = substr($0, i + 13)
      j = index(rest, "\"")
      res = substr(rest, 1, j - 1)
      # Workspace entries are the repository`s own packages, not registry
      # parents an override can be scoped to. npm filters its root equivalent
      # the same way.
      if (index(res, "@workspace:") > 0) { cur = ""; next }
      at = 0
      for (k = length(res); k > 1; k--) {
        if (substr(res, k, 1) == "@") { at = k; break }
      }
      cur = (at > 1) ? substr(res, 1, at - 1) : res
      next
    }
    /^  dependencies:/ { indeps = 1; next }
    /^  [a-zA-Z]/      { indeps = 0 }
    indeps && /^    / {
      dep = $0
      sub(/^    /, "", dep)
      c = index(dep, ":")
      if (c == 0) next
      name = substr(dep, 1, c - 1)
      gsub(/"/, "", name)
      if (name == pkg && cur != "") print cur
    }
  ' yarn.lock | sort -u | jq -Rs 'split("\n") | map(select(length > 0))'
}

verb_why() {
  pkg="${1:?why requires a package name}"
  pm=$(pm_of)

  direct=$(jq --arg pkg "$pkg" '
    [ (.dependencies // {}), (.devDependencies // {}),
      (.optionalDependencies // {}), (.peerDependencies // {}) ]
    | map(has($pkg)) | any' package.json)

  dev_only=$(jq --arg pkg "$pkg" '
    ((.devDependencies // {}) | has($pkg))
    and (((.dependencies // {}) | has($pkg)) | not)' package.json)

  case "$pm" in
    npm)  parents=$(npm_parents "$pkg")  ;;
    pnpm) parents=$(pnpm_parents "$pkg") ;;
    yarn) parents=$(yarn_parents "$pkg") ;;
    *)    die "why: unsupported pm '$pm'" ;;
  esac

  # Best-effort human-readable chain for the PR body. Never fatal: these exit
  # non-zero in normal situations, such as a package present only as a peer.
  raw=""
  why_cmd=$(verb_detect | jq -r '.why_cmd')
  raw=$($why_cmd "$pkg" 2>&1 || true)

  printf '%s' "$parents" \
    | jq --arg pkg "$pkg" --arg pm "$pm" --arg raw "$raw" \
         --argjson direct "$direct" --argjson dev_only "$dev_only" '
      (map(select(. != "__root__"))) as $pkgparents
      | {
          pm: $pm,
          package: $pkg,
          relationship: (if $direct then "direct" else "transitive" end),
          dev_only: $dev_only,
          parents: $pkgparents,
          parent_count: ($pkgparents | length),
          raw: $raw
        }'
}

# ---------------------------------------------------------------------------
# validate — composes resolved_versions and applies the constraint
#
# Usage: validate [--line <major>] [--vulnerable <range>]... <pkg> <constraint>
#
# Two independent questions, because passing the first is not passing the
# second (issue #19):
#
#   1. Constraint. Does every resolved copy satisfy the range the fix applied?
#      `--line` narrows this to the major line the group targets: a package
#      resolved at 5.x, 6.x and 7.x concurrently can never satisfy one
#      major-bounded range, and each line is a separate group with its own fix.
#   2. Completeness. Does any resolved copy still match a `vulnerable_range`
#      from the group's alerts? Meeting the constraint on the copy you fixed
#      says nothing about the copies you did not, which is how a partial fix
#      used to report success.
#
# A still-vulnerable copy *below* the target line is separated out as
# `requires_major_bump`: no advisory in this group offers a fix within that
# copy's major, so no scoped override bounded to it can help. The remediation is
# a major bump of its parent, or dropping the parent, and that is reported
# rather than attempted.
#
# `--vulnerable` takes advisory range syntax verbatim (">= 7.0.0, < 7.29.0",
# "< 6.28.0"). Ranges are passed rather than whole alert JSON because advisory
# summaries carry apostrophes and an agent has no safe way to quote them.
#
# Two guards keep the completeness check from passing vacuously, because both
# failure modes look exactly like a clean result:
#
#   * `--line` without any `--vulnerable` is refused. A constraint check alone
#     cannot tell a finished fix from a partial one, and prose asking callers to
#     pass the ranges is not a mechanism.
#   * Every `--vulnerable` range is parsed strictly before it is evaluated. Range
#     satisfaction answers false for a token it cannot read, which on this side
#     of the check means "no copy is vulnerable", the unsafe direction. A typo
#     or an advisory form the tokenizer does not know is an error, not a pass.
# ---------------------------------------------------------------------------
verb_validate() {
  line=""
  vuln_ranges=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --line)
        line="${2:?--line requires a major}"
        shift 2
        ;;
      --vulnerable)
        vuln_ranges="$vuln_ranges${2:?--vulnerable requires a range}
"
        shift 2
        ;;
      --) shift; break ;;
      -*) die "validate: unknown option '$1'" ;;
      *)  break ;;
    esac
  done

  pkg="${1:?validate requires a package name}"
  range="${2:?validate requires a range}"

  case "$line" in
    ''|*[!0-9]*)
      [ -z "$line" ] || die "validate: --line must be a major number, got '$line'"
      ;;
  esac

  if [ -n "$line" ] && [ -z "$vuln_ranges" ]; then
    die "validate: --line requires at least one --vulnerable range. Pass every distinct vulnerable_range from the group's alerts; without them the completeness check has nothing to check and would pass a partial fix (issue #19)."
  fi

  vuln_json=$(printf '%s' "$vuln_ranges" \
    | jq -Rs 'split("\n") | map(select(length > 0)) | unique')

  # Strict parse of the advisory ranges, deliberately separate from `satisfies`,
  # which stays false-on-garbage: on the constraint side an unreadable range
  # failing every copy is the safe answer, and here it is the dangerous one.
  # A range is valid when every ||-alternative is non-empty and each of its
  # comparators is a known operator applied to a parseable version.
  bad_range=$(printf '%s' "$vuln_json" | jq -r '
    def token_ok:
      sub("^(>=|<=|>|<|=)"; "") | sub("^[~^]"; "")
      | test("^[v=]*[0-9]+(\\.[0-9]+){0,2}(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$");

    def alternatives:
      gsub("(?<o>[<>=~^]+)[[:space:]]+"; "\(.o)")
      | split("||")
      | map([splits("[[:space:],]+")] | map(select(length > 0)));

    def range_ok:
      alternatives as $alts
      | (($alts | length) > 0)
        and ($alts | all(length > 0))
        and ($alts | all(.[][]; token_ok));

    [ .[] | select(range_ok | not) ] | first // empty')

  if [ -n "$bad_range" ]; then
    die "validate: --vulnerable range '$bad_range' is not a parseable version range. Copy the alert's vulnerable_range verbatim; an unreadable range would silently mark every resolved copy as not vulnerable."
  fi

  resolved=$(verb_resolved_versions "$pkg")
  if [ "$(printf '%s' "$resolved" | jq -r '.present')" != "true" ]; then
    die "validate: '$pkg' resolves to no versions in the lockfile. Nothing to validate."
  fi

  result=$(printf '%s' "$resolved" \
    | jq --arg range "$range" --arg line "$line" --argjson vulnerable "$vuln_json" \
      "$SEMVER_JQ"'
    def major_of: semver_parse | (.core[0] // 0);

    . as $r
    | (if $line == "" then null else ($line | tonumber) end) as $lineno
    | ([ $r.versions[]
         | select($lineno == null or ((.version | major_of) == $lineno)) ]) as $inline
    | ([ $inline[] | select(satisfies(.version; $range) | not) ]) as $bad
    | ([ $r.versions[]
         | . as $v
         | ($vulnerable | map(select(satisfies($v.version; .)))) as $hits
         | select(($hits | length) > 0)
         | {version: $v.version, path: $v.path, vulnerable_ranges: $hits,
            below_line: ($lineno != null and (($v.version | major_of) < $lineno))} ]) as $still
    | ([ $still[] | select(.below_line     ) | del(.below_line) ]) as $bump
    | ([ $still[] | select(.below_line|not) | del(.below_line) ]) as $unresolved
    | {ok: (($bad | length) == 0
            and ($unresolved | length) == 0
            and ($lineno == null or ($inline | length) > 0)),
       package: $r.package, range: $range,
       line: (if $line == "" then null else $line end),
       line_present: ($lineno == null or ($inline | length) > 0),
       checked: ($inline | length),
       resolved_count: $r.count,
       violations: $bad,
       unresolved_alerts: $unresolved,
       requires_major_bump: $bump,
       resolved_versions: ([$r.versions[].version] | unique)}')

  printf '%s\n' "$result"
  printf '%s' "$result" | jq -e '.ok' >/dev/null
}

# ---------------------------------------------------------------------------
# apply_constraint
#
# Default is scoped entries, major-bounded, merged into whatever the manifest
# already has. Pre-existing bare global overrides are reported as observations
# rather than rewritten: they are usually someone reaching for the blunt tool,
# and converting them is a separate concern from fixing today's alert.
#
# --tighten-bare is the escalation an agent reaches for only after scoped
# entries alone fail validation, because a bare override still governs paths
# the scoped entries do not cover.
# ---------------------------------------------------------------------------
set_indent_args() {
  # Keep the diff to the lines actually changed rather than reformatting.
  #
  # An array rather than a string: jq needs two argv entries for `--indent 4`,
  # and passing them as one word relies on the caller leaving the expansion
  # unquoted. bash 3.2 has indexed arrays, and this one is never empty, so the
  # empty-array-under-`set -u` trap does not apply.
  first=$(grep -m1 '^[[:space:]][[:space:]]*"' package.json 2>/dev/null || true)
  case "$first" in
    "	"*)     INDENT_ARGS=(--tab) ;;
    "    "*) INDENT_ARGS=(--indent 4) ;;
    *)       INDENT_ARGS=(--indent 2) ;;
  esac
}

verb_apply_constraint() {
  refuse_primary_checkout
  tighten_bare=false
  if [ "${1:-}" = "--tighten-bare" ]; then
    tighten_bare=true
    shift
  fi
  pkg="${1:?apply_constraint requires a package name}"
  range="${2:?apply_constraint requires a range}"
  shift 2
  parents_json=$(printf '%s\n' "$@" | jq -Rs 'split("\n") | map(select(length > 0))')

  pm=$(pm_of)
  loc=$(verb_detect | jq -r '.override_location')

  # Observations: unscoped global entries in the override block. A lead for the
  # pin audit (issue #7), not a finding: removability needs a real test.
  #
  # "Bare" is per-syntax. pnpm scopes with `>`, so anything without one is
  # bare. yarn scopes with `/`, which collides with scoped package names, so
  # `@scope/name` is bare while `@scope/name/dep` and `parent/dep` are not.
  observations=$(jq --arg pkg "$pkg" --arg loc "$loc" '
    def is_bare($key):
      if $loc == "pnpm.overrides" then (($key | test(">")) | not)
      elif $loc == "resolutions" then
        (($key | split("/")
          | (if ($key | startswith("@")) then .[2:] else .[1:] end)
          | length) == 0)
      else true end;

    (if   $loc == "pnpm.overrides" then (.pnpm.overrides // {})
     elif $loc == "resolutions"    then (.resolutions // {})
     else (.overrides // {}) end) as $block
    | [ $block | to_entries[]
        | select((.value | type) == "string")
        | select(is_bare(.key))
        | {type: "unscoped_override", key: .key, range: .value,
           targets_this_package: (.key == $pkg or (.key | startswith($pkg + "@")))} ]
    ' package.json)

  set_indent_args
  tmp=$(mktemp)

  if ! jq "${INDENT_ARGS[@]}" \
      --arg pkg "$pkg" --arg range "$range" --arg loc "$loc" \
      --argjson parents "$parents_json" --argjson tighten "$tighten_bare" '
      # Create the override container only inside set_entry, so a direct
      # dependency update never leaves an empty "resolutions": {} (or
      # equivalent) behind in a manifest that had no override block.
      def set_entry($key; $val):
        if   $loc == "pnpm.overrides" then
          ((.pnpm //= {}) | (.pnpm.overrides //= {}) | .pnpm.overrides[$key] = $val)
        elif $loc == "resolutions" then
          ((.resolutions //= {}) | .resolutions[$key] = $val)
        else
          ((.overrides //= {}) | .overrides[$key] = $val)
        end;

      if $tighten then
          set_entry($pkg; $range)
        elif ($parents | length) == 0 then
          # Direct dependency: match how the manifest already expresses
          # versions. A repo that pins exactly (yarn `defaultSemverRangePrefix:
          # ""`, or Dependabot-managed pins) should not acquire a lone range
          # entry, and a caret repo should stay caret. The major bound still
          # holds either way: an exact pin cannot cross a major, and `^` is
          # already major-bounded.
          ($range | sub("^>=[[:space:]]*"; "") | split(" ")[0]) as $lower
          | (if   ((.dependencies // {})    | has($pkg)) then .dependencies[$pkg]
             elif ((.devDependencies // {}) | has($pkg)) then .devDependencies[$pkg]
             else null end) as $existing
          | (if   $existing == null              then $range
             elif ($existing | test("^[0-9]"))   then $lower
             elif ($existing | startswith("^"))  then "^" + $lower
             elif ($existing | startswith("~"))  then "~" + $lower
             else $range end) as $value
          | if   ((.dependencies // {})    | has($pkg)) then .dependencies[$pkg]    = $value
            elif ((.devDependencies // {}) | has($pkg)) then .devDependencies[$pkg] = $value
            else set_entry($pkg; $range) end
        else
          reduce $parents[] as $parent (.;
            if   $loc == "pnpm.overrides" then set_entry($parent + ">" + $pkg; $range)
            elif $loc == "resolutions"    then set_entry($parent + "/" + $pkg; $range)
            else ((.overrides //= {})
                  | .overrides[$parent] =
                      (((.overrides[$parent] // {})
                        | if type == "string" then {} else . end) + {($pkg): $range}))
            end)
        end' package.json > "$tmp"; then
    rm -f "$tmp"
    die "apply_constraint: failed to rewrite package.json"
  fi

  mv "$tmp" package.json

  printf '%s' "$observations" \
    | jq --arg pkg "$pkg" --arg range "$range" --arg loc "$loc" --arg pm "$pm" \
         --argjson parents "$parents_json" --argjson tighten "$tighten_bare" '
      {
        pm: $pm,
        package: $pkg,
        range: $range,
        override_location: $loc,
        mode: (if $tighten then "tighten-bare"
               elif ($parents | length) == 0 then "direct"
               else "scoped" end),
        parents: $parents,
        observations: .
      }'
}

# ---------------------------------------------------------------------------
# install / verification_commands / compare_versions / list_pins
# ---------------------------------------------------------------------------
# Mutating verbs run only inside a linked git worktree. A mutating verb that
# runs anywhere else (a cwd mistake before worktree setup) silently edits the
# user's tree, observed live in Phase 2 testing. The classification lives in
# common/require-linked-worktree.sh, which run-check.sh also invokes, so the
# two guards cannot drift; it already emits the adapter's JSON error shape on
# stderr, so this only has to relay the exit status.
refuse_primary_checkout() {
  "$SCRIPT_DIR/../common/require-linked-worktree.sh" "refusing to run '$VERB' here" || exit 1
}

verb_install() {
  refuse_primary_checkout
  cmd=$(verb_detect | jq -r '.install_cmd')
  printf 'Running: %s\n' "$cmd" >&2
  $cmd
}

verb_verification_commands() {
  pm=$(verb_detect | jq -r '.pm_exec')
  # Emits *candidates*, not a running order. Name-based filtering catches the
  # obvious servers but cannot recognize every one (`start-verdaccio` is a
  # registry, `nx-migrate` is a codemod), so the caller reviews the list and
  # skips what is not a check. Matching the last colon-separated segment as
  # well as the whole name keeps `storybook:build` while dropping `test:watch`
  # and `storybook:dev`.
  jq --arg pm "$pm" '
    ["dev","start","serve","watch","storybook","preview"] as $long
    | def is_long: . as $s
        | ($long | index($s)) != null
          or ($long | index($s | split(":") | last)) != null;
      ((.scripts // {}) | keys) as $all
    | {
        commands: [ $all[] | select(is_long | not) | "\($pm) \(.)" ],
        skipped:  [ $all[] | select(is_long) ]
      }' package.json
}

verb_compare_versions() {
  a="${1:?compare_versions requires two versions}"
  b="${2:?compare_versions requires two versions}"
  jq -n --arg a "$a" --arg b "$b" "$SEMVER_JQ"'
    {a: $a, b: $b, result: semver_cmp($a; $b), delta: semver_delta($a; $b)}'
}

# Some repo scripts invoke the bare package-manager name internally, which
# fails when the toolchain is corepack-managed or vendored and no binary sits
# on PATH. This writes a one-line shim that delegates to the resolved runner,
# so callers prepend the directory to PATH instead of hand-rolling
# mkdir/printf/chmod (three separate commands, each drawing its own
# permission review). The optional runner override is a test seam
# (precedent: detect-capacity.sh's meminfo path).
verb_shim() {
  dir="${1:?shim requires a target directory}"
  runner="${2:-}"
  case "$(detect_raw)" in
    pnpm)       pm="pnpm" ;;
    yarn-berry) pm="yarn" ;;
    npm)        pm="npm" ;;
    *) die "shim supports pnpm, Yarn Berry, and npm; detected: $(detect_raw)" ;;
  esac
  if [ -z "$runner" ]; then
    runner=$(pm_runner "$pm")
    if [ "$runner" = "$pm" ] && command -v "$pm" >/dev/null 2>&1; then
      jq -n --arg pm "$pm" \
        '{created: false, pm: $pm, reason: "\($pm) is already on PATH"}'
      return 0
    fi
  fi
  # A vendored runner is emitted relative to the repository root; the shim
  # runs from arbitrary directories, so absolutize it.
  case "$runner" in
    "node .yarn/"*) runner="node $PWD/${runner#node }" ;;
  esac
  mkdir -p "$dir" || die "cannot create shim directory: $dir"
  shim_file="$dir/$pm"
  printf '#!/bin/sh\nexec %s "$@"\n' "$runner" > "$shim_file" \
    || die "cannot write shim: $shim_file"
  chmod +x "$shim_file"
  jq -n --arg pm "$pm" --arg shim "$shim_file" --arg dir "$dir" \
    --arg runner "$runner" \
    '{created: true, pm: $pm, shim: $shim, path_prefix: $dir, runner: $runner}'
}

case "$VERB" in
  detect)                verb_detect ;;
  why)                   verb_why "$@" ;;
  resolved_versions)     verb_resolved_versions "$@" ;;
  apply_constraint)      verb_apply_constraint "$@" ;;
  install)               verb_install ;;
  validate)              verb_validate "$@" ;;
  verification_commands) verb_verification_commands ;;
  compare_versions)      verb_compare_versions "$@" ;;
  shim)                  verb_shim "$@" ;;
  list_pins)
    printf '{"error":"list_pins is not implemented until RFC 001 Phase 4 (issue #7)."}\n' >&2
    exit 2
    ;;
  *) die "Unknown verb '$VERB'" ;;
esac
