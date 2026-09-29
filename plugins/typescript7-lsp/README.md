# typescript7-lsp

Runs TypeScript 7's native language server (`tsc --lsp --stdio`) from the project's
`node_modules/typescript`. It covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and
`.cjs`.

Replaces `typescript-lsp@claude-plugins-official`, which needs the `tsserver.js` TypeScript 7 no
longer ships
([anthropics/claude-plugins-official#4492](https://github.com/anthropics/claude-plugins-official/issues/4492)).
Disable it: if both are enabled, the first registered server handles the files and the other never
starts.

```json
{
  "enabledPlugins": {
    "typescript7-lsp@skills": true,
    "typescript-lsp@claude-plugins-official": false
  }
}
```

## Requirements

- `node` on `PATH`.
- `typescript` 7+ at `${CLAUDE_PROJECT_DIR}/node_modules/typescript` (install first). Use
  `typescript-lsp` for TypeScript 6 or older.

Without that path the server fails to start, and Claude Code reports it. Causes include Yarn
Plug'n'Play, pnpm `node-linker=pnp`, or a custom pnpm `modules-dir`. Another cause is a pnpm
(isolated) monorepo with `typescript` only in a workspace package.
