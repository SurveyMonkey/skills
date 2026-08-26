#!/bin/sh
# shellcheck shell=sh
# `env_prefix` is an opaque, optional seam (issue #135).
#
# The plugin used to name one environment manager and construct its prefix
# itself: phase 1 and phase 5 probed for a `.envrc` at or above `repo_root`
# and built `direnv exec <repo_root>` from what they found, and the agent
# definitions explained the composition rules in that manager's terms. A
# generally applicable skill cannot assume one manager, or that per-directory
# environments exist at all, so the derivation is gone and the prefix is now
# taken verbatim from session context or absent.
#
# None of that is visible to a script, so it is pinned here in prose, the same
# way spec/resolve_alerts_scope_spec.sh pins the scope rules. The verdict
# assertion is the absence scan at the bottom: a reintroduced probe or a
# reintroduced vocabulary fails the suite rather than waiting for a reviewer to
# notice that the seam has grown a mechanism again. The failure class the seam
# guards against is manager-agnostic and must survive every rewording, so the
# retry-and-diagnose contract phrases are pinned alongside it.

Describe 'env_prefix as an opaque seam (issue #135)'
  SKILL="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/skills/resolve-alerts/SKILL.md"
  CMD="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/commands/audit-pins.md"
  CONV="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/scripts/CLAUDE.md"
  FIXER="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/fix-dependency.md"
  AUDITOR="$SHELLSPEC_PROJECT_ROOT/plugins/gh-security/agents/audit-pins.md"

  # A wrapped paragraph is not one grep line, so the file is flattened first.
  # The indent of a continuation line survives that flattening as a run of
  # spaces, so the runs are squeezed too and every pattern here is written
  # with single spaces. NOTE: this copy deliberately differs from the
  # same-named helpers in spec/audit_pins_rules_spec.sh and
  # spec/resolve_alerts_scope_spec.sh, which do not squeeze; a pattern moved
  # between these files without checking its spaces can silently stop
  # matching.
  phrase_in() { tr '\n' ' ' < "$1" | tr -s ' ' | grep -o -e "$2" | wc -l | tr -d ' '; }

  Describe 'the definition is a command prefix and nothing more'
    Parameters
      "$CONV"    'scripts/CLAUDE.md'
      "$SKILL"   'SKILL.md phase 1'
      "$CMD"     'the audit-pins command'
    End

    It "defines env_prefix opaquely in $2"
      When call phrase_in "$1" 'command prefix the environment requires for repo-targeted'
      The status should be success
      The output should equal '1'
    End
  End

  It 'gives the convention document the seam as its section title'
    When call phrase_in "$CONV" 'env_prefix. is an opaque, optional seam'
    The status should be success
    The output should equal '1'
  End

  It 'makes where a prefix comes from the environment, not the plugin'
    When call phrase_in "$CONV" 'is the user'"'"'s environment'"'"'s concern'
    The status should be success
    The output should equal '1'
  End

  It 'says the plugin never names a manager, probes, or invents a prefix'
    When call phrase_in "$CONV" \
      'never names an environment manager, probes the filesystem for one, or invents a prefix'
    The status should be success
    The output should equal '1'
  End

  # The opacity is a property of the consumer, not of the whole plugin. The
  # dispatcher has to recognize a context statement and instantiate it against
  # a directory; an unscoped "never construct one" reads as forbidding the act
  # phase 5 requires.
  It 'scopes the opacity to the agent rather than to the dispatcher'
    When call phrase_in "$CONV" 'The opacity is the agent.s, not the dispatcher.s'
    The status should be success
    The output should equal '1'
  End

  It 'says the dispatcher resolves once and nothing re-derives afterwards'
    When call phrase_in "$CONV" 'never re-derived, by the dispatcher or by any agent it dispatches'
    The status should be success
    The output should equal '1'
  End

  Describe 'the orchestrator takes the prefix from session context'
    It 'says so at repo scope, in phase 1'
      When call phrase_in "$SKILL" 'take it from your session context'
      The status should be success
      The output should equal '1'
    End

    It 'says so per repo, in phase 5'
      When call phrase_in "$SKILL" 'whatever prefix your session context states for the'
      The status should be success
      The output should equal '1'
    End

    It 'says so in the audit-pins command'
      When call phrase_in "$CMD" 'Take it from your session context'
      The status should be success
      The output should equal '1'
    End

    # A stated prefix is commonly path-parameterized, so phase 5 has to say
    # which directory it is instantiated against. The checkout is the wrong
    # answer: step 2 creates it, under this very prefix, so a prefix naming it
    # fails on the clone that would bring it into existence.
    It 'instantiates a path-taking prefix against the destination, not the checkout'
      When call phrase_in "$SKILL" \
        'instantiate it against the destination directory this run chose, never'
      The status should be success
      The output should equal '1'
    End

    # A context statement is prose in someone else's file, so what counts as
    # one has to be stated or the dispatcher silently resolves no prefix and
    # every symptom in the #33 list follows.
    It 'gives phase 1 a recognition cue for what counts as a statement'
      When call phrase_in "$SKILL" \
        'names a wrapper command for tools run in a directory tree is such a statement'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'absence means bare, not a wrapping of the agent'"'"'s own'
    Parameters
      "$FIXER"   'fix-dependency'
      "$AUDITOR" 'audit-pins'
    End

    It "keeps the run-bare rule in the $2 agent"
      When call phrase_in "$1" 'commands bare, with no wrapping of your own'
      The status should be success
      The output should equal '1'
    End

    It "keeps the verbatim rule in the $2 agent"
      When call phrase_in "$1" 'prepend it verbatim, do not re-derive it, and never reason'
      The status should be success
      The output should equal '1'
    End

    # Scoped to the agent, matching the convention document: what the agent
    # may not do is re-derive, and the reason is that someone else already
    # did the deriving.
    It "tells the $2 agent the prefix is opaque to it specifically"
      When call phrase_in "$1" 'It is opaque to you.*: your dispatcher resolved it'
      The status should be success
      The output should equal '1'
    End

    # The prohibition survives the rewording: it is about what a command
    # prefix can exec, which is true of any of them.
    It "keeps the builtin prohibition in the $2 agent"
      When call phrase_in "$1" 'prefix wraps a command, not a shell builtin'
      The status should be success
      The output should equal '1'
    End

    It "points the $2 agent at the renamed convention section"
      When call phrase_in "$1" 'env_prefix. is an opaque, optional seam'
      The status should be success
      The output should equal '1'
    End
  End

  Describe 'composition is unchanged: after the cd, never instead of it'
    It 'keeps the injects-not-chdir sentence in phase 1'
      When call phrase_in "$SKILL" 'it injects the environment, it does not chdir'
      The status should be success
      The output should equal '1'
    End

    # The registry preflight is the general safety net and keeps its shape
    # exactly; only the manager's name left the sentence.
    It 'keeps the cd load-bearing in the registry preflight'
      When call phrase_in "$SKILL" 'The .cd. is load-bearing and .env_prefix. cannot replace it'
      The status should be success
      The output should equal '1'
    End

    It 'keeps the composed probe shapes opaque'
      When call phrase_in "$SKILL" 'cd <repo_root> && <env_prefix> <pm_exec> view <package> version'
      The status should be success
      The output should equal '2'
    End
  End

  Describe 'the failure class survives the de-coupling'
    Parameters
      "$CONV"  'scripts/CLAUDE.md'
      "$SKILL" 'SKILL.md phase 1'
      "$CMD"   'the audit-pins command'
    End

    It "states it manager-agnostically in $2"
      When call phrase_in "$1" 'interactive shell hooks that .*non-interactive tool shell.* never run'
      The status should be success
      The output should equal '1'
    End
  End

  # The symptom list closes the loop back to resolution: absence is not
  # self-evidently benign, so the symptoms have to name the missed statement
  # as one of their causes.
  It 'names a missed context statement as a cause of those symptoms'
    When call phrase_in "$CONV" 'An absent prefix has two causes and only one of them is benign'
    The status should be success
    The output should equal '1'
  End

  It 'sends the reader back to session context on any of them'
    When call phrase_in "$CONV" 're-read session context for a prefix you missed'
    The status should be success
    The output should equal '1'
  End

  # The verdict. `git grep` (no `--cached`) scans working-tree content of
  # tracked files under the pathspec, so a probe reintroduced in any plugin
  # file — prose, script, or fixture — trips this.
  Describe 'no environment manager is named anywhere in the plugin'
    manager_words() {
      git -C "$SHELLSPEC_PROJECT_ROOT" grep -nEi \
        -e 'direnv' -e 'envrc' -- 'plugins/gh-security'
    }

    # Positive control: the same pattern over the whole tree must find
    # something, or a broken pattern would let the scan above pass
    # vacuously. The repository's own root CLAUDE.md documents the
    # maintainer's workspace, which is exactly the material that left the
    # plugin, and its Environment section is the anchor the assertion below
    # depends on: if that section is ever reworded away, this control needs a
    # new anchor rather than deletion, or the scan above starts passing for
    # the wrong reason.
    manager_words_repo_wide() {
      git -C "$SHELLSPEC_PROJECT_ROOT" grep -nEi -e 'direnv' -e 'envrc'
    }

    It 'finds no environment-manager vocabulary under plugins/gh-security'
      When call manager_words
      The status should equal 1
      The output should equal ''
      The stderr should equal ''
    End

    It 'still matches those words elsewhere in the tree'
      When call manager_words_repo_wide
      The status should equal 0
      The output should include 'CLAUDE.md:'
      The stderr should equal ''
    End
  End
End
