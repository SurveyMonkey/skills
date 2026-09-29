// Runs before every test file (vitest.config.ts `setupFiles`).
//
// A git hook runs with GIT_DIR and GIT_INDEX_FILE, and in a linked worktree
// more, pointing at the repository being committed to. The process runner
// passes the inherited environment to every child, so under a hook each git
// call an example makes, including the scratch repositories that
// harness/git-repo.ts builds, would act on this repository instead. On #273
// that wrote `core.bare = true` and a test identity into the real
// `.git/config`, and moved a worktree's HEAD. With these gone, an example
// sees what it sees in CI, whatever started the suite.

for (const name of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]) {
  delete process.env[name]
}
