import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "../../pi-mono/packages/coding-agent/src/index.ts";
import { log } from "../logger";
import type { ExternalMcpServerSpec } from "./types";

const TAG = "pi-mcp-extension";

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; name: string; uri: string; description?: string };

type McpListedTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpBridge = {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpListedTool[];
};

export interface PiMcpExtensionBundle {
  extensionFactories: ExtensionFactory[];
  dispose(): Promise<void>;
}

function normalizeMcpContent(content: McpContent[]): Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
> {
  const normalized: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];

  for (const block of content) {
    if (block.type === "text") {
      normalized.push(block);
      continue;
    }

    if (block.type === "image") {
      normalized.push(block);
      continue;
    }

    if (block.type === "resource") {
      normalized.push({
        type: "text",
        text: "text" in block.resource && block.resource.text
          ? block.resource.text
          : `[resource] ${block.resource.uri}`,
      });
      continue;
    }

    normalized.push({
      type: "text",
      text: block.description
        ? `${block.name}: ${block.description} (${block.uri})`
        : `${block.name} (${block.uri})`,
    });
  }

  return normalized;
}

async function createBridge(
  serverName: string,
  serverSpec: ExternalMcpServerSpec,
  cwd: string,
): Promise<McpBridge> {
  const transport = new StdioClientTransport({
    command: serverSpec.command,
    args: serverSpec.args,
    cwd,
    env: {
      ...process.env,
      ...(serverSpec.env ?? {}),
    },
    stderr: "pipe",
  });

  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk) => {
      log.warn(TAG, `MCP stderr from ${serverName}`, {
        serverName,
        stderr: String(chunk).trim(),
      });
    });
  }

  const client = new Client({
    name: "octo-mcp-bridge",
    version: "1.0.0",
  });

  await client.connect(transport);
  const listedTools = await client.listTools();

  return {
    serverName,
    client,
    transport,
    tools: listedTools.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function createExtensionFactory(bridges: McpBridge[]): ExtensionFactory {
  return async (pi) => {
    for (const bridge of bridges) {
      for (const tool of bridge.tools) {
        const definition: ToolDefinition = defineTool({
          name: `mcp__${bridge.serverName}__${tool.name}`,
          label: `${bridge.serverName}:${tool.name}`,
          description: tool.description ?? `MCP tool ${tool.name}`,
          parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
          async execute(_toolCallId, params) {
            const result = await bridge.client.callTool({
              name: tool.name,
              arguments: params as Record<string, unknown>,
            });

            if ("toolResult" in result) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result.toolResult, null, 2),
                  },
                ],
                details: {},
              };
            }

            return {
              content: normalizeMcpContent(result.content as McpContent[]),
              details: {},
            };
          },
        });

        pi.registerTool(definition);
      }
    }
  };
}

export async function createPiMcpExtensionBundle(
  servers: Record<string, ExternalMcpServerSpec> | undefined,
  cwd: string,
): Promise<PiMcpExtensionBundle> {
  const entries = Object.entries(servers ?? {});
  if (entries.length === 0) {
    return {
      extensionFactories: [],
      async dispose() {},
    };
  }

  const bridges = await Promise.all(
    entries.map(([serverName, serverSpec]) => createBridge(serverName, serverSpec, cwd)),
  );

  return {
    extensionFactories: [createExtensionFactory(bridges)],
    async dispose() {
      await Promise.allSettled(bridges.map((bridge) => bridge.client.close()));
    },
  };
}
