# Install: Paperclip solo-CTO setup (fork `cto-workflow`)

This guide installs this fork on a new macOS machine and sets up one Paperclip
company per real company. Each company gets four local Claude Code agents
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

Paperclip resolves those shims from your home folder, so a CLI pinned only in a
repo's `.mise.toml` is not found. Keep every tool listed in `claudeSandbox.tools`
(at least `aws`) in this global config; `mise which aws` run from `~` must
print a path.

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

This repo can have any folder name (e.g. `paperdev/`); the agents never run in it.

A company folder can also be the repository itself, e.g. `~/Workspaces/together`
with `.git` at its root. The company root is then the repo, so the Implementer's
worktrees (`.paperclip/worktrees/`) and the CLI tool home (`.paperclip-tools/`)
are created inside it. Keep them out of git without committing anything:

```sh
printf '.paperclip/\n.paperclip-tools/\n' >> ~/Workspaces/together/.git/info/exclude
```

Tools that walk the folder themselves (ESLint, Prettier) don't read
`.git/info/exclude` and will lint or format the worktrees too. Add
`.paperclip/` and `.paperclip-tools/` to their ignore lists in the repo.

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

## 4. Database (local Postgres, password over TCP)

Run as your macOS user:

```sh
createuser paperclip
createdb --owner=paperclip paperclip
psql -d paperclip -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO paperclip;"
psql -d postgres -c '\password paperclip'   # choose a long random password
```

The `paperclip` user owns the database. That lets migrations create the
`pg_trgm` and `fuzzystrmatch` extensions without superuser rights.

**Require passwords over TCP.** Postgres.app trusts every local connection by
default. Sandboxed agents can reach `localhost`, so with `trust` an Implementer
can log in as your superuser role and run commands outside the sandbox. The
sandbox blocks the unix socket, so keep `trust` there only:

1. Open the file that `psql -d postgres -Atc 'show hba_file'` prints.
2. On the `host` lines (`127.0.0.1/32` and `::1/128`), replace `trust` with
   `scram-sha-256`. Leave the `local` lines on `trust`.
3. Reload: `psql -d postgres -c 'select pg_reload_conf()'`.
4. Other roles you use over TCP (apps on `localhost:5432`) now need a password:
   set one with `\password <role>` and add `localhost:5432:*:<role>:<password>`
   to `~/.pgpass` (mode `600`). Agents can't read `~/.pgpass`.

Your own `psql` without `-h` keeps using the socket, with no password.

**Instance env.** The server reads `~/.paperclip/instances/default/.env`.
Don't use the repo's `.env`: `pnpm dev` starts the server from `server/`, so a
`.env` at the repo root is never loaded. Create the file once with the database
URL and the instance secrets. Without `PAPERCLIP_AGENT_JWT_SECRET`, runs get no
`PAPERCLIP_API_KEY`, so agents can't post plans, cards or comments (the server
logs "local agent jwt secret missing"). Agents can't read `~/.paperclip`, and
neither `DATABASE_URL` nor `PAPERCLIP_*` variables are passed on to them.

```sh
mkdir -p ~/.paperclip/instances/default && (umask 077; {
  echo "DATABASE_URL=postgres://paperclip:<password>@localhost:5432/paperclip"
  echo "PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)"
  echo "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)"
} > ~/.paperclip/instances/default/.env)
```

Migrations run automatically when the server starts. Check that the startup
banner says `Mode external-postgres`.

**Never run agents on the embedded Postgres.** Without `DATABASE_URL`, the
server starts an embedded Postgres on `127.0.0.1:54329` with the fixed login
`paperclip`/`paperclip`. Sandboxed agents can reach localhost, so any agent
could connect to it, approve its own plans and read every company's data.
To move an existing embedded instance, stop `pnpm dev` (that stops the embedded
Postgres too), start it alone and copy it:

```sh
BIN=$(dirname "$(find node_modules/.pnpm -path '*embedded-postgres*' -name pg_ctl -type f | head -1)")
"$BIN/pg_ctl" -D ~/.paperclip/instances/default/db -o "-p 54329 -c listen_addresses=127.0.0.1" -w start
PGPASSWORD=paperclip pg_dump -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -Fc -f /tmp/paperclip.dump
pg_restore -h localhost -U paperclip -d paperclip --no-owner --no-privileges --exit-on-error /tmp/paperclip.dump
"$BIN/pg_ctl" -D ~/.paperclip/instances/default/db -m fast -w stop && rm /tmp/paperclip.dump
```

Then add `DATABASE_URL` to the instance env and start `pnpm dev`. Your
company secrets stay readable: their key lives in
`~/.paperclip/instances/default/secrets/`, not in the database.

**Optional:** a throwaway database for the plan-gate tests:

```sh
createdb --owner=paperclip paperclip_gate_test
cd server && PAPERCLIP_PLAN_APPROVAL_GATE_TEST_DATABASE_URL=postgres://paperclip:<password>@localhost:5432/paperclip_gate_test \
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
`tmux` session:

```sh
tmux new-session -d -s paperdev -c ~/Workspaces/paperclip && tmux send-keys -t paperdev 'pnpm dev' Enter
tmux attach -t paperdev   # watch the logs; detach with Ctrl-b d
```

`send-keys` runs `pnpm dev` inside your interactive shell, so `mise activate`
applies, and the shell stays open with the error if the server stops.

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
   - **Execution workspaces**: isolated, git worktree from `main` (the
     package sets this). Without it every run shares the main checkout, and
     the Implementer would work on top of your uncommitted changes. It only
     takes effect once **Instance settings → Experimental → Isolated
     workspaces** (`enableIsolatedWorkspaces`) is on, and it's off by default.
     Tasks created before you turn it on stay on the shared checkout, so
     recreate them.
   - **Worktree setup**: set the project's
     `workspaceStrategy.provisionCommand`. It runs outside the sandbox in
     each worktree when it is created or reused.
     - **mise repos:** add `mise exec -- true`. A worktree of a trusted repo
       inherits mise trust, but mise records it under `~/.local/state/mise`
       on first use, which the sandbox denies. Until then every `mise exec`
       in the run fails, including git hooks that use it.
     - **Untracked files:** a new worktree has none, such as `.env`. If the
       tests need one and CI builds it from `.env.example`, add the same step,
       e.g. `test -f .env || cp .env.example .env`.
     - Chain the steps with `;`. Particups uses
       `test -f .env || cp .env.example .env; mise exec -- true`.
   - **Env**: add this company's secrets (see 7.3).
2. **Company Settings → interaction governance**: set confirmations to
   **Human only**.
3. **Each agent → Configuration → Run test**: this should report
   subscription auth and "Claude OS sandbox is on for company directory …".
4. **Implementer → Advanced** (the YAML editor): under
   `spec.adapterConfig.claudeSandbox.tools`, list the CLIs this company uses,
   e.g. `[gh, aws, wrangler]`. It defaults to `[gh]`. The same editor holds
   `isolationRoot` and `allowedDomains`.
   - **Hide secret files** that sit inside the company folder, such as a repo
     `.env`: add them to `claudeSandbox.extraDenyRead` on **all four** agents,
     e.g. `[~/Workspaces/particups/.env]`. Both Bash and Claude's Read/Grep/Glob
     tools are then denied. Worktrees don't contain the untracked `.env`, so
     give the Implementer what its tests need through the project env or the
     worktree setup above.
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
pcaws() { local t=~/Workspaces/$1/.paperclip-tools/aws; shift; AWS_CONFIG_FILE=$t/config HOME=$t "$(mise which aws)" "$@"; }

pcaws patlynk configure sso                 # creates the profile in the company tool home
pcaws patlynk sso login --profile <profile> # repeat whenever SSO expires
```

`$(mise which aws)` calls the real binary: through the mise shim, the changed
`HOME` would make mise install a second copy of aws into the tool home.

If the profiles already exist in your personal `~/.aws/config`, you can copy
just the `[profile …]` and `[sso-session …]` sections this company's agents
may use (e.g. staging only, no production) into
`~/Workspaces/<company>/.paperclip-tools/aws/config` (mode `600`) instead of
running `configure sso`. This is not a hard boundary: one SSO login grants
every role your portal user has, so scope the permission sets in IAM Identity
Center if production must stay out of reach.

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
`GH_TOKEN` project secret: a fine-grained PAT limited to this company's
repositories (Metadata: read, Contents and Pull requests: read & write).

SSH can't leave the sandbox. Either use **HTTPS** remotes:

```sh
gh auth login && gh auth setup-git
git -C ~/Workspaces/patlynk/app remote set-url origin https://github.com/<org>/app.git
```

or **keep SSH remotes** for yourself and let agent runs rewrite them to HTTPS.
Create `~/Workspaces/<company>/.paperclip/gitconfig` (no secrets in it):

```ini
[user]
	name = Your Name
	email = you@example.com
[url "https://github.com/"]
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
[credential "https://github.com"]
	# The empty helper drops inherited helpers (osxkeychain, cache), so no
	# personal login or other company's token is ever used.
	helper =
	helper = !gh auth git-credential
```

Then add to the project env: `GIT_CONFIG_GLOBAL=<that file>`,
`GIT_CONFIG_NOSYSTEM=1` and
`GH_CONFIG_DIR=~/Workspaces/<company>/.paperclip-tools/gh`. Use absolute
paths. Put the file in `.paperclip/`, not `.paperclip-tools/`, because the
read-only agents can't read the tool home and their `git log` would fail.

**Recommended:** protect `main` on GitHub, so an agent can push branches but
never `main`.

**Toolchains.** Agents get the Node, pnpm and Java versions the repo pins,
through the mise shims: Paperclip removes its own `node_modules/.bin` and mise
install directories from the agent's `PATH`. Run `mise trust` in the repo
once. Keep each company's package caches in its own folder, so one company's
agents can't tamper with packages another company installs. Add to the project
env (absolute paths):

- `pnpm_config_store_dir=~/Workspaces/<company>/.paperclip-tools/pnpm-store`
  (pnpm 11+ ignores `npm_config_*`). The Implementer may also write pnpm 12's
  fixed lock folders, `/tmp/pnpm-*-locks-<uid>` and `/tmp/pnpm-modules-swaps-<uid>`.
- `GRADLE_USER_HOME=~/Workspaces/<company>/.paperclip-tools/gradle` for JVM
  repos. Java ignores `HTTPS_PROXY`, and the sandbox proxy needs the
  credential that variable carries. Set Gradle up once:

  ```sh
  G=~/Workspaces/<company>/.paperclip-tools/gradle
  mkdir -p $G/init.d && cp doc/solo-cto/gradle/paperclip-sandbox-proxy.init.gradle $G/init.d/
  printf 'org.gradle.daemon=false\nkotlin.compiler.execution.strategy=in-process\norg.gradle.vfs.watch=false\n' > $G/gradle.properties
  (cd <repo>/backend && GRADLE_USER_HOME=$G ./gradlew --version)   # caches the wrapper
  ```

  The init script points Gradle at the proxy for each build without printing
  anything. A long-lived daemon would outlive its sandbox session, hence
  `daemon=false`. The wrapper's own download redirects to GitHub release
  hosts, so the last line caches it from your terminal. Allow the repository
  hosts (`repo.maven.apache.org`, `repo1.maven.org`, `plugins.gradle.org`,
  `plugins-artifacts.gradle.org`) in `allowedDomains`.

  If the build uses a Java toolchain (foojay auto-provisioning), point Gradle
  at the JDK mise installs for the repo instead, because the sandbox blocks
  JDK downloads:

  ```sh
  printf 'org.gradle.java.installations.paths=%s\norg.gradle.java.installations.auto-download=false\n' \
    ~/.local/share/mise/installs/java/temurin-25 >> $G/gradle.properties
  ```

  On macOS the JVM ignores `TMPDIR` and writes temp files to the per-user
  `/var/folders/…/T`, which the sandbox denies. It also can't reach the
  window server, so a JVM that touches AWT hangs. For runs with sandbox
  tools, Paperclip sets `-Djava.io.tmpdir=$TMPDIR -Djava.awt.headless=true`
  in `JAVA_TOOL_OPTIONS`, which fixes the Kotlin compiler, image-processing
  tests and most others. JVM agent attach
  still can't work there: tests that use Mockito's inline mock maker fail with
  "Could not self-attach to current VM". Load Mockito as a `-javaagent` in
  the repo's test config instead, which Mockito recommends on JDK 21+.

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
| `claude_sandbox_workspace_outside_root` | Point the project's Codebase at a folder under `~/Workspaces/<company>/`. If the workspace path is under `~/.paperclip/…/isolated-workspace-attempts/`, a Retry after a failed setup copied the repo there instead of making a worktree, and every later retry reuses that copy: cancel the task and create it again. |
| `setup_failed`: `git worktree add` "could not lock config file .git/config" | Two tasks in one repo created their worktrees at once. The Paperclip build predates the per-repo worktree lock; update and restart `pnpm dev`, then cancel and re-create the task rather than using Retry. |
| `read_only_run_modified_workspace` | A read-only run changed files. Check `git status` in the repo and revert. |
| `claude_permission_profile_conflict` | Remove `--settings`/permission flags from the agent's extra args. |
| `adapter_engine_unavailable` | Set the agent's engine to CLI (the imported agents already do). |
| `aws`: "profile could not be found" | Run `pcaws <company> configure sso`; check `AWS_PROFILE` in the project env. |
| A CLI can't reach a host | Add the domain to the agent's `claudeSandbox.allowedDomains` (Advanced tab). |
| `pnpm` refuses to run (`ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`) | `node_modules` came from another pnpm; run `pnpm install` with the repo's pnpm (`mise install`, then `pnpm --version` should print 12.16.1). |
| Agents report HTTP 401 "Empty bearer token" and can't comment or write plans | `PAPERCLIP_AGENT_JWT_SECRET` is missing: create the instance secrets (section 4) and restart `pnpm dev`. |
| Imported agents show the **Paperclip Runner** adapter instead of Claude (CLI), and Run test says nothing about the sandbox | The package predates `runner: legacy` (once the native runner is built, `auto` picks it, and the sandbox, read-only mode and plan gate don't apply). Re-import with the current `doc/solo-cto/company`, or switch each agent's adapter back to `claude_local` with the package's config. |
| An agent reports Paperclip's own Node/pnpm versions instead of the repo's | Restart `pnpm dev` on a build with the launcher-`PATH` fix, and `mise trust` the repo. `command -v node` in a run should point to `mise/shims`. |
| Gradle: `UnknownHostException` or "Plugin … was not found" | The proxy init script or the cached wrapper is missing from `GRADLE_USER_HOME` (7.3, Toolchains). Otherwise check `allowedDomains`. |
| Kotlin: `FileSystemException: /var/folders/…/kotlin-compiler-….alive: Operation not permitted` | The Paperclip build predates the JVM temp-dir profile (7.3, Toolchains). Update and restart `pnpm dev`. |
| `git commit` fails in a hook: mise "failed to ln -sf … trusted-configs … Operation not permitted" | Add `mise exec -- true` to the project's `provisionCommand` (section 7.2, Worktree setup). An existing worktree keeps its own copy of the command, so set it on that execution workspace too, or start a new task. |
| A JVM test task hangs with no output (on macOS, a native stack in `LWCToolkit.initAppkit`) | The Paperclip build predates `-Djava.awt.headless=true` in the JVM profile (7.3, Toolchains). Update and restart `pnpm dev`. |
| Mockito: "Could not self-attach to current VM using external process" | The sandbox blocks JVM agent attach. Load Mockito as a `-javaagent` in the repo's test config (7.3, Toolchains). |
| A run that used the subscription shows "Connect your Claude account" | The Paperclip build predates the login-detector fix (`claude_auth_required` on a successful run). Update, restart `pnpm dev`, and dismiss the card. |
| pnpm: `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` | The Paperclip build predates the pnpm 12 lock folders in the Implementer's write allowlist. Update and restart `pnpm dev`. |
| `aws`: "Token has expired and refresh failed" | `pcaws <company> sso login --sso-session <name>`. An SSO login lasts as long as the IAM Identity Center session duration (8 hours by default), so the morning routines often find it expired. |
| ESLint: "multiple candidate TSConfigRootDirs" listing `.paperclip/worktrees/…` | Add `.paperclip/` and `.paperclip-tools/` to the repo's ESLint (and Prettier) ignores (section 2). |
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
