import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { getSessionRef, initDatabase, saveSessionRef } from "../src/db";
import { GroupService } from "../src/group-service";
import { OctoCliRuntimeHost } from "../src/cli/octo-cli-runtime-host";
import { CliStateStore } from "../src/cli/state-store";

function createProfilesConfig(rootDir: string): string {
  const configPath = join(rootDir, "agent-profiles.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        defaultProfile: "claude",
        profiles: {
          claude: {
            apiFormat: "anthropic",
            baseUrl: "https://api.anthropic.com",
            apiKeyEnv: "ANTHROPIC_API_KEY",
            model: "claude-sonnet-4-6",
          },
        },
      },
      null,
      2,
    ),
  );
  return configPath;
}

function createSessionFile(cwd: string, sessionId: string): string {
  const sessionDir = join(cwd, ".pi", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date("2026-04-18T09:00:00.000Z").toISOString(),
      cwd,
    })}\n`,
  );
  return sessionPath;
}

function createFakeRuntime(initialSessionPath: string, initialCwd: string): {
  runtime: AgentSessionRuntime;
  calls: {
    switchSession: Array<{ sessionPath: string; cwdOverride?: string }>;
    importFromJsonl: Array<{ inputPath: string; cwdOverride?: string }>;
  };
} {
  const session = { sessionFile: initialSessionPath, extensionRunner: undefined, dispose() {} };
  const services = { cwd: initialCwd, agentDir: join(initialCwd, ".pi", "agent") };
  const runtimeState = {
    cwd: initialCwd,
  };
  const calls = {
    switchSession: [] as Array<{ sessionPath: string; cwdOverride?: string }>,
    importFromJsonl: [] as Array<{ inputPath: string; cwdOverride?: string }>,
  };
  const runtime = {
    session,
    services,
    cwd: runtimeState.cwd,
    diagnostics: [],
    modelFallbackMessage: undefined,
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    switchSession: async (sessionPath: string, cwdOverride?: string) => {
      calls.switchSession.push({ sessionPath, cwdOverride });
      session.sessionFile = sessionPath;
      const nextCwd = cwdOverride ?? runtimeState.cwd;
      services.cwd = nextCwd;
      runtimeState.cwd = nextCwd;
      runtime.cwd = nextCwd;
      return { cancelled: false };
    },
    importFromJsonl: async (inputPath: string, cwdOverride?: string) => {
      calls.importFromJsonl.push({ inputPath, cwdOverride });
      const nextCwd = cwdOverride ?? runtimeState.cwd;
      session.sessionFile = createSessionFile(nextCwd, "imported");
      services.cwd = nextCwd;
      runtimeState.cwd = nextCwd;
      runtime.cwd = nextCwd;
      return { cancelled: false };
    },
    dispose: async () => {},
  };

  return {
    runtime: runtime as unknown as AgentSessionRuntime,
    calls,
  };
}

describe("OctoCliRuntimeHost", () => {
  test("rejects switchSession outside Octo registered groups", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-runtime-host-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const currentGroup = groupService.createCliGroup({ name: "Current" });
      const currentCwd = join(rootDir, "groups", currentGroup.folder);
      const currentSessionPath = createSessionFile(currentCwd, "current");
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const { runtime } = createFakeRuntime(currentSessionPath, currentCwd);
      const host = new OctoCliRuntimeHost(runtime, {
        db,
        groupService,
        stateStore,
        currentGroup,
        rootDir,
      });

      const outsideCwd = join(rootDir, "outside");
      mkdirSync(outsideCwd, { recursive: true });
      const outsideSessionPath = createSessionFile(outsideCwd, "outside");

      await expect(host.switchSession(outsideSessionPath)).rejects.toThrow(
        "Session is outside Octo registered groups",
      );
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("switchGroup updates current group, session ref, and state store", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-runtime-host-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const firstGroup = groupService.createCliGroup({ name: "First" });
      const secondGroup = groupService.createCliGroup({ name: "Second" });
      const firstCwd = join(rootDir, "groups", firstGroup.folder);
      const secondCwd = join(rootDir, "groups", secondGroup.folder);
      const firstSessionPath = createSessionFile(firstCwd, "first");
      const secondSessionPath = createSessionFile(secondCwd, "second");
      saveSessionRef(db, secondGroup.folder, secondSessionPath);
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const { runtime, calls } = createFakeRuntime(firstSessionPath, firstCwd);
      const host = new OctoCliRuntimeHost(runtime, {
        db,
        groupService,
        stateStore,
        currentGroup: firstGroup,
        rootDir,
      });

      await host.switchGroup(secondGroup);

      expect(host.getCurrentGroup().folder).toBe(secondGroup.folder);
      expect(calls.switchSession).toEqual([
        {
          sessionPath: secondSessionPath,
          cwdOverride: secondCwd,
        },
      ]);
      expect(getSessionRef(db, secondGroup.folder)).toBe(secondSessionPath);
      expect(stateStore.getCurrentGroupFolder()).toBe(secondGroup.folder);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("importFromJsonl stays inside the current group cwd", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-runtime-host-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const group = groupService.createCliGroup({ name: "Import" });
      const cwd = join(rootDir, "groups", group.folder);
      const sessionPath = createSessionFile(cwd, "base");
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const { runtime, calls } = createFakeRuntime(sessionPath, cwd);
      const host = new OctoCliRuntimeHost(runtime, {
        db,
        groupService,
        stateStore,
        currentGroup: group,
        rootDir,
      });

      await host.importFromJsonl("/tmp/source.jsonl", "/tmp/should-be-ignored");

      expect(calls.importFromJsonl).toEqual([
        {
          inputPath: "/tmp/source.jsonl",
          cwdOverride: cwd,
        },
      ]);
      expect(getSessionRef(db, group.folder)).toBe(
        join(cwd, ".pi", "sessions", "imported.jsonl"),
      );
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
