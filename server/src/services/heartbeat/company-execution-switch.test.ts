import { describe, expect, it, vi } from "vitest";
import { resolveCompanyExecutionSwitch } from "./company-execution-switch.js";

const claude = { mode: "responsible_user", provider: "anthropic", method: "subscription" };
const codex = { mode: "shared", provider: "openai", method: "api_key", connectionId: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002" };
function fixture(mode = "codex", previous = "claude") {
  const reads = [{ mode }, { context: { companyExecutionSwitch: { mode: previous } } }];
  const where = vi.fn(async () => undefined);
  const db = { select: () => ({ from: () => ({ where: async () => [reads.shift()] }) }), update: () => ({ set: () => ({ where }) }) };
  const agent = { id: "agent", companyId: "company", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "claude", modelReasoningEffort: "high", cwd: "/workspace" }, runtimeConfig: { aiConnection: claude, companyExecutionSwitch: { enabled: true, codexModel: "codex-test", codexConnection: codex } } };
  const run = { id: "run", contextSnapshot: {} };
  const context: Record<string, unknown> = { resumeSessionParams: { sessionId: "claude-session" } };
  return { db, agent, run, context, where };
}
async function resolve(f: ReturnType<typeof fixture>, previous = true) {
  return resolveCompanyExecutionSwitch(f.db as never, f.agent as never, f.run as never, previous ? { lastRunId: "previous" } as never : null, f.context);
}
describe("company execution switch", () => {
  it("retains workspace, replaces provider and resets cross-provider sessions", async () => {
    const f = fixture();
    const result = await resolve(f);
    expect(result?.config).toMatchObject({ provider: "codex", model: "codex-test", cwd: "/workspace" });
    expect(result?.config).not.toHaveProperty("acpxAgent");
    expect(result?.config).not.toHaveProperty("modelReasoningEffort");
    expect(result?.binding).toEqual(codex);
    expect(f.context.forceFreshSession).toBe(true);
    expect(f.context).not.toHaveProperty("resumeSessionParams");
    expect(f.where).toHaveBeenCalledOnce();
  });
  it("returns to Claude with a fresh session and original settings", async () => {
    const f = fixture("claude", "codex");
    const result = await resolve(f);
    expect(result?.config).toMatchObject({ provider: "acpx", acpxAgent: "claude", model: "claude", modelReasoningEffort: "high" });
    expect(result?.binding).toEqual(claude);
    expect(f.context.forceFreshSession).toBe(true);
  });
  it("preserves sessions within the same mode", async () => {
    const f = fixture("codex", "codex");
    await resolve(f);
    expect(f.context.forceFreshSession).toBeUndefined();
  });
  it("leaves agents outside the switch alone", async () => {
    const f = fixture(); f.agent.runtimeConfig.companyExecutionSwitch.enabled = false;
    expect(await resolve(f)).toBeNull();
    expect(f.where).not.toHaveBeenCalled();
  });
  it("recovery uses the recorded selection rather than the current company mode", async () => {
    const f = fixture("claude");
    f.run.contextSnapshot = { companyExecutionSwitch: { mode: "codex", config: { provider: "codex", model: "saved" }, binding: codex } };
    expect((await resolve(f, false))?.config.model).toBe("saved");
    expect(f.where).not.toHaveBeenCalled();
  });
  it("rejects a subscription account as paid fallback", async () => {
    const f = fixture(); f.agent.runtimeConfig.companyExecutionSwitch.codexConnection.method = "subscription";
    await expect(resolve(f)).rejects.toThrow("API-key");
  });
});
