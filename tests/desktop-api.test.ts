import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopApiRouter } from "../src/desktop/api";
import type {
  CreateCliWorkspaceResult,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeSnapshotController,
  RuntimeSummary,
} from "../src/kernel/types";
import { log } from "../src/logger";
import { initDatabase, type ChatRow, type WorkspaceRow } from "../src/db";
import { WorkspaceService } from "../src/workspace-service";

type RouteRequest = Request & {
  params?: Record<string, string>;
};

function withParams<T extends Request>(request: T, params: Record<string, string>): T & {
  params: Record<string, string>;
} {
  return Object.assign(request, { params });
}

function createSnapshot(
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot {
  return {
    workspaceId: "workspace_main",
    workspaceFolder: "main",
    workspaceName: "Main Workspace",
    chatId: "chat_main",
    chatTitle: "Main Chat",
    activeBranch: "main",
    profileKey: "claude",
    sessionRef: "/tmp/session.jsonl",
    currentRunId: null,
    isStreaming: false,
    pendingFollowUp: [],
    pendingSteering: [],
    messages: [],
    ...overrides,
  };
}

function createSummary(
  overrides: Partial<RuntimeSummary> = {},
): RuntimeSummary {
  return {
    workspaceId: "workspace_main",
    workspaceFolder: "main",
    workspaceName: "Main Workspace",
    chatId: "chat_main",
    chatTitle: "Main Chat",
    activeBranch: "main",
    platform: "cli",
    isMain: true,
    profileKey: "claude",
    sessionRef: "/tmp/session.jsonl",
    isStreaming: false,
    ...overrides,
  };
}

function readChunk(value: string | Uint8Array | undefined): string {
  if (!value) {
    return "";
  }

  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function createFixture(): {
  dir: string;
  configPath: string;
  workspaceService: WorkspaceService;
  workspace: WorkspaceRow;
  chat: ChatRow;
} {
  const dir = join(tmpdir(), `octo-desktop-api-${crypto.randomUUID()}`);
  mkdirSync(join(dir, "store"), { recursive: true });

  const configPath = join(dir, "agent-profiles.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "claude",
      profiles: {
        claude: {
          apiFormat: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          model: "claude-sonnet-4-6",
        },
      },
    }),
    "utf-8",
  );

  const db = initDatabase(join(dir, "store", "messages.db"));
  const workspaceService = new WorkspaceService(db, { rootDir: dir });
  const workspace = workspaceService.createWorkspace({
    name: "Main Workspace",
    folder: "main",
    defaultBranch: "main",
    profileKey: "claude",
    isMain: true,
  });
  const chat = workspaceService.createChat(workspace.id, {
    title: "Main Chat",
    requiresTrigger: false,
  });

  return {
    dir,
    configPath,
    workspaceService,
    workspace,
    chat,
  };
}

const originalLogMethods = {
  info: log.info,
  warn: log.warn,
  error: log.error,
};

const cleanupDirs: string[] = [];
const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

afterEach(() => {
  log.info = originalLogMethods.info;
  log.warn = originalLogMethods.warn;
  log.error = originalLogMethods.error;
  process.env.AGENT_PROFILES_PATH = previousProfilesPath;

  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("desktop api router", () => {
  test("lists workspaces and prompts through the runtime manager", async () => {
    const fixture = createFixture();
    cleanupDirs.push(fixture.dir);
    process.env.AGENT_PROFILES_PATH = fixture.configPath;

    const summaries: RuntimeSummary[] = [
      createSummary({
        workspaceId: fixture.workspace.id,
        workspaceFolder: fixture.workspace.folder,
        workspaceName: fixture.workspace.name,
        chatId: fixture.chat.id,
        chatTitle: fixture.chat.title,
        activeBranch: fixture.chat.active_branch,
        isMain: fixture.workspace.is_main === 1,
        profileKey: fixture.workspace.profile_key,
        sessionRef: fixture.chat.session_ref,
      }),
    ];
    const prompts: Array<{ chatId: string; text: string; mode: string }> = [];
    const manager: RuntimeSnapshotController = {
      listChats: () => summaries,
      getSnapshot: async () => createSnapshot({
        workspaceId: fixture.workspace.id,
        workspaceFolder: fixture.workspace.folder,
        workspaceName: fixture.workspace.name,
        chatId: fixture.chat.id,
        chatTitle: fixture.chat.title,
        activeBranch: fixture.chat.active_branch,
        profileKey: fixture.workspace.profile_key,
        sessionRef: fixture.chat.session_ref,
      }),
      prompt: async (chatId, input) => {
        prompts.push({
          chatId,
          text: input.text,
          mode: input.mode,
        });
        return createSnapshot({
          workspaceId: fixture.workspace.id,
          workspaceFolder: fixture.workspace.folder,
          workspaceName: fixture.workspace.name,
          chatId,
          chatTitle: fixture.chat.title,
          activeBranch: fixture.chat.active_branch,
          profileKey: fixture.workspace.profile_key,
          sessionRef: fixture.chat.session_ref,
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
    const router = createDesktopApiRouter(manager, {
      workspaceService: fixture.workspaceService,
    });

    const listResponse = router.listWorkspaces(
      new Request("http://localhost/api/desktop/workspaces"),
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      workspaces: [
        {
          id: fixture.workspace.id,
          name: "Main Workspace",
          folder: "main",
          defaultBranch: "main",
          profileKey: "claude",
          isMain: true,
          chats: [
            {
              id: fixture.chat.id,
              title: "Main Chat",
              activeBranch: fixture.chat.active_branch,
              sessionRef: fixture.chat.session_ref,
              isStreaming: false,
            },
          ],
        },
      ],
    });

    const promptResponse = await router.prompt(withParams(
      new Request(
        `http://localhost/api/desktop/workspaces/${fixture.workspace.id}/chats/${fixture.chat.id}/prompt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "继续",
            mode: "follow_up",
          }),
        },
      ),
      { workspaceId: fixture.workspace.id, chatId: fixture.chat.id },
    ));

    expect(promptResponse.status).toBe(200);
    expect(prompts).toEqual([
      {
        chatId: fixture.chat.id,
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

  test("creates a chat through workspaceService and returns its snapshot", async () => {
    const fixture = createFixture();
    cleanupDirs.push(fixture.dir);
    process.env.AGENT_PROFILES_PATH = fixture.configPath;

    const manager: RuntimeSnapshotController = {
      listChats: () => [],
      getSnapshot: async (chatId) => {
        const chat = fixture.workspaceService.getChatById(chatId);
        if (!chat) {
          throw new Error(`Chat not found: ${chatId}`);
        }
        return createSnapshot({
          workspaceId: fixture.workspace.id,
          workspaceFolder: fixture.workspace.folder,
          workspaceName: fixture.workspace.name,
          chatId: chat.id,
          chatTitle: chat.title,
          activeBranch: chat.active_branch,
          profileKey: fixture.workspace.profile_key,
          sessionRef: chat.session_ref,
        });
      },
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager, {
      workspaceService: fixture.workspaceService,
    });

    const response = await router.createChat(withParams(
      new Request(`http://localhost/api/desktop/workspaces/${fixture.workspace.id}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Route B",
        }),
      }),
      { workspaceId: fixture.workspace.id },
    ));

    expect(response.status).toBe(201);
    const payload = await response.json() as {
      chat: ChatRow;
      snapshot: RuntimeSnapshot;
    };
    expect(payload.chat).toMatchObject({
      workspace_id: fixture.workspace.id,
      title: "Route B",
      active_branch: "main",
    });
    expect(payload.snapshot).toMatchObject({
      workspaceId: fixture.workspace.id,
      chatId: payload.chat.id,
      chatTitle: "Route B",
      activeBranch: "main",
    });
    expect(fixture.workspaceService.listChats(fixture.workspace.id)).toHaveLength(2);
  });

  test("validates prompt body and returns 400 on invalid request", async () => {
    const manager: RuntimeSnapshotController = {
      listChats: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager);

    const response = await router.prompt(withParams(
      new Request("http://localhost/api/desktop/workspaces/workspace_main/chats/chat_main/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: " ",
        }),
      }),
      { workspaceId: "workspace_main", chatId: "chat_main" },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
    });
  });

  test("streams snapshot and runtime events over SSE", async () => {
    let emitEvent: ((event: RuntimeEvent) => void) | undefined;
    const manager: RuntimeSnapshotController = {
      listChats: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: (_chatId, next) => {
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
      new Request("http://localhost/api/desktop/workspaces/workspace_main/chats/chat_main/events"),
      { workspaceId: "workspace_main", chatId: "chat_main" },
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
      workspaceId: "workspace_main",
      workspaceFolder: "main",
      chatId: "chat_main",
      runId: "run_1",
      message: {
        id: "assistant-1",
        role: "assistant",
        timestamp: 1,
        blocks: [{ type: "text", text: "已完成" }],
      },
    });

    const first = await reader!.read();
    let payload = readChunk(first.value);
    if (!payload.includes("event: message_end")) {
      const second = await reader!.read();
      payload += readChunk(second.value);
    }

    expect(payload).toContain("event: ready");
    expect(payload).toContain("event: message_end");
    expect(payload).toContain("\"chatId\":\"chat_main\"");
    expect(payload).toContain("已完成");
    await reader!.cancel();
  });

  test("creates a CLI workspace through the injected creator", async () => {
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

    const created: CreateCliWorkspaceResult = {
      workspace: {
        id: "workspace_cli_test",
        name: "New Desktop Workspace",
        folder: "cli_20260418_test",
        default_branch: "main",
        status: "active",
        profile_key: "claude",
        is_main: 0,
        created_at: "2026-04-22T00:00:00.000Z",
        updated_at: "2026-04-22T00:00:00.000Z",
      },
      chat: {
        id: "chat_cli_test",
        workspace_id: "workspace_cli_test",
        title: "New Desktop Workspace",
        active_branch: "main",
        session_ref: null,
        status: "active",
        trigger_pattern: "",
        requires_trigger: 0,
        created_at: "2026-04-22T00:00:00.000Z",
        updated_at: "2026-04-22T00:00:00.000Z",
        last_activity_at: "2026-04-22T00:00:00.000Z",
      },
      summary: createSummary({
        workspaceId: "workspace_cli_test",
        workspaceFolder: "cli_20260418_test",
        workspaceName: "New Desktop Workspace",
        chatId: "chat_cli_test",
        chatTitle: "New Desktop Workspace",
        isMain: false,
        sessionRef: null,
      }),
      snapshot: createSnapshot({
        workspaceId: "workspace_cli_test",
        workspaceFolder: "cli_20260418_test",
        workspaceName: "New Desktop Workspace",
        chatId: "chat_cli_test",
        chatTitle: "New Desktop Workspace",
        sessionRef: null,
      }),
    };
    const manager: RuntimeSnapshotController = {
      listChats: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager, {
      createCliWorkspace: async (input) => {
        expect(input).toEqual({ name: "New Desktop Workspace" });
        return created;
      },
    });

    const response = await router.createCliWorkspace(
      new Request("http://localhost/api/desktop/workspaces/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "  New Desktop Workspace  ",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(entries).toEqual([
      {
        level: "info",
        tag: "desktop-api",
        message: "Received desktop createCliWorkspace request",
        data: {
          method: "POST",
          path: "/api/desktop/workspaces/cli",
          requestedName: "New Desktop Workspace",
        },
      },
      {
        level: "info",
        tag: "desktop-api",
        message: "Desktop createCliWorkspace succeeded",
        data: {
          method: "POST",
          path: "/api/desktop/workspaces/cli",
          requestedName: "New Desktop Workspace",
          status: 201,
          workspaceFolder: "cli_20260418_test",
          workspaceName: "New Desktop Workspace",
        },
      },
    ]);
  });

  test("logs createCliWorkspace failures", async () => {
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

    const manager: RuntimeSnapshotController = {
      listChats: () => [],
      getSnapshot: async () => createSnapshot(),
      prompt: async () => createSnapshot(),
      abort: async () => createSnapshot(),
      newSession: async () => createSnapshot(),
      subscribe: () => () => undefined,
    };
    const router = createDesktopApiRouter(manager, {
      createCliWorkspace: async () => {
        throw new Error("create failed");
      },
    });

    const response = await router.createCliWorkspace(
      new Request("http://localhost/api/desktop/workspaces/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Broken Workspace",
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
      message: "Received desktop createCliWorkspace request",
      data: {
        method: "POST",
        path: "/api/desktop/workspaces/cli",
        requestedName: "Broken Workspace",
      },
    });
    expect(entries[1].level).toBe("error");
    expect(entries[1].tag).toBe("desktop-api");
    expect(entries[1].message).toBe("Desktop API createCliWorkspace failed");
    expect(entries[1].data).toMatchObject({
      method: "POST",
      path: "/api/desktop/workspaces/cli",
      requestedName: "Broken Workspace",
      error: {
        name: "Error",
        message: "create failed",
      },
    });
  });
});
