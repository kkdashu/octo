import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type AgentSessionRuntime,
} from "@mariozechner/pi-coding-agent";
import { initDatabase } from "../src/db";
import { GroupService } from "../src/group-service";
import { OctoCliRuntimeHost } from "../src/cli/octo-cli-runtime-host";
import { CliStateStore } from "../src/cli/state-store";
import { GroupRuntimeManager } from "../src/kernel/group-runtime-manager";
import type { MessageSender } from "../src/tools";
import { WorkspaceService } from "../src/workspace-service";

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
    importFromJsonl: Array<{ inputPath: string; cwdOverride?: string }>;
  };
} {
  const sessionManager = SessionManager.inMemory(initialCwd);
  let sessionFile = initialSessionPath;
  const session = {
    sessionManager,
    get sessionFile() {
      return sessionFile;
    },
    set sessionFile(next: string | undefined) {
      sessionFile = next ?? sessionFile;
    },
    get isStreaming() {
      return false;
    },
    async prompt() {},
    async followUp() {},
    async steer() {},
    async abort() {},
    subscribe() {
      return () => undefined;
    },
  };
  const services = { cwd: initialCwd, agentDir: join(initialCwd, ".pi", "agent") };
  const runtimeState = {
    cwd: initialCwd,
  };
  const calls = {
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

function createNoopMessageSender(): MessageSender {
  return {
    send: async () => undefined,
    sendImage: async () => undefined,
    refreshGroupMetadata: async () => ({ count: 0 }),
  };
}

describe("OctoCliRuntimeHost", () => {
  test("switchGroup updates current group, session ref, and state store", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-runtime-host-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const workspaceService = new WorkspaceService(db, { rootDir });
      const firstGroup = groupService.createCliGroup({ name: "First" });
      const secondGroup = groupService.createCliGroup({ name: "Second" });
      const firstWorkspace = workspaceService.getWorkspaceByFolder(firstGroup.folder);
      const secondWorkspace = workspaceService.getWorkspaceByFolder(secondGroup.folder);
      if (!firstWorkspace || !secondWorkspace) {
        throw new Error("workspace missing");
      }
      const firstChat = workspaceService.listChats(firstWorkspace.id)[0];
      const secondChat = workspaceService.listChats(secondWorkspace.id)[0];
      if (!firstChat || !secondChat) {
        throw new Error("chat missing");
      }
      const firstCwd = join(rootDir, "groups", firstGroup.folder);
      const secondCwd = join(rootDir, "groups", secondGroup.folder);
      const firstSessionPath = createSessionFile(firstCwd, "first");
      const secondSessionPath = createSessionFile(secondCwd, "second");
      workspaceService.updateChat(secondChat.id, { sessionRef: secondSessionPath });
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const first = createFakeRuntime(firstSessionPath, firstCwd);
      const second = createFakeRuntime(secondSessionPath, secondCwd);
      const manager = new GroupRuntimeManager({
        db,
        workspaceService,
        rootDir,
        createMessageSender: () => createNoopMessageSender(),
        createGroupRuntime: async (groupFolder) => {
          if (groupFolder === firstGroup.folder) {
            return {
              group: firstGroup,
              runtime: first.runtime,
              sessionRef: firstSessionPath,
            };
          }

          if (groupFolder === secondGroup.folder) {
            return {
              group: secondGroup,
              runtime: second.runtime,
              sessionRef: secondSessionPath,
            };
          }

          throw new Error(`Unexpected test group: ${groupFolder}`);
        },
      });
      const host = new OctoCliRuntimeHost({
        manager,
        stateStore,
        currentWorkspace: firstWorkspace,
        currentChat: firstChat,
        currentGroup: firstGroup,
        runtime: first.runtime,
      });

      await host.switchGroup(secondGroup);

      expect(host.getCurrentGroup().folder).toBe(secondGroup.folder);
      expect(host.getCurrentWorkspace().folder).toBe(secondGroup.folder);
      expect(host.getCurrentChat().id).toBe(secondChat.id);
      expect(host.session.sessionFile).toBe(secondSessionPath);
      expect(workspaceService.getChatById(secondChat.id)?.session_ref).toBe(secondSessionPath);
      expect(stateStore.getCurrentGroupFolder()).toBe(secondGroup.folder);
      expect(stateStore.getCurrentWorkspaceFolder()).toBe(secondGroup.folder);
      expect(stateStore.getCurrentChatId()).toBe(secondChat.id);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("switchChat notifies external switch handler after applying runtime", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-runtime-host-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const workspaceService = new WorkspaceService(db, { rootDir });
      const group = groupService.createCliGroup({ name: "Current" });
      const workspace = workspaceService.getWorkspaceByFolder(group.folder);
      if (!workspace) {
        throw new Error("workspace missing");
      }
      const [firstChat] = workspaceService.listChats(workspace.id);
      if (!firstChat) {
        throw new Error("default chat missing");
      }
      const secondChat = workspaceService.createChat(workspace.id, {
        title: "Route B",
        requiresTrigger: false,
      });
      const cwd = join(rootDir, "groups", group.folder);
      const firstSessionPath = createSessionFile(cwd, "first");
      const secondSessionPath = createSessionFile(cwd, "second");
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const first = createFakeRuntime(firstSessionPath, cwd);
      const second = createFakeRuntime(secondSessionPath, cwd);
      const manager = new GroupRuntimeManager({
        db,
        workspaceService,
        rootDir,
        createMessageSender: () => createNoopMessageSender(),
        createChatRuntime: async (chatId) => {
          if (chatId === firstChat.id) {
            return {
              workspace,
              chat: firstChat,
              runtime: first.runtime,
              sessionRef: firstSessionPath,
            };
          }

          if (chatId === secondChat.id) {
            return {
              workspace,
              chat: secondChat,
              runtime: second.runtime,
              sessionRef: secondSessionPath,
            };
          }

          throw new Error(`Unexpected test chat: ${chatId}`);
        },
      });
      const host = new OctoCliRuntimeHost({
        manager,
        stateStore,
        currentWorkspace: workspace,
        currentChat: firstChat,
        currentGroup: group,
        runtime: first.runtime,
      });
      const events: Array<{
        kind: string;
        chatId: string;
        sessionRef: string | undefined;
      }> = [];
      host.setExternalSwitchHandler((event) => {
        events.push({
          kind: event.kind,
          chatId: event.chat.id,
          sessionRef: event.runtime.session.sessionFile,
        });
      });

      await host.switchChat(secondChat);

      expect(host.getCurrentChat().id).toBe(secondChat.id);
      expect(events).toEqual([
        {
          kind: "chat",
          chatId: secondChat.id,
          sessionRef: secondSessionPath,
        },
      ]);
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
      const workspaceService = new WorkspaceService(db, { rootDir });
      const group = groupService.createCliGroup({ name: "Import" });
      const workspace = workspaceService.getWorkspaceByFolder(group.folder);
      if (!workspace) {
        throw new Error("workspace missing");
      }
      const chat = workspaceService.listChats(workspace.id)[0];
      if (!chat) {
        throw new Error("chat missing");
      }
      const cwd = join(rootDir, "groups", group.folder);
      const sessionPath = createSessionFile(cwd, "base");
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const current = createFakeRuntime(sessionPath, cwd);
      const manager = new GroupRuntimeManager({
        db,
        workspaceService,
        rootDir,
        createMessageSender: () => createNoopMessageSender(),
        createGroupRuntime: async (groupFolder) => {
          if (groupFolder !== group.folder) {
            throw new Error(`Unexpected test group: ${groupFolder}`);
          }

          return {
            group,
            runtime: current.runtime,
            sessionRef: sessionPath,
          };
        },
      });
      const host = new OctoCliRuntimeHost({
        manager,
        stateStore,
        currentWorkspace: workspace,
        currentChat: chat,
        currentGroup: group,
        runtime: current.runtime,
      });

      await host.importFromJsonl("/tmp/source.jsonl", "/tmp/should-be-ignored");

      expect(current.calls.importFromJsonl).toEqual([
        {
          inputPath: "/tmp/source.jsonl",
          cwdOverride: cwd,
        },
      ]);
      expect(workspaceService.getChatById(chat.id)?.session_ref).toBe(
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
