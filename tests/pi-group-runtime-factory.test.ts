import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { initDatabase } from "../src/db";
import { resolveGroupSessionRef } from "../src/runtime/pi-group-runtime-factory";
import { ensurePiSessionDir, materializePiSessionRef } from "../src/providers/pi-session-ref";

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

      const resolved = resolveGroupSessionRef(
        db,
        "atlas",
        workingDirectory,
        {
          sessionRefOverride: explicitSession,
          persistResolvedRef: false,
        },
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
});
