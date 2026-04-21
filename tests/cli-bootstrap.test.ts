import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDatabase, registerGroup } from "../src/db";
import {
  __test__,
  createCliMessageSender,
  resolveInitialCliGroup,
  resolveInitialCliTarget,
} from "../src/cli";
import { GroupService } from "../src/group-service";
import { CliStateStore } from "../src/cli/state-store";
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

  test("resolveInitialCliGroup prefers explicit group, then state, then creates a new CLI group", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-bootstrap-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const first = groupService.createCliGroup({ name: "First" });
      const second = groupService.createCliGroup({ name: "Second" });

      stateStore.setCurrentGroupFolder(first.folder);
      expect(resolveInitialCliGroup(groupService, stateStore, second.folder).folder).toBe(second.folder);
      expect(resolveInitialCliGroup(groupService, stateStore).folder).toBe(first.folder);

      stateStore.clear();
      const created = resolveInitialCliGroup(groupService, stateStore);
      expect(created.channel_type).toBe("cli");
      expect(groupService.listCliGroups()).toHaveLength(3);
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
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const workspaceService = new WorkspaceService(db, { rootDir });
      const stateStore = new CliStateStore(join(rootDir, "cli-state.json"));
      const group = groupService.createCliGroup({ name: "CLI Root" });
      const workspace = workspaceService.getWorkspaceByFolder(group.folder);
      expect(workspace).not.toBeNull();
      if (!workspace) {
        throw new Error("workspace missing");
      }

      const firstChat = workspaceService.listChats(workspace.id)[0];
      expect(firstChat).not.toBeUndefined();
      if (!firstChat) {
        throw new Error("default chat missing");
      }

      const secondChat = workspaceService.createChat(workspace.id, {
        title: "Route B",
        requiresTrigger: false,
      });

      const explicit = resolveInitialCliTarget(
        groupService,
        workspaceService,
        stateStore,
        { chatId: secondChat.id },
      );
      expect(explicit.chat.id).toBe(secondChat.id);
      expect(explicit.workspace.id).toBe(workspace.id);

      stateStore.setCurrentChat(firstChat.id, workspace.folder);
      const fromState = resolveInitialCliTarget(
        groupService,
        workspaceService,
        stateStore,
      );
      expect(fromState.chat.id).toBe(firstChat.id);

      stateStore.clear();
      const fromWorkspace = resolveInitialCliTarget(
        groupService,
        workspaceService,
        stateStore,
        { workspace: workspace.folder },
      );
      expect(fromWorkspace.workspace.id).toBe(workspace.id);
      expect(fromWorkspace.chat.id).toBe(firstChat.id);
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
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const cliGroup = groupService.createCliGroup({ name: "CLI" });
      registerGroup(db, {
        jid: "oc_feishu_group",
        name: "Feishu",
        folder: "feishu_demo",
        channelType: "feishu",
        requiresTrigger: false,
        isMain: false,
        profileKey: "claude",
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
        group: cliGroup,
        workingDirectory: join(rootDir, "groups", cliGroup.folder),
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

      await expect(sender.send(cliGroup.jid, "hello")).rejects.toThrow(
        "send_message to CLI groups is unsupported",
      );

      await sender.send("oc_feishu_group", "hello feishu");
      expect(sentMessages).toEqual([{ jid: "oc_feishu_group", text: "hello feishu" }]);
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
