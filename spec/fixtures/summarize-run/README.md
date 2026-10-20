# summarize-run specimens

`field-run/` holds the files of one `resolve-alerts` run on a field-test repository, with
gh-security 0.30.0 and the scope "everything". The names are scrubbed to public names (`octo/app`,
`/Users/example`). Each file is a copy of the run output. Do not edit these files.

- `workflow-result.json` is the result of the Workflow tool. Its `result` is the list of entries.
- `workflow-args.json` is the `args` of that Workflow.
- `post-agent-<package>-<major>.result.json` is the result of one agent, and
  `post-agent-<package>-<major>.report.json` is the report of `post-agent.sh` for it. The two
  failure reports name a worktree and a branch that did not exist (round 7 ruling 12 on #229).
- `detect-scope.json`, `discover-repos.json`, `namespace-probe.*` and `classify-lines.json` are the
  outputs of phases 1 and 2.
- `pr-status.json` is the answer of `pr-status` for the one pull request.
- `summary.md` is the phase 7 summary that the model wrote by hand for this run.

`derived-failure-with-pr-url.json` is not from a run (round 7 ruling 13 on #229). It is
`result[1]` of `field-run/workflow-result.json`, the `smol-toml` failure entry, with one change:
`result.pr_url` is `https://github.com/octo/app/pull/2503`, as a failed `render-pr create` gives
it. Replace it when a real run gives this shape.
