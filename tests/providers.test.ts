import { describe, expect, test } from "bun:test";
import { ClaudeProvider } from "../src/providers/claude";
import { OpenAIProxyManager } from "../src/runtime/openai-proxy";
import type { AgentEvent, AgentProvider, SessionConfig } from "../src/providers/types";

describe("Provider interface compliance", () => {
  test("ClaudeProvider implements AgentProvider", () => {
    const provider = new ClaudeProvider(new OpenAIProxyManager());
    expect(provider.name).toBe("claude");
    expect(typeof provider.startSession).toBe("function");
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

describe("Tool definitions", () => {
  test("createGroupToolDefs returns a function export", async () => {
    const { createGroupToolDefs } = await import("../src/tools");
    expect(typeof createGroupToolDefs).toBe("function");
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
    ];

    const names = getToolNames(tools, "octo-tools");
    expect(names).toEqual([
      "mcp__octo-tools__send_message",
      "mcp__octo-tools__send_image",
    ]);
  });
});
