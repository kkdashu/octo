import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initDatabase, registerGroup } from "../src/db";
import { createPiMcpExtensionBundle } from "../src/providers/pi-mcp-extension";
import {
  annotateLocalFileLinksForAgent,
  annotateStandaloneLocalFilePathsForAgent,
  collectAssistantText,
  filterInternalContent,
  normalizePromptForAgent,
} from "../src/providers/prompt-normalizer";
import { PiProvider } from "../src/providers/pi";
import {
  getPiSessionDir,
  resolvePersistedPiSessionRef,
} from "../src/providers/pi-session-ref";
import {
  adaptOctoTools,
  OCTO_TOOL_PREFIX,
  toPiToolName,
} from "../src/providers/pi-tool-adapter";
import type { ResolvedAgentProfile } from "../src/runtime/types";
import type {
  AgentRuntime,
  OpenConversationInput,
  RuntimeEvent,
} from "../src/providers/types";

const passthroughImagePreprocessor = {
  preprocess: async (text: string) => text,
};

const fakeMcpFixturePath = fileURLToPath(
  new URL("./fixtures/fake-mcp-server.ts", import.meta.url),
);
const bunExecutable = Bun.which("bun") ?? process.execPath;

const testProfile: ResolvedAgentProfile = {
  profileKey: "claude",
  apiFormat: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  apiKey: "test-key",
  model: "claude-sonnet-4-6",
  codingPlanEnabled: false,
};

type RegisteredExtensionTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >;
    details: unknown;
  }>;
};

type FakeResponsesRequest = {
  pathname: string;
  authorization: string | null;
  body: Record<string, unknown>;
};

async function collectEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 10000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildOpenAIResponsesSse(text: string): string {
  const events = [
    `data: ${JSON.stringify({
      type: "response.output_item.added",
      item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
    })}`,
    `data: ${JSON.stringify({
      type: "response.content_part.added",
      part: { type: "output_text", text: "" },
    })}`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    })}`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    })}`,
    "data: [DONE]",
  ];

  return `${events.join("\n\n")}\n\n`;
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve a loopback port for the fake Responses server"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function startFakeOpenAIResponsesServer(text: string): Promise<{
  server: ReturnType<typeof Bun.serve>;
  requests: FakeResponsesRequest[];
  baseUrl: string;
}> {
  const requests: FakeResponsesRequest[] = [];
  const body = buildOpenAIResponsesSse(text);
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await reserveLoopbackPort();

    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method !== "POST" || !url.pathname.endsWith("/responses")) {
            return new Response("not found", { status: 404 });
          }

          requests.push({
            pathname: url.pathname,
            authorization: request.headers.get("authorization"),
            body: await request.json() as Record<string, unknown>,
          });

          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });

      return {
        server,
        requests,
        baseUrl: server.url.origin,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to start fake OpenAI Responses server after retries: ${String(lastError)}`,
  );
}

describe("Provider interface compliance", () => {
  test("PiProvider implements AgentRuntime", () => {
    const provider = new PiProvider(passthroughImagePreprocessor);

    expect(provider.name).toBe("pi");
    expect(typeof provider.openConversation).toBe("function");
    expect(typeof provider.resetSession).toBe("function");
  });

  test("resetSession creates a fresh local Pi session ref", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-pi-provider-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });
      const provider = new PiProvider(passthroughImagePreprocessor);
      const result = await provider.resetSession({
        groupFolder: "main",
        workingDirectory,
        profile: testProfile,
      });

      expect(result.sessionRef).toContain(getPiSessionDir(workingDirectory));
      expect(existsSync(dirname(result.sessionRef))).toBe(true);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("RuntimeEvent stream contract", () => {
  test("mock runtime yields correct event sequence", async () => {
    const mockRuntime: AgentRuntime = {
      name: "mock",
      openConversation: async (_config: OpenConversationInput) => {
        async function* events(): AsyncGenerator<RuntimeEvent> {
          yield { type: "assistant_text", text: "Hello from mock" };
          yield { type: "assistant_text", text: "Second message" };
          yield { type: "completed", sessionRef: "mock-session-123" };
        }

        return {
          conversation: {
            send: async () => {},
            close: () => {},
          },
          events: events(),
        };
      },
      resetSession: async () => ({ sessionRef: "mock-cleared-session-123" }),
    };

    const { conversation, events } = await mockRuntime.openConversation({
      groupFolder: "test",
      workingDirectory: "/tmp/test",
      isMain: false,
      tools: [],
      profile: testProfile,
    });
    await conversation.send({ mode: "prompt", text: "hello" });

    const collected: RuntimeEvent[] = [];
    for await (const event of events) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
    expect(collected[0]).toEqual({ type: "assistant_text", text: "Hello from mock" });
    expect(collected[1]).toEqual({ type: "assistant_text", text: "Second message" });
    expect(collected[2]).toEqual({ type: "completed", sessionRef: "mock-session-123" });
    expect(typeof conversation.send).toBe("function");
    expect(typeof conversation.close).toBe("function");
  });
});

describe("Pi session refs", () => {
  test("resolves existing absolute and relative local session refs", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-pi-session-ref-"));
    const workingDirectory = join(workspaceDir, "groups", "main");
    const sessionDir = getPiSessionDir(workingDirectory);
    const absoluteSessionRef = join(sessionDir, "absolute.jsonl");
    const relativeSessionRef = join(".pi", "sessions", "relative.jsonl");

    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(absoluteSessionRef, "");
      writeFileSync(join(workingDirectory, relativeSessionRef), "");

      expect(
        resolvePersistedPiSessionRef(workingDirectory, absoluteSessionRef),
      ).toBe(absoluteSessionRef);
      expect(
        resolvePersistedPiSessionRef(workingDirectory, relativeSessionRef),
      ).toBe(join(workingDirectory, relativeSessionRef));
      expect(
        resolvePersistedPiSessionRef(workingDirectory, join(sessionDir, "missing.jsonl")),
      ).toBeUndefined();
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("Pi tool adapter", () => {
  test("prefixes octo tools into Pi MCP-style names and preserves handler output", async () => {
    const piTools = adaptOctoTools([
      {
        name: "send_message",
        description: "Send a message",
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        handler: async (args) => ({
          content: [{ type: "text", text: `sent:${String(args.text)}` }],
        }),
      },
    ]);

    expect(OCTO_TOOL_PREFIX).toBe("mcp__octo-tools__");
    expect(toPiToolName("send_message")).toBe("mcp__octo-tools__send_message");
    expect(piTools[0]?.name).toBe("mcp__octo-tools__send_message");

    const result = await piTools[0]!.execute("call-1", { text: "hello" });
    expect(result.content).toEqual([{ type: "text", text: "sent:hello" }]);
  });
});

describe("Pi MCP bridge integration", () => {
  test("registers tools from a real stdio MCP server and normalizes text/non-text content", async () => {
    const bundle = await createPiMcpExtensionBundle(
      {
        fake: {
          command: bunExecutable,
          args: [fakeMcpFixturePath],
        },
      },
      process.cwd(),
    );
    const tools = new Map<string, RegisteredExtensionTool>();

    try {
      expect(bundle.extensionFactories).toHaveLength(1);

      await bundle.extensionFactories[0]!({
        registerTool: (tool: RegisteredExtensionTool) => {
          tools.set(tool.name, tool);
        },
      } as never);

      const echoTool = tools.get("mcp__fake__echo_content");
      expect(echoTool).toBeDefined();

      const textResult = await echoTool!.execute("call-text", {
        text: "hello",
        mode: "text",
      });
      expect(textResult.content).toEqual([{ type: "text", text: "echo:hello" }]);

      const resourceResult = await echoTool!.execute("call-resource", {
        text: "hello",
        mode: "resource",
      });
      expect(resourceResult.content).toEqual([{ type: "text", text: "resource:hello" }]);

      const resourceLinkResult = await echoTool!.execute("call-resource-link", {
        text: "hello",
        mode: "resource_link",
      });
      expect(resourceLinkResult.content).toEqual([
        { type: "text", text: "artifact: linked:hello (file:///tmp/hello.txt)" },
      ]);

      const imageResult = await echoTool!.execute("call-image", {
        text: "hello",
        mode: "image",
      });
      expect(imageResult.content).toEqual([
        {
          type: "image",
          data: Buffer.from("image:hello", "utf8").toString("base64"),
          mimeType: "image/png",
        },
      ]);
    } finally {
      await bundle.dispose();
    }
  });
});

describe("PiProvider smoke", () => {
  test("openConversation + send emits assistant_text and completed with a local fake OpenAI Responses server", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-pi-smoke-"));
    const workingDirectory = join(workspaceDir, "groups", "main");
    const { server, requests, baseUrl } = await startFakeOpenAIResponsesServer(
      "hello from fake pi model",
    );

    mkdirSync(workingDirectory, { recursive: true });

    const provider = new PiProvider(passthroughImagePreprocessor);
    const { conversation, events } = await provider.openConversation({
      groupFolder: "main",
      workingDirectory,
      isMain: true,
      tools: [],
      profile: {
        profileKey: "test-openai",
        apiFormat: "openai",
        upstreamApi: "responses",
        baseUrl,
        apiKeyEnv: "OPENAI_API_KEY",
        apiKey: "test-key",
        model: "gpt-5.4",
        codingPlanEnabled: false,
      },
    });

    try {
      const collectedPromise = withTimeout(
        (async () => {
          const collected: RuntimeEvent[] = [];
          for await (const event of events) {
            collected.push(event);
            if (event.type === "completed" || event.type === "failed") {
              break;
            }
          }
          return collected;
        })(),
        "Timed out waiting for PiProvider smoke test events",
      );
      await conversation.send({
        mode: "prompt",
        text: "Say hello from the Pi smoke test.",
      });
      const collected = await collectedPromise;

      const textEvent = collected.find(
        (event): event is Extract<RuntimeEvent, { type: "assistant_text" }> =>
          event.type === "assistant_text",
      );
      const resultEvent = collected.find(
        (event): event is Extract<RuntimeEvent, { type: "completed" }> =>
          event.type === "completed",
      );

      expect(textEvent?.text).toBe("hello from fake pi model");
      expect(resultEvent?.sessionRef).toBeDefined();
      expect(existsSync(resultEvent!.sessionRef!)).toBe(true);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.pathname.endsWith("/responses")).toBe(true);
      expect(requests[0]?.authorization).toBe("Bearer test-key");
      expect(requests[0]?.body).toMatchObject({
        model: "gpt-5.4",
        stream: true,
        store: false,
      });
      expect(JSON.stringify(requests[0]?.body.input)).toContain(
        "Say hello from the Pi smoke test.",
      );
    } finally {
      conversation.close();
      server.stop(true);
      rmSync(workspaceDir, { recursive: true, force: true });
    }
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
        profileKey: "claude",
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
        profileKey: "claude",
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
        profileKey: "claude",
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
        profileKey: "claude",
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

  test("getToolNames formats Pi MCP-style names correctly", async () => {
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
      `${OCTO_TOOL_PREFIX}send_message`,
      `${OCTO_TOOL_PREFIX}send_image`,
      `${OCTO_TOOL_PREFIX}generate_image`,
    ]);
  });
});

describe("Prompt normalization", () => {
  test("uses preprocessed pure text content instead of legacy image placeholders", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-images-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const normalized = await normalizePromptForAgent(
        "前文\n![image](media/oc_test/om_test.png)\n后文",
        workspaceDir,
        workingDirectory,
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
        "test",
      );

      expect(normalized).toBe(
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
      expect(normalized).not.toContain("Read");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("falls back to normalized markdown when image preprocessing throws", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-images-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const normalized = await normalizePromptForAgent(
        "旧格式图片：[IMAGE:media/oc_test/om_legacy.png]",
        workspaceDir,
        workingDirectory,
        {
          preprocess: async () => {
            throw new Error("preprocess failed");
          },
        },
        "test",
      );

      expect(normalized).toBe("旧格式图片：![image](media/oc_test/om_legacy.png)");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("annotates local file links with agent-readable paths", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-files-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const annotated = annotateLocalFileLinksForAgent(
        "请阅读这个文件：[AI素养评价_产品手册.md](media/oc_test/om_1-AI素养评价_产品手册.md)",
        workspaceDir,
        workingDirectory,
      );

      expect(annotated).toContain(
        "[AI素养评价_产品手册.md](media/oc_test/om_1-AI素养评价_产品手册.md)",
      );
      expect(annotated).toContain(
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

      const annotated = annotateLocalFileLinksForAgent(
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
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "# report");

      const annotated = annotateStandaloneLocalFilePathsForAgent(
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

  test("collects assistant text and strips internal content", () => {
    expect(filterInternalContent("before<internal>secret</internal>after")).toBe(
      "beforeafter",
    );

    expect(
      collectAssistantText({
        role: "assistant",
        content: [
          { type: "text", text: "Visible" },
          { type: "text", text: "<internal>secret</internal>Shown" },
          { type: "image", data: "..." },
        ],
      }),
    ).toBe("Visible\n\nShown");
  });
});
