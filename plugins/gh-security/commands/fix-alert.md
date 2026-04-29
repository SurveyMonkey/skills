---
description: >
  Fix the next Dependabot security alert for the current repo. Fetches all open
  alerts, groups by package, ranks by severity then EPSS exploitability, skips
  packages with open fix PRs, and resolves the top group: updates direct deps or
  adds major-bounded scoped overrides for transitive ones. Validates the lockfile,
  runs all repo scripts, then commits and opens a PR. Supports pnpm, npm, yarn,
  and bun.
allowed-tools:
  - Bash(pwd)
  - Bash(*discover-alerts.sh*)
  - Bash(ls:*)
  - Bash(pnpm *)
  - Bash(npm *)
  - Bash(yarn *)
  - Bash(bun *)
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
  - Bash(awk *)
  - Bash(sed *)
  - Bash(grep *)
  - Bash(sort *)
  - Bash(rm pnpm-lock.yaml*)
  - Bash(rm yarn.lock*)
  - Bash(rm package-lock.json*)
  - Bash(rm bun.lock*)
  - Read
  - Edit(package.json)
---

Fix the highest-priority group of Dependabot security alerts for the current repository. Work through each phase sequentially. Do not skip phases.

## Phase 1: Detect context

```bash
pwd
```

Derive `OWNER/REPO` from the working directory path. Find the **innermost (deepest) `@`-prefixed segment**, then the next non-`@` segment is the repo name. The `@` segment (without the `@` prefix) is the owner.

Example: `/Users/.../Code/@momentive_emu/@mntv-analysis/mdx-report-poc`
- Innermost `@`-segment: `@mntv-analysis`
- Next non-`@` segment: `mdx-report-poc`
- Result: `OWNER/REPO` = `mntv-analysis/mdx-report-poc`

## Phase 2: Detect package manager

Check for lockfiles in the repo root (first match wins):

| Lockfile | PM | Why command | Install command | Override location |
|---|---|---|---|---|
| `pnpm-lock.yaml` | pnpm | `pnpm why <pkg>` | `pnpm install` | `pnpm.overrides` in package.json |
| `yarn.lock` | yarn | `yarn why <pkg>` | `yarn install` | `resolutions` in package.json |
| `package-lock.json` | npm | `npm explain <pkg>` | `npm install` | `overrides` in package.json |
| `bun.lock` or `bun.lockb` | bun | (inspect lockfile) | `bun install` | `overrides` in package.json |

```bash
ls pnpm-lock.yaml yarn.lock package-lock.json bun.lock bun.lockb 2>/dev/null | head -1
```

Record the PM and lockfile for later phases.

## Phase 3: Discover alerts

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/discover-alerts.sh OWNER/REPO
```

The script returns JSON with two arrays: `actionable` (groups ready to fix) and `skipped` (groups excluded, with reason).

If the script exits non-zero or returns JSON with an `"error"` key, report the error message to the user and stop. Do not proceed to subsequent phases.

If `actionable` is empty, report why using the `skipped` array:
- Groups with `reason: "no fix available"`: no patched version exists yet
- Groups with `reason: "open PR exists"`: a PR on branch `fix/dependabot-<package>` is already open (URL in `open_pr_url`)

Report all skipped groups, then stop.

If `actionable` is not empty, select the first item (highest priority). Present a summary:

> **Target**: `<package>` (<alert_count> alert(s), max severity: <max_severity>, EPSS: <max_epss_percentile as percent>)
> **Minimum safe version**: >=<highest_fixed_version>
> **Alerts**:
> - #<number>: <cve> (<severity>, EPSS <epss_percentile as percent>): <summary>
> - #<number>: <cve> (<severity>, EPSS <epss_percentile as percent>): <summary>

If any groups were skipped, briefly note them before proceeding.

Proceed with the selected group.

## Phase 4: Prepare working branch

Before making any changes, ensure we're starting from the latest default branch.

### 4a: Switch to the default branch

```bash
git remote show origin | sed -n 's/.*HEAD branch: //p'
```

If that command fails (no remote, network error), try:

```bash
git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'
```

If both fail, report the error and stop.

If not already on the default branch, switch to it:

```bash
git switch <default-branch>
```

If there are uncommitted changes, **stop and report the issue**. Do not stash or discard work.

### 4b: Pull latest

```bash
git pull origin <default-branch>
```

### 4c: Create the fix branch

Use the `branch_name` from the discovery output:

```bash
git switch -c <branch_name from discovery output>
```

## Phase 5: Investigate dependency chain

Run the PM's "why" command to determine how the package enters the dependency tree:

```bash
pnpm why <package>   # or yarn why / npm explain
```

Also check if the package is listed directly in package.json:

```bash
grep '"<package>"' package.json
```

Determine:
1. Is it a **direct** dependency (listed in `dependencies` or `devDependencies`)?
2. If **transitive**, which parent package(s) pull it in? Record each unique direct parent from the "why" output.

## Phase 6: Apply fix

Read `package.json` to understand the current state.

### If direct dependency

Update the version in package.json to a range that includes the fixed version. Use `Edit` to modify the version in `dependencies` or `devDependencies`.

### If transitive dependency

Add scoped overrides. Always scope the override to the specific parent package(s) rather than applying a global override, unless the PM does not support scoping.

**Version range**: Always use a major-bounded range to prevent accidental major version upgrades. Derive the ceiling from the `highest_fixed_version`:
- If fixed version is `3.1.2`, use `>=3.1.2 <4`
- If fixed version is `8.5.10`, use `>=8.5.10 <9`
- If fixed version is `0.5.3`, use `>=0.5.3 <1`

Never use unbounded ranges like `>=3.1.2` as they will auto-install future major versions with potential breaking changes.

**pnpm**: Add entries to `pnpm.overrides` using `"parent>dep"` syntax:
```json
"pnpm": {
  "overrides": {
    "parent-a>vulnerable-pkg": ">=<highest_fixed_version> <<next_major>",
    "parent-b>vulnerable-pkg": ">=<highest_fixed_version> <<next_major>"
  }
}
```

**npm**: Add nested entries to `overrides`:
```json
"overrides": {
  "parent-a": {
    "vulnerable-pkg": ">=<highest_fixed_version> <<next_major>"
  },
  "parent-b": {
    "vulnerable-pkg": ">=<highest_fixed_version> <<next_major>"
  }
}
```

**yarn**: Add entries to `resolutions` using `"parent/dep"` syntax:
```json
"resolutions": {
  "parent-a/vulnerable-pkg": ">=<highest_fixed_version> <<next_major>",
  "parent-b/vulnerable-pkg": ">=<highest_fixed_version> <<next_major>"
}
```

**bun**: Add flat entry to `overrides` (bun does not support scoped overrides):
```json
"overrides": {
  "vulnerable-pkg": ">=<highest_fixed_version> <<next_major>"
}
```

If the override section already exists in package.json, merge new entries into it. Do not replace existing entries.

## Phase 7: Install

Run the PM's install command to apply changes and regenerate the lockfile:

```bash
pnpm install   # or yarn install / npm install / bun install
```

If the install command fails, investigate the error. Common causes:
- Peer dependency conflict: check if the override range needs widening
- Registry timeout: retry once
- Version not found: verify the `highest_fixed_version` exists on the registry

Do not proceed to Phase 8 until install succeeds cleanly.

## Phase 8: Verify

### 8a: Confirm resolution

Run the "why" command again and confirm the resolved version is >= `highest_fixed_version`:

```bash
pnpm why <package>   # or equivalent
```

If the version is still below the fix threshold, adjust the override and re-install.

### 8b: Validate lockfile against overrides

The "why" command alone is insufficient. The lockfile may resolve versions that violate the override constraint for some dependency paths (e.g., a major version bump that bypasses a `<N` ceiling).

Search the lockfile for all resolved versions of the overridden package:

**pnpm** (pnpm-lock.yaml):
```bash
grep -E "^\s+'?<package>@" pnpm-lock.yaml | sort -u
```

**npm** (package-lock.json):
```bash
grep -E '"<package>":' package-lock.json | grep '"version"' | sort -u
```

**yarn** (yarn.lock):
```bash
grep -A1 "^\"?<package>@" yarn.lock | grep version | sort -u
```

Verify that **every** resolved version satisfies the override constraint. Pay special attention to:
- Major version bumps that exceed a `<N` ceiling in the override range
- Multiple resolved versions where some satisfy and others don't

If any resolved version violates the constraint:

**First attempt**: Adjust overrides
1. Identify which parent packages pull in the violating version
2. Add additional scoped overrides targeting those specific parents
3. Re-run install
4. Re-validate

**If validation still fails**: The lockfile may have stale pinned versions that resist overrides. **Stop and ask the user before proceeding**: "Validation failed after adjusting overrides. I need to delete `<lockfile>` and perform a fresh install to force re-resolution. Proceed?" Wait for explicit confirmation, then delete the lockfile and perform a fresh install:

```bash
rm pnpm-lock.yaml   # or yarn.lock / package-lock.json / bun.lock
pnpm install         # or yarn install / npm install / bun install
```

Re-validate after the fresh install. A clean lockfile regeneration forces all transitive dependencies to re-resolve against the current overrides and registry state, picking up patch releases that a stale lockfile would otherwise ignore.

### 8c: Run all package.json scripts

Use `Read` to read `package.json` and identify the available scripts from the `scripts` field. Do NOT use `node -e` or other shell commands to parse package.json. Do NOT assume which scripts exist: different repos have different tooling.

Run every script that exists. Use the detected PM to invoke each one (e.g., `pnpm <script-name>`). Skip `dev` and `start` as they launch long-running servers.

If any script fails, investigate and fix before proceeding. If the failure is unrelated to the security update (pre-existing), note it and proceed.

## Phase 9: Ship

**STOP and present the plan to the user before proceeding. Show:**

> Ready to ship fix for `<package>` (<N> alerts resolved):
>
> **Branch**: `<branch_name from discovery output>`
> **Commit message**: (show draft below)
> **PR title**: (show draft below)
>
> Proceed?

Wait for explicit user confirmation before continuing.

### 9a: Commit

```bash
git add package.json <lockfile>
```

Commit message format (conventional commits, using a heredoc):
```
fix(deps): resolve <N> Dependabot alert(s) for <package>

<Direct update | Scoped override> to >=<version> via <pnpm.overrides | overrides | resolutions>.

Alerts resolved:
- #<number>: <CVE> (<severity>)
- #<number>: <CVE> (<severity>)

Refs: https://github.com/OWNER/REPO/security/dependabot/<number>
Refs: https://github.com/OWNER/REPO/security/dependabot/<number>
```


### 9b: Push and create PR

```bash
git push -u origin <branch_name from discovery output>
```

Create the PR. Collect **all** required labels from every source and apply them together. This skill always requires the `Security` label. Additionally, check all CLAUDE.md files in the conversation context for any required PR labels (e.g., `ai-claudecode`). Merge every label from every source into a single set and pass each one via its own `--label` flag. No source overrides another; all labels are additive.

PR body format:
```markdown
## Summary

- Resolves <N> Dependabot alert(s) for `<package>` by <updating the direct dependency | adding scoped overrides>
- Target version: >=<highest_fixed_version>
- Resolved version: <actual version from "why" output>

## Alerts resolved

| # | CVE | Severity | Summary |
|---|---|---|---|
| [#N](https://github.com/OWNER/REPO/security/dependabot/N) | CVE-XXXX-XXXXX | severity | summary |

## Dependency chain

```
<output of "why" command>
```

## Changes

```json
<the exact JSON added or modified in package.json>
```

## Verification

- [x] `<pm> why <package>` confirms >=<version>
- [x] Lockfile validated: all resolved versions satisfy override constraint
- [x] `<pm> <script>` passes (one entry per script actually run)

## References

- https://github.com/OWNER/REPO/security/dependabot/<number>
- https://github.com/OWNER/REPO/security/dependabot/<number>
```

Report the PR URL when done.
