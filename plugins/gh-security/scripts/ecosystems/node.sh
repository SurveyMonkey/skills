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
#   resolution_map                             -> {pm, lockfile_entries, entries_read,
#                                                  entries_expected, unreadable_entries,
#                                                  package_count, resolutions{}}
#   apply_constraint <pkg> <range> [parent...] -> {mode, parents[], written[],
#                                                  alias_lookup, observations[]}
#   install                                    -> pass-through, exit code is the signal
#   validate [--line <major>] [--vulnerable <range>]... [--baseline <json>] <pkg> <range>
#                                              -> {ok, line_present, checked,
#                                                  violations[],
#                                                  unresolved_alerts[],
#                                                  requires_major_bump[]}
#                                                 (--line requires --vulnerable)
#   compare_versions <a> <b>                   -> {result, delta, major_distance}
#   range_facts <range> <version>              -> {parseable, satisfied, pinned,
#                                                  floor_major, majors_ahead}
#                                                 (all null when not parseable)
#   declared_ranges [--line <major>] <pkg>     -> {ranges[], root_range,
#                                                  parents_read[],
#                                                  parents_without_range[],
#                                                  parents_unreadable[],
#                                                  parents_malformed[],
#                                                  parents_other_lines[], line}
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

# The key an entry is installed under, and npm's own name for it. `.value.name`
# is present exactly when the two differ (an `npm:` alias), so for every
# ordinary entry, nested or hoisted, the two are the same string.
NPM_ENTRY_KEY='(.key | split("node_modules/") | last)'
NPM_ENTRY_NAME='(.value.name // '"$NPM_ENTRY_KEY"')'

# Either name answers, because both are real names for the same copy and each
# is the one some caller holds. `resolution_map` keys the alias under the
# package it aliases, which is what an advisory query needs; but a `resolutions`
# or `overrides` entry for an aliased dependency is keyed by the **alias**
# (`"lodash-alias": "npm:lodash@4.18.2"`), so that is the name `list_pins` hands
# the audit. Answering `present: false` for it, while `declared_ranges` returns
# its range, is read as "the package left the tree" and recommends deleting the
# pin ([#46](https://github.com/SurveyMonkey/skills/issues/46)).
npm_versions() {
  jq --arg pkg "$1" '
    if (.packages | type) != "object" then
      error("package-lock.json has no .packages object (lockfileVersion 1 is unsupported)")
    else
      [ .packages | to_entries[]
        | select(.key | contains("node_modules/"))
        | select(.value.version != null)
        | select('"$NPM_ENTRY_NAME"' == $pkg or '"$NPM_ENTRY_KEY"' == $pkg)
        | {version: .value.version, path: .key} ]
    end' package-lock.json
}

npm_entry_count() {
  jq '[.packages // {} | keys[] | select(. != "")] | length' package-lock.json
}

# The entries this parser reads, and the rows it makes of them. One expression,
# used by `npm_resolution_pairs` for the map's rows and by `npm_parse_counts`
# for the guard's numerator, for the reason the yarn and pnpm parsers give: two
# copies of a locator parser is how the rows and the count drift apart.
#
# They had already drifted. The count asked only `.value.version != null` while
# the rows additionally required a leading digit, so a `{"version":"v1.2.3"}`
# entry was dropped from the map and reported `unreadable_entries: 0` — the map
# claiming full coverage of a package it does not contain, which is exactly the
# `collateral_changes: []` hazard the field exists to prevent
# ([#49](https://github.com/SurveyMonkey/skills/issues/49)).
#
# Link entries are excluded here as well as from the denominator, so the
# numerator stays a subset of it: they are read and deliberately kept out.
NPM_ROW_ENTRIES='( .packages // {} | to_entries[]
                   | select(.key | contains("node_modules/"))
                   | select(.value.link != true) )'

NPM_ROW='( select(.value.version != null)
           | {package: '"$NPM_ENTRY_NAME"',
              version: (.value.version | tostring)}
           | select(.version | test("^[0-9]")) )'

# `<installed>\t<versioned>` for the parse guard: the entries that name an
# installed package this parser was supposed to read, and the subset this
# parser turned into a row.
#
# A workspace is recorded as `"node_modules/<ws>": {"resolved":"packages/<ws>",
# "link":true}`: the key contains `node_modules/`, so it counted in the
# denominator, and it has no `version`, so it could never count in the
# numerator. Six workspaces beside four dependencies therefore read as `Read 4
# of 10` and hard-failed an ordinary npm-workspaces monorepo with a "the parser
# is broken" diagnosis, while this comment claimed the exclusion the code did
# not perform ([#48](https://github.com/SurveyMonkey/skills/issues/48)). Link
# entries are excluded from the denominator now: they are read and deliberately
# kept out, which is the same third answer the yarn and pnpm parsers give.
npm_parse_counts() {
  jq -r '[ '"$NPM_ROW_ENTRIES"' ]
         | "\(length)\t\([.[] | '"$NPM_ROW"'] | length)"' \
    package-lock.json
}

# pnpm's locator parser, giving the same three answers the yarn one gives.
#
# A `packages:` key is `<name>@<version>` for a registry entry, split on the
# FIRST `@` after position 1 — a scoped name's own `@` is position 1, and the
# separator is the next one. Splitting on the LAST `@` instead read
# `ssh-dep@git+ssh://git@github.com/...` as the name `ssh-dep@git+ssh://git`,
# so the protocol test below never saw `git+ssh:` and a perfectly ordinary
# forked dependency counted as a parse failure. One of those is enough to force
# `collateral_changes: null` and `not-checked` for every pin in the repository,
# and `git+ssh` forks are common ([#49](https://github.com/SurveyMonkey/skills/issues/49)).
# The last-`@` split is kept as a fallback for a key neither test recognizes at
# the first `@`, so nothing that used to parse stopped parsing.
#
# Where the version would be, a local dependency carries a protocol instead —
# and pnpm had no "read it and deliberately excluded it" answer at all, so two
# registry entries beside a `link:`, a `file:` and a git dependency read as
# `Read 2 of 5` and hard-failed a legitimate workspace ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
# Both directions were wrong: workspaces killed a healthy lockfile, and local
# dependencies padded the recognized share of a genuinely broken one.
#
# One awk program, two modes, for the reason the yarn parser gives below: two
# copies of a locator parser is how the rows and the guard's counts drift apart.
PNPM_LOCATOR_AWK=$(cat <<'AWKLIB'
    # One candidate split: name before `at`, version or protocol after it.
    # Same three answers the yarn parser gives.
    function pnpm_split(line, at,   ver) {
      PR_NAME = substr(line, 1, at - 1)
      ver = substr(line, at + 1)
      if (ver ~ /^[0-9]/) { PR_VER = ver; return 1 }
      if (ver ~ /^(link|file|workspace|portal|catalog|exec|git|git[+]ssh|git[+]http|git[+]https|http|https|ssh|github|gitlab|bitbucket):/)
        return 2
      return 0
    }

    function pnpm_row(line,   i, first, last, code) {
      first = 0
      for (i = 2; i <= length(line); i++)
        if (substr(line, i, 1) == "@") { first = i; break }
      if (first == 0) return 0
      code = pnpm_split(line, first)
      if (code > 0) return code
      last = 0
      for (i = length(line); i > 1; i--)
        if (substr(line, i, 1) == "@") { last = i; break }
      if (last == first) return 0
      return pnpm_split(line, last)
    }
    /^packages:/ { inpkgs = 1; next }
    /^[a-zA-Z]/  { inpkgs = 0 }
    inpkgs && /^  [^ ]/ {
      line = $0
      sub(/^  /, "", line)
      # A peer-dependency suffix is not part of the identity.
      p = index(line, "(")
      if (p > 0) line = substr(line, 1, p - 1)
      sub(/:$/, "", line)
      gsub(/\x27/, "", line)
      total++
      code = pnpm_row(line)
      if (code > 0) recognized++
      if (code == 1 && mode != "count") printf "%s\t%s\n", PR_NAME, PR_VER
    }
    END { if (mode == "count") printf "%d\t%d\n", total + 0, recognized + 0 }
AWKLIB
)

pnpm_rows() {
  awk -v mode=rows "$PNPM_LOCATOR_AWK" pnpm-lock.yaml
}

# `<total>\t<recognized>`: every `packages:` entry, and the subset this parser
# could read at all — registry versions plus the deliberately excluded ones.
pnpm_counts() {
  awk -v mode=count "$PNPM_LOCATOR_AWK" pnpm-lock.yaml
}

pnpm_versions() {
  pnpm_rows \
    | jq -Rs --arg pkg "$1" \
        'split("\n") | map(select(length > 0) | split("\t"))
         | map(select(.[0] == $pkg) | {version: .[1], path: (.[0] + "@" + .[1])})'
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
#
# One awk program, two modes. `rows` emits the registry resolutions;
# `count` emits `<total>\t<recognized>` for the parse guard, which needs to
# know how many locators this parser could read at all — not how many it kept.
# A single copy behind a variable, because two copies of a locator parser is
# how the two counts drift apart, and the guard is only worth anything while
# they measure the same lockfile the same way.
YARN_LOCATOR_AWK=$(cat <<'AWKLIB'
    # The name a locator resolves under: everything before its first "@", from
    # position 2 so a scoped name keeps its own leading "@".
    function locator_name(res,   n) {
      for (n = 2; n <= length(res); n++)
        if (substr(res, n, 1) == "@") return substr(res, 1, n - 1)
      return ""
    }

    # One level of percent-decoding.
    #
    # Berry escapes the locator a `patch:` wraps, and escapes it again per
    # nesting level: a patch of an already-patched package carries %253A where
    # a single patch carries %3A. So this runs once per unwrap rather than once
    # per line, and %25 is decoded LAST — decoding it first would collapse two
    # levels in one pass and split the inner locator a level too early, which
    # is how a patch-of-patch used to fall out of both verbs entirely at a real
    # registry version.
    function pct_decode(s) {
      gsub(/%3[Aa]/, ":", s)
      gsub(/%23/, "#", s)
      gsub(/%40/, "@", s)
      gsub(/%25/, "%", s)
      return s
    }

    # Read one locator. Three answers, not two:
    #
    #   1  it resolves to a registry version (RV_NAME, RV_VER, RV_KEY set)
    #   2  it deliberately resolves to none — workspace:, portal:, exec:,
    #      link:, file:, git and URL targets are local or generated code, whose
    #      package.json version is not a published release
    #   0  this parser could not read it
    #
    # The third answer exists for the parse guard. "Read it and excluded it"
    # and "could not read it" produce the same empty map, and one of them is a
    # broken parser reporting a clean tree.
    #
    # patch: is unwrapped rather than excluded: it wraps a published release,
    # so the wrapped locator is asked the same question, once per nesting
    # level. An `npm:` descriptor that is not a version is an alias naming
    # another package, and the row is keyed under the package it aliases, on
    # the same rule the npm adapter path uses.
    function locator_row(res,   d, i, n, hash, ver, sep, at, p, proto) {
      RV_KEY = locator_name(res)
      RV_NAME = RV_KEY
      RV_VER = ""
      if (RV_KEY == "") return 0
      while (1) {
        res = pct_decode(res)
        i = 0
        for (n = 2; n <= length(res); n++)
          if (substr(res, n, 1) == "@") { i = n; break }
        if (i == 0) return 0
        d = substr(res, i + 1)
        p = index(d, ":")
        proto = (p > 0) ? substr(d, 1, p - 1) : ""
        if (proto == "npm") {
          ver = substr(d, p + 1)
          # Berry appends binding parameters after "::" — __archiveUrl for
          # anything fetched from a non-default registry, i.e. every private or
          # mirrored one. Left attached, the string still ranks as its core
          # version but sorts strictly below the clean release, so it is
          # admitted by a wide range and rejected by the narrow ">= 2.5.0,
          # < 2.5.3" shape advisories use: a vulnerable copy reading safe.
          sep = index(ver, "::")
          if (sep > 0) ver = substr(ver, 1, sep - 1)
          # A full semver match, not a leading digit. Anything else is a
          # locator this parser misread, and a misreading belongs in the guard
          # below rather than in a version string.
          if (ver ~ /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$/) {
            RV_VER = ver
            return 1
          }
          at = 0
          for (n = length(ver); n > 1; n--)
            if (substr(ver, n, 1) == "@") { at = n; break }
          if (at == 0) return 0
          RV_NAME = substr(ver, 1, at - 1)
          res = RV_NAME "@npm:" substr(ver, at + 1)
          continue
        }
        if (proto == "patch") {
          res = substr(d, p + 1)
          # Everything from the first "#" is the patch file and its metadata.
          hash = index(res, "#")
          if (hash > 0) res = substr(res, 1, hash - 1)
          continue
        }
        if (proto ~ /^(workspace|portal|exec|link|file|git|git[+]ssh|git[+]http|git[+]https|http|https|ssh|github|gitlab|bitbucket)$/)
          return 2
        return 0
      }
    }
    {
      i = index($0, "resolution: \"")
      if (i == 0) next
      rest = substr($0, i + 13)
      j = index(rest, "\"")
      if (j == 0) next
      res = substr(rest, 1, j - 1)
      total++
      code = locator_row(res)
      if (code > 0) recognized++
      if (code == 1 && mode != "count")
        printf "%s\t%s\t%s\t%s\n", RV_NAME, RV_VER, res, RV_KEY
    }
    END { if (mode == "count") printf "%d\t%d\n", total + 0, recognized + 0 }
AWKLIB
)

yarn_resolution_rows() {
  awk -v mode=rows "$YARN_LOCATOR_AWK" yarn.lock
}

# `<total>\t<recognized>`: every `resolution:` line, and the subset this parser
# could read. Replaces a `grep -c`, which counted lines the parser might have
# dropped every one of (issue #46).
yarn_counts() {
  awk -v mode=count "$YARN_LOCATOR_AWK" yarn.lock
}

# Matched on either name: the package a locator resolves to, or the key it is
# installed under. They differ only for an `npm:` alias, where the alias key is
# what a `resolutions` entry names — so answering `present: false` for it while
# `declared_ranges` reports a range is the disagreement that turns a pin on a
# real package into a deletion recommendation (issue #46). `resolution_map`
# keeps the canonical name only; see its header.
yarn_versions() {
  yarn_resolution_rows \
    | jq -Rs --arg pkg "$1" \
        'split("\n") | map(select(length > 0) | split("\t"))
         | map(select(.[0] == $pkg or .[3] == $pkg) | {version: .[1], path: .[2]})'
}

# The parse guard, shared by both lockfile verbs.
#
# `entries` is what the lockfile claims to hold. `read` is what this parser
# could actually make sense of, out of `denom` entries that it should have been
# able to: for yarn that is every locator it recognized, registry or
# deliberately excluded, and for npm and pnpm it is the entries carrying a
# version.
#
# Two failures, both of which used to pass. Zero entries is a parser that
# matched nothing (v0.1.0's yarn regex, scripts/CLAUDE.md). A collapsed ratio is
# the subtler one: `resolution_map` reported `{"lockfile_entries":3,
# "package_count":0,"resolutions":{}}` and exit 0, because the count came from a
# `grep` the rows never had to survive. Two empty maps compare equal, so the
# audit's collateral check degraded into a no-op that *strengthens* a removal
# recommendation (issue #46).
#
# Deliberately a ratio and not a zero-check. A repository whose dependencies are
# all workspaces and portals legitimately resolves to no registry version at
# all, so `read == 0` is a real answer there; and a *partial* parse — one
# encoding change dropping most rows — passes a zero-check while poisoning every
# diff computed from it.
guard_parse() {
  _pm=$1
  _entries=$2
  _read=$3
  _denom=$4
  if [ "$_entries" -eq 0 ]; then
    die "Parsed 0 entries from the lockfile for pm '$_pm'. The parser is broken or the lockfile format is unrecognized; refusing to report this as a clean result."
  fi
  if [ "$_denom" -gt 0 ] && [ $((_read * 2)) -lt "$_denom" ]; then
    die "Read $_read of $_denom lockfile entries for pm '$_pm'. The parser understands too little of this lockfile to describe the tree; refusing to report a mostly-unparsed lockfile as a clean result."
  fi
}

verb_resolved_versions() {
  pkg="${1:?resolved_versions requires a package name}"
  pm=$(pm_of)
  case "$pm" in
    npm)
      versions=$(npm_versions "$pkg")
      entries=$(npm_entry_count)
      counts=$(npm_parse_counts)
      denom=$(printf '%s' "$counts" | cut -f1)
      parsed=$(printf '%s' "$counts" | cut -f2)
      ;;
    pnpm)
      versions=$(pnpm_versions "$pkg")
      counts=$(pnpm_counts)
      entries=$(printf '%s' "$counts" | cut -f1)
      parsed=$(printf '%s' "$counts" | cut -f2)
      denom=$entries
      ;;
    yarn)
      versions=$(yarn_versions "$pkg")
      counts=$(yarn_counts)
      entries=$(printf '%s' "$counts" | cut -f1)
      parsed=$(printf '%s' "$counts" | cut -f2)
      denom=$entries
      ;;
    *)    die "resolved_versions: unsupported pm '$pm'" ;;
  esac

  guard_parse "$pm" "$entries" "$parsed" "$denom"

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
# Deliberately a separate verb, not a widening of `resolved_versions`: the two
# answer different questions, and the per-path detail one caller needs is not
# what a whole-tree diff wants.
#
# What does NOT travel with that separation is the identity rule. Both verbs
# answer "what version of X is in the tree", so a change to what counts as X
# lands in both or the audit's own cross-check reports a parser bug
# ([#44](https://github.com/SurveyMonkey/skills/issues/44)). That does shift
# `validate`, deliberately: a copy installed under an `npm:` alias key is a
# copy of the aliased package, and hiding it from the completeness check is the
# unsafe direction — a vulnerable copy no `--vulnerable` range would ever match
# ([#46](https://github.com/SurveyMonkey/skills/issues/46)). `apply_constraint`
# writes the alias key so that copy can also be moved, which is what makes the
# stricter answer actionable rather than a dead end.
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
# - A **patched** package is included at the version its innermost locator
#   names, unwrapped one nesting level at a time — `yarn patch` applies a diff
#   to a real published release, and it is used above all for one-off security
#   fixes, so dropping those entries blinded the audit to the very packages it
#   exists to watch ([#44](https://github.com/SurveyMonkey/skills/issues/44)).
#   A patch wrapping a workspace or portal target is still excluded, on the
#   same rule, and a patch whose inner locator this parser cannot read is not
#   silently dropped: it counts against the parse guard above
#   ([#46](https://github.com/SurveyMonkey/skills/issues/46)).
# - An `npm:` **alias** is included under the package it aliases, not the key
#   it is installed as — in the npm lockfile, where the real name sits in
#   `.value.name`, and in Berry, where the descriptor after `npm:` names it.
#   The resolved code genuinely is that package, and the audit feeds this name
#   straight into an advisory query, where the alias key returns
#   `no-advisories` — indistinguishable from a package with a clean record.
#   `resolved_versions` answers under **both** names for exactly the same
#   reason in reverse: the alias key is what an override entry names, so
#   answering `present: false` for it reads as "the package left the tree"
#   ([#46](https://github.com/SurveyMonkey/skills/issues/46)).
# ---------------------------------------------------------------------------
npm_resolution_pairs() {
  jq '
    if (.packages | type) != "object" then
      error("package-lock.json has no .packages object (lockfileVersion 1 is unsupported)")
    else
      [ '"$NPM_ROW_ENTRIES"' | '"$NPM_ROW"' ]
    end' package-lock.json
}

pnpm_resolution_pairs() {
  pnpm_rows \
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
    npm)
      pairs=$(npm_resolution_pairs)
      entries=$(npm_entry_count)
      counts=$(npm_parse_counts)
      denom=$(printf '%s' "$counts" | cut -f1)
      parsed=$(printf '%s' "$counts" | cut -f2)
      ;;
    pnpm)
      pairs=$(pnpm_resolution_pairs)
      counts=$(pnpm_counts)
      entries=$(printf '%s' "$counts" | cut -f1)
      parsed=$(printf '%s' "$counts" | cut -f2)
      denom=$entries
      ;;
    yarn)
      pairs=$(yarn_resolution_pairs)
      counts=$(yarn_counts)
      entries=$(printf '%s' "$counts" | cut -f1)
      parsed=$(printf '%s' "$counts" | cut -f2)
      denom=$entries
      ;;
    *)    die "resolution_map: unsupported pm '$pm'" ;;
  esac

  # Same rule as resolved_versions, and for a sharper reason: a whole-tree diff
  # against an empty map reports every package as unchanged, which is the
  # wrong-safe answer wearing the shape of a clean diff.
  guard_parse "$pm" "$entries" "$parsed" "$denom"

  # How much of the lockfile this map is actually built from.
  #
  # The ratio guard above fires only below half, so a single unreadable locator
  # passes it — and that entry's package is then absent from the map, silently.
  # It is absent from the baseline snapshot *and* from the post-removal one, so
  # the audit's step-6 diff sees no change and reports `collateral_changes: []`,
  # which its own schema documents as the STRONGER claim ("nothing else moved",
  # against `null`'s "nobody looked"). An unaudited package becomes an
  # affirmatively clean one and the pin stays `removable`
  # ([#48](https://github.com/SurveyMonkey/skills/issues/48)). So the map states
  # its own coverage and `agents/audit-pins.md` step 6 requires `null` +
  # `not-checked` whenever `unreadable_entries` is non-zero.
  printf '%s' "$pairs" \
    | jq --arg pm "$pm" --argjson entries "$entries" \
         --argjson read "$parsed" --argjson denom "$denom" \
        '(reduce .[] as $p ({}; .[$p.package] += [$p.version]) | map_values(unique)) as $res
         | {pm: $pm, lockfile_entries: $entries,
            entries_read: $read, entries_expected: $denom,
            unreadable_entries: ($denom - $read),
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
#
# A dependency declared through an `npm:` alias (`"lodash-alias":
# "npm:lodash@^4.18.0"`) is a declaration of the aliased package under another
# name, so the parent counts for both names. Matching the declared key alone
# left `why <package>` reporting no parents for exactly the repositories where
# the copy is hardest to find, so the fix flow could neither name a parent to
# scope to nor move the copy with a bare entry
# ([#46](https://github.com/SurveyMonkey/skills/issues/46)).
NPM_ALIAS_TARGET=$(cat <<'JQLIB'
(if (type == "string") and startswith("npm:")
 then (.[4:] | (rindex("@")) as $i
       | if $i == null or $i == 0 then . else .[0:$i] end)
 else null end)
JQLIB
)

# Every dependency declaration the lockfile records, as
# `<parent><TAB><declared key><TAB><declared value>`.
#
# One reader for three questions that used to have three answers: which parents
# declare a package (`why`), under which key each of them declares it
# (`apply_constraint`), and with which range (`declared_ranges`). The lockfile
# rather than `node_modules/<parent>/package.json`, because that directory does
# not exist where these are asked: `apply_constraint` runs **before** `install`,
# in a fresh worktree where node_modules is gitignored; Yarn PnP never has one
# at all; pnpm links only direct dependencies into it. The old lookup therefore
# `continue`d for every parent and wrote the plain package name, which does not
# govern an aliased copy — silently, since nothing recorded that the lookup had
# been attempted ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
npm_declaration_rows() {
  jq -r '
    .packages // {} | to_entries[]
    | (if .key == "" then "__root__"
       else (.key | split("node_modules/") | last) end) as $parent
    | [ (.value.dependencies        // {}),
        (.value.optionalDependencies // {}),
        (.value.peerDependencies     // {}) ]
    | add // {}
    | to_entries[]
    | select(.value | type == "string")
    | [$parent, .key, .value] | @tsv' package-lock.json
}

# Berry's equivalent: the `dependencies:`, `peerDependencies:` and
# `optionalDependencies:` blocks under each `resolution:` entry. Workspace
# entries are the repository's own packages rather than registry parents an
# override can be scoped to, so they are dropped here exactly as npm's root
# entry is filtered out of `npm_parents` below.
#
# All three blocks, on the rule npm's reader already followed and ADR 001
# states: a parent that declares the package as a peer is why the copy is in
# the tree at all, and one that declares it optionally installs it wherever the
# platform allows. Matching `dependencies:` alone made those parents invisible
# to `why`, so `apply_constraint` had nothing to scope to and `declared_ranges`
# never saw their range — the same shape as
# [#47](https://github.com/SurveyMonkey/skills/issues/47), one block over
# ([#49](https://github.com/SurveyMonkey/skills/issues/49)). `peerDependenciesMeta:`
# is not among them and does not match: the pattern requires the colon
# immediately after the block name, and its own entries are nested a level
# deeper.
#
# The double-quote character comes from `sprintf`, never from a literal, and
# that is a constraint rather than a preference: bash 3.2 — the version this
# targets — scans for the closing `)` of a command substitution while tracking
# double quotes, so a heredoc body carrying an *unpaired* `"` (which the obvious
# `/resolution: "/` and `index(rest, "\"")` both introduce) is cut short and the
# remainder of the file is parsed as shell.
#
# It breaks only under bash 3.2 — the default macOS `/bin/bash`, and the floor
# scripts/CLAUDE.md sets — and NOT where the suite would notice on its own:
# `.shellspec` runs the examples under `--shell sh`, and the adapter runs under
# whatever `bash` leads PATH, which on a development machine is Homebrew's 5.x.
# A reintroduced unpaired quote would therefore go green everywhere modern bash
# is installed, which is the same shape of defect as a comment describing
# protection the code does not perform. `spec/bash32_parse_spec.sh` closes it by
# running `/bin/bash -n` over these scripts
# ([#49](https://github.com/SurveyMonkey/skills/issues/49)).
YARN_DECLARATION_AWK=$(cat <<'AWKLIB'
    BEGIN { q = sprintf("%c", 34) }
    /^[^[:space:]#]/ { cur = ""; indeps = 0 }
    /resolution: / {
      i = index($0, "resolution: ")
      rest = substr($0, i + 13)
      j = index(rest, q)
      res = substr(rest, 1, j - 1)
      if (index(res, "@workspace:") > 0) { cur = ""; next }
      at = 0
      for (k = length(res); k > 1; k--) {
        if (substr(res, k, 1) == "@") { at = k; break }
      }
      cur = (at > 1) ? substr(res, 1, at - 1) : res
      next
    }
    /^  (dependencies|peerDependencies|optionalDependencies):/ { indeps = 1; next }
    /^  [a-zA-Z]/ { indeps = 0 }
    indeps && /^    / {
      dep = $0
      sub(/^    /, "", dep)
      c = index(dep, ":")
      if (c == 0) next
      name = substr(dep, 1, c - 1)
      val  = substr(dep, c + 1)
      gsub(q, "", name)
      sub(/^[[:space:]]+/, "", val)
      sub(/[[:space:]]+$/, "", val)
      gsub(q, "", val)
      if (cur != "") printf "%s\t%s\t%s\n", cur, name, val
    }
AWKLIB
)

yarn_declaration_rows() {
  awk "$YARN_DECLARATION_AWK" yarn.lock
}

# The rows for the package manager in hand, or nothing.
#
# pnpm is the nothing: its `snapshots:` blocks record what each dependency
# *resolved to*, not the key and specifier it was *declared* with, so this
# adapter has no source for a pnpm alias declaration. That is reported rather
# than guessed at — see `alias_lookup` in `apply_constraint`.
declaration_rows() {
  case "$1" in
    npm)  npm_declaration_rows ;;
    yarn) yarn_declaration_rows ;;
    *)    : ;;
  esac
}

# The parents that declare $1, by either of its names, out of the rows on stdin.
parents_from_rows() {
  jq -Rs --arg pkg "$1" '
    split("\n") | map(select(length > 0) | split("\t"))
    | map(select(.[1] == $pkg
                 or (.[2] | '"$NPM_ALIAS_TARGET"') == $pkg) | .[0])
    | unique'
}

npm_parents() {
  npm_declaration_rows | parents_from_rows "$1"
}

# Parent -> child resolution edges out of pnpm's `snapshots:` section:
# `parent<TAB>parent_version<TAB>child_resolved_version`, one row per snapshot
# whose `dependencies:` block names $1. A field either parser cannot split
# out is `-`, never a guess.
#
# The snapshots record what each dependency *resolved to*, never the specifier
# it was declared with — so this reader yields no declared range, and nothing
# downstream pretends otherwise. What the resolved version does answer is LINE
# MEMBERSHIP: which major of the child each copy of a parent actually pulls
# in. Discarding the versions here is what left `declared_ranges --line` and
# `apply_constraint` blind under pnpm's isolated-store layout, where no
# `node_modules/<parent>` manifest exists to probe: parents landed in
# `parents_unreadable` while sitting on another line, and the bare
# `parent>child` override written for them collapsed the sibling lines
# ([#100](https://github.com/SurveyMonkey/skills/issues/100)).
pnpm_edge_rows() {
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
        # The parent locator splits on its LAST `@`: a scoped name owns the
        # one at position 1, exactly as `pnpm_key` in PINS_JQ splits.
        curname = cur
        curver = "-"
        at = 0
        for (k = length(cur); k > 1; k--) {
          if (substr(cur, k, 1) == "@") { at = k; break }
        }
        if (at > 1) {
          curname = substr(cur, 1, at - 1)
          curver = substr(cur, at + 1)
        }
        if (curver == "") curver = "-"
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
        val  = substr(dep, c + 1)
        gsub(/\x27/, "", name)
        sub(/^[[:space:]]+/, "", val)
        sub(/[[:space:]]+$/, "", val)
        gsub(/\x27/, "", val)
        # A peer-dependency suffix is not part of the resolved version.
        p = index(val, "(")
        if (p > 0) val = substr(val, 1, p - 1)
        if (val == "") val = "-"
        if (name == pkg && curname != "")
          printf "%s\t%s\t%s\n", curname, curver, val
      }
    }
  ' pnpm-lock.yaml
}

pnpm_parents() {
  pnpm_edge_rows "$1" | cut -f1 | sort -u \
    | jq -Rs 'split("\n") | map(select(length > 0))'
}

# Berry parents, matched on either name, exactly as npm's are.
#
# Matching the declared key alone made a Berry parent that reaches a package
# through an `npm:` alias invisible to `why`, so `apply_constraint` got zero
# parents and only the root-alias branch could fire: Yarn Berry had no working
# path at all from the alias identity shift to a fix
# ([#47](https://github.com/SurveyMonkey/skills/issues/47)).
yarn_parents() {
  yarn_declaration_rows | parents_from_rows "$1"
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
  #
  # A large dependency tree can push `pnpm why` output to megabytes, and
  # handing that to jq as a plain string argument puts it on argv rather than
  # a file. That overflows the exec argument list before jq ever runs
  # ([#102](https://github.com/SurveyMonkey/skills/issues/102)). A temp file
  # plus `--rawfile` keeps it off argv entirely; stdin is already carrying
  # `$parents`, so a file is the only clean channel left for `raw`.
  why_cmd=$(verb_detect | jq -r '.why_cmd')

  raw_file=$(mktemp)
  trap 'rm -f "$raw_file"' EXIT INT TERM
  $why_cmd "$pkg" > "$raw_file" 2>&1 || true

  # Command substitution (the old `raw=$($why_cmd ...)` form) stripped every
  # trailing newline; streaming straight to the file keeps them, so the strip
  # moves into jq's own program to keep the emitted `raw` field byte-identical.
  printf '%s' "$parents" \
    | jq --arg pkg "$pkg" --arg pm "$pm" --rawfile raw "$raw_file" \
         --argjson direct "$direct" --argjson dev_only "$dev_only" '
      (map(select(. != "__root__"))) as $pkgparents
      | {
          pm: $pm,
          package: $pkg,
          relationship: (if $direct then "direct" else "transitive" end),
          dev_only: $dev_only,
          parents: $pkgparents,
          parent_count: ($pkgparents | length),
          raw: ($raw | sub("\n+$"; ""))
        }'
}

# ---------------------------------------------------------------------------
# validate — composes resolved_versions and applies the constraint
#
# Usage: validate [--line <major>] [--vulnerable <range>]... [--baseline <json>]
#                 <pkg> <constraint>
#
# Three independent questions, because passing one is not passing the others
# (issues #19 and #83):
#
#   1. Constraint. Does every resolved copy satisfy the range the fix applied?
#      `--line` narrows this to the major line the group targets: a package
#      resolved at 5.x, 6.x and 7.x concurrently can never satisfy one
#      major-bounded range, and each line is a separate group with its own fix.
#   2. Completeness. Does any resolved copy still match a `vulnerable_range`
#      from the group's alerts? Meeting the constraint on the copy you fixed
#      says nothing about the copies you did not, which is how a partial fix
#      used to report success.
#   3. Collateral. Did the install move a copy on a major line this group does
#      not own? `--baseline` takes the pre-fix `resolved_versions` output and
#      answers it in `other_line_moves[]`.
#
# The third question exists because the first two are *both* scoped to `--line`
# and therefore cannot see an out-of-line copy at all. A Yarn `resolutions` key
# is not: `minimatch/brace-expansion` carries no version on its parent half, and
# Yarn applies it to every resolved copy of `minimatch`. On a live run that
# dragged `minimatch@3.1.5`'s `brace-expansion` from `1.1.18` to `5.0.9` — a
# different major than the `^1.1.7` that parent `require()`s — while
# `validate --line 5` returned `ok: true`, because 1.x was never in its window
# ([#83](https://github.com/SurveyMonkey/skills/issues/83)).
#
# Narrowing the key instead is a separate change with three different
# semantics behind it, and Yarn's is the one that fails open: its `from` half is
# compared by `locatorHash` equality against the parent's *resolved* locator, so
# only the exact resolved version narrows and a **range there parses and then
# silently never matches**. pnpm (`parent@^10>dep`, `semver.satisfies` on the
# resolved version) and npm (`{"parent@^10": {...}}`) can express what Yarn
# cannot. Detection is the guard that has to exist either way.
#
# `other_line_moves` is `null` when no baseline was passed and `[]` when one was
# and nothing moved. Never `[]` for both: "not checked" collapsing into "checked
# and clean" is the same failure as the pin audit's `collateral_changes` (#48),
# and here it would launder the very defect this answers.
#
# Only lines *present in the baseline* are compared. A major that appears for
# the first time after the install is the install adding a copy, not this fix
# moving one, and reporting it would fire on every legitimate new resolution.
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
#
# A third joins them for the same reason: `--baseline` is checked against the
# contract it is supposed to satisfy before it is used. A truncated payload, or
# one captured for a different package, would compare the current tree against
# nothing and report no cross-line moves at all — a clean answer produced by
# having checked nothing, which is the unsafe direction here.
# ---------------------------------------------------------------------------
verb_validate() {
  line=""
  vuln_ranges=""
  baseline=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --line)
        line="${2:?--line requires a major}"
        shift 2
        ;;
      --baseline)
        baseline="${2:?--baseline requires the pre-fix resolved_versions JSON}"
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

  if [ -n "$baseline" ] && [ -z "$line" ]; then
    die "validate: --baseline requires --line. A cross-line move is defined against the line this group owns; with no line to exclude, every move looks like collateral (issue #83)."
  fi

  # The baseline is checked against the shape `resolved_versions` promises, and
  # for the package actually being validated. `[]` is a legitimate `.versions`
  # (a package absent before the fix), so emptiness is not the test: presence
  # and type are, exactly as ADR 001 requires of every contract field.
  baseline_json=null
  if [ -n "$baseline" ]; then
    baseline_json=$(printf '%s' "$baseline" | jq -c --arg pkg "$pkg" '
      select(type == "object"
             and has("package") and .package == $pkg
             and has("versions") and (.versions | type) == "array"
             and (.versions | all(type == "object" and has("version")
                                  and (.version | type) == "string")))' 2>/dev/null) \
      || baseline_json=""
    if [ -z "$baseline_json" ]; then
      die "validate: --baseline is not a usable pre-fix baseline for '$pkg'. Pass the phase 2 'resolved_versions $pkg' output verbatim: a JSON object whose .package is '$pkg' and whose .versions is an array of objects each carrying a string .version. A baseline that is truncated, or captured for another package, would report no cross-line moves at all (issue #83)."
    fi
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
      --argjson baseline "$baseline_json" \
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
    # Every baseline major other than the one this group owns, listed only when
    # the set of versions on it changed. `vanished` is the shape the live defect
    # took: the 1.x copy was not moved within its line, it stopped existing.
    | (if $baseline == null then null
       else [ $baseline.versions
              | map(select((.version | major_of) != $lineno))
              | group_by(.version | major_of)[]
              | (.[0].version | major_of) as $m
              | {major: $m,
                 before: ([ .[].version ] | unique),
                 after: ([ $r.versions[]
                           | select((.version | major_of) == $m) | .version ] | unique)}
              | select(.before != .after)
              | . + {status: (if (.after | length) == 0 then "vanished" else "moved" end)} ]
       end) as $other_moves
    | {ok: (($bad | length) == 0
            and ($unresolved | length) == 0
            and ($lineno == null or ($inline | length) > 0)
            and ($other_moves == null or ($other_moves | length) == 0)),
       package: $r.package, range: $range,
       line: (if $line == "" then null else $line end),
       line_present: ($lineno == null or ($inline | length) > 0),
       checked: ($inline | length),
       resolved_count: $r.count,
       violations: $bad,
       unresolved_alerts: $unresolved,
       requires_major_bump: $bump,
       other_line_moves: $other_moves,
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

# Every key the manifest at $2 declares $1 under, alias keys included, as a JSON
# array. A manifest that names the package directly yields `["<pkg>"]`; one that
# reaches it through `npm:` yields the alias key; one that does both yields both,
# because an override entry moves only the key it names and the copy under the
# other key would be left vulnerable with nothing saying so
# ([#48](https://github.com/SurveyMonkey/skills/issues/48), finding 7). jq's
# exit status is not swallowed: a manifest that will not parse is an error here,
# not an empty answer indistinguishable from a package nobody declares.
declared_keys_of() {
  jq -c --arg pkg "$1" '
    [ (.dependencies // {}), (.devDependencies // {}),
      (.optionalDependencies // {}), (.peerDependencies // {}) ]
    | map(to_entries[]
          | select(.key == $pkg
                   or (.value | (type == "string")
                       and (startswith("npm:" + $pkg + "@")
                            or . == "npm:" + $pkg)))
          | .key)
    | unique' "$2"
}

# The same question asked of the LOCKFILE, for every parent at once:
# `{keys_by_parent: {<parent>: [<key>...]}, unresolved: [<parent>...]}`.
#
# A parent whose declaration this adapter cannot locate is named in
# `unresolved`, never silently skipped — the whole failure mode of the
# node_modules lookup this replaces was that it skipped and said nothing.
alias_keys_from_lockfile() {
  declaration_rows "$1" | jq -Rs --arg pkg "$2" --argjson parents "$3" '
    (split("\n") | map(select(length > 0) | split("\t"))
     | map({parent: .[0], key: .[1], value: .[2]})
     | group_by(.parent)
     | map({key: .[0].parent, value: .}) | from_entries) as $by
    | {
        keys_by_parent:
          ( [ $parents[] | . as $p
              | select($by | has($p))
              | { key: $p,
                  value: ( [ $by[$p][]
                             | select(.key == $pkg
                                      or (.value | '"$NPM_ALIAS_TARGET"') == $pkg)
                             | .key ] | unique ) } ]
            | from_entries ),
        unresolved: [ $parents[] | . as $p | select($by | has($p) | not) ]
      }'
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

  # The keys the dependents declare this package under, when they declare it
  # through an `npm:` alias. An override entry has to name the key the
  # dependent used — `overrides.lodash` does not move a copy installed as
  # `lodash-alias` — and its value has to carry the protocol back, because
  # `lodash-alias` is not a package any registry has. Without this the fix flow
  # dead-ended on every repository holding an aliased copy of an alerted
  # package ([#46](https://github.com/SurveyMonkey/skills/issues/46)).
  #
  # The root's keys come from the manifest, which is on disk by definition. Each
  # parent's come from the LOCKFILE: `node_modules/<parent>/package.json` is not
  # there when this verb runs, so the old lookup skipped every parent and wrote
  # the plain name, silently
  # ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
  root_keys=$(declared_keys_of "$pkg" package.json) \
    || die "apply_constraint: cannot read package.json"
  case "$pm" in
    npm|yarn) alias_source="lockfile" ;;
    *)        alias_source="unsupported" ;;
  esac
  lookup=$(alias_keys_from_lockfile "$pm" "$pkg" "$parents_json")
  keys_by_parent=$(printf '%s' "$lookup" | jq -c '.keys_by_parent')
  parents_unresolved=$(printf '%s' "$lookup" | jq -c '.unresolved')

  # pnpm only: the parent versions each scoped key must be qualified with.
  #
  # A bare `parent>child` key matches EVERY resolved copy of the parent, so a
  # parent in the tree at several versions — each copy resolving its own major
  # of the child — has all of its copies dragged onto this group's line, which
  # collapses the sibling lines and fails closed at `validate --baseline`
  # (field run: `ws` 7.x/8.x and `brace-expansion` 1.x each overrode every
  # copy of every parent; the sibling lines vanished). pnpm compares the
  # parent half of `parent@<v>>child` with `semver.satisfies` against the
  # parent's resolved version, so an exact version narrows the key to one
  # copy. The map is parent -> the versions to qualify with: only parents the
  # lockfile resolves at MORE than one version (a single-version parent keeps
  # today's bare key — nothing else exists for the key to leak onto), and only
  # the versions whose resolution of the child sits on the target line, read
  # from the same `snapshots:` edges `declared_ranges --line` classifies with.
  # A version whose child resolution cannot be read is kept — covering a copy
  # twice is harmless, missing one is not. A parent with no qualifying
  # version at all falls back to the bare key rather than writing nothing
  # ([#100](https://github.com/SurveyMonkey/skills/issues/100)).
  #
  # pnpm only, deliberately: npm's nested `.overrides[$parent][$key]` matches
  # transitively with its own semver rules, and a Yarn resolutions key narrows
  # only through the parent's full resolved locator (`parent@npm:<v>/dep`) —
  # a version-qualified form there parses and then silently never matches
  # (see "An override's key is scoped" in scripts/CLAUDE.md). Neither gets a
  # syntax guessed at here.
  qualified_parent_versions='{}'
  if [ "$loc" = "pnpm.overrides" ] \
    && [ "$(printf '%s' "$parents_json" | jq 'length')" -gt 0 ]; then
    target_major=$(jq -rn --arg range "$range" \
      "$SEMVER_JQ"'($range | range_floor_major) // empty')
    all_versions=$(pnpm_rows | jq -Rs -c '
      split("\n") | map(select(length > 0) | split("\t"))
      | map({name: .[0], ver: .[1]})')
    edges=$(pnpm_edge_rows "$pkg" | jq -Rs -c '
      split("\n") | map(select(length > 0) | split("\t"))
      | map({parent: .[0], pver: .[1], cver: .[2]})')
    qualified_parent_versions=$(jq -nc \
      --argjson vers "$all_versions" --argjson edges "$edges" \
      --argjson parents "$parents_json" --arg target "$target_major" '
      [ $parents[] | . as $p
        | ([ $vers[] | select(.name == $p) | .ver ] | unique) as $pv
        | select(($pv | length) > 1)
        | { key: $p,
            value: ([ $edges[]
                      | select(.parent == $p and .pver != "-")
                      | (.cver | ltrimstr("v") | split(".")[0]) as $m
                      | (if ($m | test("^[0-9]+$")) then $m else null end) as $cm
                      | select($target == "" or $cm == null or $cm == $target)
                      | .pver ] | unique) }
        | select((.value | length) > 0) ]
      | from_entries')
  fi

  set_indent_args
  tmp=$(mktemp)

  # One jq pass produces both the rewritten manifest and the list of entries it
  # wrote, threaded through a `{manifest, written}` state. Computing the report
  # separately would put the key and value the PR body quotes in a second copy
  # of this logic, which is how the result came to say `package`/`range` while
  # an alias key had been written
  # ([#48](https://github.com/SurveyMonkey/skills/issues/48), finding 7).
  if ! written_and_manifest=$(jq -c \
      --arg pkg "$pkg" --arg range "$range" --arg loc "$loc" \
      --argjson root_keys "$root_keys" --argjson keys_by_parent "$keys_by_parent" \
      --argjson parents "$parents_json" --argjson tighten "$tighten_bare" \
      --argjson pverq "$qualified_parent_versions" \
      "$SEMVER_JQ$PINS_JQ"'
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

      def override_path($key):
        if   $loc == "pnpm.overrides" then ["pnpm", "overrides", $key]
        elif $loc == "resolutions"    then ["resolutions", $key]
        else ["overrides", $key] end;

      # An aliased dependency is written under the key the dependent declared
      # it with, carrying the protocol in the value: `overrides.lodash` does not
      # move a copy installed as `lodash-alias`, and a bare range under the
      # alias key names a package no registry has.
      def alias_value: "npm:" + $pkg + "@" + $range;

      # Match how the manifest already expresses versions. A repo that pins
      # exactly (yarn `defaultSemverRangePrefix: ""`, or Dependabot-managed
      # pins) should not acquire a lone range entry, and a caret repo should
      # stay caret. The major bound still holds either way: an exact pin cannot
      # cross a major, and `^` is already major-bounded.
      def spec($cur):
        ($range | sub("^>=[[:space:]]*"; "") | split(" ")[0]) as $lower
        | if   $cur == null               then $range
          elif ($cur | test("^[0-9]"))    then $lower
          elif ($cur | startswith("^"))   then "^" + $lower
          elif ($cur | startswith("~"))   then "~" + $lower
          else $range end;

      # The same, for a declaration that may itself be an `npm:` alias. The
      # protocol and the package it aliases are preserved and only the version
      # part is retargeted; rewriting `npm:lodash@^4.18.0` as a plain range
      # would silently redirect the dependency at a package that does not
      # exist.
      def retarget($existing):
        if ($existing | type) == "string" and ($existing | startswith("npm:"))
        then ($existing[4:]) as $rest
             | ($rest | rindex("@")) as $i
             | (if $i == null or $i == 0 then {name: $rest, cur: null}
                else {name: $rest[0:$i], cur: $rest[$i+1:]} end) as $a
             | "npm:" + $a.name + "@" + spec($a.cur)
        else spec($existing) end;

      # Every write goes through one of these three, so nothing lands in the
      # manifest without landing in `written` with the key and value it used.
      def note($parent; $path; $value):
        .written += [{parent: $parent, path: $path, value: $value}];

      def put_override($parent; $key; $value):
        (.manifest |= set_entry($key; $value))
        | note($parent; override_path($key); $value);

      def put_root($key):
        .manifest as $m
        | if   (($m.dependencies // {}) | has($key)) then
            (retarget($m.dependencies[$key])) as $v
            | (.manifest.dependencies[$key] = $v)
            | note(null; ["dependencies", $key]; $v)
          elif (($m.devDependencies // {}) | has($key)) then
            (retarget($m.devDependencies[$key])) as $v
            | (.manifest.devDependencies[$key] = $v)
            | note(null; ["devDependencies", $key]; $v)
          else
            put_override(null; $key;
                         (if $key == $pkg then $range else alias_value end))
          end;

      # pnpm keys carry the parent version whenever $pverq names versions for
      # the parent — one key per version, so only the copies whose resolution
      # of the child is on the target line are moved and the sibling lines
      # keep their own copies (issue #100). $pverq is {} for npm and yarn:
      # their narrowing syntaxes have different semantics and are not written
      # here (see the comment where $pverq is computed).
      def put_scoped($parent; $key; $value):
        if   $loc == "pnpm.overrides" then
          ($pverq[$parent] // []) as $qv
          | if ($qv | length) > 0 then
              reduce $qv[] as $v (.;
                put_override($parent; $parent + "@" + $v + ">" + $key; $value))
            else
              put_override($parent; $parent + ">" + $key; $value)
            end
        elif $loc == "resolutions" then
          put_override($parent; $parent + "/" + $key; $value)
        else
          (.manifest |= ((.overrides //= {})
                         | .overrides[$parent] =
                             (((.overrides[$parent] // {})
                               | if type == "string" then {} else . end)
                              + {($key): $value})))
          | note($parent; ["overrides", $parent, $key]; $value)
        end;

      # `--tighten-bare` targets a package major line, not just a package. A
      # field manifest can carry several bare keys covering that line at
      # once: the plain `$pkg` key, plus one or more selector-qualified keys
      # (`protobufjs@8`, `protobufjs@^8.0.0`) whose selector floor major
      # equals that of the target range. Writing only one of them leaves the
      # rest competing with the freshly-tightened entry for the same
      # resolution, which is the shape of
      # [#104](https://github.com/SurveyMonkey/skills/issues/104) both times
      # it bit: first a stale qualified key beside a brand new plain key,
      # then a stale duplicate qualified key beside the single key that a
      # `sort | first` happened to pick. So the rule is: tighten EVERY
      # covering key in place (each write through put_override, so every key
      # touched lands in `written[]`), and only when none exists fall through
      # to writing the plain key.
      #
      # "Bare" is per-syntax, the same predicate the observations block above
      # uses. pnpm scopes with `>`: `vite@7>rollup` and
      # `protobufjs@^8.0.0>lodash` pin a DIFFERENT package (the child) under
      # a parent selector, yet `range_floor_major` still reads a floor out of
      # the `selector>child` tail (measured: `7>rollup` reads 0,
      # `^8.0.0>lodash` reads 8), so without the exclusion the pin of the
      # child package was clobbered with the range meant for the parent
      # and reported as a bare write. npm keys are never `>`-scoped (npm
      # nests objects instead), and a `>` there can only sit inside a
      # comparator selector (`pkg@>=8 <9`), so npm keys are all bare;
      # excluding on `>` would wrongly skip that selector shape. yarn scopes
      # with path segments after the (possibly scoped) head
      # (`lodash@^3/minimist`), and its bare keys carry descriptors too
      # (`protobufjs@^8`), which PINS_JQ already reads with strip_selector,
      # so resolutions gets the same qualified-key match under yarn_key
      # bareness rather than an exclusion.
      #
      # `$sel.name == $pkg` guards the startswith match against a key whose
      # last-`@` split names some other package (`protobufjs@8@x` splits to
      # name `protobufjs@8`). A selector no floor can be read from (`@beta`)
      # never matches; with no covering key at all the fall-through still
      # writes the plain key.
      def covering_bare_keys:
        ($range | range_floor_major) as $target_major
        | (if   $loc == "pnpm.overrides" then (.manifest.pnpm.overrides // {})
           elif $loc == "resolutions"    then (.manifest.resolutions // {})
           else (.manifest.overrides // {}) end) as $block
        | [ $block | to_entries[]
            | select((.value | type) == "string")
            | .key
            | select(if   $loc == "pnpm.overrides" then ((test(">")) | not)
                     elif $loc == "resolutions" then
                       ((yarn_key | .parents | length) == 0)
                     else true end)
            | select(. == $pkg
                     or (startswith($pkg + "@")
                         and ((strip_selector) as $sel
                              | ($sel.name == $pkg)
                                and ($target_major != null)
                                and (($sel.selector | range_floor_major)
                                     == $target_major))))
          ] | sort;

      {manifest: ., written: []}
      | if $tighten then
          covering_bare_keys as $covering
          | if ($covering | length) == 0 then put_override(null; $pkg; $range)
            else reduce $covering[] as $k (.; put_override(null; $k; $range))
            end
        elif ($parents | length) == 0 then
          # Direct dependency. The root declares it by name, through one or
          # more alias keys, or (a repo that pins a transitive package it does
          # not depend on) not at all.
          if ($root_keys | length) == 0 then put_override(null; $pkg; $range)
          else reduce $root_keys[] as $k (.; put_root($k)) end
        else
          reduce $parents[] as $parent (.;
            (($keys_by_parent[$parent] // [])
             | if length == 0 then [$pkg] else . end) as $ks
            | reduce $ks[] as $k (.;
                put_scoped($parent; $k;
                           (if $k == $pkg then $range else alias_value end))))
        end' package.json); then
    rm -f "$tmp"
    die "apply_constraint: failed to rewrite package.json"
  fi

  if ! printf '%s' "$written_and_manifest" \
      | jq "${INDENT_ARGS[@]}" '.manifest' > "$tmp"; then
    rm -f "$tmp"
    die "apply_constraint: failed to write package.json"
  fi
  mv "$tmp" package.json

  printf '%s' "$observations" \
    | jq --arg pkg "$pkg" --arg range "$range" --arg loc "$loc" --arg pm "$pm" \
         --arg alias_source "$alias_source" \
         --argjson written "$(printf '%s' "$written_and_manifest" | jq -c '.written')" \
         --argjson unresolved "$parents_unresolved" \
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
        written: $written,
        alias_lookup: {source: $alias_source, parents_unresolved: $unresolved},
        observations: .
      }'
}

# ---------------------------------------------------------------------------
# install / compare_versions / list_pins
# ---------------------------------------------------------------------------
# Every verb that writes runs only inside a linked git worktree, and the set is
# exactly `apply_constraint` (rewrites package.json), `install` (rewrites the
# lockfile and node_modules) and `shim` (creates a directory and an executable,
# and absolutizes a vendored runner from the cwd). Each calls the guard as its
# first statement; a verb that starts writing must be added here and to the list
# in scripts/CLAUDE.md. A mutating verb that runs anywhere else (a cwd mistake
# before worktree setup) silently edits the user's tree, observed live in Phase
# 2 testing. The classification lives in
# common/require-linked-worktree.sh; it already emits the adapter's JSON error
# shape on stderr, so this only has to relay the exit status.
refuse_primary_checkout() {
  "$SCRIPT_DIR/../common/require-linked-worktree.sh" "refusing to run '$VERB' here" || exit 1
}

verb_install() {
  refuse_primary_checkout
  cmd=$(verb_detect | jq -r '.install_cmd')
  printf 'Running: %s\n' "$cmd" >&2
  $cmd
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
# the agent definition: a `for` over a command substitution, which no
# permission rule can pre-approve (so it prompted on every run), which
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
# node_modules at all, and pnpm only links direct dependencies there. Its
# declaration comes from the lockfile instead (see `parent_copy_rows`), and
# only a parent no source could answer for is listed in `parents_unreadable`;
# a parent whose manifest is on disk but will not parse joins them — a damaged
# install, reported rather than substituted for — and is additionally named in
# `parents_malformed`.
#
# `--line <major>` narrows the collection to the parents this fix actually
# moves, mirroring `validate --line`. A package resolved at 5.x, 6.x and 7.x
# concurrently has parents on each of those lines, and a major-bounded fix
# touches exactly one of them: on arsenalamerica/app#300 a 7.28.0 -> 7.29.0
# bump scoped to line 7 was scored "2 major lines crossed" against the 5.x and
# 6.x parents' declarations, because every declaration of the name anywhere in
# the lockfile was collected regardless of which copy the parent resolves to
# ([#76](https://github.com/SurveyMonkey/skills/issues/76)). Those parents are
# a different, untouched consumer: not something the change could regress, and
# distance measured against them is measured from dependents the override does
# not move. They come back in `parents_other_lines[]`, which is deliberately
# none of the four existing lists — a parent excluded by the line is neither
# unreadable nor declaring nothing.
#
# A range is read from an `npm:` alias declaration as well as from a plain one.
# `npm_parents` and `yarn_parents` count an aliasing parent as a parent, so
# looking up the package name verbatim here put it in `parents_without_range` —
# labelled as declaring nothing while it in fact declares `npm:lodash@^4.18.0`,
# a live range that keeps readmitting vulnerable versions with no disclosure in
# the PR body ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
DECLARED_RANGE_JQ=$(cat <<'JQLIB'
def declared_ranges_of($pkg):
  map(to_entries) | add
  | map(select(.value | type == "string"))
  | map(if   .key == $pkg then .value
        elif (.value | startswith("npm:" + $pkg + "@"))
          then (.value | .[(($pkg | length) + 5):])
        else empty end);
JQLIB
)

# The major line a parent's own copy of the package resolves to, printed on
# stdout, or nothing with a non-zero status when it cannot be determined.
#
# Node resolution, read off the installed tree: a parent's nested copy wins,
# and a parent with no nested copy reaches the hoisted one. That is exactly
# what `--line` needs to know and it is the same tree `declared_ranges`
# already reads its manifests out of, so it introduces no new dependency on
# the install being present than the verb already had.
#
# A version that is not `<digits>.<...>` yields nothing rather than a guess.
# Callers treat "undeterminable" as "keep the parent", the direction that can
# only over-report distance.
resolved_major_for_parent() {
  _rmp_parent=$1
  _rmp_pkg=$2
  for _rmp_manifest in \
    "node_modules/$_rmp_parent/node_modules/$_rmp_pkg/package.json" \
    "node_modules/$_rmp_pkg/package.json"; do
    [ -f "$_rmp_manifest" ] || continue
    _rmp_major=$(jq -r '
      (.version // "") | ltrimstr("v") | split(".")[0]
      | if type == "string" and test("^[0-9]+$") then . else empty end
    ' "$_rmp_manifest" 2>/dev/null) || _rmp_major=""
    if [ -n "$_rmp_major" ]; then
      printf '%s' "$_rmp_major"
      return 0
    fi
  done
  return 1
}

# Per-parent-*copy* declarations, read out of the lockfile
#
# `node_modules/<parent>/package.json` answers for one copy of a parent, and a
# parent in the tree at several versions has several — each declaring its own
# range and each resolving its own copy of the package. Asking the installed
# manifest for a multi-version parent therefore attributes one copy's range to
# every line the parent sits on, and asking `resolved_major_for_parent` for its
# line answers about the hoisted copy or about nothing at all. On
# arsenalamerica/app (Yarn Berry, no `node_modules` in the pre-install
# worktree) `declared_ranges --line 5 brace-expansion` returned
# `parents_read: []`, `parents_unreadable: ["minimatch"]` and `ranges: []`,
# while the lockfile plainly recorded minimatch@3.1.5 -> brace-expansion@^1.1.7
# and minimatch@10.2.5 -> brace-expansion@^5.0.5
# ([#85](https://github.com/SurveyMonkey/skills/issues/85)).
#
# The lockfile has all of it per copy, and it is the source scripts/CLAUDE.md
# already names for what a parent declares. These rows carry the parent's own
# resolved version, the range that copy declares, and the version of the
# package *that copy* resolves to — which is what `--line` has to filter on.
#
# npm resolves a declaration by walking `node_modules` upward from the
# declaring path, so the candidate list is that walk against the lockfile's own
# `packages` keys. Berry resolves a descriptor (`<key>@<value>`) through the
# entry whose key list contains it, so the rows are joined against a descriptor
# -> version map built from the same file.
#
# pnpm has no DECLARED range in these rows, for the same reason
# `apply_constraint`'s `alias_lookup` reports `unsupported` for it: its
# `snapshots:` blocks record what a dependency resolved to, never the
# specifier it was declared with. That is still true, and a pnpm parent keeps
# the installed-manifest path for its range. What the snapshots do record —
# per copy of the parent — is the child version that copy resolves, which is
# exactly what `--line` classifies on. So pnpm's rows carry `parent_version`
# and `resolved` with `range: null`: line membership is truthful even when no
# installed manifest exists (the isolated store links only direct
# dependencies into `node_modules`), and the range stays honestly unread
# rather than guessed ([#100](https://github.com/SurveyMonkey/skills/issues/100)).
#
# The parentheses around `.packages // {}` are load-bearing, not style. `as`
# binds its whole right-hand side, so `A // B as $x | body` parses as
# `A // (B as $x | body)`: with a `packages` map present the alternative
# short-circuits and the program returns that map instead of the rows. jq 1.8
# happens to give the intended reading, jq 1.7 (ubuntu-latest, and the floor
# these scripts support) gives the other one, so on Linux every lockfile-read
# parent came back `parents_unreadable` while macOS was green. Bind first,
# always: every other `//`-defaulted binding in these scripts is parenthesized.
NPM_COPY_ROWS_JQ=$(cat <<'JQLIB'
def prefixes:
  if . == "" then [""]
  else [.] + ((sub("/?node_modules/[^/]+$"; "")) | prefixes) end;
def candidates($dk):
  prefixes | map((if . == "" then "" else . + "/" end) + "node_modules/" + $dk);
(.packages // {}) as $pkgs
| [ $pkgs | to_entries[]
    | .key as $path
    | .value as $v
    | (if $path == "" then "__root__"
       else ($path | split("node_modules/") | last) end) as $parent
    | ([ ($v.dependencies         // {}),
         ($v.optionalDependencies // {}),
         ($v.peerDependencies     // {}) ] | add // {})
    | to_entries[]
    | select(.value | type == "string")
    | select(.key == $pkg or (.value | startswith("npm:" + $pkg + "@")))
    | .key as $dk
    | { parent: $parent,
        parent_version: ($v.version // null),
        range: (if $dk == $pkg then .value
                else (.value | .[(($pkg | length) + 5):]) end),
        resolved: ([ $path | candidates($dk)[] as $c
                     | select($pkgs | has($c)) | $pkgs[$c].version // empty ]
                   | first // null) } ]
JQLIB
)

npm_copy_rows() {
  jq -c --arg pkg "$1" "$NPM_COPY_ROWS_JQ" package-lock.json
}

# Berry's rows, plus the descriptor -> version map its resolution needs.
#
# `D` rows are one per descriptor in an entry's key list; `P` rows are one per
# declaration in a `dependencies:`, `peerDependencies:` or
# `optionalDependencies:` block, carrying the declaring entry's own name and
# version. Workspace entries are dropped exactly as `yarn_declaration_rows`
# drops them.
#
# The double-quote character comes from `sprintf` for the bash 3.2 reason
# `YARN_DECLARATION_AWK` documents: an unpaired `"` in a heredoc body cuts the
# command substitution short.
YARN_COPY_AWK=$(cat <<'AWKLIB'
    BEGIN { q = sprintf("%c", 34) }
    /^[^[:space:]#]/ {
      ndesc = 0; cur = ""; ver = ""; indeps = 0
      keyline = $0
      if (substr(keyline, length(keyline), 1) == ":") {
        keys = substr(keyline, 1, length(keyline) - 1)
        gsub(q, "", keys)
        ndesc = split(keys, desc, ", ")
      }
      next
    }
    /^  version: / {
      ver = substr($0, 12)
      gsub(q, "", ver)
      sub(/^[[:space:]]+/, "", ver)
      sub(/[[:space:]]+$/, "", ver)
      for (i = 1; i <= ndesc; i++) printf "D\t%s\t%s\n", desc[i], ver
      next
    }
    /resolution: / {
      i = index($0, "resolution: ")
      rest = substr($0, i + 13)
      j = index(rest, q)
      res = substr(rest, 1, j - 1)
      if (index(res, "@workspace:") > 0) { cur = ""; next }
      at = 0
      for (k = length(res); k > 1; k--) {
        if (substr(res, k, 1) == "@") { at = k; break }
      }
      cur = (at > 1) ? substr(res, 1, at - 1) : res
      next
    }
    /^  (dependencies|peerDependencies|optionalDependencies):/ { indeps = 1; next }
    /^  [a-zA-Z]/ { indeps = 0 }
    indeps && /^    / {
      dep = $0
      sub(/^    /, "", dep)
      c = index(dep, ":")
      if (c == 0) next
      name = substr(dep, 1, c - 1)
      val  = substr(dep, c + 1)
      gsub(q, "", name)
      sub(/^[[:space:]]+/, "", val)
      sub(/[[:space:]]+$/, "", val)
      gsub(q, "", val)
      if (cur != "") printf "P\t%s\t%s\t%s\t%s\n", cur, ver, name, val
    }
AWKLIB
)

YARN_COPY_ROWS_JQ=$(cat <<'JQLIB'
split("\n") | map(select(length > 0) | split("\t")) as $rows
| ([ $rows[] | select(.[0] == "D") | {key: .[1], value: .[2]} ] | from_entries) as $dmap
| [ $rows[]
    | select(.[0] == "P")
    | {parent: .[1], parent_version: .[2], key: .[3], value: .[4]}
    | select(.key == $pkg or (.value | startswith("npm:" + $pkg + "@")))
    | {parent: .parent,
       parent_version: .parent_version,
       range: (if .key == $pkg then (.value | ltrimstr("npm:"))
               else (.value | .[(($pkg | length) + 5):]) end),
       resolved: ($dmap[.key + "@" + .value] // null)} ]
JQLIB
)

yarn_copy_rows() {
  awk "$YARN_COPY_AWK" yarn.lock | jq -Rs -c --arg pkg "$1" "$YARN_COPY_ROWS_JQ"
}

pnpm_copy_rows() {
  pnpm_edge_rows "$1" | jq -Rs -c '
    split("\n") | map(select(length > 0) | split("\t"))
    | map({parent: .[0],
           parent_version: (if .[1] == "-" then null else .[1] end),
           range: null,
           resolved: (if .[2] == "-" or (.[2] | test("^[0-9]") | not)
                      then null else .[2] end)})'
}

parent_copy_rows() {
  case "$1" in
    npm)  npm_copy_rows "$2"  ;;
    yarn) yarn_copy_rows "$2" ;;
    pnpm) pnpm_copy_rows "$2" ;;
    *)    printf '[]'         ;;
  esac
}

verb_declared_ranges() {
  line=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --line)
        line="${2:?--line requires a major}"
        shift 2
        ;;
      --) shift; break ;;
      -*) die "declared_ranges: unknown option '$1'" ;;
      *)  break ;;
    esac
  done

  pkg="${1:?declared_ranges requires a package name}"

  case "$line" in
    ''|*[!0-9]*)
      [ -z "$line" ] || die "declared_ranges: --line must be a major number, got '$line'"
      ;;
  esac

  pm=$(pm_of)
  case "$pm" in
    npm)  parents=$(npm_parents "$pkg")  ;;
    pnpm) parents=$(pnpm_parents "$pkg") ;;
    yarn) parents=$(yarn_parents "$pkg") ;;
    *)    die "declared_ranges: unsupported pm '$pm'" ;;
  esac

  # A direct dependency's own declaration in the root manifest counts: the
  # repository is a dependent like any other.
  root_range=$(jq -r --arg pkg "$pkg" "$DECLARED_RANGE_JQ"'
    [ (.dependencies // {}), (.optionalDependencies // {}),
      (.peerDependencies // {}), (.devDependencies // {}) ]
    | declared_ranges_of($pkg) | first // empty' package.json)

  ranges=""
  read_parents=""
  no_range=""
  unreadable=""
  malformed=""
  other_lines=""

  # The root is a dependent like any other, so `--line` filters it on the same
  # rule: it has no nested copy of its own, and reaches the hoisted one.
  if [ -n "$root_range" ] && [ -n "$line" ] \
    && root_major=$(resolved_major_for_parent __root__ "$pkg") \
    && [ "$root_major" != "$line" ]; then
    other_lines="__root__
"
    root_range=""
  fi

  copy_rows=$(parent_copy_rows "$pm" "$pkg")
  tab=$(printf '\t')

  while IFS= read -r parent; do
    [ -n "$parent" ] || continue
    [ "$parent" != "__root__" ] || continue

    # A parent the installed tree cannot answer for goes to the lockfile rows,
    # which carry one declaration per copy of the parent. Two cases reach here:
    # the parent is in the tree at several versions, where a single installed
    # manifest describes at most one of them and attributing its range to every
    # line is the defect; and the parent has no installed manifest at all,
    # where the range was simply lost — the pre-install worktree a fix runs in,
    # Yarn PnP, and every pnpm parent that is not a direct dependency
    # ([#85](https://github.com/SurveyMonkey/skills/issues/85)).
    #
    # A manifest that is on disk stays the answer for a single-copy parent: it
    # is the state actually installed, version skew against the lockfile is
    # real, and a manifest on disk that will not parse is a damaged install
    # that must keep saying so rather than being papered over.
    parent_rows=$(printf '%s' "$copy_rows" | jq -c --arg p "$parent" '[ .[] | select(.parent == $p) ]')
    copy_count=$(printf '%s' "$parent_rows" | jq '[ .[].parent_version ] | unique | length')
    if [ "$copy_count" -gt 1 ] \
      || { [ "$copy_count" -ge 1 ] && [ ! -f "node_modules/$parent/package.json" ]; }; then
      row_read=""
      row_unread=""
      while IFS="$tab" read -r copy_version copy_range copy_major; do
        [ -n "$copy_version$copy_range$copy_major" ] || continue
        if [ -n "$line" ] && [ -n "$copy_major" ] && [ "$copy_major" != "$line" ]; then
          # Named with the parent's own version: a parent on two lines appears
          # in `parents_read` and here, and only the version says which copy is
          # which.
          if [ "$copy_version" = "-" ]; then
            other_lines="$other_lines$parent
"
          else
            other_lines="$other_lines$parent@$copy_version
"
          fi
          continue
        fi
        if [ -n "$copy_range" ] && [ "$copy_range" != "-" ]; then
          ranges="$ranges$copy_range
"
          row_read=y
        else
          # A row with no declared specifier is pnpm's: its snapshots record
          # what resolved, never what was declared, so the copy's line above
          # is truthful while its range is still a range nobody could read.
          # The parent stays `parents_unreadable` rather than joining
          # `parents_without_range`, which claims a read that never happened
          # ([#100](https://github.com/SurveyMonkey/skills/issues/100)).
          # npm and yarn rows always carry the declared specifier, so only
          # pnpm reaches this branch.
          row_unread=y
        fi
      done <<EOF
$(printf '%s' "$parent_rows" | jq -r '
        .[] | [ (.parent_version // "-"),
                (.range // "-"),
                ((.resolved // "") | ltrimstr("v") | split(".")[0]
                 | if type == "string" and test("^[0-9]+$") then . else "" end) ]
        | @tsv')
EOF
      if [ -n "$row_read" ]; then
        read_parents="$read_parents$parent
"
      elif [ -n "$row_unread" ]; then
        unreadable="$unreadable$parent
"
      fi
      continue
    fi

    # The line filter comes first, and files the parent in none of the four
    # existing lists. A parent whose own copy sits on another major line was
    # not read-and-declaring-nothing and was not unreadable; it is simply not
    # a dependent this fix moves, and saying so under its own field keeps
    # `parents_read` / `parents_without_range` / `parents_unreadable` honest
    # ([#76](https://github.com/SurveyMonkey/skills/issues/76)).
    #
    # An undeterminable line keeps the parent, because the alternative is
    # dropping a range on a guess: over-reporting distance is the recoverable
    # direction, and every dropped range lowers a risk score silently.
    #
    # pnpm answers from its lockfile rows even here, where a manifest is on
    # disk: the isolated store never nests the child under
    # `node_modules/<parent>/`, so `resolved_major_for_parent`'s first probe
    # always misses and its hoisted fallback describes the ROOT's copy, not
    # this parent's. On the field run that attributed another parent's range
    # to the queried line while the real on-line parent sat in
    # `parents_unreadable` ([#100](https://github.com/SurveyMonkey/skills/issues/100)).
    if [ -n "$line" ]; then
      if [ "$pm" = "pnpm" ]; then
        parent_major=$(printf '%s' "$parent_rows" | jq -r '
          (first // {}) | ((.resolved // "") | ltrimstr("v") | split(".")[0]
          | if type == "string" and test("^[0-9]+$") then . else empty end)')
      else
        parent_major=$(resolved_major_for_parent "$parent" "$pkg") \
          || parent_major=""
      fi
      if [ -n "$parent_major" ] && [ "$parent_major" != "$line" ]; then
        other_lines="$other_lines$parent
"
        continue
      fi
    fi
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
    if found=$(jq -r --arg pkg "$pkg" "$DECLARED_RANGE_JQ"'
        [ (.dependencies // {}), (.optionalDependencies // {}),
          (.peerDependencies // {}) ]
        | declared_ranges_of($pkg) | .[]' "$manifest" 2>/dev/null); then
      read_parents="$read_parents$parent
"
      if [ -z "$found" ]; then
        # Read, and declaring the package in no block under either of its
        # names. Version skew produces this legitimately: the lockfile records
        # a parent that declared the package in a release the installed
        # manifest does not. Named rather than counted, so "read and declared
        # nothing" is not mistaken for "not read" — but it is a claim about the
        # parent, so it must not be reached by looking the package up under one
        # name when the parent declares it under another. That is why the
        # lookup above is alias-aware; without it this comment rationalized a
        # mislabel to the reading agent
        # ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
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
    --arg pkg "$pkg" --arg pm "$pm" --arg root "$root_range" --arg line "$line" \
    --argjson read_parents "$(printf '%s' "$read_parents" | jq -Rs 'split("\n") | map(select(length > 0))')" \
    --argjson no_range "$(printf '%s' "$no_range" | jq -Rs 'split("\n") | map(select(length > 0))')" \
    --argjson unreadable "$(printf '%s' "$unreadable" | jq -Rs 'split("\n") | map(select(length > 0))')" \
    --argjson malformed "$(printf '%s' "$malformed" | jq -Rs 'split("\n") | map(select(length > 0))')" \
    --argjson other_lines "$(printf '%s' "$other_lines" | jq -Rs 'split("\n") | map(select(length > 0))')" '
    {
      pm: $pm,
      package: $pkg,
      line: (if $line == "" then null else ($line | tonumber) end),
      ranges: (split("\n") | map(select(length > 0)) | unique),
      root_range: (if $root == "" then null else $root end),
      parents_read: $read_parents,
      parents_without_range: $no_range,
      parents_unreadable: $unreadable,
      parents_malformed: $malformed,
      parents_other_lines: $other_lines
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
  compare_versions)      verb_compare_versions "$@" ;;
  range_facts)           verb_range_facts "$@" ;;
  declared_ranges)       verb_declared_ranges "$@" ;;
  shim)                  verb_shim "$@" ;;
  list_pins)             verb_list_pins ;;
  *) die "Unknown verb '$VERB'" ;;
esac
