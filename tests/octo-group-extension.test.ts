import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "../pi-mono/packages/coding-agent/src/index.ts";
import { initDatabase } from "../src/db";
import { GroupService } from "../src/group-service";
import { createOctoGroupExtension } from "../src/cli/octo-group-extension";

type RegisteredCommandMap = Map<
  string,
  {
    description?: string;
    handler: (args: string, ctx: CommandContext) => Promise<void>;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
  }
>;

type CommandContext = {
  waitForIdle(): Promise<void>;
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
};

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

function registerExtension(factory: ExtensionFactory): RegisteredCommandMap {
  const commands: RegisteredCommandMap = new Map();

  factory({
    registerCommand(name, options) {
      commands.set(name, options as RegisteredCommandMap extends Map<string, infer T> ? T : never);
    },
  } as unknown as Parameters<ExtensionFactory>[0]);

  return commands;
}

describe("octo group extension", () => {
  test("new-group creates and switches to a new CLI group", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-group-extension-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const currentGroup = groupService.createCliGroup({ name: "Current" });
      let switchedFolder: string | null = null;
      const runtimeHost = {
        getCurrentGroup: () => currentGroup,
        switchGroup: async (group: { folder: string }) => {
          switchedFolder = group.folder;
          return { cancelled: false };
        },
      };
      const commands = registerExtension(createOctoGroupExtension({
        groupService,
        getRuntimeHost: () => runtimeHost as never,
      }));
      const notices: string[] = [];
      const command = commands.get("new-group");
      if (!command) {
        throw new Error("new-group command was not registered");
      }

      await command.handler("Sprint planning", {
        waitForIdle: async () => {},
        ui: {
          input: async () => undefined,
          select: async () => undefined,
          notify: (message) => notices.push(message),
        },
      });

      expect(groupService.listCliGroups()).toHaveLength(2);
      const created = groupService.listCliGroups().find((group) => group.name === "Sprint planning");
      expect(created).not.toBeUndefined();
      expect(switchedFolder).toBe(created?.folder);
      expect(notices[0]).toContain(created?.folder ?? "");
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("rename-group renames the current group", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-group-extension-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      const currentGroup = groupService.createCliGroup({ name: "Before" });
      const commands = registerExtension(createOctoGroupExtension({
        groupService,
        getRuntimeHost: () => ({
          getCurrentGroup: () => currentGroup,
        }) as never,
      }));
      const command = commands.get("rename-group");
      if (!command) {
        throw new Error("rename-group command was not registered");
      }

      await command.handler("", {
        waitForIdle: async () => {},
        ui: {
          input: async () => "After",
          select: async () => undefined,
          notify: () => {},
        },
      });

      expect(groupService.getGroupByFolder(currentGroup.folder)?.name).toBe("After");
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("switch-group exposes completions for CLI groups", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-group-extension-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      const configPath = createProfilesConfig(rootDir);
      process.env.AGENT_PROFILES_PATH = configPath;
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const groupService = new GroupService(db, { rootDir });
      groupService.createCliGroup({ name: "Alpha" });
      const beta = groupService.createCliGroup({ name: "Beta" });
      const commands = registerExtension(createOctoGroupExtension({
        groupService,
        getRuntimeHost: () => null,
      }));
      const command = commands.get("switch-group");
      if (!command?.getArgumentCompletions) {
        throw new Error("switch-group completions were not registered");
      }

      expect(command.getArgumentCompletions(beta.folder.slice(0, 6))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: beta.folder,
          }),
        ]),
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
