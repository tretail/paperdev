import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Per-company cloud CLI access for sandboxed Claude runs.
 *
 * Credentials live in the company's tool home (`<companyRoot>/.paperclip-tools`)
 * or in the company project's secret env, never in the operator's personal
 * `~/.aws`, `~/.azure`, keychain, or CLI config. Probe findings (Claude Code
 * 2.1.312, macOS) this relies on:
 * - Claude's shell rebuilds PATH from login profiles, so wrappers are put
 *   first through a ZDOTDIR/BASH_ENV profile, like Paperclip's GitHub launchers;
 * - the sandbox always denies reads of any `.aws/config` file, so AWS uses
 *   AWS_CONFIG_FILE at a neutral path; the SSO token cache is HOME-relative,
 *   so `aws` runs with HOME pointed at the company tool home;
 * - `supabase` writes `~/.supabase` on every call and needs the same HOME wrapper;
 * - wildcard domains such as `*.amazonaws.com` work in `allowedDomains`;
 * - raw TCP (e.g. Postgres to Supabase) cannot leave the sandbox.
 */

export const CLAUDE_SANDBOX_TOOL_NAMES = ["gh", "aws", "az", "wrangler", "supabase"] as const;
export type ClaudeSandboxToolName = (typeof CLAUDE_SANDBOX_TOOL_NAMES)[number];

export const TOOL_HOME_DIRNAME = ".paperclip-tools";

interface ToolPreset {
  domains: string[];
  /** Binary run with HOME set to `<toolHome>/<tool>`. */
  homeWrapper?: string;
  env?: (toolHome: string) => Record<string, string>;
  /**
   * Go binary: macOS TLS verification goes through `com.apple.trustd.agent`,
   * which the sandbox blocks unless weaker network isolation is enabled
   * (otherwise `x509: OSStatus -26276`).
   */
  needsTrustd?: boolean;
}

const TOOL_PRESETS: Record<ClaudeSandboxToolName, ToolPreset> = {
  gh: {
    domains: ["github.com", "api.github.com", "uploads.github.com", "codeload.github.com", "objects.githubusercontent.com"],
    needsTrustd: true,
  },
  aws: {
    domains: ["*.amazonaws.com", "*.awsapps.com"],
    homeWrapper: "aws",
    env: (toolHome) => ({
      AWS_CONFIG_FILE: path.join(toolHome, "aws", "config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(toolHome, "aws", "credentials"),
      AWS_EC2_METADATA_DISABLED: "true",
    }),
  },
  az: {
    domains: ["login.microsoftonline.com", "management.azure.com", "graph.microsoft.com", "*.azure.com"],
    env: (toolHome) => ({
      AZURE_CONFIG_DIR: path.join(toolHome, "azure"),
      AZURE_CORE_COLLECT_TELEMETRY: "false",
    }),
  },
  wrangler: {
    domains: ["api.cloudflare.com", "dash.cloudflare.com", "registry.npmjs.org"],
    env: (toolHome) => ({
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: path.join(toolHome, "wrangler", "logs"),
    }),
  },
  supabase: {
    domains: ["api.supabase.com", "*.supabase.co", "*.supabase.com"],
    homeWrapper: "supabase",
    needsTrustd: true,
  },
};

/** Personal CLI state that no agent may read, whatever tools it has. */
export const PERSONAL_TOOL_STATE_DIRS = [".azure", ".supabase", "Library/Preferences/.wrangler"];

/** Package-manager caches the implementer must write to install dependencies. */
export const TOOLCHAIN_CACHE_DIRS = [".npm", ".cache", "Library/Caches", "Library/pnpm", ".bun/install/cache"];

/**
 * pnpm 12 keeps its install locks in fixed per-user folders under /tmp and
 * ignores TMPDIR (ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK without them).
 */
export function pnpmLockDirs(tmpRoot: string, uid: number): string[] {
  return ["pnpm-store-operation-locks", "pnpm-dir-locks", "pnpm-modules-swaps"]
    .map((name) => path.join(tmpRoot, `${name}-${uid}`));
}

export function readClaudeSandboxTools(value: unknown): ClaudeSandboxToolName[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(CLAUDE_SANDBOX_TOOL_NAMES);
  return [...new Set(value.filter((entry): entry is ClaudeSandboxToolName => typeof entry === "string" && known.has(entry)))];
}

export function claudeSandboxToolDomains(tools: readonly ClaudeSandboxToolName[]): string[] {
  return [...new Set(tools.flatMap((tool) => TOOL_PRESETS[tool].domains))];
}

export function claudeSandboxToolsNeedTrustd(tools: readonly ClaudeSandboxToolName[]): boolean {
  return tools.some((tool) => TOOL_PRESETS[tool].needsTrustd === true);
}

export function companyToolHome(companyRoot: string): string {
  return path.join(companyRoot, TOOL_HOME_DIRNAME);
}

export function claudeToolRuntimeDirectory(runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run ID for the Claude tool runtime");
  return path.join(os.tmpdir(), "paperclip-tool-runtime", runId);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isMiseShim(candidate: string): boolean {
  return candidate.split(path.sep).join("/").includes("/mise/shims/");
}

/**
 * A mise shim re-enters `mise` (reading and writing its state) on every call,
 * which the sandbox may refuse. Resolve shims to the installed binary while
 * staging, outside the sandbox, using the global mise configuration.
 */
async function resolveMiseShim(name: string, searchPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("mise", ["which", name], {
      cwd: os.homedir(),
      env: { ...process.env, PATH: searchPath },
      timeout: 15_000,
    });
    const resolved = stdout.trim();
    return resolved && !isMiseShim(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

async function resolveBinary(name: string, searchPath: string, exclude: string): Promise<string | null> {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || path.resolve(dir) === exclude) continue;
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    if (!isMiseShim(candidate)) return candidate;
    const resolved = await resolveMiseShim(name, searchPath);
    if (resolved) return resolved;
  }
  return null;
}

const ZSH_PROFILES = [".zshenv", ".zprofile", ".zshrc"];
const BASH_PROFILES = [".bashrc", ".bash_profile", ".profile"];

// JVM defaults that can't work in the sandbox. Nested shells source the profile
// again; each guard keeps one copy and an explicit setting wins.
// - The JVM ignores TMPDIR: on macOS it takes java.io.tmpdir from the per-user
//   /var/folders temp dir, which the sandbox denies writing (the Kotlin compiler
//   fails on its `.alive` file there). Point it at the shell's TMPDIR instead.
// - The sandbox can't reach the window server, so a JVM that touches AWT on
//   macOS hangs starting AppKit (LWCToolkit.initAppkit). Run headless.
const JVM_SANDBOX_PROFILE = [
  'case " ${JAVA_TOOL_OPTIONS:-} " in',
  '  *" -Djava.io.tmpdir="*) ;;',
  '  *) if [ -n "${TMPDIR:-}" ]; then export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$TMPDIR${JAVA_TOOL_OPTIONS:+ $JAVA_TOOL_OPTIONS}"; fi ;;',
  "esac",
  'case " ${JAVA_TOOL_OPTIONS:-} " in',
  '  *" -Djava.awt.headless="*) ;;',
  '  *) export JAVA_TOOL_OPTIONS="-Djava.awt.headless=true${JAVA_TOOL_OPTIONS:+ $JAVA_TOOL_OPTIONS}" ;;',
  "esac",
  "",
].join("\n");

/**
 * Stage wrappers and env for one run. Existing ZDOTDIR/BASH_ENV profiles
 * (e.g. Paperclip's GitHub launchers) are sourced first, then the tool bin
 * directory is put at the front of PATH.
 */
export async function stageClaudeToolRuntime(input: {
  runId: string;
  tools: readonly ClaudeSandboxToolName[];
  toolHome: string;
  env: Record<string, string>;
  basePath: string;
}): Promise<{ env: Record<string, string>; directory: string; missingBinaries: string[] }> {
  const directory = claudeToolRuntimeDirectory(input.runId);
  const binDir = path.join(directory, "bin");
  const profileDir = path.join(directory, "profile");
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });

  const missingBinaries: string[] = [];
  const toolEnv: Record<string, string> = {};
  for (const tool of input.tools) {
    const preset = TOOL_PRESETS[tool];
    for (const [key, value] of Object.entries(preset.env?.(input.toolHome) ?? {})) {
      // Project env (company secrets) wins over defaults.
      if (!input.env[key]) toolEnv[key] = value;
    }
    if (!preset.homeWrapper) continue;
    const binary = await resolveBinary(preset.homeWrapper, input.basePath, path.resolve(binDir));
    if (!binary) {
      missingBinaries.push(preset.homeWrapper);
      continue;
    }
    const home = path.join(input.toolHome, tool);
    await fs.writeFile(
      path.join(binDir, preset.homeWrapper),
      `#!/bin/sh\n# Paperclip: run ${preset.homeWrapper} with this company's tool home.\nHOME=${shellQuote(home)} exec ${shellQuote(binary)} "$@"\n`,
      { mode: 0o700 },
    );
  }

  const previousZdotdir = input.env.ZDOTDIR;
  const previousBashEnv = input.env.BASH_ENV;
  const prependPath = `export PATH=${shellQuote(binDir)}:"$PATH"\n${JVM_SANDBOX_PROFILE}`;
  for (const name of ZSH_PROFILES) {
    const source = previousZdotdir ? `[ -f ${shellQuote(path.join(previousZdotdir, name))} ] && . ${shellQuote(path.join(previousZdotdir, name))}\n` : "";
    await fs.writeFile(path.join(profileDir, name), source + prependPath, { mode: 0o600 });
  }
  for (const name of BASH_PROFILES) {
    const previous = name === ".bashrc" ? previousBashEnv : previousZdotdir ? path.join(previousZdotdir, name) : undefined;
    const source = previous ? `[ -f ${shellQuote(previous)} ] && . ${shellQuote(previous)}\n` : "";
    await fs.writeFile(path.join(profileDir, name), source + prependPath, { mode: 0o600 });
  }

  return {
    env: {
      ...toolEnv,
      PATH: `${binDir}${path.delimiter}${input.basePath}`,
      ZDOTDIR: profileDir,
      BASH_ENV: path.join(profileDir, ".bashrc"),
      PAPERCLIP_TOOL_HOME: input.toolHome,
      PAPERCLIP_SANDBOX_TOOLS: input.tools.join(","),
    },
    directory,
    missingBinaries,
  };
}

export async function cleanupClaudeToolRuntime(runId: string): Promise<void> {
  await fs.rm(claudeToolRuntimeDirectory(runId), { recursive: true, force: true });
}
