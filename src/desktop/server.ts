import { log } from "../logger";
import type { DesktopApiRouter } from "./api";
import type { DesktopAdminApiRouter } from "./admin-api";

const TAG = "desktop-server";
export const DESKTOP_HOSTNAME = "127.0.0.1";
export const DEFAULT_DESKTOP_PORT = 4317;
const RANDOM_PORT_MIN = 20000;
const RANDOM_PORT_SPAN = 30000;
const RANDOM_PORT_ATTEMPTS = 64;

function createCorsHeaders(req: Request): Headers {
  const headers = new Headers();
  const origin = req.headers.get("origin");
  headers.set("access-control-allow-origin", origin?.trim() || "*");
  headers.set("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type");
  headers.set("access-control-max-age", "600");
  headers.set("vary", "Origin");
  return headers;
}

function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const corsHeaders = createCorsHeaders(req);
  for (const [key, value] of corsHeaders.entries()) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: createCorsHeaders(req),
  });
}

export function startDesktopServer(options: {
  api: DesktopApiRouter;
  adminApi: DesktopAdminApiRouter;
  port?: number;
  hostname?: string;
}) {
  const hostname = options.hostname ?? DESKTOP_HOSTNAME;
  const requestedPort = options.port;
  const candidatePorts = requestedPort === 0
    ? [
      DEFAULT_DESKTOP_PORT,
      ...Array.from({ length: RANDOM_PORT_ATTEMPTS }, () =>
        RANDOM_PORT_MIN + Math.floor(Math.random() * RANDOM_PORT_SPAN)
      ),
    ]
    : [requestedPort ?? DEFAULT_DESKTOP_PORT];

  let lastError: unknown = null;
  for (const port of candidatePorts) {
    try {
      const server = Bun.serve({
        hostname,
        port,
        development: true,
        routes: {
      "/api/desktop/groups": {
        GET: (req) => withCors(req, options.api.listGroups(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/groups/cli": {
        POST: async (req) => withCors(req, await options.api.createCliGroup(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/groups/:folder/snapshot": {
        GET: async (req) => withCors(req, await options.api.getSnapshot(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/groups/:folder/prompt": {
        POST: async (req) => withCors(req, await options.api.prompt(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/groups/:folder/abort": {
        POST: async (req) => withCors(req, await options.api.abort(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/groups/:folder/session/new": {
        POST: async (req) => withCors(req, await options.api.newSession(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/groups/:folder/events": {
        GET: async (req) => withCors(req, await options.api.getEvents(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces": {
        GET: (req) => withCors(req, options.api.listWorkspaces(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/cli": {
        POST: async (req) => withCors(req, await options.api.createCliWorkspace(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats": {
        POST: async (req) => withCors(req, await options.api.createChat(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/snapshot": {
        GET: async (req) => withCors(req, await options.api.getSnapshot(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/prompt": {
        POST: async (req) => withCors(req, await options.api.prompt(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/abort": {
        POST: async (req) => withCors(req, await options.api.abort(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/session/new": {
        POST: async (req) => withCors(req, await options.api.newSession(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/events": {
        GET: async (req) => withCors(req, await options.api.getEvents(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/branches": {
        GET: async (req) => withCors(req, await options.api.listBranches(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/branches/switch": {
        POST: async (req) => withCors(req, await options.api.switchBranch(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/workspaces/:workspaceId/chats/:chatId/branches/fork": {
        POST: async (req) => withCors(req, await options.api.forkBranch(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/admin/groups": {
        GET: (req) => withCors(req, options.adminApi.listGroups(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/admin/groups/:folder": {
        GET: (req) => withCors(req, options.adminApi.getGroup(req)),
        PATCH: async (req) => withCors(req, await options.adminApi.patchGroup(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/admin/groups/:folder/memory": {
        PUT: async (req) => withCors(req, await options.adminApi.putMemory(req)),
        DELETE: (req) => withCors(req, options.adminApi.deleteMemory(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/admin/groups/:folder/files": {
        GET: (req) => withCors(req, options.adminApi.listFiles(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/admin/groups/:folder/file": {
        GET: (req) => withCors(req, options.adminApi.getFile(req)),
        PUT: async (req) => withCors(req, await options.adminApi.putFile(req)),
        POST: async (req) => withCors(req, await options.adminApi.postFile(req)),
        OPTIONS: (req) => preflight(req),
      },
      "/api/desktop/admin/groups/:folder/folder": {
        POST: async (req) => withCors(req, await options.adminApi.postFolder(req)),
        OPTIONS: (req) => preflight(req),
      },
        },
      });

      log.info(TAG, `Desktop sidecar listening on ${server.url.toString()}`);
      return server;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to start desktop server");
}
