import { afterEach, describe, expect, test } from "bun:test";
import { createDesktopApiRouter } from "../src/desktop/api";
import type {
  CreateCliGroupResult,
  GroupRuntimeEvent,
  GroupRuntimeSnapshot,
  GroupRuntimeSnapshotController,
  GroupRuntimeSummary,
} from "../src/kernel/types";
import { log } from "../src/logger";

type RouteRequest = Request & {
  params?: Record<string, string>;
};

function withParams<T extends Request>(request: T, params: Record<string, string>): T & {
  params: Record<string, string>;
} {
  return Object.assign(request, { params });
}

function createSnapshot(
  overrides: Partial<GroupRuntimeSnapshot> = {},
): GroupRuntimeSnapshot {
  return {
    groupFolder: "main",
    groupName: "Main Group",
    profileKey: "claude",
    sessionRef: "/tmp/session.jsonl",
    isStreaming: false,
    pendingFollowUp: [],
    pendingSteering: [],
    messages: [],
    ...overrides,
  };
}

const originalLogMethods = {
  info: log.info,
  warn: log.warn,
  error: log.error,
};

afterEach(() => {
  log.info = originalLogMethods.info;
  log.warn = originalLogMethods.warn;
  log.error = originalLogMethods.error;
});

describe("desktop api router", () => {
  test("lists groups and prompts through the runtime manager", async () => {
    const groups: GroupRuntimeSummary[] = [{
      folder: "main",
      name: "Main Group",
      channelType: "cli",
      isMain: true,
      profileKey: "claude",
      sessionRef: "/tmp/session.jsonl",
      isStreaming: false,
    }];
    const prompts: Array<{ groupFolder: string; text: string; mode: string }> = [];
    const manager: GroupRuntimeSnapshotController = {
      listGroups: () => groups,
      getSnapshot: async () => createSnapshot(),
      prompt: async (groupFolder, input) => {
        prompts.push({
          groupFolder,
          text: input.text,
          mode: input.mode,
        });
        return createSnapshot({
          messages: [
            {
              id: "1",
              role: "user",
              timestamp: 1,
              blocks: [{ type: "text", text: input.text }],
            },
          ],
        });
      },
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot({ sessionRef: "/tmp/fresh.jsonl" }),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager);

    const listResponse = router.listGroups(
      new Request("http://localhost/api/desktop/groups"),
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ groups });

    const promptResponse = await router.prompt(withParams(
      new Request("http://localhost/api/desktop/groups/main/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "继续",
          mode: "follow_up",
        }),
      }),
      { folder: "main" },
    ));

    expect(promptResponse.status).toBe(200);
    expect(prompts).toEqual([
      {
        groupFolder: "main",
        text: "继续",
        mode: "follow_up",
      },
    ]);
    expect(await promptResponse.json()).toMatchObject({
      messages: [
        {
          role: "user",
          blocks: [{ type: "text", text: "继续" }],
        },
      ],
    });
  });

  test("validates prompt body and returns 400 on invalid request", async () => {
    const manager: GroupRuntimeSnapshotController = {
      listGroups: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager);

    const response = await router.prompt(withParams(
      new Request("http://localhost/api/desktop/groups/main/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: " ",
        }),
      }),
      { folder: "main" },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
    });
  });

  test("streams snapshot and runtime events over SSE", async () => {
    let emitEvent: ((event: GroupRuntimeEvent) => void) | undefined;
    const manager: GroupRuntimeSnapshotController = {
      listGroups: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: (_groupFolder, next) => {
        emitEvent = next;
        return () => {
          if (emitEvent === next) {
            emitEvent = undefined;
          }
        };
      },
    };
    const router = createDesktopApiRouter(manager);
    const response = await router.getEvents(withParams(
      new Request("http://localhost/api/desktop/groups/main/events"),
      { folder: "main" },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    expect(emitEvent).toBeDefined();
    if (!emitEvent) {
      throw new Error("SSE listener was not registered");
    }

    emitEvent({
      type: "message_end",
      groupFolder: "main",
      message: {
        id: "assistant-1",
        role: "assistant",
        timestamp: 1,
        blocks: [{ type: "text", text: "已完成" }],
      },
    });

    const first = await reader!.read();
    const second = await reader!.read();
    const decoder = new TextDecoder();
    const payload = `${decoder.decode(first.value)}${decoder.decode(second.value)}`;

    expect(payload).toContain("event: snapshot");
    expect(payload).toContain("\"groupFolder\":\"main\"");
    expect(payload).toContain("event: message_end");
    expect(payload).toContain("已完成");
    await reader!.cancel();
  });

  test("creates a CLI group through the injected creator", async () => {
    const entries: Array<{
      level: "info" | "warn" | "error";
      tag: string;
      message: string;
      data: unknown;
    }> = [];
    log.info = ((tag, message, data) => {
      entries.push({
        level: "info",
        tag,
        message,
        data,
      });
    }) as typeof log.info;

    const created: CreateCliGroupResult = {
      group: {
        folder: "cli_20260418_test",
        name: "New Desktop Group",
        channelType: "cli",
        isMain: false,
        profileKey: "claude",
        sessionRef: null,
        isStreaming: false,
      },
      snapshot: createSnapshot({
        groupFolder: "cli_20260418_test",
        groupName: "New Desktop Group",
        sessionRef: null,
      }),
    };
    const manager: GroupRuntimeSnapshotController = {
      listGroups: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager, {
      createCliGroup: async (input) => {
        expect(input).toEqual({ name: "New Desktop Group" });
        return created;
      },
    });

    const response = await router.createCliGroup(
      new Request("http://localhost/api/desktop/groups/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "  New Desktop Group  ",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(entries).toEqual([
      {
        level: "info",
        tag: "desktop-api",
        message: "Received desktop createCliGroup request",
        data: {
          method: "POST",
          path: "/api/desktop/groups/cli",
          requestedName: "New Desktop Group",
        },
      },
      {
        level: "info",
        tag: "desktop-api",
        message: "Desktop createCliGroup succeeded",
        data: {
          method: "POST",
          path: "/api/desktop/groups/cli",
          requestedName: "New Desktop Group",
          status: 201,
          groupFolder: "cli_20260418_test",
          groupName: "New Desktop Group",
        },
      },
    ]);
  });

  test("logs createCliGroup failures", async () => {
    const entries: Array<{
      level: "info" | "warn" | "error";
      tag: string;
      message: string;
      data: unknown;
    }> = [];
    log.info = ((tag, message, data) => {
      entries.push({
        level: "info",
        tag,
        message,
        data,
      });
    }) as typeof log.info;
    log.error = ((tag, message, data) => {
      entries.push({
        level: "error",
        tag,
        message,
        data,
      });
    }) as typeof log.error;

    const manager: GroupRuntimeSnapshotController = {
      listGroups: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager, {
      createCliGroup: async () => {
        throw new Error("create failed");
      },
    });

    const response = await router.createCliGroup(
      new Request("http://localhost/api/desktop/groups/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Broken Group",
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "internal_error",
      details: "create failed",
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      level: "info",
      tag: "desktop-api",
      message: "Received desktop createCliGroup request",
      data: {
        method: "POST",
        path: "/api/desktop/groups/cli",
        requestedName: "Broken Group",
      },
    });
    expect(entries[1].level).toBe("error");
    expect(entries[1].tag).toBe("desktop-api");
    expect(entries[1].message).toBe("Desktop API createCliGroup failed");
    expect(entries[1].data).toMatchObject({
      method: "POST",
      path: "/api/desktop/groups/cli",
      requestedName: "Broken Group",
      error: {
        name: "Error",
        message: "create failed",
      },
    });
  });
});
