import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  decidePlanGateRun,
  evaluatePlanApproval,
  planGateAllowsAgentCheckout,
  planGateContextFor,
  readPlanApprovalImplementer,
} from "../services/plan-approval-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plan approval gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plan approval gate", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-approval-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { gated?: boolean } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const plannerId = randomUUID();
    const implementerId = randomUUID();
    const codexId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Solo CTO",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agent = (id: string, name: string, adapterType: string) => ({
      id, companyId, name, role: "engineer", status: "idle", adapterType,
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([
      agent(plannerId, "Planner", "claude_local"),
      agent(implementerId, "Implementer", "claude_local"),
      agent(codexId, "Codex", "codex_local"),
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "App",
      planApprovalPolicy: options.gated === false ? null : { enabled: true, implementerAgentId: implementerId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      identifier: "APP-1",
      title: "Add passwordless login",
      status: "todo",
      priority: "medium",
      workMode: "planning",
      assigneeAgentId: plannerId,
    });
    return { companyId, projectId, issueId, plannerId, implementerId, codexId };
  }

  async function writePlan(fixture: { companyId: string; issueId: string }, revisionNumber: number, documentId?: string) {
    const revisionId = randomUUID();
    if (documentId) {
      await db.update(documents)
        .set({ latestRevisionId: revisionId, latestRevisionNumber: revisionNumber, latestBody: `plan v${revisionNumber}` })
        .where(eq(documents.id, documentId));
      return { documentId, revisionId };
    }
    const newDocumentId = randomUUID();
    await db.insert(documents).values({
      id: newDocumentId,
      companyId: fixture.companyId,
      title: "Plan",
      latestBody: `plan v${revisionNumber}`,
      latestRevisionId: revisionId,
      latestRevisionNumber: revisionNumber,
    });
    await db.insert(issueDocuments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      documentId: newDocumentId,
      key: "plan",
    });
    return { documentId: newDocumentId, revisionId };
  }

  async function confirmation(
    fixture: { companyId: string; issueId: string; plannerId: string },
    revisionId: string,
    resolution: { status: "pending" | "accepted" | "rejected"; byUserId?: string; byAgentId?: string },
  ) {
    await db.insert(issueThreadInteractions).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      kind: "request_confirmation",
      status: resolution.status,
      createdByAgentId: fixture.plannerId,
      resolvedByUserId: resolution.byUserId ?? null,
      resolvedByAgentId: resolution.byAgentId ?? null,
      resolvedAt: resolution.status === "pending" ? null : new Date(),
      payload: {
        version: 1,
        prompt: "Approve the plan?",
        target: { type: "issue_document", issueId: fixture.issueId, key: "plan", revisionId },
      } as never,
    });
  }

  it("leaves projects without a policy ungated", async () => {
    const fixture = await seed({ gated: false });
    const evaluation = await evaluatePlanApproval(db, fixture);
    expect(evaluation).toEqual({ required: false });
    expect(decidePlanGateRun(evaluation, { adapterType: "codex_local" })).toEqual({ kind: "ungated" });
    expect(await readPlanApprovalImplementer(db, fixture)).toBeNull();
  });

  it("confines planning to read-only before any plan exists, and blocks adapters that cannot", async () => {
    const fixture = await seed();
    const evaluation = await evaluatePlanApproval(db, fixture);
    expect(evaluation).toMatchObject({ required: true, approved: false, reason: "no_plan" });
    expect(decidePlanGateRun(evaluation, { adapterType: "claude_local" })).toEqual({ kind: "plan" });
    expect(decidePlanGateRun(evaluation, { adapterType: "codex_local" })).toMatchObject({ kind: "blocked" });
    expect(planGateContextFor(fixture.issueId, { kind: "plan" })).toEqual({ issueId: fixture.issueId, mode: "plan" });
  });

  it("does not treat a pending confirmation, an agent acceptance, or a rejection as approval", async () => {
    const fixture = await seed();
    const { revisionId } = await writePlan(fixture, 1);
    await confirmation(fixture, revisionId, { status: "pending" });
    await confirmation(fixture, revisionId, { status: "accepted", byAgentId: fixture.plannerId });
    await confirmation(fixture, revisionId, { status: "rejected", byUserId: "board-user" });
    const evaluation = await evaluatePlanApproval(db, fixture);
    expect(evaluation).toMatchObject({ required: true, approved: false, reason: "not_approved", planRevisionNumber: 1 });
    expect(decidePlanGateRun(evaluation, { adapterType: "claude_local" })).toEqual({ kind: "plan" });
  });

  it("allows implementation of exactly the approved revision", async () => {
    const fixture = await seed();
    const { revisionId } = await writePlan(fixture, 1);
    await confirmation(fixture, revisionId, { status: "accepted", byUserId: "board-user" });
    const evaluation = await evaluatePlanApproval(db, fixture);
    expect(evaluation).toMatchObject({
      required: true,
      approved: true,
      planRevisionId: revisionId,
      planRevisionNumber: 1,
      approvedByUserId: "board-user",
      implementerAgentId: fixture.implementerId,
    });
    expect(decidePlanGateRun(evaluation, { adapterType: "codex_local" })).toEqual({
      kind: "implement",
      approvedRevisionId: revisionId,
      approvedRevisionNumber: 1,
    });
  });

  it("invalidates approval when the plan gets a new revision", async () => {
    const fixture = await seed();
    const first = await writePlan(fixture, 1);
    await confirmation(fixture, first.revisionId, { status: "accepted", byUserId: "board-user" });
    const second = await writePlan(fixture, 2, first.documentId);
    const stale = await evaluatePlanApproval(db, fixture);
    expect(stale).toMatchObject({ required: true, approved: false, reason: "approval_stale", planRevisionNumber: 2 });
    expect(decidePlanGateRun(stale, { adapterType: "claude_local" })).toEqual({ kind: "plan" });

    await confirmation(fixture, second.revisionId, { status: "accepted", byUserId: "board-user" });
    expect(await evaluatePlanApproval(db, fixture)).toMatchObject({ approved: true, planRevisionId: second.revisionId });
  });

  it("lets only a read-only run bound to the task check it out before approval", async () => {
    const fixture = await seed();
    await writePlan(fixture, 1);
    const run = async (agentId: string, contextSnapshot: Record<string, unknown>) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId: fixture.companyId, agentId, status: "running", contextSnapshot });
      return id;
    };
    const boundPlannerRun = await run(fixture.plannerId, { issueId: fixture.issueId });
    const timerRun = await run(fixture.implementerId, {});
    const codexRun = await run(fixture.codexId, { issueId: fixture.issueId });
    const check = (agentId: string, checkoutRunId: string | null) =>
      planGateAllowsAgentCheckout(db, { companyId: fixture.companyId, issueId: fixture.issueId, agentId, checkoutRunId });

    expect(await check(fixture.plannerId, boundPlannerRun)).toEqual({ allowed: true });
    expect(await check(fixture.implementerId, timerRun)).toMatchObject({ allowed: false });
    expect(await check(fixture.codexId, codexRun)).toMatchObject({ allowed: false });
    expect(await check(fixture.implementerId, null)).toMatchObject({ allowed: false });
    // A run id belonging to another agent is not accepted as evidence.
    expect(await check(fixture.implementerId, boundPlannerRun)).toMatchObject({ allowed: false });
  });

  it("allows any checkout once the current plan is approved", async () => {
    const fixture = await seed();
    const { revisionId } = await writePlan(fixture, 1);
    await confirmation(fixture, revisionId, { status: "accepted", byUserId: "board-user" });
    expect(await planGateAllowsAgentCheckout(db, {
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.implementerId,
      checkoutRunId: null,
    })).toEqual({ allowed: true });
  });
});
