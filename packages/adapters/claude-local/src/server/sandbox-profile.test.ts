import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudePermissionProfileArgs, resolveClaudePermissionProfile } from "./permissions.js";
import {
  ClaudeSandboxProfileError,
  readClaudeSandboxConfig,
  resolveClaudeSandboxProfile,
} from "./sandbox-profile.js";

const roots: string[] = [];

async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sbx-home-")));
  roots.push(home);
  const ws = path.join(home, "Workspaces");
  for (const dir of ["a/repo", "b", "paperclip/skills/paperclip", ".ssh", ".paperclip/instances/default/secrets"]) {
    await fs.mkdir(dir.startsWith(".") ? path.join(home, dir) : path.join(ws, dir), { recursive: true });
  }
  const repo = path.join(ws, "a/repo");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const bundle = path.join(home, ".paperclip/instances/default/prompt-cache/bundle-1");
  await fs.mkdir(path.join(bundle, ".claude/skills"), { recursive: true });
  await fs.symlink(path.join(ws, "paperclip/skills/paperclip"), path.join(bundle, ".claude/skills/paperclip"));
  return { home, ws, repo, bundle };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const sandbox = { isolationRoot: "~/Workspaces", allowedDomains: ["github.com"], extraDenyRead: [], tools: [] as never[] };

describe("claudeSandbox config", () => {
  it("is off unless enabled, and requires an isolation root", () => {
    expect(readClaudeSandboxConfig({})).toBeNull();
    expect(readClaudeSandboxConfig({ claudeSandbox: { enabled: false } })).toBeNull();
    expect(() => readClaudeSandboxConfig({ claudeSandbox: { enabled: true } })).toThrow(ClaudeSandboxProfileError);
  });
});

describe("resolveClaudeSandboxProfile", () => {
  it("isolates the read-only profile to its company directory", async () => {
    const { home, ws, repo, bundle } = await fixture();
    const profile = await resolveClaudeSandboxProfile({ sandbox, cwd: repo, readOnly: true, promptBundleDir: bundle, homeDir: home });
    const fsSettings = (profile.settings.sandbox as any).filesystem;
    expect(profile.companyRoot).toBe(path.join(ws, "a"));
    expect(fsSettings.denyRead).toEqual(expect.arrayContaining([ws, path.join(home, ".ssh"), path.join(home, ".paperclip"), path.join(home, ".config/gh")]));
    expect(fsSettings.allowRead).toEqual(expect.arrayContaining([path.join(ws, "a"), bundle, path.join(ws, "paperclip/skills/paperclip")]));
    expect(fsSettings.denyWrite).toEqual(expect.arrayContaining([path.join(ws, "a"), path.join(ws, "b"), bundle]));
    expect(fsSettings.allowWrite).toBeUndefined();
    expect((profile.settings.sandbox as any)).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowLocalBinding: true, allowedDomains: [] },
    });
    expect(profile.readOnlyAllowedTools).toContain(`Read(/${path.join(ws, "a")}/**)`);
    expect(profile.readOnlyAllowedTools.some((rule) => rule.includes(path.join(ws, "b")))).toBe(false);
  });

  it("lets the implementer write its repo and git dir, never sibling companies or secrets", async () => {
    const { home, ws, repo, bundle } = await fixture();
    const profile = await resolveClaudeSandboxProfile({ sandbox, cwd: repo, readOnly: false, promptBundleDir: bundle, homeDir: home });
    const sandboxSettings = profile.settings.sandbox as any;
    expect(sandboxSettings.filesystem.denyWrite).toEqual(expect.arrayContaining([path.join(ws, "b")]));
    expect(sandboxSettings.filesystem.denyWrite).not.toContain(path.join(ws, "a"));
    expect(sandboxSettings.network.allowedDomains).toEqual(["github.com"]);
    expect(sandboxSettings.autoAllowBashIfSandboxed).toBeUndefined();
    expect(sandboxSettings.filesystem.denyRead).not.toContain(path.join(home, ".config/gh"));

    expect(profile.disallowedTools).toEqual(expect.arrayContaining([
      `Read(/${path.join(ws, "b")}/**)`,
      `Edit(/${path.join(ws, "b")}/**)`,
      `Read(/${path.join(home, ".ssh")}/**)`,
      `Read(/${path.join(home, ".paperclip/instances/default/secrets")}/**)`,
    ]));
    // Paths Claude needs (prompt bundle, skills) are carved out, not denied.
    expect(profile.disallowedTools.some((rule) => rule.includes(bundle))).toBe(false);
    expect(profile.disallowedTools).not.toContain(`Read(/${path.join(ws, "paperclip")}/**)`);
    expect(profile.disallowedTools).not.toContain(`Read(/${path.join(home, ".paperclip")}/**)`);
  });

  it("rejects a workspace outside the isolation root or equal to it", async () => {
    const { home, ws, bundle } = await fixture();
    for (const cwd of [home, ws]) {
      await expect(resolveClaudeSandboxProfile({ sandbox, cwd, readOnly: true, promptBundleDir: bundle, homeDir: home }))
        .rejects.toMatchObject({ code: "claude_sandbox_workspace_outside_root" });
    }
  });

  it("adds sandbox settings and path-scoped read rules to read-only args", async () => {
    const { home, repo, bundle } = await fixture();
    const profile = await resolveClaudeSandboxProfile({ sandbox, cwd: repo, readOnly: true, promptBundleDir: bundle, homeDir: home });
    const args = buildClaudePermissionProfileArgs(
      resolveClaudePermissionProfile({ toolProfile: "read_only" }),
      { targetIsRemote: false },
      profile,
    );
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).not.toContain("Read");
    expect(allowed).toEqual(expect.arrayContaining([profile.readOnlyAllowedTools[0], "Bash(curl:*)"]));
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual(profile.settings);
  });

  it("adds deny rules and settings to the implementer's permission-mode args", async () => {
    const { home, repo, bundle } = await fixture();
    const profile = await resolveClaudeSandboxProfile({ sandbox, cwd: repo, readOnly: false, promptBundleDir: bundle, homeDir: home });
    const args = buildClaudePermissionProfileArgs(
      resolveClaudePermissionProfile({ claudePermissionMode: "auto" }),
      { targetIsRemote: false },
      profile,
    );
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "auto"]);
    expect(args).toEqual(expect.arrayContaining(["--disallowedTools", ...profile.disallowedTools]));
    expect(args).toContain("--settings");
  });

  it("gives the implementer its tools, caches and tool home, and hides the tool home from read-only agents", async () => {
    const { home, ws, repo, bundle } = await fixture();
    const withTools = { ...sandbox, tools: ["aws" as const] };
    const implementer = await resolveClaudeSandboxProfile({ sandbox: withTools, cwd: repo, readOnly: false, promptBundleDir: bundle, homeDir: home });
    const toolHome = path.join(ws, "a", ".paperclip-tools");
    const implementerSettings = implementer.settings.sandbox as any;
    expect(implementer.tools).toEqual(["aws"]);
    expect(implementer.toolHome).toBe(toolHome);
    expect(implementerSettings.filesystem.allowWrite).toEqual(expect.arrayContaining([toolHome, path.join(home, ".npm")]));
    expect(implementerSettings.network.allowedDomains).toEqual(expect.arrayContaining(["github.com", "*.amazonaws.com"]));
    expect(implementerSettings.filesystem.denyRead).toEqual(expect.arrayContaining([path.join(home, ".azure"), path.join(home, "Library/Preferences/.wrangler")]));

    const planner = await resolveClaudeSandboxProfile({ sandbox: withTools, cwd: repo, readOnly: true, promptBundleDir: bundle, homeDir: home });
    const plannerSettings = planner.settings.sandbox as any;
    expect(planner.tools).toEqual([]);
    expect(plannerSettings.network.allowedDomains).toEqual([]);
    expect(plannerSettings.filesystem.denyRead).toContain(toolHome);
    expect(plannerSettings.filesystem.allowWrite).toBeUndefined();
    const args = buildClaudePermissionProfileArgs(resolveClaudePermissionProfile({ toolProfile: "read_only" }), { targetIsRemote: false }, planner);
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toContain(`Read(/${toolHome}/**)`);
  });
});
