---
okf_version: "0.2"
---

# RFC index

| Doc | Description |
|-----|-------------|
| [001-alert-orchestration.md](001-alert-orchestration.md) | Converts gh-security from a single-shot fix command into an orchestrated multi-agent workflow with scripted deterministic work, worktree-isolated fix subagents, and per-PR merge-risk ratings. |
| [002-typescript-port.md](002-typescript-port.md) | Moves the gh-security plugin's deterministic layer off bash 3.2 and jq onto TypeScript executed directly by Node 22.18 or newer, keeping the domain rules and the fixture corpus as the requirements and running both implementations against them until each bash script is retired. |
