import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeReadOnlyWorkspaceChange, snapshotReadOnlyWorkspace } from "./read-only-workspace-guard.js";

const dirs: string[] = [];
async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ro-guard-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  git("add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  return { dir, git };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("read-only workspace guard", () => {
  it("reports no change for an untouched repo", async () => {
    const { dir } = await repo();
    const before = await snapshotReadOnlyWorkspace(dir);
    expect(before).not.toBeNull();
    expect(describeReadOnlyWorkspaceChange(before!, await snapshotReadOnlyWorkspace(dir))).toBeNull();
  });

  it("detects new files and edits", async () => {
    const { dir } = await repo();
    const before = (await snapshotReadOnlyWorkspace(dir))!;
    await fs.writeFile(path.join(dir, "pwned.txt"), "x");
    expect(describeReadOnlyWorkspaceChange(before, await snapshotReadOnlyWorkspace(dir))).toContain("pwned.txt");
  });

  it("detects commits", async () => {
    const { dir, git } = await repo();
    const before = (await snapshotReadOnlyWorkspace(dir))!;
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "sneaky");
    expect(describeReadOnlyWorkspaceChange(before, await snapshotReadOnlyWorkspace(dir))).toMatch(/HEAD moved/);
  });

  it("skips non-git directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ro-guard-plain-"));
    dirs.push(dir);
    expect(await snapshotReadOnlyWorkspace(dir)).toBeNull();
  });
});
