import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeSandboxToolDomains,
  cleanupClaudeToolRuntime,
  readClaudeSandboxTools,
  stageClaudeToolRuntime,
} from "./sandbox-tools.js";

const dirs: string[] = [];
const runIds: string[] = [];

async function fakeBinDir(names: string[]) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-bin-")));
  dirs.push(dir);
  for (const name of names) await fs.writeFile(path.join(dir, name), "#!/bin/sh\necho real\n", { mode: 0o755 });
  return dir;
}

function runId() {
  const id = `test-${Math.random().toString(36).slice(2)}`;
  runIds.push(id);
  return id;
}

afterEach(async () => {
  await Promise.all(runIds.splice(0).map(cleanupClaudeToolRuntime));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sandbox tool presets", () => {
  it("keeps only known tools", () => {
    expect(readClaudeSandboxTools(["aws", "terraform", "aws", 3])).toEqual(["aws"]);
    expect(readClaudeSandboxTools(undefined)).toEqual([]);
  });

  it("merges preset domains", () => {
    expect(claudeSandboxToolDomains(["aws", "supabase"])).toEqual(
      expect.arrayContaining(["*.amazonaws.com", "*.awsapps.com", "api.supabase.com", "*.supabase.co"]),
    );
  });
});

describe("stageClaudeToolRuntime", () => {
  it("wraps aws and supabase with the company tool home and sets CLI env", async () => {
    const bin = await fakeBinDir(["aws", "supabase", "az"]);
    const staged = await stageClaudeToolRuntime({
      runId: runId(),
      tools: ["aws", "az", "supabase", "wrangler"],
      toolHome: "/ws/patlynk/.paperclip-tools",
      env: {},
      basePath: bin,
    });
    const awsWrapper = await fs.readFile(path.join(staged.directory, "bin", "aws"), "utf8");
    expect(awsWrapper).toContain("HOME='/ws/patlynk/.paperclip-tools/aws'");
    expect(awsWrapper).toContain(`exec '${path.join(bin, "aws")}'`);
    expect(await fs.readFile(path.join(staged.directory, "bin", "supabase"), "utf8"))
      .toContain("HOME='/ws/patlynk/.paperclip-tools/supabase'");
    await expect(fs.access(path.join(staged.directory, "bin", "az"))).rejects.toThrow();
    expect(staged.env).toMatchObject({
      AWS_CONFIG_FILE: "/ws/patlynk/.paperclip-tools/aws/config",
      AWS_EC2_METADATA_DISABLED: "true",
      AZURE_CONFIG_DIR: "/ws/patlynk/.paperclip-tools/azure",
      WRANGLER_SEND_METRICS: "false",
      PAPERCLIP_TOOL_HOME: "/ws/patlynk/.paperclip-tools",
    });
    expect(staged.env.PATH.split(path.delimiter)[0]).toBe(path.join(staged.directory, "bin"));
    expect(staged.missingBinaries).toEqual([]);
  });

  it("keeps project env values and chains existing shell profiles", async () => {
    const bin = await fakeBinDir(["aws"]);
    const previous = await fakeBinDir([]);
    const staged = await stageClaudeToolRuntime({
      runId: runId(),
      tools: ["aws"],
      toolHome: "/ws/a/.paperclip-tools",
      env: { AWS_CONFIG_FILE: "/custom/config", ZDOTDIR: previous, BASH_ENV: `${previous}/.bashrc` },
      basePath: bin,
    });
    expect(staged.env.AWS_CONFIG_FILE).toBeUndefined();
    expect(staged.env.ZDOTDIR).toBe(path.join(staged.directory, "profile"));
    const zshenv = await fs.readFile(path.join(staged.directory, "profile", ".zshenv"), "utf8");
    expect(zshenv.indexOf(`. '${previous}/.zshenv'`)).toBeLessThan(zshenv.indexOf("export PATH="));
    const bashrc = await fs.readFile(path.join(staged.directory, "profile", ".bashrc"), "utf8");
    expect(bashrc).toContain(`. '${previous}/.bashrc'`);
  });

  it("reports CLIs that are not installed", async () => {
    const staged = await stageClaudeToolRuntime({
      runId: runId(),
      tools: ["aws"],
      toolHome: "/ws/a/.paperclip-tools",
      env: {},
      basePath: await fakeBinDir([]),
    });
    expect(staged.missingBinaries).toEqual(["aws"]);
  });

  it("resolves mise shims to the installed binary", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mise-")));
    dirs.push(root);
    const shims = path.join(root, "mise", "shims");
    const installed = path.join(root, "mise", "installs", "aws", "2.0.0", "bin");
    const miseBin = path.join(root, "bin");
    for (const dir of [shims, installed, miseBin]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(shims, "aws"), "#!/bin/sh\nexec mise x -- aws \"$@\"\n", { mode: 0o755 });
    await fs.writeFile(path.join(installed, "aws"), "#!/bin/sh\necho real\n", { mode: 0o755 });
    await fs.writeFile(path.join(miseBin, "mise"), `#!/bin/sh\n[ "$1" = which ] && echo '${path.join(installed, "aws")}'\n`, { mode: 0o755 });
    const staged = await stageClaudeToolRuntime({
      runId: runId(),
      tools: ["aws"],
      toolHome: "/ws/a/.paperclip-tools",
      env: {},
      basePath: [shims, miseBin, "/usr/bin", "/bin"].join(path.delimiter),
    });
    const wrapper = await fs.readFile(path.join(staged.directory, "bin", "aws"), "utf8");
    expect(wrapper).toContain(`exec '${path.join(installed, "aws")}'`);
  });
});
