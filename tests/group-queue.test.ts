import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelManager } from "../src/channels/manager";
import {
  getSessionRef,
  initDatabase,
  registerGroup,
  saveSessionRef,
} from "../src/db";
import {
  GroupQueue,
  __test__ as groupQueueTestHelpers,
} from "../src/group-queue";
import type {
  AgentRuntime,
  ConversationMessageInput,
  OpenConversationInput,
  ResetSessionInput,
} from "../src/providers/types";
import { __test__ as externalMcpConfigTestHelpers } from "../src/runtime/external-mcp-config";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

function createQueueWorkspace(tempDir: string) {
  mkdirSync(join(tempDir, "store"), { recursive: true });
  mkdirSync(join(tempDir, "groups", "main"), { recursive: true });

  const configPath = join(tempDir, "agent-profiles.json");
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

  const db = initDatabase(join(tempDir, "store", "messages.db"));
  registerGroup(db, {
    jid: "oc_main",
    name: "Main Group",
    folder: "main",
    channelType: "feishu",
    requiresTrigger: false,
    isMain: true,
    profileKey: "claude",
  });

  process.env.AGENT_PROFILES_PATH = configPath;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

  return { db };
}

function createFakeChannelManager(): ChannelManager {
  return {
    send: async () => {},
    sendImage: async () => {},
    refreshGroupMetadata: async () => [],
  } as unknown as ChannelManager;
}

function createCapturingRuntime() {
  let resolveOpenConfig!: (config: OpenConversationInput) => void;
  const opened = new Promise<OpenConversationInput>((resolve) => {
    resolveOpenConfig = resolve;
  });

  let resolveFirstSend!: (input: ConversationMessageInput) => void;
  const firstSend = new Promise<ConversationMessageInput>((resolve) => {
    resolveFirstSend = resolve;
  });

  let firstSendResolved = false;

  let resolveResetConfig!: (config: ResetSessionInput) => void;
  const reset = new Promise<ResetSessionInput>((resolve) => {
    resolveResetConfig = resolve;
  });

  const runtime: AgentRuntime = {
    name: "mock",
    openConversation: async (config) => {
      resolveOpenConfig(config);
      return {
        conversation: {
          send: async (input) => {
            if (!firstSendResolved) {
              firstSendResolved = true;
              resolveFirstSend(input);
            }
          },
          close: () => {},
        },
        events: (async function* () {})(),
      };
    },
    resetSession: async (config) => {
      resolveResetConfig(config);
      return { sessionRef: "fresh-session.jsonl" };
    },
  };

  return { runtime, opened, firstSend, reset };
}

describe("group queue MarkItDown gating", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "octo-group-queue-"));
    externalMcpConfigTestHelpers.resetCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    externalMcpConfigTestHelpers.resetCache();
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("detects whether a curated skill is installed for the group", () => {
    const skillDir = join(
      tempDir,
      "groups",
      "main",
      ".pi",
      "skills",
      "pdf-to-markdown",
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# pdf-to-markdown");

    expect(
      groupQueueTestHelpers.isGroupSkillInstalled(
        "main",
        "pdf-to-markdown",
        tempDir,
      ),
    ).toBe(true);
    expect(
      groupQueueTestHelpers.isGroupSkillInstalled(
        "main",
        "missing-skill",
        tempDir,
      ),
    ).toBe(false);
  });

  test("only injects markitdown MCP for groups with the curated skill installed", () => {
    const configPath = join(tempDir, "external-mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          servers: {
            markitdown: {
              enabled: true,
              command: "uvx",
              args: ["markitdown-mcp"],
            },
          },
        },
        null,
        2,
      ),
    );
    process.env.EXTERNAL_MCP_CONFIG_PATH = configPath;

    const skillDir = join(
      tempDir,
      "groups",
      "enabled-group",
      ".pi",
      "skills",
      "pdf-to-markdown",
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# pdf-to-markdown");

    expect(
      groupQueueTestHelpers.buildGroupExternalMcpServers(
        "enabled-group",
        tempDir,
      ),
    ).toEqual({
      markitdown: {
        command: "uvx",
        args: ["markitdown-mcp"],
      },
    });
    expect(
      groupQueueTestHelpers.buildGroupExternalMcpServers(
        "disabled-group",
        tempDir,
      ),
    ).toEqual({});
  });
});

describe("group queue Pi session ref lifecycle", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "octo-group-queue-session-"));
    externalMcpConfigTestHelpers.resetCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    externalMcpConfigTestHelpers.resetCache();
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("passes an existing local Pi session ref into runtime.openConversation", async () => {
    const { db } = createQueueWorkspace(tempDir);
    const sessionRef = join(tempDir, "groups", "main", ".pi", "sessions", "existing.jsonl");
    mkdirSync(join(tempDir, "groups", "main", ".pi", "sessions"), { recursive: true });
    writeFileSync(sessionRef, "");
    saveSessionRef(db, "main", sessionRef);

    const { runtime, opened } = createCapturingRuntime();
    const queue = new GroupQueue(db, createFakeChannelManager(), runtime, 1);

    await queue.enqueue("main", "hello");

    const config = await opened;
    expect(config.resumeSessionRef).toBe(sessionRef);
  });

  test("drops stale Pi session refs before runtime.openConversation", async () => {
    const { db } = createQueueWorkspace(tempDir);
    const missingSessionRef = join(tempDir, "groups", "main", ".pi", "sessions", "missing.jsonl");
    saveSessionRef(db, "main", missingSessionRef);

    const { runtime, opened } = createCapturingRuntime();
    const queue = new GroupQueue(db, createFakeChannelManager(), runtime, 1);

    await queue.enqueue("main", "hello");

    const config = await opened;
    expect(config.resumeSessionRef).toBeUndefined();
    expect(getSessionRef(db, "main")).toBeNull();
  });

  test("clearSession resumes from an existing local Pi session ref", async () => {
    const { db } = createQueueWorkspace(tempDir);
    const sessionRef = join(tempDir, "groups", "main", ".pi", "sessions", "existing.jsonl");
    mkdirSync(join(tempDir, "groups", "main", ".pi", "sessions"), { recursive: true });
    writeFileSync(sessionRef, "");
    saveSessionRef(db, "main", sessionRef);

    const { runtime, reset } = createCapturingRuntime();
    const queue = new GroupQueue(db, createFakeChannelManager(), runtime, 1);

    const result = await queue.clearSession("main");
    const config = await reset;

    expect(config.resumeSessionRef).toBe(sessionRef);
    expect(result.previousSessionRef).toBe(sessionRef);
    expect(result.sessionRef).toBe("fresh-session.jsonl");
    expect(getSessionRef(db, "main")).toBe("fresh-session.jsonl");
  });

  test("clearSession drops stale Pi session refs before creating a fresh one", async () => {
    const { db } = createQueueWorkspace(tempDir);
    const missingSessionRef = join(tempDir, "groups", "main", ".pi", "sessions", "missing.jsonl");
    saveSessionRef(db, "main", missingSessionRef);

    const { runtime, reset } = createCapturingRuntime();
    const queue = new GroupQueue(db, createFakeChannelManager(), runtime, 1);

    const result = await queue.clearSession("main");
    const config = await reset;

    expect(config.resumeSessionRef).toBeUndefined();
    expect(result.previousSessionRef).toBe(missingSessionRef);
    expect(result.sessionRef).toBe("fresh-session.jsonl");
    expect(getSessionRef(db, "main")).toBe("fresh-session.jsonl");
  });
});
