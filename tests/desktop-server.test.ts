import { afterEach, describe, expect, test } from "bun:test";
import { startDesktopServer } from "../src/desktop/server";
import type { DesktopApiRouter } from "../src/desktop/api";
import type { DesktopAdminApiRouter } from "../src/desktop/admin-api";

type BunServeOptions = Parameters<typeof Bun.serve>[0];
type BunServer = ReturnType<typeof Bun.serve>;

const servers: BunServer[] = [];
const restoreFns: Array<() => void> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }

  while (restoreFns.length > 0) {
    restoreFns.pop()?.();
  }
});

function createApi(): DesktopApiRouter {
  return {
    listWorkspaces() {
      return Response.json({ workspaces: [] });
    },
    async createCliWorkspace() {
      return Response.json({ ok: true }, { status: 201 });
    },
    async createChat() {
      return Response.json({ ok: true }, { status: 201 });
    },
    async getSnapshot() {
      return Response.json({
        workspaceId: "ws_1",
        workspaceFolder: "main",
        workspaceName: "Main Workspace",
        chatId: "chat_1",
        chatTitle: "Main Chat",
        activeBranch: "main",
        profileKey: "claude",
        sessionRef: null,
        currentRunId: null,
        isStreaming: false,
        pendingFollowUp: [],
        pendingSteering: [],
        messages: [],
      });
    },
    async prompt() {
      return Response.json({ ok: true });
    },
    async abort() {
      return Response.json({ ok: true });
    },
    async newSession() {
      return Response.json({ ok: true });
    },
    async getEvents() {
      return new Response("event: snapshot\ndata: {}\n\n", {
        headers: {
          "content-type": "text/event-stream",
        },
      });
    },
    async listBranches() {
      return Response.json({
        currentBranch: "main",
        branches: ["main"],
        isDirty: false,
      });
    },
    async switchBranch() {
      return Response.json({ ok: true });
    },
    async forkBranch() {
      return Response.json({ ok: true });
    },
  };
}

function createAdminApi(): DesktopAdminApiRouter {
  return {
    listWorkspaces() {
      return Response.json({ workspaces: [], availableProfiles: [] });
    },
    getWorkspace() {
      return Response.json({
        workspace: {
          id: "ws_1",
          name: "Test Workspace",
          folder: "test-workspace",
          triggerPattern: "@octo",
          requiresTrigger: true,
          profileKey: "claude",
          createdAt: "2026-04-19T00:00:00.000Z",
        },
        availableProfiles: [],
        memories: [],
      });
    },
    async patchWorkspace() {
      return Response.json({ ok: true });
    },
    async putMemory() {
      return Response.json({ ok: true });
    },
    deleteMemory() {
      return Response.json({ ok: true });
    },
    listFiles() {
      return Response.json({ path: ".", entries: [] });
    },
    getFile() {
      return Response.json({ path: "x", content: "", size: 0 });
    },
    async putFile() {
      return Response.json({ ok: true });
    },
    async postFile() {
      return Response.json({ ok: true }, { status: 201 });
    },
    async postFolder() {
      return Response.json({ ok: true }, { status: 201 });
    },
  };
}

function startServerWithCapturedRoutes(): {
  routes: NonNullable<BunServeOptions["routes"]>;
  server: BunServer;
} {
  const originalServe = Bun.serve;
  let capturedOptions: BunServeOptions | null = null;
  const bunObject = Bun as unknown as { serve: typeof Bun.serve };

  bunObject.serve = ((options: BunServeOptions) => {
    capturedOptions = options;
    return {
      url: new URL(`http://${options.hostname}:${options.port}`),
      stop() {},
    } as BunServer;
  }) as typeof Bun.serve;

  restoreFns.push(() => {
    bunObject.serve = originalServe;
  });

  const server = startDesktopServer({
    api: createApi(),
    adminApi: createAdminApi(),
    hostname: "127.0.0.1",
    port: 4317,
  });
  servers.push(server);

  if (!capturedOptions?.routes) {
    throw new Error("Desktop server did not expose routes");
  }

  return {
    routes: capturedOptions.routes,
    server,
  };
}

describe("desktop server", () => {
  test("adds CORS headers to API responses and supports preflight", async () => {
    const { routes } = startServerWithCapturedRoutes();
    const origin = "http://127.0.0.1:1420";

    const listResponse = await routes["/api/desktop/workspaces"]!.GET!(
      new Request("http://localhost/api/desktop/workspaces", {
        headers: { Origin: origin },
      }),
    );
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("access-control-allow-origin")).toBe(origin);
    expect(listResponse.headers.get("access-control-allow-methods")).toContain("OPTIONS");

    const preflightResponse = await routes["/api/desktop/workspaces/:workspaceId/chats/:chatId/prompt"]!.OPTIONS!(
      new Request("http://localhost/api/desktop/workspaces/ws_1/chats/chat_1/prompt", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
    );
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflightResponse.headers.get("access-control-allow-headers")).toContain("Content-Type");

    const adminPreflight = await routes["/api/desktop/admin/workspaces/:folder"]!.OPTIONS!(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
    );
    expect(adminPreflight.status).toBe(204);
    expect(adminPreflight.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(adminPreflight.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  test("keeps SSE responses CORS-accessible", async () => {
    const { routes } = startServerWithCapturedRoutes();
    const origin = "http://127.0.0.1:1420";

    const response = await routes["/api/desktop/workspaces/:workspaceId/chats/:chatId/events"]!.GET!(
      new Request("http://localhost/api/desktop/workspaces/ws_1/chats/chat_1/events", {
        headers: { Origin: origin },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test("serves desktop admin routes with CORS headers", async () => {
    const { routes } = startServerWithCapturedRoutes();
    const origin = "http://127.0.0.1:1420";

    const response = await routes["/api/desktop/admin/workspaces"]!.GET!(
      new Request("http://localhost/api/desktop/admin/workspaces", {
        headers: { Origin: origin },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await response.json()).toEqual({
      workspaces: [],
      availableProfiles: [],
    });
  });
});
