import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { agents, issues, projects } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

describeEmbeddedPostgres("project intake routing", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-intake-");
  const wakeup = vi.mocked(queueIssueAssignmentWakeup);
  beforeEach(() => wakeup.mockClear());

  async function fixture() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Intake");
    const [investigator, planner] = await ctx.db.insert(agents).values([
      { companyId: company.companyId, name: "Investigator", role: "general", adapterType: "process" },
      { companyId: company.companyId, name: "Planner", role: "engineer", adapterType: "process" },
    ]).returning();
    const [project] = await ctx.db.insert(projects)
      .values({ companyId: company.companyId, name: "App", intakeAgentId: investigator!.id })
      .returning();
    const app = routeApp(ctx.db, company.actor, issueRoutes, projectRoutes as never);
    return { ...company, investigator: investigator!, planner: planner!, project: project!, app };
  }

  const lastWake = () => wakeup.mock.calls.at(-1)?.[0];

  it("sends a board user's unassigned task to the intake agent in Backlog and wakes it", async () => {
    const f = await fixture();
    const res = await request(f.app)
      .post(`/api/companies/${f.companyId}/issues`)
      .send({ title: "Polls in the event chat", projectId: f.project.id })
      .expect(201);
    expect(res.body).toMatchObject({ assigneeAgentId: f.investigator.id, status: "backlog" });
    expect(lastWake()).toMatchObject({ allowBacklog: true, issue: expect.objectContaining({ id: res.body.id }) });
  });

  it("routes a task the dialog pre-assigned to the intake agent, even when it asks for todo", async () => {
    const f = await fixture();
    const res = await request(f.app)
      .post(`/api/companies/${f.companyId}/issues`)
      .send({ title: "Calendar export", projectId: f.project.id, assigneeAgentId: f.investigator.id, status: "todo" })
      .expect(201);
    expect(res.body).toMatchObject({ assigneeAgentId: f.investigator.id, status: "backlog" });
    expect(lastWake()).toMatchObject({ allowBacklog: true });
  });

  it("leaves tasks assigned to someone else, child tasks and projects without intake alone", async () => {
    const f = await fixture();
    const assigned = await request(f.app)
      .post(`/api/companies/${f.companyId}/issues`)
      .send({ title: "Straight to planning", projectId: f.project.id, assigneeAgentId: f.planner.id })
      .expect(201);
    expect(assigned.body).toMatchObject({ assigneeAgentId: f.planner.id, status: "todo" });
    expect(lastWake()).toMatchObject({ allowBacklog: false });

    const child = await request(f.app)
      .post(`/api/companies/${f.companyId}/issues`)
      .send({ title: "A sub-step", projectId: f.project.id, parentId: assigned.body.id })
      .expect(201);
    expect(child.body.assigneeAgentId).toBeNull();
    expect(child.body.status).toBe("backlog");

    const [plain] = await ctx.db.insert(projects).values({ companyId: f.companyId, name: "Docs" }).returning();
    const unrouted = await request(f.app)
      .post(`/api/companies/${f.companyId}/issues`)
      .send({ title: "No intake here", projectId: plain!.id })
      .expect(201);
    expect(unrouted.body.assigneeAgentId).toBeNull();
    expect(lastWake()).toMatchObject({ allowBacklog: false });
  });

  it("lets only board users set an intake agent from the same company", async () => {
    const f = await fixture();
    const other = await fixture();
    await request(f.app).patch(`/api/projects/${f.project.id}`).send({ intakeAgentId: other.investigator.id }).expect(422);
    await request(f.app).patch(`/api/projects/${f.project.id}`).send({ intakeAgentId: f.planner.id }).expect(200);
    const [stored] = await ctx.db.select({ intakeAgentId: projects.intakeAgentId }).from(projects).where(eq(projects.id, f.project.id));
    expect(stored!.intakeAgentId).toBe(f.planner.id);

    const agentApp = routeApp(ctx.db, { type: "agent", agentId: f.planner.id, companyId: f.companyId, source: "agent_key" } as never, projectRoutes as never);
    await request(agentApp).patch(`/api/projects/${f.project.id}`).send({ intakeAgentId: null }).expect(403);
    const remaining = await ctx.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId));
    expect(remaining).toEqual([]);
  });
});
