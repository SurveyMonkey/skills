---
description: >
  Fix the next Dependabot security alert for the current repo. Fetches all open
  alerts, groups by package, ranks by severity then EPSS exploitability, skips
  packages with open fix PRs, and resolves the top group: updates direct deps or
  adds major-bounded scoped overrides for transitive ones. Validates the lockfile,
  runs all repo scripts, then opens a draft PR carrying a computed merge-risk
  rating. Supports pnpm, npm, and Yarn Berry.
allowed-tools:
  - Bash(*detect-scope.sh*)
  - Bash(*discover-alerts.sh*)
  - Bash(*select-adapter.sh*)
  - Bash(*score-merge-risk.sh*)
  - Bash(*node.sh*)
  - Bash(pnpm *)
  - Bash(npm *)
  - Bash(yarn *)
  - Bash(git switch *)
  - Bash(git switch -c *)
  - Bash(git add *)
  - Bash(git commit *)
  - Bash(git push -u origin *)
  - Bash(git pull *)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git remote *)
  - Bash(git symbolic-ref *)
  - Bash(gh pr create *)
  - Bash(gh pr ready *)
  - Bash(gh pr view *)
  - Bash(rm pnpm-lock.yaml*)
  - Bash(rm yarn.lock*)
  - Bash(rm package-lock.json*)
  - Read
  - Edit(package.json)
---

Fix the highest-priority group of Dependabot security alerts for the current repository.

The deterministic work lives in scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/`. Call them; do not
reimplement what they do. Your job is the judgment: interpreting install failures, deciding
whether a failing script is pre-existing or caused by this change, and writing the PR prose.

Throughout, `ADAPTER` refers to the adapter path returned in phase 2 and `PM` to its package
manager. Every script emits JSON on stdout and exits non-zero with an `error` key on failure. If
any script fails, report its error and stop.

## Phase 1: Detect context

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/detect-scope.sh
```

Use `nwo` (`owner/repo`) for everything downstream. If `scope` is not `repo`, you are not inside a
repository checkout: report the scope and stop. If `git_remote` disagrees with `nwo`, trust
`git_remote` and say so; the directory convention is a heuristic and the remote is the fact.

## Phase 2: Discover alerts and route to an adapter

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/common/discover-alerts.sh <nwo> \
  | ${CLAUDE_PLUGIN_ROOT}/scripts/common/select-adapter.sh --from-discovery
```

Returns `actionable` (ready to fix, ranked by severity then EPSS) and `skipped` (excluded, each
with a `reason`).

If `actionable` is empty, report every skipped group and stop. Reasons you will see:

- `no fix available` — no patched version published yet
- `open PR exists` — a fix PR is already open (URL in `open_pr_url`)
- `ecosystem not supported yet` — no adapter for that ecosystem; see `.github/CONTRIBUTING.md`
- `PR check failed` — the PR lookup itself errored (`error` field)

Otherwise take the **first** actionable group. Confirm the toolchain:

```bash
$ADAPTER detect
```

If this exits 3, the repository uses an unsupported package manager. Report the message verbatim
(it points at `.github/CONTRIBUTING.md`) and stop. This is not a failure, it is an unsupported
configuration.

Present the target:

> **Target**: `<package>` (<alert_count> alert(s), max severity: <max_severity>, EPSS: <max_epss_percentile as percent>)
> **Minimum safe version**: >=<highest_fixed_version>
> **Alerts**:
> - #<number>: <cve> (<severity>, EPSS <epss_percentile as percent>): <summary>

Note any skipped groups briefly, then proceed.

## Phase 3: Prepare the working branch

Find the default branch:

```bash
git remote show origin | sed -n 's/.*HEAD branch: //p'
```

If that fails, try `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`.
If both fail, report and stop.

Switch to it and pull. **If there are uncommitted changes, stop and report.** Never stash or
discard someone's work. Then create the fix branch using `branch_name` from the discovery output.

## Phase 4: Record the pre-fix baseline

```bash
$ADAPTER resolved_versions <package>
```

Keep this output. The merge-risk rating needs the version that was resolved *before* the fix, and
once you install it is gone.

If `present` is false the package is not currently in the lockfile, which is legitimate for a new
direct dependency. Record that there is no baseline and continue; phase 8 handles it.

If the script errors about parsing zero entries, the lockfile is unreadable. Stop. Do not treat a
failed parse as an empty result.

## Phase 5: Classify the dependency

```bash
$ADAPTER why <package>
```

`relationship` is `direct` or `transitive`, and `parents` lists the direct parents a scoped
override must target. Keep `raw` for the PR body.

## Phase 6: Apply the fix

Derive a **major-bounded** range from `highest_fixed_version`: `3.1.2` becomes `>=3.1.2 <4`,
`0.5.3` becomes `>=0.5.3 <1`. Never emit an unbounded range; it would auto-install future majors.

```bash
# direct dependency
$ADAPTER apply_constraint <package> '>=<version> <<next_major>'

# transitive: pass every parent from phase 5
$ADAPTER apply_constraint <package> '>=<version> <<next_major>' <parent-a> <parent-b>
```

The adapter picks the right syntax per package manager, merges into existing entries rather than
replacing them, and preserves the manifest's formatting.

Its `observations` array lists **unscoped global overrides** already in the manifest. Do not act
on them here. Collect them for the summary in phase 10.

## Phase 7: Install and validate

```bash
$ADAPTER install
$ADAPTER validate <package> '>=<version> <<next_major>'
```

`validate` checks **every** resolved version against the constraint, not just the one the
package manager reports. It exits non-zero and lists `violations` on failure.

Install failures are yours to diagnose. Common causes: a peer conflict needing a wider range, a
registry timeout worth one retry, or a version that does not exist on the registry.

When `validate` fails, work through these in order:

1. **Uncovered parents.** A violating version usually arrives via a parent not in your override
   list. Add scoped entries for those parents and re-run install and validate.
2. **A bare global override.** If the manifest already has an unscoped override for this package
   (check the phase 6 observations) with a range below the fixed version, it governs every path
   your scoped entries do not cover. Escalate:

   ```bash
   $ADAPTER apply_constraint --tighten-bare <package> '>=<version> <<next_major>'
   ```

   This is an escalation, not a default. Record it: the PR body must say the bare override was
   tightened because scoped entries alone could not satisfy the constraint.
3. **A stale lockfile.** If validation still fails, the lockfile may hold pinned versions that
   resist overrides. **Ask the user before deleting it**, then remove the lockfile, install
   fresh, and re-validate.

## Phase 8: Run the repo's own checks

```bash
$ADAPTER verification_commands
```

`commands` is a **candidate list**, not a running order. The script filters obvious long-running
servers into `skipped` by name, but it cannot recognize every one. Review the list before running
it and skip anything that is not a check: registry or preview servers (`start-verdaccio`),
migration or codemod runners (`nx-migrate`), release and publish scripts, and `postinstall`
(already run by the install). Say which ones you skipped and why.

Run the rest.

Judge each failure: caused by this update, or pre-existing? Check out the default branch and
re-run if you are unsure. Pre-existing failures are noted and do not block; caused failures must
be fixed or the fix abandoned.

## Phase 9: Score merge risk

Capture the post-fix version with `$ADAPTER resolved_versions <package>`, then:

```bash
$ADAPTER why <package> > /tmp/why.json
${CLAUDE_PLUGIN_ROOT}/scripts/common/score-merge-risk.sh \
  --package <package> \
  --before <lowest version from phase 4, omit entirely if there was no baseline> \
  --after <resolved version now> \
  --adapter $ADAPTER \
  --why-json /tmp/why.json \
  --f4 <0|1|2> --f5 <0|1|2>
```

The script computes F1 (version delta), F2 (runtime exposure), and F3 (usage surface). You supply
the two factors only you know, from phase 8:

- **F4 test signal**: `0` tests pass and exercise the affected modules; `1` tests pass but nothing
  clearly exercises them; `2` no test script, or tests could not run.
- **F5 verification**: `0` every script ran clean; `1` scripts ran with pre-existing failures;
  `2` one or more scripts skipped or partially run.

Be honest about F4 and F5. Their whole purpose is telling a reviewer how much to trust the rest.

Use the returned `markdown` verbatim in the PR body.

## Phase 10: Ship

Commit, push, and open the PR **as a draft**. Do not pause before committing: the PR is the
review artifact, and it goes up as a draft precisely so nothing is final until a human says so.

```bash
git add package.json <lockfile>
```

Commit message:

```
fix(deps): resolve <N> Dependabot alert(s) for <package>

<Direct update | Scoped override> to >=<version> via <override location>.

Alerts resolved:
- #<number>: <CVE> (<severity>)

Refs: https://github.com/<nwo>/security/dependabot/<number>
```

Push, then create the draft PR. Collect **all** required labels from every source and apply them
together, each via its own `--label` flag. This skill always requires `Security`. Check every
CLAUDE.md in context for additional required labels (for example `ai-claudecode`). No source
overrides another; labels are additive.

`gh pr create` fails outright if a label does not exist in the repository, so check first and
create any that are missing rather than dropping them:

```bash
gh label list --repo <nwo> --json name --jq '.[].name'
gh label create Security --repo <nwo> --color D93F0B --description "Security fix" 2>/dev/null || true
```

```bash
gh pr create --draft --label Security [--label ...] --title "..." --body "..."
```

PR body:

```markdown
## Summary

- Resolves <N> Dependabot alert(s) for `<package>` by <updating the direct dependency | adding scoped overrides>
- Target version: >=<highest_fixed_version>
- Resolved version: <post-fix resolved version>

## Alerts resolved

| # | CVE | Severity | EPSS | Summary |
|---|---|---|---|---|
| [#N](https://github.com/<nwo>/security/dependabot/N) | CVE-XXXX-XXXXX | severity | 84.2% | summary |

<merge-risk markdown from phase 9, verbatim>

## Dependency chain

```
<raw from phase 5>
```

## Changes

```json
<the exact JSON added or modified in package.json>
```

## Verification

- [x] Lockfile validated: <checked> resolved version(s) satisfy `>=<version> <<next_major>`
- [x] `<command>` passes (one entry per command actually run)

## References

- https://github.com/<nwo>/security/dependabot/<number>
```

EPSS percentile and merge risk are separate signals shown side by side: EPSS is how urgent the
vulnerability is, merge risk is how risky this fix is to merge. Never merge them into one number.

If you tightened a bare override in phase 7, add a short section saying so and why.

## Phase 11: Report and offer to mark ready

Report:

1. The draft PR URL and its merge-risk band.
2. Any **unscoped global overrides** from the phase 6 observations, as a note:

   > Note: `<location>` contains N unscoped override(s): `<keys>`. These may be removable or
   > convertible to scoped pins. The pin audit will test removability (issue #7).

   A lead, not a finding. Do not remove or convert them here.
3. Remaining actionable groups, if any, and that re-running resolves the next one.

Then ask whether to mark the PR ready for review. On confirmation:

```bash
gh pr ready <url>
```

The branch was cut from a freshly pulled default branch, so no rebase is needed before marking
ready.
