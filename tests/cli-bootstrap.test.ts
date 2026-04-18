import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, registerGroup } from "../src/db";
import { resolveInitialCliGroup, createCliMessageSender } from "../src/cli";
import { GroupService } from "../src/group-service";
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

describe("CLI bootstrap helpers", () => {
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
