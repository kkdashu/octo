import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { log } from "../logger";
import { buildClaudeSdkEnv } from "../runtime/profile-config";
import { OpenAIProxyManager } from "../runtime/openai-proxy";
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  SessionConfig,
  ToolDefinition,
} from "./types";

const TAG = "claude-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

function filterInternalContent(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
}

/** Convert platform-agnostic ToolDefinitions into a Claude SDK MCP server */
function buildMcpServer(tools: ToolDefinition[]) {
  const sdkTools = tools.map((t) =>
    tool(
      t.name,
      t.description,
      jsonSchemaToZod(t.schema),
      async (args: Record<string, unknown>) => {
        const result = await t.handler(args);
        return { ...result } as { [key: string]: unknown; content: Array<{ type: "text"; text: string }> };
      },
    ),
  );

  return createSdkMcpServer({
    name: "octo-tools",
    version: "1.0.0",
    tools: sdkTools,
  });
}

/** Minimal JSON Schema → Zod conversion for our tool schemas */
function jsonSchemaToZod(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const result: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(props)) {
    let field: z.ZodType;

    if (prop.enum) {
      field = z.enum(prop.enum as [string, ...string[]]);
    } else {
      field = z.string();
    }

    if (prop.description) {
      field = (field as z.ZodString).describe(prop.description as string);
    }

    if (prop.default !== undefined) {
      field = field.default(prop.default);
    }

    if (!required.has(key) && prop.default === undefined) {
      field = field.optional();
    }

    result[key] = field;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Claude Provider
// ---------------------------------------------------------------------------

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";

  constructor(private readonly proxyManager: OpenAIProxyManager) {}

  async clearContext(config: SessionConfig): Promise<{
    sessionId: string;
  }> {
    const proxyRoute =
      config.profile.apiFormat === "openai"
        ? this.proxyManager.acquire(config.profile)
        : undefined;
    const env = buildClaudeSdkEnv(config.profile, proxyRoute);

    try {
      for await (const message of query({
        prompt: "/clear",
        options: {
          model: config.profile.model,
          settingSources: ["project"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env,
          cwd: config.workingDirectory,
          maxTurns: 1,
          ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
        },
      })) {
        if (message.type === "system" && (message as any).subtype === "init") {
          const sessionId = (message as any).session_id;
          if (sessionId) {
            return { sessionId };
          }
        }

        if (message.type === "result") {
          const sessionId = (message as any).session_id;
          if (sessionId) {
            return { sessionId };
          }
        }
      }
    } finally {
      proxyRoute?.release();
    }

    throw new Error(`Failed to clear context for group ${config.groupFolder}: no new session id returned`);
  }

  async startSession(config: SessionConfig): Promise<{
    session: AgentSession;
    events: AsyncIterable<AgentEvent>;
  }> {
    const groupWorkdir = config.workingDirectory;

    log.info(TAG, `=== Starting session for group: ${config.groupFolder} ===`, {
      groupFolder: config.groupFolder,
      isMain: config.isMain,
      hasResume: !!config.resumeSessionId,
      promptLength: config.initialPrompt.length,
      profileKey: config.profile.profileKey,
      apiFormat: config.profile.apiFormat,
      model: config.profile.model,
    });

    // Build message channel (async generator for streaming input)
    let resolveNext: ((msg: string | null) => void) | null = null;
    const queue: (string | null)[] = [];

    async function* messageGenerator(initialPrompt: string) {
      yield makeUserMessage(initialPrompt);
      while (true) {
        const msg =
          queue.length > 0
            ? queue.shift()!
            : await new Promise<string | null>((r) => {
                resolveNext = r;
              });
        resolveNext = null;
        if (msg === null) return;
        yield makeUserMessage(msg);
      }
    }

    function push(text: string) {
      if (resolveNext) resolveNext(text);
      else queue.push(text);
    }

    function close() {
      if (resolveNext) resolveNext(null);
      else queue.push(null);
    }

    // Build MCP tools
    const mcpServer = buildMcpServer(config.tools);
    const toolNames = config.tools.map((t) => `mcp__octo-tools__${t.name}`);

    const allowedTools = [
      "Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill",
      ...toolNames,
    ];

    const proxyRoute =
      config.profile.apiFormat === "openai"
        ? this.proxyManager.acquire(config.profile)
        : undefined;
    const env = buildClaudeSdkEnv(config.profile, proxyRoute);

    log.info(TAG, "Agent configuration", {
      cwd: groupWorkdir,
      allowedTools,
      permissionMode: "bypassPermissions",
      resuming: !!config.resumeSessionId,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
      profileKey: config.profile.profileKey,
    });

    const queryIter = query({
      prompt: messageGenerator(config.initialPrompt),
      options: {
        model: config.profile.model,
        settingSources: ["project"],
        mcpServers: { "octo-tools": mcpServer },
        allowedTools,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env,
        ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
        cwd: groupWorkdir,
      },
    });

    // Convert Claude SDK output stream → AgentEvent stream
    async function* eventStream(): AsyncGenerator<AgentEvent> {
      let messageCount = 0;
      try {
        for await (const message of queryIter) {
          messageCount++;
          log.debug(TAG, `Agent output message #${messageCount}`, {
            type: message.type,
            subtype: (message as any).subtype,
            groupFolder: config.groupFolder,
          });

          if (message.type === "assistant" && (message as any).message?.content) {
            const content = (message as any).message.content;
            for (const block of content) {
              if ("text" in block) {
                const raw = block.text;
                const text = filterInternalContent(raw);
                if (text) {
                  yield { type: "text", text };
                }
              }
            }
          }

          if (message.type === "result") {
            const resultMsg = message as any;
            log.info(TAG, `=== Agent finished for group ${config.groupFolder} ===`, {
              sessionId: resultMsg.session_id,
              totalCostUsd: resultMsg.total_cost_usd,
              totalMessages: messageCount,
            });
            yield {
              type: "result",
              sessionId: resultMsg.session_id ?? undefined,
            };
          }
        }
      } catch (err) {
        log.error(TAG, `Agent error for group ${config.groupFolder}`, err);
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      } finally {
        proxyRoute?.release();
      }
    }

    return {
      session: { push, close },
      events: eventStream(),
    };
  }
}
