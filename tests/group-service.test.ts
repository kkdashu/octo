import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, registerGroup } from "../src/db";
import { buildCliGroupJid, GroupService } from "../src/group-service";

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

describe("group service", () => {
  test("creates CLI groups with cli jid and workspace", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-group-service-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;

      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const service = new GroupService(db, {
        rootDir,
        now: () => new Date("2026-04-18T16:45:30.000Z"),
      });

      const group = service.createCliGroup({ name: "Refactor runtime" });

      expect(group.channel_type).toBe("cli");
      expect(group.jid).toBe(buildCliGroupJid(group.folder));
      expect(group.name).toBe("Refactor runtime");
      expect(group.folder).toMatch(/^cli_\d{8}_\d{6}_[0-9a-f]{6}$/);
      expect(existsSync(join(rootDir, "groups", group.folder))).toBe(true);
      expect(existsSync(join(rootDir, "groups", group.folder, "AGENTS.md"))).toBe(false);
      expect(group.is_main).toBe(1);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("does not mark later CLI groups as main when a main group already exists", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-group-service-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;

      const db = initDatabase(join(rootDir, "store", "messages.db"));
      registerGroup(db, {
        jid: "oc_main",
        name: "Main",
        folder: "main",
        channelType: "feishu",
        requiresTrigger: false,
        isMain: true,
        profileKey: "claude",
      });

      const service = new GroupService(db, { rootDir });
      const group = service.createCliGroup({ name: "CLI 2" });

      expect(group.is_main).toBe(0);
      expect(service.listCliGroups()).toHaveLength(1);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("renames groups", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-group-service-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;

      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const service = new GroupService(db, { rootDir });
      const created = service.createCliGroup({ name: "Before" });
      const renamed = service.renameGroup(created.folder, "After");

      expect(renamed.name).toBe("After");
      expect(renamed.folder).toBe(created.folder);
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
