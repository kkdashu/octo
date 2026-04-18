import { afterEach, describe, expect, test } from "bun:test";
import { startDesktopServer } from "../src/desktop/server";
import type { DesktopApiRouter } from "../src/desktop/api";
import type { DesktopAdminApiRouter } from "../src/desktop/admin-api";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

function createApi(): DesktopApiRouter {
  return {
    listGroups() {
      return Response.json({ groups: [] });
    },
    async createCliGroup() {
      return Response.json({ ok: true }, { status: 201 });
    },
    async getSnapshot() {
      return Response.json({
        groupFolder: "main",
        groupName: "Main Group",
        profileKey: "claude",
        sessionRef: null,
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
  };
}

function createAdminApi(): DesktopAdminApiRouter {
  return {
    listGroups() {
      return Response.json({ groups: [], availableProfiles: [] });
    },
    getGroup() {
      return Response.json({
        group: {
          jid: "oc_test",
          name: "Test Group",
          folder: "test-group",
          channelType: "feishu",
          triggerPattern: "@octo",
          requiresTrigger: true,
          isMain: false,
          profileKey: "claude",
          addedAt: "2026-04-19T00:00:00.000Z",
        },
        availableProfiles: [],
        memories: [],
      });
    },
    async patchGroup() {
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

describe("desktop server", () => {
  test("adds CORS headers to API responses and supports preflight", async () => {
    const server = startDesktopServer({
      api: createApi(),
      adminApi: createAdminApi(),
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const origin = "http://127.0.0.1:1420";
    const listResponse = await fetch(`${server.url}api/desktop/groups`, {
      headers: {
        Origin: origin,
      },
    });
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("access-control-allow-origin")).toBe(origin);
    expect(listResponse.headers.get("access-control-allow-methods")).toContain("OPTIONS");

    const preflightResponse = await fetch(`${server.url}api/desktop/groups/main/prompt`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflightResponse.headers.get("access-control-allow-headers")).toContain("Content-Type");

    const adminPreflight = await fetch(`${server.url}api/desktop/admin/groups/test-group`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(adminPreflight.status).toBe(204);
    expect(adminPreflight.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(adminPreflight.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  test("keeps SSE responses CORS-accessible", async () => {
    const server = startDesktopServer({
      api: createApi(),
      adminApi: createAdminApi(),
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const origin = "http://127.0.0.1:1420";
    const response = await fetch(`${server.url}api/desktop/groups/main/events`, {
      headers: {
        Origin: origin,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test("serves desktop admin routes with CORS headers", async () => {
    const server = startDesktopServer({
      api: createApi(),
      adminApi: createAdminApi(),
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const origin = "http://127.0.0.1:1420";
    const response = await fetch(`${server.url}api/desktop/admin/groups`, {
      headers: {
        Origin: origin,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await response.json()).toEqual({
      groups: [],
      availableProfiles: [],
    });
  });
});
