# SurveyMonkey Skills

Claude Code plugin marketplace. Structure and installation: [README.md](README.md).
Script conventions: [plugins/gh-security/scripts/CLAUDE.md](plugins/gh-security/scripts/CLAUDE.md).

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
