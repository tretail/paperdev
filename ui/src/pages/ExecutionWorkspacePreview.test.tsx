// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueRuntimeServiceSummary, WorkspaceOperation } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { ExecutionWorkspacePreview } from "./ExecutionWorkspacePreview";

const state = vi.hoisted(() => ({
  search: "issue=issue-1&service=1",
  summaries: [] as IssueRuntimeServiceSummary[],
  operations: [] as WorkspaceOperation[],
  logContent: "",
}));
const api = vi.hoisted(() => ({
  start: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useParams: () => ({ workspaceId: "workspace-1" }),
  useSearchParams: () => [new URLSearchParams(state.search)],
}));
vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    get: vi.fn(async () => ({ id: "workspace-1", companyId: "company-1" })),
    listWorkspaceOperations: vi.fn(async () => state.operations),
    controlRuntimeServices: api.start,
  },
}));
vi.mock("../api/issues", () => ({
  issuesApi: { runtimeServices: vi.fn(async () => state.summaries) },
}));
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { workspaceOperationLog: vi.fn(async () => ({ content: state.logContent })) },
}));
vi.mock("../lib/preview-launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/preview-launcher")>()),
  replaceLocation: api.replace,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function summary(status: IssueRuntimeServiceSummary["status"], url: string | null = null): IssueRuntimeServiceSummary {
  return { issueId: "issue-1", executionWorkspaceId: "workspace-1", serviceName: "Preview", serviceIndex: 1, status, url };
}

function startOperation(status: WorkspaceOperation["status"]): WorkspaceOperation {
  const now = new Date();
  return {
    id: "operation-1", companyId: "company-1", executionWorkspaceId: "workspace-1", heartbeatRunId: null, issueId: null,
    phase: "workspace_provision", command: "preview", cwd: "/tmp", status, exitCode: null, logStore: "local_file",
    logRef: "operation-1.ndjson", logBytes: null, logSha256: null, logCompressed: false, stdoutExcerpt: null,
    stderrExcerpt: null, metadata: { action: "start", serviceIndex: 1 }, startedAt: now, finishedAt: null,
    createdAt: now, updatedAt: now,
  };
}

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ExecutionWorkspacePreview />
      </QueryClientProvider>,
    );
  });
  return container;
}

describe("ExecutionWorkspacePreview", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    state.search = "issue=issue-1&service=1";
    state.summaries = [];
    state.operations = [];
    state.logContent = "";
    api.start.mockReset();
    api.replace.mockReset();
  });

  afterEach(() => {
    for (const root of roots.splice(0)) flushSync(() => root.unmount());
  });

  it("goes straight to a running preview without starting it", async () => {
    state.summaries = [summary("running", "https://mini.example.ts.net:5173")];
    const container = renderPage();
    await vi.waitFor(() => expect(api.replace).toHaveBeenCalledWith("https://mini.example.ts.net:5173"));
    expect(api.start).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Opening Preview");
  });

  it("starts a stopped preview once, shows its log, then goes to it", async () => {
    state.summaries = [summary("stopped")];
    state.operations = [startOperation("running")];
    state.logContent = `${JSON.stringify({ ts: new Date().toISOString(), stream: "stdout", chunk: "compiling the backend\n" })}\n`;
    let finishStart!: () => void;
    api.start.mockImplementation(() => new Promise<void>((resolve) => { finishStart = resolve; }));
    const container = renderPage();

    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start).toHaveBeenCalledWith("workspace-1", "start", { serviceIndex: 1 });
    await vi.waitFor(() => expect(container.textContent).toContain("compiling the backend"));
    expect(container.textContent).toContain("Starting Preview");

    state.summaries = [summary("running", "https://mini.example.ts.net:5173")];
    finishStart();
    await vi.waitFor(() => expect(api.replace).toHaveBeenCalledWith("https://mini.example.ts.net:5173"));
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("waits for a start that someone else holds (409)", async () => {
    state.summaries = [summary("stopped")];
    api.start.mockRejectedValue(new ApiError("Workspace runtime control is busy", 409, null));
    const container = renderPage();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    state.summaries = [summary("starting")];
    await vi.waitFor(() => expect(container.textContent).toContain("Starting Preview"));
    expect(container.textContent).not.toContain("didn't start");
  });

  it("doesn't start a preview that's already starting", async () => {
    state.summaries = [summary("starting")];
    const container = renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain("Starting Preview"));
    expect(api.start).not.toHaveBeenCalled();
  });

  it("shows the failure and a link to the runtime logs", async () => {
    state.summaries = [summary("stopped")];
    api.start.mockRejectedValue(new ApiError("Runtime service Preview exited before it was ready", 500, null));
    const container = renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain("Preview didn't start"));
    expect(container.textContent).toContain("exited before it was ready");
    expect(container.querySelector('a[href="/execution-workspaces/workspace-1/runtime-logs"]')).not.toBeNull();
    expect(api.replace).not.toHaveBeenCalled();
  });

  it("says so when the task has no preview", async () => {
    state.summaries = [];
    const container = renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain("Nothing to preview"));
    expect(api.start).not.toHaveBeenCalled();
  });
});
