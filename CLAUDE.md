# SurveyMonkey Skills

Claude Code plugin marketplace. Structure and installation: [README.md](README.md).
Script conventions: [plugins/gh-security/scripts/CLAUDE.md](plugins/gh-security/scripts/CLAUDE.md).

## Releasing a plugin

**A plugin's version lives in its own `plugin.json` and nowhere else.** Bumping it is the entire
release: Claude Code resolves the version from `plugin.json` first, and users only receive updates
when that string changes.

Do **not** add `version` to a plugin's entry in `.claude-plugin/marketplace.json`. Claude Code
always prefers the `plugin.json` value **without warning**, so a version set in both places lets a
forgotten `plugin.json` bump silently ship nothing. `metadata.version` in `marketplace.json` is the
catalog's own version and is unrelated to plugin updates.

No git tags and no GitHub releases. Plugins are installed from the default branch and refreshed
with `/plugin marketplace update`. Tags would also be ambiguous once this marketplace carries
several plugins at independent versions.

## Testing

Bash scripts are covered by [shellspec](https://shellspec.info): `brew install shellspec`, then
`shellspec` from the repo root. Specs live in `spec/`, config in `.shellspec`.

- **Fixtures are hand-authored and use only public package names.** Never trim a lockfile out of a
  private repo into this one, which is public: internal package names, registry URLs, and the
  shape of an internal dependency graph all leak that way.
- **Specs never hit the network or run an install.** Anything reaching for `gh` is mocked with
  shellspec's `Mock`.
- **Assert JSON with the `adapter_jq` / `common_jq` helpers**, not string matching against
  pretty-printed output. Both preserve the script's exit status, which matters because `validate`
  deliberately emits its report *and* fails.
- **Use `Parameters` blocks for table-driven cases** (version ordering, ecosystem routing, band
  thresholds) rather than repeating near-identical examples.

Lint with [ShellCheck](https://www.shellcheck.net) (`brew install shellcheck`):

```bash
shellcheck plugins/gh-security/scripts/common/*.sh \
           plugins/gh-security/scripts/ecosystems/*.sh \
           spec/spec_helper.sh spec/*_spec.sh
```

Both must stay clean.

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
