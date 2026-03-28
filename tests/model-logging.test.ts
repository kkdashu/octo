import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "node:http";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import { AnthropicLoggingProxyManager } from "../src/runtime/anthropic-logging-proxy";
import { MAX_MODEL_LOG_BYTES, writeModelLog } from "../src/runtime/model-logger";
import { OpenAIProxyManager } from "../src/runtime/openai-proxy";
import type { ResolvedAgentProfile } from "../src/runtime/types";

const originalEnv = { ...process.env };

function readGroupLogEntries(logDir: string, groupFolder: string): Array<Record<string, unknown>> {
  const groupDir = join(logDir, "model", groupFolder);
  const files = readdirSync(groupDir).sort();

  return files.flatMap((fileName) => {
    const raw = readFileSync(join(groupDir, fileName), "utf-8").trim();
    if (!raw) {
      return [];
    }
    return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind test server"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requestRaw(
  url: string,
  options: {
    method: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string | Buffer;
  },
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body === undefined
      ? undefined
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body);
    const headers: http.OutgoingHttpHeaders = {
      ...(options.headers ?? {}),
    };

    if (body && headers["content-length"] === undefined) {
      headers["content-length"] = String(body.byteLength);
    }

    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });

    req.on("error", reject);

    if (body) {
      req.end(body);
      return;
    }

    req.end();
  });
}

describe("model logger", () => {
  let logDir = "";

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "octo-model-log-"));
    process.env.LOG_DIR = logDir;
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("writes per-group logs and rotates after 80MB", () => {
    const now = new Date("2026-03-28T10:00:00.000Z");
    const mainDir = join(logDir, "model", "main");
    mkdirSync(mainDir, { recursive: true });

    const primaryPath = join(mainDir, "octo-model-2026-03-28.jsonl");
    closeSync(openSync(primaryPath, "w"));
    truncateSync(primaryPath, MAX_MODEL_LOG_BYTES - 8);

    writeModelLog({
      requestId: "req-main",
      routeType: "anthropic_direct",
      stage: "sdk_request",
      profileKey: "kimi",
      provider: "moonshot",
      model: "kimi-k2.5",
      groupFolder: "main",
      url: "https://api.moonshot.cn/anthropic/v1/messages",
      method: "POST",
      stream: false,
      headers: {
        authorization: "Bearer sk-secret-token-1234",
      },
      body: {
        hello: "world",
      },
    }, now);

    writeModelLog({
      requestId: "req-other",
      routeType: "anthropic_direct",
      stage: "sdk_request",
      profileKey: "minimax",
      provider: "minimax",
      model: "MiniMax-M2.7",
      groupFolder: "group-b",
      url: "https://api.minimaxi.com/anthropic/v1/messages",
      method: "POST",
      stream: false,
      body: {
        prompt: "ping",
      },
    }, now);

    expect(readdirSync(mainDir).sort()).toEqual([
      "octo-model-2026-03-28.1.jsonl",
      "octo-model-2026-03-28.jsonl",
    ]);
    expect(readdirSync(join(logDir, "model", "group-b"))).toEqual([
      "octo-model-2026-03-28.jsonl",
    ]);

    const rotatedEntry = JSON.parse(
      readFileSync(join(mainDir, "octo-model-2026-03-28.1.jsonl"), "utf-8").trim(),
    ) as Record<string, unknown>;
    expect((rotatedEntry.headers as Record<string, string>).authorization).toContain("***");
    expect((rotatedEntry.headers as Record<string, string>).authorization).not.toContain("secret-token-1234");
    expect(rotatedEntry.body).toEqual({ hello: "world" });
  });
});

describe("anthropic logging proxy", () => {
  let logDir = "";

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "octo-anthropic-proxy-"));
    process.env.LOG_DIR = logDir;
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("logs full non-stream anthropic requests per group", async () => {
    let upstreamPath = "";
    let upstreamAuth = "";
    let upstreamBody: Record<string, unknown> | null = null;

    const upstreamServer = http.createServer((req, res) => {
      upstreamPath = req.url || "";
      upstreamAuth = req.headers["x-api-key"] as string;

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;

        const payload = JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "kimi-k2.5",
          content: [{ type: "text", text: "hello from kimi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 4 },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      });
    });

    const port = await listen(upstreamServer);
    const manager = new AnthropicLoggingProxyManager();
    await manager.start();

    try {
      const route = manager.acquire({
        profileKey: "kimi",
        apiFormat: "anthropic",
        baseUrl: `http://127.0.0.1:${port}/anthropic`,
        apiKeyEnv: "MOONSHOT_API_KEY",
        apiKey: "moonshot-upstream-key",
        model: "kimi-k2.5",
        provider: "moonshot",
        codingPlanEnabled: false,
      }, "main");

      const response = await fetch(`${route.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": route.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "kimi-k2.5",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(((body.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>).text).toBe("hello from kimi");
      expect(upstreamPath).toBe("/anthropic/v1/messages");
      expect(upstreamAuth).toBe("moonshot-upstream-key");
      expect(upstreamBody?.messages).toBeDefined();

      const entries = readGroupLogEntries(logDir, "main");
      expect(entries.map((entry) => entry.stage)).toEqual([
        "sdk_request",
        "upstream_request",
        "upstream_response",
      ]);
      expect(entries[0].url).toBe(`http://127.0.0.1:${port}/anthropic/v1/messages`);
      expect((entries[1].headers as Record<string, string>)["x-api-key"]).toContain("***");
    } finally {
      await manager.stop();
      await closeServer(upstreamServer);
    }
  });

  test("preserves compressed non-stream responses while logging decoded body", async () => {
    const payload = {
      id: "msg_br",
      type: "message",
      role: "assistant",
      model: "MiniMax-M2.7",
      content: [{ type: "text", text: "brotli payload" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4 },
    };
    const compressedPayload = brotliCompressSync(Buffer.from(JSON.stringify(payload)));

    const upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "br",
        "content-length": String(compressedPayload.byteLength),
      });
      res.end(compressedPayload);
    });

    const port = await listen(upstreamServer);
    const manager = new AnthropicLoggingProxyManager();
    await manager.start();

    try {
      const route = manager.acquire({
        profileKey: "minimax",
        apiFormat: "anthropic",
        baseUrl: `http://127.0.0.1:${port}/anthropic`,
        apiKeyEnv: "MINIMAX_API_KEY",
        apiKey: "minimax-upstream-key",
        model: "MiniMax-M2.7",
        provider: "minimax",
        codingPlanEnabled: false,
      }, "compressed-group");

      const response = await requestRaw(`${route.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": route.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "MiniMax-M2.7",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          stream: false,
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBe("br");
      expect(response.body.equals(compressedPayload)).toBe(true);
      expect(
        JSON.parse(brotliDecompressSync(response.body).toString("utf-8")) as Record<string, unknown>,
      ).toEqual(payload);

      const entries = readGroupLogEntries(logDir, "compressed-group");
      expect(entries.map((entry) => entry.stage)).toEqual([
        "sdk_request",
        "upstream_request",
        "upstream_response",
      ]);
      expect(entries[2]?.body).toEqual(payload);
    } finally {
      await manager.stop();
      await closeServer(upstreamServer);
    }
  });

  test("logs stream chunks for anthropic direct upstreams", async () => {
    const upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const port = await listen(upstreamServer);
    const manager = new AnthropicLoggingProxyManager();
    await manager.start();

    try {
      const route = manager.acquire({
        profileKey: "minimax",
        apiFormat: "anthropic",
        baseUrl: `http://127.0.0.1:${port}/anthropic`,
        apiKeyEnv: "MINIMAX_API_KEY",
        apiKey: "minimax-upstream-key",
        model: "MiniMax-M2.7",
        provider: "minimax",
        codingPlanEnabled: false,
      }, "stream-group");

      const response = await fetch(`${route.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": route.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "MiniMax-M2.7",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("message_start");

      const entries = readGroupLogEntries(logDir, "stream-group");
      expect(entries.some((entry) => entry.stage === "upstream_stream_chunk")).toBe(true);
      expect(entries.at(-1)?.stage).toBe("upstream_response");
    } finally {
      await manager.stop();
      await closeServer(upstreamServer);
    }
  });
});

describe("openai proxy model logging", () => {
  let logDir = "";

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "octo-openai-proxy-"));
    process.env.LOG_DIR = logDir;
    process.env.OPENAI_PROXY_PORT = "0";
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("logs anthropic input, openai upstream request, and proxy response", async () => {
    let upstreamPath = "";
    let upstreamAuth = "";
    let upstreamBody: Record<string, unknown> | null = null;

    const upstreamServer = http.createServer((req, res) => {
      upstreamPath = req.url || "";
      upstreamAuth = req.headers.authorization as string;

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;

        const payload = JSON.stringify({
          id: "chatcmpl_1",
          model: "gpt-5.4",
          choices: [
            {
              message: {
                role: "assistant",
                content: "hello from codex",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 7,
          },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      });
    });

    const port = await listen(upstreamServer);
    const manager = new OpenAIProxyManager();
    await manager.start();

    const upstreamProfile: ResolvedAgentProfile = {
      profileKey: "codex",
      apiFormat: "openai",
      upstreamApi: "chat_completions",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "OPENAI_API_KEY",
      apiKey: "openai-upstream-key",
      model: "gpt-5.4",
      provider: "openai",
      codingPlanEnabled: false,
    };

    try {
      const route = manager.acquire(upstreamProfile, "openai-group");
      const response = await fetch(`${route.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": route.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: [{ type: "text", text: "hello proxy" }] }],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(((body.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>).text).toBe("hello from codex");
      expect(upstreamPath).toBe("/v1/chat/completions");
      expect(upstreamAuth).toBe("Bearer openai-upstream-key");
      expect(upstreamBody?.messages).toEqual([
        { role: "user", content: "hello proxy" },
      ]);

      const entries = readGroupLogEntries(logDir, "openai-group");
      expect(entries.map((entry) => entry.stage)).toEqual([
        "sdk_request",
        "upstream_request",
        "upstream_response",
        "proxy_response",
      ]);
      expect(entries[1].url).toBe(`http://127.0.0.1:${port}/v1/chat/completions`);
      expect((entries[1].body as Record<string, unknown>).messages).toEqual([
        { role: "user", content: "hello proxy" },
      ]);
    } finally {
      await manager.stop();
      await closeServer(upstreamServer);
    }
  });
});
