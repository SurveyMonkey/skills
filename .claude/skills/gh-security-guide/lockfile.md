# gh-security: reading declarations from the lockfile

## What a parent declares comes from the lockfile, never from `node_modules/`

`apply_constraint` runs **before** `install`, in a fresh worktree where `node_modules` is
gitignored and absent; Yarn PnP never has one, and pnpm links only direct dependencies into one.
Reading `node_modules/<parent>/package.json` for a parent's alias key therefore found nothing every
time, skipped silently, and wrote the plain package name — which does not govern the aliased copy,
so the escalation ladder re-ran the same lookup and the flow dead-ended
([#48](https://github.com/SurveyMonkey/skills/issues/48)). The declarations come from
`.packages["node_modules/<parent>"]` (npm) and each `resolution:` entry (Berry), through one reader
that `why`, `apply_constraint` and `declared_ranges` all share — the shared reader is what gave
Berry a working alias path at all
([#47](https://github.com/SurveyMonkey/skills/issues/47)). Both read the same three blocks —
`dependencies`, `optionalDependencies` and `peerDependencies` — because a parent that declares the
package as a peer is why the copy is in the tree at all; Berry read only `dependencies` until
[#49](https://github.com/SurveyMonkey/skills/issues/49), which hid exactly that parent.

Two rules travel with it, both of which the old lookup broke:

- **A parent whose declaration cannot be read is named**, in `alias_lookup.parents_unresolved`.
  pnpm has no readable declaration at all — its snapshots record what a dependency resolved to, not
  the key it was declared under — so it reports `source: "unsupported"` rather than guessing.
- **The result states the key and value actually written**, in `written[]`, produced by the same
  pass that writes them. Two copies of that logic is how the report came to say `package`/`range`
  while an alias key had been written, putting an edit in the PR body that was never made.

`declared_ranges` is the one verb that also reads the installed manifest, and it may: it runs
**after** `install`, and the manifest on disk is the state actually installed, which is how a
parent that declares nothing in the release the lockfile recorded is told apart from one nobody
could read. But it is per parent *name*, and a parent in the tree at several versions has one
declaration per copy, each resolving its own copy of the package. Asking one file for a
multi-version parent attributes one copy's range to every line; asking it in a worktree that has
no `node_modules` — Berry PnP, or any fix worktree before `install` — loses the range entirely and
reports the parent as unreadable, which is what happened on a live `brace-expansion` fix
([#85](https://github.com/SurveyMonkey/skills/issues/85)). So the lockfile answers **per parent
copy** whenever the manifest cannot: more than one copy, or no manifest on disk. A manifest that
is on disk and will not parse is a damaged install and stays `parents_unreadable` +
`parents_malformed` rather than falling back — the reviewer needs that fact, not a substitute for
it. pnpm's rows carry no declared range, for the same reason `alias_lookup` reports `unsupported`
for it — its snapshots record what resolved, never the specifier — but they do carry **line
membership**: the child version each parent copy resolves, which is what `--line` classifies on.
Under the isolated store neither of the installed-tree probes can answer that (the child is never
nested under `node_modules/<parent>/`, and the hoisted fallback describes the root's copy), so
every pnpm parent used to land in `parents_unreadable` with `parents_other_lines` empty, and the
overrides written for them collapsed the sibling lines
([#100](https://github.com/SurveyMonkey/skills/issues/100)). An other-line pnpm parent is now
named in `parents_other_lines`; only an on-line copy whose manifest is truly absent stays
`parents_unreadable`, because its range — unlike its line — really is unreadable.

`spec/fixtures/npm-alias` has **no committed `node_modules`** for this reason, and
`spec/fixtures/npm-alias-installed` is a separate specimen of the installed state `declared_ranges`
reads. A fixture carrying a directory that does not exist where the verb runs is not a specimen of
reality, and it is why the suite stayed green through this.

## The TypeScript readers

`plugins/gh-security/src/lockfiles/` has one reader for each format: `npm.ts`, `pnpm.ts` and
`yarn.ts`. `shared.ts` has the parse guard and the answer types. Each reader gives resolved
versions, the resolution map and the parents of a package, as plain data. They port the lockfile
parsers of `node.sh`. The bash parsers stay until #223.
