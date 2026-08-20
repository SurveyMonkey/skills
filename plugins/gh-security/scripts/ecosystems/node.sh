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
#   resolution_map                             -> {pm, lockfile_entries, package_count,
#                                                  resolutions{}}
#   apply_constraint <pkg> <range> [parent...] -> {changes, observations[]}
#   install                                    -> pass-through, exit code is the signal
#   validate [--line <major>] [--vulnerable <range>]... <pkg> <range>
#                                              -> {ok, line_present, checked,
#                                                  violations[],
#                                                  unresolved_alerts[],
#                                                  requires_major_bump[]}
#                                                 (--line requires --vulnerable)
#   verification_commands                      -> {commands[], skipped[]}
#   compare_versions <a> <b>                   -> {result, delta, major_distance}
#   range_facts <range> <version>              -> {parseable, satisfied, pinned,
#                                                  floor_major, majors_ahead}
#                                                 (all null when not parseable)
#   declared_ranges <pkg>                      -> {ranges[], root_range,
#                                                  parents_read[],
#                                                  parents_without_range[],
#                                                  parents_unreadable[],
#                                                  parents_malformed[]}
#   shim <dir> [runner]                        -> {created, pm, shim?, path_prefix?}
#   list_pins                                  -> {pm, override_location, block_present,
#                                                  count, bare_count, pins[]}
#
# Exit codes: 0 ok | 1 error | 2 not implemented | 3 unsupported toolchain
#
# Run from the root of the tree being operated on, which for the mutating verbs
# (apply_constraint, install, shim) must be a linked git worktree: they refuse
# to run in a primary checkout, so "the repository root" is the worktree's root,
# not the user's. Targets bash 3.2; depends only on bash, jq, gh.

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

def major_distance($a; $b):
  (($a | semver_parse).core[0] // 0) as $ma
  | (($b | semver_parse).core[0] // 0) as $mb
  | if $ma > $mb then $ma - $mb else $mb - $ma end;

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

# Wildcards, as comparator pairs. `*` (or a bare `x`) admits every version, so
# it expands to a floor nothing can fall below, prerelease included. An x-range
# bounds a line exactly the way the caret and tilde forms do: `1.x` is `^1`,
# `1.2.x` is `~1.2`. Anything else returns null, which is how the callers below
# tell a wildcard from an ordinary comparator.
def wildcard_expand:
  . as $t
  | ($t | sub("^[v=]+"; "") | split(".")) as $p
  | if   ($t | test("^[*xX]$")) then [">=0.0.0-0"]
    elif ($p | length) == 2 and ($p[0] | test("^[0-9]+$")) and ($p[1] | test("^[xX*]$"))
      then [">=\($p[0]).0.0", "<\(($p[0] | tonumber) + 1).0.0"]
    elif ($p | length) == 3 and ($p[0] | test("^[0-9]+$")) and ($p[1] | test("^[0-9]+$"))
         and ($p[2] | test("^[xX*]$"))
      then [">=\($p[0]).\($p[1]).0", "<\($p[0]).\(($p[1] | tonumber) + 1).0"]
    else null end;

def expand_token:
  . as $t
  | ($t | wildcard_expand) as $w
  | if   $w != null            then $w
    elif ($t | startswith("^")) then [(">=" + $t[1:]), ("<" + ($t[1:] | caret_upper))]
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

# Range shape, for the merge-risk scorer (issue #21). A dependent declaring
# `^9` has been tested against the 9.x line and nothing above it, so how far
# past that floor a fix lands is a risk signal the before/after delta cannot
# express. Alternatives are flattened here rather than evaluated separately:
# the floor of a union is the lowest floor in it, and a range carrying a pin
# in any alternative is reported as pinned. Whether the version is actually
# admitted is answered by `satisfies`, which does respect alternatives.
def range_tokens:
  (. // "") | tostring
  | gsub("(?<o>[<>=~^]+)[[:space:]]+"; "\(.o)")
  | [splits("[[:space:],|]+")]
  | map(select(length > 0));

# A tilde, an exact version, an x-range bounded to one minor line, or an
# explicit upper bound. A caret is not a pin: it admits the whole major line,
# which is the ordinary declaration, and `1.x` says the same thing.
def range_pinned:
  range_tokens
  | map(select(startswith("~") or startswith("<")
               or test("^=?[0-9]+\\.[0-9]+\\.[0-9]+")
               or test("^=?[0-9]+\\.[0-9]+\\.[xX*]$")))
  | length > 0;

# Can this range be read at all?
#
# `satisfies` answers false for a token it cannot parse, so a specifier like
# `workspace:^`, `latest`, or a git URL would otherwise come back as a
# confident "this version is not admitted" and be reported as a dependent left
# behind. Unreadable is a third answer, and the callers below return it rather
# than guessing (review follow-up on issue #21).
#
# Deliberately separate from validate's `--vulnerable` parse check, which is
# stricter on purpose: an advisory range is copied verbatim from the API and a
# wildcard there means the tokenizer misread it, while a manifest legitimately
# declares `*`.
def range_alternatives:
  (. // "") | tostring
  | gsub("(?<o>[<>=~^]+)[[:space:]]+"; "\(.o)")
  | split("||")
  | map([splits("[[:space:],]+")] | map(select(length > 0)));

def token_parseable:
  if (wildcard_expand) != null then true
  else
    sub("^(>=|<=|>|<|=)"; "") | sub("^[~^]"; "")
    | test("^[v=]*[0-9]+(\\.[0-9]+){0,2}(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$")
  end;

def range_parseable:
  range_alternatives as $alts
  | (($alts | length) > 0)
    and ($alts | all(length > 0))
    and ($alts | all(.[][]; token_parseable));

# The major of the lowest version the range admits. Upper-bound comparators
# are excluded: `<10` says nothing about where the range starts.
def range_floor_major:
  range_tokens
  | map(select(startswith("<") | not))
  | map(sub("^[><=~^v]+"; ""))
  | map(select(test("^[0-9]")))
  | map(semver_parse | .core[0] // 0)
  | if length == 0 then null else min end;
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
#
# A package is identified by the name it actually resolves to, never by where it
# sits: npm keys an `npm:` alias by the alias (`node_modules/lodash-alias`) and
# records the real name in `.value.name`, and Berry wraps a patched package in a
# `patch:` locator whose inner descriptor names the registry version. Both are
# the same package as far as "what version of X is in the tree" is concerned,
# and both were previously invisible to this verb
# ([#44](https://github.com/SurveyMonkey/skills/issues/44)).
# ---------------------------------------------------------------------------

# npm's own name for an entry, falling back to the path segment. `.value.name`
# is present exactly when the two differ (an `npm:` alias), so this leaves every
# ordinary entry, nested or hoisted, keyed as before.
NPM_ENTRY_NAME='(.value.name // (.key | split("node_modules/") | last))'

npm_versions() {
  jq --arg pkg "$1" '
    if (.packages | type) != "object" then
      error("package-lock.json has no .packages object (lockfileVersion 1 is unsupported)")
    else
      [ .packages | to_entries[]
        | select(.key | contains("node_modules/"))
        | select(.value.version != null)
        | select('"$NPM_ENTRY_NAME"' == $pkg)
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
# stable even when several descriptors share a single block. Every consumer
# reads the lockfile through this one parser, emitting
# `name<TAB>version<TAB>resolution` for each entry that resolves to a registry
# version: `resolved_versions` filters it by name, `resolution_map` groups it.
#
# The name is the locator's leading `pkg@` segment rather than a `@npm:` prefix
# match, because a `patch:` locator does not contain a literal `@npm:` — Berry
# percent-encodes the colon of the descriptor it wraps
# (`lodash@patch:lodash@npm%3A4.17.21#...`). Requiring the literal dropped every
# patched package from both verbs at a real registry version, which is the
# population `yarn patch` exists for
# ([#44](https://github.com/SurveyMonkey/skills/issues/44)).
yarn_resolution_rows() {
  awk '
    # The name a locator resolves under: everything before its first "@", from
    # position 2 so a scoped name keeps its own leading "@".
    function locator_name(res,   n) {
      for (n = 2; n <= length(res); n++)
        if (substr(res, n, 1) == "@") return substr(res, 1, n - 1)
      return ""
    }
    # The registry version a locator ultimately points at, or "" when it points
    # at none: workspace:, portal: and exec: entries are local code whose
    # package.json version is not a published release, and git and URL targets
    # name no version at all. patch: is the exception — it wraps another
    # locator, so decode the wrapped one and ask it the same question. That
    # keeps a patched registry package in (it is that release, plus a diff) and
    # a patched workspace or portal package out, on the same rule.
    function registry_version(res,   d, i, n, hash) {
      gsub(/%3[Aa]/, ":", res)
      while (1) {
        i = 0
        for (n = 2; n <= length(res); n++)
          if (substr(res, n, 1) == "@") { i = n; break }
        if (i == 0) return ""
        d = substr(res, i + 1)
        if (substr(d, 1, 4) == "npm:") return substr(d, 5)
        if (substr(d, 1, 6) != "patch:") return ""
        res = substr(d, 7)
        # Everything from the first "#" is the patch file and its metadata.
        hash = index(res, "#")
        if (hash > 0) res = substr(res, 1, hash - 1)
      }
    }
    {
      i = index($0, "resolution: \"")
      if (i == 0) next
      rest = substr($0, i + 13)
      j = index(rest, "\"")
      if (j == 0) next
      res  = substr(rest, 1, j - 1)
      name = locator_name(res)
      ver  = registry_version(res)
      if (name != "" && ver ~ /^[0-9]/) printf "%s\t%s\t%s\n", name, ver, res
    }
  ' yarn.lock
}

yarn_versions() {
  yarn_resolution_rows \
    | jq -Rs --arg pkg "$1" \
        'split("\n") | map(select(length > 0) | split("\t"))
         | map(select(.[0] == $pkg) | {version: .[1], path: .[2]})'
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
# resolution_map — every package in the lockfile, not one named package
#
# The pin audit's reason for existing: removing an override can change dedup,
# hoisting, or how a peer conflict resolves, so a removal can move a package
# the pin never named. `resolved_versions <pkg>` cannot see that, and a
# `removable` verdict computed from it alone is right about its own package and
# silent about the tree ([#42](https://github.com/SurveyMonkey/skills/issues/42)).
# Diffing this map before and after a removal names what else moved.
#
# Deliberately a separate verb, not a widening of `resolved_versions`: that one
# has callers (`validate`, the merge-risk baseline) whose behavior must not
# shift, and its per-path detail is not what a whole-tree diff wants.
#
# `versions` are unique and lexically sorted, which makes two maps comparable
# with a plain jq `==`. They are NOT semver-ordered; rank with
# `compare_versions` if order matters.
#
# An entry is keyed by the package it resolves to, and only entries that resolve
# to a registry version are kept, on exactly the rule `resolved_versions` uses —
# the two verbs must agree about any package, because the audit reads a
# disagreement as a parser bug and refuses the pin. So:
#
# - Workspace links, portal and exec targets, git targets and URL targets are
#   excluded: "what version of X is in the tree" has no registry answer for
#   local or generated code.
# - A **patched** package is included at the version it patches. `yarn patch`
#   applies a diff to a real published release, and it is used above all for
#   one-off security fixes, so dropping those entries blinded the audit to the
#   very packages it exists to watch
#   ([#44](https://github.com/SurveyMonkey/skills/issues/44)).
# - An npm `npm:` **alias** is included under the package it aliases, not the
#   key it is installed as. The resolved code genuinely is that package, and the
#   audit feeds this name straight into an advisory query, where the alias key
#   returns `no-advisories` — indistinguishable from a package with a clean
#   record.
# ---------------------------------------------------------------------------
npm_resolution_pairs() {
  jq '
    if (.packages | type) != "object" then
      error("package-lock.json has no .packages object (lockfileVersion 1 is unsupported)")
    else
      [ .packages | to_entries[]
        | select(.key | contains("node_modules/"))
        | select(.value.version != null)
        | {package: '"$NPM_ENTRY_NAME"',
           version: (.value.version | tostring)}
        | select(.version | test("^[0-9]")) ]
    end' package-lock.json
}

pnpm_resolution_pairs() {
  awk '
    /^packages:/ { inpkgs = 1; next }
    /^[a-zA-Z]/  { inpkgs = 0 }
    inpkgs && /^  [^ ]/ {
      line = $0
      sub(/^  /, "", line)
      p = index(line, "(")
      if (p > 0) line = substr(line, 1, p - 1)
      sub(/:$/, "", line)
      gsub(/\x27/, "", line)
      # Split on the LAST "@": a scoped name carries one of its own.
      at = 0
      for (i = length(line); i > 1; i--) {
        if (substr(line, i, 1) == "@") { at = i; break }
      }
      if (at == 0) next
      name = substr(line, 1, at - 1)
      ver  = substr(line, at + 1)
      if (ver ~ /^[0-9]/) printf "%s\t%s\n", name, ver
    }
  ' pnpm-lock.yaml \
    | jq -Rs 'split("\n") | map(select(length > 0) | split("\t")
                                | {package: .[0], version: .[1]})'
}

yarn_resolution_pairs() {
  yarn_resolution_rows \
    | jq -Rs 'split("\n") | map(select(length > 0) | split("\t")
                                | {package: .[0], version: .[1]})'
}

verb_resolution_map() {
  pm=$(pm_of)
  case "$pm" in
    npm)  pairs=$(npm_resolution_pairs);  entries=$(npm_entry_count)  ;;
    pnpm) pairs=$(pnpm_resolution_pairs); entries=$(pnpm_entry_count) ;;
    yarn) pairs=$(yarn_resolution_pairs); entries=$(yarn_entry_count) ;;
    *)    die "resolution_map: unsupported pm '$pm'" ;;
  esac

  # Same rule as resolved_versions: zero parsed entries is a broken parser,
  # never a clean tree. A whole-tree diff against an empty map would report
  # every package as unchanged, which is the wrong-safe answer.
  if [ "$entries" -eq 0 ]; then
    die "Parsed 0 entries from the lockfile for pm '$pm'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result."
  fi

  printf '%s' "$pairs" \
    | jq --arg pm "$pm" --argjson entries "$entries" \
        '(reduce .[] as $p ({}; .[$p.package] += [$p.version]) | map_values(unique)) as $res
         | {pm: $pm, lockfile_entries: $entries,
            package_count: ($res | length), resolutions: $res}'
}

# ---------------------------------------------------------------------------
# why — relationship plus the parents a scoped override must target
#
# Parents come from the lockfile, not from parsing `pnpm why` tree output. The
# PM's own text is captured as `raw` so an agent can sanity-check the result.
# ---------------------------------------------------------------------------
# A lockfile v3 `packages` entry records each dependency block under its own
# key, so matching `.dependencies` alone misses a parent that declares the
# package only optionally or as a peer. Both still resolve it: the optional one
# installs it whenever the platform allows, and the peer one is why the copy is
# in the tree at all. Missing them meant `declared_ranges` never read those
# manifests (so their ranges vanished from F7) and a scoped override skipped the
# very parent that pulled the vulnerable copy in.
#
# `devDependencies` is deliberately not among them: npm records it only for the
# root entry and for linked workspaces, and the root is filtered out below.
npm_parents() {
  jq --arg pkg "$1" '
    [ .packages | to_entries[]
      | select([ (.value.dependencies // {}),
                 (.value.optionalDependencies // {}),
                 (.value.peerDependencies // {}) ]
               | map(has($pkg)) | any)
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
# Every verb that writes runs only inside a linked git worktree, and the set is
# exactly `apply_constraint` (rewrites package.json), `install` (rewrites the
# lockfile and node_modules) and `shim` (creates a directory and an executable,
# and absolutizes a vendored runner from the cwd). Each calls the guard as its
# first statement; a verb that starts writing must be added here and to the list
# in scripts/CLAUDE.md. A mutating verb that runs anywhere else (a cwd mistake
# before worktree setup) silently edits the user's tree, observed live in Phase
# 2 testing. The classification lives in
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
    {a: $a, b: $b, result: semver_cmp($a; $b), delta: semver_delta($a; $b),
     major_distance: major_distance($a; $b)}'
}

# range_facts — what a dependent's declared range says about this version
#
# The scorer needs to know how far outside a declared range a fix lands, and
# whether the range it crossed was a pin. Both are semver questions, so they
# live behind a verb like every other version comparison (ADR 001).
#
# `parseable` is the first field to read. A manifest may declare `workspace:^`,
# `latest`, or a git URL, none of which is a version range; reporting those as
# `satisfied: false` told the scorer a dependent had been left behind by the
# fix, which is a fabricated fact. When `parseable` is false every other answer
# is null, because there is nothing to answer from. Every key is always
# present: a caller that has to distinguish "no floor" from "field missing"
# cannot do it if the field can also be absent.
#
# Known divergence: prereleases. npm's semver admits a prerelease version into a
# range only when some comparator in the same conjunction carries a prerelease
# on the identical [major, minor, patch] tuple, so `1.x` does not admit
# `2.0.0-alpha` for npm while this evaluator reports `satisfied: true` (it
# compares `2.0.0-alpha` as sorting below `2.0.0` and inside `>=1.0.0 <2.0.0`).
# The divergence is deliberate rather than pending: the exclusion rule lives in
# the shared `satisfies`, which `validate` also uses against advisory ranges,
# where applying it would stop a prerelease copy matching `< 2.0.0` and report a
# vulnerable copy as clean. That is the unsafe direction, and the completeness
# check (issue #19) exists precisely to prevent it. The scoring side reaches
# this only when a `first_patched_version` is itself a prerelease, where the
# effect is at most an understated F7, never a missed vulnerable copy.
verb_range_facts() {
  range="${1:?range_facts requires a range and a version}"
  version="${2:?range_facts requires a range and a version}"
  jq -n --arg range "$range" --arg version "$version" "$SEMVER_JQ"'
    ($range | range_parseable) as $ok
    | ($range | range_floor_major) as $floor
    | (($version | semver_parse).core[0] // 0) as $major
    | {
        range: $range,
        version: $version,
        parseable: $ok,
        satisfied: (if $ok then satisfies($version; $range) else null end),
        pinned: (if $ok then ($range | range_pinned) else null end),
        floor_major: (if $ok then $floor else null end),
        majors_ahead: (if $ok | not then null
                       elif $floor == null then null
                       elif $major > $floor then $major - $floor
                       else 0 end)
      }'
}

# declared_ranges — the ranges this package's dependents declare for it
#
# The scorer's F7 needs these, and collecting them used to be a shell loop in
# the agent definition: a `for` over a command substitution, which the
# preflight catalog cannot pre-approve (so it prompted on every run), which
# discarded every per-parent error (so a partial read was indistinguishable
# from a complete one), and which missed optionalDependencies. It is a single
# flat command here instead, and the partial read is reported rather than
# hidden (review follow-up on issue #21).
#
# Parents come from the lockfile, the ranges from each parent's installed
# manifest, across `dependencies`, `optionalDependencies` and
# `peerDependencies`. The root manifest is read with `devDependencies` on top of
# those three, deliberately: the repository is a dependent like any other, and a
# dev-only direct dependency still declares a range this fix can leave behind.
#
# A parent whose manifest is not on disk is not an error: Yarn PnP installs no
# node_modules at all, and pnpm only links direct dependencies there. Those
# parents are listed in `parents_unreadable` so the caller can say in the PR
# body which ranges nobody could read; a parent whose manifest is on disk but
# will not parse joins them, and is additionally named in `parents_malformed`.
verb_declared_ranges() {
  pkg="${1:?declared_ranges requires a package name}"
  pm=$(pm_of)
  case "$pm" in
    npm)  parents=$(npm_parents "$pkg")  ;;
    pnpm) parents=$(pnpm_parents "$pkg") ;;
    yarn) parents=$(yarn_parents "$pkg") ;;
    *)    die "declared_ranges: unsupported pm '$pm'" ;;
  esac

  # A direct dependency's own declaration in the root manifest counts: the
  # repository is a dependent like any other.
  root_range=$(jq -r --arg pkg "$pkg" '
    [ (.dependencies // {}), (.optionalDependencies // {}),
      (.peerDependencies // {}), (.devDependencies // {}) ]
    | map(.[$pkg]?) | map(select(type == "string")) | first // empty' package.json)

  ranges=""
  read_parents=""
  no_range=""
  unreadable=""
  malformed=""
  while IFS= read -r parent; do
    [ -n "$parent" ] || continue
    [ "$parent" != "__root__" ] || continue
    manifest="node_modules/$parent/package.json"
    if [ ! -f "$manifest" ]; then
      unreadable="$unreadable$parent
"
      continue
    fi
    # `|| true` on the read swallowed jq's exit status, so a parent whose
    # manifest is on disk but not valid JSON landed in parents_read with its
    # range silently dropped: indistinguishable from a parent that declares no
    # range, which is why the PR body's partial-view disclosure never fired for
    # it (review follow-up on issue #21). A manifest that will not parse is a
    # range nobody could read, so the parent joins `parents_unreadable` and
    # every existing consumer of that list stays correct; `parents_malformed`
    # is the subset naming the ones that are corrupt rather than simply not
    # installed, because those two want different remediations.
    if found=$(jq -r --arg pkg "$pkg" '
        [ (.dependencies // {}), (.optionalDependencies // {}),
          (.peerDependencies // {}) ]
        | map(.[$pkg]?) | map(select(type == "string")) | .[]' "$manifest" 2>/dev/null); then
      read_parents="$read_parents$parent
"
      if [ -z "$found" ]; then
        # Legitimate under version skew: the lockfile records a parent that
        # declared the package in a release the installed manifest does not.
        # Named rather than counted, so "read and declared nothing" is not
        # mistaken for "not read".
        no_range="$no_range$parent
"
      else
        ranges="$ranges$found
"
      fi
    else
      unreadable="$unreadable$parent
"
      malformed="$malformed$parent
"
    fi
  done <<EOF
$(printf '%s' "$parents" | jq -r '.[]')
EOF

  [ -z "$root_range" ] || ranges="$ranges$root_range
"

  printf '%s' "$ranges" | jq -Rs \
    --arg pkg "$pkg" --arg pm "$pm" --arg root "$root_range" \
    --argjson read_parents "$(printf '%s' "$read_parents" | jq -Rs 'split("\n") | map(select(length > 0))')" \
    --argjson no_range "$(printf '%s' "$no_range" | jq -Rs 'split("\n") | map(select(length > 0))')" \
    --argjson unreadable "$(printf '%s' "$unreadable" | jq -Rs 'split("\n") | map(select(length > 0))')" \
    --argjson malformed "$(printf '%s' "$malformed" | jq -Rs 'split("\n") | map(select(length > 0))')" '
    {
      pm: $pm,
      package: $pkg,
      ranges: (split("\n") | map(select(length > 0)) | unique),
      root_range: (if $root == "" then null else $root end),
      parents_read: $read_parents,
      parents_without_range: $no_range,
      parents_unreadable: $unreadable,
      parents_malformed: $malformed
    }'
}

# ---------------------------------------------------------------------------
# list_pins — every override/resolution entry, parsed
#
# The pin audit's first step (RFC 001 Phase 4). Read-only: it parses the
# manifest and states what is declared there, and every judgment about whether
# an entry is still needed belongs to the audit agent, which tests removal in a
# scratch worktree against `check-advisories.sh`.
#
# Three key syntaxes, one shape out. Each is ambiguous in its own way and each
# ambiguity has been the source of a wrong reading:
#
#   * pnpm scopes with `>` (`jsdom>form-data`) and allows a version selector on
#     either side (`handlebars@4`). A scoped package name starts with an `@`
#     that is not a selector, so the selector is split off the *last* `@`.
#   * yarn scopes with `/`, which is also the separator inside a scoped package
#     name: `@babel/core` is a bare entry, `@vercel/fun/undici` is a scoped one.
#     The first segment is one path component, or two when the key starts `@`.
#   * npm nests objects (`{parent: {dep: range}}`) to arbitrary depth, and a
#     `"."` key inside one names the parent itself rather than a dependency.
#
# Values are classified rather than assumed to be ranges. A resolution may
# redirect to a different package entirely (`"@next/env":
# "npm:@varlock/nextjs-integration@1.1.6"`), point at a patch or a local path,
# or reference another declared dependency (`"$lodash"`). Reading any of those
# as a version range is how an audit would reason about the "range" of a pin
# that was never about a version at all.
# ---------------------------------------------------------------------------
PINS_JQ=$(cat <<'JQLIB'
def strip_selector:
  . as $k
  | ($k | rindex("@")) as $i
  | if $i == null or $i == 0 then {name: $k, selector: null}
    else {name: ($k[0:$i]), selector: ($k[$i+1:])} end;

def pnpm_key:
  . as $k
  | ($k | rindex(">")) as $i
  | if $i == null then {parents: [], target: $k}
    else {parents: ($k[0:$i] | split(">")), target: ($k[$i+1:])} end;

def yarn_key:
  . as $k
  | ($k | split("/")) as $seg
  | (if ($k | startswith("@")) then 2 else 1 end) as $head
  | if ($seg | length) <= $head then {parents: [], target: $k}
    else {parents: [($seg[0:$head] | join("/"))],
          target: ($seg[$head:] | join("/"))} end;

def value_facts:
  . as $v
  | if ($v | type) != "string" then
      {kind: "unparseable", range: null, alias_package: null, alias_range: null}
    elif ($v | startswith("$")) then
      {kind: "reference", range: null, alias_package: null, alias_range: null}
    elif ($v | startswith("npm:")) then
      # An `npm:` value names a package, optionally with a version after the
      # last `@`. The version is optional and its absence is not a reason to
      # read what remains as a range: `npm:esbuild-wasm` and
      # `npm:@babel/core` are both redirects to a different package, and
      # reporting either as `{kind: "range", range: "<package name>"}` is the
      # exact misreading this classification exists to prevent — the audit
      # would then test, and could report as removable, an entry that decides
      # which package ships.
      #
      # `npm:4.17.21` (the protocol carrying only a version, same package) is
      # reported as an alias too, because a package name and a bare version are
      # not distinguishable here: npm allows purely numeric names. That
      # direction is the safe one — the audit reports such an entry as
      # `not-a-version-pin` and leaves it alone, rather than testing the wrong
      # thing.
      ($v[4:]) as $rest
      | ($rest | rindex("@")) as $i
      | if $i == null or $i == 0 then
          {kind: "alias", range: null, alias_package: $rest, alias_range: null}
        else
          {kind: "alias", range: null,
           alias_package: ($rest[0:$i]), alias_range: ($rest[$i+1:])}
        end
    elif ($v | test("^[a-zA-Z][a-zA-Z0-9+.-]*:")) then
      {kind: "protocol", range: null, alias_package: null, alias_range: null}
    elif ($v | range_parseable) then
      {kind: "range", range: $v, alias_package: null, alias_range: null}
    else
      {kind: "unparseable", range: null, alias_package: null, alias_range: null}
    end;

def pin($key; $path; $parents; $target; $value):
  ($target | strip_selector) as $t
  | ($value | value_facts) as $f
  | {
      key: $key,
      path: $path,
      package: $t.name,
      selector: $t.selector,
      parents: $parents,
      scope: (if ($parents | length) == 0 then "bare" else "scoped" end),
      value: $value,
      kind: $f.kind,
      range: $f.range,
      alias_package: $f.alias_package,
      alias_range: $f.alias_range
    };

# The override block itself, or null when the manifest has none.
#
# `try/catch` is not defensive decoration: `.pnpm.overrides` raises when
# `.pnpm` is a string rather than an object, which aborts the whole program.
# The sentinel makes that manifest reachable by the type check below instead,
# where it is reported rather than crashing.
def override_block($loc):
  if   $loc == "pnpm.overrides" then (try (.pnpm.overrides // null) catch "__invalid__")
  elif $loc == "resolutions"    then (try (.resolutions    // null) catch "__invalid__")
  else                               (try (.overrides      // null) catch "__invalid__") end;

# npm nests, so the entries are the leaves of the override block and their key
# path is the parent chain.
def npm_walk($obj; $path):
  [ $obj | to_entries[]
    | .key as $k | .value as $v
    | if ($v | type) == "object" then npm_walk($v; $path + [$k])[]
      else {path: ($path + [$k]), value: $v} end ];
JQLIB
)

verb_list_pins() {
  loc=$(verb_detect | jq -r '.override_location')
  pm=$(pm_of)

  # Three states, not two. An override block that is present but is not an
  # object (a string, an array, a number) is a broken manifest, and coercing it
  # to `{}` emitted `count: 0` — byte-identical to a manifest that genuinely
  # pins nothing, which the audit reads as "this repository pins nothing, stop".
  # A corrupted manifest auditing clean is the v0.1.0 failure class exactly
  # (scripts/CLAUDE.md), so it fails loudly here instead.
  block_type=$(jq -r --arg loc "$loc" "$SEMVER_JQ$PINS_JQ"'
    override_block($loc)
    | if . == "__invalid__" then "unreadable" else type end' package.json) \
    || die "list_pins: cannot read package.json"
  case "$block_type" in
    object|null) ;;
    unreadable)
      die "list_pins: the container holding '$loc' in package.json is not an object, so the override block cannot be read. Refusing to report a manifest this script cannot read as a repository with no pins."
      ;;
    *)
      die "list_pins: '$loc' in package.json is a $block_type, not an object of override entries. Refusing to report a manifest this script cannot read as a repository with no pins."
      ;;
  esac

  jq --arg pm "$pm" --arg loc "$loc" "$SEMVER_JQ$PINS_JQ"'
    override_block($loc) as $block
    | (if ($block | type) == "object" then $block else {} end) as $b
    | (if $loc == "overrides" then
         [ npm_walk($b; [])[]
           | .path as $p | .value as $v
           | (if ($p | last) == "." and ($p | length) > 1
              then {parents: $p[0:-2], target: $p[-2]}
              else {parents: $p[0:-1], target: ($p | last)} end) as $s
           | pin($p[0]; $p; $s.parents; $s.target; $v) ]
       elif $loc == "pnpm.overrides" then
         [ $b | to_entries[]
           | .key as $k | .value as $v
           | ($k | pnpm_key) as $s
           | pin($k; ($s.parents + [$s.target]); $s.parents; $s.target; $v) ]
       else
         [ $b | to_entries[]
           | .key as $k | .value as $v
           | ($k | yarn_key) as $s
           | pin($k; ($s.parents + [$s.target]); $s.parents; $s.target; $v) ]
       end) as $pins
    | {
        pm: $pm,
        override_location: $loc,
        block_present: ($block != null),
        count: ($pins | length),
        bare_count: ([$pins[] | select(.scope == "bare")] | length),
        pins: $pins
      }' package.json
}

# Some repo scripts invoke the bare package-manager name internally, which
# fails when the toolchain is corepack-managed or vendored and no binary sits
# on PATH. This writes a one-line shim that delegates to the resolved runner,
# so callers prepend the directory to PATH instead of hand-rolling
# mkdir/printf/chmod (three separate commands, each drawing its own
# permission review). The optional runner override is a test seam
# (precedent: detect-capacity.sh's meminfo path).
verb_shim() {
  refuse_primary_checkout
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
  resolution_map)        verb_resolution_map ;;
  apply_constraint)      verb_apply_constraint "$@" ;;
  install)               verb_install ;;
  validate)              verb_validate "$@" ;;
  verification_commands) verb_verification_commands ;;
  compare_versions)      verb_compare_versions "$@" ;;
  range_facts)           verb_range_facts "$@" ;;
  declared_ranges)       verb_declared_ranges "$@" ;;
  shim)                  verb_shim "$@" ;;
  list_pins)             verb_list_pins ;;
  *) die "Unknown verb '$VERB'" ;;
esac
