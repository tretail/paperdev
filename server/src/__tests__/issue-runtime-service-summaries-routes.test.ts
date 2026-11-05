import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, executionWorkspaces, issues, projects, projectWorkspaces, workspaceRuntimeServices } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue runtime service summaries", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-runtime-services-");
  const oldPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  beforeAll(() => { process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce"; });
  afterAll(() => {
    if (oldPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = oldPrivacy;
  });

  // The project workspace's services: one without a browser URL, then the preview.
  const projectRuntime = {
    workspaceRuntime: {
      services: [
        { name: "Worker", command: "pnpm worker" },
        {
          name: "Preview", command: "pnpm dev", lifecycle: "shared", port: { type: "auto" },
          expose: { type: "url", urlTemplate: "https://mini.example.ts.net:{{port}}" },
        },
      ],
    },
  };

  async function workspace(
    companyId: string, projectId: string, projectWorkspaceId: string, mode: string,
    extra: { status?: string; metadata?: Record<string, unknown> } = {},
  ) {
    const [row] = await ctx.db.insert(executionWorkspaces).values({
      companyId, projectId, projectWorkspaceId, mode, strategyType: "git_worktree", name: `ws-${randomUUID().slice(0, 8)}`,
      status: extra.status ?? "active", cwd: `/tmp/paperclip-runtime-services/${randomUUID()}`, providerType: "git_worktree",
      metadata: extra.metadata ?? null,
    }).returning();
    return row!;
  }

  async function service(input: {
    companyId: string; projectId: string; projectWorkspaceId: string; executionWorkspaceId: string | null;
    serviceName?: string; command?: string; status?: string; url?: string | null; scopeType?: string;
  }) {
    await ctx.db.insert(workspaceRuntimeServices).values({
      id: randomUUID(), companyId: input.companyId, projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId, executionWorkspaceId: input.executionWorkspaceId,
      scopeType: input.scopeType ?? "project_workspace", serviceName: input.serviceName ?? "Preview",
      status: input.status ?? "running", lifecycle: "shared", command: input.command ?? "pnpm dev", cwd: "/tmp",
      provider: "local_process", healthStatus: "healthy",
      url: input.url === undefined ? "https://mini.example.ts.net:5173" : input.url,
    });
  }

  async function fixture() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Runtime services");
    const [project] = await ctx.db.insert(projects).values({ companyId: company.companyId, name: "App", status: "in_progress" }).returning();
    const [projectWorkspace] = await ctx.db.insert(projectWorkspaces).values({
      companyId: company.companyId, projectId: project!.id, name: "Primary", sourceType: "local_path", isPrimary: true, cwd: "/tmp",
      metadata: { runtimeConfig: projectRuntime },
    }).returning();
    const ids = { companyId: company.companyId, projectId: project!.id, projectWorkspaceId: projectWorkspace!.id };
    const isolated = (extra?: { status?: string; metadata?: Record<string, unknown> }) =>
      workspace(ids.companyId, ids.projectId, ids.projectWorkspaceId, "isolated_workspace", extra);
    const running = await isolated();
    const starting = await isolated();
    const stopped = await isolated();
    const neverStarted = await isolated();
    const failed = await isolated();
    // Its own config, with no service a browser opens.
    const noPreview = await isolated({ metadata: { config: { workspaceRuntime: { services: [{ name: "Worker", command: "pnpm worker" }] } } } });
    const archived = await isolated({ status: "archived" });
    const shared = await workspace(ids.companyId, ids.projectId, ids.projectWorkspaceId, "shared_workspace");
    await service({ ...ids, executionWorkspaceId: running.id, serviceName: "Worker", command: "pnpm worker", url: null });
    await service({ ...ids, executionWorkspaceId: running.id });
    await service({ ...ids, executionWorkspaceId: starting.id, status: "starting" });
    // A stopped row keeps the URL it last had; the summary doesn't hand it out.
    await service({ ...ids, executionWorkspaceId: stopped.id, status: "stopped", url: "https://mini.example.ts.net:5999" });
    await service({ ...ids, executionWorkspaceId: failed.id, status: "failed" });
    await service({ ...ids, executionWorkspaceId: noPreview.id, serviceName: "Worker", command: "pnpm worker", url: null });
    await service({ ...ids, executionWorkspaceId: archived.id });
    // The project's own checkout preview, which a shared workspace inherits.
    await service({ ...ids, executionWorkspaceId: null, url: "https://mini.example.ts.net:5174" });
    const rows = await ctx.db.insert(issues).values([
      { companyId: ids.companyId, projectId: ids.projectId, title: "Running", status: "in_review", executionWorkspaceId: running.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Starting", status: "in_progress", executionWorkspaceId: starting.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Stopped", status: "in_progress", executionWorkspaceId: stopped.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Never started", status: "in_progress", executionWorkspaceId: neverStarted.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Failed", status: "in_progress", executionWorkspaceId: failed.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "No preview", status: "in_progress", executionWorkspaceId: noPreview.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Archived", status: "done", executionWorkspaceId: archived.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Shared", status: "in_progress", executionWorkspaceId: shared.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "No workspace", status: "todo" },
    ]).returning();
    return { ...company, ...ids, rows, running, starting, stopped, neverStarted, failed };
  }
  function app(actor: Express.Request["actor"]) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor; next(); });
    result.use("/api", issueRoutes(ctx.db, {} as never));
    result.use(errorHandler);
    return result;
  }
  const url = (companyId: string) => `/api/companies/${companyId}/issues/runtime-services`;

  const byIssue = (body: Array<{ issueId: string }>) => [...body].sort((a, b) => a.issueId.localeCompare(b.issueId));

  it("returns each task's own preview, running or not, with a URL only while it runs", async () => {
    const f = await fixture();
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: f.rows.map((row) => row.id).join(",") }).expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const preview = (issueIndex: number, executionWorkspaceId: string, status: string, previewUrl: string | null = null) => ({
      issueId: f.rows[issueIndex]!.id, executionWorkspaceId, serviceName: "Preview", serviceIndex: 1, status, url: previewUrl,
    });
    expect(byIssue(res.body)).toEqual(byIssue([
      preview(0, f.running.id, "running", "https://mini.example.ts.net:5173"),
      preview(1, f.starting.id, "starting"),
      preview(2, f.stopped.id, "stopped"),
      preview(3, f.neverStarted.id, "stopped"),
      preview(4, f.failed.id, "failed"),
    ]));
  });

  it("drops the URL once the service stops", async () => {
    const f = await fixture();
    await ctx.db.update(workspaceRuntimeServices).set({ status: "stopped" })
      .where(eq(workspaceRuntimeServices.executionWorkspaceId, f.running.id));
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(200);
    expect(res.body).toEqual([expect.objectContaining({ issueId: f.rows[0]!.id, status: "stopped", url: null })]);
  });

  it.each(["", "?ids=", "?ids=nope", "?ids=,", "?ids[]=nope",
    `?ids=${randomUUID()}&ids=${randomUUID()}`, `?ids=${Array.from({ length: 101 }, () => randomUUID()).join(",")}`,
  ])("rejects invalid query %s", async (query) => {
    const f = await fixture();
    await request(app(f.actor)).get(url(f.companyId) + query).expect(400);
  });

  it("omits hidden, private and foreign issues", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await ctx.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, f.rows[0]!.id));
    const privateId = randomUUID();
    await ctx.db.insert(issues).values({
      id: privateId, companyId: f.companyId, projectId: f.projectId, title: "Private", visibility: "private",
      privacyRootIssueId: privateId, responsibleUserId: "someone-else", createdByUserId: "someone-else",
      executionWorkspaceId: f.running.id,
    });
    const ids = [f.rows[0]!.id, privateId, foreign.rows[0]!.id];
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.join(",") }).expect(200);
    expect(res.body).toEqual([]);
    await request(app(f.actor)).get(url(foreign.companyId)).query({ ids: foreign.rows[0]!.id }).expect(403);
  });

  it("rejects task-bridge keys", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Reader", role: "engineer", adapterType: "process" }).returning();
    const actor = { type: "agent", agentId: agent!.id, companyId: f.companyId, source: "agent_key", keyScope: { kind: "task_bridge", issueId: f.rows[0]!.id } } as Express.Request["actor"];
    await request(app(actor)).get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(403);
  });
});
