import type { IssueRuntimeServiceSummary, WorkspaceOperation } from "@paperclipai/shared";

/**
 * The launcher page for a task's preview: it starts the preview if it isn't running, then moves
 * on to it. Board cards open it in a new tab.
 */
export function previewLauncherPath(
  service: Pick<IssueRuntimeServiceSummary, "issueId" | "executionWorkspaceId" | "serviceIndex">,
) {
  const params = new URLSearchParams({ issue: service.issueId, service: String(service.serviceIndex) });
  return `/execution-workspaces/${service.executionWorkspaceId}/preview?${params}`;
}

/** The newest operation that started (or restarted) this service, which carries its start log. */
export function latestPreviewStartOperation(
  operations: readonly WorkspaceOperation[] | undefined,
  serviceIndex: number,
): WorkspaceOperation | null {
  let latest: WorkspaceOperation | null = null;
  for (const operation of operations ?? []) {
    const action = operation.metadata?.action;
    if (action !== "start" && action !== "restart") continue;
    const index = operation.metadata?.serviceIndex;
    if (index !== null && index !== undefined && index !== serviceIndex) continue;
    if (!latest || new Date(operation.startedAt).getTime() > new Date(latest.startedAt).getTime()) latest = operation;
  }
  return latest;
}

/** The last lines of a stored workspace operation log (one JSON chunk per line). */
export function storedLogTail(content: string | undefined, maxLines = 40): string {
  if (!content) return "";
  let text = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { chunk?: unknown };
      if (typeof raw.chunk === "string") text += raw.chunk;
    } catch {
      // Ignore malformed log lines.
    }
  }
  return text.split("\n").filter((line) => line.trim().length > 0).slice(-maxLines).join("\n");
}

/** Leaves the launcher for the preview, without keeping the launcher in the tab's history. */
export function replaceLocation(url: string) {
  window.location.replace(url);
}
