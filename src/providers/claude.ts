import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import { log } from "../logger";
import {
  isLocalMarkdownLinkTarget,
  normalizeLegacyImageSyntax,
} from "../message-parts";
import { AnthropicLoggingProxyManager } from "../runtime/anthropic-logging-proxy";
import type { ImageMessagePreprocessor } from "../runtime/image-message-preprocessor";
import { buildClaudeSdkEnv } from "../runtime/profile-config";
import { OpenAIProxyManager } from "../runtime/openai-proxy";
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  SessionConfig,
  ToolDefinition,
  ExternalMcpServerSpec,
} from "./types";

const TAG = "claude-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeUserMessage(
  text: string,
  rootDir: string,
  workingDirectory: string,
  imageMessagePreprocessor: ImageMessagePreprocessor,
): Promise<SDKUserMessage> {
  let processedContent = normalizeLegacyImageSyntax(text);

  try {
    processedContent = await imageMessagePreprocessor.preprocess(text, rootDir);
  } catch (error) {
    log.error(TAG, "Image preprocessing failed, falling back to normalized text", {
      rootDir,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error) {
      log.error(TAG, "Image preprocessing error details", error);
    }
  }

  processedContent = annotateLocalFileLinksForAgent(
    processedContent,
    rootDir,
    workingDirectory,
  );

  const message = {
    role: "user" as const,
    content: processedContent,
  } as SDKUserMessage["message"];

  return {
    type: "user",
    message,
    parent_tool_use_id: null,
    session_id: "",
  };
}

function filterInternalContent(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
}

function buildSessionMcpServers(
  builtInMcpServer: ReturnType<typeof buildMcpServer>,
  externalMcpServers?: Record<string, ExternalMcpServerSpec>,
): Record<string, unknown> {
  return {
    "octo-tools": builtInMcpServer,
    ...(externalMcpServers ?? {}),
  };
}

function buildExternalMcpAllowedTools(
  externalMcpServers?: Record<string, ExternalMcpServerSpec>,
): string[] {
  return Object.keys(externalMcpServers ?? {}).map(
    (serverName) => `mcp__${serverName}__*`,
  );
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function resolveAgentReadablePath(
  rawPath: string,
  rootDir: string,
  workingDirectory: string,
): string {
  if (isAbsolute(rawPath)) {
    return toPosixPath(rawPath);
  }

  const normalizedPath = rawPath.trim().replace(/\\/g, "/");
  if (!normalizedPath) {
    return rawPath;
  }

  const absolutePath =
    normalizedPath.startsWith("media/") || normalizedPath.startsWith("groups/")
      ? resolve(rootDir, normalizedPath)
      : resolve(workingDirectory, normalizedPath);
  const relativePath = relative(workingDirectory, absolutePath);
  const normalizedRelativePath = toPosixPath(relativePath || ".");

  return normalizedRelativePath.startsWith(".")
    ? normalizedRelativePath
    : `./${normalizedRelativePath}`;
}

function formatAnnotatedFileLink(
  label: string,
  rawPath: string,
  agentReadablePath: string,
): string {
  const normalizedLabel = label.trim() || basename(rawPath) || "file";
  const markdownLink = `[${normalizedLabel}](${rawPath})`;
  if (agentReadablePath === rawPath) {
    return markdownLink;
  }

  return `${markdownLink}\n可读路径: ${agentReadablePath}`;
}

function isExistingLocalFilePath(
  rawPath: string,
  rootDir: string,
  workingDirectory: string,
): boolean {
  if (!isLocalMarkdownLinkTarget(rawPath)) {
    return false;
  }

  const normalizedPath = rawPath.trim().replace(/\\/g, "/");
  if (!normalizedPath) {
    return false;
  }

  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : normalizedPath.startsWith("media/") || normalizedPath.startsWith("groups/")
      ? resolve(rootDir, normalizedPath)
      : resolve(workingDirectory, normalizedPath);

  if (!existsSync(absolutePath)) {
    return false;
  }

  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function annotateStandaloneLocalFilePathsForAgent(
  text: string,
  rootDir: string,
  workingDirectory: string,
): string {
  const lines = text.split("\n");
  let changed = false;

  const annotatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("![")) {
      return line;
    }

    if (!isExistingLocalFilePath(trimmed, rootDir, workingDirectory)) {
      return line;
    }

    changed = true;
    return formatAnnotatedFileLink(
      basename(trimmed),
      trimmed,
      resolveAgentReadablePath(trimmed, rootDir, workingDirectory),
    );
  });

  return changed ? annotatedLines.join("\n") : text;
}

function annotateLocalFileLinksForAgent(
  text: string,
  rootDir: string,
  workingDirectory: string,
): string {
  if (!text) {
    return text;
  }

  const linkRe = /\[([^\]]*)\]\(([^)\n]+)\)/g;
  let result = "";
  let lastIndex = 0;

  for (const match of text.matchAll(linkRe)) {
    const start = match.index ?? 0;
    const matchedText = match[0] ?? "";
    if (start > 0 && text[start - 1] === "!") {
      continue;
    }

    const label = (match[1] ?? "").trim();
    const rawPath = (match[2] ?? "").trim();
    if (!rawPath || !isLocalMarkdownLinkTarget(rawPath)) {
      continue;
    }

    result += text.slice(lastIndex, start);
    result += formatAnnotatedFileLink(
      label,
      rawPath,
      resolveAgentReadablePath(rawPath, rootDir, workingDirectory),
    );
    lastIndex = start + matchedText.length;
  }

  if (lastIndex === 0) {
    return text;
  }

  result += text.slice(lastIndex);
  return annotateStandaloneLocalFilePathsForAgent(
    result,
    rootDir,
    workingDirectory,
  );
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

  constructor(
    private readonly openAIProxyManager: OpenAIProxyManager,
    private readonly anthropicLoggingProxyManager: AnthropicLoggingProxyManager,
    private readonly imageMessagePreprocessor: ImageMessagePreprocessor,
  ) {}

  async clearContext(config: SessionConfig): Promise<{
    sessionId: string;
  }> {
    const proxyRoute =
      config.profile.apiFormat === "openai"
        ? this.openAIProxyManager.acquire(config.profile, config.groupFolder)
        : this.anthropicLoggingProxyManager.acquire(config.profile, config.groupFolder);
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
    const projectRoot = resolve(groupWorkdir, "..", "..");

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
    const imageMessagePreprocessor = this.imageMessagePreprocessor;

    async function* messageGenerator(initialPrompt: string) {
      yield await makeUserMessage(
        initialPrompt,
        projectRoot,
        groupWorkdir,
        imageMessagePreprocessor,
      );
      while (true) {
        const msg =
          queue.length > 0
            ? queue.shift()!
            : await new Promise<string | null>((r) => {
                resolveNext = r;
              });
        resolveNext = null;
        if (msg === null) return;
        yield await makeUserMessage(
          msg,
          projectRoot,
          groupWorkdir,
          imageMessagePreprocessor,
        );
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
    const externalMcpAllowedTools = buildExternalMcpAllowedTools(
      config.externalMcpServers,
    );
    const sessionMcpServers = buildSessionMcpServers(
      mcpServer,
      config.externalMcpServers,
    );

    const allowedTools = [
      "Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill",
      ...toolNames,
      ...externalMcpAllowedTools,
    ];

    const proxyRoute =
      config.profile.apiFormat === "openai"
        ? this.openAIProxyManager.acquire(config.profile, config.groupFolder)
        : this.anthropicLoggingProxyManager.acquire(config.profile, config.groupFolder);
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
        mcpServers: sessionMcpServers,
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

export const __test__ = {
  annotateLocalFileLinksForAgent,
  annotateStandaloneLocalFilePathsForAgent,
  buildExternalMcpAllowedTools,
  buildSessionMcpServers,
  makeUserMessage,
  resolveAgentReadablePath,
};
