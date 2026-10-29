import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import type { ProjectPlanApprovalPolicy } from "@paperclipai/shared";

/**
 * Plan approval gate.
 *
 * A project may opt in with `planApprovalPolicy.enabled`. For its tasks, an
 * implementation run is allowed only when a human accepted a
 * `request_confirmation` that targets the *current* revision of the task's
 * `plan` document. Work mode, assignment, comments, and agent claims are not
 * evidence of approval; any new plan revision invalidates earlier approvals.
 */

export const PLAN_APPROVAL_REQUIRED_ERROR_CODE = "plan_approval_required";

/** Adapters that can run a task read-only when its plan is not approved. */
const READ_ONLY_PLANNING_ADAPTER_TYPES = new Set(["claude_local"]);

export type PlanApprovalEvaluation =
  | { required: false }
  | {
    required: true;
    approved: true;
    planRevisionId: string;
    planRevisionNumber: number;
    interactionId: string;
    approvedByUserId: string;
    approvedAt: Date | null;
    implementerAgentId: string | null;
  }
  | {
    required: true;
    approved: false;
    reason: "no_plan" | "not_approved" | "approval_stale";
    planRevisionId: string | null;
    planRevisionNumber: number | null;
    implementerAgentId: string | null;
  };

/** What a run on a task may do under the gate. */
export type PlanGateRunDecision =
  | { kind: "ungated" }
  | { kind: "implement"; approvedRevisionId: string; approvedRevisionNumber: number }
  | { kind: "plan" }
  | { kind: "blocked"; reason: string };

/** Shape stamped into the adapter context as `paperclipPlanGate`. */
export interface PaperclipPlanGateContext {
  issueId: string;
  mode: "plan" | "implement";
  approvedRevisionId?: string;
  approvedRevisionNumber?: number;
}

export function readProjectPlanApprovalPolicy(value: unknown): ProjectPlanApprovalPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.enabled !== true) return null;
  const implementerAgentId = typeof record.implementerAgentId === "string" && record.implementerAgentId.length > 0
    ? record.implementerAgentId
    : null;
  return { enabled: true, implementerAgentId };
}

type DbReader = Pick<Db, "select">;

/** Implementer configured on the task's gated project, or null. */
export async function readPlanApprovalImplementer(
  db: DbReader,
  input: { companyId: string; issueId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ policy: projects.planApprovalPolicy })
    .from(issues)
    .innerJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  return readProjectPlanApprovalPolicy(row?.policy)?.implementerAgentId ?? null;
}

export async function evaluatePlanApproval(
  db: DbReader,
  input: { companyId: string; issueId: string },
): Promise<PlanApprovalEvaluation> {
  const [issue] = await db
    .select({ policy: projects.planApprovalPolicy })
    .from(issues)
    .innerJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  const policy = readProjectPlanApprovalPolicy(issue?.policy);
  if (!policy) return { required: false };
  const implementerAgentId = policy.implementerAgentId ?? null;

  const [plan] = await db
    .select({ revisionId: documents.latestRevisionId, revisionNumber: documents.latestRevisionNumber })
    .from(issueDocuments)
    .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, issueDocuments.companyId)))
    .where(and(
      eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId),
      eq(issueDocuments.key, "plan"),
    ))
    .limit(1);
  if (!plan?.revisionId) {
    return { required: true, approved: false, reason: "no_plan", planRevisionId: null, planRevisionNumber: null, implementerAgentId };
  }

  const humanAcceptedPlanConfirmations = and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.kind, "request_confirmation"),
    eq(issueThreadInteractions.status, "accepted"),
    isNotNull(issueThreadInteractions.resolvedByUserId),
    isNull(issueThreadInteractions.resolvedByAgentId),
    sql`${issueThreadInteractions.payload}->'target'->>'type' = 'issue_document'`,
    sql`${issueThreadInteractions.payload}->'target'->>'key' = 'plan'`,
  );
  const [approval] = await db
    .select({
      id: issueThreadInteractions.id,
      resolvedByUserId: issueThreadInteractions.resolvedByUserId,
      resolvedAt: issueThreadInteractions.resolvedAt,
    })
    .from(issueThreadInteractions)
    .where(and(
      humanAcceptedPlanConfirmations,
      sql`${issueThreadInteractions.payload}->'target'->>'revisionId' = ${plan.revisionId}`,
    ))
    .orderBy(desc(issueThreadInteractions.resolvedAt))
    .limit(1);
  if (approval?.resolvedByUserId) {
    return {
      required: true,
      approved: true,
      planRevisionId: plan.revisionId,
      planRevisionNumber: plan.revisionNumber,
      interactionId: approval.id,
      approvedByUserId: approval.resolvedByUserId,
      approvedAt: approval.resolvedAt,
      implementerAgentId,
    };
  }

  const [olderApproval] = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(humanAcceptedPlanConfirmations)
    .limit(1);
  return {
    required: true,
    approved: false,
    reason: olderApproval ? "approval_stale" : "not_approved",
    planRevisionId: plan.revisionId,
    planRevisionNumber: plan.revisionNumber,
    implementerAgentId,
  };
}

/**
 * Decide what a run may do. Unapproved runs are allowed only on adapters that
 * enforce a read-only planning profile; every other adapter is blocked.
 */
export function decidePlanGateRun(
  evaluation: PlanApprovalEvaluation,
  agent: { adapterType: string | null },
): PlanGateRunDecision {
  if (!evaluation.required) return { kind: "ungated" };
  if (evaluation.approved) {
    return {
      kind: "implement",
      approvedRevisionId: evaluation.planRevisionId,
      approvedRevisionNumber: evaluation.planRevisionNumber,
    };
  }
  if (READ_ONLY_PLANNING_ADAPTER_TYPES.has(agent.adapterType ?? "")) return { kind: "plan" };
  return {
    kind: "blocked",
    reason:
      `This task requires an approved plan before implementation (${describePlanApprovalGap(evaluation)}), ` +
      `and the ${agent.adapterType ?? "unknown"} adapter cannot run it read-only. ` +
      "Approve the current plan revision, or assign planning to a claude_local agent.",
  };
}

export function describePlanApprovalGap(evaluation: PlanApprovalEvaluation): string {
  if (!evaluation.required || evaluation.approved) return "approved";
  switch (evaluation.reason) {
    case "no_plan":
      return "no plan document exists yet";
    case "approval_stale":
      return `the plan changed after approval; revision ${evaluation.planRevisionNumber} is not approved`;
    default:
      return `plan revision ${evaluation.planRevisionNumber} is awaiting human approval`;
  }
}

export function planGateContextFor(issueId: string, decision: PlanGateRunDecision): PaperclipPlanGateContext | null {
  if (decision.kind === "plan") return { issueId, mode: "plan" };
  if (decision.kind === "implement") {
    return {
      issueId,
      mode: "implement",
      approvedRevisionId: decision.approvedRevisionId,
      approvedRevisionNumber: decision.approvedRevisionNumber,
    };
  }
  return null;
}

/**
 * Whether an agent may check out a gated task whose plan is not approved.
 * Only a run bound to that task on a read-only-capable adapter qualifies:
 * dispatch confined exactly those runs to the read-only planning profile.
 * Timer or other-task runs carry full permissions and must not pick it up.
 */
export async function planGateAllowsAgentCheckout(
  db: DbReader,
  input: { companyId: string; issueId: string; agentId: string; checkoutRunId: string | null },
): Promise<{ allowed: true } | { allowed: false; evaluation: PlanApprovalEvaluation }> {
  const evaluation = await evaluatePlanApproval(db, input);
  if (!evaluation.required || evaluation.approved) return { allowed: true };
  if (!input.checkoutRunId) return { allowed: false, evaluation };
  const [run] = await db
    .select({ issueId: heartbeatRuns.issueId, contextSnapshot: heartbeatRuns.contextSnapshot, adapterType: agents.adapterType })
    .from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .where(and(
      eq(heartbeatRuns.id, input.checkoutRunId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .limit(1);
  const runIssueId = typeof run?.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : run?.issueId;
  const confined = Boolean(run) && runIssueId === input.issueId &&
    READ_ONLY_PLANNING_ADAPTER_TYPES.has(run!.adapterType ?? "");
  return confined ? { allowed: true } : { allowed: false, evaluation };
}
