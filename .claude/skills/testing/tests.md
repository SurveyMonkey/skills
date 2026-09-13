# Good and Bad Tests

Every example below is real and cited by path. The bad ones are not hypotheticals: each is a shape
this suite shipped, and each is paired with what fixed it.

**A PR that deletes a cited spec replaces the citation with its successor example, in the same
PR.** The port retires these files as their replacements land
([#223](https://github.com/SurveyMonkey/skills/issues/223),
[#231](https://github.com/SurveyMonkey/skills/issues/231)), and a citation whose file is gone
takes the lesson with it. `spec/testing_skill_spec.sh` catches the dangling path; only the PR that
removed the file knows what replaced it.

## Good

### The expected value comes from a published spec

`spec/node_semver_spec.sh`, the `ordering` block inside `Describe 'node.sh compare_versions'`.
Three of its fourteen rows:

```sh
Describe 'ordering'
  Parameters
    # left            right             expected result
    ...
    "1.0.0-beta.2"    "1.0.0-beta.11"   -1   # identifiers compare numerically
    "1.0.0-beta.11"   "1.0.0-rc.1"      -1
    "1.0.0-rc.1"      "1.0.0-beta.11"    1   # rc outranks beta
  End

  It "orders $1 against $2"
    When call adapter_jq '.result' compare_versions "$1" "$2"
    The status should be success
    The output should equal "$3"
  End
End
```

Why it is good: the chain is the example from semver.org section 11, so the expected column cannot
be recomputed the way the adapter computes it, and it exists because a real bug shipped here, jq's
`tonumber?` emitting *empty* rather than null for a non-numeric identifier, which dropped that
identifier and reversed `rc.1` against `beta.11`. One `Parameters` row per case means a failure
names the pair that broke. The seam is the adapter CLI, through `adapter_jq`.

### The fixture is built so that dropping the guard is observable

`spec/discover_repos_spec.sh`, `make_workspace` and `lists every immediate checkout root, sorted,
deduped, and nothing else`.

The workspace is real: `git init -q` in a scratch directory for every shape, a bare repository, a
checkout under a dot-directory, one two levels down, one with a space in its name, plus three
symlinks. The expectation is the whole emitted list, built from resolved paths, and a second
`Parameters` block names each shape that must never appear so a leak says which shape leaked
instead of showing up as a diff.

The load-bearing detail is in the fixture, not the assertion: the link `into-elsewhere` points at
`elsewhere/sub`, a subdirectory of a checkout **outside** the workspace. Pointed at a subdirectory
of a checkout the workspace already lists, dropping the root-only guard would change nothing and the
guard would be untested. Pointed where it is, dropping the guard adds `elsewhere` to the answer and
the example fails. See the bad counterpart below, which is the same fixture before that link
existed.

### The assertion is the whole shape, so a removed key stays removed

`spec/discover_alerts_spec.sh`, `emits exactly actionable and skipped`.

```sh
It 'emits exactly actionable and skipped'
  When call discover 'keys'
  The status should be success
  The output should equal '["actionable","skipped"]'
End
```

Why it is good: the rule is that the script answers for one repository, so there is no
`skipped_repos` key for a consumer to read as a cross-repo summary (issue #188). `keys` compared to
an exact array is the only assertion that can see the key come back. A `.actionable` projection, or
a `should include`, passes either way.

## Bad, with the fix

### A count pin a batch-wide regression survives

`spec/resolve_alerts_branch_style_spec.sh`, `maps a refs/heads/fix hit onto --branch-style flat at
every consuming site`.

```sh
It 'maps a refs/heads/fix hit onto --branch-style flat at every consuming site'
  When call phrase_in "$SKILL" '--branch-style flat'
  The status should be success
  The output should equal '2'
End
```

What is wrong: the title claims the flag reaches every consuming site, and the assertion checks
that the string occurs twice anywhere in the file. A rewrite that moves both occurrences into one
phase, or that drops one site and adds a mention somewhere else, keeps the count and keeps the
example green. A batch-wide regression is exactly the mutation a bare total cannot see.

The fix: pin each site where it lives, one example per site with an anchored `rule_in` pattern, so
the failure names the site. Better still, the flag selection is mechanical, so it belongs in a
script and the pin is deleted when that script lands (issues #193 and #197).

### An alternation that matched nothing on macOS

`spec/resolve_alerts_scope_spec.sh`, the `no longer calls a branch name provisional` block.

The pattern started as one `count_in` with a BRE alternation across the three old spellings.
`\|` is a GNU extension; BSD grep reads it as a literal bar, so on macOS the pattern matched
nothing, the count was `0`, and the example was vacuously green. It was green for the prose it was
meant to forbid.

The fix, which is what the file carries now:

```sh
Describe 'no longer calls a branch name provisional'
  Parameters
    'provisional until'
    'is provisional'
    'names are provisional'
  End

  It "carries no $1"
    When call count_in "$SKILL" "$1"
    The status should be success
    The output should equal '0'
  End
End
```

One row per spelling, every pattern in the portable dialect. The general rule: an assertion whose
pass value is `0` has to be shown able to produce a non-zero, on both CI legs, or it is pinning
nothing. `spec/reference_scrub_spec.sh` does this explicitly, carrying a positive control that
proves its own pattern is not vacuous.

### A fixture whose shape never reaches the guard it exists for

`spec/discover_repos_spec.sh`, before the `into-elsewhere` link was pointed out of the workspace.

The root-only guard exists so that a symlink to a checkout's **subdirectory** is not listed as a
checkout root. The fixture had such a link, and the example asserted the link's own name was absent
from the list. But the link pointed into a checkout the workspace already listed, so the entry the
guard suppresses was one the answer contained anyway under its resolved path. Deleting the guard
left the emitted list byte-identical and the suite green.

The fix is the fixture, not the assertion: point the link at `elsewhere/sub`, a checkout no other
shape in the workspace contributes, so removing the guard adds a visible entry. The same failure
mode in prose: the specimen chosen to illustrate the phase-6 exception classified as `kind: alias`,
which phase 2 files as `not-a-version-pin` and never tests, so the documented specimen could not
reach the code path it was about, and no fixture carried the reachable one
(`spec/node_list_pins_spec.sh`, issue #48).

**The test for a fixture is the mutant.** Name the defect it exists for, remove the guard or revert
the fix, and watch the example fail. If it does not, the fixture is decoration.
