# gh-security: judging a removal

## A removal is judged against the whole tree, not one package

An override is not scoped in its effects the way its key is scoped in its syntax. Lifting one
changes dedup and hoisting and can let a peer conflict resolve differently, so removing a pin on A
can move B. `resolved_versions A` cannot see that, and the `removable` verdict it produces is
correct about A and silent about the tree it was tested in
([#42](https://github.com/SurveyMonkey/skills/issues/42)).

`resolution_map` is the whole-lockfile answer, and the audit diffs it across every removal.
Anything else that judges a tree change reads it the same way. Two rules travel with it:

- **Zero entries is an error here too, and for a sharper reason.** A diff against an empty map
  reports every package unchanged — "found nothing" meaning "all clear" once more, this time
  wearing the shape of a clean diff. **Guard on what the parser read, never on what a line
  count found.** The yarn count counted `resolution: "` lines while the rows had to survive two
  more filters, so a lockfile parsed to nothing reported `lockfile_entries: 3, package_count: 0` and
  exit 0 ([#46](https://github.com/SurveyMonkey/skills/issues/46)). A parser therefore separates
  "read it and excluded it" from "could not read it" and refuses when the recognized share
  collapses — a ratio and not a zero-check, because an all-local repository legitimately resolves
  to no registry version and a *partial* parse passes a zero-check.
- **A verdict says what it covers.** When the map is unavailable the audit still runs, but its
  findings say the claim is about the named package only. A narrower finding is a smaller result;
  a finding that outruns what was checked is a wrong one. The guard is a *ratio*, so a single
  unreadable locator passes it and drops its package from both snapshots — no change in the diff,
  and `[]` is the stronger claim. `resolution_map` therefore reports `unreadable_entries`, and
  `agents/audit-pins.md` maps any non-zero value onto `collateral_changes: null` +
  `collateral_verdict: not-checked` ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
- **Every parser owes three answers, not two**, and "deliberately excluded" is the one that keeps
  getting forgotten: an npm workspace link (`link: true`, no `version`) and a pnpm `link:`, `file:`
  or git entry belong with Berry's `workspace:` and `portal:` locators, not in the unread count.
  Counting them as unread hard-failed ordinary monorepos with a "the parser is broken" diagnosis,
  which stops the audit and fails the fix flow's baseline
  ([#48](https://github.com/SurveyMonkey/skills/issues/48)).
- **A package is identified by what it resolves to, never by where it sits**, and identically in
  `resolution_map` and `resolved_versions` — the audit reads a disagreement between them as a
  parser bug. Berry's `patch:` locator percent-encodes the descriptor it wraps, and npm keys an
  `npm:` alias by the alias with the real name in `.name`; matching a literal `@npm:` or reading
  the `node_modules/` path lost the first entirely and mislabeled the second
  ([#44](https://github.com/SurveyMonkey/skills/issues/44)). Neither tripped the zero-entry guard,
  because the entry count is nonzero and the map merely looks healthy — which is the whole reason
  to state the identity rule rather than leave it to each parser. The **install key** answers too,
  in `resolved_versions` only: it is what an override entry for an aliased dependency names, so it
  is what `list_pins` hands the audit, and `present: false` there is read as "the package left the
  tree". That is the single place the two verbs differ about a name, it is documented in ADR 001,
  and `apply_constraint` writes the same key so the copy can also be moved
  ([#46](https://github.com/SurveyMonkey/skills/issues/46)). Answering under both names has one
  documented consequence: a real package sharing its name with another entry's install key has its
  versions merged into one answer. **On the read path** the direction is fail-safe and the audit
  names the shape. **On the write path it is not**: `apply_constraint` retargets the colliding
  declaration in place, turning `"lodash": "npm:underscore@^1.13.6"` into
  `"npm:underscore@^4.17.21"` — a version of `underscore` that does not exist — while the copy the
  caller meant goes unmoved. The adapter cannot tell the two senses apart there either, so
  `written[]` reports what it wrote and `agents/fix-dependency.md` fails the run on a written
  `npm:` value naming a package other than the one passed
  ([#49](https://github.com/SurveyMonkey/skills/issues/49)). See ADR 001's alias exception.

## Removability is judged against the advisory database, never repo alert history

`check-advisories.sh` unions the vulnerable ranges of **every published advisory** for a package
and, given `--version`, returns a verdict for one candidate version. The bash script also needs
`--adapter`. The CLI command takes the adapter from `--ecosystem`. The pin audit
has no other source for "is this version safe", and the reason is structural: a pin keeps
vulnerable versions out of the lockfile, so every advisory published after the pin produced no
alert on that repository. Asking the repo's own alert history is asking "was anything reported
while we were protected", whose answer is no by construction.

Its four verdicts exist because three different things get mistaken for safety. `safe` means
advisories exist, every range was evaluated, and none admits the version. `unknown` means a range
could not be read — never folded into `safe`, since an unreadable range is exactly where an
unnoticed match hides. `no-advisories` means the query succeeded and returned nothing, which a
non-security pin, a misspelled package name, and the wrong ecosystem all produce identically.

When the adapter itself fails on a range, the message of the failed verb (stderr, for the bash
script) is kept in `adapter_errors[]` rather than discarded. The verdict is unchanged — an unevaluated range is never folded into `safe` — but a
broken adapter otherwise turned every pin in the audit inconclusive with nothing naming the cause.
