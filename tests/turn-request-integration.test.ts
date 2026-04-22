import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { CliStateStore } from "../src/cli/state-store";
import { OctoCliRuntimeHost } from "../src/cli/octo-cli-runtime-host";
import {
  createRun,
  createTask,
  initDatabase,
  type ChatRow,
  type WorkspaceRow,
  upsertWorkspaceRuntimeState,
} from "../src/db";
import { GroupRuntimeManager } from "../src/kernel/group-runtime-manager";
import { __test__ as schedulerTestHelpers } from "../src/task-scheduler";
import { WorkspaceService } from "../src/workspace-service";

function createProfilesConfig(rootDir: string): string {
  const configPath = join(rootDir, "agent-profiles.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        defaultProfile: "claude",
        profiles: {
          claude: {
            apiFormat: "anthropic",
            baseUrl: "https://api.anthropic.com",
            apiKeyEnv: "ANTHROPIC_API_KEY",
            model: "claude-sonnet-4-6",
          },
        },
      },
      null,
      2,
    ),
  );
  return configPath;
}

function createFakeRuntime(initialCwd: string): {
  runtime: AgentSessionRuntime;
  sessionManager: SessionManager;
  emit(event: AgentSessionEvent): void;
} {
  const sessionManager = SessionManager.inMemory(initialCwd);
  let sessionFile = join(initialCwd, ".pi", "sessions", "current.jsonl");
  let isStreaming = false;
  const listeners = new Set<(event: AgentSessionEvent) => void>();

  const session = {
    sessionManager,
    settingsManager: {
      getShowHardwareCursor: () => false,
      getClearOnShrink: () => false,
      getEditorPaddingX: () => 0,
      getAutocompleteMaxVisible: () => 8,
      getHideThinkingBlock: () => false,
      getTheme: () => "default",
    },
    agent: {},
    resourceLoader: {
      getThemes: () => ({ themes: [] }),
    },
    promptTemplates: [],
    autoCompactionEnabled: false,
    get sessionFile() {
      return sessionFile;
    },
    set sessionFile(next: string | undefined) {
      sessionFile = next ?? sessionFile;
    },
    get isStreaming() {
      return isStreaming;
    },
    async prompt(text: string) {
      sessionManager.appendMessage({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
    },
    async followUp(_text: string) {},
    async steer(_text: string) {},
    async abort() {
      isStreaming = false;
    },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const runtime = {
    session,
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
    dispose: async () => {},
  };

  return {
    runtime: runtime as unknown as AgentSessionRuntime,
    sessionManager,
    emit(event: AgentSessionEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe("turn request integration", () => {
  test("GroupRuntimeManager prompt persists turn_request and links run", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-turn-request-manager-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      mkdirSync(join(rootDir, "workspaces", "main"), { recursive: true });
      mkdirSync(join(rootDir, "store"), { recursive: true });
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);

      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
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
          sessionRef: null,
        }),
      });

      await manager.prompt(chat.id, {
        mode: "prompt",
        text: "hello turn request",
      }, {
        sourceType: "desktop",
      });
      fakeRuntime.emit({ type: "agent_end", messages: [] });

      const turnRequest = db
        .query(
          `SELECT source_type, request_text, status
           FROM turn_requests
           WHERE chat_id = $chatId
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get({ chatId: chat.id }) as {
        source_type: string;
        request_text: string;
        status: string;
      } | null;
      expect(turnRequest).not.toBeNull();
      expect(turnRequest?.source_type).toBe("desktop");
      expect(turnRequest?.request_text).toBe("hello turn request");
      expect(turnRequest?.status).toBe("completed");

      const run = db
        .query(
          `SELECT turn_request_id, trigger_source
           FROM runs
           WHERE chat_id = $chatId
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .get({ chatId: chat.id }) as {
        turn_request_id: string | null;
        trigger_source: string;
      } | null;
      expect(run?.turn_request_id).not.toBeNull();
      expect(run?.trigger_source).toBe("prompt");
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("OctoCliRuntimeHost session proxy routes prompt variants through manager prompt", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-turn-request-cli-"));

    try {
      const calls: Array<{
        chatId: string;
        input: { text: string; mode: string };
        options: { sourceType?: string; sourceRef?: string } | undefined;
      }> = [];
      const manager = {
        prompt: async (
          chatId: string,
          input: { text: string; mode: "prompt" | "follow_up" | "steer" },
          options?: { sourceType?: "cli" | "desktop" | "system"; sourceRef?: string },
        ) => {
          calls.push({ chatId, input, options });
          return {} as never;
        },
        createNewSession: async () => ({ cancelled: false, workspace: {} as never, chat: {} as never, runtime: {} as never, snapshot: {} as never }),
        fork: async () => ({ cancelled: false, workspace: {} as never, chat: {} as never, runtime: {} as never, snapshot: {} as never }),
        importFromJsonl: async () => ({ cancelled: false, workspace: {} as never, chat: {} as never, runtime: {} as never, snapshot: {} as never }),
        switchChat: async () => ({ cancelled: false, workspace: {} as never, chat: {} as never, runtime: {} as never, snapshot: {} as never }),
        listChats: () => [],
        dispose: async () => undefined,
      } as unknown as GroupRuntimeManager;

      const workspace = {
        id: "ws1",
        name: "CLI",
        folder: "cli_main",
        default_branch: "main",
        status: "active",
        profile_key: "claude",
        created_at: "2026-04-21T00:00:00.000Z",
        updated_at: "2026-04-21T00:00:00.000Z",
      } satisfies WorkspaceRow;
      const chat = {
        id: "chat1",
        workspace_id: "ws1",
        title: "CLI Chat",
        active_branch: "main",
        session_ref: null,
        status: "active",
        trigger_pattern: "",
        requires_trigger: 0,
        created_at: "2026-04-21T00:00:00.000Z",
        updated_at: "2026-04-21T00:00:00.000Z",
        last_activity_at: null,
      } satisfies ChatRow;
      const fakeRuntime = createFakeRuntime(rootDir);
      const host = new OctoCliRuntimeHost({
        manager,
        stateStore: new CliStateStore(join(rootDir, "cli-state.json")),
        currentWorkspace: workspace,
        currentChat: chat,
        runtime: fakeRuntime.runtime,
      });

      await host.session.prompt("hello");
      await host.session.followUp("next");
      await host.session.steer("adjust");

      expect(calls).toEqual([
        {
          chatId: "chat1",
          input: { text: "hello", mode: "prompt" },
          options: { sourceType: "cli" },
        },
        {
          chatId: "chat1",
          input: { text: "next", mode: "follow_up" },
          options: { sourceType: "cli" },
        },
        {
          chatId: "chat1",
          input: { text: "adjust", mode: "steer" },
          options: { sourceType: "cli" },
        },
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("scheduler writes turn_request before executing the runtime controller", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-turn-request-scheduler-"));

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
      });
      const chat = workspaceService.createChat(workspace.id, {
        title: "Main",
        requiresTrigger: false,
      });

      createTask(db, {
        workspaceId: workspace.id,
        chatId: chat.id,
        prompt: "do scheduled work",
        scheduleType: "cron",
        scheduleValue: "* * * * *",
        contextMode: "isolated",
        nextRun: "2026-04-21T00:00:00.000Z",
      });

      let executedTurnRequestId = "";
      schedulerTestHelpers.pollAndExecute(db, {} as never, {
        isActive: () => false,
        pushMessage: () => false,
        enqueue: async () => ({
          status: "completed",
          failureNotified: false,
        }),
        executeTurnRequest: async (turnRequestId: string) => {
          executedTurnRequestId = turnRequestId;
          return {
            status: "completed",
            failureNotified: false,
          };
        },
        clearSession: async () => ({
          closedActiveSession: false,
          previousSessionRef: null,
          sessionRef: "fresh",
          generation: 1,
        }),
      });

      const turnRequest = db
        .query(
          `SELECT source_type, source_ref, request_text
           FROM turn_requests
           WHERE id = $id`,
        )
        .get({ id: executedTurnRequestId }) as {
        source_type: string;
        source_ref: string | null;
        request_text: string;
      } | null;
      expect(turnRequest).not.toBeNull();
      expect(turnRequest?.source_type).toBe("scheduled_task");
      expect(turnRequest?.source_ref).not.toBeNull();
      expect(turnRequest?.request_text).toContain("do scheduled work");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("failed startRun marks turn_request as failed instead of leaving it running", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-turn-request-active-run-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      mkdirSync(join(rootDir, "workspaces", "main"), { recursive: true });
      mkdirSync(join(rootDir, "store"), { recursive: true });
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);

      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
      });
      const firstChat = workspaceService.createChat(workspace.id, {
        title: "First",
        requiresTrigger: false,
      });
      const secondChat = workspaceService.createChat(workspace.id, {
        title: "Second",
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
        createChatRuntime: async (chatId) => ({
          workspace,
          chat: workspaceService.getChatById(chatId)!,
          runtime: fakeRuntime.runtime,
          sessionRef: null,
        }),
      });

      const staleRun = createRun(db, {
        workspaceId: workspace.id,
        chatId: firstChat.id,
        status: "running",
        branch: firstChat.active_branch,
        triggerSource: "prompt",
        startedAt: "2026-04-21T14:22:21.991Z",
      });
      upsertWorkspaceRuntimeState(db, {
        workspaceId: workspace.id,
        checkedOutBranch: firstChat.active_branch,
        activeRunId: staleRun.id,
        status: "running",
        lastActivityAt: "2026-04-21T14:22:21.991Z",
        unloadAfter: null,
      });

      await expect(manager.prompt(secondChat.id, {
        mode: "prompt",
        text: "second run",
      }, {
        sourceType: "cli",
      })).rejects.toThrow(`Workspace already has an active run: ${workspace.id}`);

      const failedTurnRequest = db
        .query(
          `SELECT status, error
           FROM turn_requests
           WHERE chat_id = $chatId
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get({ chatId: secondChat.id }) as {
        status: string;
        error: string | null;
      } | null;
      expect(failedTurnRequest?.status).toBe("failed");
      expect(failedTurnRequest?.error).toContain(`Workspace already has an active run: ${workspace.id}`);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("prompt completion without agent_end still finishes the run", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-turn-request-no-agent-end-"));
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      mkdirSync(join(rootDir, "workspaces", "main"), { recursive: true });
      mkdirSync(join(rootDir, "store"), { recursive: true });
      process.env.AGENT_PROFILES_PATH = createProfilesConfig(rootDir);

      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
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
          sessionRef: null,
        }),
      });

      await manager.prompt(chat.id, {
        mode: "prompt",
        text: "no agent end",
      }, {
        sourceType: "cli",
      });

      const run = db
        .query(
          `SELECT status, ended_at
           FROM runs
           WHERE chat_id = $chatId
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .get({ chatId: chat.id }) as {
        status: string;
        ended_at: string | null;
      } | null;
      expect(run?.status).toBe("completed");
      expect(run?.ended_at).not.toBeNull();

      const runtimeState = db
        .query(
          `SELECT active_run_id, status
           FROM workspace_runtime_state
           WHERE workspace_id = $workspaceId`,
        )
        .get({ workspaceId: workspace.id }) as {
        active_run_id: string | null;
        status: string;
      } | null;
      expect(runtimeState?.active_run_id).toBeNull();
      expect(runtimeState?.status).toBe("idle");
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
