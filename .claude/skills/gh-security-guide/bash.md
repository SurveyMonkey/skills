# gh-security: bash during the port

## Bash during the port

**This section is the one deliberate exception to
[#216](https://github.com/SurveyMonkey/skills/issues/216)'s rule that nothing here describes a
bash or jq mechanism the port removes, and
[#241](https://github.com/SurveyMonkey/skills/issues/241) deletes it.** It governs the shipped
scripts that have not been ported yet, plus `detect-capacity.sh` and `notice-scan.sh`, which stay
bash for good (RFC 002, Non-Goals). Which is which is the rollout table in
[RFC 002](../../../docs/rfc/002-typescript-port.md). These targets outlive this section, and
land in a section of their own beside the two scripts when this section goes.

Two bash scripts ship from `scripts/common/` and stay bash: `notice-scan.sh`, the PostToolUse
notice hook, which runs on every Bash call, where a node process start would be a standing cost
paid per tool call for a grep; and `detect-capacity.sh`, three machine probes, called once per
dispatch. Any other `.sh` file under `scripts/` is mid-port.

**Target jq 1.7** (ubuntu-latest's, which is what CI runs). Development machines run 1.8 from
Homebrew, so anything the two versions read differently goes green locally and red only in CI.
**Parenthesize a `//` default before binding it**: `(A // B) as $x`, never `A // B as $x`. `as`
takes its whole right-hand side, so the unparenthesized form parses as `A // (B as $x | body)`
and short-circuits to `A` whenever `A` is present — 1.8 reads it as intended, 1.7 does not
([#82](https://github.com/SurveyMonkey/skills/pull/82)). `spec/jq_binding_spec.sh` gates the
shape on every platform.

**Target bash 3.2** (the macOS default). Not every engineer has Homebrew bash on PATH. That rules
out associative arrays, `mapfile`/`readarray`, `${var,,}`, and `**`. jq carries the data
structures instead.

**Use POSIX character classes in regexes**, `[[:space:]]` not `\s`. BSD grep on macOS does not
support `\s` in ERE. It works under ugrep, which some engineers alias to `grep`, so this fails
only on other people's machines. `spec/grep_dialect_spec.sh` gates the same dialect inside the
shellspec suite.

## Parity

**Parity is what licenses a deletion.** A bash script is deleted only after its replacement is
parity-green on every fixture that covered it
([RFC 002](../../../docs/rfc/002-typescript-port.md)), and its spec file goes in the same commit,
because two implementations of one behavior outlive their usefulness the moment one of them is
authoritative. `tests/plugins/gh-security/semver/parity-semver.test.ts` is the first such run, over `node.sh`'s two semver
verbs. The runner itself is deleted in
[#241](https://github.com/SurveyMonkey/skills/issues/241), when there is nothing left to compare
against.
