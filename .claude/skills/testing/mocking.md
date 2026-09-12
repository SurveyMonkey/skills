# When to Mock

**Mock at the system boundary and nowhere else.** In the shell suite that boundary is `gh`, the one
thing a spec cannot run for real because it is the network and someone else's state. In the vitest
suite it is the Workflow runtime the model supplies (`agent`, `parallel`, the logger), which no spec
can run for real either; `spec/js/harness.mjs` stubs exactly those and nothing else, reproducing
their documented semantics rather than a tidier version of them.

Everything else is used for real:

- **Not a sibling script the caller resolves by path.** `post-agent.sh` resolves `pr-status.sh` and
  `reap-agent-artifacts.sh` as siblings of its own path: run the real one.
  `spec/post_agent_spec.sh` does exactly that, copying both collaborators verbatim next to a
  scratch copy of the script under test. A mocked collaborator tests the caller against a shape
  nothing emits, which is how two scripts that each pass their own suite disagree in the field.
  Scripts that are pipeline neighbours rather than caller and callee (`discover-alerts.sh` and
  `classify-lines.sh`, which the skill's pipeline runs in sequence) are each tested on their own
  seam and never against a mock of the other.
- **Not an adapter, in the adapter's own specs.** `node.sh` is reached through `adapter_jq`, as its
  callers reach it, and never by sourcing it to call one of its functions.
- **Not git.** Fixtures are real `git init` repositories in scratch directories
  (`spec/discover_repos_spec.sh`), including the shapes that are supposed to fail: a bare
  repository, a `.git` with no traverse permission, a checkout missing `HEAD`, a pointer file whose
  gitdir is gone, and where the shape needs one, a real mount.
- **Not the filesystem.** Real files, real directories, real symlinks, real permission bits, copied
  per example by `use_fixture` (`spec/spec_helper.sh`) so a mutating verb never touches the
  committed fixture.
- **Not `jq`, not `bash`, not the package managers.** Specs never hit the network and never run an
  install; where a package manager would have to run, the script's seam is a JSON input instead.

The only other shellspec `Mock` in the suite is the machine itself: `uname`, `sysctl` and `nproc` in
`spec/detect_capacity_spec.sh`, because the concurrency cap is a function of the host's cores and
RAM, which is exactly as unfakeable and as external as the network. All three mocks read their
answers from environment variables so one mock serves every `Parameters` row.

## The injected collaborator

**A collaborator a driver accepts as a path is substituted through that flag, not mocked around.**
Where running the real one would run a package manager or reach the network, the driver's own seam
carries the substitution: `spec/fix_group_spec.sh` and `spec/fix_group_apply_spec.sh` pass
`--adapter` and `--scorer`, and `spec/audit_driver_spec.sh` and `spec/audit_driver_judge_spec.sh`
pass `--adapter` and `--advisories`. This is not a hole in the rule above. The flag is a documented
part of the CLI, `fix-group.sh` falls back to the real sibling when it is absent, and the spec is
still observing only the seam.

Two constraints hold for a substituted collaborator:

- **It reproduces the real shape, and it does not recompute the answer the driver does.**
  `spec/audit_driver_spec.sh`'s `list_pins` stub deliberately re-reads the pin list from the
  manifest on disk instead of serving a canned count, so the driver's own removal is what the
  count-minus-one check is measured against. A spec that canned both sides asserts the driver
  against itself.
- **It is named at the point of use as what it stands in for.** Anything substituted that is
  neither `gh`, the machine trio, the Workflow runtime, nor a collaborator behind a documented flag
  needs a comment saying which boundary it is.

## How `gh` is mocked

**Today**, each spec that needs `gh` builds its own shellspec `Mock gh` block: a `case` on the
leading arguments, a log appended to a file under `$MOCK_DIR`, and fail switches read from stub
files. Four files carry one (`spec/discover_alerts_spec.sh`, `spec/pr_status_spec.sh`,
`spec/check_advisories_spec.sh`, and `spec/render_pr_spec.sh`, which carries five separate blocks
of its own), they have already drifted from each other, and a generic dispatcher is the shape this
skill warns about: mocking requires conditional logic inside the mock, and a reader cannot tell
from an example which endpoints it exercises.

`spec/post_agent_spec.sh` is the deliberate fifth shape rather than a counterexample: `pr-status.sh`
runs there as a genuine subprocess of `post-agent.sh`, one level deeper than shellspec's own
interception reaches, so its `gh` is a real executable placed on `PATH` instead of a `Mock` block.
The boundary is the same one; only the mechanism differs.

Two rules those blocks already get right and any replacement must keep:

- **An unhandled endpoint fails loudly.** `spec/pr_status_spec.sh` logs the call *before* refusing
  it, deliberately: `exit 1` alone makes a rejected call invisible, so a suppressed mutating call
  (`gh pr merge --auto || true`) would leave a clean log and a green suite, which is how the first
  version of that assertion passed under mutation (issue #87). A silent empty body is worse still,
  because an empty alert list reads as "nothing to fix".
- **The mock reproduces the real tool's shape, not a tidy one.** Real `gh` writes its
  release-upgrade notice to stderr and still exits 0; the mock does too, per PR, from a stub file.
  A failure stub carries the wording the real `gh` writes for that endpoint, and that is not one
  spelling: `gh api` reports `gh: Not Found (HTTP 404)` (`spec/discover_alerts_spec.sh`), while a
  `gh` subcommand reports `HTTP 422: Validation Failed: name already exists` with no `gh:` prefix
  (`spec/render_pr_spec.sh`). Copy the spelling the endpoint actually emits, because classification
  is what the script under test does with it.

**The intended shape** is one shared, SDK-style helper in `spec/spec_helper.sh` (issue #196), which
this file will document as the way once it lands:

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
