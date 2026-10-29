import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Per-company directory isolation for Claude runs, built on Claude Code's
 * OS sandbox (Seatbelt on macOS, bubblewrap on Linux) plus path-scoped
 * permission rules for Claude's own file tools, which run outside the sandbox.
 *
 * Probe findings this design relies on (Claude Code 2.1.312, macOS):
 * - sandbox `allowRead` on a narrower path overrides `denyRead` on its parent;
 * - sandbox `denyWrite` wins over a narrower `allowWrite`, so writes are
 *   limited by denying siblings, not by allow-listing the worktree;
 * - `Read(...)`/`Edit(...)`/`Write(...)` deny rules hold in `auto` mode;
 * - sandboxed commands reach localhost only with `allowLocalBinding: true`.
 */

export interface ClaudeSandboxConfig {
  isolationRoot: string;
  allowedDomains: string[];
  extraDenyRead: string[];
}

export interface ClaudeSandboxProfile {
  companyRoot: string;
  /** Sandbox settings passed to Claude via `--settings`. */
  settings: Record<string, unknown>;
  /** Tool rules for the read-only profile (dontAsk allowlist). */
  readOnlyAllowedTools: string[];
  /** Tool deny rules for full-permission profiles. */
  disallowedTools: string[];
}

export class ClaudeSandboxProfileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClaudeSandboxProfileError";
  }
}

const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".paperclip"];
/** Only read-only agents lose GitHub CLI credentials; the implementer opens PRs. */
const READ_ONLY_SECRET_DIRS = [".config/gh"];

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

export function readClaudeSandboxConfig(config: Record<string, unknown>): ClaudeSandboxConfig | null {
  const raw = config.claudeSandbox;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.enabled !== true) return null;
  const isolationRoot = typeof record.isolationRoot === "string" ? record.isolationRoot.trim() : "";
  if (!isolationRoot) {
    throw new ClaudeSandboxProfileError(
      "claude_sandbox_config_invalid",
      "claudeSandbox.isolationRoot is required when claudeSandbox.enabled is true.",
    );
  }
  return {
    isolationRoot,
    allowedDomains: stringList(record.allowedDomains),
    extraDenyRead: stringList(record.extraDenyRead),
  };
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

async function realpathOrResolved(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return fs.realpath(resolved).catch(() => resolved);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Claude permission rules take absolute paths as `//abs/path`. */
function ruleFor(tool: string, absolutePath: string): string {
  return `${tool}(/${absolutePath}/**)`;
}

async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const dir = stdout.trim();
    return dir ? await realpathOrResolved(dir) : null;
  } catch {
    return null;
  }
}

/**
 * Deny rules cannot carve exceptions, so when a denied directory contains a
 * path Claude still needs, deny its other children instead (bounded depth).
 */
async function denyAroundRuntimePaths(dir: string, runtimePaths: string[], depth = 4): Promise<string[]> {
  const needed = runtimePaths.filter((runtimePath) => isWithin(runtimePath, dir));
  if (needed.length === 0) return [dir];
  if (needed.some((runtimePath) => runtimePath === dir) || depth === 0) return [];
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const nested = await Promise.all(entries.map((entry) => denyAroundRuntimePaths(path.join(dir, entry), needed, depth - 1)));
  return nested.flat();
}

/** Real paths of the prompt bundle's skill entries (they are usually symlinks). */
async function skillRealPaths(promptBundleDir: string): Promise<string[]> {
  const skillsHome = path.join(promptBundleDir, ".claude", "skills");
  const entries = await fs.readdir(skillsHome).catch(() => [] as string[]);
  return Promise.all(entries.map((entry) => realpathOrResolved(path.join(skillsHome, entry))));
}

export async function resolveClaudeSandboxProfile(input: {
  sandbox: ClaudeSandboxConfig;
  cwd: string;
  readOnly: boolean;
  promptBundleDir: string;
  instructionsDir?: string | null;
  homeDir?: string;
}): Promise<ClaudeSandboxProfile> {
  const homeDir = input.homeDir ?? os.homedir();
  const isolationRoot = await realpathOrResolved(expandHome(input.sandbox.isolationRoot, homeDir));
  const cwd = await realpathOrResolved(input.cwd);
  const relative = path.relative(isolationRoot, cwd);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ClaudeSandboxProfileError(
      "claude_sandbox_workspace_outside_root",
      `Workspace ${cwd} is not inside a company directory under ${isolationRoot}. ` +
        "Point the project's workspace at a folder under claudeSandbox.isolationRoot.",
    );
  }
  const companyRoot = path.join(isolationRoot, relative.split(path.sep)[0]!);

  const rootEntries = await fs.readdir(isolationRoot, { withFileTypes: true }).catch(() => []);
  const siblings = (await Promise.all(rootEntries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(isolationRoot, entry.name))
    .filter((entry) => entry !== companyRoot)
    .map(realpathOrResolved)))
    .filter((entry) => !isWithin(cwd, entry));

  const promptBundleDir = await realpathOrResolved(input.promptBundleDir);
  const instructionsDir = input.instructionsDir ? await realpathOrResolved(input.instructionsDir) : null;
  const skillPaths = await skillRealPaths(promptBundleDir);
  // Claude must keep reading its own prompt bundle, instructions and skills
  // even when they live under a denied directory.
  const runtimeReadPaths = [...new Set([promptBundleDir, ...(instructionsDir ? [instructionsDir] : []), ...skillPaths])];

  const secretDirs = [...SECRET_DIRS, ...(input.readOnly ? READ_ONLY_SECRET_DIRS : [])]
    .map((dir) => path.join(homeDir, dir));
  const extraDenyRead = await Promise.all(input.sandbox.extraDenyRead
    .map((entry) => realpathOrResolved(expandHome(entry, homeDir))));
  const deniedReadPaths = [isolationRoot, ...secretDirs, ...extraDenyRead];

  const writableGitDir = input.readOnly ? null : await gitCommonDir(cwd);
  const filesystem: Record<string, unknown> = {
    denyRead: deniedReadPaths,
    allowRead: [companyRoot, ...runtimeReadPaths],
    denyWrite: input.readOnly
      ? [companyRoot, ...siblings, promptBundleDir]
      : [...siblings, promptBundleDir],
  };
  if (writableGitDir && !isWithin(writableGitDir, cwd)) filesystem.allowWrite = [writableGitDir];

  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      // Read-only runs keep their explicit Bash allowlist on top of the sandbox.
      ...(input.readOnly ? { autoAllowBashIfSandboxed: false } : {}),
      filesystem,
      network: {
        // Required on macOS for the Paperclip API on localhost.
        allowLocalBinding: true,
        allowedDomains: input.readOnly ? [] : input.sandbox.allowedDomains,
      },
    },
  };

  const companyReadable = [companyRoot, ...runtimeReadPaths];
  const readOnlyAllowedTools = companyReadable.flatMap((dir) => [
    ruleFor("Read", dir),
    ruleFor("Grep", dir),
    ruleFor("Glob", dir),
  ]);
  const deniedForTools = (await Promise.all(
    [...siblings, ...secretDirs, ...extraDenyRead].map((dir) => denyAroundRuntimePaths(dir, runtimeReadPaths)),
  )).flat();
  const disallowedTools = deniedForTools.flatMap((dir) => [
    ruleFor("Read", dir),
    ruleFor("Edit", dir),
    ruleFor("Write", dir),
  ]);

  return { companyRoot, settings, readOnlyAllowedTools, disallowedTools };
}
