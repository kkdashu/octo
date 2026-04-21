import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDatabase, updateWorkspace } from "../src/db";
import { resolvePersistedPiSessionRef } from "../src/providers/pi-session-ref";
import {
  ensureAgentProfilesPath,
  listAgentProfiles,
  resolveAgentProfile,
} from "../src/runtime/profile-config";
import {
  __test__ as minimaxMcpTestHelpers,
  resolveMiniMaxTokenPlanMcpConfig,
} from "../src/runtime/minimax-token-plan-mcp";
import { WorkspaceService } from "../src/workspace-service";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

function createTempProfilesConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "octo-runtime-test-"));
  const path = join(dir, "agent-profiles.json");
  writeFileSync(
    path,
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
          codex: {
            apiFormat: "openai",
            upstreamApi: "responses",
            baseUrl: "https://api.openai.com",
            apiKeyEnv: "OPENAI_API_KEY",
            model: "gpt-5.4",
            provider: "openai",
          },
          kimi: {
            apiFormat: "openai",
            upstreamApi: "chat_completions",
            baseUrl: "https://api.moonshot.cn/v1",
            apiKeyEnv: "MOONSHOT_API_KEY",
            model: "kimi-k2.5",
            provider: "moonshot",
          },
          "kimi-cli": {
            apiFormat: "openai",
            upstreamApi: "chat_completions",
            baseUrl: "https://api.kimi.com/coding/v1",
            apiKeyEnv: "MOONSHOT_API_KEY",
            model: "kimi-k2.5",
            codingPlanEnabled: true,
            provider: "moonshot",
          },
          minimax: {
            apiFormat: "anthropic",
            baseUrl: "https://api.minimaxi.com/anthropic",
            apiKeyEnv: "MINIMAX_API_KEY",
            model: "MiniMax-M2.7",
            provider: "minimax",
          },
        },
      },
      null,
      2,
    ),
  );

  return { dir, path };
}

function createRootProfilesConfig(rootDir: string, fileName = "agent-profiles.json"): string {
  const configDir = join(rootDir, "config");
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, fileName);
  writeFileSync(
    path,
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

  return path;
}

describe("profile-config", () => {
  let tempDir = "";

  beforeEach(() => {
    const temp = createTempProfilesConfig();
    tempDir = temp.dir;
    process.env.AGENT_PROFILES_PATH = temp.path;
    process.env.ANTHROPIC_API_KEY = "ant-key";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.MOONSHOT_API_KEY = "moonshot-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("resolves explicit profile", () => {
    const profile = resolveAgentProfile("codex");
    expect(profile.profileKey).toBe("codex");
    expect(profile.apiFormat).toBe("openai");
    expect(profile.upstreamApi).toBe("responses");
    expect(profile.apiKey).toBe("openai-key");
  });

  test("falls back to default profile when requested profile is missing", () => {
    const profile = resolveAgentProfile("missing");
    expect(profile.profileKey).toBe("claude");
    expect(profile.model).toBe("claude-sonnet-4-6");
  });

  test("throws when required api key env is missing", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => resolveAgentProfile("codex")).toThrow("OPENAI_API_KEY");
  });

  test("lists configured profiles", () => {
    const profiles = listAgentProfiles();
    expect(profiles.map((profile) => profile.profileKey)).toEqual([
      "claude",
      "codex",
      "kimi",
      "kimi-cli",
      "minimax",
    ]);
  });

  test("resolves moonshot profile to anthropic compatibility endpoint", () => {
    const profile = resolveAgentProfile("kimi");
    expect(profile.profileKey).toBe("kimi");
    expect(profile.apiFormat).toBe("anthropic");
    expect(profile.upstreamApi).toBeUndefined();
    expect(profile.baseUrl).toBe("https://api.moonshot.cn/anthropic");
    expect(profile.apiKey).toBe("moonshot-key");
  });

  test("resolves moonshot coding plan profile to direct anthropic endpoint", () => {
    const profile = resolveAgentProfile("kimi-cli");
    expect(profile.profileKey).toBe("kimi-cli");
    expect(profile.apiFormat).toBe("anthropic");
    expect(profile.upstreamApi).toBeUndefined();
    expect(profile.baseUrl).toBe("https://api.kimi.com/coding");
    expect(profile.codingPlanEnabled).toBe(true);
  });

  test("resolves minimax profile to anthropic compatibility endpoint", () => {
    const profile = resolveAgentProfile("minimax");
    expect(profile.profileKey).toBe("minimax");
    expect(profile.apiFormat).toBe("anthropic");
    expect(profile.upstreamApi).toBeUndefined();
    expect(profile.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(profile.apiKey).toBe("minimax-key");
    expect(profile.model).toBe("MiniMax-M2.7");
  });

  test("pins relative AGENT_PROFILES_PATH to rootDir before workspace cwd changes", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-runtime-root-config-"));

    try {
      const configPath = createRootProfilesConfig(rootDir);
      const workspaceDir = join(rootDir, "workspaces", "demo");
      mkdirSync(workspaceDir, { recursive: true });
      process.env.AGENT_PROFILES_PATH = "config/agent-profiles.json";

      ensureAgentProfilesPath(rootDir);
      process.chdir(workspaceDir);

      const profile = resolveAgentProfile("claude");
      expect(process.env.AGENT_PROFILES_PATH).toBe(resolve(configPath));
      expect(profile.profileKey).toBe("claude");
      expect(profile.model).toBe("claude-sonnet-4-6");
    } finally {
      process.chdir(originalCwd);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("falls back to the root example config when the primary config is missing", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-runtime-root-config-"));

    try {
      const examplePath = createRootProfilesConfig(rootDir, "agent-profiles.example.json");
      delete process.env.AGENT_PROFILES_PATH;

      const resolvedPath = ensureAgentProfilesPath(rootDir);
      const profile = resolveAgentProfile("claude");

      expect(resolvedPath).toBe(resolve(examplePath));
      expect(process.env.AGENT_PROFILES_PATH).toBe(resolve(examplePath));
      expect(profile.profileKey).toBe("claude");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("db session retention on profile switch", () => {
  test("updateWorkspace keeps existing chat session refs", () => {
    const db = initDatabase(":memory:");
    const workspaceService = new WorkspaceService(db);
    const workspace = workspaceService.createWorkspace({
      name: "Test",
      folder: "group-1",
      profileKey: "claude",
    });
    const chat = workspaceService.createChat(workspace.id, {
      title: "Test",
      requiresTrigger: false,
    });
    workspaceService.updateChat(chat.id, { sessionRef: "session-1" });
    updateWorkspace(db, workspace.id, { profileKey: "codex" });

    expect(workspaceService.getChatById(chat.id)?.session_ref).toBe("session-1");
  });
});

describe("pi session ref validation", () => {
  test("keeps persisted session ref when the local session file exists", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-runtime-pi-session-"));
    const workingDirectory = join(workspaceDir, "groups", "group-1");
    const relativeSessionRef = join(".pi", "sessions", "session-1.jsonl");

    try {
      mkdirSync(join(workingDirectory, ".pi", "sessions"), { recursive: true });
      writeFileSync(join(workingDirectory, relativeSessionRef), "");

      expect(
        resolvePersistedPiSessionRef(workingDirectory, relativeSessionRef),
      ).toBe(join(workingDirectory, relativeSessionRef));
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("drops persisted session ref when the local session file is missing", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-runtime-pi-session-"));
    const workingDirectory = join(workspaceDir, "groups", "group-1");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      expect(
        resolvePersistedPiSessionRef(
          workingDirectory,
          join(".pi", "sessions", "legacy-session.jsonl"),
        ),
      ).toBeUndefined();
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("minimax token plan mcp config", () => {
  test("uses default host and command when env overrides are absent", () => {
    const config = resolveMiniMaxTokenPlanMcpConfig({
      MINIMAX_API_KEY: "minimax-key",
    });

    expect(config).toEqual({
      apiKey: "minimax-key",
      apiHost: minimaxMcpTestHelpers.DEFAULT_MINIMAX_API_HOST,
      command: minimaxMcpTestHelpers.DEFAULT_MINIMAX_MCP_COMMAND,
      args: [...minimaxMcpTestHelpers.DEFAULT_MINIMAX_MCP_ARGS],
    });
  });

  test("supports explicit host and uvx command overrides", () => {
    const config = resolveMiniMaxTokenPlanMcpConfig({
      MINIMAX_API_KEY: "minimax-key",
      MINIMAX_API_HOST: "https://api.internal.minimax.example",
      MINIMAX_MCP_COMMAND: "/opt/homebrew/bin/uvx",
    });

    expect(config).toEqual({
      apiKey: "minimax-key",
      apiHost: "https://api.internal.minimax.example",
      command: "/opt/homebrew/bin/uvx",
      args: [...minimaxMcpTestHelpers.DEFAULT_MINIMAX_MCP_ARGS],
    });
  });

  test("extracts text blocks from MiniMax tool output", () => {
    const text = minimaxMcpTestHelpers.extractToolTextContent([
      { type: "text", text: "客观描述: 白猫" },
      { type: "resource", resource: { text: "OCR文本: 无" } },
      { type: "image" },
    ]);

    expect(text).toBe("客观描述: 白猫\nOCR文本: 无");
  });

  test("builds understand_image tool args with image_source", () => {
    const args = minimaxMcpTestHelpers.buildUnderstandImageToolArguments({
      prompt: "describe this image",
      imagePath: "/tmp/cat.png",
    });

    expect(args).toEqual({
      prompt: "describe this image",
      image_source: "/tmp/cat.png",
    });
  });
});
