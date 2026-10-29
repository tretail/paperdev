# Solo CTO workflow: plan → approve → implement

This fork adds a workflow for one developer supervising local Claude Code
agents. An agent may change source code only after you approve the current
revision of the task's plan. The rule is enforced by the server and by Claude
Code's permission system, not only by prompts.

Design notes: [`doc/plans/2026-10-29-plan-approval-gate.md`](plans/2026-10-29-plan-approval-gate.md).

## 1. Install and run

```sh
pnpm install          # use the repo's pnpm (packageManager in package.json)
pnpm dev              # API + UI on http://localhost:3100
```

First-party telemetry is **off by default** in this fork. It runs only if your
Paperclip config sets `telemetry.enabled: true`.

## 2. Claude subscription authentication

All three agents use the local `claude` CLI and your Claude subscription. They
make no direct Anthropic API calls for inference.

1. Sign in once on the machine that runs Paperclip: `claude login`. A
   long-lived `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) also works.
2. Keep `ANTHROPIC_API_KEY` **unset**, both in the shell that starts Paperclip
   and in agent env. Claude Code prefers an API key over the subscription.
3. The bundled agents set `requireSubscriptionAuth: true`. If an API key or
   Bedrock credentials are visible, the run fails with
   `claude_subscription_auth_required`; it never falls back to API billing.
4. On the agent's configuration page, click **Run test** (environment test). It runs a real
   Claude hello probe with the agent's permission profile. If
   `requireSubscriptionAuth` is set and an API key is visible, it reports
   `claude_subscription_auth_required` as an error.

Start Paperclip from a normal terminal, not from inside a Claude Code session.
Some inherited Claude Code session variables are not stripped from agent
processes.

Remaining non-inference calls to Anthropic, all optional:

- quota/usage display: `api.anthropic.com/api/oauth/usage` and profile, using
  your OAuth token;
- model listing via `/v1/models`, only when an API key exists.

## 3. Agents and permissions

Import the company package:

```sh
pnpm paperclipai company import ./doc/solo-cto/company --target new --new-company-name "My Company"
```

| Agent | Claude permission profile | Can change code? |
|---|---|---|
| Tech Lead | `toolProfile: read_only` | No |
| Planner | `toolProfile: read_only` | No |
| Implementer | `claudePermissionMode: auto`, git worktree | Only after plan approval |

All three agents use `engine: cli` and `requireSubscriptionAuth: true`.

**Read-only profile.** The read-only profile works as follows:

- Claude runs with `--permission-mode dontAsk`, which denies anything not
  pre-approved.
- The `Edit`, `Write`, `MultiEdit` and `NotebookEdit` tools are not loaded.
- Bash is limited to `curl` (for the Paperclip API) and `git log`, `show`,
  `diff` and `status`.
- The workspace's project and local `.claude` settings are ignored.
- Paperclip records `git status` and `HEAD` before and after the run. Any
  change fails the run with `read_only_run_modified_workspace`.
- Extra CLI args that would override the profile are rejected.

**Implementer.** Claude Code `auto` mode replaces
`--dangerously-skip-permissions`. Its classifier approves routine actions and
blocks risky ones. The Implementer pushes its task branch and opens a pull
request; it never pushes to or merges the default branch. Protect `main` on
GitHub for a hard guarantee (see Limitations).

**Configuration keys.** These `claude_local` keys can be set on any agent:

- `claudePermissionMode` — `auto`, `dontAsk`, `plan`, `acceptEdits` or
  `bypassPermissions`
- `toolProfile: read_only`
- `allowedTools` / `disallowedTools`
- `requireSubscriptionAuth`
- `claudeSandbox` (see below)

Agents that set none of them keep the legacy behaviour, which is
`dangerouslySkipPermissions`, default true.

### Directory isolation between companies

Keep each company's repositories under one folder per company, all under a
common parent:

```text
~/Workspaces/
  patlynk/    ← company A's repos
  flow/       ← company B's repos
  together/   ← company C's repos
```

Each agent sets `claudeSandbox: { enabled: true, isolationRoot: ~/Workspaces }`.
Paperclip uses the folder that contains the run's workspace as that run's
company directory, for example `~/Workspaces/patlynk`. It then runs Claude
Code's built-in macOS sandbox (Seatbelt, no Docker), plus matching
permission rules.

| | Read-only agents (Tech Lead, Planner) | Implementer |
|---|---|---|
| Bash reads | Own company folder only; other companies are denied by the OS | Same |
| Bash writes | None; the OS denies writes | Own workspace and the repo's `.git`; other companies are denied |
| Claude Read/Grep/Glob | Own company folder plus Paperclip's prompt bundle and skills | Everything except other companies and secrets |
| Claude Edit/Write | Not loaded | Denied for other companies and secrets |
| Secrets | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.paperclip`, `~/.config/gh` unreadable | Same, except `~/.config/gh`, which it needs to open PRs |
| Network | Paperclip API on localhost only | Localhost plus `allowedDomains` (GitHub, npm registry by default) |

A new company folder is picked up automatically on the next run. Use
`extraDenyRead` to hide more paths.

The run fails instead of running unprotected in three cases:

- the sandbox cannot start;
- the workspace is not inside `isolationRoot`
  (`claude_sandbox_workspace_outside_root`);
- `extraArgs` contains `--settings`.

**Run test** on the agent page runs the hello probe inside the same sandbox.

**Pushing from the Implementer.** `~/.ssh` is unreadable in the sandbox, and
SSH does not go through the sandbox's network proxy. Use HTTPS remotes
authenticated by the GitHub CLI: run `gh auth login` and `gh auth setup-git`
once, then set `git remote set-url origin https://github.com/<org>/<repo>.git`.

### Cloud CLIs per company

Only the Implementer gets cloud CLIs. Enable them per company with
`claudeSandbox.tools`, for example `tools: [gh, aws, wrangler]`. Each tool
adds the network domains it needs. Credentials come from that company only:

| Tool | Where its credentials live | One-time setup (per company) |
|---|---|---|
| `gh` / `git` | Paperclip's GitHub connection (managed launchers); otherwise a `GH_TOKEN` project secret | Connect GitHub in Paperclip |
| `aws` | `<company>/.paperclip-tools/aws/config` plus that folder's SSO cache | `AWS_CONFIG_FILE=~/Workspaces/<company>/.paperclip-tools/aws/config HOME=~/Workspaces/<company>/.paperclip-tools/aws aws configure sso`; add `AWS_PROFILE` to the project env |
| `az` | `<company>/.paperclip-tools/azure` | `AZURE_CONFIG_DIR=~/Workspaces/<company>/.paperclip-tools/azure az login` |
| `wrangler` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` project secrets | Create a scoped API token in Cloudflare |
| `supabase` | `SUPABASE_ACCESS_TOKEN` project secret | Create an access token in Supabase |

A shell function keeps the AWS commands short:

```sh
pcaws() { local t=~/Workspaces/$1/.paperclip-tools/aws; shift; AWS_CONFIG_FILE=$t/config HOME=$t aws "$@"; }
pcaws patlynk sso login --profile patlynk
```

How it works:
- Paperclip puts per-run wrappers first on the agent's PATH. They run `aws`
  and `supabase` with the company tool home as `HOME`.
- Paperclip sets `AWS_CONFIG_FILE`, `AZURE_CONFIG_DIR` and telemetry
  opt-outs.
- Your personal `~/.aws`, `~/.azure`, `~/.supabase`, wrangler config and
  keychain stay hidden. Claude Code also blocks reading any `.aws/config`
  file, which is why the AWS config is named `config` inside
  `.paperclip-tools/aws/`.
- The tool home sits at the company root, above the repos. The Implementer
  can write to it, for token refresh. Planner and Tech Lead cannot read it.
- The Implementer can always write to package caches (`~/.npm`,
  `~/Library/pnpm`, `~/Library/Caches`, `~/.cache`), so installs work.

### When an agent needs you

Runs are headless, so an agent never waits at a prompt. When a step needs
you, the agent stops and asks. Examples are an expired AWS SSO session, MFA,
`az login`, a missing secret, a host the sandbox refuses, or a
production-affecting command that `auto` mode declines. The agent:

1. posts a question card (`ask_user_questions`) on the task with the exact
   command to run, for example
   `AWS_CONFIG_FILE=… HOME=… aws sso login --profile patlynk`;
2. commits safe work in progress, sets the task `blocked` and ends the run.

You run the command in your own terminal, then answer the card or comment.
That wakes the agent in the same Claude session, so it keeps its context. It
re-checks access and continues. Pending cards are also listed among the items
that need your attention.

## 4. Enable the gate on a project

1. Open the `App` project → Properties.
2. Point the project at your repository: in the **Codebase** section, pick its local folder.
3. Switch **Plan approval** on and choose **Implementer** as the implementer.
4. Recommended: set the company interaction governance cap for
   `request_confirmation` to `human_only`. Agent-resolved confirmations never
   count as approval anyway.

Only board users can change a project's plan approval policy; agents get
`403`. Every change is written to the activity log.

## 5. Run a task end to end

**A. Create the task.** Create it in the gated project with a title and
description, for example "Add passwordless login using email magic links".

**B. Plan.** Assign the task to the **Planner**. The run is read-only:

- The Planner inspects the repo and writes the task's `plan` document.
- It creates an approval request for that plan revision and moves the task to
  `in_review`.
- The task's **Plan approval** row shows *Awaiting approval (rev N)*.

**C. Review.** Read the plan in the Plans tab, or as the `plan` document, and
answer the confirmation card:

- **Approve** (the agent may label it "Approve plan") records who approved,
  which revision, and when.
- **Request changes**: click **Reject** and type your feedback as the reason.
  Paperclip treats a rejected plan as "needs revision", moves the task back and
  wakes the Planner with your reason. The Planner writes rev N+1 and asks
  again. Any new plan revision makes earlier approvals stale; the row then
  shows *Re-approve rev N*.
- **A plain comment** also wakes the Planner. Use it for questions or
  discussion; Reject is the clear "revise this" signal.
- To stop entirely, cancel the task.

**D. Implement.** Approval hands the task to the **Implementer** and wakes it.
It:

- implements the approved revision in a git worktree and runs the tests;
- pushes the task branch and opens a PR, recorded as a `pull_request` work
  product;
- writes an `implementation-report` document (changes, deviations, test
  results, diff stat);
- sets the task to `in_review`.

If the plan must change, the Implementer writes a new plan revision. That
invalidates the approval, so its next run is read-only until you approve
again.

**E. Review the work.** Review the PR, the report and the run logs. Mark the
task `done` yourself; a finished run alone does not complete the task.

## 6. What the gate enforces

The gate is evaluated at dispatch for **every** run on a task in a gated
project. That includes:

- assignment wakes;
- manual runs;
- scheduled heartbeats;
- automatic retries;
- recovery after restart;
- resumed sessions.

A task counts as approved only when all of these hold:

- an accepted `request_confirmation` targets the task's `plan` document;
- its target revision equals the plan's **current** latest revision;
- it was resolved by a human user, not an agent.

Work mode, assignment, `todo` status, comments, and agent claims are not
evidence of approval.

| Situation | Result |
|---|---|
| Not approved, `claude_local` agent | Run allowed **read-only**; prompt says to plan only |
| Not approved, other adapter | Run fails `plan_approval_required` (not retried) |
| Agent checks out an unapproved task from a timer run or another task's run | `409 plan_approval_required` |
| Approved current revision | Normal permissions for the agent |

Read the state with `GET /api/issues/:id/plan-approval`.

## 7. Scheduled task discovery

The **Daily discovery** routine runs at 08:00 UTC and creates a task for the
Tech Lead.

- The Tech Lead proposes at most three tasks in a single `suggest_tasks` card,
  each with rationale, evidence, acceptance criteria and an
  impact/confidence/effort score.
- If nothing is worth proposing, it says so instead.
- Only the suggestions you accept become tasks.
- The Tech Lead is read-only and never assigns the Implementer.

To change or disable discovery, open **Routines → Daily discovery**. Edit the
trigger's cron or timezone, switch the trigger off, or pause the routine.

## 8. Failed runs and recovery

- Open the run from the task to see logs, the permission profile used (logged
  at start), and the error code.
- Retrying keeps the plan, its approval state and the task history. The gate
  re-checks approval on each attempt.
- `plan_approval_required`, `read_only_run_modified_workspace`,
  `claude_subscription_auth_required` and `claude_permission_profile_conflict`
  are not retried automatically. Fix the cause, then re-run.
- For `read_only_run_modified_workspace`, inspect the worktree with
  `git status` and revert before re-running.

## 9. Known limitations

- **The OS sandbox covers Bash only.** Claude's own Read/Edit/Write tools, MCP
  servers and hooks run outside it and are limited by permission rules. Without
  `claudeSandbox`, read-only enforcement relies on those rules plus the git
  before/after check.
- **Within its own company, the Implementer's Bash can write anywhere in the
  repo**, including the main checkout, not only its worktree. With the sandbox,
  a deny-write rule beats a narrower allow, so the worktree alone can't be
  carved out. Other companies and secrets stay protected.
- **Allowed domains can carry data out.** Keep `allowedDomains` short.
- **Supabase direct database connections don't work.** The sandbox only
  proxies HTTP(S), so `supabase db push`, `link --password` or `psql` to
  Supabase fail. Use the Management API, or run them yourself when the agent
  asks.
- **Tokens in project env are visible to every shell command** in that
  company's Implementer runs. Use least-privilege, per-company tokens.
- **The Implementer's git policy comes from its instructions.** Claude Code
  deny rules did not block `git push` in `auto` mode in our probe. Use GitHub
  branch protection on `main`.
- **`auto` mode is a safety net, not a security boundary.**
- **Read-only planning is implemented only for `claude_local`.** Other
  adapters on gated tasks are blocked until approval.
- **Approval is per task.** A full-permission run for an approved task works
  in the shared repository and could touch unrelated code.
- **There is no "on task completed" trigger.** Discovery reviews recently
  completed tasks on its schedule instead.
- The plan approval policy is not part of company export/import; enable it
  after import.
