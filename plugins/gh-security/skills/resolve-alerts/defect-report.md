# Filing a skill-defect report

**When this run's own evidence shows the skill itself misbehaved, file that as a defect against
this repository, not against the target.** The signal is a fail-close, a written key, or a probe
result that the run's own evidence contradicts: a false `baseline` or `validate` fail-close, an
override key the install then proved ineffective, a probe with the wrong verdict, a `mispaired`
entry, or an agent that worked around its own tooling. But a target repo's own defect (a stale
lockfile, a dead registry token, a blocked branch namespace) is never filed here; report it to the
user only. When in doubt, the absence of a plausible repo-side explanation tips it toward the
skill.

**Check this repository for an existing issue before drafting a new one.**

```bash
gh issue list --repo SurveyMonkey/skills --search "<distinguishing terms>" --state all
```

`--state all` matters: a fixed-and-closed defect is still a hit, and the answer is "the plugin
needs updating again". A hit means a second independent field sighting is confirmation, not noise:
comment the new run's specifics onto it. No hit means draft a new issue.

**This search is also the reachability probe for the identity question below.** An auth error
here, not an empty list, says this run's credentials cannot reach this repository.

**The report carries the run's own concrete evidence**: the failing payload verbatim, the shapes
involved, and what makes it a skill defect rather than the target repo's own state.

**Scrub the report as this repository scrubs everything else.** Never name the target repository,
its owner or org, or its internal directory topology: write "a field run", and cite only public
package names.

**Consent gates filing.** Propose the drafted title and body and file only on the user's go-ahead,
unless the user pre-authorized defect reports earlier in this session. Either way, the closing
report in phase 8 states what was filed or proposed, with the issue number or URL once it exists.

**The identity that files the report is resolved separately from the identity that ran the batch,
and is never assumed to be the same.** The batch's credentials may belong to an account barred from
contributing to outside repositories, such as an Enterprise Managed User.

- Never file under the batch's credentials without the reachability probe above.
- When the session context documents another, capable account for this repository (a wrapper
  command or a second `gh` config for its directory), use it for the report, under the same
  consent that covers the report itself. A bare `cd` into that directory is never the mechanism.
  Switching identities is never invented silently.
- When no capable account resolves, the report does not vanish: hand the drafted title and body to
  the user in the closing report.
