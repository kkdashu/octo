import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { log } from "../logger";
import { writeModelLog } from "./model-logger";
import type { ProxyRouteHandle, ResolvedAgentProfile } from "./types";

const TAG = "anthropic-logging-proxy";
const LOCAL_HOST = "127.0.0.1";
const PROXY_BIND_HOST = "127.0.0.1";

type AnthropicProxyRoute = {
  routeId: string;
  apiKey: string;
  upstream: ResolvedAgentProfile;
  groupFolder: string;
};

function createAnthropicErrorBody(message: string, type = "api_error"): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

function writeJSON(res: http.ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readHeaderValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function readRequestBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > 20 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function tryParseJSON(raw: string): unknown {
  if (!raw) {
    return "";
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function copyRequestHeaders(
  headers: http.IncomingHttpHeaders,
  bodyByteLength: number,
): http.OutgoingHttpHeaders {
  const copied: http.OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (key === "host") {
      continue;
    }

    if (value === undefined) {
      continue;
    }

    copied[key] = value;
  }

  if (bodyByteLength > 0 && copied["content-length"] === undefined) {
    copied["content-length"] = String(bodyByteLength);
  }

  return copied;
}

function applyUpstreamAuth(
  headers: http.OutgoingHttpHeaders,
  incomingHeaders: http.IncomingHttpHeaders,
  apiKey: string,
): void {
  delete headers.authorization;
  delete headers["x-api-key"];
  delete headers["anthropic-api-key"];

  if (readHeaderValue(incomingHeaders, "authorization")) {
    headers.authorization = `Bearer ${apiKey}`;
    return;
  }

  if (
    readHeaderValue(incomingHeaders, "x-api-key") ||
    readHeaderValue(incomingHeaders, "anthropic-api-key")
  ) {
    headers["x-api-key"] = apiKey;
    return;
  }

  headers["x-api-key"] = apiKey;
}

function buildTargetURL(baseUrl: string, routePath: string, search: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const normalizedPath = routePath === "/" ? "" : routePath;
  return `${normalizedBaseUrl}${normalizedPath}${search}`;
}

function copyResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const copied: http.OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    copied[key] = value;
  }

  return copied;
}

function normalizeContentEncoding(contentEncoding: string | null): string {
  return contentEncoding?.split(",")[0]?.trim().toLowerCase() ?? "";
}

function decodeBufferForLogging(
  rawBody: Buffer,
  contentEncoding: string | null,
): {
  body: unknown;
  meta?: Record<string, unknown>;
} {
  const normalizedEncoding = normalizeContentEncoding(contentEncoding);

  try {
    let decoded: Buffer;

    switch (normalizedEncoding) {
      case "":
      case "identity":
        decoded = rawBody;
        break;
      case "br":
        decoded = brotliDecompressSync(rawBody);
        break;
      case "gzip":
        decoded = gunzipSync(rawBody);
        break;
      case "deflate":
        decoded = inflateSync(rawBody);
        break;
      default:
        return {
          body: rawBody.toString("utf-8"),
          meta: {
            contentEncoding: normalizedEncoding,
            decodeError: `Unsupported content encoding: ${normalizedEncoding}`,
          },
        };
    }

    return { body: tryParseJSON(decoded.toString("utf-8")) };
  } catch (error) {
    return {
      body: rawBody.toString("utf-8"),
      meta: {
        contentEncoding: normalizedEncoding,
        decodeError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function createUpstreamRequest(
  targetUrl: URL,
  method: string,
  headers: http.OutgoingHttpHeaders,
  onResponse: (response: http.IncomingMessage) => void,
): http.ClientRequest {
  const client = targetUrl.protocol === "https:" ? https : http;
  return client.request({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || undefined,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method,
    headers,
  }, onResponse);
}

export class AnthropicLoggingProxyManager {
  private server: http.Server | null = null;
  private port: number | null = null;
  private lastProxyError: string | null = null;
  private readonly routes = new Map<string, AnthropicProxyRoute>();

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch((error) => {
          const message = error instanceof Error ? error.message : "Internal proxy error";
          this.lastProxyError = message;
          log.error(TAG, "Proxy request failed", error);
          if (!res.headersSent) {
            writeJSON(res, 500, createAnthropicErrorBody(message));
          } else {
            res.end();
          }
        });
      });

      server.on("error", (error) => {
        this.lastProxyError = error.message;
        reject(error);
      });

      server.listen(0, PROXY_BIND_HOST, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to bind Anthropic logging proxy port"));
          return;
        }

        this.server = server;
        this.port = addr.port;
        this.lastProxyError = null;
        log.info(TAG, "Anthropic logging proxy started", { port: this.port });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.port = null;
    this.routes.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  acquire(upstream: ResolvedAgentProfile, groupFolder: string): ProxyRouteHandle {
    if (upstream.apiFormat !== "anthropic") {
      throw new Error(`Profile "${upstream.profileKey}" does not use the Anthropic logging proxy.`);
    }
    if (!this.server || !this.port) {
      throw new Error("Anthropic logging proxy has not been started.");
    }

    const routeId = crypto.randomUUID();
    const apiKey = `octo-anthropic-proxy-${routeId}`;
    this.routes.set(routeId, { routeId, apiKey, upstream, groupFolder });

    log.info(TAG, "Proxy route acquired", {
      routeId,
      groupFolder,
      profileKey: upstream.profileKey,
      baseUrl: upstream.baseUrl,
      model: upstream.model,
    });

    return {
      routeId,
      apiKey,
      baseUrl: `http://${LOCAL_HOST}:${this.port}/proxy/${routeId}`,
      release: () => {
        if (this.routes.delete(routeId)) {
          log.info(TAG, "Proxy route released", {
            routeId,
            groupFolder,
            profileKey: upstream.profileKey,
          });
        }
      },
    };
  }

  private resolveRoute(pathname: string): AnthropicProxyRoute | null {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== "proxy") {
      return null;
    }
    return this.routes.get(segments[1]!) ?? null;
  }

  private matchesRouteAuth(req: http.IncomingMessage, route: AnthropicProxyRoute): boolean {
    const xApiKey = readHeaderValue(req.headers, "x-api-key");
    if (xApiKey) {
      return xApiKey === route.apiKey;
    }

    const authorization = readHeaderValue(req.headers, "authorization");
    if (authorization?.startsWith("Bearer ")) {
      return authorization.slice("Bearer ".length).trim() === route.apiKey;
    }

    return true;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = (req.method || "GET").toUpperCase();
    const url = new URL(req.url || "/", `http://${LOCAL_HOST}`);

    if (method === "GET" && url.pathname === "/healthz") {
      writeJSON(res, 200, {
        ok: true,
        running: Boolean(this.server),
        routeCount: this.routes.size,
        lastError: this.lastProxyError,
      });
      return;
    }

    const route = this.resolveRoute(url.pathname);
    if (!route) {
      writeJSON(res, 404, createAnthropicErrorBody("Not found", "not_found_error"));
      return;
    }

    if (!this.matchesRouteAuth(req, route)) {
      writeJSON(res, 401, createAnthropicErrorBody("Invalid proxy API key", "authentication_error"));
      return;
    }

    const requestId = crypto.randomUUID();
    const routePath = url.pathname.replace(`/proxy/${route.routeId}`, "") || "/";
    const targetUrl = buildTargetURL(route.upstream.baseUrl, routePath, url.search);

    let requestBodyBuffer = Buffer.alloc(0);
    try {
      requestBodyBuffer = await readRequestBodyBuffer(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request body";
      writeModelLog({
        requestId,
        routeType: "anthropic_direct",
        stage: "error",
        profileKey: route.upstream.profileKey,
        provider: route.upstream.provider,
        model: route.upstream.model,
        groupFolder: route.groupFolder,
        url: targetUrl,
        method,
        stream: false,
        headers: req.headers,
        body: { message },
      });
      writeJSON(res, 400, createAnthropicErrorBody(message, "invalid_request_error"));
      return;
    }

    const requestBodyRaw = requestBodyBuffer.toString("utf-8");
    const parsedRequestBody = tryParseJSON(requestBodyRaw);
    const stream = Boolean(
      parsedRequestBody &&
      typeof parsedRequestBody === "object" &&
      !Array.isArray(parsedRequestBody) &&
      (parsedRequestBody as Record<string, unknown>).stream === true,
    );

    writeModelLog({
      requestId,
      routeType: "anthropic_direct",
      stage: "sdk_request",
      profileKey: route.upstream.profileKey,
      provider: route.upstream.provider,
      model: route.upstream.model,
      groupFolder: route.groupFolder,
      url: targetUrl,
      method,
      stream,
      headers: req.headers,
      body: parsedRequestBody,
      meta: {
        routePath,
      },
    });

    const upstreamHeaders = copyRequestHeaders(req.headers, requestBodyBuffer.byteLength);
    applyUpstreamAuth(upstreamHeaders, req.headers, route.upstream.apiKey);

    writeModelLog({
      requestId,
      routeType: "anthropic_direct",
      stage: "upstream_request",
      profileKey: route.upstream.profileKey,
      provider: route.upstream.provider,
      model: route.upstream.model,
      groupFolder: route.groupFolder,
      url: targetUrl,
      method,
      stream,
      headers: upstreamHeaders,
      body: parsedRequestBody,
    });

    const target = new URL(targetUrl);

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };

      const upstreamReq = createUpstreamRequest(target, method, upstreamHeaders, (upstreamRes) => {
        this.lastProxyError = null;

        const statusCode = upstreamRes.statusCode ?? 502;
        const responseHeaders = copyResponseHeaders(upstreamRes.headers);
        const contentType = readHeaderValue(upstreamRes.headers, "content-type") ?? "";
        const contentEncoding = readHeaderValue(upstreamRes.headers, "content-encoding");
        const shouldStream = stream || contentType.includes("text/event-stream");

        res.writeHead(statusCode, responseHeaders);

        if (!shouldStream) {
          const rawChunks: Buffer[] = [];

          upstreamRes.on("data", (chunk: Buffer | string) => {
            const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            rawChunks.push(rawChunk);
            res.write(rawChunk);
          });

          upstreamRes.on("end", () => {
            const rawResponseBody = Buffer.concat(rawChunks);
            const decodedResponse = decodeBufferForLogging(rawResponseBody, contentEncoding);

            writeModelLog({
              requestId,
              routeType: "anthropic_direct",
              stage: "upstream_response",
              profileKey: route.upstream.profileKey,
              provider: route.upstream.provider,
              model: route.upstream.model,
              groupFolder: route.groupFolder,
              url: targetUrl,
              method,
              status: statusCode,
              stream: false,
              headers: upstreamRes.headers,
              body: decodedResponse.body,
              meta: decodedResponse.meta,
            });

            res.end();
            settle(resolve);
          });
        } else {
          const decoder = new TextDecoder();
          let chunkIndex = 0;

          upstreamRes.on("data", (chunk: Buffer | string) => {
            const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            res.write(rawChunk);

            const chunkText = decoder.decode(rawChunk, { stream: true });
            if (!chunkText) {
              return;
            }

            writeModelLog({
              requestId,
              routeType: "anthropic_direct",
              stage: "upstream_stream_chunk",
              profileKey: route.upstream.profileKey,
              provider: route.upstream.provider,
              model: route.upstream.model,
              groupFolder: route.groupFolder,
              url: targetUrl,
              method,
              status: statusCode,
              stream: true,
              headers: upstreamRes.headers,
              body: chunkText,
              meta: { chunkIndex },
            });
            chunkIndex += 1;
          });

          upstreamRes.on("end", () => {
            const finalChunk = decoder.decode();
            if (finalChunk) {
              writeModelLog({
                requestId,
                routeType: "anthropic_direct",
                stage: "upstream_stream_chunk",
                profileKey: route.upstream.profileKey,
                provider: route.upstream.provider,
                model: route.upstream.model,
                groupFolder: route.groupFolder,
                url: targetUrl,
                method,
                status: statusCode,
                stream: true,
                headers: upstreamRes.headers,
                body: finalChunk,
                meta: { chunkIndex },
              });
              chunkIndex += 1;
            }

            writeModelLog({
              requestId,
              routeType: "anthropic_direct",
              stage: "upstream_response",
              profileKey: route.upstream.profileKey,
              provider: route.upstream.provider,
              model: route.upstream.model,
              groupFolder: route.groupFolder,
              url: targetUrl,
              method,
              status: statusCode,
              stream: true,
              headers: upstreamRes.headers,
              meta: {
                chunkCount: chunkIndex,
                done: true,
                contentEncoding: normalizeContentEncoding(contentEncoding),
              },
            });

            res.end();
            settle(resolve);
          });
        }

        upstreamRes.on("error", (error) => {
          const message = error instanceof Error ? error.message : "Upstream response error";
          this.lastProxyError = message;
          writeModelLog({
            requestId,
            routeType: "anthropic_direct",
            stage: "error",
            profileKey: route.upstream.profileKey,
            provider: route.upstream.provider,
            model: route.upstream.model,
            groupFolder: route.groupFolder,
            url: targetUrl,
            method,
            status: statusCode,
            stream: shouldStream,
            headers: upstreamRes.headers,
            body: { message },
          });
          res.destroy(error instanceof Error ? error : new Error(message));
          settle(() => reject(error));
        });
      });

      const abortUpstream = (): void => {
        if (!upstreamReq.destroyed) {
          upstreamReq.destroy();
        }
      };

      req.on("aborted", abortUpstream);
      res.on("close", () => {
        if (!res.writableEnded) {
          abortUpstream();
        }
      });

      upstreamReq.on("error", (error) => {
        const message = error instanceof Error ? error.message : "Network error";
        this.lastProxyError = message;
        writeModelLog({
          requestId,
          routeType: "anthropic_direct",
          stage: "error",
          profileKey: route.upstream.profileKey,
          provider: route.upstream.provider,
          model: route.upstream.model,
          groupFolder: route.groupFolder,
          url: targetUrl,
          method,
          stream,
          headers: upstreamHeaders,
          body: { message },
        });

        if (!res.headersSent) {
          writeJSON(res, 502, createAnthropicErrorBody(message));
        } else {
          res.destroy(error instanceof Error ? error : new Error(message));
        }
        settle(() => reject(error));
      });

      if (method === "GET" || method === "HEAD" || requestBodyBuffer.byteLength === 0) {
        upstreamReq.end();
        return;
      }

      upstreamReq.end(requestBodyBuffer);
    });
  }
}
