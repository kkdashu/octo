import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { GroupRuntimeManager } from "../src/kernel/group-runtime-manager";
import { initDatabase, upsertWorkspaceRuntimeState } from "../src/db";
import { WorkspaceService } from "../src/workspace-service";

function createFakeRuntime(initialCwd: string): {
  runtime: AgentSessionRuntime;
  disposeCalls: { count: number };
} {
  const sessionManager = SessionManager.inMemory(initialCwd);
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const disposeCalls = { count: 0 };

  return {
    runtime: {
      session: {
        sessionManager,
        sessionFile: join(initialCwd, ".pi", "sessions", "current.jsonl"),
        isStreaming: false,
        async prompt() {},
        async followUp() {},
        async steer() {},
        async abort() {},
        subscribe(listener: (event: AgentSessionEvent) => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      services: {
        cwd: initialCwd,
        agentDir: join(initialCwd, ".pi", "agent"),
      },
      cwd: initialCwd,
      diagnostics: [],
      modelFallbackMessage: undefined,
      newSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }),
      importFromJsonl: async () => ({ cancelled: false }),
      dispose: async () => {
        disposeCalls.count += 1;
      },
    } as unknown as AgentSessionRuntime,
    disposeCalls,
  };
}

describe("GroupRuntimeManager idle unload", () => {
  test("prunes an idle runtime after unload_after when there are no listeners", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-runtime-manager-prune-"));

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      const chat = workspaceService.createChat(workspace.id, {
        title: "Main",
        requiresTrigger: false,
      });
      const fakeRuntime = createFakeRuntime(join(rootDir, "workspaces", "main"));
      const manager = new GroupRuntimeManager({
        db,
        workspaceService,
        rootDir,
        createMessageSender: () => ({
          send: async () => undefined,
          sendImage: async () => undefined,
          refreshChatMetadata: async () => ({ count: 0 }),
        }),
        createChatRuntime: async () => ({
          workspace,
          chat: workspaceService.getChatById(chat.id)!,
          runtime: fakeRuntime.runtime,
          sessionRef: chat.session_ref,
        }),
      });

      await manager.getSnapshot(chat.id);
      upsertWorkspaceRuntimeState(db, {
        workspaceId: workspace.id,
        checkedOutBranch: chat.active_branch,
        status: "idle",
        activeRunId: null,
        lastActivityAt: "2026-04-22T00:00:00.000Z",
        unloadAfter: "2026-04-22T00:00:00.000Z",
      });

      await manager.pruneIdleRuntimes(new Date("2026-04-22T00:01:00.000Z"));

      expect(fakeRuntime.disposeCalls.count).toBe(1);
      expect(manager.getLoadedRuntime(chat.id)).toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("keeps an idle runtime loaded while it still has active listeners", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-runtime-manager-prune-"));

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      const chat = workspaceService.createChat(workspace.id, {
        title: "Main",
        requiresTrigger: false,
      });
      const fakeRuntime = createFakeRuntime(join(rootDir, "workspaces", "main"));
      const manager = new GroupRuntimeManager({
        db,
        workspaceService,
        rootDir,
        createMessageSender: () => ({
          send: async () => undefined,
          sendImage: async () => undefined,
          refreshChatMetadata: async () => ({ count: 0 }),
        }),
        createChatRuntime: async () => ({
          workspace,
          chat: workspaceService.getChatById(chat.id)!,
          runtime: fakeRuntime.runtime,
          sessionRef: chat.session_ref,
        }),
      });

      await manager.getSnapshot(chat.id);
      const unsubscribe = manager.subscribe(chat.id, () => undefined);
      upsertWorkspaceRuntimeState(db, {
        workspaceId: workspace.id,
        checkedOutBranch: chat.active_branch,
        status: "idle",
        activeRunId: null,
        lastActivityAt: "2026-04-22T00:00:00.000Z",
        unloadAfter: "2026-04-22T00:00:00.000Z",
      });

      await manager.pruneIdleRuntimes(new Date("2026-04-22T00:01:00.000Z"));

      expect(fakeRuntime.disposeCalls.count).toBe(0);
      expect(manager.getLoadedRuntime(chat.id)).not.toBeNull();
      unsubscribe();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
