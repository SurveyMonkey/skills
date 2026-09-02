// The JS suite covers exactly one thing: the Workflow script under
// plugins/gh-security/workflows/ (ADR 010). Everything else in this
// repository is bash, gated by shellspec and ShellCheck.
//
// `include` is narrow on purpose. spec/fixtures/ carries dozens of
// hand-authored package.json and node_modules trees that are lockfile
// specimens, not project code; a broad default pattern is how a fixture ends
// up being collected, or how a fixture's own manifest gets mistaken for this
// repo's. Keep the pattern anchored at spec/js/.
export default {
  test: {
    include: ['spec/js/**/*.test.mjs'],
    exclude: ['node_modules/**', 'spec/fixtures/**'],
    // A run that collects no files is not a pass. scripts/check.sh js also
    // refuses empty discovery before it gets here; this is the same floor
    // stated to the runner itself.
    passWithNoTests: false,
    // Writes spec/js/generated/workflow.mjs before collection. The test file
    // imports it statically, so it has to exist by then.
    globalSetup: ['spec/js/generate.mjs'],
    coverage: {
      provider: 'v8',
      // The projection of the shipped workflow, and nothing else. The shipped
      // file itself cannot appear here: it is never imported (its contract
      // requires a top-level `return`), so no instrumentation can attribute a
      // line to it — a `//# sourceURL=` pointing at the real path was tried
      // and changes nothing. spec/js/generate.mjs explains the projection and
      // fix-groups.test.mjs asserts it is byte-identical to the regions it
      // copies, which is what makes this number mean the shipped code.
      //
      // The harness and the test file are deliberately outside the set: they
      // are test infrastructure, and measuring them would let an unused
      // helper move the number while no shipped code changed.
      include: ['spec/js/generated/workflow.mjs'],
      // `all` keeps a file with no test at all in the denominator at 0%
      // rather than dropping it from the report entirely.
      all: true,
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
