
## Staging

Staging holds no real patient data, and your AWS access is limited to it: the
`AgentStaging` role can view resources, read logs and read `/staging/agent-access/*`, with
no writes and no secret values. A refusal from that role is the boundary working, so
report it rather than looking for a way around it. Use the `staging` skill
(`.claude/skills/staging/SKILL.md`) to check your work there:
`.claude/skills/staging/staging-curl` for `https://staging.patlynk.com`, plain `curl`
for `https://api-staging.patlynk.com`. Never read or print the Cloudflare Access
token, the `CF_Authorization` cookie or the test account password.

If AWS SSO has expired, ask the human on a question card to run
`pcaws patlynk sso login --sso-session staging --no-browser`, then open the printed URL
in a private window and sign in as `agents-staging@patlynk.com`. A login approved as
anyone else gives you that person's access, so if `aws sts get-caller-identity` shows any
other user or role, stop and tell the human. Then block the task as described under "When
you need the human".

The skill's `playwright-staging` browser isn't available in Paperclip runs. Use
`staging-curl`, and say in your report what you couldn't check in a browser.

Deployments to staging belong to the human. If your check needs a deployed version,
say so in your implementation report.

## CI results

`gh pr checks` fails with this token (`Resource not accessible by personal access token`).
Use `gh run list --branch <branch>` and `gh run view <id> --log-failed` instead.

## Tests in this repository

- **Backend:** many tests, including in `:api:test`, need Docker through Testcontainers.
  The sandbox blocks the Docker socket, so they fail with an error at
  `DockerClientProviderStrategy`. That isn't a failure of your change: CI runs the backend
  suite on your pull request. Run what you can, and say in your report what didn't run.
  Never try to get around the block. A `FROM-CACHE` test task ran nothing in this run, so
  report it as cached rather than as passing here.
- **Frontend:** Turbo replays cached results, shown as `FULL TURBO`, so `just lint`,
  `just typecheck` and `just frontend test` can pass without running anything here. When
  you need proof, run `pnpm turbo run <task> --force` in `frontend/`. Paperclip installs
  `frontend/` dependencies when it prepares your worktree, because the sandbox refuses to create the `.idea` folders some packages ship,
  such as `iconv-lite`. If you change dependencies and `pnpm install` stops with `EPERM`
  on `.idea`, report it and block the task as described under "When you need the human".
- **Python:** `just python install` regenerates the tracked ANTLR parser files under
  `domain/numeric_parser/generated/`, with a large unrelated diff. Use `uv sync` in
  `python/` instead. Unless you changed the grammar, run
  `git checkout -- python/src/patlynk_python/domain/numeric_parser/generated` before you
  commit.
