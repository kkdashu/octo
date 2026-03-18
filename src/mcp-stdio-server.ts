#!/usr/bin/env bun
/**
 * Standalone stdio MCP server for Codex integration.
 *
 * Reuses the same tool definitions from tools.ts — no duplicate handler logic.
 * The only difference is how messages are sent (HTTP to main process instead of in-process).
 *
 * IMPORTANT: stdout is reserved for MCP JSON-RPC. All logging must go to stderr.
 */

// Redirect console.log/info to stderr before any imports (logger uses console.log)
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createGroupToolDefs, type MessageSender } from "./tools";

// Resolve project root from script location (src/mcp-stdio-server.ts → project root)
const OCTO_ROOT = join(import.meta.dir, "..");
const DB_PATH = join(OCTO_ROOT, "store", "messages.db");
const INTERNAL_PORT = process.env.INTERNAL_PORT || "9800";
const INTERNAL_API = `http://localhost:${INTERNAL_PORT}`;

const db = new Database(DB_PATH, { strict: true });

// ---------------------------------------------------------------------------
// HTTP-based MessageSender (forwards to main process)
// ---------------------------------------------------------------------------

const httpSender: MessageSender = {
  async send(chatJid: string, text: string) {
    await fetch(`${INTERNAL_API}/internal/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatJid, text }),
    });
  },
  async sendImage(chatJid: string, filePath: string) {
    await fetch(`${INTERNAL_API}/internal/send-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatJid, filePath }),
    });
  },
  async refreshGroupMetadata() {
    const res = await fetch(`${INTERNAL_API}/internal/refresh-groups`, { method: "POST" });
    return (await res.json()) as { count: number };
  },
};

// ---------------------------------------------------------------------------
// MCP Server — wraps ToolDefinition[] from tools.ts into MCP protocol
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "octo-tools", version: "1.0.0" });

// The MCP server doesn't know the groupFolder at init time — Codex passes it per-call.
// We register tools that accept groupFolder as a parameter, and delegate to tools.ts handlers.

// First, get all tools for "main" group to have the full set available.
// The groupFolder is dynamic (passed by the agent), so we create tools with a placeholder
// and re-resolve per call.

// Helper: create a lazy tool resolver
function registerMcpTools() {
  // We need groupFolder per-call. Strategy: register each tool with an extra groupFolder param,
  // create the real handler on the fly by calling createGroupToolDefs.
  // For efficiency, cache the tool defs per groupFolder.
  const toolCache = new Map<string, Map<string, (args: Record<string, unknown>) => Promise<any>>>();

  function getHandler(groupFolder: string, toolName: string) {
    let handlers = toolCache.get(groupFolder);
    if (!handlers) {
      const isMain = true; // Give all tools — permission is checked inside handlers
      const tools = createGroupToolDefs(groupFolder, isMain, db, httpSender, OCTO_ROOT);
      handlers = new Map(tools.map((t) => [t.name, t.handler]));
      toolCache.set(groupFolder, handlers);
    }
    return handlers.get(toolName);
  }

  // Get tool definitions for schema reference (use "main" as placeholder)
  const allTools = createGroupToolDefs("_schema", true, db, httpSender, OCTO_ROOT);

  for (const toolDef of allTools) {
    // Add groupFolder parameter to each tool's schema
    const props = (toolDef.schema.properties ?? {}) as Record<string, unknown>;
    const required = (toolDef.schema.required ?? []) as string[];

    const zodSchema: Record<string, z.ZodType> = {
      groupFolder: z.string().describe("Current group folder name"),
    };
    for (const [key, prop] of Object.entries(props)) {
      const p = prop as Record<string, unknown>;
      let field: z.ZodType;
      if (p.enum) {
        field = z.enum(p.enum as [string, ...string[]]);
      } else {
        field = z.string();
      }
      if (p.description) field = (field as z.ZodString).describe(p.description as string);
      if (p.default !== undefined) field = field.default(p.default);
      if (!required.includes(key) && p.default === undefined) field = field.optional();
      zodSchema[key] = field;
    }

    server.tool(toolDef.name, toolDef.description, zodSchema, async (args) => {
      const groupFolder = args.groupFolder as string;
      const handler = getHandler(groupFolder, toolDef.name);
      if (!handler) {
        return { content: [{ type: "text" as const, text: `Tool not found: ${toolDef.name}` }] };
      }
      // Remove groupFolder from args before passing to handler (it's not in the original schema)
      const { groupFolder: _, ...toolArgs } = args;
      return handler(toolArgs);
    });
  }
}

registerMcpTools();

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
