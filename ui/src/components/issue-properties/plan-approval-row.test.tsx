// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssuePlanApprovalState } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { PlanApprovalRow } from "./plan-approval-row";

function render(state: IssuePlanApprovalState) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(queryKeys.issues.planApproval("issue-1"), state);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlanApprovalRow issueId="issue-1" enabled />
    </QueryClientProvider>,
  );
}

describe("PlanApprovalRow", () => {
  it("renders nothing for ungated tasks", () => {
    expect(render({ required: false })).toBe("");
  });

  it("shows the approved plan revision", () => {
    const html = render({
      required: true,
      approved: true,
      planRevisionId: "rev-2",
      planRevisionNumber: 2,
      interactionId: "interaction-1",
      approvedByUserId: "board-user",
      approvedAt: null,
      implementerAgentId: null,
    });
    expect(html).toContain("Plan approval");
    expect(html).toContain("Approved rev 2");
  });

  it("asks for re-approval after the plan changed", () => {
    const html = render({
      required: true,
      approved: false,
      reason: "approval_stale",
      planRevisionId: "rev-3",
      planRevisionNumber: 3,
      implementerAgentId: null,
    });
    expect(html).toContain("Re-approve rev 3");
  });
});
