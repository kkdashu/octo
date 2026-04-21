import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, registerGroup } from "../src/db";
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

describe("workspace service", () => {
  test("migrates a legacy group into a workspace with a default chat", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-workspace-service-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      registerGroup(db, {
        jid: "oc_feishu_demo",
        name: "Feishu Demo",
        folder: "feishu_demo",
        channelType: "feishu",
        requiresTrigger: true,
        isMain: true,
        profileKey: "claude",
      });

      const service = new WorkspaceService(db, { rootDir });
      const workspace = service.getWorkspaceByFolder("feishu_demo");
      expect(workspace).not.toBeNull();
      if (!workspace) {
        throw new Error("workspace missing");
      }

      const chats = service.listChats(workspace.id);
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({
        title: "Feishu Demo",
        active_branch: "main",
        requires_trigger: 1,
      });
      expect(chats[0]?.session_ref).toBeNull();
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("creates chats under a workspace and reuses the workspace default branch", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-workspace-service-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const service = new WorkspaceService(db, { rootDir });

      const workspace = service.createWorkspace({
        name: "Project Atlas",
        folder: "project_atlas",
        defaultBranch: "main",
      });
      const chat = service.createChat(workspace.id, {
        title: "Route B",
        requiresTrigger: false,
      });

      expect(chat.title).toBe("Route B");
      expect(chat.active_branch).toBe("main");
      expect(chat.requires_trigger).toBe(0);
      expect(chat.session_ref).not.toBeNull();
      expect(existsSync(join(rootDir, "workspaces", "project_atlas"))).toBe(true);
      expect(existsSync(join(rootDir, "workspaces", "project_atlas", ".pi", "sessions"))).toBe(true);
      expect(existsSync(chat.session_ref!)).toBe(true);
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
