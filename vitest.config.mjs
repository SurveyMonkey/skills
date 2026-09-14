// This suite covers the Workflow script under plugins/gh-security/workflows/
// (ADR 010) and the TypeScript source under plugins/gh-security/ (ADR 012).
// The rest of the repository is bash, gated by shellspec and ShellCheck.
//
// `include` is narrow on purpose. spec/fixtures/ carries dozens of
// hand-authored package.json and node_modules trees that are lockfile
// specimens, not project code; a broad default pattern is how a fixture ends
// up being collected, or how a fixture's own manifest gets mistaken for this
// repo's. Keep the pattern anchored at spec/js/ and spec/ts/.
export default {
  test: {
    // spec/js/ is the Workflow script's suite (ADR 010); spec/ts/ is the
    // TypeScript suite (ADR 012, #216 decision 5). Both anchors are explicit
    // for the same reason: spec/fixtures/ carries dozens of hand-authored
    // package.json and node_modules trees, and a broad default pattern is how
    // one of those ends up collected as this repository's own code.
    include: ['spec/js/**/*.test.mjs', 'spec/ts/**/*.test.ts'],
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
      // The projection of the shipped workflow, and the TypeScript source the
      // plugin ships. The shipped workflow file itself cannot appear here: it
      // is never imported (its contract requires a top-level `return`), so no
      // instrumentation can attribute a line to it: a `//# sourceURL=`
      // pointing at the real path was tried and changes nothing.
      // spec/js/generate.mjs explains the projection and fix-groups.test.mjs
      // asserts it is byte-identical to the regions it copies, which is what
      // makes this number mean the shipped code. The TypeScript glob needs no
      // such projection: it is imported directly (ADR 012).
      //
      // The harness and the test files are deliberately outside the set: they
      // are test infrastructure, and measuring them would let an unused
      // helper move the number while no shipped code changed.
      include: ['spec/js/generated/workflow.mjs', 'plugins/gh-security/src/**/*.ts'],
      // A file that genuinely cannot reach 100 (a process boundary or a
      // platform branch) is named here with a comment saying why, never
      // dropped from `include` instead: the number is never lowered to
      // accommodate it, because a silently-narrowed `include` hides that
      // file's regression the same way an empty file set would (ADR 012,
      // #211).
      exclude: [
        // node-floor.ts's own comments explain why: `parseVersion`'s regex
        // captures three mandatory `(\d+)` groups inside a `^...$` anchored
        // match, so a successful match always populates all three, and
        // `assertNodeFloor`'s loop only ever indexes 0, 1 and 2 into two
        // fixed-length 3-tuples. The `?? 0` after each index exists only
        // because `noUncheckedIndexedAccess` cannot see either guarantee;
        // the fallback branch it introduces is provably unreachable at
        // runtime, and closing it needs a source change (a non-null
        // assertion in place of the fallback, or a `v8 ignore` comment),
        // which is out of scope for #211.
        'plugins/gh-security/src/lib/node-floor.ts',
      ],
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
