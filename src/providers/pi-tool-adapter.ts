import {
  defineTool,
  type ToolDefinition as PiToolDefinition,
} from "../../pi-mono/packages/coding-agent/src/index.ts";
import type { ToolDefinition as OctoToolDefinition } from "./types";

export const OCTO_TOOL_PREFIX = "mcp__octo-tools__";

export function toPiToolName(toolName: string): string {
  return `${OCTO_TOOL_PREFIX}${toolName}`;
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
          content: result.content,
          details: {},
        };
      },
    }),
  );
}
