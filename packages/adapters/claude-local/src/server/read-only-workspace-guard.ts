import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ReadOnlyWorkspaceSnapshot {
  head: string;
  status: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

/**
 * Detection backstop for read-only runs. Claude Code permissions are the
 * primary control; this records HEAD and the working-tree state so a run
 * that changed the workspace anyway is reported instead of trusted.
 * Returns null when the directory is not a git work tree.
 */
export async function snapshotReadOnlyWorkspace(cwd: string): Promise<ReadOnlyWorkspaceSnapshot | null> {
  try {
    const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return null;
    const head = (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
    const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"]);
    return { head, status };
  } catch {
    return null;
  }
}

export function describeReadOnlyWorkspaceChange(
  before: ReadOnlyWorkspaceSnapshot,
  after: ReadOnlyWorkspaceSnapshot | null,
): string | null {
  if (!after) return "the workspace could not be inspected after the run";
  if (before.head !== after.head) return `HEAD moved from ${before.head || "(none)"} to ${after.head || "(none)"}`;
  if (before.status !== after.status) {
    const beforeLines = new Set(before.status.split("\n").filter(Boolean));
    const changed = after.status.split("\n").filter((line) => line && !beforeLines.has(line));
    const sample = changed.slice(0, 5).join(", ");
    return changed.length > 0
      ? `working tree changed (${sample}${changed.length > 5 ? ", …" : ""})`
      : "working tree changed";
  }
  return null;
}
