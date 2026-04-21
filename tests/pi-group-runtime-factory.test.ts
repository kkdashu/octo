import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { initDatabase } from "../src/db";
import {
  getWorkspaceForWorkingDirectory,
  resolveWorkspaceSessionRef,
} from "../src/runtime/pi-group-runtime-factory";
import { ensurePiSessionDir, materializePiSessionRef } from "../src/providers/pi-session-ref";
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

describe("pi group runtime factory", () => {
  test("explicit missing chat session ref does not fall back to recent session", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-pi-runtime-factory-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workingDirectory = join(rootDir, "workspaces", "atlas");
      const sessionDir = ensurePiSessionDir(workingDirectory);
      const recentSession = materializePiSessionRef(
        SessionManager.create(workingDirectory, sessionDir),
      );
      const explicitSession = join(sessionDir, "chat-2.jsonl");

      const resolved = resolveWorkspaceSessionRef(
        workingDirectory,
        explicitSession,
      );

      expect(recentSession).not.toBe(explicitSession);
      expect(resolved).toBe(explicitSession);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("resolves workspace context from the workspace working directory", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-pi-runtime-factory-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.ensureFeishuWorkspace("cli_test_app", {
        profileKey: "claude",
      });

      const resolved = getWorkspaceForWorkingDirectory(
        db,
        join(rootDir, "workspaces", workspace.folder),
        rootDir,
      );

      expect(resolved).not.toBeNull();
      expect(resolved).toMatchObject({
        folder: workspace.folder,
        name: workspace.name,
        profile_key: "claude",
      });
      expect(resolved?.id).toBe(workspace.id);
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
