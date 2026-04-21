import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../src/db";
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
  test("does not migrate legacy groups into workspaces during database init", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-workspace-service-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);
      const dbPath = join(rootDir, "store", "messages.db");
      const db = initDatabase(dbPath);
      const registeredGroups = db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registered_groups'",
      ).get();
      const groupMemories = db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_memories'",
      ).get();

      expect(registeredGroups).toBeNull();
      expect(groupMemories).toBeNull();

      const service = new WorkspaceService(db, { rootDir });
      expect(service.listWorkspaces()).toHaveLength(0);

      db.close();
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

  test("creates Feishu chats with direct replies enabled by default", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-workspace-service-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const service = new WorkspaceService(db, { rootDir });

      const workspace = service.ensureFeishuWorkspace("cli_test_app", {
        profileKey: "claude",
      });
      const chat = service.ensureFeishuChat(workspace.id, "oc_feishu_demo");

      expect(chat.workspace_id).toBe(workspace.id);
      expect(chat.requires_trigger).toBe(0);
      expect(chat.title).toBe("Auto (oc_feishu_demo)");
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
