import {
  defineTool,
  type ToolDefinition as PiToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type {
  ToolContentBlock,
  ToolDefinition as OctoToolDefinition,
} from "./types";

export const OCTO_TOOL_PREFIX = "mcp__octo-tools__";

export function toPiToolName(toolName: string): string {
  return `${OCTO_TOOL_PREFIX}${toolName}`;
}

function normalizePiToolContent(content: ToolContentBlock[]): Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
> {
  return content.map((block) => {
    if (block.type === "text" || block.type === "image") {
      return block;
    }

    if (block.type === "resource") {
      return {
        type: "text",
        text: block.resource.text?.trim() || `[resource] ${block.resource.uri}`,
      };
    }

    return {
      type: "text",
      text: block.description
        ? `${block.name}: ${block.description} (${block.uri})`
        : `${block.name} (${block.uri})`,
    };
  });
}

export function adaptOctoTools(
  tools: OctoToolDefinition[],
): PiToolDefinition[] {
  return tools.map((tool) =>
    defineTool({
      name: toPiToolName(tool.name),
      label: tool.name,
      description: tool.description,
      parameters: tool.schema as never,
      async execute(_toolCallId, params) {
        const result = await tool.handler(params as Record<string, unknown>);
        return {
          content: normalizePiToolContent(result.content),
          details: {},
        };
      },
    }),
  );
}
