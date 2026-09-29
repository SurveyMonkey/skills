// This suite covers the Workflow script under plugins/gh-security/workflows/
// (ADR 010), and the TypeScript that gh-security ships: the shared `lib/`,
// the plugin's `scripts/` entry point and its `src/` (ADR 012). The rest of
// the repository is bash, gated by shellspec and ShellCheck.
//
// `include` is narrow on purpose. spec/fixtures/ carries dozens of
// hand-authored package.json and node_modules trees that are lockfile
// specimens, not project code; a broad default pattern is how a fixture ends
// up being collected, or how a fixture's own manifest gets mistaken for this
// repo's. Keep the patterns anchored at spec/js/ and tests/.
export default {
  test: {
    // spec/js/ is the Workflow script's suite (ADR 010); tests/ is the
    // TypeScript suite, at the mirror of the code it covers (ADR 012,
    // the testing skill, "Layout").
    include: ['spec/js/**/*.test.mjs', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.claude/worktrees/**', '**/fixtures/**'],
    // A run that collects no files is not a pass. scripts/check.sh js also
    // refuses empty discovery before it gets here; this is the same floor
    // stated to the runner itself.
    passWithNoTests: false,
    // Writes spec/js/generated/workflow.mjs before collection. The test file
    // imports it statically, so it has to exist by then.
    globalSetup: ['spec/js/generate.mjs'],
    // Clears the git variables a hook exports, so no example's git call can
    // reach this repository (harness/setup.ts).
    setupFiles: ['harness/setup.ts'],
    coverage: {
      provider: 'v8',
      // The projection of the shipped workflow, and the TypeScript the plugin
      // ships: the entry point under scripts/ is measured with the source
      // under src/ and the shared lib/, because it is a file a user runs and
      // a file the report never names is a file whose regression nothing
      // catches (#224). The shipped workflow file itself cannot appear here:
      // it is never imported (its contract requires a top-level `return`), so
      // no instrumentation can attribute a line to it: a `//# sourceURL=`
      // pointing at the real path was tried and changes nothing.
      // spec/js/generate.mjs explains the projection and fix-groups.test.mjs
      // asserts it is byte-identical to the regions it copies, which is what
      // makes this number mean the shipped code. The TypeScript globs need no
      // such projection: they are imported directly (ADR 012).
      //
      // Vitest 4 reports every file that matches `include` when the whole
      // suite runs, so a file with no test at all is in the denominator at
      // 0% rather than dropped (vitest 4 removed `coverage.all`, #272). The
      // plugin reaches lib/ through its `src/lib` symlink, and v8 reports the
      // real path, so lib/ is named here directly.
      //
      // The harness and the test files are deliberately outside the set: they
      // are test infrastructure, and measuring them would let an unused
      // helper move the number while no shipped code changed.
      include: [
        'spec/js/generated/workflow.mjs',
        'lib/**/*.ts',
        'plugins/gh-security/scripts/**/*.ts',
        'plugins/gh-security/src/**/*.ts',
      ],
      // No file is named here. A branch no test can reach is restructured
      // until it no longer exists, never excluded (the testing skill,
      // "Coverage"; ADR 012). Opening this list is a maintainer decision,
      // argued on its own pull request.
      exclude: [],
      // NOTE: the `text` reporter renders an empty file table here — the
      // projection lives under spec/, which its own default filtering hides,
      // and emptying `exclude` does not restore the row. The JSON summary is
      // correct and complete, so `scripts/check.sh js` reads that and prints
      // the per-file numbers itself rather than leaving a reviewer with a
      // 100% summary above a blank table.
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
}
