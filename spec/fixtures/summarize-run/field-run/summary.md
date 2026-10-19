## gh-security resolve-alerts: run summary

**Still vulnerable after this batch (only fix crosses a major):**
- `nx` 20.8.4 in `octo/app` (alerts patched only in the 22.x line). No override bounded to 20.x can fix this; it needs a major bump of the parent that pins it, or dropping that parent.
- `uuid` 11.x: only 8 and 9 are installed; the fix line is 11.x. Skipped before dispatch.
- `@tiptap/core` 3.x: only 2 is installed; the fix line is 3.x. Skipped before dispatch.

| Package | Line | PR | Risk | F4/F5 | Notes |
|---|---|---|---|---|---|
| nx | 22.x | [#2502](https://github.com/octo/app/pull/2502) | Low (1) | 0/0 | scoped-override; resolved 22.7.10 |
| smol-toml | 1.x | none | n/a | n/a | failure: validate. Override `overrides.nx.smol-toml = '>=1.9.0 <2'` written, install left smol-toml 1.6.1 (nx pins exact 1.6.1); lockfile unchanged |
| brace-expansion | 2.x | none | n/a | n/a | failure: worktree. `git fetch origin fix/dependabot-brace-expansion-2x` failed: `Failed to connect to github.com port 443 after 75002 ms`. Network, likely transient |

**Excluded checkouts / registry preflight:** none. Branch style: slash (no flat repos).

**Shared-parent skips:** none.

**Other skips:** open PR exists: webpack-dev-middleware 7.x (#2435), axios 1.x (#2436), qs 6.x (#2437), brace-expansion 5.x (#2439). No fix available: braces, http-cache-semantics, sprintf-js.

**Reap:** 1 of 3 groups came back with an empty `left_behind` (nx 22.x, reaped after PR #2502 read OPEN). post-agent.sh reports these left behind:
- smol-toml 1.x: `/Users/example/src/octo/app/.claude/worktrees/fix-dependabot-smol-toml-1x`, branch `fix/dependabot-smol-toml-1x` (reason: failure)
- brace-expansion 2.x: `/Users/example/src/octo/app/.claude/worktrees/fix-dependabot-brace-expansion-2x`, branch `fix/dependabot-brace-expansion-2x` (reason: failure). The agent's `cleanup` says neither was ever created: "setup failed before any worktree or branch was created".

**Observations:** Note: `octo/app` contains 1 unscoped global override(s): `minimatch`. These may be removable or convertible to scoped pins. `/gh-security:audit-pins` tests removability.
