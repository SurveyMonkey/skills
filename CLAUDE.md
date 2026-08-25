# SurveyMonkey Skills

Claude Code plugin marketplace. Installation and plugin overview: [README.md](README.md);
structure: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Script conventions: [plugins/gh-security/scripts/CLAUDE.md](plugins/gh-security/scripts/CLAUDE.md).

## Releasing a plugin

**A plugin's version lives in its own `plugin.json` and nowhere else.** Bumping it is the entire
release: Claude Code resolves the version from `plugin.json` first, and users only receive updates
when that string changes.

`.claude-plugin/marketplace.json` carries **no version at all**, in either place it accepts one:

- Not in a `plugins[]` entry. Claude Code prefers the `plugin.json` value **without warning**, so a
  version in both places lets a forgotten `plugin.json` bump silently ship nothing.
- Not as a top-level `version` (nor the back-compat `metadata.version`). That field is the
  *catalog's* own version and never affects plugin resolution, so its only real effect is sitting
  next to a plugin version that legitimately differs and inviting the question of which one is
  authoritative.

Validate both manifests before shipping:

```bash
claude plugin validate .claude-plugin/marketplace.json --strict
claude plugin validate plugins/<name> --strict
```

No git tags and no GitHub releases. Plugins are installed from the default branch and refreshed
with `/plugin marketplace update`. Tags would also be ambiguous once this marketplace carries
several plugins at independent versions.

## Testing

Bash scripts are covered by [shellspec](https://shellspec.info): `brew install shellspec`, then
`shellspec` from the repo root. Specs live in `spec/`, config in `.shellspec`.

All three quality gates (suite, ShellCheck, `claude plugin validate --strict`) run through one
entry point, `scripts/check.sh` (`lint` / `validate` / `spec` / `fast` / `all` / `targets`);
target lists live there and nowhere else, and empty discovery is a hard failure in every gate.
Committed git
hooks run the fast gates on commit and the suite on push, enabled once per clone with
`git config core.hooksPath .githooks`; CI runs all three (`.github/workflows/gates.yml`).
Venue decisions and pins: [ADR 005](docs/adr/005-quality-gate-venues.md). Unlike the plugin
scripts, `scripts/check.sh` may assume `git`, `shellcheck`, and `shellspec`, but still targets
bash 3.2 because the hooks run it on stock macOS.

- **Fixtures are hand-authored and use only public package names.** Never trim a lockfile out of a
  private repo into this one, which is public: internal package names, registry URLs, and the
  shape of an internal dependency graph all leak that way.
- **Nothing names a repository, organization, account or workspace outside the public
  `@SurveyMonkey` org.** This covers fixtures, code comments, spec data and documentation alike,
  and it covers organization topology (umbrella and nested owner directories) as surely as it
  covers package names: the shape of private infrastructure leaks the same way an internal
  dependency graph does. Cite a real field case generically ("the field-test repository", "a
  field-test fix PR") and give structural examples fictitious names (`@example-org/example-repo`,
  `octo/app`). `spec/reference_scrub_spec.sh` gates the internal slugs; the rest is on review.
- **Specs never hit the network or run an install.** Anything reaching for `gh` is mocked with
  shellspec's `Mock`.
- **Assert JSON with the `adapter_jq` / `common_jq` helpers**, not string matching against
  pretty-printed output. Both preserve the script's exit status, which matters because `validate`
  deliberately emits its report *and* fails.
- **Use `Parameters` blocks for table-driven cases** (version ordering, ecosystem routing, band
  thresholds) rather than repeating near-identical examples.

### Every regression lands a fixture, in the same commit as its fix

**A fix without a fixture is not a fix.** Any defect found by running the code — against a real
repository, a crafted input, or a review reproduction — must land a fixture carrying that exact
shape alongside the change that fixes it. This is not optional cleanup; it is the deliverable.

Without it the suite stays green while each round trades one defect for another. That has happened
repeatedly: the notice hook's text-only match missed `--json` output, its replacement regex could
not match a brace in an advisory title, and its replacement's fix for yarn `patch:` locators
inverted `present` for npm alias keys. Every one passed a full suite at the time.

**Assert the verdict, not just the parse.** These defects are dangerous because a plausible-looking
parse becomes a `removable` recommendation or a silent skip. A spec that stops at a script's JSON
passes while the hazard survives, so assert through the consuming rule — `validate`, a
`skipped_repos` reason, the `present: false` → `removable` path — and the test fails for the reason
the bug mattered.

**A shape found in the wild is the specimen.** When a real sample exists, trim the fixture from it;
never hand-author an approximation. Invented pnpm and yarn audit fixtures encoded formats those
tools never emit, which is exactly why the suite could not see the bug.

**A parser gaining a format branch needs a real specimen of that branch.** Aliases, patch
protocols, workspace and portal targets, binding parameters and nesting each need their own entry,
not a comment claiming they are excluded.

Lint with [ShellCheck](https://www.shellcheck.net) (`brew install shellcheck`):

```bash
./scripts/check.sh lint
```

It covers every tracked shell file, `scripts/check.sh` and the `.githooks/` included. Both suite
and lint must stay clean.

### Suppression is a last resort

**Read the tool's own guidance and try its recommended fix before overriding anything.** Both
tools are right far more often than they are wrong, and most findings have a canonical rewrite
that is genuinely better than the code that triggered them.

For a ShellCheck finding, open `https://www.shellcheck.net/wiki/SCXXXX` for that code first. Real
examples from this repo, both of which started as suppressions and became fixes:

- **SC2016** fired on a `sed` character class because the ordering happened to spell the literal
  `$(`. Reordering so `$` does not sit before `(` silenced it, verified byte-identical across nine
  inputs. No directive needed.
- **SC2086** fired on `jq $INDENT_ARGS`, which relied on the caller leaving the expansion
  unquoted. An indexed array removed the warning and the fragility together, and doing so exposed
  a real bug: the override container was created unconditionally, leaving an empty
  `"resolutions": {}` in manifests that never had one.

There are **no `shellcheck disable` directives in the shipped scripts**. Keep it that way; a
finding you cannot fix is usually a design smell worth a second look.

For a shellspec problem, check what upstream actually does before inventing something. A custom
`satisfy jq` matcher written for this suite emitted stray output into the results and was dropped
for plain helper functions plus exact JSON equality, which is both quieter and more idiomatic.

### When an override really is warranted

Only for a tool limitation you have confirmed, never for a finding you have not understood.

- **Narrowest scope that works.** `spec/.shellcheckrc` disables SC2317 and SC2329 for the suites
  only; both stay active against the plugin scripts. ShellCheck resolves `.shellcheckrc` relative
  to the file being checked, so new spec files inherit it with nothing to remember. Do not promote
  it to the repo root.
- **Specific codes, never blanket.**
- **Say why the tool is wrong, and say what you checked.** `spec/.shellcheckrc` records that
  upstream shellspec ships `disable=SC2317`, that SC2329 goes beyond upstream, and that all three
  SC2329 findings were individually confirmed as helpers invoked through `When call`.

## Working an issue

> **Temporary.** This section is being extracted into a skill or rule; see
> [sm-incubator/beta-recognition#1042](https://github.com/sm-incubator/beta-recognition/issues/1042).
> It lives here so the remaining RFC 001 phases (#5 through #9) are executed the same way Phase 1
> was. Delete it once that lands.

**Explore before asking.** Read the issue, the RFC or ADR it references, and every file it names,
in normal mode. Questions asked before that are uninformed and waste a turn.

**Ask one question at a time.** Not a batch. Each question carries a recommendation *and* the
argument against it, so the reply is "agreed" or a redirect. Batched questions get partially
answered: the second one gets dropped.

**Hand back before planning.** End the question phase by saying there is enough for a sound plan,
and stop. The human decides when to enter plan mode.

**Verify inputs while exploring, not assumptions.** Phase 1 planning changed materially once the
target repos were actually inspected: Yarn Berry rather than Classic, npm lockfile v3, and a
pre-existing bare override that blocked the intended fix.

## The issue tracker is the record

A plan that lives only in a session is invisible to everyone else and gone when it ends.

- **Post the approved plan as an issue comment before writing code.**
- **When scope moves between issues, comment on both** the issue losing it and the one gaining it,
  each saying why.
- **Scope that belongs nowhere yet becomes a new issue**, referenced from wherever it was cut.
- **Correct published claims where they were published** (`gh api -X PATCH .../issues/comments/ID`),
  not just locally.

## Verification discipline

**Verify a claim before publishing it.** Phase 1 asserted a bug in the existing version sort that
turned out not to exist; running the old code showed the real defect was different and worse. Run
the code before calling it broken.

**Report blocked work explicitly.** Say which targets failed, why, and what was still proven.
Never report success on the subset that worked and leave the rest unmentioned.

**Restore state you disturbed** in repos that are not the subject of the work: switch branches
back, revert changes.

**Prefer real repositories over fixtures.** Four Phase 1 defects surfaced only from real runs: a
corepack-managed package manager missing from `PATH`, a repo that pins exactly rather than by
range, a `test:watch` script that would have hung, and a missing label that makes `gh pr create`
fail outright.

## Environment

`direnv` does not auto-load in non-interactive tool shells, so `gh` and `git` silently use the
personal account in work directories. Use `direnv exec <dir> <cmd>`; never hardcode
`GH_CONFIG_DIR`.

Some repos cannot complete an install in a sandboxed shell (private registries, secret-gated
hooks). Check before planning verification that assumes installs succeed.
