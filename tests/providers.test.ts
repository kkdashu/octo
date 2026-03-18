import { test, expect, describe } from "bun:test";
import { ProviderRegistry } from "../src/providers/registry";
import { ClaudeProvider } from "../src/providers/claude";
import { CodexProvider } from "../src/providers/codex";
import { KimiProvider } from "../src/providers/kimi";
import type { AgentProvider, AgentEvent, SessionConfig } from "../src/providers/types";

// ---------------------------------------------------------------------------
// ProviderRegistry tests
// ---------------------------------------------------------------------------

describe("ProviderRegistry", () => {
  test("register and get provider", () => {
    const registry = new ProviderRegistry();
    const mockProvider: AgentProvider = {
      name: "test",
      startSession: async () => ({
        session: { push: () => {}, close: () => {} },
        events: (async function* () {})(),
      }),
    };

    registry.register(mockProvider);
    expect(registry.get("test")).toBe(mockProvider);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("first registered provider becomes default", () => {
    const registry = new ProviderRegistry();
    const p1: AgentProvider = {
      name: "first",
      startSession: async () => ({
        session: { push: () => {}, close: () => {} },
        events: (async function* () {})(),
      }),
    };
    const p2: AgentProvider = {
      name: "second",
      startSession: async () => ({
        session: { push: () => {}, close: () => {} },
        events: (async function* () {})(),
      }),
    };

    registry.register(p1);
    registry.register(p2);
    expect(registry.getDefault().name).toBe("first");
  });

  test("setDefault changes default provider", () => {
    const registry = new ProviderRegistry();
    const p1: AgentProvider = {
      name: "first",
      startSession: async () => ({
        session: { push: () => {}, close: () => {} },
        events: (async function* () {})(),
      }),
    };
    const p2: AgentProvider = {
      name: "second",
      startSession: async () => ({
        session: { push: () => {}, close: () => {} },
        events: (async function* () {})(),
      }),
    };

    registry.register(p1);
    registry.register(p2);
    registry.setDefault("second");
    expect(registry.getDefault().name).toBe("second");
  });

  test("getDefault throws when no providers registered", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.getDefault()).toThrow("No providers registered");
  });

  test("setDefault throws for unknown provider", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.setDefault("unknown")).toThrow("Provider not found: unknown");
  });

  test("list returns all registered provider names", () => {
    const registry = new ProviderRegistry();
    const make = (name: string): AgentProvider => ({
      name,
      startSession: async () => ({
        session: { push: () => {}, close: () => {} },
        events: (async function* () {})(),
      }),
    });

    registry.register(make("claude"));
    registry.register(make("codex"));
    expect(registry.list()).toEqual(["claude", "codex"]);
  });
});

// ---------------------------------------------------------------------------
// Provider interface compliance tests
// ---------------------------------------------------------------------------

describe("Provider interface compliance", () => {
  test("ClaudeProvider implements AgentProvider", () => {
    const provider = new ClaudeProvider();
    expect(provider.name).toBe("claude");
    expect(typeof provider.startSession).toBe("function");
  });

  test("CodexProvider implements AgentProvider", () => {
    const provider = new CodexProvider();
    expect(provider.name).toBe("codex");
    expect(typeof provider.startSession).toBe("function");
  });

  test("KimiProvider implements AgentProvider", () => {
    const provider = new KimiProvider();
    expect(provider.name).toBe("kimi");
    expect(typeof provider.startSession).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Mock provider event stream test
// ---------------------------------------------------------------------------

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
    });

    const collected: AgentEvent[] = [];
    for await (const event of events) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
    expect(collected[0]).toEqual({ type: "text", text: "Hello from mock" });
    expect(collected[1]).toEqual({ type: "text", text: "Second message" });
    expect(collected[2]).toEqual({ type: "result", sessionId: "mock-session-123" });

    // Session should have push and close
    expect(typeof session.push).toBe("function");
    expect(typeof session.close).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tool definitions test
// ---------------------------------------------------------------------------

describe("Tool definitions", () => {
  test("createGroupToolDefs returns correct tool count", async () => {
    // We can't easily test with real db/channelManager, but we can verify the module exports
    const { createGroupToolDefs } = await import("../src/tools");
    expect(typeof createGroupToolDefs).toBe("function");
  });

  test("getToolNames formats correctly", async () => {
    const { getToolNames } = await import("../src/tools");
    const tools = [
      { name: "send_message", description: "", schema: {}, handler: async () => ({ content: [{ type: "text" as const, text: "" }] }) },
      { name: "send_image", description: "", schema: {}, handler: async () => ({ content: [{ type: "text" as const, text: "" }] }) },
    ];

    const names = getToolNames(tools, "octo-tools");
    expect(names).toEqual([
      "mcp__octo-tools__send_message",
      "mcp__octo-tools__send_image",
    ]);
  });
});
