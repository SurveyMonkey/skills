# gh-security scripts

Deterministic work lives here so agent prompts do not re-derive procedures each session.
**Agents decide, scripts do.** Anything with one correct procedure belongs in a script with a
JSON contract; interpreting failures and writing prose stays with the agent.

## Hard constraints

**Dependencies are `bash`, `jq`, and `gh`. Nothing else.** No `node`, no `npx`, no `yq`, no
`python`. Semver comparison is implemented in jq rather than shelling out to `npx semver`, which
would mean a cold-cache network fetch in the middle of a security fix.

**Target bash 3.2** (the macOS default). Not every engineer has Homebrew bash on PATH. That rules
out associative arrays, `mapfile`/`readarray`, `${var,,}`, and `**`. jq carries the data
structures instead.

**Use POSIX character classes in regexes**, `[[:space:]]` not `\s`. BSD grep on macOS does not
support `\s` in ERE. It works under ugrep, which some engineers alias to `grep`, so this fails
only on other people's machines.

## Layout

| Path | Scope |
|---|---|
| `common/` | Ecosystem-agnostic: scope detection, alert discovery, adapter routing, risk scoring, capacity detection, PR status and promotion |
| `ecosystems/` | One adapter per GitHub advisory ecosystem. `node.sh` handles `npm` alerts |

## Adapter contract

See `docs/adr/001-ecosystem-adapter-contract.md`. Adapters are invoked as
`<adapter>.sh <verb> [args]`, emit JSON on stdout, human-readable detail on stderr, and exit
non-zero with `{"error": "..."}` on failure.

Everything ecosystem-specific stays behind the verbs, **including version comparison and range
semantics**. Phase 6's Python adapter implements PEP 440; node implements semver. Do not lift
`compare_versions` or `range_facts` into `common/`. `score-merge-risk.sh` is the pattern to copy:
it needs to know how far past `^9` a fix landed, and it asks the adapter rather than reaching for
a leading digit itself.

## One group per package major line, and validate decides completeness

`discover-alerts.sh` groups by package **and** the major of `first_patched_version`. Grouping by
package alone collapsed every patched version into one `highest_fixed_version`, which described
only the newest line while the older ones stayed vulnerable under a group reported as fixed
([#19](https://github.com/SurveyMonkey/skills/issues/19)). Anything that regroups or renames must
keep one branch, one worktree and one PR per line.

Discovery cannot tell which resolved copy an alert matched: the API does not say, and discovery
has no lockfile. **Only the adapter's `validate` can answer whether the alerts were actually
cleared**, and it must be given the group's `vulnerable_range`s (`--vulnerable`) to do it. A
constraint check alone passes a partial fix, so the guarantee is enforced rather than requested:
`--line` without `--vulnerable` is an error, and so is a `--vulnerable` range that does not parse
(range satisfaction answers false for a token it cannot read, which on this side means "nothing is
vulnerable").

## Prescribed shapes and the preflight catalog move together

`preflight-permissions.sh` pre-approves exactly the command shapes the agent definition
prescribes. Changing a prescribed shape in `agents/fix-dependency.md` without updating the
catalog in the same commit reintroduces a permission prompt for spec'd behavior — caught live
once already (the `rev-parse` → `branch --list` guard change). Keep them in lockstep.

## No Bash snippet may depend on the previous call

The Bash tool resets cwd between invocations and shell variables do not survive it. A snippet in
an agent definition that relies on an earlier `cd` or an earlier assignment runs in the user's
checkout instead of the worktree — which is how a live run bumped a package and regenerated a
lockfile in a real repository ([#18](https://github.com/SurveyMonkey/skills/issues/18)). Every
prescribed snippet locates itself: `git -C <path> ...`, or `cd <path> && <command>` for
everything else.

Scripts that are cwd-sensitive enforce it rather than trust it, through one shared guard:
`common/require-linked-worktree.sh`, invoked by `refuse_primary_checkout` in `ecosystems/node.sh`
for the mutating verbs and by `common/run-check.sh` for every check run. It requires the cwd to
sit inside a **linked** worktree, which a primary checkout, any subdirectory of one, a submodule
(also a `.git` file), and a directory in no repository at all all fail. Specs fake a worktree
with `fake_linked_worktree` (see `spec/spec_helper.sh`).

## The rule that matters most

**Zero resolved versions is an error, never a pass.** `resolved_versions` returning an empty list
means the parser failed, not that the package is absent. The shipped v0.1.0 yarn validation
regex could never match, so it returned zero lines and every yarn repo got a "lockfile
validated" claim backed by nothing. Any code path that treats "found nothing" as success is a
bug.

## Supported toolchains

`node.sh detect` handles pnpm, npm, and Yarn Berry (v2+, lockfiles carrying a `__metadata`
block). Unsupported toolchains are **rejected gracefully**, never with a crash, pointing at
`.github/CONTRIBUTING.md`:

- **bun** — dropped, unused internally
- **Yarn Classic v1** — a `yarn.lock` with no `__metadata` block

Same treatment for non-`npm` advisory ecosystems in `select-adapter.sh`: skipped and reported.

## Testing

Shellspec suites live in `spec/` at the repo root; conventions are in the root `CLAUDE.md`
(Testing section). CI automation for the suite is tracked in
[#10](https://github.com/SurveyMonkey/skills/issues/10). Fixture tests do not replace verifying
against real repositories with live alerts; check both the success path and the "parser found
nothing" path.
