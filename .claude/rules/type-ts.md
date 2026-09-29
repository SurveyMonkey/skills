---
paths:
  - "lib/**/*.ts"
  - "harness/**/*.ts"
  - "plugins/**/*.ts"
  - "tests/**/*.ts"
---

# Plugin TypeScript

Plugin code is TypeScript, executed directly by node with type stripping and no build step. The
floor is node 22.18. `docs/rfc/002-typescript-port.md` is the record of the port.
`docs/adr/012-typescript-on-node-22-18.md` covers the runtime. `docs/adr/005-quality-gate-venues.md`
covers where each gate runs. This page is the rules.

## Shape

```
lib/                            # shared across plugins; the only thing that crosses a boundary
plugins/<plugin>/
  scripts/<plugin>.ts           # thin adapter: the node floor check, then the CLI
  src/
    lib -> ../../../lib         # committed symlink
    cli/                        # registry, dispatch, the real io
    subcommands/<command>.ts    # one exported handler per subcommand: the seam
  hooks/
harness/                        # the shared test harness; never shipped
tests/                          # mirrors lib/ and plugins/<plugin>/; never shipped
  lib/<module>.test.ts
  plugins/<plugin>/subcommands/<command>.test.ts
  harness/<module>.test.ts
  repo/                         # checks of this repository's own layout
```

## The command handler is the seam

Parsed arguments, the environment and an injected io in, an envelope out. Everything a command
decides is then reachable in-process, with nothing spawned and no stub binary on `PATH`.

`lib/envelope.ts` has the four outcomes of ADR 001, and they are the exit statuses: `ok` is 0,
`error` is 1, `not-implemented` is 2, and `unsupported` is 3. The adapter contract needs an
unsupported toolchain as its own outcome. A success is JSON on stdout. A failure is
`{"error": ...}` on stdout, with the same message in prose on stderr. A handler can also answer
with silence: exit 0, and nothing written.

## `scripts/` is an adapter

It turns `process.argv` into the handler's arguments and maps the result onto an exit code and a
stream. It holds no decisions, so one spawned contract test covers it.

The directory is `scripts/`, never `bin/`. claude.ai rejects a plugin that carries a top-level
`bin/`, by marketplace sync and by direct upload alike
([org sync](https://claude.com/docs/plugins/org-sync)). While the plugin is enabled, the Bash
tool also adds `bin/` to its own `PATH`. `tests/repo/repo-layout.test.ts` refuses a plugin that
carries one.

The entry point has exactly one static import, `../src/lib/node-floor.ts`. It calls
`assertNodeFloor(process.version)`, and reaches everything else by `await import`, after the
check. The JS engine hoists and evaluates import declarations before any statement runs. So a
second static import would load its whole module graph, on the runtime the guard exists to
refuse.

One registry serves each plugin (`src/cli/registry.ts`): a name, the `--help` line, and a
`load` function that dynamically imports the handler. A command nobody asked for is never
loaded. This matters for a handler that runs on every tool call, such as `allow-own-commands`.
Add a command as a registry entry and a file under `src/subcommands/`. Never change the entry
point for it.

## Tests

- A test lives under `tests/`, at the mirror of the code it covers: `tests/lib/args.test.ts` for
  `lib/args.ts`, `tests/plugins/<p>/subcommands/<command>.test.ts` for
  `plugins/<p>/src/subcommands/<command>.ts`. `.claude/rules/path-plugins.md` says why nothing
  test-only goes in a plugin.
- A test imports plugin code as `#<p>/...` and the harness as `#harness/...`, from the `imports`
  map in the root `package.json`. A plugin test reaches `lib/` as `#<p>/lib/...`, through the
  plugin's symlink, so it sees the same module the plugin sees. The harness reaches `lib/` as
  `#lib/...`.
- A path a test needs on disk (an entry point to spawn, a bash script, a plugin file) comes from
  `harness/paths.ts`, never from `../` counted from the test's own location. The one relative
  import is the entry point test's own `import()` of `scripts/<plugin>.ts`, which `#<p>/*` does
  not map, so that coverage measures the file.
- Fixtures stay in `spec/fixtures/`. The shellspec suite and the vitest suite share them.
- `spec/js/` stays the Workflow script's suite (ADR 010). The script must `return` at top level,
  which no ES module parser accepts.
- How to test (seams, what may be mocked, red first) is the `testing` skill.

## Boundaries

- The committed symlink `plugins/<p>/src/lib -> ../../../lib` is the only path out of a plugin.
  The link target is the exact string `../../../lib`, because that string is what Claude Code's
  installer classifies. `tests/repo/repo-layout.test.ts` enforces it.
- Never reach the root `lib/` around the link. A `../../../lib` import from a plugin file resolves
  in this checkout only. `tests/repo/repo-layout.test.ts` refuses it, and a bare package
  specifier.
- The link resolves for an install from this marketplace: Claude Code dereferences a symlink
  into the cache copy when its target is inside the same marketplace. It does not survive a
  `--plugin-dir` load, a local-path install, or a Windows clone with `core.symlinks=false`.
- Do not use a `#` import in a plugin or in `lib/`. Only the root `package.json` resolves it, and
  that file does not ship.
- Shipped code takes no dependency: node's own built-ins, and nothing else at run time.
- No plugin-level `package.json`. Claude Code runs a dependency install inside the cache copy when
  it finds one with a lockfile, which turns a plugin install into a network fetch.

## Language level

Erasable syntax only: no `enum`, no parameter properties, no namespaces. Node strips types rather
than compile them, and rejects all three at launch with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
`erasableSyntaxOnly` in `tsconfig.json` turns that into a failed gate. Every import names the
`.ts` extension explicitly, which is what node's own resolver reads.

## Coverage

`vitest.config.ts`'s thresholds are the gate: 100 on lines, branches, functions, and statements,
over a named source set.

The gate does not move to fit the code. Do not lower a threshold. Do not add a name to
`coverage.exclude`, even for a file you judge a process boundary or a platform branch. The remedy
for a branch no test can reach is to restructure the code until the branch no longer exists: lift
the decision into a function that takes, as an argument, what it depended on. To open the
exclusion list is a maintainer decision, argued on its own pull request (ADR 012).
