---
paths:
  - "**/plugins/gh-security/**"
---

# gh-security

- Before you change, review or port anything in this plugin, invoke the `gh-security-guide`
  skill and read the file for your task. Where the code disagrees with the skill, the skill wins
  ([RFC 002](../../docs/rfc/002-typescript-port.md)).
- **Zero resolved versions is an error, never a pass.** Any code path that treats "found nothing"
  as success is a bug.
