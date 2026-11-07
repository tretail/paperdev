import { and, eq, sql } from "drizzle-orm";
import { companies, heartbeatRuns, type Db, type agents, type agentTaskSessions } from "@paperclipai/db";
import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";

/** A run retains its selection through recovery, even when company settings change. */
export async function resolveCompanyExecutionSwitch(db: Db, agent: typeof agents.$inferSelect, run: typeof heartbeatRuns.$inferSelect, taskSession: typeof agentTaskSessions.$inferSelect | null, context: Record<string, unknown>) {
  let saved = parseObject(run.contextSnapshot?.companyExecutionSwitch);
  const settings = parseObject(agent.runtimeConfig?.companyExecutionSwitch);
  if (!Object.keys(saved).length && settings.enabled !== true) return null;
  if (!Object.keys(saved).length) {
    if (agent.adapterType !== "paperclip_runner" || agent.adapterConfig.provider !== "acpx" || (agent.adapterConfig.acpxAgent ?? "claude") !== "claude" || agent.adapterConfig.homeMode === "preconfigured") throw new Error("Company execution switching requires an isolated Paperclip Runner Claude agent.");
    const [company] = await db.select({ mode: companies.executionMode }).from(companies).where(eq(companies.id, agent.companyId));
    if (!company) throw new Error("Company is unavailable");
    const mode = company.mode;
    const config = { ...agent.adapterConfig };
    let binding = aiConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection);
    if (binding.provider !== "anthropic" || binding.method !== "subscription") throw new Error("Configure a Claude subscription connection before enabling the company switch.");
    if (mode === "codex") {
      binding = aiConnectionBindingSchema.parse(settings.codexConnection);
      if (binding.mode === "responsible_user" || binding.provider !== "openai" || binding.method !== "api_key") throw new Error("Select an OpenAI API-key connection for Codex fallback.");
      if (typeof settings.codexModel !== "string" || !settings.codexModel.trim()) throw new Error("Configure a Codex fallback model.");
      for (const key of ["command", "acpxAgent", "effort", "reasoningEffort", "modelReasoningEffort", "variant"]) delete config[key];
      Object.assign(config, { provider: "codex", model: settings.codexModel });
    }
    saved = { mode, config, binding };
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ companyExecutionSwitch: saved })}::jsonb` }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId)));
  }
  context.companyExecutionSwitch = saved;
  if (taskSession?.lastRunId) {
    const [previous] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, taskSession.lastRunId), eq(heartbeatRuns.companyId, agent.companyId)));
    if (parseObject(previous?.context?.companyExecutionSwitch).mode !== saved.mode) {
      context.forceFreshSession = true;
      delete context.resumeSessionParams;
      delete context.resumeSessionDisplayId;
    }
  }
  return { config: parseObject(saved.config), binding: aiConnectionBindingSchema.parse(saved.binding) };
}
