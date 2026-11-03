import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
} from "../services/workspace-runtime.js";
import {
  doesLocalServiceCommandLineMatch,
  isLocalServiceCommandLineComparable,
  isLocalServiceProcessOwnedBy,
  listLocalServiceRegistryRecords,
  readLocalServicePortOwner,
  readLocalServiceProcessGroupId,
  resolveLocalServiceLogPath,
  terminateLocalService,
} from "../services/local-service-supervisor.js";

describe("local service supervision", () => {
  afterEach(async () => {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
  });

  it("keeps request-logging runtime stdio usable after the supervisor side closes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-stdio-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `service-stdio-${randomUUID()}`;

    // The managed service uses a login shell, whose PATH can select a different
    // Node installation from the one CI configured for this test process.
    // Git Bash accepts Windows drive paths with forward slashes.
    const nodeExecutable = process.platform === "win32"
      ? process.execPath.replace(/\\/g, "/")
      : process.execPath;
    const nodeCommand = "'" + nodeExecutable.replace(/'/g, "'\\''") + "'";
    let registryRecord: Awaited<ReturnType<typeof listLocalServiceRegistryRecords>>[number] | null = null;
    try {
      const [service] = await startRuntimeServicesForWorkspaceControl({
        actor: { id: null, name: "Board", companyId: randomUUID() },
        issue: null,
        workspace: {
          baseCwd: workspaceRoot,
          source: "agent_home",
          projectId: null,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
          strategy: "project_primary",
          cwd: workspaceRoot,
          branchName: null,
          worktreePath: null,
          warnings: [],
          created: false,
        },
        config: {
          workspaceRuntime: {
            services: [{
              name: "web",
              command: nodeCommand + " -e \"const http=require('node:http'); console.log('fixture starting', process.execPath, process.env.PORT); process.on('SIGTERM',()=>{}); http.createServer((req,res)=>{ process.stdout.write('request '+req.url+'\\\\n',(error)=>{ if (!error) res.end('ok'); }); }).listen(Number(process.env.PORT), '127.0.0.1',()=>console.log('fixture listening', process.env.PORT))\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "agent",
              stopPolicy: { type: "manual" },
            }],
          },
        },
        adapterEnv: {},
      });

      expect(service?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(service?.port).toBeTypeOf("number");
      registryRecord = (await listLocalServiceRegistryRecords({ profileKind: "workspace-runtime" }))
        .find((record) => record.runtimeServiceId === service!.id) ?? null;
      expect(registryRecord).not.toBeNull();

      await resetRuntimeServicesForTests({ simulateSupervisorExit: true });

      await expect(fetch(`${service!.url}/after-restart`)).resolves.toMatchObject({ ok: true });
      const log = await fs.readFile(resolveLocalServiceLogPath(registryRecord!.serviceKey), "utf8");
      expect(log).toContain("request /after-restart");
      expect(log).toContain(process.execPath);

      await terminateLocalService(registryRecord!);
      expect(await readLocalServicePortOwner(service!.port!)).toBeNull();
      await expect(fetch(service!.url!)).rejects.toThrow();
      registryRecord = null;
    } finally {
      if (registryRecord) await terminateLocalService(registryRecord).catch(() => undefined);
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not wait for an unrelated process that takes over the service port", async () => {
    if (process.platform === "win32") return;
    const unrelatedListener = net.createServer();
    await new Promise<void>((resolve) => unrelatedListener.listen(0, "127.0.0.1", resolve));
    const address = unrelatedListener.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("Failed to allocate unrelated listener port");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    try {
      await terminateLocalService({
        pid: child.pid!,
        processGroupId: child.pid!,
        port,
      });
      expect(await readLocalServicePortOwner(port)).toBe(process.pid);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The target process group was already terminated.
      }
      await new Promise<void>((resolve, reject) => {
        unrelatedListener.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("recognizes a pnpm command after the launcher becomes pnpm.cjs", () => {
    expect(doesLocalServiceCommandLineMatch({
      commandLine: "/usr/bin/node /opt/pnpm/pnpm.cjs dev -- --bind custom --bind-host 127.0.0.1",
      recordedCommand: "pnpm dev -- --bind custom --bind-host 127.0.0.1",
      serviceName: "paperclip-dev",
    })).toBe(true);
  });

  it("does not compare shell expressions with the surviving process argv", () => {
    expect(isLocalServiceCommandLineComparable(
      "env | sort > /tmp/service.env; exec pnpm dev --bind loopback",
    )).toBe(false);
    expect(isLocalServiceCommandLineComparable(
      "node -e \"process.stdout.write('left | right')\"",
    )).toBe(true);
  });

  it("does not accept a different command merely because it uses node", () => {
    expect(doesLocalServiceCommandLineMatch({
      commandLine: "/usr/bin/node /workspace/server/dist/index.js",
      recordedCommand: "pnpm dev -- --bind custom --bind-host 127.0.0.1",
      serviceName: "paperclip-dev",
    })).toBe(false);
  });

  it("does not collapse different script paths to the same basename", () => {
    expect(doesLocalServiceCommandLineMatch({
      commandLine: "/usr/bin/node /other-workspace/server.js",
      recordedCommand: "node ./server.js",
      serviceName: "web",
    })).toBe(false);
  });

  // Turbo runs each task in a process group of its own, so a monorepo's dev server listens from
  // outside the group Paperclip launched. It is still that launch's descendant.
  it.skipIf(process.platform === "win32")("owns a listener a descendant runs in its own process group", async () => {
    const launcherScript = [
      "const { spawn } = require('node:child_process');",
      "const server = \"require('node:http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port); })\";",
      "const child = spawn(process.execPath, ['-e', server], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "process.on('SIGTERM', () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} process.exit(0); });",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const launcher = spawn(process.execPath, ["-e", launcherScript], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        launcher.stdout!.once("data", (chunk) => resolve(Number.parseInt(String(chunk).trim(), 10)));
        launcher.once("exit", () => reject(new Error("launcher exited before its listener started")));
      });
      const listenerPid = await readLocalServicePortOwner(port);
      expect(listenerPid).not.toBeNull();
      expect(listenerPid).not.toBe(launcher.pid);
      // The precondition this test is about: the listener left the launched process group.
      expect(await readLocalServiceProcessGroupId(listenerPid!)).not.toBe(launcher.pid);

      await expect(isLocalServiceProcessOwnedBy(listenerPid!, launcher.pid!)).resolves.toBe(true);
      await expect(isLocalServiceProcessOwnedBy(listenerPid!, unrelated.pid!)).resolves.toBe(false);
    } finally {
      for (const pid of [launcher.pid, unrelated.pid]) {
        try { process.kill(-pid!, "SIGTERM"); } catch { /* already gone */ }
      }
    }
  });
});
