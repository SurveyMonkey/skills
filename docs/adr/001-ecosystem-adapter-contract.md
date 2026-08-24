---
type: ADR
description: 'Invocation, exit-code, and JSON-output contract for the per-ecosystem adapter scripts: the empty-result and range-semantics obligations, pin listing, the whole-tree resolution map with self-reported parse coverage, and alias identity across verbs.'
status: stable
created: 2026-07-26
owner: brianespinosa
related_issues: [4, 7]
---

# ADR 001: Ecosystem adapter contract

Drives [RFC 001](../rfc/001-alert-orchestration.md). Landed in Phase 1
([#4](https://github.com/SurveyMonkey/skills/issues/4)).

## Context

RFC 001 moves the deterministic surface of `gh-security` out of command prose and into scripts,
and isolates ecosystem-specific behavior behind an adapter so `npm` and `pip` alerts can share one
orchestrator. The RFC names the verbs (`detect`, `why`, `apply_constraint`, `install`, `validate`,
`list_pins`, `compare_versions`) but not how adapters are invoked, what they return, or how
failure is signalled. Phases 2 through 6 all build against this, so the operational details need
settling before the second adapter exists rather than after.

The RFC's list also carried `verification_commands`, which enumerated a repository's own check
scripts for an agent to run. It is retired: agents no longer run a repository's checks at all, so
no adapter implements it and no new one has to
([ADR 006](006-merge-risk-is-static-analysis.md)).

Two things pushed specific decisions here.

**A latent bug in v0.1.0.** The shipped yarn lockfile validation was:

```bash
grep -A1 "^\"?<package>@" yarn.lock | grep version | sort -u
```

Without `-E` the `?` is a literal character, so the pattern can never match. Against a real Yarn
Berry lockfile it returns zero lines while the package plainly exists, and zero matches were read
as "validated." Every yarn repository this plugin touched received a validation claim backed by
nothing. Any contract that lets "found nothing" mean "all clear" can reproduce this.

**Version comparison is not portable across ecosystems.** semver and PEP 440 disagree about
prerelease ordering, and PEP 440 additionally has epochs and post-releases. A shared comparator
would have to be wrong for one of them.

## Decision

**Invocation.** Adapters are executables at `scripts/ecosystems/<name>.sh`, invoked as
`<adapter> <verb> [args]`, run from the root of the tree being operated on. For the verbs that
write (`apply_constraint`, `install`, `shim`) that root must be a **linked git worktree**, never
the user's own checkout: each of them refuses to run there, through the shared guard in
`common/require-linked-worktree.sh`. JSON on stdout, human-readable detail on stderr.
`select-adapter.sh` resolves ecosystem to adapter path; nothing else hardcodes it.

**Exit codes** distinguish four outcomes, because callers respond differently to each:

| Code | Meaning | Caller response |
|---|---|---|
| 0 | Success | Continue |
| 1 | Error | Report and stop |
| 2 | Verb not implemented | Feature not built yet; not a failure |
| 3 | Unsupported toolchain | Report and stop; this is a configuration fact, not a bug |

Code 3 exists so bun and Yarn Classic are *reported* rather than crashing, matching how the RFC
treats unsupported ecosystems. Its payload carries `unsupported` and points at
`.github/CONTRIBUTING.md`.

**Empty results are never implicitly successful.** `resolved_versions` returns `present` and
`lockfile_entries` alongside `versions`. If the lockfile parses to zero entries at all, the
adapter exits 1 rather than returning an empty list: that means the parser failed, not that the
repository has no dependencies. A package genuinely absent from a populated lockfile returns
`present: false` with a non-zero `lockfile_entries`. This is the direct countermeasure to the
v0.1.0 bug.

**`resolved_versions` is a verb, and `validate` composes on it.** The RFC lists only `validate`.
Splitting them serves two callers: the merge-risk baseline needs to enumerate versions *before*
any constraint exists to check against, and `validate` needs the same enumeration plus a
predicate. One parser, two consumers.

**`resolution_map` answers the whole-tree question `resolved_versions` cannot.** It returns
`{pm, lockfile_entries, entries_read, entries_expected, unreadable_entries, package_count,
resolutions}`, where `resolutions` maps every package in the lockfile to its unique, lexically
sorted version list. The pin audit needs it because an override
reaches past the package it names: lifting one changes dedup and hoisting and can let a peer
conflict resolve differently, so a removal can move a package the pin never mentioned. Diffing one
package before and after a removal is blind to that, and the resulting `removable` verdict is right
about its own package and silent about the tree
([#42](https://github.com/SurveyMonkey/skills/issues/42)). A separate verb rather than a widened
`resolved_versions`: the two answer different questions, and the per-path detail one caller needs is
not what a diff wants. What does **not** travel with that separation is the identity rule below: both
verbs answer "what version of X is in the tree", so a change to what counts as X lands in both, even
when it shifts `validate` ([#46](https://github.com/SurveyMonkey/skills/issues/46)). The empty-parse
rule above applies unchanged, and for a sharper reason — a diff against an empty map reports every
package unchanged, which is the wrong-safe answer by yet another route. Versions are sorted for
comparability, not ranked; callers that need semver order still ask `compare_versions`.

**A package is keyed by what it resolves to, not by where it sits — in both verbs.** Workspace
links, `portal:` and `exec:` targets, git targets and URL targets are excluded, because "what
version of X is in the tree" has no registry answer for local or generated code. A `patch:` entry
is *not* in that set: it wraps a published release, so it is included at the version its innermost
locator names, unwrapped one nesting level at a time — a patch of an already-patched package escapes
its inner locator twice, and a single decode left it looking like neither protocol. A patch wrapping
a workspace or portal target stays excluded on the same rule, and a locator whose version cannot be
read is **not** quietly dropped: it counts against the parse guard. An `npm:` alias is included under
the package it aliases rather than the key it installs as, in npm and Berry alike. Each of these was
previously dropped or mislabeled — a patched package vanished from the map at a real registry
version, an alias was reported under a name no registry has, and a version carrying Berry's `::`
binding parameters ranked below the clean release it named
([#44](https://github.com/SurveyMonkey/skills/issues/44),
[#46](https://github.com/SurveyMonkey/skills/issues/46)).

The two verbs must agree about any package, since the pin audit treats a disagreement as a parser
bug and refuses the pin. Their **shapes** differ by design, though — `resolved_versions` reports
one `{version, path}` per resolution, the map reports each package's versions once — so a caller
comparing them normalizes first: `[.versions[].version] | unique` against the map's list.

**One documented exception, and only one: an alias key.** `resolved_versions` answers under the key a
package is installed as *as well as* under the package it resolves to, because the install key is
what an override entry names and what `list_pins` therefore hands the audit; answering `present:
false` there reads as "the package left the tree" and recommends deleting the pin. The map keeps the
single canonical name, because its consumer is an advisory query that an alias key answers
`no-advisories`. So for an alias key alone, the map legitimately holds no entry while
`resolved_versions` reports one, and `agents/audit-pins.md` reports that pin `inconclusive` naming
the alias rather than reading it as a parser bug.

**That exception carries a limit, and the limit is documented rather than fixed.** Answering under
both names means a real package whose name equals another entry's install key — a repository
installing `underscore` under the key `lodash` while a dependency pulls the real `lodash` — has its
versions merged into one `resolved_versions` answer, in npm and Berry alike. Disambiguating by path
or locator would require the caller to say which sense of the name it meant, and the caller cannot:
an override key `lodash` is exactly as ambiguous as the lockfile is. On the **read** path the merge
is fail-safe in direction — it over-reports toward `inconclusive` and `still-required`, never toward
`removable` — so it is stated here and acted on in the audit rather than guessed at. It presents as
**two non-empty lists that disagree**, distinct from the alias-key case's `[]` against non-empty,
and `agents/audit-pins.md` names both shapes so neither is read as a parser bug
([#48](https://github.com/SurveyMonkey/skills/issues/48)).

**On the write path the same ambiguity is not fail-safe, and that is the direction that ships an
edit.** `apply_constraint lodash '>=4.17.21 <5'` against that repository finds the root's colliding
declaration `"lodash": "npm:underscore@^1.13.6"` and retargets it in place, because retargeting an
`npm:` declaration deliberately preserves the protocol and the package it aliases and rewrites only
the version. The result is `"npm:underscore@^4.17.21"` — a version of `underscore` that does not
exist, so the install breaks — while the real `lodash` copy the caller meant goes unmoved. Nothing
in the adapter can tell the two senses apart here either, so the report is what catches it:
`written[]` states the key and value actually written, and `agents/fix-dependency.md` **rejects any
written value whose `npm:` protocol names a package other than the one passed**, failing the run
with the entry quoted rather than opening a PR on it
([#49](https://github.com/SurveyMonkey/skills/issues/49)).

**The parse guard counts what the parser could read, not what it kept.** A repository whose
dependencies are all workspaces and portals resolves to no registry version at all, so an empty map
is a real answer there; a lockfile the parser understood none of produces the same empty map, and a
diff against it reports every package unchanged. Adapters therefore distinguish "read it and
excluded it" from "could not read it", and refuse a lockfile whose recognized share has collapsed —
which also catches the partial parse a zero-check cannot see
([#46](https://github.com/SurveyMonkey/skills/issues/46)). Every ecosystem's parser owes all three
answers: an npm workspace link (`link: true`, no `version`) and a pnpm `link:`, `file:` or git
entry are read and deliberately excluded, exactly as Berry's `workspace:` and `portal:` locators
are, and counting either as unread hard-failed ordinary monorepos with a "the parser is broken"
diagnosis ([#48](https://github.com/SurveyMonkey/skills/issues/48)).

**A guard that only refuses is not enough: the map states its own coverage.** The guard is a ratio,
so a *single* unreadable locator passes it and its package silently leaves the map — absent from a
baseline snapshot and from a post-removal one alike, which a whole-tree diff reads as "unchanged".
`resolution_map` therefore carries `entries_read`, `entries_expected` and `unreadable_entries`, and
`agents/audit-pins.md` requires `collateral_changes: null` with `collateral_verdict: not-checked`
whenever the last is non-zero. Without it an unaudited package became an affirmatively clean one,
because `[]` is documented as the stronger claim than `null`
([#48](https://github.com/SurveyMonkey/skills/issues/48)).

**Adapters parse lockfiles rather than querying the package manager.** `npm ls --json` and
`yarn info --json` are available and would be less code, but the lockfile is the artifact the PR
commits, and parsing it works before any install has run, which the pre-fix baseline requires.

**Version comparison stays inside the adapter.** `compare_versions` is a verb, not a shared helper
in `common/`. The node adapter implements semver in jq; Phase 6's Python adapter will implement
PEP 440 behind the same verb. Callers that need to rank versions, including
`discover-alerts.sh`, route through the adapter rather than sorting themselves.

**Range semantics stay inside the adapter too.** `range_facts <range> <version>` reports whether a
dependent's declared range still admits the version, how many major lines past the range's floor
it sits, and whether the range was a pin rather than a caret. Added in Phase 2 for the merge-risk
scorer ([#21](https://github.com/SurveyMonkey/skills/issues/21)), for the same reason as
`compare_versions`: what `^9` or `~6.14.0` admits is a semver answer, and the Python adapter's is
different. The scorer asks; it does not parse.

**A range the adapter cannot read is a third answer, not a false one.** `range_facts` leads with
`parseable`, and answers `satisfied`, `pinned`, `floor_major` and `majors_ahead` as null when it is
false. Manifests declare things that are not version ranges at all (`workspace:^`, `latest`, a git
URL), and reporting those as "this version is not admitted" fabricated a dependent the fix had
left behind. Every key is always present, whatever the answer, because a caller distinguishing "no
floor" from "field missing" cannot do it against a field that is sometimes absent: absence means
the adapter does not implement this side of the contract, and `score-merge-risk.sh` treats it as a
hard error rather than scoring the fix low on a fact nobody supplied. `major_distance` on
`compare_versions` carries the same obligation, and so does the *type*: a numeric field arriving as
`"lots"` is present, passes `has()`, and then fails its integer test on stderr only, which is the
same silent zero by another route. The obligation starts one step earlier still: an adapter that
exits 0 with empty stdout answers nothing, and jq reading empty input emits nothing rather than
failing, so every `has()` check downstream is skipped instead of tripped. A reply is asserted to be
a JSON object before any field of it is read.

**`apply_constraint` reads every declaration it needs out of the lockfile, and reports what it
wrote.** It runs *before* `install`, in a fresh worktree where `node_modules` is gitignored and
absent — and Yarn PnP never has one at all, while pnpm links only direct dependencies into one — so
the key a parent declares an aliased dependency under comes from the lockfile
(`.packages["node_modules/<parent>"]` for npm, each `resolution:` entry for Berry, reading
`dependencies`, `optionalDependencies` and `peerDependencies` in both), never from a parent's
installed manifest. A parent whose declaration
the adapter cannot locate is named in `alias_lookup.parents_unresolved`, never skipped: the whole
failure of the manifest-based lookup was that it skipped silently and wrote the plain package name,
which does not govern the aliased copy. The result also carries `written[]`, one
`{parent, path, value}` per entry the call actually created, produced by the same pass that writes
them — the report used to state `package` and `range` whatever it had written, so a PR body quoting
it described an edit that was not made ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
pnpm is the one gap and it is reported rather than guessed at: its `snapshots:` blocks record what
a dependency resolved to, not the key and specifier it was declared with, so `alias_lookup.source`
is `unsupported` there and every parent is listed unresolved. **`source` is what the list means, so
a caller reads both.** `unsupported` names an ecosystem limit and nothing about this repository;
keying the "an aliased copy may not have moved" warning on a non-empty list alone raises it on every
pnpm scoped fix, which trains the reading agent to discount the one case — `source: "lockfile"` with
parents still unresolved — where it is a real finding
([#49](https://github.com/SurveyMonkey/skills/issues/49)).

**`declared_ranges [--line <major>] <pkg>` collects what the dependents declare.** It returns the union of
`dependencies`, `optionalDependencies` and `peerDependencies` ranges across the package's parents,
plus the root manifest's own declaration, which is read from those three and `devDependencies` too:
the repository is a dependent like any other, and a dev-only direct dependency still declares a
range a fix can leave behind. Parent discovery covers the same three blocks in npm lockfile v3, whose
entries record each of them under their own key; a parent that declares the package only optionally
or as a peer still resolves it. The Yarn Berry parser covers the same three blocks under each
`resolution:` entry, which it did not until
[#49](https://github.com/SurveyMonkey/skills/issues/49): matching `dependencies:` alone left a
peer-declared Berry parent invisible to `why` and unreachable by `apply_constraint`, contradicting
this paragraph one block over from where
[#47](https://github.com/SurveyMonkey/skills/issues/47) had just been fixed. **pnpm remains the
exception**: its `snapshots:` blocks record what each dependency resolved to rather than the block
it was declared in, so an optional-only or peer-only pnpm parent is still missed and a range it
declares reaches F7 only if the agent reads it by hand. Widening that parser is open work, not a
documented guarantee. Alongside the ranges: `parents_read[]`, `parents_without_range[]`
(read, but declaring the package in no block, which version skew produces legitimately),
`parents_unreadable[]`, and `parents_malformed[]`, the subset of unreadable whose manifest is on
disk but does not parse, kept inside `parents_unreadable` so every consumer of that list stays
correct while the corrupt case remains distinguishable from the merely uninstalled one. A range is
read from an `npm:` alias declaration as well as from a plain one, because parent discovery counts
an aliasing parent as a parent: looking the package up under its own name alone filed that parent
under `parents_without_range`, which reads as "declared nothing" for a parent that in fact declares
a live range ([#48](https://github.com/SurveyMonkey/skills/issues/48)). The verb
belongs behind the contract because finding a parent's manifest is an ecosystem question
(`node_modules/<parent>/package.json` here, `site-packages` metadata for Python), and because the
shell loop it replaced in the agent definition could not be pre-approved by the preflight catalog
(removed in v0.8.2, [#86](https://github.com/SurveyMonkey/skills/issues/86); the loop's command
substitution cannot be pre-approved by any permission rule either), discarded every per-parent
error, and missed optional dependencies. A parent whose manifest is not
installed is reported, never guessed at: Yarn PnP has no `node_modules`, and pnpm links only direct
dependencies into one.

**`--line <major>` scopes the collection to the parents a line-bounded fix moves**, mirroring
`validate --line`. A package resolved at several majors at once has parents on each of them, and a
major-bounded override touches exactly one line; collecting every declaration of the name regardless
of which copy the parent resolves to measured F7's distance against dependents the fix leaves
untouched, scoring a 7.28.0 -> 7.29.0 bump as two major lines crossed plus a crossed 5.x pin
([#76](https://github.com/SurveyMonkey/skills/issues/76)). Which line a parent's own copy sits on is
an ecosystem question like finding its manifest is, which is why the filter belongs behind the
contract: here it is node resolution over the installed tree, a parent's nested copy before the
hoisted one. Excluded parents are returned in `parents_other_lines[]`, deliberately none of the four
lists above, since such a parent is neither unreadable nor declaring nothing. A parent whose
resolved copy cannot be determined is kept, because over-reporting distance is recoverable and a
silently dropped range is not. The flag is optional and omitting it is the pre-existing behavior;
`line` echoes back what was applied, `null` when nothing was.

**~~`list_pins` is reserved but unimplemented.~~** ~~It is part of the contract and returns exit
code 2 until Phase 4 ([#7](https://github.com/SurveyMonkey/skills/issues/7)), whose pin audit is
its only consumer.~~ **Implemented in Phase 4** alongside that consumer. It returns
`{pm, override_location, block_present, count, bare_count, pins[]}`, one entry per constraint the
manifest declares, each carrying `key`, `path`, `package`, `selector`, `parents`, `scope`
(`bare` or `scoped`), `value`, `kind`, `range`, and the alias fields.

Two parts of that shape are contract, not convenience, because each is a wrong reading the audit
would otherwise make:

- **Keys are parsed, not split.** Every scoping syntax collides with something: pnpm's `>` with
  version selectors (`handlebars@4`), yarn's `/` with scoped package names (`@babel/core` is one
  name; `@vercel/fun/undici` is a parent and a dependency), npm's nesting with its `"."` key,
  which names the parent itself and so is a bare pin wearing a nested shape.
- **`kind` says what the value is**, and only `range` is a version pin. A resolution may redirect
  to a **different package** (`"@next/env": "npm:@varlock/nextjs-integration@1.1.6"` → `alias`),
  point at a patch or a local path (`protocol`), or defer to a declared dependency
  (`"$lodash"` → `reference`). Reading any of those as a range has the audit reasoning about the
  version of a pin that was never about a version, and reporting the wrong package. `range` is
  never inferred: it is what the adapter's own range parser accepts, the same one behind
  `range_facts`. The version in an `npm:` value is optional, so `npm:esbuild-wasm` and
  `npm:@babel/core` are aliases with a null `alias_range`, not ranges whose text happens to be a
  package name.

An empty override block is `count: 0` and exit 0, which does **not** contradict the empty-result
rule above: this verb reads structured JSON, where absence is a fact, rather than a lockfile,
where zero parsed entries means the parser failed. A block that is **present but not an object**
is the third state and exits 1: coercing it to `{}` produced a `count: 0` byte-identical to the
legitimately empty case, and the audit stops on `count: 0`, so a corrupted manifest audited clean
— "found nothing" meaning "all clear" by another route.

**Dependencies are `bash`, `jq`, and `gh`.** No `node`, no `npx`. Node has no built-in semver, so
using it would mean `npx semver` and a cold-cache network fetch in the middle of a security fix.
Scripts target bash 3.2, the macOS default.

## Consequences

Phases 2 through 6 write agent prompts against verbs rather than package-manager specifics, and
Phase 6 adds Python without touching the orchestrator or the subagents. That is the payoff, and
it is also the bet: if the verb set is wrong, every phase pays for it.

The four exit codes mean callers must check more than zero-or-not. Treating 2 and 3 as generic
failures produces misleading output ("error" when the honest answer is "not built yet" or "not
supported"), so the command prose spells out the response to each.

Lockfile parsing is per-format work: three parsers in the node adapter alone (npm's JSON,
pnpm v9's YAML, Yarn Berry v8's YAML), and a new lockfile format is a code change rather than a
new flag. Accepted deliberately in exchange for working before install and validating the
committed artifact.

`compare_versions` will be implemented more than once across adapters. That duplication is the
point: a single implementation could not be correct for both semver and PEP 440.

The contract is covered by fixture-driven shellspec suites in `spec/`, enforced on every PR and
push by the quality gates ([ADR 005](005-quality-gate-venues.md)), and verified against real
repositories, which the fixtures deliberately do not replace. The bug this ADR is partly a
reaction to is exactly the kind a fixture test catches on day one and a real-repo run can miss
for months.
