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

  async function workspace(companyId: string, projectId: string, projectWorkspaceId: string, mode: string) {
    const [row] = await ctx.db.insert(executionWorkspaces).values({
      companyId, projectId, projectWorkspaceId, mode, strategyType: "git_worktree", name: `ws-${randomUUID().slice(0, 8)}`,
      status: "active", cwd: `/tmp/paperclip-runtime-services/${randomUUID()}`, providerType: "git_worktree",
    }).returning();
    return row!;
  }

  async function service(input: {
    companyId: string; projectId: string; projectWorkspaceId: string; executionWorkspaceId: string | null;
    serviceName?: string; status?: string; url?: string | null; scopeType?: string;
  }) {
    await ctx.db.insert(workspaceRuntimeServices).values({
      id: randomUUID(), companyId: input.companyId, projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId, executionWorkspaceId: input.executionWorkspaceId,
      scopeType: input.scopeType ?? "project_workspace", serviceName: input.serviceName ?? "Preview",
      status: input.status ?? "running", lifecycle: "shared", command: "pnpm dev", cwd: "/tmp",
      provider: "local_process", healthStatus: "healthy",
      url: input.url === undefined ? "https://mini.example.ts.net:5173" : input.url,
    });
  }

  async function fixture() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Runtime services");
    const [project] = await ctx.db.insert(projects).values({ companyId: company.companyId, name: "App", status: "in_progress" }).returning();
    const [projectWorkspace] = await ctx.db.insert(projectWorkspaces).values({
      companyId: company.companyId, projectId: project!.id, name: "Primary", sourceType: "local_path", isPrimary: true, cwd: "/tmp",
    }).returning();
    const ids = { companyId: company.companyId, projectId: project!.id, projectWorkspaceId: projectWorkspace!.id };
    const running = await workspace(ids.companyId, ids.projectId, ids.projectWorkspaceId, "isolated_workspace");
    const starting = await workspace(ids.companyId, ids.projectId, ids.projectWorkspaceId, "isolated_workspace");
    const noUrl = await workspace(ids.companyId, ids.projectId, ids.projectWorkspaceId, "isolated_workspace");
    const shared = await workspace(ids.companyId, ids.projectId, ids.projectWorkspaceId, "shared_workspace");
    await service({ ...ids, executionWorkspaceId: running.id, serviceName: "Storybook", status: "stopped", url: "https://mini.example.ts.net:6006" });
    await service({ ...ids, executionWorkspaceId: running.id });
    await service({ ...ids, executionWorkspaceId: starting.id, status: "starting" });
    await service({ ...ids, executionWorkspaceId: noUrl.id, url: null });
    // The project's own checkout preview, which a shared workspace inherits.
    await service({ ...ids, executionWorkspaceId: null, url: "https://mini.example.ts.net:5174" });
    const rows = await ctx.db.insert(issues).values([
      { companyId: ids.companyId, projectId: ids.projectId, title: "Previewed", status: "in_review", executionWorkspaceId: running.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Starting", status: "in_progress", executionWorkspaceId: starting.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "No URL", status: "in_progress", executionWorkspaceId: noUrl.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "Shared", status: "in_progress", executionWorkspaceId: shared.id },
      { companyId: ids.companyId, projectId: ids.projectId, title: "No workspace", status: "todo" },
    ]).returning();
    return { ...company, ...ids, rows, running };
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

  it("returns the running service with a URL in each task's own isolated workspace", async () => {
    const f = await fixture();
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: f.rows.map((row) => row.id).join(",") }).expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual([
      { issueId: f.rows[0]!.id, serviceName: "Preview", url: "https://mini.example.ts.net:5173" },
    ]);
  });

  it("drops the link once the service stops", async () => {
    const f = await fixture();
    await ctx.db.update(workspaceRuntimeServices).set({ status: "stopped" })
      .where(eq(workspaceRuntimeServices.executionWorkspaceId, f.running.id));
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(200);
    expect(res.body).toEqual([]);
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
