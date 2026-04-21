import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  __test__,
  createCliMessageSender,
  resolveInitialCliTarget,
} from "../src/cli";
import { initDatabase } from "../src/db";
import { CliStateStore } from "../src/cli/state-store";
import { buildCliChatBindingId, WorkspaceService } from "../src/workspace-service";

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

function createRootProfilesConfig(rootDir: string): string {
  const configDir = join(rootDir, "config");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "agent-profiles.json");
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

describe("CLI bootstrap helpers", () => {
  test("ensureCliAgentProfilesPath pins relative config paths to the startup root", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-bootstrap-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const expectedPath = createRootProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = "config/agent-profiles.json";

      __test__.ensureCliAgentProfilesPath(rootDir);

      expect(process.env.AGENT_PROFILES_PATH).toBe(resolve(expectedPath));
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("ensureCliAgentProfilesPath falls back to the root config when unset", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-bootstrap-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const expectedPath = createRootProfilesConfig(rootDir);
      delete process.env.AGENT_PROFILES_PATH;

      __test__.ensureCliAgentProfilesPath(rootDir);

      expect(process.env.AGENT_PROFILES_PATH).toBe(resolve(expectedPath));
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("resolveInitialCliTarget creates a new CLI workspace when there is no explicit target or saved state", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-bootstrap-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const stateStore = new CliStateStore(join(rootDir, "store", "cli-state.json"));

      const resolved = resolveInitialCliTarget(workspaceService, stateStore);

      expect(resolved.workspace.folder).toMatch(/^cli_/);
      expect(resolved.chat.workspace_id).toBe(resolved.workspace.id);
      expect(workspaceService.listWorkspaces()).toHaveLength(1);
      db.close(false);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("resolveInitialCliTarget prefers explicit chat, then stored chat, then workspace fallback", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-bootstrap-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const stateStore = new CliStateStore(join(rootDir, "store", "cli-state.json"));
      const created = workspaceService.createCliWorkspace({ name: "CLI Root" });
      const workspace = created.workspace;
      const firstChat = created.chat;
      const secondChat = workspaceService.createChat(workspace.id, {
        title: "Route B",
        requiresTrigger: false,
      });

      const explicit = resolveInitialCliTarget(
        workspaceService,
        stateStore,
        { chatId: secondChat.id },
      );
      expect(explicit.chat.id).toBe(secondChat.id);
      expect(explicit.workspace.id).toBe(workspace.id);

      stateStore.setCurrentChat(firstChat.id, workspace.folder);
      const fromState = resolveInitialCliTarget(
        workspaceService,
        stateStore,
      );
      expect(fromState.chat.id).toBe(firstChat.id);

      stateStore.clear();
      const fromWorkspace = resolveInitialCliTarget(
        workspaceService,
        stateStore,
        { workspace: workspace.folder },
      );
      expect(fromWorkspace.workspace.id).toBe(workspace.id);
      expect(fromWorkspace.chat.id).toBe(firstChat.id);
      db.close(false);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("CLI message sender rejects CLI targets and delegates Feishu targets", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-bootstrap-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const cliWorkspace = workspaceService.createCliWorkspace({ name: "CLI" });
      const feishuWorkspace = workspaceService.createWorkspace({
        name: "Feishu",
        folder: "feishu_demo",
        profileKey: "claude",
      });
      workspaceService.createChat(feishuWorkspace.id, {
        title: "Feishu",
        requiresTrigger: false,
        externalBinding: {
          platform: "feishu",
          externalChatId: "oc_feishu_group",
        },
      });

      const sentMessages: Array<{ jid: string; text: string }> = [];
      const senderFactory = createCliMessageSender(db, {
        send: async (jid: string, text: string) => {
          sentMessages.push({ jid, text });
        },
        sendImage: async () => {},
        refreshGroupMetadata: async () => [],
      } as never);

      const sender = senderFactory({
        workspace: cliWorkspace.workspace,
        chat: cliWorkspace.chat,
        workingDirectory: join(rootDir, "workspaces", cliWorkspace.workspace.folder),
        profile: {
          profileKey: "claude",
          apiFormat: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          apiKey: "test-key",
          model: "claude-sonnet-4-6",
          codingPlanEnabled: false,
        },
      });

      await expect(
        sender.send(buildCliChatBindingId(cliWorkspace.workspace.folder), "hello"),
      ).rejects.toThrow("send_message to CLI chats is unsupported");

      await sender.send("oc_feishu_group", "hello feishu");
      expect(sentMessages).toEqual([{ jid: "oc_feishu_group", text: "hello feishu" }]);
      db.close(false);
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
