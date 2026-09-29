---
paths:
  - "lib/**/*.ts"
  - "plugins/**/*.ts"
---

# Plugin TypeScript

Shipped code is TypeScript that node 22.18 or newer runs directly, with no build step (ADR 012).

```
lib/                            # shared across plugins; the only thing that crosses a boundary
plugins/<plugin>/
  scripts/<plugin>.ts           # thin adapter: the node floor check, then the CLI
  src/
    lib -> ../../../lib         # committed symlink
    cli/                        # registry, dispatch, the real io
    subcommands/<command>.ts    # one exported handler per subcommand: the seam
  hooks/
```

- A command is an exported handler: parsed arguments, the environment and an injected io in, an
  envelope out. `lib/envelope.ts` has the four ADR 001 outcomes, which are the exit statuses:
  `ok` 0, `error` 1, `not-implemented` 2, `unsupported` 3. A handler may also answer with
  silence: exit 0, nothing written.
- The entry point is `scripts/<plugin>.ts`, never `bin/`. It holds no decisions, and has exactly
  one static import, `../src/lib/node-floor.ts`. Everything else loads by `await import` after
  the floor check.
- Add a command as an entry in `src/cli/registry.ts`, with a `load` that dynamically imports the
  handler, and a file under `src/subcommands/`. Never change the entry point for it.
- The committed symlink `plugins/<p>/src/lib -> ../../../lib`, that exact string, is the only
  path out of a plugin. Never import the root `lib/` around it, and never use a `#` import in
  `lib/` or a plugin.
- Shipped code takes no run-time dependency beyond node's built-ins. No plugin-level
  `package.json`.
- Erasable syntax only: no `enum`, parameter properties or namespaces. Every import names its
  `.ts` extension.

`tests/repo/repo-layout.test.ts` enforces the layout. Tests follow the `testing` skill. The
reasoning behind each rule is in the `plugin-design` skill (`typescript.md`).
