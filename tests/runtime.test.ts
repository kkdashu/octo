import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, saveSessionId, updateGroupProvider } from "../src/db";
import { resolveClaudeResumeSessionId } from "../src/group-queue";
import {
  buildClaudeSdkEnv,
  listAgentProfiles,
  resolveAgentProfile,
} from "../src/runtime/profile-config";
import { anthropicToOpenAI, openAIToAnthropic } from "../src/runtime/openai-transform";
import { __test__ as proxyTestHelpers } from "../src/runtime/openai-proxy";

const originalEnv = { ...process.env };

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
        },
      },
      null,
      2,
    ),
  );
  return { dir, path };
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
  });

  afterEach(() => {
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

  test("lists configured profiles and builds claude env", () => {
    const profiles = listAgentProfiles();
    expect(profiles.map((profile) => profile.profileKey)).toEqual([
      "claude",
      "codex",
      "kimi",
      "kimi-cli",
    ]);

    const env = buildClaudeSdkEnv(resolveAgentProfile("claude"));
    expect(env.ANTHROPIC_API_KEY).toBe("ant-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
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

    const env = buildClaudeSdkEnv(profile);
    expect(env.ANTHROPIC_API_KEY).toBe("moonshot-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding");
    expect(env.ANTHROPIC_MODEL).toBe("kimi-k2.5");
  });

  test("lists moonshot profiles with resolved runtime endpoints", () => {
    const profiles = listAgentProfiles();
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: "kimi",
          apiFormat: "anthropic",
          upstreamApi: undefined,
          baseUrl: "https://api.moonshot.cn/anthropic",
        }),
        expect.objectContaining({
          profileKey: "kimi-cli",
          apiFormat: "anthropic",
          upstreamApi: undefined,
          baseUrl: "https://api.kimi.com/coding",
          codingPlanEnabled: true,
        }),
      ]),
    );
  });
});

describe("openai compatibility transforms", () => {
  test("converts anthropic request into openai chat completions request", () => {
    const request = anthropicToOpenAI({
      model: "claude-sonnet-4-6",
      system: "You are helpful",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      tools: [
        {
          name: "send_message",
          description: "Send a message",
          input_schema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        },
      ],
      max_tokens: 1024,
      stream: true,
    });

    expect(request.model).toBe("claude-sonnet-4-6");
    expect(request.messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hello" },
    ]);
    expect(request.tools).toEqual([
      {
        type: "function",
        function: {
          name: "send_message",
          description: "Send a message",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        },
      },
    ]);
  });

  test("converts openai chat completions tool call response into anthropic message", () => {
    const response = openAIToAnthropic({
      id: "chatcmpl-1",
      model: "gpt-5.4",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Working on it",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "send_message",
                  arguments: "{\"text\":\"hi\"}",
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
      },
    });

    expect(response.stop_reason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "Working on it" },
      {
        type: "tool_use",
        id: "call_1",
        name: "send_message",
        input: { text: "hi" },
      },
    ]);
  });

  test("converts chat completions request into responses request for openai upstream", () => {
    const request = proxyTestHelpers.convertChatCompletionsRequestToResponsesRequest({
      model: "gpt-5.4",
      stream: true,
      messages: [
        { role: "system", content: "Follow the rules" },
        { role: "user", content: "hello" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "send_message",
            description: "Send a message",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      ],
    });

    expect(request.instructions).toBe("Follow the rules");
    expect(request.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
    expect(request.tools).toEqual([
      {
        type: "function",
        name: "send_message",
        description: "Send a message",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ]);
  });

  test("converts responses api output into openai chat response shape", () => {
    const response = proxyTestHelpers.convertResponsesToOpenAIResponse({
      id: "resp_1",
      model: "gpt-5.4",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "send_message",
          arguments: "{\"text\":\"hi\"}",
        },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 5,
      },
    });

    expect(response.choices).toEqual([
      {
        message: {
          role: "assistant",
          content: "hello",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "send_message",
                arguments: "{\"text\":\"hi\"}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ]);
  });
});

describe("db session retention on profile switch", () => {
  test("updateGroupProvider keeps existing session rows", () => {
    const db = initDatabase(":memory:");
    db.query(
      `INSERT INTO registered_groups (
        jid, name, folder, channel_type, trigger_pattern, added_at, requires_trigger, is_main, agent_provider
      ) VALUES ('jid-1', 'Test', 'group-1', 'feishu', '', '2026-03-24T00:00:00.000Z', 1, 0, 'claude')`,
    ).run();

    saveSessionId(db, "group-1", "session-1");
    updateGroupProvider(db, "group-1", "codex");

    const row = db
      .query("SELECT session_id FROM sessions WHERE group_folder = 'group-1'")
      .get() as { session_id: string } | null;

    expect(row?.session_id).toBe("session-1");
  });
});

describe("claude session resume validation", () => {
  test("keeps persisted session id when it exists in Claude session storage", async () => {
    const resumeSessionId = await resolveClaudeResumeSessionId(
      "/tmp/group-1",
      "session-1",
      async () => [
        {
          sessionId: "session-1",
          summary: "latest",
          lastModified: Date.now(),
          fileSize: 1,
        },
      ],
    );

    expect(resumeSessionId).toBe("session-1");
  });

  test("drops persisted session id when it no longer exists in Claude session storage", async () => {
    const resumeSessionId = await resolveClaudeResumeSessionId(
      "/tmp/group-1",
      "legacy-session",
      async () => [],
    );

    expect(resumeSessionId).toBeUndefined();
  });
});
