import { AgentIdentity } from "@/components/AgentIdentity";
import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useQuery } from "@tanstack/react-query";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { PullRequestStateIcon } from "./PullRequestStateIcon";
import { IssueLabelChip, IssueLabelChips } from "./IssueLabelChip";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Identity } from "./Identity";
import type { Issue, IssueLabel, IssuePullRequestSummary, IssueRuntimeServiceSummary, IssueStatus } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { AlertTriangle, ChevronDown, ChevronRight, MonitorPlay } from "lucide-react";
import { isSuccessfulRunHandoffRequired } from "../lib/successful-run-handoff";
import { collectSubtreeLiveCounts } from "../lib/liveIssueIds";
import { cn } from "../lib/utils";
import { previewLauncherPath } from "../lib/preview-launcher";
import { IN_REVIEW_STATUS_LABEL } from "../lib/issue-status-label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HorizontalScrollViewport } from "./HorizontalScrollViewport";

export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type KanbanColumnPageSize = (typeof KANBAN_COLUMN_PAGE_SIZE_OPTIONS)[number];
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE: KanbanColumnPageSize = 10;
export const KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLUMN_REVEAL_INCREMENT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;

export const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];

const defaultKanbanColumnTone = {
  rail: "border-border bg-muted/20",
  railOver: "bg-accent/50 ring-1 ring-primary/20",
  header: "text-muted-foreground",
  count: "text-muted-foreground/60",
  body: "bg-muted/20",
  bodyOver: "bg-accent/40",
  card: "",
};

// Every column carries a status-hued tint (matching the app-wide status
// vocabulary: gray backlog, amber todo, blue in-progress, violet review,
// red blocked, green done) so no column reads as accidentally unstyled.
export const kanbanColumnTones: Partial<Record<IssueStatus, typeof defaultKanbanColumnTone>> = {
  backlog: {
    rail: "border-border bg-muted/30",
    railOver: "bg-muted/50 ring-1 ring-neutral-400/25",
    header: "text-muted-foreground",
    count: "text-muted-foreground/60",
    body: "bg-muted/30 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/50 ring-1 ring-inset ring-neutral-400/25",
    card: "",
  },
  todo: {
    rail: "border-amber-500/25 bg-amber-50/60 dark:bg-amber-950/20",
    railOver: "bg-amber-100/70 ring-1 ring-amber-500/25 dark:bg-amber-950/35",
    header: "text-amber-700 dark:text-amber-300",
    count: "text-amber-700/65 dark:text-amber-300/65",
    body: "bg-amber-50/45 ring-1 ring-inset ring-amber-500/15 dark:bg-amber-950/15",
    bodyOver: "bg-amber-100/70 ring-1 ring-inset ring-amber-500/25 dark:bg-amber-950/30",
    card: "",
  },
  in_progress: {
    rail: "border-blue-500/25 bg-blue-50/60 dark:bg-blue-950/20",
    railOver: "bg-blue-100/70 ring-1 ring-blue-500/25 dark:bg-blue-950/35",
    header: "text-blue-700 dark:text-blue-300",
    count: "text-blue-700/65 dark:text-blue-300/65",
    body: "bg-blue-50/45 ring-1 ring-inset ring-blue-500/15 dark:bg-blue-950/15",
    bodyOver: "bg-blue-100/70 ring-1 ring-inset ring-blue-500/25 dark:bg-blue-950/30",
    card: "",
  },
  blocked: {
    rail: "border-red-500/25 bg-red-50/60 dark:bg-red-950/20",
    railOver: "bg-red-100/70 ring-1 ring-red-500/25 dark:bg-red-950/35",
    header: "text-red-700 dark:text-red-300",
    count: "text-red-700/65 dark:text-red-300/65",
    body: "bg-red-50/45 ring-1 ring-inset ring-red-500/15 dark:bg-red-950/15",
    bodyOver: "bg-red-100/70 ring-1 ring-inset ring-red-500/25 dark:bg-red-950/30",
    card: "",
  },
  in_review: {
    rail: "border-violet-500/25 bg-violet-50/60 dark:bg-violet-950/20",
    railOver: "bg-violet-100/70 ring-1 ring-violet-500/25 dark:bg-violet-950/35",
    header: "text-violet-700 dark:text-violet-300",
    count: "text-violet-700/65 dark:text-violet-300/65",
    body: "bg-violet-50/45 ring-1 ring-inset ring-violet-500/15 dark:bg-violet-950/15",
    bodyOver: "bg-violet-100/70 ring-1 ring-inset ring-violet-500/25 dark:bg-violet-950/30",
    card: "",
  },
  done: {
    rail: "border-green-500/25 bg-green-50/60 dark:bg-green-950/20",
    railOver: "bg-green-100/70 ring-1 ring-green-500/25 dark:bg-green-950/35",
    header: "text-green-700 dark:text-green-300",
    count: "text-green-700/65 dark:text-green-300/65",
    body: "bg-green-50/45 ring-1 ring-inset ring-green-500/15 dark:bg-green-950/15",
    bodyOver: "bg-green-100/70 ring-1 ring-inset ring-green-500/25 dark:bg-green-950/30",
    card: "",
  },
  cancelled: {
    rail: "border-neutral-300/70 bg-muted/25 opacity-80 dark:border-neutral-700/70 dark:bg-neutral-900/20",
    railOver: "bg-muted/45 opacity-90 ring-1 ring-neutral-400/25 dark:bg-neutral-900/35",
    header: "text-muted-foreground/80",
    count: "text-muted-foreground/50",
    body: "bg-muted/25 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/45 ring-1 ring-inset ring-neutral-400/25",
    card: "bg-muted/35 text-muted-foreground opacity-80 hover:shadow-none",
  },
};

export function getKanbanColumnTone(status: IssueStatus) {
  return kanbanColumnTones[status] ?? defaultKanbanColumnTone;
}

function statusLabel(status: string): string {
  if (status === "in_review") return IN_REVIEW_STATUS_LABEL;
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function resolveKanbanTargetStatus(overId: string, issues: Issue[]): IssueStatus | null {
  // Swimlane columns are droppable as "<lane>::<status>"; a drop only ever changes status.
  const separator = overId.lastIndexOf(KANBAN_LANE_SEPARATOR);
  const columnId = separator === -1 ? overId : overId.slice(separator + KANBAN_LANE_SEPARATOR.length);
  if ((boardStatuses as readonly string[]).includes(columnId)) {
    return columnId as IssueStatus;
  }
  return issues.find((issue) => issue.id === overId)?.status ?? null;
}

/* ── Tag swimlanes ── */

/** Tag lanes come in this order, then any other labels A–Z, then the untagged lane. */
export const KANBAN_LANE_LABEL_ORDER = ["security", "legal", "product", "tech", "infra"] as const;
export const KANBAN_UNTAGGED_LANE = "__untagged__";
const KANBAN_LANE_SEPARATOR = "::";

type LaneLabel = Pick<IssueLabel, "id" | "name" | "color">;

export interface KanbanLane {
  key: string;
  label: LaneLabel | null;
  issues: Issue[];
}

function laneRank(label: LaneLabel): number {
  const index = (KANBAN_LANE_LABEL_ORDER as readonly string[]).indexOf(label.name.trim().toLowerCase());
  return index === -1 ? KANBAN_LANE_LABEL_ORDER.length : index;
}

function compareLaneLabels(a: LaneLabel, b: LaneLabel): number {
  return laneRank(a) - laneRank(b) || a.name.localeCompare(b.name);
}

/** One lane per tag; each issue appears once, in the lane of its first label in lane order. */
export function groupKanbanLanes(issues: Issue[]): KanbanLane[] {
  const lanes = new Map<string, KanbanLane>();
  for (const issue of issues) {
    const label = [...(issue.labels ?? [])].sort(compareLaneLabels)[0] ?? null;
    const key = label ? label.id : KANBAN_UNTAGGED_LANE;
    const lane = lanes.get(key) ?? { key, label, issues: [] };
    lane.issues.push(issue);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort((a, b) => {
    if (a.label && b.label) return compareLaneLabels(a.label, b.label);
    return a.label ? -1 : b.label ? 1 : 0;
  });
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
  /** Proposed clipping indicators, with a single horizontal scroll owner. */
  showOverflowFades?: boolean;
  /** "label" splits the board into one row of columns per tag. */
  swimlanes?: "none" | "label";
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  droppableId,
  issues,
  agents,
  liveIssueIds,
  subtreeLiveCounts,
  pullRequests,
  runtimeServices,
  compactCards = false,
  collapsed = false,
  visibleCount,
  revealIncrement,
  onShowMore,
}: {
  status: IssueStatus;
  /** Defaults to the status; swimlane columns use "<lane>::<status>". */
  droppableId?: string;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  subtreeLiveCounts?: ReadonlyMap<string, number>;
  pullRequests?: ReadonlyMap<string, IssuePullRequestSummary>;
  runtimeServices?: ReadonlyMap<string, IssueRuntimeServiceSummary>;
  compactCards?: boolean;
  collapsed?: boolean;
  visibleCount: number;
  revealIncrement: number;
  onShowMore: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId ?? status });

  const isEmpty = issues.length === 0;
  const visibleIssues = collapsed ? [] : issues.slice(0, visibleCount);
  const hiddenCount = Math.max(issues.length - visibleIssues.length, 0);
  const nextRevealCount = Math.min(revealIncrement, hiddenCount);
  const tone = getKanbanColumnTone(status);

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-(--sz-220px) w-(--sz-52px) shrink-0 flex-col items-center rounded-md border px-1.5 py-2 transition-colors",
          tone.rail,
          isOver && tone.railOver,
        )}
        title={`${statusLabel(status)}: ${issues.length}`}
      >
        <StatusIcon status={status} />
        <span className={cn("mt-2 [writing-mode:vertical-rl] rotate-180 text-(length:--text-nano) font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <Badge variant="ghost" className={cn("mt-auto bg-background px-1.5 text-(length:--text-nano) tabular-nums", tone.header)}>
          {issues.length}
        </Badge>
      </div>
    );
  }

  return (
    <div className="flex flex-col shrink-0 min-w-(--sz-260px) w-(--sz-260px)">
      <div className="flex items-center gap-2 px-3 py-2 mb-1">
        <StatusIcon status={status} />
        <span className={cn("text-xs font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <span className={cn("ml-auto text-xs tabular-nums", tone.count)}>
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex-1 min-h-(--sz-120px) rounded-md p-2 space-y-1 transition-colors",
          isOver ? tone.bodyOver : tone.body,
        )}
      >
        {/* Hidden cards are intentionally excluded from sort targets until revealed. */}
        <SortableContext
          items={visibleIssues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {visibleIssues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              isLive={liveIssueIds?.has(issue.id)}
              subtreeLiveCount={subtreeLiveCounts?.get(issue.id) ?? 0}
              pullRequest={pullRequests?.get(issue.id)}
              runtimeService={runtimeServices?.get(issue.id)}
              compact={compactCards}
              className={tone.card}
            />
          ))}
        </SortableContext>
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="mt-1 flex w-full items-center justify-center rounded-md border border-dashed border-border bg-background/70 px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            onClick={onShowMore}
          >
            Show {nextRevealCount} more
          </button>
        ) : null}
        {issues.length > 0 && (hiddenCount > 0 || issues.length >= visibleCount) ? (
          <p className="px-1 pt-1 text-(length:--text-micro) text-muted-foreground">
            Showing {visibleIssues.length} of {issues.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Card link buttons ── */

const CARD_LINK_BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-muted-foreground no-underline transition-colors hover:border-foreground/30 hover:text-foreground";

// The card is draggable and opens the task; pressing one of its link buttons does neither.
const stopCardInteraction = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** Opens the task's pull request on GitHub, showing GitHub's icon for its state and its number. */
function PullRequestCardLink({ pullRequest }: { pullRequest: IssuePullRequestSummary }) {
  const state = pullRequest.state === "unknown" ? "state unknown" : pullRequest.state;
  const label = `Open pull request${pullRequest.number ? ` #${pullRequest.number}` : ""} (${state}) on GitHub`;
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      onPointerDown={stopCardInteraction}
      onClick={stopCardInteraction}
      className={cn(CARD_LINK_BUTTON_CLASS, "font-mono")}
    >
      <PullRequestStateIcon state={pullRequest.state} />
      {pullRequest.number ? `#${pullRequest.number}` : null}
    </a>
  );
}

/**
 * Opens the task's preview in a new tab. A running preview opens directly; otherwise the tab opens
 * the launcher page, which starts it and then moves on to it.
 */
function RuntimeServiceCardLink({ service }: { service: IssueRuntimeServiceSummary }) {
  const icon = <MonitorPlay className="size-3.5 shrink-0" aria-hidden="true" />;
  if (service.status === "running" && service.url) {
    const label = `Open ${service.serviceName} in a new tab`;
    return (
      <a
        href={service.url}
        target="_blank"
        rel="noopener noreferrer"
        title={label}
        aria-label={label}
        onPointerDown={stopCardInteraction}
        onClick={stopCardInteraction}
        className={cn(CARD_LINK_BUTTON_CLASS, "border-foreground/30 text-foreground")}
      >
        {icon}
      </a>
    );
  }
  const label = service.status === "starting"
    ? `${service.serviceName} is starting: open it in a new tab when it's ready`
    : service.status === "failed"
      ? `${service.serviceName} failed: start it again in a new tab`
      : `Start ${service.serviceName} (opens in a new tab)`;
  return (
    <Link
      to={previewLauncherPath(service)}
      target="_blank"
      rel="noopener"
      title={label}
      aria-label={label}
      onPointerDown={stopCardInteraction}
      onClick={stopCardInteraction}
      className={CARD_LINK_BUTTON_CLASS}
    >
      {icon}
    </Link>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  subtreeLiveCount = 0,
  pullRequest,
  runtimeService,
  isOverlay,
  compact = false,
  className,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  subtreeLiveCount?: number;
  pullRequest?: IssuePullRequestSummary;
  runtimeService?: IssueRuntimeServiceSummary;
  isOverlay?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // A done or cancelled task's preview is stopped by the terminal sweep: nothing to open.
  const previewService = issue.status === "done" || issue.status === "cancelled" ? undefined : runtimeService;

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "relative block cursor-grab active:cursor-grabbing transition-shadow",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
        compact ? "p-2" : "p-2.5",
        className,
      )}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className={`flex items-start gap-1.5 ${compact ? "mb-1" : "mb-1.5"}`}>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isSuccessfulRunHandoffRequired(issue) ? (
            <Badge variant="outline"
              className="border-amber-400/45 bg-amber-50/60 px-1.5 text-(length:--text-nano) text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
              title="This task needs a next step"
              aria-label="Needs next step"
            >
              <AlertTriangle className="h-3 w-3" />
              Next step
            </Badge>
          ) : null}
          {isLive && (
            <span className="inline-flex shrink-0 items-center gap-1 text-(length:--text-nano) font-medium text-blue-600 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              {compact ? "Live" : null}
            </span>
          )}
          {!isLive && subtreeLiveCount > 0 && (
            <Badge variant="outline"
              className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
              title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden="true" />
              {subtreeLiveCount} live below
            </Badge>
          )}
        </div>
        <p className={`${compact ? "mb-1.5 text-xs" : "mb-2 text-sm"} leading-snug line-clamp-2`}>{issue.title}</p>
        <IssueLabelChips labels={issue.labels ?? []} max={3} className={compact ? "mb-1.5" : "mb-2"} />
        {/* Room for the link buttons, which sit outside the task link. */}
        <div className={cn(
          "flex items-center gap-2 min-w-0",
          pullRequest && previewService ? "pr-24" : pullRequest ? "pr-16" : previewService ? "pr-8" : null,
        )}>
          {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority={issue.priority} />}
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <AgentIdentity agent={agents?.find((agent) => agent.id === issue.assigneeAgentId) ?? { id: issue.assigneeAgentId, name }} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
        </div>
      </Link>
      {pullRequest || previewService ? (
        <div className={cn("absolute flex items-stretch gap-1", compact ? "bottom-2 right-2" : "bottom-2.5 right-2.5")}>
          {previewService ? <RuntimeServiceCardLink service={previewService} /> : null}
          {pullRequest ? <PullRequestCardLink pullRequest={pullRequest} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function groupIssuesByStatus(issues: Issue[]): Record<IssueStatus, Issue[]> {
  const grouped = Object.fromEntries(boardStatuses.map((status) => [status, [] as Issue[]])) as Record<IssueStatus, Issue[]>;
  for (const issue of issues) grouped[issue.status]?.push(issue);
  return grouped;
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  compactCards = false,
  collapsedStatuses = [],
  initialVisibleCount = KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT,
  revealIncrement = KANBAN_COLUMN_REVEAL_INCREMENT,
  showOverflowFades = false,
  swimlanes = "none",
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(() => new Set());
  const paginationKey = `${initialVisibleCount}:${revealIncrement}`;
  const [visibleState, setVisibleState] = useState<{
    paginationKey: string;
    counts: Record<string, number>;
  }>({ paginationKey, counts: {} });
  const visibleCountByStatus = visibleState.paginationKey === paginationKey ? visibleState.counts : {};
  const collapsedStatusSet = useMemo(() => new Set(collapsedStatuses), [collapsedStatuses]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const lanes = useMemo(() => (swimlanes === "label" ? groupKanbanLanes(issues) : null), [issues, swimlanes]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(issues, liveIssueIds ?? new Set<string>()),
    [issues, liveIssueIds],
  );

  // A board shows one company's tasks.
  const companyId = issues[0]?.companyId ?? null;
  const sortedIssueIds = useMemo(() => [...new Set(issues.map((issue) => issue.id))].sort(), [issues]);
  const { data: pullRequestSummaries } = useQuery({
    queryKey: queryKeys.issues.pullRequests(companyId ?? "", sortedIssueIds),
    queryFn: ({ signal }) => issuesApi.pullRequests(companyId!, sortedIssueIds, { signal }),
    enabled: Boolean(companyId) && sortedIssueIds.length > 0,
    staleTime: 60_000,
  });
  const pullRequests = useMemo(
    () => new Map((pullRequestSummaries ?? []).map((summary) => [summary.issueId, summary])),
    [pullRequestSummaries],
  );
  // Each task's preview, running or not. Workspace activity refreshes this at once; services that
  // agents start, or that stop when idle, send no event, so it also refreshes every minute.
  const { data: runtimeServiceSummaries } = useQuery({
    queryKey: queryKeys.issues.runtimeServices(companyId ?? "", sortedIssueIds),
    queryFn: ({ signal }) => issuesApi.runtimeServices(companyId!, sortedIssueIds, { signal }),
    enabled: Boolean(companyId) && sortedIssueIds.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const runtimeServices = useMemo(
    () => new Map((runtimeServiceSummaries ?? []).map((summary) => [summary.issueId, summary])),
    [runtimeServiceSummaries],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    const targetStatus = resolveKanbanTargetStatus(over.id as string, issues);

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  /** One column per status for `laneIssues`; inside a swimlane, ids and page counts are per lane. */
  function renderColumns(laneIssues: Issue[], laneKey: string | null) {
    const byStatus = groupIssuesByStatus(laneIssues);
    return boardStatuses.map((status) => {
      const columnKey = laneKey ? `${laneKey}${KANBAN_LANE_SEPARATOR}${status}` : status;
      return (
        <KanbanColumn
          key={columnKey}
          status={status}
          droppableId={columnKey}
          issues={byStatus[status]}
          agents={agents}
          liveIssueIds={liveIssueIds}
          subtreeLiveCounts={subtreeLiveCounts}
          pullRequests={pullRequests}
          runtimeServices={runtimeServices}
          compactCards={compactCards}
          // Compact mode also collapses empty lanes to labeled rails.
          collapsed={collapsedStatusSet.has(status) || (collapsedStatusSet.size > 0 && byStatus[status].length === 0)}
          visibleCount={visibleCountByStatus[columnKey] ?? initialVisibleCount}
          revealIncrement={revealIncrement}
          onShowMore={() => {
            setVisibleState((current) => {
              const counts = current.paginationKey === paginationKey ? current.counts : {};
              return { paginationKey, counts: { ...counts, [columnKey]: (counts[columnKey] ?? initialVisibleCount) + revealIncrement } };
            });
          }}
        />
      );
    });
  }

  function toggleLane(key: string) {
    setCollapsedLanes((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  const content = lanes
    ? lanes.map((lane) => {
        const collapsed = collapsedLanes.has(lane.key);
        const name = lane.label?.name ?? "No tag";
        return (
          <section key={lane.key} aria-label={`${name} lane`} className="flex flex-col gap-1">
            <button
              type="button"
              className="flex w-fit items-center gap-2 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={!collapsed}
              onClick={() => toggleLane(lane.key)}
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {lane.label ? <IssueLabelChip label={lane.label} /> : <span>{name}</span>}
              <span className="tabular-nums">{lane.issues.length}</span>
            </button>
            {collapsed ? null : <div className="flex gap-3">{renderColumns(lane.issues, lane.key)}</div>}
          </section>
        );
      })
    : renderColumns(issues, null);
  const contentLayout = lanes ? "flex flex-col gap-4" : "flex gap-3";

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {showOverflowFades
        ? <HorizontalScrollViewport label="Task board columns" contentClassName={cn(contentLayout, "pb-4 px-2")}>{content}</HorizontalScrollViewport>
        : <div className={cn(contentLayout, "overflow-x-auto pb-4 -mx-2 px-2")}>{content}</div>}
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            pullRequest={pullRequests.get(activeIssue.id)}
            runtimeService={runtimeServices.get(activeIssue.id)}
            isOverlay
            compact={compactCards}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
