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

One shared, SDK-style helper mocks `gh`, registered in `spec/spec_helper.sh` and driven from a
standalone dispatcher script, `spec/support/gh-mock-dispatch.sh` (issue #196). Four files use it:
`spec/discover_alerts_spec.sh`, `spec/pr_status_spec.sh`, `spec/check_advisories_spec.sh`, and
`spec/render_pr_spec.sh`. Each one's `Mock gh` block is a single line:

```sh
Mock gh
  "$GH_MOCK_DISPATCH" "$@"
End
```

The dispatcher lives in its own file rather than a `spec_helper.sh` function because a
command-based `Mock` block runs as a real, separate subprocess whenever the script under test
invokes `gh` itself (`When run script`, or a script that shells out to `gh` on its own) — that
subprocess cannot call a shell function defined outside the block, and shellspec's own docs say
the one exception (an exported bash function via `export -f`) is not portable to the `sh` this
suite targets. An external command has no such restriction, so the matching and reply logic is a
script the mock block simply invokes.

`spec_helper.sh` exposes the registration API:

- `mock_gh_reset` starts a fresh scratch directory (`$GH_MOCK_DIR`) with an empty registry and
  request log. Call it once per example, typically from the spec file's own `Before` hook.
- `mock_gh_cleanup` removes that scratch directory. Pair it with `mock_gh_reset` via `After`, the
  same way `use_fixture` is paired with `After 'cleanup_fixture'` elsewhere in `spec_helper.sh` —
  without it, every example that resets the mock leaks a `mktemp` directory for the life of the
  shellspec process.
- `mock_gh_reply <verb path> <file> [stderr file]` registers the stdout for **one endpoint**,
  keyed by the leading `gh` arguments (`api repos/octo/app/dependabot/alerts`, `pr list`,
  `label create merge-risk:low`). One reply per endpoint, no conditional logic in the test. `file`
  is read at call time, not copied, so an example that later overwrites the same path (many
  `discover-alerts.sh` examples rewrite their alerts fixture in place) is answered with the new
  content. The optional third argument is a file of stderr chatter gh should still emit alongside
  an otherwise-successful reply (the release-upgrade notice `pr-status.sh` must tolerate). The key
  may not contain a tab or newline; registration refuses it loudly rather than risk corrupting the
  registry's tab-separated record.
- `mock_gh_fail <verb path> <stderr text> [exit]` is a **per-endpoint** fail switch, so an example
  says which endpoint fails and how, with the real `gh: ... (HTTP nnn)` wording the scripts
  classify. Same restriction as above, on both the key and the text: a real multi-line `gh` error
  is exactly what this argument is for, but it cannot yet be reproduced here — reject it rather
  than truncate or silently corrupt the registry.
- `mock_gh_requests` prints the request log, one line per call, for assertions on what was sent
  (`ecosystem=pip`, `--search head:fix/...`) via command substitution:
  `The value "$(mock_gh_requests)" should include ...`.

The dispatcher itself keeps the two rules the per-file blocks already got right:

- **An unhandled endpoint fails loudly.** Every call is logged *before* it is matched, so a
  rejected or unregistered call still shows up in `mock_gh_requests` — `exit 1` alone would make a
  suppressed mutating call (`gh pr merge --auto || true`) invisible, which is how the first version
  of that assertion passed under mutation (issue #87). An endpoint with no registered reply exits 1
  with `unhandled: <args>` on stderr, so a call an example did not declare fails outright rather
  than reading as "no alerts".
- **The mock reproduces the real tool's shape, not a tidy one.** A failure registered with
  `mock_gh_fail` carries the wording the real `gh` writes for that endpoint, and that is not one
  spelling: `gh api` reports `gh: Not Found (HTTP 404)` (`spec/discover_alerts_spec.sh`), while a
  `gh` subcommand reports `HTTP 422: Validation Failed: name already exists` with no `gh:` prefix
  (`spec/render_pr_spec.sh`). Copy the spelling the endpoint actually emits, because classification
  is what the script under test does with it.

Registration is keyed by the leading `gh` arguments: each space-separated token in the key must
match an argument of the call whole, or match a leading part of it immediately followed by `?`, in
order though not necessarily contiguous. That lets `pr list --search head:<branch>` match past
`--repo`, and lets a key with no query string match an `api` call whose path carries one, without
also matching an unrelated branch that merely shares a name prefix (`fix/dependabot-lodash` must
not match `fix/dependabot-lodash-4x`). The **last** registration whose key matches a given call
wins, so a `Before` hook can register a broad default (`pr list` answering "no open PR" for every
branch, `label create` answering "created" for any label) and one example can register a narrower,
later key to override it for the one case it cares about.

The point of the SDK shape is that registration *is* the declaration: an example lists the
endpoints it exercises, and reaching one it did not declare is a failure rather than a default.

**One bespoke block remains**, in `spec/render_pr_spec.sh` ("round 2, finding 5"): a real failure
whose *stdout* happens to contain the phrase `create_label` checks for, with the actual error on
stderr. `mock_gh_reply` only ever answers success, and `mock_gh_fail` only ever writes to stderr,
so a failing call that also writes to stdout is the one shape the shared helper cannot express.

`spec/post_agent_spec.sh` stays its own shape rather than migrating: `pr-status.sh` runs there as a
genuine subprocess of `post-agent.sh`, one level deeper than shellspec's own interception reaches,
so its `gh` is a real executable placed on `PATH` instead of a `Mock` block at all. The boundary is
the same one; only the mechanism differs, and there is no `Mock gh` block there to migrate.

## What a log assertion may claim

**Request shape only.** That the alert query carried `ecosystem=pip`, that the PR lookup searched
`head:fix/...`, that a mutating endpoint was never reached at all.

**Never call count or order.** Retries, pagination and caching change both without changing
behavior, and an example pinned to them breaks on a refactor that fixed nothing. The exception is
an absence: "this endpoint was never called" is a behavioral claim, and it is the one the allowlist
in `spec/pr_status_spec.sh` makes.
