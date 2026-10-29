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

Agents that set none of them keep the legacy behaviour, which is
`dangerouslySkipPermissions`, default true.

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

- **Approve plan** records who approved, which revision, and when.
- **Request changes**: the Planner revises the plan, which creates rev N+1, and
  asks again. Any new plan revision makes earlier approvals stale; the row then
  shows *Re-approve rev N*.
- **Reject**, or cancel the task.

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

- **No OS sandbox on macOS.** Read-only enforcement relies on Claude Code
  permissions plus the git before/after check. `curl` could in principle write
  files; the check catches tracked and untracked changes, but not writes
  outside the repository.
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
