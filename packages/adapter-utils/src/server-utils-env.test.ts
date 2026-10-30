import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv, stripLauncherToolchainEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("drops the control plane's DATABASE_URL", () => {
    expect(sanitizeInheritedPaperclipEnv({
      DATABASE_URL: "postgres://paperclip:secret@localhost:5432/paperclip",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("stripLauncherToolchainEnv", () => {
  const launcherPath = [
    "/w/paperdev/server/node_modules/.bin",
    "/h/.local/share/mise/installs/pnpm/12.16.1/dist/node-gyp-bin",
    "/w/paperdev/node_modules/.bin",
    "/h/.local/share/mise/installs/pnpm/12.16.1",
    "/h/.local/share/mise/installs/node/24/bin",
    "/h/.local/bin",
    "/h/.local/share/mise/shims",
    "/usr/bin",
  ].join(":");

  it("drops the launcher's node_modules/.bin and mise installs, keeping the shims", () => {
    expect(stripLauncherToolchainEnv({ PATH: `/run/tools/bin:${launcherPath}` }, launcherPath)).toEqual({
      PATH: "/run/tools/bin:/h/.local/bin:/h/.local/share/mise/shims:/usr/bin",
    });
  });

  it("puts the mise shims where the first install entry was when the launcher had none", () => {
    const path = "/h/.local/share/mise/installs/node/24/bin:/usr/bin";
    expect(stripLauncherToolchainEnv({ PATH: path }, path)).toEqual({
      PATH: "/h/.local/share/mise/shims:/usr/bin",
    });
  });

  it("keeps entries that did not come from the launcher", () => {
    expect(stripLauncherToolchainEnv(
      { PATH: "/h/.local/share/mise/installs/java/21/bin:/usr/bin" },
      "/usr/bin",
    )).toEqual({ PATH: "/h/.local/share/mise/installs/java/21/bin:/usr/bin" });
  });

  it("drops the launcher's mise session and package-script variables", () => {
    expect(stripLauncherToolchainEnv({
      PATH: "/usr/bin",
      __MISE_DIFF: "x",
      __MISE_SESSION: "x",
      MISE_SHELL: "zsh",
      MISE_DATA_DIR: "/h/mise",
      npm_execpath: "/h/pnpm.cjs",
      npm_lifecycle_event: "dev",
      npm_package_json: "/w/paperdev/server/package.json",
      npm_config_user_agent: "pnpm/12.16.1",
      npm_config_registry: "https://registry.example.test/",
      PNPM_HOME: "/h/pnpm",
      PNPM_PACKAGE_NAME: "@paperclipai/server",
      PNPM_SCRIPT_SRC_DIR: "/w/paperdev/server",
      pnpm_config_verify_deps_before_run: "false",
    }, "/usr/bin")).toEqual({
      PATH: "/usr/bin",
      MISE_DATA_DIR: "/h/mise",
      npm_config_registry: "https://registry.example.test/",
      PNPM_HOME: "/h/pnpm",
    });
  });
});
