interface ClaudePermissionInput {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}

// Permission defaults are identical for local, remote, and connected tools.
// A tool allowlist is not equivalent to full bypass: it misses MCP tools and
// tools added by later provider releases. Let Claude enforce its own launch
// requirements rather than silently downgrading the requested permission mode.
export function buildClaudeExecutionPermissionArgs(input: ClaudePermissionInput): string[] {
  return input.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [];
}

export const buildClaudeProbePermissionArgs = buildClaudeExecutionPermissionArgs;

/** Claude permits full bypass as root only inside an identified sandbox. */
export function claudeSandboxPermissionEnv(input: {
  dangerouslySkipPermissions: boolean;
  targetIsSandbox: boolean;
}): Record<string, string> {
  return input.dangerouslySkipPermissions && input.targetIsSandbox ? { IS_SANDBOX: "1" } : {};
}

/** Claude Code CLI `--permission-mode` values that Paperclip passes through. */
export const CLAUDE_CLI_PERMISSION_MODES = [
  "auto",
  "dontAsk",
  "plan",
  "acceptEdits",
  "bypassPermissions",
] as const;
export type ClaudeCliPermissionMode = (typeof CLAUDE_CLI_PERMISSION_MODES)[number];

/** Built-in tools available to read-only runs; Edit/Write/NotebookEdit are not loaded at all. */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"] as const;

/**
 * Pre-approved tools for read-only runs. `dontAsk` denies everything else, so
 * Bash is limited to the Paperclip API (curl) and read-only git inspection.
 */
export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Bash(curl:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
] as const;

export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

const PERMISSION_FLAGS = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
] as const;
const READ_ONLY_CONFLICTING_FLAGS = [
  ...PERMISSION_FLAGS,
  "--tools",
  "--allowedTools",
  "--allowed-tools",
  "--setting-sources",
  "--settings",
] as const;

export type ClaudePermissionProfile =
  | { kind: "legacy"; dangerouslySkipPermissions: boolean }
  | {
    kind: "mode";
    mode: ClaudeCliPermissionMode;
    allowedTools: string[];
    disallowedTools: string[];
  }
  | {
    kind: "read_only";
    reason: "agent_tool_profile" | "plan_approval_gate";
    allowedTools: string[];
    disallowedTools: string[];
  };

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function readPlanGateMode(context: Record<string, unknown> | undefined): string | null {
  const gate = context?.paperclipPlanGate;
  if (typeof gate !== "object" || gate === null) return null;
  const mode = (gate as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode : null;
}

/**
 * Resolve the Claude permission contract for one run.
 *
 * - A plan-gated planning run, or an agent with `toolProfile: "read_only"`, is
 *   always read-only, whatever bypass or mode the agent otherwise requests.
 * - `claudePermissionMode` selects a Claude Code `--permission-mode`.
 * - Otherwise the legacy `dangerouslySkipPermissions` behavior applies.
 */
export function resolveClaudePermissionProfile(
  config: Record<string, unknown>,
  context?: Record<string, unknown>,
): ClaudePermissionProfile {
  const allowedTools = stringList(config.allowedTools);
  const disallowedTools = stringList(config.disallowedTools);
  if (readPlanGateMode(context) === "plan") {
    // The gate is server policy: agent config may add denials but never widen it.
    return { kind: "read_only", reason: "plan_approval_gate", allowedTools: [], disallowedTools };
  }
  if (config.toolProfile === "read_only") {
    return { kind: "read_only", reason: "agent_tool_profile", allowedTools, disallowedTools };
  }
  const mode = typeof config.claudePermissionMode === "string" ? config.claudePermissionMode.trim() : "";
  if ((CLAUDE_CLI_PERMISSION_MODES as readonly string[]).includes(mode)) {
    return { kind: "mode", mode: mode as ClaudeCliPermissionMode, allowedTools, disallowedTools };
  }
  return {
    kind: "legacy",
    dangerouslySkipPermissions: typeof config.dangerouslySkipPermissions === "boolean"
      ? config.dangerouslySkipPermissions
      : true,
  };
}

/** True when the run must use the CLI engine because ACP cannot express the profile. */
export function claudePermissionProfileRequiresCli(
  profile: ClaudePermissionProfile,
  config: Record<string, unknown> = {},
): boolean {
  const sandbox = config.claudeSandbox;
  const sandboxEnabled = typeof sandbox === "object" && sandbox !== null &&
    (sandbox as Record<string, unknown>).enabled === true;
  return profile.kind !== "legacy" || sandboxEnabled;
}

/** Whether Claude runs with full permission bypass under this profile. */
export function claudePermissionProfileBypasses(profile: ClaudePermissionProfile): boolean {
  if (profile.kind === "legacy") return profile.dangerouslySkipPermissions;
  return profile.kind === "mode" && profile.mode === "bypassPermissions";
}

/** Whether Claude must ignore project/local settings files from the workspace. */
export function claudePermissionProfileRestrictsSettingSources(profile: ClaudePermissionProfile): boolean {
  return profile.kind === "read_only";
}

function flagMatches(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`);
}

/** Returns the first extra arg that would override the resolved permission profile. */
export function findClaudePermissionProfileConflict(
  profile: ClaudePermissionProfile,
  extraArgs: readonly string[],
): string | null {
  if (profile.kind === "legacy") return null;
  const flags: readonly string[] = profile.kind === "read_only" ? READ_ONLY_CONFLICTING_FLAGS : PERMISSION_FLAGS;
  return extraArgs.find((arg) => flags.some((flag) => flagMatches(arg, flag))) ?? null;
}

/** Sandbox inputs from `resolveClaudeSandboxProfile` (see sandbox-profile.ts). */
export interface ClaudeSandboxArgs {
  settings: Record<string, unknown>;
  readOnlyAllowedTools: string[];
  readOnlyDisallowedTools?: string[];
  disallowedTools: string[];
}

/** Read-only file tools; with a sandbox they are replaced by path-scoped rules. */
const UNSCOPED_READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

export function buildClaudePermissionProfileArgs(
  profile: ClaudePermissionProfile,
  input: Omit<ClaudePermissionInput, "dangerouslySkipPermissions">,
  sandbox: ClaudeSandboxArgs | null = null,
): string[] {
  const sandboxArgs = sandbox ? ["--settings", JSON.stringify(sandbox.settings)] : [];
  if (profile.kind === "legacy") {
    const args = buildClaudeExecutionPermissionArgs({ ...input, dangerouslySkipPermissions: profile.dangerouslySkipPermissions });
    if (sandbox && sandbox.disallowedTools.length > 0) args.push("--disallowedTools", ...sandbox.disallowedTools);
    return [...args, ...sandboxArgs];
  }
  if (profile.kind === "mode") {
    const args = ["--permission-mode", profile.mode];
    const disallowed = [...new Set([...profile.disallowedTools, ...(sandbox?.disallowedTools ?? [])])];
    if (profile.allowedTools.length > 0) args.push("--allowedTools", ...profile.allowedTools);
    if (disallowed.length > 0) args.push("--disallowedTools", ...disallowed);
    return [...args, ...sandboxArgs];
  }
  const baseAllowed = sandbox
    ? [...sandbox.readOnlyAllowedTools, ...CLAUDE_READ_ONLY_ALLOWED_TOOLS.filter((tool) => !UNSCOPED_READ_TOOLS.has(tool))]
    : [...CLAUDE_READ_ONLY_ALLOWED_TOOLS];
  const allowed = [...new Set([...baseAllowed, ...profile.allowedTools])];
  const disallowed = [...new Set([
    ...CLAUDE_READ_ONLY_DISALLOWED_TOOLS,
    ...profile.disallowedTools,
    ...(sandbox?.readOnlyDisallowedTools ?? []),
  ])];
  return [
    "--permission-mode", "dontAsk",
    "--tools", CLAUDE_READ_ONLY_TOOLS.join(","),
    "--allowedTools", ...allowed,
    "--disallowedTools", ...disallowed,
    ...sandboxArgs,
  ];
}
