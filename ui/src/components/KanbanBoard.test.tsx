// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssuePullRequestSummary, IssueRuntimeServiceSummary, IssueStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKanbanColumnTone, groupKanbanLanes, KanbanBoard, KANBAN_UNTAGGED_LANE, resolveKanbanTargetStatus } from "./KanbanBoard";

const pullRequestsMock = vi.hoisted(() => ({ summaries: [] as IssuePullRequestSummary[] }));
const runtimeServicesMock = vi.hoisted(() => ({ summaries: [] as IssueRuntimeServiceSummary[] }));

vi.mock("../api/issues", () => ({
  issuesApi: {
    pullRequests: vi.fn(async () => pullRequestsMock.summaries),
    runtimeServices: vi.fn(async () => runtimeServicesMock.summaries),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function act(callback: () => void): void {
  flushSync(callback);
}

function createIssue(index: number, status: IssueStatus): Issue {
  return {
    id: `issue-${status}-${index}`,
    identifier: `PAP-${index}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${index}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: index === 1 ? "agent-1" : null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: index,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  };
}

function createIssues(count: number, status: IssueStatus): Issue[] {
  return Array.from({ length: count }, (_, index) => createIssue(index + 1, status));
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const render = (nextProps: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] }) => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <KanbanBoard
            agents={[{ id: "agent-1", name: "Codex" }]}
            liveIssueIds={new Set(["issue-todo-1"])}
            onUpdateIssue={vi.fn()}
            {...nextProps}
          />
        </QueryClientProvider>,
      );
    });
  };

  render(props);

  return { container, root, render };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    pullRequestsMock.summaries = [];
    runtimeServicesMock.summaries = [];
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });

  it("limits visible cards and reveals more cards per column", () => {
    const { container } = renderBoard({
      issues: createIssues(60, "todo"),
      compactCards: true,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    expect(container.textContent).toContain("Showing 50 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 50");
    expect(container.textContent).not.toContain("Issue 51");

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");
    expect(container.textContent).not.toContain("Show 10 more");
  });

  it("resets visible counts when the column page size changes", () => {
    const issues = createIssues(60, "todo");
    const { container, render } = renderBoard({
      issues,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");

    render({
      issues,
      initialVisibleCount: 10,
      revealIncrement: 10,
    });

    expect(container.textContent).toContain("Showing 10 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 10");
    expect(container.textContent).not.toContain("Issue 11");
  });

  it("renders collapsed statuses as rails without cards", () => {
    const { container } = renderBoard({
      issues: createIssues(3, "done"),
      collapsedStatuses: ["done"],
    });

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("3");
    expect(container.textContent).not.toContain("Issue 1");
  });

  it("gives every column a status-hued tone", () => {
    expect(getKanbanColumnTone("backlog").body).toContain("bg-muted/30");
    expect(getKanbanColumnTone("todo").body).toContain("amber");
    expect(getKanbanColumnTone("in_progress").body).toContain("blue");
    expect(getKanbanColumnTone("in_review").body).toContain("violet");
    expect(getKanbanColumnTone("blocked").body).toContain("red");
    expect(getKanbanColumnTone("done").body).toContain("green");
    expect(getKanbanColumnTone("cancelled").body).toContain("bg-muted/25");
    expect(getKanbanColumnTone("cancelled").card).toContain("opacity-80");
  });

  it("ghosts cancelled lane cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "cancelled"),
    });

    const card = container.querySelector('a[href="/issues/PAP-1"]')?.parentElement;

    expect(card?.className).toContain("bg-muted/35");
    expect(card?.className).toContain("opacity-80");
  });

  it("keeps core issue signals in compact cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      compactCards: true,
    });

    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Live");
  });

  it("resolves drop targets from status rails and cards", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
    ];

    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues)).toBe("blocked");
    expect(resolveKanbanTargetStatus("missing", issues)).toBeNull();
  });

  it("labels the in_review column Waiting", () => {
    const { container } = renderBoard({ issues: createIssues(1, "in_review") });
    expect(container.textContent).toContain("Waiting");
    expect(container.textContent).not.toMatch(/In review/i);
  });

  it("links a card to its pull request in a new tab, outside the task link", async () => {
    pullRequestsMock.summaries = [{
      issueId: "issue-in_review-1",
      url: "https://github.com/acme/app/pull/12345",
      number: 12345,
      state: "merged",
    }];
    const { container } = renderBoard({ issues: createIssues(2, "in_review") });
    await vi.waitFor(() => expect(container.querySelector('a[href^="https://github.com"]')).not.toBeNull());

    const link = container.querySelector<HTMLAnchorElement>('a[href^="https://github.com"]')!;
    expect(link.getAttribute("href")).toBe("https://github.com/acme/app/pull/12345");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toBe("#12345");
    expect(link.getAttribute("aria-label")).toBe("Open pull request #12345 (merged) on GitHub");
    expect(link.querySelector('[data-pr-state="merged"]')?.getAttribute("class")).toContain("text-(--pr-state-merged)");
    // A link inside the task link would be invalid HTML and would open the task too.
    expect(link.parentElement?.closest("a")).toBeNull();
    // Only the card with a pull request gets a button.
    expect(container.querySelectorAll('a[href^="https://github.com"]')).toHaveLength(1);
  });

  it("links a card to its running preview in a new tab, beside its pull request", async () => {
    pullRequestsMock.summaries = [{
      issueId: "issue-in_review-1",
      url: "https://github.com/acme/app/pull/7",
      number: 7,
      state: "open",
    }];
    runtimeServicesMock.summaries = [{
      issueId: "issue-in_review-1",
      serviceName: "Preview",
      url: "https://mini.example.ts.net:5173",
    }];
    const { container } = renderBoard({ issues: createIssues(2, "in_review") });
    await vi.waitFor(() => expect(container.querySelector('a[href^="https://mini.example.ts.net"]')).not.toBeNull());
    await vi.waitFor(() => expect(container.querySelector('a[href^="https://github.com"]')).not.toBeNull());

    const link = container.querySelector<HTMLAnchorElement>('a[href^="https://mini.example.ts.net"]')!;
    expect(link.getAttribute("href")).toBe("https://mini.example.ts.net:5173");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("aria-label")).toBe("Open Preview in a new tab");
    expect(link.parentElement?.closest("a")).toBeNull();
    // Both buttons share one group, preview first.
    const group = link.parentElement!;
    expect([...group.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href")))
      .toEqual(["https://mini.example.ts.net:5173", "https://github.com/acme/app/pull/7"]);

    // Pressing the button neither starts a drag nor opens the task.
    const reachedCard = vi.fn();
    document.body.addEventListener("pointerdown", reachedCard);
    document.body.addEventListener("click", reachedCard);
    link.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.body.removeEventListener("pointerdown", reachedCard);
    document.body.removeEventListener("click", reachedCard);
    expect(reachedCard).not.toHaveBeenCalled();

    // Only the card with a running preview gets one.
    expect(container.querySelectorAll('a[href^="https://mini.example.ts.net"]')).toHaveLength(1);
  });

  describe("tag swimlanes", () => {
    const label = (name: string, color = "var(--label-test)") => ({
      id: `label-${name.toLowerCase()}`, companyId: "company-1", name, color,
      createdAt: new Date("2026-05-05T00:00:00.000Z"), updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    });
    const tagged = (index: number, status: IssueStatus, labels: ReturnType<typeof label>[]): Issue => ({
      ...createIssue(index, status), labels, labelIds: labels.map((entry) => entry.id),
    });

    it("puts each task once, in the lane of its first tag in lane order", () => {
      const lanes = groupKanbanLanes([
        tagged(1, "todo", [label("Tech"), label("Security")]),
        tagged(2, "done", [label("Zeta")]),
        tagged(3, "todo", [label("product")]),
        tagged(4, "backlog", []),
        tagged(5, "todo", [label("Alpha"), label("Zeta")]),
      ]);
      expect(lanes.map((lane) => lane.label?.name ?? lane.key)).toEqual(["Security", "product", "Alpha", "Zeta", KANBAN_UNTAGGED_LANE]);
      expect(lanes.map((lane) => lane.issues.map((issue) => issue.identifier))).toEqual([["PAP-1"], ["PAP-3"], ["PAP-5"], ["PAP-2"], ["PAP-4"]]);
    });

    it("maps a drop on a lane column to that column's status only", () => {
      const issues = [tagged(1, "todo", [label("Tech")])];
      expect(resolveKanbanTargetStatus("label-security::done", issues)).toBe("done");
      expect(resolveKanbanTargetStatus(`${KANBAN_UNTAGGED_LANE}::in_review`, issues)).toBe("in_review");
      expect(resolveKanbanTargetStatus("issue-todo-1", issues)).toBe("todo");
      expect(resolveKanbanTargetStatus("label-security::nope", issues)).toBeNull();
    });

    it("renders a lane per tag with its chip and count, and tag chips on cards", () => {
      const { container } = renderBoard({
        swimlanes: "label",
        issues: [tagged(1, "todo", [label("Security", "var(--label-security-test)"), label("Tech")]), tagged(2, "done", [])],
      });
      const lanes = [...container.querySelectorAll("section[aria-label]")].map((lane) => lane.getAttribute("aria-label"));
      expect(lanes).toEqual(["Security lane", "No tag lane"]);
      const card = container.querySelector('a[href="/issues/PAP-1"]')!;
      expect(card.textContent).toContain("Security");
      expect(card.textContent).toContain("Tech");
    });

    it("collapses a lane from its header", () => {
      const { container } = renderBoard({ swimlanes: "label", issues: [tagged(1, "todo", [label("Legal")])] });
      const header = container.querySelector<HTMLButtonElement>('section[aria-label="Legal lane"] button[aria-expanded]')!;
      act(() => header.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("Issue 1");
    });
  });
});
