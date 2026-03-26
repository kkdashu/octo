import { log } from "../logger";
import type { AdminApiRouter } from "./api";
import adminHtml from "./index.html";

const TAG = "admin-server";
export const ADMIN_HOSTNAME = "127.0.0.1";
export const DEFAULT_ADMIN_PORT = 3010;

export function startAdminServer(options: {
  api: AdminApiRouter;
  port?: number;
  hostname?: string;
}) {
  const hostname = options.hostname ?? ADMIN_HOSTNAME;
  const port = options.port ?? DEFAULT_ADMIN_PORT;

  const server = Bun.serve({
    hostname,
    port,
    development: true,
    routes: {
      "/admin": adminHtml,
      "/admin/": adminHtml,
      "/api/admin/groups": {
        GET: (req) => options.api.listGroups(req),
      },
      "/api/admin/groups/:folder": {
        GET: (req) => options.api.getGroup(req),
        PATCH: (req) => options.api.patchGroup(req),
      },
      "/api/admin/groups/:folder/files": {
        GET: (req) => options.api.listFiles(req),
      },
      "/api/admin/groups/:folder/file": {
        GET: (req) => options.api.getFile(req),
        PUT: (req) => options.api.putFile(req),
        POST: (req) => options.api.postFile(req),
      },
      "/api/admin/groups/:folder/folder": {
        POST: (req) => options.api.postFolder(req),
      },
    },
  });

  log.info(TAG, `Admin UI listening on http://${hostname}:${port}/admin`);
  return server;
}
