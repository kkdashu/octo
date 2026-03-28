import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Stream } from "node:stream";
import { log } from "../logger";

const TAG = "minimax-token-plan-mcp";
const DEFAULT_MINIMAX_API_HOST = "https://api.minimaxi.com";
const DEFAULT_MINIMAX_MCP_COMMAND = "uvx";
const DEFAULT_MINIMAX_MCP_ARGS = ["minimax-coding-plan-mcp", "-y"] as const;

export interface ImageUnderstandingInput {
  imagePath: string;
  prompt: string;
}

export interface ImageUnderstandingClient {
  understandImage(input: ImageUnderstandingInput): Promise<string>;
}

export interface MiniMaxTokenPlanMcpConfig {
  apiKey: string | null;
  apiHost: string;
  command: string;
  args: string[];
}

interface ToolContentBlock {
  type: string;
  text?: string;
  resource?: {
    text?: string;
  };
}

interface ConnectedClient {
  client: Client;
  transport: StdioClientTransport;
}

function inheritStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

function attachTransportStderrLogging(stderr: Stream | null) {
  if (!stderr || !("setEncoding" in stderr) || !("on" in stderr)) {
    return;
  }

  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string | Buffer) => {
    const message = String(chunk).trim();
    if (!message) {
      return;
    }

    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        log.warn(TAG, "MiniMax MCP stderr", { line: trimmed });
      }
    }
  });
}

export function resolveMiniMaxTokenPlanMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): MiniMaxTokenPlanMcpConfig {
  const apiKey = env.MINIMAX_API_KEY?.trim() || null;
  const apiHost = env.MINIMAX_API_HOST?.trim() || DEFAULT_MINIMAX_API_HOST;
  const command = env.MINIMAX_MCP_COMMAND?.trim() || DEFAULT_MINIMAX_MCP_COMMAND;

  return {
    apiKey,
    apiHost,
    command,
    args: [...DEFAULT_MINIMAX_MCP_ARGS],
  };
}

export function extractToolTextContent(content: ToolContentBlock[]): string {
  return content
    .flatMap((block) => {
      if (block.type === "text" && block.text) {
        return [block.text.trim()];
      }

      if (block.type === "resource" && block.resource?.text) {
        return [block.resource.text.trim()];
      }

      return [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildUnderstandImageToolArguments(input: ImageUnderstandingInput): {
  prompt: string;
  image_source: string;
} {
  return {
    prompt: input.prompt,
    image_source: input.imagePath,
  };
}

export class MiniMaxTokenPlanMcpClient implements ImageUnderstandingClient {
  private connectionPromise: Promise<ConnectedClient> | null = null;

  constructor(
    private readonly config: MiniMaxTokenPlanMcpConfig,
  ) {}

  async understandImage(input: ImageUnderstandingInput): Promise<string> {
    const { client } = await this.ensureConnected();

    log.info(TAG, "Calling understand_image", {
      imagePath: input.imagePath,
      command: this.config.command,
      apiHost: this.config.apiHost,
    });

    const result = await client.callTool({
      name: "understand_image",
      arguments: buildUnderstandImageToolArguments(input),
    });

    const text = extractToolTextContent(result.content as ToolContentBlock[]);
    if (!text) {
      throw new Error("MiniMax understand_image returned empty content");
    }

    return text;
  }

  async close(): Promise<void> {
    if (!this.connectionPromise) {
      return;
    }

    const connection = await this.connectionPromise.catch(() => null);
    this.connectionPromise = null;

    if (connection) {
      await connection.transport.close();
    }
  }

  private async ensureConnected(): Promise<ConnectedClient> {
    if (!this.connectionPromise) {
      this.connectionPromise = this.connect().catch((error) => {
        this.connectionPromise = null;
        throw error;
      });
    }

    return this.connectionPromise;
  }

  private async connect(): Promise<ConnectedClient> {
    if (!this.config.apiKey) {
      throw new Error("MINIMAX_API_KEY is not set");
    }

    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      stderr: "pipe",
      env: {
        ...inheritStringEnv(process.env),
        MINIMAX_API_KEY: this.config.apiKey,
        MINIMAX_API_HOST: this.config.apiHost,
      },
    });

    attachTransportStderrLogging(transport.stderr);
    transport.onerror = (error) => {
      log.error(TAG, "MiniMax MCP transport error", error);
    };
    transport.onclose = () => {
      log.warn(TAG, "MiniMax MCP transport closed");
      this.connectionPromise = null;
    };

    const client = new Client(
      {
        name: "octo-minimax-image-preprocessor",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    log.info(TAG, "MiniMax MCP client connected", {
      command: this.config.command,
      apiHost: this.config.apiHost,
      tools: toolNames,
    });

    if (!toolNames.includes("understand_image")) {
      await transport.close();
      throw new Error("MiniMax MCP tool understand_image is unavailable");
    }

    return { client, transport };
  }
}

export const __test__ = {
  buildUnderstandImageToolArguments,
  DEFAULT_MINIMAX_API_HOST,
  DEFAULT_MINIMAX_MCP_COMMAND,
  DEFAULT_MINIMAX_MCP_ARGS,
  extractToolTextContent,
  resolveMiniMaxTokenPlanMcpConfig,
};
