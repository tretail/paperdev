import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, CircleAlert } from "lucide-react";
import { issuesApi, type IssuePlanApprovalState } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { formatDate } from "../../lib/utils";
import { PropertyRow } from "./primitives";

function describePlanApproval(state: Extract<IssuePlanApprovalState, { required: true }>) {
  if (state.approved) {
    return {
      icon: CircleCheck,
      label: `Approved rev ${state.planRevisionNumber}`,
      title: `Plan revision ${state.planRevisionNumber} approved${state.approvedAt ? ` on ${formatDate(state.approvedAt)}` : ""}. Implementation is allowed.`,
    };
  }
  switch (state.reason) {
    case "no_plan":
      return { icon: CircleDashed, label: "Needs a plan", title: "No plan yet. Runs are read-only until a plan is approved." };
    case "approval_stale":
      return {
        icon: CircleAlert,
        label: `Re-approve rev ${state.planRevisionNumber}`,
        title: "The plan changed after it was approved. Runs are read-only until you approve the current revision.",
      };
    default:
      return {
        icon: CircleDashed,
        label: `Awaiting approval (rev ${state.planRevisionNumber})`,
        title: "Runs are read-only until you approve the current plan revision.",
      };
  }
}

/** Shows the plan approval gate state for tasks in gated projects. */
export function PlanApprovalRow({ issueId, enabled }: { issueId: string; enabled: boolean }) {
  const { data } = useQuery({
    queryKey: queryKeys.issues.planApproval(issueId),
    queryFn: () => issuesApi.getPlanApproval(issueId),
    enabled,
  });
  if (!data?.required) return null;
  const { icon: Icon, label, title } = describePlanApproval(data);
  return (
    <PropertyRow label="Plan approval">
      <span
        className={data.approved ? "inline-flex items-center gap-1.5 text-sm" : "inline-flex items-center gap-1.5 text-sm text-muted-foreground"}
        title={title}
        data-testid="plan-approval-state"
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    </PropertyRow>
  );
}
