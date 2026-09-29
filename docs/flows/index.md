---
okf_version: "0.2"
---

# Flow index

One directory for each skill, `<plugin>/<skill>/`, with one mermaid diagram in each file
(`.claude/rules/file-skill-md.md`).

| Doc | Description |
|-----|-------------|
| [gh-security/resolve-alerts/_skill-flow.md](gh-security/resolve-alerts/_skill-flow.md) | State and branch map of the resolve-alerts skill's orchestrator: its phases, the user decision points, the branches that exclude a checkout or withdraw a group, and every terminal state of a run. |
| [gh-security/resolve-alerts/fix-dependency-agent-flow.md](gh-security/resolve-alerts/fix-dependency-agent-flow.md) | State and branch map of the fix-dependency subagent: one group's fix, from setup through to an open pull request, with every failure and no-op terminal. |
| [gh-security/audit-pins/_skill-flow.md](gh-security/audit-pins/_skill-flow.md) | State and branch map of the audit-pins skill and its agent: the open security-PR preflight, the mode question, the findings and guards, and the ways a completed audit opens no pull request. |
