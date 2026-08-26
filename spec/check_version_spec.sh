#!/bin/sh
# shellcheck shell=sh
# The version gate: `scripts/check.sh version`. A plugin's version lives in its
# own plugin.json and nowhere else, so nothing but this gate notices when
# changed plugin code would reach users at a version string they already have.
#
# Every example builds a real throwaway repository with real commits, because
# the gate's whole subject is git history: the merge base against the default
# branch, the manifest as it stood there, and which paths the range touched.
# Nothing here reaches the network; the "remote" is a local ref plus a
# symbolic-ref, which is exactly what `git clone` leaves behind.

Describe 'scripts/check.sh version'
  CHECK="$SHELLSPEC_PROJECT_ROOT/scripts/check.sh"

  # A repository at the state a stack branches from: one plugin at 1.0.0,
  # committed, with origin/main and origin/HEAD pointing at it.
  version_repo() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || return 1
    git init -q .
    git config user.email 'gates@example.invalid'
    git config user.name 'Gates'
    git config commit.gpgsign false
    write_plugin example 1.0.0
    mkdir -p .claude-plugin
    printf '{"name":"example-marketplace"}\n' > .claude-plugin/marketplace.json
    printf 'base\n' > README.md
    git add -A
    git commit -qm 'base'
    git update-ref refs/remotes/origin/main HEAD
    git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  }

  write_plugin() {
    mkdir -p "plugins/$1/.claude-plugin"
    printf '{"name":"%s","version":"%s"}\n' "$1" "$2" \
      > "plugins/$1/.claude-plugin/plugin.json"
  }

  commit_all() {
    git add -A
    git commit -qm "$1"
  }

  After cleanup_fixture

  Describe 'the comparison against the default branch merge base'
    Before version_repo

    It 'fails when a plugin changed with no version bump'
      printf 'changed\n' > plugins/example/skill.md
      commit_all 'touch the plugin'
      When run "$CHECK" version
      The status should eq 1
      The output should include 'comparing against refs/remotes/origin/main'
      The stderr should include 'files changed'
      The stderr should include 'still 1.0.0'
      The stderr should include 'base: 1.0.0'
      The stderr should include 'nowhere else'
      The stderr should include 'Releasing a plugin'
    End

    It 'passes when the same change carries a bump'
      printf 'changed\n' > plugins/example/skill.md
      write_plugin example 1.1.0
      commit_all 'touch the plugin and release it'
      When run "$CHECK" version
      The status should be success
      The output should include 'plugins/example: 1.0.0 -> 1.1.0'
    End

    It 'passes a change that touches no plugin at all'
      printf 'docs\n' > README.md
      commit_all 'docs only'
      When run "$CHECK" version
      The status should be success
      The output should include 'unchanged since'
      The output should include 'no bump required'
    End

    It 'passes a plugin added since the base, which has no version to differ from'
      write_plugin newcomer 0.1.0
      commit_all 'add a second plugin'
      When run "$CHECK" version
      The status should be success
      The output should include 'plugins/newcomer: added since'
      The output should include 'plugins/example: unchanged'
    End

    It 'names only the plugin that failed when another one is clean'
      write_plugin sibling 2.0.0
      commit_all 'add a sibling'
      git update-ref refs/remotes/origin/main HEAD
      printf 'changed\n' > plugins/example/skill.md
      printf 'changed\n' > plugins/sibling/skill.md
      write_plugin sibling 2.1.0
      commit_all 'touch both, release one'
      When run "$CHECK" version
      The status should eq 1
      The output should include 'plugins/sibling: 2.0.0 -> 2.1.0'
      The stderr should include 'plugins/example: files changed'
      The stderr should not include 'plugins/sibling: files changed'
    End

    It 'ignores an uncommitted bump, because only committed state can land'
      printf 'changed\n' > plugins/example/skill.md
      commit_all 'touch the plugin'
      write_plugin example 1.1.0
      When run "$CHECK" version
      The status should eq 1
      The output should include 'comparing against'
      The stderr should include 'still 1.0.0'
    End
  End

  # Every example above branches from the tip of origin/main, where the merge
  # base and the base tip are the same commit and the gate cannot tell them
  # apart. Here they differ: origin/main moves on after the branch point,
  # carrying a release of its own. Comparing against the tip instead of the
  # merge base would attribute that release to the branch under test, so
  # dropping the merge base is only visible from this shape.
  Describe 'a default branch that moved on after the branch point'
    diverged_repo() {
      version_repo || return 1
      git branch branch-point
      # main advances: someone else's plugin change, released.
      printf 'landed elsewhere\n' > plugins/example/theirs.md
      write_plugin example 1.1.0
      commit_all 'a release that landed on the default branch'
      git update-ref refs/remotes/origin/main HEAD
      git checkout -q branch-point
    }
    Before diverged_repo

    It 'passes a docs-only branch, whose range holds no plugin change of its own'
      # Against the tip this is 1.1.0 vs 1.1.0 over a range that includes the
      # other release's files, which reads as a violation the branch did not
      # commit.
      printf 'docs\n' > README.md
      commit_all 'docs only, from before the release'
      When run "$CHECK" version
      The status should be success
      The output should include 'plugins/example: unchanged since'
    End

    It 'still fails a branch that touches a plugin without bumping it'
      printf 'mine\n' > plugins/example/mine.md
      commit_all 'plugin change, no bump, from before the release'
      When run "$CHECK" version
      The status should eq 1
      The output should include 'comparing against'
      The stderr should include 'still 1.0.0'
      The stderr should include 'base: 1.0.0'
    End
  End

  # One bump per stack is the rule, so the verdict must depend on whether the
  # layer under test carries it, not on how many layers sit below.
  Describe 'a stack whose single bump sits mid-way'
    stacked_repo() {
      version_repo || return 1
      printf 'layer one\n' > plugins/example/one.md
      commit_all 'layer one: plugin change, no bump'
      git branch layer-one
      printf 'layer two\n' > plugins/example/two.md
      write_plugin example 1.1.0
      commit_all 'layer two: the bump'
      git branch layer-two
      printf 'layer three\n' > plugins/example/three.md
      commit_all 'layer three: plugin change above the bump'
      git branch layer-three
    }
    Before stacked_repo

    # The verdict lands on stdout when it passes and stderr when it fails, so
    # the streams are merged here rather than parameterizing which one to read.
    version_output() {
      "$CHECK" version 2>&1
    }

    Parameters
      layer-one 1 'files changed since'
      layer-two 0 '1.0.0 -> 1.1.0'
      layer-three 0 '1.0.0 -> 1.1.0'
    End

    Example "$1 is judged by whether its own tip carries the bump"
      git checkout -q "$1"
      When call version_output
      The status should eq "$2"
      The output should include "$3"
    End
  End

  Describe 'the comparison base'
    Before version_repo

    It 'accepts an explicit CHECK_VERSION_BASE, as the workflow passes'
      # The push-to-the-default-branch venue: the base is the sha the push
      # moved from, so the range is exactly what that merge added.
      before=$(git rev-parse HEAD)
      printf 'changed\n' > plugins/example/skill.md
      commit_all 'a merge landing plugin changes with no bump'
      export CHECK_VERSION_BASE="$before"
      When run "$CHECK" version
      The status should eq 1
      The output should include "comparing against $before"
      The stderr should include 'still 1.0.0'
    End

    It 'refuses a CHECK_VERSION_BASE that resolves to nothing'
      export CHECK_VERSION_BASE=refs/heads/no-such-branch
      When run "$CHECK" version
      The status should eq 2
      The stderr should include 'does not resolve to a commit'
    End

    It 'refuses when HEAD and the base share no history'
      git checkout -q --orphan unrelated
      printf 'unrelated\n' > README.md
      git add -A
      git commit -qm 'unrelated root'
      When run "$CHECK" version
      The status should eq 2
      The stderr should include 'share no history'
    End

    It 'falls back to the one obvious candidate when origin/HEAD is unset, loudly'
      git symbolic-ref -d refs/remotes/origin/HEAD
      When run "$CHECK" version
      The status should be success
      The stderr should include 'origin/HEAD is not set'
      The stderr should include 'git remote set-head origin --auto'
      The output should include 'refs/remotes/origin/main'
    End

    It 'refuses when origin/HEAD is unset and there is no candidate at all'
      git symbolic-ref -d refs/remotes/origin/HEAD
      git update-ref -d refs/remotes/origin/main
      When run "$CHECK" version
      The status should eq 2
      The stderr should include 'cannot determine a default branch'
      The stderr should include 'CHECK_VERSION_BASE=<ref>'
    End

    It 'refuses when origin/HEAD is unset and main and master both exist'
      git symbolic-ref -d refs/remotes/origin/HEAD
      git update-ref refs/remotes/origin/master HEAD
      When run "$CHECK" version
      The status should eq 2
      The stderr should include 'exactly one candidate'
      The stderr should include 'cannot determine a default branch'
    End
  End

  Describe 'a manifest it cannot read a version out of'
    Before version_repo

    It 'refuses a manifest that carries no version at all'
      printf '{"name":"example"}\n' > plugins/example/.claude-plugin/plugin.json
      commit_all 'drop the version'
      When run "$CHECK" version
      The status should eq 2
      The output should include 'comparing against'
      The stderr should include 'carries no .version'
    End

    It 'refuses a manifest that is committed but not JSON'
      printf 'name: example\nversion: 1.1.0\n' \
        > plugins/example/.claude-plugin/plugin.json
      commit_all 'a manifest jq cannot parse'
      When run "$CHECK" version
      The status should eq 2
      The output should include 'comparing against'
      The stderr should include 'could not read a version'
    End

    It 'treats a base manifest with no version as a release, labelled (none)'
      # Gaining a version IS a release act: whatever the base carried, users
      # did not have this version string, which is the only question the gate
      # asks. Only the label needs care, hence (none) rather than a gap.
      printf '{"name":"example"}\n' > plugins/example/.claude-plugin/plugin.json
      commit_all 'a base with no version'
      git update-ref refs/remotes/origin/main HEAD
      write_plugin example 1.1.0
      commit_all 'give it one'
      When run "$CHECK" version
      The status should be success
      The output should include 'plugins/example: (none) -> 1.1.0'
    End

    It 'refuses a manifest present in the tree but never committed'
      # Discovery reads the working tree, both versions come out of git, and
      # an uncommitted manifest cannot be released; saying so beats a
      # git error nobody can act on.
      printf 'changed\n' > plugins/example/skill.md
      commit_all 'touch the plugin'
      git rm -q --cached plugins/example/.claude-plugin/plugin.json
      git commit -qm 'untrack the manifest'
      When run "$CHECK" version
      The status should eq 2
      The output should include 'comparing against'
      The stderr should include 'is not committed at HEAD'
    End
  End

  Describe 'empty discovery refuses instead of passing'
    It 'fails when no plugin carries a manifest'
      version_repo
      git rm -rq plugins
      commit_all 'remove every plugin'
      When run "$CHECK" version
      The status should eq 2
      The stderr should include 'no plugin manifests found'
    End
  End
End
