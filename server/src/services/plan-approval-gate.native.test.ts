import { describe, expect, it } from "vitest";
import { decidePlanGateRun } from "./plan-approval-gate.js";

const unapproved = { required: true, approved: false, reason: "no_plan", planRevisionId: null, planRevisionNumber: null, implementerAgentId: null } as const;
const nativePlan = {
  executionMode: "plan", task: { workMode: "planning" }, provider: { kind: "codex" },
  planningContext: { documentId: null, baseRevisionId: null, baseRevisionNumber: 0, markdown: "", sha256: "a".repeat(64), reviewContext: {} },
};

describe("project gate native planning confinement", () => {
  it("admits a prepared native Codex plan without authorizing implementation", () => {
    expect(decidePlanGateRun(unapproved, { adapterType: "paperclip_runner" }, {
      workMode: "planning", nativeExecution: nativePlan,
    })).toEqual({ kind: "plan" });
  });
  it.each([
    { workMode: "standard", nativeExecution: nativePlan },
    { workMode: "planning", nativeExecution: { ...nativePlan, executionMode: "default" } },
    { workMode: "planning", nativeExecution: { ...nativePlan, task: { workMode: "standard" } } },
    { workMode: "planning", nativeExecution: { ...nativePlan, planningContext: null } },
    { workMode: "planning", nativeExecution: { ...nativePlan, provider: { kind: "unknown" } } },
    { workMode: "planning", nativeExecution: null },
  ])("refuses unconfined native execution %#", planning => {
    expect(decidePlanGateRun(unapproved, { adapterType: "paperclip_runner" }, planning)).toMatchObject({ kind: "blocked" });
  });
  it("does not lend native capabilities to a legacy Codex adapter", () => {
    expect(decidePlanGateRun(unapproved, { adapterType: "codex_local" }, {
      workMode: "planning", nativeExecution: nativePlan,
    })).toMatchObject({ kind: "blocked" });
  });
  it("keeps stale approvals in plan mode", () => {
    expect(decidePlanGateRun({ ...unapproved, reason: "approval_stale", planRevisionNumber: 2 },
      { adapterType: "paperclip_runner" }, { workMode: "planning", nativeExecution: nativePlan })).toEqual({ kind: "plan" });
  });
});
