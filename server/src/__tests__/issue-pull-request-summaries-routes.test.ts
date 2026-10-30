import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, issues, issueWorkProducts } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue pull request summaries", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-pull-requests-");
  const oldPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  beforeAll(() => { process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce"; });
  afterAll(() => {
    if (oldPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = oldPrivacy;
  });

  // Merged and non-GitHub pull requests never reach GitHub, so these tests stay offline.
  async function fixture() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Pull requests");
    const rows = await ctx.db.insert(issues).values([
      { companyId: company.companyId, title: "Merged", status: "done" },
      { companyId: company.companyId, title: "Open", status: "in_review" },
      { companyId: company.companyId, title: "No PR", status: "todo" },
    ]).returning();
    await ctx.db.insert(issueWorkProducts).values([
      { companyId: company.companyId, issueId: rows[0]!.id, type: "pull_request", provider: "github", title: "PR", url: "https://github.com/acme/app/pull/7", status: "merged" },
      { companyId: company.companyId, issueId: rows[1]!.id, type: "pull_request", provider: "custom", title: "PR", url: "https://example.com/pr/8", status: "ready_for_review" },
      { companyId: company.companyId, issueId: rows[2]!.id, type: "branch", provider: "github", title: "Branch", url: "https://github.com/acme/app/tree/x", status: "active" },
    ]);
    return { ...company, rows };
  }
  function app(actor: Express.Request["actor"]) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor; next(); });
    result.use("/api", issueRoutes(ctx.db, {} as never));
    result.use(errorHandler);
    return result;
  }
  const url = (companyId: string) => `/api/companies/${companyId}/issues/pull-requests`;

  it("returns one pull request per issue that has one", async () => {
    const f = await fixture();
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: f.rows.map((row) => row.id).join(",") }).expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual(expect.arrayContaining([
      { issueId: f.rows[0]!.id, url: "https://github.com/acme/app/pull/7", number: 7, state: "merged" },
      { issueId: f.rows[1]!.id, url: "https://example.com/pr/8", number: null, state: "open" },
    ]));
    expect(res.body).toHaveLength(2);
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
    await ctx.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, f.rows[1]!.id));
    const privateId = randomUUID();
    await ctx.db.insert(issues).values({ id: privateId, companyId: f.companyId, title: "Private", visibility: "private", privacyRootIssueId: privateId, responsibleUserId: "someone-else", createdByUserId: "someone-else" });
    await ctx.db.insert(issueWorkProducts).values({ companyId: f.companyId, issueId: privateId, type: "pull_request", provider: "github", title: "PR", url: "https://github.com/acme/app/pull/9", status: "merged" });
    const ids = [f.rows[0]!.id, f.rows[1]!.id, privateId, foreign.rows[0]!.id];
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.join(",") }).expect(200);
    expect(res.body.map((row: { issueId: string }) => row.issueId)).toEqual([f.rows[0]!.id]);
    await request(app(f.actor)).get(url(foreign.companyId)).query({ ids: foreign.rows[0]!.id }).expect(403);
  });

  it("rejects task-bridge keys", async () => {
    const f = await fixture();
    const [agent] = await ctx.db.insert(agents).values({ companyId: f.companyId, name: "Reader", role: "engineer", adapterType: "process" }).returning();
    const actor = { type: "agent", agentId: agent!.id, companyId: f.companyId, source: "agent_key", keyScope: { kind: "task_bridge", issueId: f.rows[0]!.id } } as Express.Request["actor"];
    await request(app(actor)).get(url(f.companyId)).query({ ids: f.rows[0]!.id }).expect(403);
  });
});
