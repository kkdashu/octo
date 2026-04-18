import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "octo-fake-mcp",
  version: "1.0.0",
});

server.tool(
  "echo_content",
  "Return deterministic MCP content for integration tests",
  {
    text: z.string(),
    mode: z.enum(["text", "resource", "resource_link", "image"]).optional(),
  },
  async ({ text, mode = "text" }) => {
    switch (mode) {
      case "resource":
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `file:///tmp/${text}.txt`,
                text: `resource:${text}`,
              },
            },
          ],
        };
      case "resource_link":
        return {
          content: [
            {
              type: "resource_link",
              name: "artifact",
              uri: `file:///tmp/${text}.txt`,
              description: `linked:${text}`,
            },
          ],
        };
      case "image":
        return {
          content: [
            {
              type: "image",
              data: Buffer.from(`image:${text}`, "utf8").toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      default:
        return {
          content: [{ type: "text", text: `echo:${text}` }],
        };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
