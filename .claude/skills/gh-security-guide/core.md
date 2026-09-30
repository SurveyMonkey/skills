# gh-security: core rules

Deterministic work lives here so agent prompts do not re-derive procedures each session.
**Agents decide, commands do.** Anything with one correct procedure belongs in a command with a
typed JSON contract; interpreting failures and writing prose stays with the agent.

**This skill describes the target state**, the Shape in
[RFC 002](../../../docs/rfc/002-typescript-port.md): one CLI entry point over typed commands that
node executes directly. Which of them have been ported and which are still bash is the rollout
table in that RFC, and that table is the source for what exists today rather than anything here.
A script name used in these files (`common/fix-group.sh`, `ecosystems/node.sh`) names the home of a
procedure, not a claim about the substrate it is written in this week.

## Hard constraints

**Nothing shipped imports anything outside the plugin.** vitest, ajv, `typescript` and
`@types/node` are dev and CI dependencies and stay that way. A dependency on a shipped path
reintroduces the cold-cache registry fetch in the middle of a security fix that ADR 001 refused
`npx semver` for, and that refusal stands.

**Scope: this rule governs what runs on a user's machine**, which is `scripts/gh-security.ts`,
everything under `src/` (and the root `lib/` it reaches through `src/lib`), plus the two bash
scripts that still ship under `scripts/`. It is not a repository-wide
ban on dependencies. `plugins/gh-security/workflows/` ships one JavaScript file that the Claude
Code harness loads and evaluates, never a user's shell (ADR 010's boundary, which ADR 012 leaves
standing). Nothing under `scripts/` or `src/` imports that file, and it imports nothing from them.

**`gh`, `git`, the package manager and `detect-capacity.sh` are the only process seams.** Every
other boundary is a function call: a verb never spawns another verb, and no call site pays a
process to ask a semver question (ADR 001 as amended by ADR 012). A process seam is also where
untrusted input arrives, so what comes back across one is validated where it enters and never
defaulted.

## Adapter contract

See [ADR 001](../../../docs/adr/001-ecosystem-adapter-contract.md). As amended by ADR 012 the
contract is an in-process interface rather than a process: verbs are functions behind one adapter
interface, and the four exit codes are the same four outcomes carried in a typed result envelope.
The stdout and stderr split survives at the CLI entry point, where a command is invoked from a
prompt. Every obligation ADR 001 states survives the move unchanged.

Everything ecosystem-specific stays behind the verbs, **including version comparison and range
semantics**. Milestone 7's Python adapter implements PEP 440; node implements semver. Do not lift
`compare_versions` or `range_facts` into shared code. `score-merge-risk` is the pattern to copy:
it needs to know how far past `^9` a fix landed, and it asks the adapter rather than reaching for
a leading digit itself.

**A field the contract promises arrives present and of the promised type, or it is a hard error,
never a default.** The type system now carries the half of that rule it can: a verb's result is a
declared type, and a caller reading a field nothing promised does not compile. The other half
stays runtime, because a lockfile, a `gh` reply and a state file are untrusted input whatever a
signature says, so each is validated once where it enters rather than guarded again at every call
site. The distinction that has to survive there is absent versus null: null is often a legitimate
answer, since a range with no floor has no `majors_ahead`, and absence never is, which is the same
rule that makes `range_facts` emit every key. An adapter missing `major_distance` once made the
whole multi-major escalation vanish while the run still reported success. Two further routes
reach that same silent zero and are checked the same way: a present-but-untyped value, and a verb
that reports success while answering with nothing at all. So `score-merge-risk` asserts the reply
is an object before reading any field of it, and checks the numeric ones are integers before
comparing them.

## The rule that matters most

**Zero resolved versions is an error, never a pass.** `resolved_versions` returning an empty list
means the parser failed, not that the package is absent. The shipped v0.1.0 yarn validation
regex could never match, so it returned zero lines and every yarn repo got a "lockfile
validated" claim backed by nothing. Any code path that treats "found nothing" as success is a
bug.

Fixture tests do not replace verifying against real repositories with live alerts; check both the
success path and the "parser found nothing" path.

## Supported toolchains

`node.sh detect` handles pnpm, npm, and Yarn Berry (v2+, lockfiles carrying a `__metadata`
block). Unsupported toolchains are **rejected gracefully**, never with a crash, pointing at
`.github/CONTRIBUTING.md`:

- **bun** — dropped, unused internally
- **Yarn Classic v1** — a `yarn.lock` with no `__metadata` block

Same treatment for non-`npm` advisory ecosystems in `select-adapter.sh`: skipped and reported.
