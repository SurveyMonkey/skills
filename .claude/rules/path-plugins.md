---
paths:
  - "plugins/**"
  - "lib/**"
---

# Plugin Directories

Claude Code copies a plugin's whole directory, and `lib/` through `src/lib`, into each user's
cache. So a plugin directory holds only files an installed plugin uses at run time.

- Tests go in `tests/plugins/<plugin>/`, at the mirror of `src/`. Tests of `lib/` go in
  `tests/lib/`. The shared harness is `harness/`, and fixtures are in `spec/fixtures/`.
- Documentation goes under `docs/`, not in the plugin. Flow diagrams go in
  `docs/flows/<plugin>/<skill>/` (`.claude/rules/file-skill-md.md`).
- No `CLAUDE.md` in a plugin. `claude plugin validate --strict` refuses one at the plugin root.
  Anywhere else, the name promises memory semantics the file does not have.
- The component names are `commands`, `agents`, `skills`, `hooks`, `output-styles`, `workflows`,
  `themes`, `monitors`, `bin` and `evals`. Give a directory one of these names only when it is
  that component at the plugin root. Do not use `commands/`: use `skills/`. Do not use `bin/`: use
  `scripts/` (`.claude/rules/type-ts.md`).
- No `#` import in a plugin or in `lib/`: only the root `package.json` resolves it, and it does not
  ship.

`tests/repo/repo-layout.test.ts` enforces this.
