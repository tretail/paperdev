import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "../api/client";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { latestPreviewStartOperation, replaceLocation, storedLogTail } from "../lib/preview-launcher";

const POLL_MS = 2_000;
// An older start operation's log belongs to an earlier preview, not to this one.
const START_LOG_WINDOW_MS = 10_000;

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Opened in a new tab from a board card: starts the task's preview if it isn't running, shows its
 * start log meanwhile, then replaces itself with the preview.
 */
export function ExecutionWorkspacePreview() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  const [searchParams] = useSearchParams();
  const issueId = searchParams.get("issue") ?? "";
  const serviceIndex = Number.parseInt(searchParams.get("service") ?? "", 10);
  const validRequest = Boolean(workspaceId && issueId) && Number.isInteger(serviceIndex) && serviceIndex >= 0;

  const [openedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [startError, setStartError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  // This tab's own start request: none yet, waiting for its answer, or answered.
  const [startState, setStartState] = useState<"none" | "pending" | "settled">("none");
  const startRequested = useRef(false);
  const polling = validRequest && !redirectUrl && !startError;

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [polling]);

  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId),
    queryFn: () => executionWorkspacesApi.get(workspaceId),
    enabled: validRequest,
  });
  const companyId = workspaceQuery.data?.companyId ?? null;

  const summaryQuery = useQuery({
    queryKey: [...queryKeys.issues.runtimeServicesAll(companyId ?? ""), "launcher", issueId] as const,
    queryFn: async () => {
      const summaries = await issuesApi.runtimeServices(companyId!, [issueId]);
      return summaries.find((summary) =>
        summary.executionWorkspaceId === workspaceId && summary.serviceIndex === serviceIndex) ?? null;
    },
    enabled: validRequest && Boolean(companyId),
    refetchInterval: polling ? POLL_MS : false,
  });
  const summary = summaryQuery.data;
  const refetchSummary = summaryQuery.refetch;

  const operationsQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.workspaceOperations(workspaceId),
    queryFn: () => executionWorkspacesApi.listWorkspaceOperations(workspaceId),
    enabled: validRequest,
    refetchInterval: polling ? POLL_MS : false,
  });
  const operation = latestPreviewStartOperation(operationsQuery.data, serviceIndex);
  const currentOperation = operation
    && (operation.status === "running" || new Date(operation.startedAt).getTime() >= openedAt - START_LOG_WINDOW_MS)
    ? operation
    : null;

  const logQuery = useQuery({
    queryKey: ["workspace-operation-log", currentOperation?.id ?? "none"],
    queryFn: () => heartbeatsApi.workspaceOperationLog(currentOperation!.id),
    enabled: Boolean(currentOperation?.logRef),
    refetchInterval: polling && currentOperation?.status === "running" ? POLL_MS : false,
  });
  const logTail = storedLogTail(logQuery.data?.content);

  useEffect(() => {
    if (!summary || redirectUrl) return;
    if (summary.status === "running" && summary.url) {
      setRedirectUrl(summary.url);
      replaceLocation(summary.url);
      return;
    }
    // Someone (an agent, another tab) is already starting it: wait for theirs.
    if (startRequested.current || summary.status === "starting") return;
    startRequested.current = true;
    setStartState("pending");
    void executionWorkspacesApi
      .controlRuntimeServices(workspaceId, "start", { serviceIndex })
      .then(() => refetchSummary())
      .catch((error: unknown) => {
        // 409: another start holds the workspace. Keep polling for it.
        if (error instanceof ApiError && error.status === 409) return;
        // A dropped connection says nothing about the start itself, which goes on server-side.
        if (!(error instanceof ApiError)) return;
        setStartError(error.message);
      })
      .finally(() => setStartState("settled"));
  }, [summary, redirectUrl, workspaceId, serviceIndex, refetchSummary]);

  const serviceName = summary?.serviceName ?? "Preview";
  const runtimeLogsPath = `/execution-workspaces/${workspaceId}/runtime-logs`;
  // A failed status before this tab's own start has answered is the previous attempt's.
  const failed = Boolean(startError)
    || (summary?.status === "failed" && startState !== "pending" && currentOperation?.status !== "running");

  let title: string;
  let description: string;
  if (!validRequest) {
    title = "Nothing to preview";
    description = "This link doesn't name a task's preview.";
  } else if (workspaceQuery.error || summaryQuery.error) {
    title = "Couldn't read the preview";
    const error = workspaceQuery.error ?? summaryQuery.error;
    description = error instanceof Error ? error.message : "The request failed.";
  } else if (summaryQuery.isSuccess && !summary) {
    title = "Nothing to preview";
    description = "This task's workspace has no preview service, or it's archived.";
  } else if (redirectUrl) {
    title = `Opening ${serviceName}`;
    description = redirectUrl;
  } else if (failed) {
    title = `${serviceName} didn't start`;
    description = startError ?? "The service failed. Its log is below.";
  } else {
    title = `Starting ${serviceName}`;
    description = `${formatElapsed(now - openedAt)} elapsed. This tab opens it as soon as it's ready; a first start can take a few minutes.`;
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription className="break-all">{description}</CardDescription>
        </CardHeader>
        {(logTail || failed) && validRequest ? (
          <CardContent className="space-y-3">
            {logTail ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
                {logTail}
              </pre>
            ) : null}
            {failed ? (
              <Link to={runtimeLogsPath} className="text-sm underline underline-offset-2">
                Open the workspace's runtime logs
              </Link>
            ) : null}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
