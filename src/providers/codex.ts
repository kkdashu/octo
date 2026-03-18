import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent } from "@openai/codex-sdk";
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { log } from "../logger";
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  SessionConfig,
} from "./types";

const TAG = "codex-provider";

/**
 * Create a wrapper script that cd's into the target directory before
 * executing the real codex binary. This ensures Codex CLI discovers
 * AGENTS.md and .agents/skills/ from the correct working directory.
 */
function ensureWrapper(): string {
  const wrapperPath = resolve("store", "codex-wrapper.sh");
  if (!existsSync(wrapperPath)) {
    writeFileSync(
      wrapperPath,
      '#!/bin/sh\ncd "$CODEX_WORKING_DIR" && exec "$CODEX_REAL_PATH" "$@"\n',
    );
    chmodSync(wrapperPath, 0o755);
    log.info(TAG, `Created codex wrapper script at ${wrapperPath}`);
  }
  return wrapperPath;
}

/** Find the real codex binary path (same logic as the SDK's findCodexPath) */
function findRealCodexPath(): string {
  const { platform, arch } = process;
  const tripleMap: Record<string, Record<string, string>> = {
    darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
    linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  };
  const triple = tripleMap[platform]?.[arch];
  if (!triple) throw new Error(`Unsupported platform: ${platform} ${arch}`);

  const pkgMap: Record<string, string> = {
    "x86_64-apple-darwin": "@openai/codex-darwin-x64",
    "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
    "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
    "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
    "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
    "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
  };

  const moduleRequire = createRequire(import.meta.url);
  const codexPkgJson = moduleRequire.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPkgJson);
  const platformPkgJson = codexRequire.resolve(`${pkgMap[triple]}/package.json`);
  const vendorRoot = join(dirname(platformPkgJson), "vendor");
  const binaryName = platform === "win32" ? "codex.exe" : "codex";
  return join(vendorRoot, triple, "codex", binaryName);
}

export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  private wrapperPath: string;
  private realCodexPath: string;
  private mcpServerScript: string;

  constructor() {
    this.wrapperPath = ensureWrapper();
    this.realCodexPath = findRealCodexPath();
    this.mcpServerScript = resolve("src", "mcp-stdio-server.ts");
    this.ensureMcpServer();
    log.info(TAG, `Codex wrapper: ${this.wrapperPath}, binary: ${this.realCodexPath}`);
  }

  /** Register octo-tools MCP server in ~/.codex/config.toml if not already present */
  private ensureMcpServer() {
    const configPath = join(process.env.HOME ?? "~", ".codex", "config.toml");
    if (existsSync(configPath)) {
      const content = require("fs").readFileSync(configPath, "utf-8");
      if (content.includes("[mcp_servers.octo-tools]")) {
        log.info(TAG, "octo-tools MCP server already registered in ~/.codex/config.toml");
        return;
      }
    }
    log.info(TAG, `Registering octo-tools MCP server via codex mcp add`);
    const result = spawnSync("codex", ["mcp", "add", "octo-tools", "--", "bun", this.mcpServerScript], {
      stdio: "pipe",
      env: process.env as Record<string, string>,
    });
    if (result.status === 0) {
      log.info(TAG, "octo-tools MCP server registered successfully");
    } else {
      log.error(TAG, `Failed to register MCP server: ${result.stderr?.toString()}`);
    }
  }

  async startSession(config: SessionConfig): Promise<{
    session: AgentSession;
    events: AsyncIterable<AgentEvent>;
  }> {
    log.info(TAG, `=== Starting session for group: ${config.groupFolder} ===`, {
      groupFolder: config.groupFolder,
      isMain: config.isMain,
      hasResume: !!config.resumeSessionId,
      promptLength: config.initialPrompt.length,
    });

    // Per-session Codex client: wrapper script cd's into the group directory
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.CODEX_WORKING_DIR = config.workingDirectory;
    env.CODEX_REAL_PATH = this.realCodexPath;
    env.OCTO_DB_PATH = resolve("store", "messages.db");
    env.OCTO_ROOT = resolve(".");
    env.OCTO_INTERNAL_API = `http://localhost:${process.env.INTERNAL_PORT || 9800}`;
    env.OCTO_GROUP_FOLDER = config.groupFolder;
    env.OCTO_IS_MAIN = config.isMain ? "1" : "0";

    const client = new Codex({
      codexPathOverride: this.wrapperPath,
      env,
      config: { approval_policy: "never" },
    });

    const threadOptions = {
      ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
      sandboxMode: "danger-full-access" as const,
      workingDirectory: config.workingDirectory,
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
    };

    const thread = config.resumeSessionId
      ? client.resumeThread(config.resumeSessionId, threadOptions)
      : client.startThread(threadOptions);

    const pendingMessages: string[] = [];
    let closed = false;
    let resolveWaiting: (() => void) | null = null;

    function push(text: string) {
      if (closed) return;
      pendingMessages.push(text);
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    }

    function close() {
      closed = true;
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    }

    async function* eventStream(): AsyncGenerator<AgentEvent> {
      yield* runTurn(config.initialPrompt);

      while (!closed) {
        if (pendingMessages.length === 0) {
          await new Promise<void>((r) => {
            if (pendingMessages.length > 0 || closed) { r(); return; }
            resolveWaiting = r;
          });
        }
        if (closed && pendingMessages.length === 0) break;

        const msgs = pendingMessages.splice(0, pendingMessages.length);
        if (msgs.length > 0) yield* runTurn(msgs.join("\n\n"));
      }
    }

    async function* runTurn(prompt: string): AsyncGenerator<AgentEvent> {
      log.info(TAG, `Running turn for ${config.groupFolder}`, {
        promptLength: prompt.length,
        promptPreview: prompt.substring(0, 200),
      });
      try {
        const { events } = await thread.runStreamed(prompt);
        for await (const event of events) {
          const agentEvent = normalizeEvent(event, thread.id);
          if (agentEvent) yield agentEvent;
        }
      } catch (err) {
        log.error(TAG, `Turn error for ${config.groupFolder}`, err);
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      }
    }

    return { session: { push, close }, events: eventStream() };
  }
}

function normalizeEvent(event: ThreadEvent, threadId: string | null): AgentEvent | null {
  switch (event.type) {
    case "item.completed":
      if (event.item.type === "agent_message" && event.item.text) {
        return { type: "text", text: event.item.text };
      }
      break;
    case "turn.completed":
      return { type: "result", sessionId: threadId ?? undefined };
    case "turn.failed":
      return { type: "error", error: new Error(event.error.message) };
    case "error":
      return { type: "error", error: new Error(event.message) };
  }
  return null;
}
