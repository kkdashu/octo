import { afterEach, describe, expect, test } from "bun:test";
import { startDesktopServer } from "../src/desktop/server";
import type { DesktopApiRouter } from "../src/desktop/api";

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

describe("desktop server", () => {
  test("adds CORS headers to API responses and supports preflight", async () => {
    const server = startDesktopServer({
      api: createApi(),
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
  });

  test("keeps SSE responses CORS-accessible", async () => {
    const server = startDesktopServer({
      api: createApi(),
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
});
