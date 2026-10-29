# Install: Paperclip solo-CTO setup (fork `cto-workflow`)

This guide installs this fork on a new macOS machine and sets up one Paperclip
company per real company. Each company gets three local Claude Code agents
using your Claude subscription:

- **Tech Lead** proposes technical work (CI, DX, security, design).
- **Product Lead** proposes product work and writes specs.
- **Planner** writes plans.
- **Implementer** writes code only after you approve the plan.

Agents of one company cannot read or write another company's folder.

For background and details, see `doc/SOLO-CTO-WORKFLOW.md`.

---

## 0. Before you start (on the current machine)

The `cto-workflow` branch exists only locally until you push it to a repository
you control:

```sh
git remote add mine git@github.com:<you>/paperclip.git   # your fork or private repo
git push -u mine cto-workflow
```

## 1. Prerequisites (new machine)

| What | Install |
|---|---|
| Xcode command line tools | `xcode-select --install` |
| Homebrew | https://brew.sh |
| [mise](https://mise.jdx.dev) | `brew install mise`, then add `eval "$(mise activate zsh)"` to `~/.zshrc` and open a new terminal |
| Node.js 24 + pnpm 12.16.1 | from the repo's `mise.toml` (section 3) |
| Python 3 + cloud CLIs | from your global mise config (below) |
| PostgreSQL | [Postgres.app](https://postgresapp.com) (add its `bin` to PATH as it instructs) |
| Rust (optional) | `mise use -g rust`. Only needed if the native Paperclip Runner gets built; these agents don't use it. |
| Claude Code CLI | Native installer (`curl -fsSL https://claude.ai/install.sh \| bash`, or see code.claude.com docs), then `claude --version` |

Put the cloud CLIs in your **global** mise config, so they resolve the same way
in every company repo the agents work in. Create `~/.config/mise/config.toml`:

```toml
[tools]
python = "3.12"      # Claude sign-in flows and azure-cli
gh = "latest"
aws = "latest"
azure-cli = "latest" # pipx backend
supabase = "latest"
wrangler = "latest"  # npm backend
```

Then run `mise install`. Keep only the CLIs you need. Paperclip resolves mise
shims to the real binaries when it builds the agents' per-run wrappers, so
`mise activate` and shims both work.

## 2. Directory layout

Put each company's repositories under one folder per company, all under
`~/Workspaces`:

```text
~/Workspaces/
  paperclip/          ← this repo
  patlynk/            ← company A: its repos go here
    app/
  flow/               ← company B
  together/           ← company C
```

The agents' sandbox uses `isolationRoot: ~/Workspaces`. If you use another
parent folder, change `isolationRoot` in each agent's config (section 7).

## 3. Get the code

```sh
cd ~/Workspaces
git clone git@github.com:<you>/paperclip.git
cd paperclip
git checkout cto-workflow
git remote add upstream https://github.com/paperclipai/paperclip.git   # to pull updates later
mise trust && mise install   # Node 24 + pnpm 12.16.1 from mise.toml
pnpm install
```

## 4. Database (local Postgres, no password)

Postgres.app trusts local connections by default, so no password is needed.
Run as your macOS user:

```sh
createuser paperclip
createdb --owner=paperclip paperclip
psql -d paperclip -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO paperclip;"
psql "postgres://paperclip@localhost:5432/paperclip" -c "select current_user;"   # check
```

The `paperclip` user owns the database. That lets migrations create the
`pg_trgm` and `fuzzystrmatch` extensions without superuser rights.

Create `~/Workspaces/paperclip/.env` (it is gitignored):

```sh
DATABASE_URL=postgres://paperclip@localhost:5432/paperclip
```

Migrations run automatically when the server starts.

**Optional:** a throwaway database for the plan-gate tests:

```sh
createdb --owner=paperclip paperclip_gate_test
cd server && PAPERCLIP_PLAN_APPROVAL_GATE_TEST_DATABASE_URL=postgres://paperclip@localhost:5432/paperclip_gate_test \
  npx vitest run src/__tests__/plan-approval-gate.test.ts
```

## 5. Claude subscription login

```sh
claude login            # sign in with your Claude subscription
env | grep ANTHROPIC    # must print nothing; an ANTHROPIC_API_KEY would switch to API billing
```

Remove any `ANTHROPIC_API_KEY` from `~/.zshrc` and similar. The agents use
`requireSubscriptionAuth: true`, so if a key is visible they fail instead of
using it.

## 6. Start Paperclip

Run this from a **normal terminal**, not from inside a Claude Code session:

```sh
cd ~/Workspaces/paperclip
pnpm dev
```

Open http://localhost:3100. The default mode is `local_trusted`: you are the
board and need no login.

Telemetry is off by default in this fork.

**Optional:** run it in the background at login with a LaunchAgent or a
`tmux` session.

## 7. Create a company (repeat per company)

### 7.1 Import the agents

```sh
cd ~/Workspaces/paperclip
pnpm paperclipai company import ./doc/solo-cto/company --target new --new-company-name "Patlynk"
```

This creates:

- the **Tech Lead**, **Product Lead**, **Planner** and **Implementer** agents (`claude_local`,
  sandboxed, subscription only);
- the **App** project;
- the **Daily technical discovery** (08:00 UTC) and **Daily product discovery**
  (09:00 UTC) routines.

### 7.2 Configure in the UI

1. **Project → Properties**
   - **Codebase**: pick the company repo, e.g. `~/Workspaces/patlynk/app`. It
     must be inside that company's folder, or runs fail with
     `claude_sandbox_workspace_outside_root`.
   - **Plan approval**: turn it on, and set the implementer to
     **Implementer**.
   - **Env**: add this company's secrets (see 7.3).
2. **Company Settings → interaction governance**: set confirmations to
   **Human only**.
3. **Each agent → Configuration → Run test**: this should report
   subscription auth and "Claude OS sandbox is on for company directory …".
4. **Implementer → Advanced** (the YAML editor): under
   `spec.adapterConfig.claudeSandbox.tools`, list the CLIs this company uses,
   e.g. `[gh, aws, wrangler]`. It defaults to `[gh]`. The same editor holds
   `isolationRoot` and `allowedDomains`.
5. **Routines**: change the time or timezone of either discovery routine, or
   pause it.
6. **Product context**: copy `doc/solo-cto/product-context.template.md` to the
   product repo as `docs/product-context.md` and fill it in. The Product Lead
   reads it every run.

### 7.3 Per-company CLI credentials

Credentials never come from your personal logins. Each company's live in its
own folder or in its project secrets.

**AWS** (once per company):

```sh
# Add to ~/.zshrc:
pcaws() { local t=~/Workspaces/$1/.paperclip-tools/aws; shift; AWS_CONFIG_FILE=$t/config HOME=$t aws "$@"; }

pcaws patlynk configure sso                 # creates the profile in the company tool home
pcaws patlynk sso login --profile <profile> # repeat whenever SSO expires
```

Then add `AWS_PROFILE=<profile>` to the project env.

**Azure:**

```sh
AZURE_CONFIG_DIR=~/Workspaces/patlynk/.paperclip-tools/azure az login
```

**Cloudflare (wrangler):** create a scoped API token in Cloudflare. Add
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as project secrets.

**Supabase:** create an access token. Add `SUPABASE_ACCESS_TOKEN` as a project
secret.

Direct database commands such as `supabase db push` cannot pass the sandbox.
The agent will ask you to run them.

**GitHub:** connect GitHub in Paperclip (managed `git`/`gh`), or add a
`GH_TOKEN` project secret. Repos must use **HTTPS** remotes, because SSH can't
leave the sandbox:

```sh
gh auth login && gh auth setup-git
git -C ~/Workspaces/patlynk/app remote set-url origin https://github.com/<org>/app.git
```

**Recommended:** protect `main` on GitHub, so an agent can push branches but
never `main`.

## 8. How the workflow works

1. **Create a task** in the company's App project.
   - **Product feature:** assign it to the **Product Lead** first. It writes a
     `spec` (user problem, flow, success metric, acceptance criteria) and asks
     you to approve it, then hands the task to the Planner.
   - **Technical task:** go straight to step 2.
2. **Plan.** Assign the task to the **Planner**. If there's an approved spec,
   the plan follows it.
   - The Planner reads the repo (read-only) and writes the task's `plan`
     document.
   - It posts an approval card, and the task goes to `in_review`.
3. **Review the plan** (Plans tab or `plan` document):
   - **Approve**: the task goes to the Implementer.
   - **Reject with feedback**: the Planner revises and asks again. Every new
     revision needs a fresh approval.
   - **Comment**: the Planner reads it on its next wake.
4. **Implement.** The Implementer:
   - implements the approved plan revision in a git worktree and runs the
     tests;
   - pushes a branch and opens a PR;
   - writes an `implementation-report`, then sets the task `in_review`.
5. **Review** the PR and report, then mark the task `done` yourself.
6. **Discovery.** Every day the Tech Lead (technical) and the Product Lead
   (product, with web research) each propose up to three tasks in one card.
   Only the ones you accept become tasks.

**When an agent needs you** (expired SSO, MFA, a missing secret, a refused
command):

1. It posts a question card with the exact command and blocks the task.
2. You run the command in your terminal and answer the card.
3. The agent resumes where it left off.

**What's enforced, not just requested:**

- No implementation run starts without your approval of the current plan
  revision. This holds for retries, timers and recovery.
- Tech Lead, Product Lead and Planner runs are read-only.
- No agent can touch another company's folder or your personal credentials.

## 9. Troubleshooting

| Error code / symptom | Fix |
|---|---|
| `claude_subscription_auth_required` | An `ANTHROPIC_API_KEY` or Bedrock variable is visible. Unset it and restart `pnpm dev`. |
| `plan_approval_required` | Approve the task's current plan revision. Only `claude_local` agents can run unapproved tasks, and only read-only. |
| `claude_sandbox_workspace_outside_root` | Point the project's Codebase at a folder under `~/Workspaces/<company>/`. |
| `read_only_run_modified_workspace` | A read-only run changed files. Check `git status` in the repo and revert. |
| `claude_permission_profile_conflict` | Remove `--settings`/permission flags from the agent's extra args. |
| `adapter_engine_unavailable` | Set the agent's engine to CLI (the imported agents already do). |
| `aws`: "profile could not be found" | Run `pcaws <company> configure sso`; check `AWS_PROFILE` in the project env. |
| A CLI can't reach a host | Add the domain to the agent's `claudeSandbox.allowedDomains` (Advanced tab). |
| `pnpm` refuses to run (`ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`) | `node_modules` came from another pnpm; run `pnpm install` with the repo's pnpm (`mise install`, then `pnpm --version` should print 12.16.1). |
| "Agent skills awaiting approval: acpx, dotenv" | Informational pnpm 12 notice. Paperclip doesn't need them; leave them unapproved. |

## 10. Updating from upstream

```sh
git fetch upstream
git merge upstream/master        # or rebase; resolve conflicts, then:
pnpm install && pnpm dev         # migrations apply on start
```

**pnpm conflicts.** This fork pins pnpm 12.16.1. It merged upstream's pnpm 11
migration (PR paperclipai/paperclip#13894), so `pnpm-workspace.yaml` is the
only place pnpm config lives (patches, overrides, `allowBuilds`). Upstream
still pins its older pnpm until that PR lands. When merging:

- **`package.json`:** keep `"packageManager": "pnpm@12.16.1"` and no `pnpm`
  field.
- **New `pnpm.*` entries from upstream:** if upstream adds a patch or override
  to `package.json#pnpm`, move it into `pnpm-workspace.yaml` instead.
- **`pnpm-lock.yaml`:** take upstream's version (`git checkout --theirs
  pnpm-lock.yaml`), run `pnpm install`, and commit the regenerated lockfile.
- **New references to upstream's older pnpm version** in workflows or docs: bump them to 12.16.1.
- **Check:** `pnpm run check:pnpm-version` verifies all of the above.

Fork-specific code is mostly in:

- `packages/adapters/claude-local/src/server/{permissions,sandbox-profile,sandbox-tools,read-only-workspace-guard}.ts`
- `server/src/services/plan-approval-gate.ts`
- `doc/solo-cto/`
