# When to Mock

**Mock at the system boundary and nowhere else.** In this repository the boundary is `gh`, the one
thing a spec cannot run for real because it is the network and someone else's state.

Everything else is used for real:

- **Not a sibling script.** `discover-alerts.sh` calling `classify-lines.sh`, the driver calling
  `fix-group.sh`, a skill's pipeline: run the real one. A mocked collaborator tests the caller
  against a shape nothing emits, which is how two scripts that each pass their own suite disagree
  in the field.
- **Not an adapter.** `node.sh` is reached through `adapter_jq`, as its callers reach it.
- **Not git.** Fixtures are real `git init` repositories in scratch directories
  (`spec/discover_repos_spec.sh`), including the shapes that are supposed to fail: a bare
  repository, a `.git` with no traverse permission, a checkout missing `HEAD`, a pointer file whose
  gitdir is gone, and where the shape needs one, a real mount.
- **Not the filesystem.** Real files, real directories, real symlinks, real permission bits, copied
  per example by `use_fixture` so a mutating verb never touches the committed fixture.
- **Not `jq`, not `bash`, not the package managers.** Specs never hit the network and never run an
  install; where a package manager would have to run, the script's seam is a JSON input instead.

The one other thing mocked in the suite is the machine itself: `uname`, `sysctl` and `nproc` in
`spec/detect_capacity_spec.sh`, because the concurrency cap is a function of the host's cores and
RAM, which is exactly as unfakeable and as external as the network. Both those mocks read their
answers from environment variables so one mock serves every `Parameters` row. Anything beyond `gh`
and that trio needs a comment saying which boundary it is.

## How `gh` is mocked

**Today**, each spec that needs `gh` builds its own shellspec `Mock gh` block: a `case` on the
leading arguments, a log appended to a file under `$MOCK_DIR`, and fail switches read from stub
files. Five files carry one (`spec/discover_alerts_spec.sh`, `spec/render_pr_spec.sh`,
`spec/pr_status_spec.sh`, `spec/check_advisories_spec.sh`, `spec/post_agent_spec.sh`), they have
already drifted from each other, and a generic dispatcher is the shape this skill warns about:
mocking requires conditional logic inside the mock, and a reader cannot tell from an example which
endpoints it exercises.

Two rules those blocks already get right and any replacement must keep:

- **An unhandled endpoint fails loudly.** `spec/pr_status_spec.sh` logs the call *before* refusing
  it, deliberately: `exit 1` alone makes a rejected call invisible, so a suppressed mutating call
  (`gh pr merge --auto || true`) would leave a clean log and a green suite, which is how the first
  version of that assertion passed under mutation (issue #87). A silent empty body is worse still,
  because an empty alert list reads as "nothing to fix".
- **The mock reproduces the real tool's shape, not a tidy one.** Real `gh` writes its
  release-upgrade notice to stderr and still exits 0; the mock does too, per PR, from a stub file.
  A failure stub carries the real `gh: ... (HTTP nnn)` wording, because classification is what the
  script under test does with it.

**The intended shape** is one shared, SDK-style helper in `spec/spec_helper.sh` (issue #196), which
`mocking.md` will document as the way once it lands:

- `mock_gh_reply <verb path> <file>` registers the stdout for **one endpoint**, keyed by the
  leading `gh` arguments (`api repos/octo/app/dependabot/alerts`, `pr list`,
  `label create merge-risk:low`). One reply per endpoint, no conditional logic in the test.
- `mock_gh_fail <verb path> <stderr text> [exit]` is a **per-endpoint** fail switch, so an example
  says which endpoint fails and how.
- `mock_gh_unhandled` keeps the rule above: an endpoint with no registered reply exits non-zero
  with `unhandled: <args>` on stderr.
- `mock_gh_requests` is the request log.

The point of the SDK shape is that registration *is* the declaration: an example lists the
endpoints it exercises, and reaching one it did not declare is a failure rather than a default.

## What a log assertion may claim

**Request shape only.** That the alert query carried `ecosystem=pip`, that the PR lookup searched
`head:fix/...`, that a mutating endpoint was never reached at all.

**Never call count or order.** Retries, pagination and caching change both without changing
behavior, and an example pinned to them breaks on a refactor that fixed nothing. The exception is
an absence: "this endpoint was never called" is a behavioral claim, and it is the one the allowlist
in `spec/pr_status_spec.sh` makes.
