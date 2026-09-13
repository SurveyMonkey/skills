# When to Mock

**Mock at the system boundary and nowhere else.** That boundary is `gh`, the one thing an example
cannot run for real because it is the network and someone else's state, and it is reached through
an injected client (below). For the Workflow script it is additionally the runtime the model
supplies (`agent`, `parallel`, the logger), which no example can run for real either;
`spec/js/harness.mjs` stubs exactly those and nothing else, reproducing their documented semantics
rather than a tidier version of them.

Everything else is used for real:

- **Not a collaborator you own**, a module the caller imports or a sibling script it resolves by
  path. `post-agent.sh` resolves `pr-status.sh` and `reap-agent-artifacts.sh` as siblings of
  its own path: run the real one. `spec/post_agent_spec.sh` does exactly that, copying both
  collaborators verbatim next to a scratch copy of the script under test. A mocked collaborator
  tests the caller against a shape nothing emits, which is how two scripts that each pass their
  own suite disagree in the field.
  Scripts that are pipeline neighbours rather than caller and callee (`discover-alerts.sh` and
  `classify-lines.sh`, which the skill's pipeline runs in sequence) are each tested on their own
  seam and never against a mock of the other.
- **Not an adapter, in the adapter's own tests.** It is reached through the contract its callers
  reach it through, and never by reaching past that into something it does not promise.
- **Not git.** Fixtures are real `git init` repositories in scratch directories
  (`spec/discover_repos_spec.sh`), including the shapes that are supposed to fail: a bare
  repository, a `.git` with no traverse permission, a checkout missing `HEAD`, a pointer file whose
  gitdir is gone, and where the shape needs one, a real mount.
- **Not the filesystem.** Real files, real directories, real symlinks, real permission bits, copied
  per example by `use_fixture` (`spec/spec_helper.sh`) so a mutating verb never touches the
  committed fixture.
- **Not the package managers.** Examples never hit the network and never run an install; where a
  package manager would have to run, the seam it sits behind takes a JSON input instead.

The only other shellspec `Mock` in the suite is the machine itself: `uname`, `sysctl` and `nproc` in
`spec/detect_capacity_spec.sh`, because the concurrency cap is a function of the host's cores and
RAM, which is exactly as unfakeable and as external as the network. All three mocks read their
answers from environment variables so one mock serves every `Parameters` row.

## The injected collaborator

**A collaborator a driver accepts as a parameter is substituted through that parameter, not mocked
around.** Where running the real one would run a package manager or reach the network, the driver's
own seam carries the substitution: `spec/fix_group_spec.sh` and `spec/fix_group_apply_spec.sh` pass
`--adapter` and `--scorer`, and `spec/audit_driver_spec.sh` and `spec/audit_driver_judge_spec.sh`
pass `--adapter` and `--advisories`. This is not a hole in the rule above. The flag is a documented
part of the contract, the driver falls back to the real collaborator when it is absent, and the
example is still observing only the seam.

Two constraints hold for a substituted collaborator:

- **It reproduces the real shape, and it does not recompute the answer the driver does.**
  `spec/audit_driver_spec.sh`'s `list_pins` stub deliberately re-reads the pin list from the
  manifest on disk instead of serving a canned count, so the driver's own removal is what the
  count-minus-one check is measured against. A spec that canned both sides asserts the driver
  against itself.
- **It is named at the point of use as what it stands in for.** Anything substituted that is
  neither `gh`, the machine trio, the Workflow runtime, nor a collaborator behind a documented
  parameter needs a comment saying which boundary it is.

## How `gh` is mocked

**The boundary is a typed client, not a command.** Every `gh` operation the plugin performs is one
method on an SDK-style client that wraps `gh`, and handlers take that client as an injected
parameter (issue #216's decision comment, which constrains #217 and #219). An example substitutes
the methods it exercises and nothing else. This is the upstream skill's rule about preferring
SDK-style interfaces over one generic fetcher, taken at its word: one shape per method, no
conditional logic inside a mock, and the endpoints an example touches are legible from the
substitution list.

Octokit is not the client. Shipped code imports nothing outside the plugin (ADR 012), so the
per-endpoint method shape is the model rather than the library; the official OpenAPI types
package may type the responses as a dev dependency, through `import type` only, at #217's
discretion.

Four semantics carry over from the shared shellspec helper
([#196](https://github.com/SurveyMonkey/skills/issues/196)), because each was earned by a defect:

- **An operation the example did not declare throws.** A call nobody registered is a failure
  outright, never an empty answer that reads downstream as "no alerts". Registration *is* the
  declaration.
- **The failure switch is per method, and it carries the real wording.** An example says which
  operation fails and how, in the spelling the real `gh` writes for it, because classification of
  that text is what the code under test does with it. That is not one spelling: `gh api` reports
  `gh: Not Found (HTTP 404)`, while a `gh` subcommand reports
  `HTTP 422: Validation Failed: name already exists` with no `gh:` prefix. Copy the spelling the
  operation actually emits; a tidied-up error tests nothing.
- **Every call is recorded before it is answered**, so a rejected or unregistered call still shows
  up in the request log. A failure alone would make a suppressed mutating call invisible, which is
  how the first version of that assertion passed under mutation (issue #87).
- **The request log is asserted on shape, never on count or order.** See the next section.

What does not carry over is the dispatcher's key matching: keys matched token by token against
argv, with a last-registration-wins override, because a command-based shellspec `Mock` block runs
as a separate subprocess that cannot call a shell function and had to be handed argv to sort out.
A method call needs none of that, and a defaulting layer with an override rule is exactly the
conditional logic in test setup the SDK shape exists to remove.

## What a log assertion may claim

**Request shape only.** That the alert query carried `ecosystem=pip`, that the PR lookup searched
`head:fix/...`, that a mutating endpoint was never reached at all.

**Never call count or order.** Retries, pagination and caching change both without changing
behavior, and an example pinned to them breaks on a refactor that fixed nothing. The exception is
an absence: "this endpoint was never called" is a behavioral claim, and it is the one the allowlist
in `spec/pr_status_spec.sh` makes.
