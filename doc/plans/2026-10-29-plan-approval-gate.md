# Plan approval gate and Claude permission profiles

Date: 2026-10-29. Status: implemented on the `cto-workflow` branch.
User guide: [`doc/SOLO-CTO-WORKFLOW.md`](../SOLO-CTO-WORKFLOW.md).

## Problem

Paperclip already had planning work mode, versioned `plan` documents, and
`request_confirmation` approvals bound to a plan revision. Three gaps remained:

- Planning mode was a prompt instruction for `claude_local`; runs still used
  `--dangerously-skip-permissions`.
- No backend check stopped implementation without an approved plan.
- Approval did not hand work to a separate implementer.

## Design

- **Policy.** `projects.plan_approval_policy` (jsonb, nullable) holds
  `{ enabled, implementerAgentId? }`. It is opt-in, and only board users can
  change it (`403` for agents).
- **Approval predicate** (`server/src/services/plan-approval-gate.ts`): an
  accepted `request_confirmation` targeting the task's `plan` document at the
  document's current `latestRevisionId`, with `resolvedByUserId` set and
  `resolvedByAgentId` null. Every plan edit therefore requires a new approval.
- **Dispatch** (`heartbeat/runtime-execution.ts`): evaluated for every run with
  a task, right before adapter or native dispatch. That covers wakes, timers,
  retries, recovery and resumes.
  - Unapproved runs on `claude_local` are stamped with
    `context.paperclipPlanGate = { mode: "plan" }` and run read-only.
  - Other adapters fail with `plan_approval_required`, which is non-retryable.
  - Approved runs get `{ mode: "implement", approvedRevisionId }`.
- **Checkout** (`issueService.checkout`): an unapproved gated task may be
  checked out only by a run bound to that task on a read-only-capable adapter.
  This closes timer runs that choose their own work.
- **Handoff** (`issue-thread-interactions.ts`): a human acceptance of the plan
  reassigns the task to `implementerAgentId` with `todo` and `standard` work
  mode; the existing continuation wake starts it.
- **Claude permission profiles** (`claude-local/src/server/permissions.ts`):
  - `claudePermissionMode` passes `--permission-mode` through.
  - `toolProfile: read_only` (forced by the gate) runs with:
    `dontAsk`; `--tools` without edit tools; an allowlist limited to
    curl/read-only git; `--setting-sources user`; and a git before/after
    workspace check.
  - These profiles always use the CLI engine; an explicit ACP setting is
    rejected, never weakened.
  - `requireSubscriptionAuth` fails runs that would bill an API key or Bedrock.

## Probe findings (Claude Code 2.1.312)

- `dontAsk` with an allowlist denied `touch` and redirections in a clean env.
  One early run inside a parent Claude Code session let `touch` through and
  could not be reproduced; hence the workspace check.
- `auto` mode works with subscription auth.
- `--disallowedTools` and `permissions.deny` rules did not block `git push` in
  `auto` mode. The git policy is therefore instruction-level, plus branch
  protection.

## Addendum: per-company sandbox (`claudeSandbox`)

`packages/adapters/claude-local/src/server/sandbox-profile.ts` derives the
company directory (the child of `isolationRoot` that contains the workspace).
It passes Claude Code sandbox settings via `--settings`, plus path-scoped
file-tool rules.

Probes (macOS, Claude Code 2.1.312) through the real generated args:

- a narrower `allowRead` overrides a parent `denyRead`;
- `denyWrite` beats a narrower `allowWrite`;
- path-scoped `Read(...)` allows in `dontAsk` also gate Grep and Glob;
- `Read`/`Edit`/`Write` deny rules hold in `auto` mode;
- worktree commits work when the git common dir is writable;
- sandboxed `curl` reaches localhost only with `network.allowLocalBinding: true`.

Read-only args: other-company reads were denied by both the tool rule and the
OS, and `touch` was denied.

Implementer args: worktree write and commit worked. Other-company Read and
Write were denied by the tool rules, and Bash `cat` there by the OS.

## Not done

- No event trigger for "task completed" discovery.
- Read-only planning for adapters other than `claude_local`.
- Including the policy in company export/import.
