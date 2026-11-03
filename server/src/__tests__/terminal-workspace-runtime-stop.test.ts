import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal runtime stop tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A preview belongs to its task: it stops as soon as the task tree is finished, while the
// worktree itself still waits for the archive cooldown.
describeEmbeddedPostgres("runtime services of a finished task", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-runtime-stop-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null, parentId: null });
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The default one-day cooldown keeps the archive (and its git inspection) out of these tests,
  // and compaction is off, so the sweep never touches the (missing) worktree directory.
  function sweep() {
    return executionWorkspaceService(db, {
      resolvePullRequestDetails: async () => ({ state: "unknown", headRef: null, headSha: null }),
      workspaceCompactionDelayMs: null,
    }).sweepTerminalWorkspaces();
  }

  async function seed(options: { mode?: "isolated_workspace" | "shared_workspace"; status?: string } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issuePrefix = `R${companyId.slice(0, 7).toUpperCase()}`;
    const worktreePath = path.join(os.tmpdir(), "paperclip-terminal-runtime-stop", executionWorkspaceId);
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "Previews", status: "in_progress" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary", sourceType: "local_path", isPrimary: true,
      cwd: path.dirname(worktreePath),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId, companyId, projectId, projectWorkspaceId,
      mode: options.mode ?? "isolated_workspace", strategyType: "git_worktree", name: "PAP-1-preview",
      status: "in_review", cwd: worktreePath, providerRef: worktreePath, providerType: "git_worktree",
      baseRef: "main", branchName: "PAP-1-preview",
    });
    const status = options.status ?? "done";
    await db.insert(issues).values({
      id: sourceIssueId, companyId, projectId, identifier: `${issuePrefix}-1`, title: "Previewed task",
      status, priority: "medium", executionWorkspaceId,
      ...(status === "done" ? { completedAt: new Date() } : {}),
      ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
    });
    await db.update(executionWorkspaces).set({ sourceIssueId }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    const serviceId = randomUUID();
    await db.insert(workspaceRuntimeServices).values({
      id: serviceId, companyId, projectId, projectWorkspaceId, executionWorkspaceId, issueId: sourceIssueId,
      scopeType: "project_workspace", serviceName: "Preview", status: "running", lifecycle: "shared",
      command: "pnpm dev", cwd: worktreePath, provider: "local_process", healthStatus: "healthy",
      url: "https://mini.example.ts.net:5173",
    });
    return { companyId, projectId, agentId, issuePrefix, executionWorkspaceId, sourceIssueId, serviceId };
  }

  async function serviceStatus(serviceId: string) {
    const [row] = await db.select({ status: workspaceRuntimeServices.status })
      .from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, serviceId));
    return row?.status ?? null;
  }

  async function stopActivity(executionWorkspaceId: string) {
    return db.select().from(activityLog).where(and(
      eq(activityLog.entityId, executionWorkspaceId),
      eq(activityLog.action, "execution_workspace.runtime_stop"),
    ));
  }

  it.each(["done", "cancelled"])("stops the task's own services once it is %s, and keeps the workspace", async (status) => {
    const f = await seed({ status });

    expect(await sweep()).toMatchObject({ archived: 0, skippedCooldown: 1 });

    expect(await serviceStatus(f.serviceId)).toBe("stopped");
    const [workspace] = await db.select({ status: executionWorkspaces.status })
      .from(executionWorkspaces).where(eq(executionWorkspaces.id, f.executionWorkspaceId));
    expect(workspace?.status).toBe("in_review");
    const activity = await stopActivity(f.executionWorkspaceId);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId: f.companyId,
      actorType: "system",
      entityType: "execution_workspace",
      details: { reason: "issue_terminal", sourceIssueId: f.sourceIssueId, serviceNames: ["Preview"] },
    });

    // Nothing left to stop: a later sweep neither stops nor logs again.
    await sweep();
    expect(await stopActivity(f.executionWorkspaceId)).toHaveLength(1);
  });

  it("keeps them while the task is still open", async () => {
    const f = await seed({ status: "in_review" });
    await sweep();
    expect(await serviceStatus(f.serviceId)).toBe("running");
  });

  it("keeps them while a sub-task is open", async () => {
    const f = await seed();
    await db.insert(issues).values({
      companyId: f.companyId, projectId: f.projectId, identifier: `${f.issuePrefix}-2`, title: "Follow-up",
      status: "todo", priority: "medium", parentId: f.sourceIssueId,
    });
    await sweep();
    expect(await serviceStatus(f.serviceId)).toBe("running");
  });

  it("keeps them while another open task reuses the workspace", async () => {
    const f = await seed();
    await db.insert(issues).values({
      companyId: f.companyId, projectId: f.projectId, identifier: `${f.issuePrefix}-2`, title: "Reuses the worktree",
      status: "in_review", priority: "medium", executionWorkspaceId: f.executionWorkspaceId,
    });
    await sweep();
    expect(await serviceStatus(f.serviceId)).toBe("running");
  });

  it("keeps them while a run holds the task, and stops them once it is released", async () => {
    const f = await seed();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, f.sourceIssueId));

    await sweep();
    expect(await serviceStatus(f.serviceId)).toBe("running");

    await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, f.sourceIssueId));
    await sweep();
    expect(await serviceStatus(f.serviceId)).toBe("stopped");
  });

  it("keeps them while a queued run targets the task through its context", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: f.companyId, agentId: f.agentId, status: "queued",
      contextSnapshot: { issueId: f.sourceIssueId },
    });
    await sweep();
    expect(await serviceStatus(f.serviceId)).toBe("running");
  });

  it("leaves a shared workspace's services alone, since they run in the project's checkout", async () => {
    const f = await seed({ mode: "shared_workspace" });
    await sweep();
    expect(await serviceStatus(f.serviceId)).toBe("running");
    expect(await stopActivity(f.executionWorkspaceId)).toHaveLength(0);
  });
});
