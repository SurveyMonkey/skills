#!/bin/sh
# shellcheck shell=sh
# Scope is the checkouts on disk, and nothing is ever cloned (issue #188,
# ADR 011). Before that, scope came from git but was still a mode (issue
# #134): a null scope asked the user to name an org, their own repos, or one
# repository, discovery went to the API, and a whole phase cloned whatever
# the machine lacked into a destination the user was asked about.
#
# The executable half is spec/discover_repos_spec.sh (the checkout rule) and
# spec/common_scripts_spec.sh (detect-scope.sh reads one checkout's identity
# from origin). This file pins the half that lives in prose, because the
# orchestrator is the only thing that consumes the discovered list, and the
# things this issue removed — the scope question, the clone step, the
# temporary directory and its `rm -rf` grant — were never visible to any
# script (the spec/fix_dependency_branch_spec.sh pattern). A returning clone,
# a returning "which org?" question, or a returning `mktemp` is exactly the
# regression the issue is about, and only a prose pin can see it.
#
# The mechanical rules of phases 1 and 2 are code since #227. The
# `prepare-checkout` and `merge-envelopes` commands run them, and their
# examples are in tests/plugins/gh-security/subcommands/. #227 removed their
# prose pins. SKILL.md still states these rules in prose, with no pin, until
# #237 makes the skill call the commands (ruling 7 of round 5, on #227).

Describe 'scope is the checkouts on disk, in prose (issue #188)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  CMD="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/audit-pins/SKILL.md"

  # A wrapped paragraph is not one grep line, so the file is flattened first.
  phrase_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  # Same reader, named for its other use: a shape that must be ABSENT. `grep
  # -o | wc -l` reports zero without failing on it, which `grep -c` would.
  count_in() { tr '\n' ' ' < "$1" | grep -o -e "$2" | wc -l | tr -d ' '; }
  # A raw-line count, for lines that are never wrapped: the frontmatter and a
  # fenced command.
  rule_in() { grep -c -e "$2" -- "$1"; }

  Describe 'phase 1 takes scope from the discovered checkouts'
    # Existence only: this proves the script is named, not that it runs
    # before anything else (testing skill, "Prose pins" checklist item 6).
    It 'prescribes running discover-repos.sh'
      When call rule_in "$SKILL" 'scripts/common/discover-repos.sh$'
      The status should be success
      The output should equal '1'
    End

    It 'states the rule as the checkouts on disk and nothing else'
      When call phrase_in "$SKILL" 'Scope is the checkouts on disk, and nothing else'
      The status should be success
      The output should equal '1'
    End

    # The two halves of the discovery contract, as the orchestrator has to
    # read them: inside a checkout that root is the whole scope; outside one,
    # the immediate checkout roots and nothing deeper.
    It 'reads a checkout as the whole scope'
      When call phrase_in "$SKILL" 'that checkout.s root and nothing else'
      The status should be success
      The output should equal '1'
    End

    It 'reads a plain directory as its immediate checkout roots, non-recursively'
      When call phrase_in "$SKILL" 'every immediate subdirectory that is itself the root of a checkout'
      The status should be success
      The output should equal '1'
    End

    # Classification is the script's, so the orchestrator never grows a
    # second, drifting reading of the directory.
    It 'forbids the orchestrator from classifying the directory itself'
      When call phrase_in "$SKILL" 'Do not classify the directory yourself; the script already did'
      The status should be success
      The output should equal '1'
    End

    It 'still says scope comes from git rather than from directory names'
      When call phrase_in "$SKILL" 'Scope comes from git, never from what the directories are named'
      The status should be success
      The output should equal '1'
    End

    # An empty list is exit 0 and a stop, not an error and not a question.
    It 'stops on an empty list with the no-repositories sentence'
      When call phrase_in "$SKILL" 'No git repositories directly inside .<cwd>.'
      The status should be success
      The output should equal '1'
    End

    # A non-zero exit is the one failure that is not a checkout to exclude:
    # the scope itself could not be established, so the run stops.
    It 'stops on a non-zero exit because there is no checkout to exclude'
      When call phrase_in "$SKILL" 'the scope itself could not be established, so there is no checkout to exclude'
      The status should be success
      The output should equal '1'
    End

    # Two links to one checkout are one repository, or the same repo is
    # discovered, dispatched and pushed twice.
    It 'reads a symlinked entry once, under its resolved root'
      When call phrase_in "$SKILL" 'A symlinked entry is followed and listed once, under its resolved root'
      The status should be success
      The output should equal '1'
    End

    # A git failure that is not "not a git repository" must never read as an
    # empty scope; the sentence names the shapes so a reader cannot fold them
    # back into "no repositories".
    It 'treats a git failure as an error rather than an empty scope'
      When call phrase_in "$SKILL" 'git itself failed for a reason other than "not a git repository"'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'nothing is ever cloned'
    It 'states the non-goal in phase 1'
      When call phrase_in "$SKILL" 'Nothing is ever cloned'
      The status should be success
      The output should equal '1'
    End

    # The three forms a convenience clone could come back in, each named so
    # a reader cannot reintroduce one as "not really cloning".
    It 'closes every form the convenience could take'
      When call phrase_in "$SKILL" 'Not by default, not behind a flag, not into a directory the user names'
      The status should be success
      The output should equal '1'
    End

    It 'puts cloning on the user'
      When call phrase_in "$SKILL" 'A repository the user wants in scope is one they clone themselves'
      The status should be success
      The output should equal '1'
    End

    # Fewer checkouts than the org has repositories is the answer, not a
    # shortfall to make up for.
    It 'says a partial set of checkouts is the correct scope'
      When call phrase_in "$SKILL" 'that is the answer, not a shortfall'
      The status should be success
      The output should equal '1'
    End

    # The mechanisms the clone step needed. Each is pinned at zero because
    # its reappearance is the whole regression: a clone, a temporary
    # directory to put it in, and the removal that cleaned it up.
    Describe 'the clone machinery is gone from the skill'
      Parameters
        clone-command        'gh repo clone'
        temp-directory       'mktemp'
        temp-directory-name  'gh-security-clones'
        recursive-removal    'rm -rf'
        destination-question 'where new clones go'
        destination-default  'as the suggested default'
      End

      It "carries no $1"
        When call count_in "$SKILL" "$2"
        The status should be success
        The output should equal '0'
      End
    End
  End

  Describe 'the scope question is gone'
    It 'no longer asks what to operate on'
      When call count_in "$SKILL" 'Ask what to operate on'
      The status should be success
      The output should equal '0'
    End

    # The three answers the question used to offer, and the discovery modes
    # behind two of them. `--scope` covers the discover-alerts.sh flag that
    # carried org and user discovery to the API.
    Describe 'none of the old modes survive'
      Parameters
        org-option    'This org'
        user-option   'My repos'
        named-repo    'One repo.*repo scope against a repo the user names'
        scope-flag    '--scope'
        org-scope     'org scope'
        user-scope    'user scope'
        api-skips     'skipped_repos'
        push-filter   'push access'
      End

      It "no longer mentions the $1"
        When call count_in "$SKILL" "$2"
        The status should be success
        The output should equal '0'
      End
    End

    It 'says there is no org, login, or question left'
      When call phrase_in "$SKILL" 'There is no org to name, no login to resolve, and no question to ask here'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'a script failure costs what the script was run for'
    # The preamble's old rule was "if one fails, report its error and stop",
    # which contradicts per-checkout exclusion. Now a run-level script stops
    # the run and a per-checkout script excludes the checkout.
    It 'splits the failure rule by what the script was run for'
      When call phrase_in "$SKILL" 'What a failure costs depends on what the script was run for'
      The status should be success
      The output should equal '1'
    End

    It 'stops the run on a run-level script'
      When call phrase_in "$SKILL" 'A run-level script (.discover-repos.sh., .detect-capacity.sh.) failing means report its error and stop'
      The status should be success
      The output should equal '1'
    End

    It 'excludes the checkout on a per-checkout script'
      When call phrase_in "$SKILL" 'failing means report its error and exclude that checkout'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'every checkout is resolved before anything is asked'
    # The ordering the field run behind the issue was missing: a group was
    # approved, then withdrawn once its checkout existed. With every checkout
    # present up front the plan the user approves is final.
    It 'resolves every checkout before phase 3'
      When call phrase_in "$SKILL" 'before phase 3 asks anything, so the plan the user approves is final'
      The status should be success
      The output should equal '1'
    End

    It 'settles branch names and classification before the question'
      When call phrase_in "$SKILL" 'every branch name is settled and every group is classified before it is offered'
      The status should be success
      The output should equal '1'
    End

    It 'no longer hedges that an offered group may be withdrawn'
      When call count_in "$SKILL" 'may still be withdrawn'
      The status should be success
      The output should equal '0'
    End

    # Phase 8 still calls a fresh PR's check state provisional, which is a
    # different claim; the pin is on branch names, at each old spelling. One
    # row per spelling rather than a BRE alternation: `\|` is a GNU extension
    # that BSD grep reads as a literal bar, so a single alternated pattern is
    # vacuously green on macOS.
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

    It 'no longer speaks of a clone destination'
      When call count_in "$SKILL" 'clone destination'
      The status should be success
      The output should equal '0'
    End

    # The prefix is instantiated against the checkout: there is no
    # destination directory any more, and no ordering hazard between the
    # prefix and a directory that does not exist yet.
    It 'instantiates a path-taking prefix against the checkout itself'
      When call phrase_in "$SKILL" 'instantiate it against the checkout itself'
      The status should be success
      The output should equal '1'
    End

    # env_prefix is per checkout too; a batch-wide prefix is the regression a
    # multi-checkout run invites.
    It 'resolves env_prefix per checkout, so neighbors can differ'
      When call phrase_in "$SKILL" 'two neighbors can differ'
      The status should be success
      The output should equal '1'
    End

    # Phase 2 withdraws before asking; phase 4 then presents settled names.
    It 'withdraws a doomed group before the question is ever asked'
      When call phrase_in "$SKILL" 'before the question is ever asked'
      The status should be success
      The output should equal '1'
    End

    It 'presents branch names as final in the phase 4 plan'
      When call phrase_in "$SKILL" 'shows each group.s .branch_name., and it is final'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'an unusable checkout is excluded, not the run'
    It 'states the exclusion rule once'
      When call phrase_in "$SKILL" 'An excluded checkout never ends the run on its own'
      The status should be success
      The output should equal '1'
    End

    It 'continues with the others and stops only when none survive'
      When call phrase_in "$SKILL" 'stop only when no checkout survives'
      The status should be success
      The output should equal '1'
    End

    # The single-checkout case is the degenerate one, not a separate mode.
    It 'reads a lone excluded checkout as the old report-and-stop'
      When call phrase_in "$SKILL" 'With one checkout in scope that is the same "report and stop" it always was'
      The status should be success
      The output should equal '1'
    End

    # Exclusion is loud, in phase 2 and again in phase 7, so a repository
    # silently left out of the batch never happens.
    It 'reports every excluded checkout by name in phase 2'
      When call phrase_in "$SKILL" 'Report every excluded checkout by name'
      The status should be success
      The output should equal '1'
    End

    # pin: mechanical, retired by summarize-run.sh
    It 're-reports every excluded checkout in the phase 7 summary'
      When call phrase_in "$SKILL" 're-report every checkout phase 1 or phase 2 excluded, by name, and every repo phase 5.s registry preflight excluded'
      The status should be success
      The output should equal '1'
    End

    # pin: mechanical, retired by preflight-repo.sh
    It 'excludes a repo whose adapter detect fails in phase 5'
      When call phrase_in "$SKILL" 'a non-zero exit there excludes every one of that repo.s groups'
      The status should be success
      The output should equal '1'
    End

    # pin: mechanical, retired by summarize-run.sh
    It 'carries the registry exclusions into the phase 8 closing report'
      When call phrase_in "$SKILL" 'every repo phase 5.s registry preflight excluded, and what would unblock each'
      The status should be success
      The output should equal '1'
    End

    # One pr-status.sh call cannot carry two prefixes, and two checkouts can
    # resolve different ones.
    # pin: mechanical, retired by pr-status.sh --env-prefix
    It 'reads PR status once per repo, under that repo prefix'
      When call phrase_in "$SKILL" 'group the URLs by repo and make one call per repo, under that repo.s .env_prefix.'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'the Repo column follows the number of checkouts'
    # Three tables show it, and each hides it only when it could not differ
    # between rows.
    It 'omits the column for one checkout and shows it for several'
      When call phrase_in "$SKILL" 'Omit the .Repo. column when one checkout is in scope'
      The status should be success
      The output should equal '3'
    End

    It 'no longer keys the column on a scope mode'
      When call count_in "$SKILL" 'Repo. column at repo scope'
      The status should be success
      The output should equal '0'
    End
  End

  Describe 'the audit command reads the same contract'
    It 'branches on a null scope'
      When call phrase_in "$CMD" 'If .scope. is null'
      The status should be success
      The output should equal '1'
    End

    It 'drops the git_remote cross-check it can no longer make'
      When call count_in "$CMD" 'disagrees with .nwo., trust'
      The status should be success
      The output should equal '0'
    End

    It 'stops on a null nwo'
      When call phrase_in "$CMD" 'this checkout has no usable .origin.; report that and stop'
      The status should be success
      The output should equal '1'
    End

    # The first detect-scope output described a path in no repository, so
    # every field of it is null. Continuing from the checkout the user names
    # means reading a second output, or the two paragraphs below stop the
    # audit on a null that describes the wrong path.
    It 're-runs detect-scope against the checkout the user names'
      When call phrase_in "$CMD" 'Re-run .detect-scope.sh <that checkout>. and read .nwo., .default_branch.'
      The status should be success
      The output should equal '1'
    End

    It 'reads the second output rather than the first'
      When call phrase_in "$CMD" 'from the second output.., never from the first'
      The status should be success
      The output should equal '1'
    End

    # The audit stays repo-scoped whatever resolve-alerts does, and says so
    # in the new vocabulary rather than the org/user one.
    It 'stays repo-scoped in the checkout vocabulary'
      When call phrase_in "$CMD" 'stays so even when .resolve-alerts. runs across several checkouts'
      The status should be success
      The output should equal '1'
    End
  End
End
