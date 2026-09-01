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
  },
}
