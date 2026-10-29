import { describe, expect, it } from "vitest";
import {
  buildClaudePermissionProfileArgs,
  claudePermissionProfileBypasses,
  claudePermissionProfileRequiresCli,
  findClaudePermissionProfileConflict,
  resolveClaudePermissionProfile,
} from "./permissions.js";

const target = { targetIsRemote: false, localProcessUid: 1000 };

describe("Claude permission profiles", () => {
  it("keeps legacy full bypass when no profile is configured", () => {
    const profile = resolveClaudePermissionProfile({});
    expect(profile).toEqual({ kind: "legacy", dangerouslySkipPermissions: true });
    expect(buildClaudePermissionProfileArgs(profile, target)).toEqual(["--dangerously-skip-permissions"]);
    expect(claudePermissionProfileRequiresCli(profile)).toBe(false);
  });

  it("passes claudePermissionMode through with tool rules", () => {
    const profile = resolveClaudePermissionProfile({
      claudePermissionMode: "auto",
      dangerouslySkipPermissions: true,
      disallowedTools: ["Bash(rm -rf:*)"],
    });
    expect(buildClaudePermissionProfileArgs(profile, target)).toEqual([
      "--permission-mode", "auto", "--disallowedTools", "Bash(rm -rf:*)",
    ]);
    expect(claudePermissionProfileBypasses(profile)).toBe(false);
    expect(claudePermissionProfileRequiresCli(profile)).toBe(true);
  });

  it("ignores unknown permission modes", () => {
    expect(resolveClaudePermissionProfile({ claudePermissionMode: "yolo" }).kind).toBe("legacy");
  });

  it("builds a dontAsk read-only profile without edit tools or bypass", () => {
    const args = buildClaudePermissionProfileArgs(resolveClaudePermissionProfile({ toolProfile: "read_only" }), target);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args.slice(0, 4)).toEqual(["--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob,Bash,WebSearch,WebFetch"]);
    expect(args).toContain("Bash(curl:*)");
    const disallowed = args.slice(args.indexOf("--disallowedTools") + 1);
    expect(disallowed).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
  });

  it("forces read-only for plan-gated runs even when the agent asks for bypass", () => {
    const profile = resolveClaudePermissionProfile(
      { claudePermissionMode: "bypassPermissions", allowedTools: ["Edit", "Bash"] },
      { paperclipPlanGate: { mode: "plan" } },
    );
    expect(profile).toMatchObject({ kind: "read_only", reason: "plan_approval_gate", allowedTools: [] });
    const args = buildClaudePermissionProfileArgs(profile, target);
    expect(args).not.toContain("bypassPermissions");
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).not.toContain("Edit");
    expect(allowed).not.toContain("Bash");
  });

  it("does not restrict approved implementation runs", () => {
    const profile = resolveClaudePermissionProfile(
      { claudePermissionMode: "auto" },
      { paperclipPlanGate: { mode: "implement" } },
    );
    expect(profile.kind).toBe("mode");
  });

  it("rejects extraArgs that would override a profile", () => {
    const readOnly = resolveClaudePermissionProfile({ toolProfile: "read_only" });
    expect(findClaudePermissionProfileConflict(readOnly, ["--dangerously-skip-permissions"])).toBe("--dangerously-skip-permissions");
    expect(findClaudePermissionProfileConflict(readOnly, ["--settings={}"])).toBe("--settings={}");
    expect(findClaudePermissionProfileConflict(readOnly, ["--chrome"])).toBeNull();
    const mode = resolveClaudePermissionProfile({ claudePermissionMode: "auto" });
    expect(findClaudePermissionProfileConflict(mode, ["--permission-mode", "bypassPermissions"])).toBe("--permission-mode");
    expect(findClaudePermissionProfileConflict(resolveClaudePermissionProfile({}), ["--permission-mode"])).toBeNull();
  });
});

describe("Claude engine selection for permission profiles", () => {
  it("uses the CLI engine for profiles and rejects explicit ACP", async () => {
    const { resolveClaudeExecutionEngineForRun } = await import("./acp.js");
    await expect(resolveClaudeExecutionEngineForRun({
      config: {},
      context: { paperclipPlanGate: { mode: "plan" } },
    } as never)).resolves.toEqual({ engine: "cli", explicit: false });
    const explicitAcp = await resolveClaudeExecutionEngineForRun({
      config: { engine: "acp", toolProfile: "read_only" },
    } as never);
    expect(explicitAcp.engine).toBe("acp");
    expect(explicitAcp.unavailableReason).toMatch(/require the Claude CLI engine/);
  });
});
