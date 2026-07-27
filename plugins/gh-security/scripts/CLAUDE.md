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
| `common/` | Ecosystem-agnostic: scope detection, alert discovery, adapter routing, risk scoring |
| `ecosystems/` | One adapter per GitHub advisory ecosystem. `node.sh` handles `npm` alerts |

## Adapter contract

See `docs/adr/001-ecosystem-adapter-contract.md`. Adapters are invoked as
`<adapter>.sh <verb> [args]`, emit JSON on stdout, human-readable detail on stderr, and exit
non-zero with `{"error": "..."}` on failure.

Everything ecosystem-specific stays behind the verbs, **including version comparison**. Phase 6's
Python adapter implements PEP 440; node implements semver. Do not lift `compare_versions` into
`common/`.

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

No harness yet; tracked in [#10](https://github.com/SurveyMonkey/skills/issues/10). Until it
lands, verify against real repositories with live alerts and check both the success path and the
"parser found nothing" path.
