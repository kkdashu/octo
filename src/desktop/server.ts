import { log } from "../logger";
import type { DesktopApiRouter } from "./api";

const TAG = "desktop-server";
export const DESKTOP_HOSTNAME = "127.0.0.1";
export const DEFAULT_DESKTOP_PORT = 4317;

function createCorsHeaders(req: Request): Headers {
  const headers = new Headers();
  const origin = req.headers.get("origin");
  headers.set("access-control-allow-origin", origin?.trim() || "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
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
  port?: number;
  hostname?: string;
}) {
  const hostname = options.hostname ?? DESKTOP_HOSTNAME;
  const port = options.port ?? DEFAULT_DESKTOP_PORT;

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
    },
  });

  log.info(TAG, `Desktop sidecar listening on http://${hostname}:${port}`);
  return server;
}
