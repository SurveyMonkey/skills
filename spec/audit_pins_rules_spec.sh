#!/bin/sh
# shellcheck shell=sh
# Rules agents/audit-pins.md states as prose, checked against the adapter output
# they read.
#
# The adapter can only carry the fact; the verdict is the definition's. A spec
# that stops at the adapter's JSON passes while the hazard survives, so each
# example below pairs the number the adapter emits with the sentence in the
# definition that acts on it. Its sibling spec/audit_restore_spec.sh does the
# same for phase 4 step 7's two git commands.

Describe 'the audit rules that read a partially-parsed map'
  After 'cleanup_fixture'

  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"

  # A single unreadable locator passes the ratio guard and removes its package
  # from both snapshots, so the step-6 diff sees no change and `[]` claims
  # nothing else moved — the stronger of the two claims, about a package nobody
  # audited (issue #48). Both halves have to hold: the map has to say so, and
  # the definition has to turn that into `null` + `not-checked`.
  # Every ecosystem owes the same number, because the rule below is written
  # once and acts on all of them. npm's count was derived from a *different*
  # predicate than its map rows — `.value.version != null` against the rows'
  # extra leading-digit test — so a `{"version":"v1.2.3"}` entry left the map
  # while the coverage field still said full coverage, and the hazard this
  # whole pairing exists to close was open on npm by construction (issue #49).
  Describe 'the count that the rule reads'
    Parameters
      yarn-partial-read
      npm-partial-read
    End

    It "has an adapter that reports the unread count in $1"
      use_fixture "$1"
      When call adapter_jq '.unreadable_entries > 0' resolution_map
      The status should be success
      The output should equal 'true'
    End
  End

  rule() { grep -c "$1" "$AGENT"; }

  It 'has a definition that maps a non-zero count onto collateral_changes null'
    When call rule 'unreadable_entries` is'
    The status should be success
    The output should equal '1'
  End

  It 'has a definition that maps a non-zero count onto not-checked'
    When call rule 'unreadable_entries` non-zero'
    The status should be success
    The output should equal '1'
  End

  # The phase-6 alias carve-out used to be illustrated with a `kind: alias`
  # pin, which phase 2 files `not-a-version-pin` and never tests, so the
  # illustration named a pin the audit cannot reach (issue #48).
  It 'illustrates the alias carve-out with a pin phase 2 actually tests'
    When call rule '^">=4.18.0"` is a version pin'
    The status should be success
    The output should equal '1'
  End

  It 'says the alias-valued form never reaches that comparison'
    When call rule 'never reaches this comparison'
    The status should be success
    The output should equal '1'
  End
End

# The removal PR (issue #72) is where a finding stops being words and becomes a
# deletion in someone's repository, so the definition's own guards are what
# stand between a plausible per-pin verdict and a bad merge. Each example below
# names one guard and fails if the sentence carrying it leaves the file.
Describe 'the rules that gate the removal PR'
  AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"

  # Two readers, because a wrapped paragraph is not one grep line. `rule_in`
  # counts lines and suits a sentence that fits on one; `phrase_in` flattens
  # the file first and suits anything the 100-column wrap may split. The
  # earlier "first option and the recommended" example passed only because
  # SKILL.md happened to wrap after the last word it matched.
  rule_in() { grep -c -e "$2" -- "$1"; }
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  # `grep -c` exits 1 on no match, which is the expected answer for a shape
  # that must be ABSENT, so this one reports the count without failing on it.
  count_in() { grep -c -e "$2" -- "$1" || true; }

  # Phases 4 and 5 test one pin per install, on purpose, which is exactly why
  # no set has ever been installed together, and a PR removes a set. Without
  # this sentence the PR would ship N individually-tested deletions as one
  # untested operation, which is the `removable-individually` hazard wearing a
  # commit.
  It 'requires the combined test before any PR'
    When call rule_in "$AGENT" 'never removes a set that was not installed and judged as a set'
    The status should be success
    The output should equal '1'
  End

  # Attempt 1 has to be the maximal set. An attempt 1 that already excluded the
  # individually-tested pins would never answer the sibling question, and
  # attempt 2 would be the same set twice.
  It 'puts the individually-tested pins in attempt 1'
    When call rule_in "$AGENT" 'includes the individually-tested pins as well'
    The status should be success
    The output should equal '1'
  End

  # A single unreadable locator drops its package from both snapshots, so the
  # diff reports no change for it. In report mode that degrades to a narrower
  # claim; here it would ship a deletion nothing checked, so it fails closed.
  It 'fails an attempt closed on a partially-read map'
    When call rule_in "$AGENT" 'fails the attempt closed'
    The status should be success
    The output should equal '1'
  End

  # Attempt 2 is the narrowing fallback. Keeping the individually-tested pins
  # in it would re-run the set that just failed, minus nothing that mattered.
  It 'narrows attempt 2 by dropping the individually-tested pins'
    When call rule_in "$AGENT" 'drops every pin whose finding was'
    The status should be success
    The output should equal '1'
  End

  # Attempt 2 measured against a tree still carrying attempt 1's removals is a
  # result about neither set, and nothing downstream can see that: the
  # manifest is still valid, the install still succeeds, and both parsers read
  # a lockfile they have no way to know is wrong.
  It 'restores the tree between the two attempts'
    When call rule_in "$AGENT" 'Restore the tree before attempt 2'
    The status should be success
    The output should equal '1'
  End

  # An Edit that silently matched nothing installs the manifest you started
  # with, and every downstream step then reports the set as removed. The
  # adapter is the only thing that can say what the manifest now declares.
  It 'verifies the edits landed before the combined install'
    When call rule_in "$AGENT" 'Verify the edits landed before installing'
    The status should be success
    The output should equal '1'
  End

  # An install that did not finish is a fact about the environment, not about
  # the pins, so narrowing the set in response turns a registry timeout into a
  # smaller PR nobody asked for, and a resolution_map read off a half-written
  # lockfile is worse still, because it parses.
  It 'routes a failed combined install to the compose phase'
    When call phrase_in "$AGENT" 'failure result (phase .compose.) quoting the install error'
    The status should be success
    The output should equal '1'
  End

  # A broken advisory lookup says nothing about the pins, so it must not read
  # as "the set is not removable". Attempt 2 would ask the same broken tool the
  # same question and record its silence as a second verdict.
  It 'routes a broken advisory lookup to the advisories phase, not a failed attempt'
    When call rule_in "$AGENT" 'quoting the error, not a failed attempt'
    The status should be success
    The output should equal '1'
  End

  # PRs open ready for review, so the checkpoint is the dispatch approval and
  # the review itself (ADR 008), and the agent's work ends at `gh pr create`.
  # Merging is a human decision on GitHub; arming auto-merge is that same
  # decision made in advance, which is the chain that merged
  # arsenalamerica/app#233 unread when the flow still had a promote step.
  It 'forbids the agent from merging its own PR or arming auto-merge'
    When call rule_in "$AGENT" 'Never merge the PR, never enable auto-merge on it'
    The status should be success
    The output should equal '1'
  End

  It 'creates the PR on the plugin-owned head'
    When call rule_in "$AGENT" '--head chore/dependabot-remove-pins --label security'
    The status should be success
    The output should equal '1'
  End

  # The inverse of the assertion this replaced, and the reason it is asserted
  # on the whole file rather than on the create line: `--draft` reintroduced
  # anywhere here restores a flow nothing else in the plugin implements any
  # more, so the PR would sit as a draft with no phase left to promote it.
  It 'passes no --draft, anywhere'
    When call count_in "$AGENT" '--draft'
    The status should be success
    The output should equal '0'
  End

  # The agent cannot ask which mode was meant, and the two differ by whether a
  # PR is opened against a real repository: report silently discards work the
  # dispatcher asked for, pr opens a PR nobody approved.
  It 'refuses to default the mode'
    When call rule_in "$AGENT" 'never defaulted, and an unrecognized value'
    The status should be success
    The output should equal '1'
  End

  # Report mode has to leave the repository untouched. Without an explicit
  # stop, phases 7 and 8 read as unconditional and report mode would commit.
  It 'stops report mode before the PR phases'
    When call rule_in "$AGENT" 'mode you stop here'
    The status should be success
    The output should equal '1'
  End

  # The lease has to name the sha the remnant guard verified. A bare
  # --force-with-lease leases against the local remote-tracking ref, which any
  # fetch in that checkout silently advances, so in a recently-fetched
  # repository it passes over commits nobody has seen: exactly the case the
  # guard exists to catch, waved through by the flag meant to catch it.
  It 'leases the push against the verified sha, not the tracking ref'
    When call rule_in "$AGENT" '--force-with-lease=chore/dependabot-remove-pins:'
    The status should be success
    The output should equal '1'
  End

  # And the sha has to have been verified against a closed PR of this plugin's
  # own making. Without that, "the name is owned by this plugin" is an
  # assumption, and acting on it destroys whatever a human put there.
  It 'verifies a remnant against a closed PR head before touching it'
    When call phrase_in "$AGENT" 'must equal the .headRefOid. of one of those closed PRs'
    The status should be success
    The output should equal '1'
  End

  # `branch -D` must not have its stderr silenced. The error that matters is a
  # branch checked out in another worktree, which means a sibling agent or the
  # user is on it right now, and `2>/dev/null || true` swallows precisely that.
  It 'does not silence the branch delete'
    When call count_in "$AGENT" 'branch -D chore/dependabot-remove-pins 2>/dev/null'
    The status should be success
    The output should equal '0'
  End

  # The field-test gaps (#78, #79, #81). Each of these was read two ways, or
  # not at all, by a live run: the failure mode is a plausible-looking result
  # produced by an agent following the doc as written, which no adapter output
  # can catch. The sentence is the mechanism, so its absence is the regression.
  Describe 'the rules the live runs found missing'
    It 'forbids bypassing a repository hook on commit or push (#78)'
      When call phrase_in "$AGENT" 'Never bypass one'
      The status should be success
      The output should equal '1'
    End

    It 'makes a hook failure a failure result rather than something to edit around (#78)'
      When call phrase_in "$AGENT" 'Never edit code, tests or configuration to satisfy a hook'
      The status should be success
      The output should equal '1'
    End

    # `--before` had a documented rule for the several-versions case and
    # `--after` had none, so prusa-connect-auto-ready#40 chose one on its own.
    It 'defines --after when a removal admits several versions (#79a)'
      When call phrase_in "$AGENT" '--after. is the \*\*highest\*\* of them'
      The status should be success
      The output should equal '1'
    End

    # 26 @esbuild/* packages moved as collateral and one was sampled with no
    # rule permitting it; the honest verdict is the whole point.
    It 'rules on a platform-binary collateral fan-out (#79b)'
      When call phrase_in "$AGENT" 'checked, not sampled, unless it is a platform-binary family'
      The status should be success
      The output should equal '1'
    End

    It 'requires the sampled verdict to say it sampled (#79b)'
      When call rule_in "$AGENT" 'sampled-family'
      The status should be success
      The output should equal '3'
    End

    # A trailing comma left by removing the last entry in an override block
    # produced an invalid manifest that only `jq` would have caught cleanly.
    It 'validates the manifest after the edit, before list_pins (#79c)'
      When call rule_in "$AGENT" 'jq \. package\.json'
      The status should be success
      The output should equal '2'
    End

    It 'templates a direct-commit provenance ref (#79d)'
      When call rule_in "$AGENT" 'Refs: https://github\.com/<nwo>/commit/<sha>'
      The status should be success
      The output should equal '1'
    End

    # Read both ways across two runs: app#303 put still-required findings in
    # left_behind, tacoma.fyi#77 left the section empty with findings present.
    It 'keeps still-required findings out of left_behind, in the schema (#81)'
      When call phrase_in "$AGENT" 'never appears in .left_behind.'
      The status should be success
      The output should equal '1'
    End

    It 'says the same in the PR body template (#81)'
      When call phrase_in "$AGENT" 'only\* for candidates an attempt excluded'
      The status should be success
      The output should equal '1'
    End

    It 'states the element type of fixed_alerts (#81)'
      When call phrase_in "$AGENT" 'array of alert numbers as bare'
      The status should be success
      The output should equal '1'
    End

    # A live run created the git worktree at $WORK itself, on top of the
    # scratch area, reading the shorthand as naming the worktree.
    It 'says no worktree is created at the workspace root (#79)'
      When call phrase_in "$AGENT" 'no git worktree is ever created at'
      The status should be success
      The output should equal '1'
    End
  End

  # The PR-state rules, in the other agent definition they govern. Both agents
  # open pull requests; the fix agent opens far more of them, since every alert
  # group dispatches one while the audit rides a spare slot. Asserting these on
  # audit-pins.md alone left the higher-traffic path unguarded, and a mutation
  # run proved it: `--draft` restored to fix-dependency.md's `gh pr create`, and
  # `gh pr ready` plus `gh pr merge --auto` added to pr-status.sh, passed the
  # full suite green (#87).
  Describe 'the PR-state rules in fix-dependency (#87)'
    FIX_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

    # Paired deliberately with the presence assertion below. An absent-string
    # assertion alone passes when the line it guards is gone entirely, so on its
    # own it cannot tell "no --draft" from "no gh pr create".
    It 'passes no --draft, anywhere'
      When call count_in "$FIX_AGENT" '--draft'
      The status should be success
      The output should equal '0'
    End

    It 'still creates the PR, so the absence above is about the flag'
      When call rule_in "$FIX_AGENT" 'gh pr create --repo <nwo> --head <branch_name> --label security'
      The status should be success
      The output should equal '1'
    End

    # arsenalamerica/app#233 came out of THIS flow: a draft somebody armed
    # auto-merge on, which the deleted promote step then merged unread. The
    # sentence is the only thing standing where the draft flag used to.
    It 'forbids merging its own PR or arming auto-merge'
      When call phrase_in "$FIX_AGENT" 'Never merge the PR, never enable auto-merge on it'
      The status should be success
      The output should equal '1'
    End
  End

  # The same hook rule, in the other agent definition it governs. Both flows
  # commit and push into repositories carrying lefthook or husky.
  Describe 'the repository hook rule in fix-dependency (#78)'
    FIX_AGENT="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"

    Parameters
      "forbids bypassing one"    'Never bypass one'
      "forbids editing around it" 'Never edit code, tests or configuration to satisfy a hook'
      "says the hooks run"       "own commit and push hooks are the repository's, and they run"
    End

    It "$1"
      When call phrase_in "$FIX_AGENT" "$2"
      The status should be success
      The output should equal '1'
    End
  End

  # ADR 006 decided only that no agent *chooses* to run the repository's
  # checks. A hook the repository attached runs automatically, which the
  # Consequences section did not distinguish and nothing else covered.
  It 'records the hook distinction in ADR 006 (#78)'
    When call phrase_in "$SHELLSPEC_PROJECT_ROOT/docs/adr/006-merge-risk-is-static-analysis.md" \
      "A repository's own git hooks still run"
    The status should be success
    The output should equal '1'
  End

  # PR mode first at every dispatch point, because the audit already did the
  # work a removal PR needs; a report-first default makes a human re-derive the
  # diff by hand, which is the step most likely to be skipped entirely.
  Describe 'PR mode leads the choice wherever the mode is asked'
    Parameters
      "$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/commands/audit-pins.md"
      "$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
    End

    It "offers it first in $1"
      When call phrase_in "$1" 'first option and the recommended one'
      The status should be success
      The output should equal '1'
    End
  End
End
