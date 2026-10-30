import { describe, expect, it, vi } from "vitest";
import {
  enrichWorkProductMetadataWithDiff,
  refreshPullRequestWorkProductMetadata,
  summarizeIssuePullRequests,
  workProductDiffSummaryFromEventPayload,
  workProductService,
} from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("extracts runner totals and enriches work-product metadata", () => {
    const summary = workProductDiffSummaryFromEventPayload({
      schema: "paperclip.workspace.diff.v1",
      totals: { files: 3, additions: 17, deletions: 5 },
    });

    expect(summary).toEqual({ changedFiles: 3, additions: 17, deletions: 5 });
    expect(enrichWorkProductMetadataWithDiff({ repo: "paperclipai/paperclip" }, summary)).toEqual({
      repo: "paperclipai/paperclip",
      changedFiles: 3,
      additions: 17,
      deletions: 5,
    });

    const prpEvent = {
      schema: "paperclip.prp.event.v1",
      payload: { totals: { files: 2, additions: 9, deletions: 4 } },
    };
    expect(workProductDiffSummaryFromEventPayload({ prpEvent })).toEqual({
      changedFiles: 2,
      additions: 9,
      deletions: 4,
    });
    expect(workProductDiffSummaryFromEventPayload(prpEvent)).toEqual({
      changedFiles: 2,
      additions: 9,
      deletions: 4,
    });
  });

  it("refreshes pull-request state without mutating the stored work product", async () => {
    const product = createWorkProductRow({
      companyId: "company-1",
      url: "https://github.com/paperclipai/paperclip/pull/42",
      metadata: {
        repo: "paperclipai/paperclip",
        number: 42,
        additions: 17,
        deletions: 5,
        changedFiles: 3,
        state: "open",
        draft: false,
      },
    }) as any;
    const resolve = vi.fn(async () => ({
      state: "open" as const,
      workProductState: "merged" as const,
      draft: false,
      headRef: "feature/rich-cards",
      headSha: "abc123",
      baseRef: "master",
      additions: 20,
      deletions: 7,
      changedFiles: 4,
    }));

    const [refreshed] = await refreshPullRequestWorkProductMetadata([product], resolve);

    expect(resolve).toHaveBeenCalledWith("company-1", {
      host: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      number: 42,
    });
    expect(refreshed?.metadata).toMatchObject({
      state: "merged",
      draft: false,
      baseRef: "master",
      headRef: "feature/rich-cards",
      additions: 20,
      deletions: 7,
      changedFiles: 4,
    });
    expect(product.metadata.state).toBe("open");
  });

  it.each([
    { url: "https://github.com/example/private-repo/pull/42" },
    { repository: "example/private-repo", number: 42 },
  ])("refreshes a PR whose identity is stored only in metadata: %j", async (metadata) => {
    const product = createWorkProductRow({ url: null, metadata }) as any;
    const resolve = vi.fn(async () => ({ state: "merged" as const, workProductState: "merged" as const, headRef: null, headSha: null }));
    const [refreshed] = await refreshPullRequestWorkProductMetadata([product], resolve);
    expect(resolve).toHaveBeenCalledWith("company-1", {
      host: "github.com", owner: "example", repo: "private-repo", number: 42,
    });
    expect(refreshed.metadata).toMatchObject({ state: "merged" });
    expect(product.metadata).toEqual(metadata);
  });

  it("retains the saved PR when the provider cannot access it", async () => {
    const product = createWorkProductRow({ url: null, metadata: { url: "https://github.com/example/private-repo/pull/42" } }) as any;
    const resolve = vi.fn(async () => { throw new Error("Not found"); });
    const [refreshed] = await refreshPullRequestWorkProductMetadata([product], resolve);
    expect(refreshed).toBe(product);
  });

  it("resolves GitHub commit stats when runner diff events are unavailable", async () => {
    const resolveCommitDetails = vi.fn(async () => ({ additions: 13, deletions: 2, changedFiles: 3 }));
    const svc = workProductService({} as any, { resolveCommitDetails });

    await expect(svc.resolveCommitDiffSummary("company-1", {
      provider: "github",
      url: "https://github.com/paperclipai/paperclip/commit/9c12ae7b41e5",
      metadata: null,
    })).resolves.toEqual({ additions: 13, deletions: 2, changedFiles: 3 });
    expect(resolveCommitDetails).toHaveBeenCalledWith("company-1", {
      host: "github.com",
      owner: "paperclipai",
      repo: "paperclip",
      sha: "9c12ae7b41e5",
    });
  });

  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });
});

describe("summarizeIssuePullRequests", () => {
  const github = (number: number) => `https://github.com/acme/app/pull/${number}`;
  const openDetails = { state: "open" as const, workProductState: "open" as const, headRef: null, headSha: null };

  it("keeps merged and closed pull requests without asking GitHub", async () => {
    const resolve = vi.fn(async () => openDetails);
    const summaries = await summarizeIssuePullRequests([
      createWorkProductRow({ issueId: "issue-1", url: github(7), status: "merged" }),
      createWorkProductRow({ issueId: "issue-2", url: github(9), status: "active", metadata: { state: "closed", number: 9 } }),
    ] as any, resolve, { cache: new Map() });
    expect(summaries).toEqual([
      { issueId: "issue-1", url: github(7), number: 7, state: "merged" },
      { issueId: "issue-2", url: github(9), number: 9, state: "closed" },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("checks open pull requests on GitHub at most once per TTL", async () => {
    const cache = new Map();
    const products = [createWorkProductRow({ issueId: "issue-1", url: github(12), status: "active" })] as any;
    const resolve = vi.fn(async () => ({ ...openDetails, state: "merged" as const, workProductState: "merged" as const }));
    const now = Date.parse("2026-10-30T12:00:00Z");

    await expect(summarizeIssuePullRequests(products, resolve, { cache, now })).resolves.toEqual([
      { issueId: "issue-1", url: github(12), number: 12, state: "merged" },
    ]);
    await summarizeIssuePullRequests(products, resolve, { cache, now: now + 60_000 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("company-1", { host: "github.com", owner: "acme", repo: "app", number: 12 });
    await summarizeIssuePullRequests(products, resolve, { cache, now: now + 3 * 60_000 });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("falls back to the stored status when GitHub can't be reached", async () => {
    const resolve = vi.fn(async () => { throw new Error("rate limited"); });
    const summaries = await summarizeIssuePullRequests([
      createWorkProductRow({ issueId: "issue-1", url: github(3), status: "draft" }),
      createWorkProductRow({ issueId: "issue-2", url: github(4), status: "ready_for_review" }),
      createWorkProductRow({ issueId: "issue-3", url: "https://example.com/pr/5", status: "active" }),
    ] as any, resolve, { cache: new Map() });
    expect(summaries.map((summary) => [summary.issueId, summary.number, summary.state])).toEqual([
      ["issue-1", 3, "draft"],
      ["issue-2", 4, "open"],
      ["issue-3", null, "open"],
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("shows the primary pull request, else the most recently updated, and skips ones without a link", async () => {
    const resolve = vi.fn(async () => openDetails);
    const summaries = await summarizeIssuePullRequests([
      createWorkProductRow({ id: "old", issueId: "issue-1", url: github(1), status: "merged", isPrimary: false, updatedAt: new Date("2026-10-01") }),
      createWorkProductRow({ id: "new", issueId: "issue-1", url: github(2), status: "merged", isPrimary: false, updatedAt: new Date("2026-10-20") }),
      createWorkProductRow({ id: "primary", issueId: "issue-2", url: github(3), status: "merged", isPrimary: true, updatedAt: new Date("2026-10-01") }),
      createWorkProductRow({ id: "newer", issueId: "issue-2", url: github(4), status: "merged", isPrimary: false, updatedAt: new Date("2026-10-20") }),
      createWorkProductRow({ issueId: "issue-3", url: null, status: "merged" }),
      createWorkProductRow({ issueId: "issue-4", url: github(5), type: "branch", status: "active" }),
    ] as any, resolve, { cache: new Map() });
    expect(summaries.map((summary) => [summary.issueId, summary.number]).sort()).toEqual([["issue-1", 2], ["issue-2", 3]]);
  });
});
