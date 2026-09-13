# gh-security scripts

Two bash scripts ship from here, and they stay bash
([RFC 002](../../../docs/rfc/002-typescript-port.md), Non-Goals):

- `common/notice-scan.sh`, the PostToolUse notice hook, which runs on every Bash call, where a
  node process start would be a standing cost paid per tool call for a grep.
- `common/detect-capacity.sh`, three machine probes, called once per dispatch.

Anything else still here is mid-port and is being replaced by a TypeScript command under
`../bin/` and `../src/`; the rollout table in RFC 002 says what has moved.

**The conventions, the domain rules and the testing policy are one document,
[`plugins/gh-security/docs/GUIDE.md`](../docs/GUIDE.md)**, whose "Bash during the port" section
carries the bash 3.2 and jq 1.7 targets these two scripts are written to.
