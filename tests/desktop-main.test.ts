import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDatabase, registerGroup } from "../src/db";
import {
  resolveDesktopSidecarOptionsFromEnv,
  startDesktopSidecar,
} from "../src/desktop/main";
import { DESKTOP_HOSTNAME } from "../src/desktop/server";

function createWorkspace() {
  const dir = join(tmpdir(), `octo-desktop-main-${crypto.randomUUID()}`);
  mkdirSync(join(dir, "store"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });

  const configPath = join(dir, "config", "agent-profiles.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "claude",
      profiles: {
        claude: {
          apiFormat: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          model: "claude-sonnet-4-6",
        },
      },
    }),
    "utf-8",
  );

  const db = initDatabase(join(dir, "store", "messages.db"));
  registerGroup(db, {
    jid: "cli:test-group",
    name: "Desktop Group",
    folder: "desktop-group",
    channelType: "cli",
    requiresTrigger: false,
    isMain: false,
    profileKey: "claude",
  });
  db.close(false);

  return { dir, configPath };
}

const cleanupDirs: string[] = [];
const previousEnv = {
  AGENT_PROFILES_PATH: process.env.AGENT_PROFILES_PATH,
  OCTO_ROOT_DIR: process.env.OCTO_ROOT_DIR,
  OCTO_DB_PATH: process.env.OCTO_DB_PATH,
  DESKTOP_HOSTNAME: process.env.DESKTOP_HOSTNAME,
  DESKTOP_PORT: process.env.DESKTOP_PORT,
};

afterEach(() => {
  process.env.AGENT_PROFILES_PATH = previousEnv.AGENT_PROFILES_PATH;
  process.env.OCTO_ROOT_DIR = previousEnv.OCTO_ROOT_DIR;
  process.env.OCTO_DB_PATH = previousEnv.OCTO_DB_PATH;
  process.env.DESKTOP_HOSTNAME = previousEnv.DESKTOP_HOSTNAME;
  process.env.DESKTOP_PORT = previousEnv.DESKTOP_PORT;

  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("desktop sidecar bootstrap", () => {
  test("defaults AGENT_PROFILES_PATH to root config when unset", async () => {
    const { dir } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = "";

    const originalServe = Bun.serve;
    const bunObject = Bun as unknown as {
      serve: typeof Bun.serve;
    };

    bunObject.serve = ((options: Parameters<typeof Bun.serve>[0]) => ({
      url: new URL(`http://${options.hostname}:${options.port}`),
      stop() {},
    }) as ReturnType<typeof Bun.serve>) as typeof Bun.serve;

    try {
      const handle = await startDesktopSidecar({
        rootDir: dir,
        port: 4319,
      });

      expect(process.env.AGENT_PROFILES_PATH).toBe(join(
        dir,
        "config",
        "agent-profiles.json",
      ));

      await handle.stop();
    } finally {
      bunObject.serve = originalServe;
    }
  });

  test("falls back to root config when AGENT_PROFILES_PATH points to a missing file", async () => {
    const { dir } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = join(
      dir,
      "groups",
      "main",
      "config",
      "agent-profiles.json",
    );

    const originalServe = Bun.serve;
    const bunObject = Bun as unknown as {
      serve: typeof Bun.serve;
    };

    bunObject.serve = ((options: Parameters<typeof Bun.serve>[0]) => ({
      url: new URL(`http://${options.hostname}:${options.port}`),
      stop() {},
    }) as ReturnType<typeof Bun.serve>) as typeof Bun.serve;

    try {
      const handle = await startDesktopSidecar({
        rootDir: dir,
        port: 4319,
      });

      expect(process.env.AGENT_PROFILES_PATH).toBe(join(
        dir,
        "config",
        "agent-profiles.json",
      ));

      await handle.stop();
    } finally {
      bunObject.serve = originalServe;
    }
  });

  test("normalizes relative AGENT_PROFILES_PATH to an absolute path", async () => {
    const { dir } = createWorkspace();
    cleanupDirs.push(dir);
    const previousCwd = process.cwd();
    process.chdir(dir);
    process.env.AGENT_PROFILES_PATH = "config/agent-profiles.json";
    const expectedProfilesPath = resolve("config/agent-profiles.json");

    const originalServe = Bun.serve;
    const bunObject = Bun as unknown as {
      serve: typeof Bun.serve;
    };

    bunObject.serve = ((options: Parameters<typeof Bun.serve>[0]) => ({
      url: new URL(`http://${options.hostname}:${options.port}`),
      stop() {},
    }) as ReturnType<typeof Bun.serve>) as typeof Bun.serve;

    try {
      const handle = await startDesktopSidecar({
        rootDir: dir,
        port: 4319,
      });

      expect(process.env.AGENT_PROFILES_PATH).toBe(expectedProfilesPath);

      await handle.stop();
    } finally {
      process.chdir(previousCwd);
      bunObject.serve = originalServe;
    }
  });

  test("resolves startup options from environment", () => {
    process.env.OCTO_ROOT_DIR = "/tmp/octo-root";
    process.env.OCTO_DB_PATH = "custom/messages.db";
    process.env.DESKTOP_HOSTNAME = "127.0.0.2";
    process.env.DESKTOP_PORT = "4512";

    expect(resolveDesktopSidecarOptionsFromEnv()).toEqual({
      rootDir: "/tmp/octo-root",
      dbPath: "custom/messages.db",
      hostname: "127.0.0.2",
      port: 4512,
    });
  });

  test("starts desktop sidecar on localhost by default and ensures group workspaces", async () => {
    const { dir, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const originalServe = Bun.serve;
    let capturedHostname: string | undefined;
    let capturedPort: number | undefined;
    let stopCalled = false;

    const bunObject = Bun as unknown as {
      serve: typeof Bun.serve;
    };

    bunObject.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
      capturedHostname = options.hostname;
      capturedPort = typeof options.port === "number" ? options.port : undefined;
      return {
        url: new URL(`http://${options.hostname}:${options.port}`),
        stop(closeActiveConnections?: boolean) {
          stopCalled = closeActiveConnections ?? false;
        },
      } as ReturnType<typeof Bun.serve>;
    }) as typeof Bun.serve;

    try {
      const handle = await startDesktopSidecar({
        rootDir: dir,
        port: 4319,
      });

      expect(capturedHostname).toBe(DESKTOP_HOSTNAME);
      expect(capturedPort).toBe(4319);
      expect(handle.server.url.hostname).toBe(DESKTOP_HOSTNAME);
      expect(handle.groupService.listGroups().map((group) => group.folder)).toEqual([
        "desktop-group",
      ]);

      const workspacePath = join(dir, "groups", "desktop-group");
      expect(existsSync(workspacePath)).toBe(true);

      await handle.stop();
      expect(stopCalled).toBe(true);
    } finally {
      bunObject.serve = originalServe;
    }
  });
});
