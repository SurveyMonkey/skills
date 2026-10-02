# gh-security: override scoping

## An override's key is scoped; its effect is not, and only a baseline sees the difference

The pin audit already knows this on the removal side. The fix side learned it the hard way: a
scoped entry can move a copy of the package on a major line the group does not own, and every
check in the fix flow was scoped to `--line` and structurally unable to notice
([#83](https://github.com/SurveyMonkey/skills/issues/83)). The fix flow's `--baseline` is
snapshotted after a no-change control install, so the diff measures only apply-attributable
movement; snapshotted before any install, a stale default-branch lockfile's ambient re-resolution
gets attributed to the fix ([#146](https://github.com/SurveyMonkey/skills/issues/146)).

The mechanism is per-manager, and Yarn's is the one that bites. Verified empirically against a
throwaway worktree of a real repository, and against Yarn's `reduceDependency` hook:

- **Yarn** compares the `from` half of a `resolutions` key by `locatorHash` equality against the
  parent's **resolved locator**. A bare `minimatch/brace-expansion` falls back to the parent's own
  reference, so it matches every copy of `minimatch` — that is the defect. Only the parent's exact
  resolved version narrows (`minimatch@npm:10.2.5/...`, protocol optional). A **range** there
  parses and then silently never matches: no warning, exit 0, nothing applied. That is a worse
  failure than the collapse, and it is why "just narrow the key" is not a one-line fix.
- **pnpm** matches `parent@^10>dep` with `semver.satisfies` against the parent's resolved version.
  An exact version there narrows the key to one copy, and `apply_constraint` uses it: a pnpm
  parent the lockfile resolves at more than one version gets **version-qualified keys**
  (`minimatch@10.2.5>brace-expansion`), one per parent version whose resolution of the child sits
  on the target line, read from the same `snapshots:` edges `declared_ranges --line` classifies
  with. A bare key there matched every copy of the parent, which is how `ws` 7.x/8.x and
  `brace-expansion` 1.x each collapsed their sibling lines on the field run; the qualified form is
  the one five shipped field PRs validated with `other_line_moves: []`
  ([#100](https://github.com/SurveyMonkey/skills/issues/100)). No qualified key matches a copy
  of the parent from outside the registry, such as a git copy (`debug@git+ssh://git@...`,
  `debug@git+https://...`). So when such a parent must get qualified keys,
  the TypeScript `apply_constraint` refuses before it writes, and names the parent
  ([#50](https://github.com/SurveyMonkey/skills/issues/50), ruling 2). A single-version parent keeps the
  bare key — nothing else exists for it to leak onto. A multi-version parent can still receive
  the bare key on two fallback paths — no parent version qualifies for the target line, or none
  of its snapshot keys carries a readable version — because an entry that over-covers beats
  writing nothing. The exact-version form is a deliberate staleness tradeoff: it is the shape the
  field PRs validated, and a later bump of a parent copy inertly un-matches its key rather than
  dragging the new copy onto the wrong line; re-running the fix refreshes it. The same snapshots
  record only what each copy *resolved*, never the specifier it was declared with, so a
  multi-copy pnpm parent keeps its per-copy line while its declared ranges stay unread
  (`parents_unreadable`) — under pnpm the risk score sees fewer declared ranges than under npm or
  yarn. yarn stays unqualified: its narrowing needs the full resolved locator (above).
- **npm** matches `{"parent@^10": {...}}` with `semver.intersects` on the edge's descriptor and
  `semver.satisfies` on the node's resolved version, and its nesting is transitive rather than
  direct-child-only. `apply_constraint` qualifies npm parents the same way it qualifies pnpm's: a
  multi-version parent gets one nested key per copy whose resolution of the child sits on the
  target line, keyed by the copy's **exact resolved version**, which every edge that resolved
  that copy admits (a version satisfying a range always intersects it) while a sibling line's
  edges admit it only when their declared ranges span majors. The one exception is empirically
  forced (npm 11.16.0, issue #132): npm hard-fails the install with `EOVERRIDE` on any override
  key whose selector intersects a **direct dependency's** spec without being byte-identical to
  it, so the copies satisfying the root manifest's own declared spec share a single key carrying
  that spec verbatim, and that key also covers every other edge whose range admits such a copy,
  because two ranges sharing a version always intersect. Declared-range qualifiers for the
  general case were considered and rejected on the same evidence: two same-major ranges
  (a grandparent's `^10.0.3` beside the root's `^10.2.5`) intersect each other, which is exactly
  the `EOVERRIDE` shape. Same fallbacks as pnpm, in both directions: a single-version parent and
  a parent with no qualifying copy keep the bare nested key, and the same staleness tradeoff
  applies, since a later bump of a parent copy inertly un-matches its exact key rather than
  dragging the new copy onto the wrong line. The carve-out's hard edges each have a fixed route:
  a root spec that ALSO admits an off-line copy of the parent (`*`, `>=3`, a cross-major `||`)
  is refused outright before anything is written, because no key satisfies the byte-identical
  rule and the line separation at once; a root spec the range readers cannot judge (a dist-tag,
  `file:`, a tarball URL, `workspace:*`, an `npm:` alias) and a parent copy whose lockfile
  version is unreadable or not plain semver all fall back to the bare key; and a prerelease copy
  is never counted covered by the root spec (node-semver excludes prereleases from plain ranges)
  and takes its own exact key. A pre-existing bare nested key for the same parent and child is
  superseded and reported in `superseded_keys` when it pins this line, because npm inserts it
  first into the OverrideSet and it would leave the qualified keys inert, and the call refuses
  when that key pins a DIFFERENT line, since deleting it strips that line's protection and
  keeping it smothers this fix.

  One shape sits outside that whole top-level algorithm: an override-placed parent, one a
  pre-existing rule names as a child key of another rule (`{"A": {"B": "<range>"}}`). npm scopes
  such a node to the rule that placed it, so a top-level key never matches it, qualified or bare,
  and a constraint written there is silently inert (field-verified across three clean reinstalls,
  issue #147). `apply_constraint` therefore nests the new entry inside the placing rule, the
  `"."` self key carrying the parent's own range, and only when the lockfile corroborates the
  rule: its root and every intermediate segment must appear, in order, in a parent copy's logical
  ancestor chain, with each segment's selector (the child key's own included) checked against the
  installed copy's version by the same `satisfies` the qualifiers use, so a rule that merely
  spells the parent's name, or whose selector cannot match the installed chain, places nothing
  and the ordinary top-level write proceeds. A parent with both placed and normally-resolved
  copies composes both shapes, which cannot collide since each matches only its own copies, and
  `--tighten-bare` composes the same way: the placing rule's pin tightens in place, plus the
  covering top-level key when normal copies exist. The shapes no verified key form serves are
  refused outright, naming the rule: a rule placing the parent through an `npm:` alias child key,
  a version-qualified child key as the placing rule (when its selector does match installed
  copies), a rule whose reach also spans other major lines of the child, a dead different-line
  top-level pair for a fully placed parent, and a different-line pin already inside the placing
  rule.

So `validate --baseline` detects rather than prevents, and that ordering is deliberate: detection
is the guard that has to exist under any of the three narrowing schemes, including the one that
fails open. `other_line_moves` is `null` when no baseline was passed and `[]` when one was and
nothing moved — the same "not checked" versus "checked and clean" distinction the audit draws with
`collateral_changes: null`, and for the same reason. Only majors **present in the baseline** are
compared; a major that first appears after the install is the install adding a copy, not this fix
moving one. Detection is only as honest as its baseline: `agents/fix-dependency.md` snapshots it
after a no-change control install precisely because a stale default-branch lockfile otherwise
attributes ambient re-resolution to the fix
([#146](https://github.com/SurveyMonkey/skills/issues/146)) — the adapter deliberately does not
loosen for it. Each entry also carries a `class`, `"fatal"` or `"benign_dedup"` (with
`--sibling-alerts`, a within-major dedup no sibling alert can reach); `validate`'s own `ok` keys on
whether any entry's `class` is `"fatal"`, not on the array being non-empty.

The parent list is the second route to the same damage. `why` has no `--line` and answers about
the package as a whole, so `agents/fix-dependency.md` narrows to `declared_ranges --line`'s
`parents_read` before calling `apply_constraint`. A parent in `parents_other_lines` never receives
a scoped entry: on a live run, passing all of `undici`'s parents for the 6.x group would have
pinned `@vercel/sandbox` (7.28.0) and `vercel` (5.29.0) under `>=6.28.0 <7`.
