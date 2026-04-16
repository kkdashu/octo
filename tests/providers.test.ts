import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider, __test__ as claudeProviderTestHelpers } from "../src/providers/claude";
import { initDatabase, registerGroup } from "../src/db";
import { AnthropicLoggingProxyManager } from "../src/runtime/anthropic-logging-proxy";
import { OpenAIProxyManager } from "../src/runtime/openai-proxy";
import type { AgentEvent, AgentProvider, SessionConfig } from "../src/providers/types";

const passthroughImagePreprocessor = {
  preprocess: async (text: string) => text,
};

describe("Provider interface compliance", () => {
  test("ClaudeProvider implements AgentProvider", () => {
    const provider = new ClaudeProvider(
      new OpenAIProxyManager(),
      new AnthropicLoggingProxyManager(),
      passthroughImagePreprocessor,
    );
    expect(provider.name).toBe("claude");
    expect(typeof provider.startSession).toBe("function");
    expect(typeof provider.clearContext).toBe("function");
  });
});

describe("AgentEvent stream contract", () => {
  test("mock provider yields correct event sequence", async () => {
    const mockProvider: AgentProvider = {
      name: "mock",
      startSession: async (_config: SessionConfig) => {
        async function* events(): AsyncGenerator<AgentEvent> {
          yield { type: "text", text: "Hello from mock" };
          yield { type: "text", text: "Second message" };
          yield { type: "result", sessionId: "mock-session-123" };
        }
        return {
          session: { push: () => {}, close: () => {} },
          events: events(),
        };
      },
      clearContext: async () => ({ sessionId: "mock-cleared-session-123" }),
    };

    const { session, events } = await mockProvider.startSession({
      groupFolder: "test",
      workingDirectory: "/tmp/test",
      initialPrompt: "hello",
      isMain: false,
      tools: [],
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

    const collected: AgentEvent[] = [];
    for await (const event of events) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
    expect(collected[0]).toEqual({ type: "text", text: "Hello from mock" });
    expect(collected[1]).toEqual({ type: "text", text: "Second message" });
    expect(collected[2]).toEqual({ type: "result", sessionId: "mock-session-123" });
    expect(typeof session.push).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});

describe("Provider clear session contract", () => {
  test("mock provider clearContext returns a fresh session id", async () => {
    const mockProvider: AgentProvider = {
      name: "mock",
      startSession: async (_config: SessionConfig) => ({
        session: { push: () => {}, close: () => {} },
        events: (async function* () {})(),
      }),
      clearContext: async () => ({ sessionId: "fresh-session-123" }),
    };

    const result = await mockProvider.clearContext({
      groupFolder: "test",
      workingDirectory: "/tmp/test",
      initialPrompt: "/clear",
      isMain: true,
      tools: [],
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

    expect(result).toEqual({ sessionId: "fresh-session-123" });
  });
});

describe("Claude provider clear session id resolution", () => {
  test("uses result.session_id when resumed clear starts with the old init session id", () => {
    expect(
      claudeProviderTestHelpers.resolveClearedSessionId(
        [
          { type: "system", subtype: "init", session_id: "session-old" },
          { type: "result", session_id: "session-new" },
        ],
        "session-old",
      ),
    ).toBe("session-new");
  });

  test("rejects resumed clear when only init.session_id is returned", () => {
    expect(() =>
      claudeProviderTestHelpers.resolveClearedSessionId(
        [{ type: "system", subtype: "init", session_id: "session-old" }],
        "session-old",
      ),
    ).toThrow("Claude /clear reused previous session id session-old");
  });

  test("rejects resumed clear when result.session_id is unchanged", () => {
    expect(() =>
      claudeProviderTestHelpers.resolveClearedSessionId(
        [
          { type: "system", subtype: "init", session_id: "session-old" },
          { type: "result", session_id: "session-old" },
        ],
        "session-old",
      ),
    ).toThrow("Claude /clear reused previous session id session-old");
  });

  test("falls back to init.session_id only when clear is not resuming an old session", () => {
    expect(
      claudeProviderTestHelpers.resolveClearedSessionId([
        { type: "system", subtype: "init", session_id: "session-fresh" },
      ]),
    ).toBe("session-fresh");
  });
});

describe("Tool definitions", () => {
  test("createGroupToolDefs returns a function export", async () => {
    const { createGroupToolDefs } = await import("../src/tools");
    expect(typeof createGroupToolDefs).toBe("function");
  });

  test("createGroupToolDefs includes generate_image and send_image", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-tools-"));

    try {
      const db = initDatabase(join(workspaceDir, "store", "messages.db"));
      registerGroup(db, {
        jid: "oc_test",
        name: "Test Group",
        folder: "test-group",
        channelType: "feishu",
        requiresTrigger: true,
        isMain: false,
        agentProvider: "claude",
      });

      const { createGroupToolDefs } = await import("../src/tools");
      const tools = createGroupToolDefs(
        "test-group",
        false,
        db,
        {
          send: async () => {},
          sendImage: async () => {},
          refreshGroupMetadata: async () => ({ count: 0 }),
        },
        workspaceDir,
      );

      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["generate_image", "send_image"]),
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("send_message and send_image default to the current regular group chat", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-tools-"));

    try {
      const db = initDatabase(join(workspaceDir, "store", "messages.db"));
      registerGroup(db, {
        jid: "oc_regular_group",
        name: "Regular Group",
        folder: "regular-group",
        channelType: "feishu",
        requiresTrigger: true,
        isMain: false,
        agentProvider: "claude",
      });

      mkdirSync(join(workspaceDir, "groups", "regular-group"), { recursive: true });
      writeFileSync(
        join(workspaceDir, "groups", "regular-group", "sample.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      const sentMessages: Array<{ chatJid: string; text: string }> = [];
      const sentImages: Array<{ chatJid: string; filePath: string }> = [];
      const { createGroupToolDefs } = await import("../src/tools");
      const tools = createGroupToolDefs(
        "regular-group",
        false,
        db,
        {
          send: async (chatJid, text) => {
            sentMessages.push({ chatJid, text });
          },
          sendImage: async (chatJid, filePath) => {
            sentImages.push({ chatJid, filePath });
          },
          refreshGroupMetadata: async () => ({ count: 0 }),
        },
        workspaceDir,
      );

      const sendMessageTool = tools.find((tool) => tool.name === "send_message");
      const sendImageTool = tools.find((tool) => tool.name === "send_image");
      expect(sendMessageTool?.schema).toMatchObject({ required: ["text"] });
      expect(sendImageTool?.schema).toMatchObject({ required: ["filePath"] });

      const sendMessageResult = await sendMessageTool!.handler({ text: "hello group" });
      const sendImageResult = await sendImageTool!.handler({ filePath: "sample.png" });

      expect(sendMessageResult).toEqual({
        content: [{ type: "text", text: "Message sent" }],
      });
      expect(sendImageResult).toEqual({
        content: [{ type: "text", text: "Image sent" }],
      });
      expect(sentMessages).toEqual([{ chatJid: "oc_regular_group", text: "hello group" }]);
      expect(sentImages).toEqual([
        {
          chatJid: "oc_regular_group",
          filePath: join(workspaceDir, "groups", "regular-group", "sample.png"),
        },
      ]);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("regular groups still cannot send to other groups explicitly", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-tools-"));

    try {
      const db = initDatabase(join(workspaceDir, "store", "messages.db"));
      registerGroup(db, {
        jid: "oc_regular_group",
        name: "Regular Group",
        folder: "regular-group",
        channelType: "feishu",
        requiresTrigger: true,
        isMain: false,
        agentProvider: "claude",
      });

      mkdirSync(join(workspaceDir, "groups", "regular-group"), { recursive: true });
      writeFileSync(
        join(workspaceDir, "groups", "regular-group", "sample.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      const { createGroupToolDefs } = await import("../src/tools");
      const tools = createGroupToolDefs(
        "regular-group",
        false,
        db,
        {
          send: async () => {
            throw new Error("send should not be called");
          },
          sendImage: async () => {
            throw new Error("sendImage should not be called");
          },
          refreshGroupMetadata: async () => ({ count: 0 }),
        },
        workspaceDir,
      );

      const sendMessageTool = tools.find((tool) => tool.name === "send_message");
      const sendImageTool = tools.find((tool) => tool.name === "send_image");

      await expect(
        sendMessageTool!.handler({ chatJid: "oc_other_group", text: "hello" }),
      ).resolves.toEqual({
        content: [{ type: "text", text: "Permission denied: cannot send to other groups" }],
      });
      await expect(
        sendImageTool!.handler({ chatJid: "oc_other_group", filePath: "sample.png" }),
      ).resolves.toEqual({
        content: [{ type: "text", text: "Permission denied: cannot send to other groups" }],
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("main group defaults to its own chat and still allows explicit cross-group sends", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-tools-"));

    try {
      const db = initDatabase(join(workspaceDir, "store", "messages.db"));
      registerGroup(db, {
        jid: "oc_main_group",
        name: "Main Group",
        folder: "main",
        channelType: "feishu",
        requiresTrigger: false,
        isMain: true,
        agentProvider: "claude",
      });

      mkdirSync(join(workspaceDir, "groups", "main"), { recursive: true });
      writeFileSync(
        join(workspaceDir, "groups", "main", "sample.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      const sentMessages: Array<{ chatJid: string; text: string }> = [];
      const sentImages: Array<{ chatJid: string; filePath: string }> = [];
      const { createGroupToolDefs } = await import("../src/tools");
      const tools = createGroupToolDefs(
        "main",
        true,
        db,
        {
          send: async (chatJid, text) => {
            sentMessages.push({ chatJid, text });
          },
          sendImage: async (chatJid, filePath) => {
            sentImages.push({ chatJid, filePath });
          },
          refreshGroupMetadata: async () => ({ count: 0 }),
        },
        workspaceDir,
      );

      const sendMessageTool = tools.find((tool) => tool.name === "send_message");
      const sendImageTool = tools.find((tool) => tool.name === "send_image");

      await sendMessageTool!.handler({ text: "hello main" });
      await sendMessageTool!.handler({ chatJid: "oc_other_group", text: "hello other" });
      await sendImageTool!.handler({ filePath: "sample.png" });
      await sendImageTool!.handler({ chatJid: "oc_other_group", filePath: "sample.png" });

      expect(sentMessages).toEqual([
        { chatJid: "oc_main_group", text: "hello main" },
        { chatJid: "oc_other_group", text: "hello other" },
      ]);
      expect(sentImages).toEqual([
        {
          chatJid: "oc_main_group",
          filePath: join(workspaceDir, "groups", "main", "sample.png"),
        },
        {
          chatJid: "oc_other_group",
          filePath: join(workspaceDir, "groups", "main", "sample.png"),
        },
      ]);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("getToolNames formats correctly", async () => {
    const { getToolNames } = await import("../src/tools");
    const tools = [
      {
        name: "send_message",
        description: "",
        schema: {},
        handler: async () => ({ content: [{ type: "text" as const, text: "" }] }),
      },
      {
        name: "send_image",
        description: "",
        schema: {},
        handler: async () => ({ content: [{ type: "text" as const, text: "" }] }),
      },
      {
        name: "generate_image",
        description: "",
        schema: {},
        handler: async () => ({ content: [{ type: "text" as const, text: "" }] }),
      },
    ];

    const names = getToolNames(tools, "octo-tools");
    expect(names).toEqual([
      "mcp__octo-tools__send_message",
      "mcp__octo-tools__send_image",
      "mcp__octo-tools__generate_image",
    ]);
  });
});

describe("Claude provider external MCP helpers", () => {
  test("only exposes built-in MCP server when no external server is configured", () => {
    const builtInServer = { name: "octo-tools" } as never;

    expect(
      claudeProviderTestHelpers.buildSessionMcpServers(builtInServer),
    ).toEqual({
      "octo-tools": builtInServer,
    });
    expect(claudeProviderTestHelpers.buildExternalMcpAllowedTools()).toEqual([]);
  });

  test("merges external MCP servers and whitelists matching tool namespaces", () => {
    const builtInServer = { name: "octo-tools" } as never;
    const externalServers = {
      markitdown: {
        command: "markitdown-mcp",
        args: ["--stdio"],
      },
      docs: {
        command: "docs-mcp",
      },
    };

    expect(
      claudeProviderTestHelpers.buildSessionMcpServers(
        builtInServer,
        externalServers,
      ),
    ).toEqual({
      "octo-tools": builtInServer,
      markitdown: {
        command: "markitdown-mcp",
        args: ["--stdio"],
      },
      docs: {
        command: "docs-mcp",
      },
    });
    expect(
      claudeProviderTestHelpers.buildExternalMcpAllowedTools(externalServers),
    ).toEqual([
      "mcp__markitdown__*",
      "mcp__docs__*",
    ]);
  });
});

describe("Claude provider markdown image content", () => {
  test("uses preprocessed pure text content instead of Read instructions", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-images-"));

    try {
      const message = await claudeProviderTestHelpers.makeUserMessage(
        "前文\n![image](media/oc_test/om_test.png)\n后文",
        workspaceDir,
        join(workspaceDir, "groups", "main"),
        {
          preprocess: async (text: string, rootDir: string) => {
            expect(rootDir).toBe(workspaceDir);
            expect(text).toBe("前文\n![image](media/oc_test/om_test.png)\n后文");

            return [
              "前文",
              "[图片理解结果]",
              "路径: media/oc_test/om_test.png",
              "客观描述: 一只白猫趴着",
              "OCR文本: 无",
              "关键信息: 无票据或聊天界面",
              "[/图片理解结果]",
              "后文",
            ].join("\n");
          },
        },
      );

      expect(message.message.content).toBe(
        [
          "前文",
          "[图片理解结果]",
          "路径: media/oc_test/om_test.png",
          "客观描述: 一只白猫趴着",
          "OCR文本: 无",
          "关键信息: 无票据或聊天界面",
          "[/图片理解结果]",
          "后文",
        ].join("\n"),
      );
      expect(message.message.content).not.toContain("Read");
      expect(message.message.content).not.toContain("[图片路径:");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("falls back to normalized markdown when preprocessing throws", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-images-"));

    try {
      const message = await claudeProviderTestHelpers.makeUserMessage(
        "旧格式图片：[IMAGE:media/oc_test/om_legacy.png]",
        workspaceDir,
        join(workspaceDir, "groups", "main"),
        {
          preprocess: async () => {
            throw new Error("preprocess failed");
          },
        },
      );

      expect(message.message.content).toBe(
        "旧格式图片：![image](media/oc_test/om_legacy.png)",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("annotates local file links with agent-readable paths", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-files-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const message = await claudeProviderTestHelpers.makeUserMessage(
        "请阅读这个文件：[AI素养评价_产品手册.md](media/oc_test/om_1-AI素养评价_产品手册.md)",
        workspaceDir,
        workingDirectory,
        {
          preprocess: async (text: string) => text,
        },
      );

      expect(message.message.content).toContain(
        "[AI素养评价_产品手册.md](media/oc_test/om_1-AI素养评价_产品手册.md)",
      );
      expect(message.message.content).toContain(
        "可读路径: ../../media/oc_test/om_1-AI素养评价_产品手册.md",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("keeps working-directory-relative file links unchanged", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-files-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const annotated = claudeProviderTestHelpers.annotateLocalFileLinksForAgent(
        "请发送 [report.pdf](./artifacts/report.pdf)",
        workspaceDir,
        workingDirectory,
      );

      expect(annotated).toBe("请发送 [report.pdf](./artifacts/report.pdf)");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("annotates standalone local file paths so agents can treat them as sendable files", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-files-"));
    const workingDirectory = join(workspaceDir, "groups", "main");
    const filePath = join(workingDirectory, ".generated", "documents", "report.md");

    try {
      mkdirSync(join(workingDirectory, ".generated", "documents"), { recursive: true });
      writeFileSync(filePath, "# report");

      const annotated = claudeProviderTestHelpers.annotateStandaloneLocalFilePathsForAgent(
        `${filePath}\n\n把这个文件发给我`,
        workspaceDir,
        workingDirectory,
      );

      expect(annotated).toContain(`[report.md](${filePath})`);
      expect(annotated).toContain("把这个文件发给我");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
