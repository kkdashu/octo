import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider } from "../src/providers/claude";
import { initDatabase, registerGroup } from "../src/db";
import { OpenAIProxyManager } from "../src/runtime/openai-proxy";
import type { AgentEvent, AgentProvider, SessionConfig } from "../src/providers/types";

describe("Provider interface compliance", () => {
  test("ClaudeProvider implements AgentProvider", () => {
    const provider = new ClaudeProvider(new OpenAIProxyManager());
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

describe("Provider clear context contract", () => {
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
