import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  getWorkspaceRuntimeState,
  initDatabase,
  listRunEvents,
  registerGroup,
} from "../src/db";
import { GroupService } from "../src/group-service";
import { getWorkspaceDirectory } from "../src/group-workspace";
import { GroupRuntimeManager } from "../src/kernel/group-runtime-manager";
import type { GroupRuntimeEvent } from "../src/kernel/types";
import type { MessageSender } from "../src/tools";
import { createWorkspaceBranch } from "../src/workspace-git";
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

function createNoopMessageSender(): MessageSender {
  return {
    send: async () => undefined,
    sendImage: async () => undefined,
    refreshGroupMetadata: async () => ({ count: 0 }),
  };
}

function createWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "octo-group-runtime-manager-"));
  mkdirSync(join(dir, "groups", "main"), { recursive: true });
  mkdirSync(join(dir, "store"), { recursive: true });
  const configPath = createProfilesConfig(dir);
  const db = initDatabase(join(dir, "store", "messages.db"));
  registerGroup(db, {
    jid: "oc_main",
    name: "Main Group",
    folder: "main",
    channelType: "cli",
    requiresTrigger: false,
    isMain: true,
    profileKey: "claude",
  });

  return {
    dir,
    db,
    configPath,
    groupService: new GroupService(db, { rootDir: dir }),
  };
}

function createAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic-messages" as const,
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function createFakeRuntime(initialCwd: string): {
  runtime: AgentSessionRuntime;
  sessionManager: SessionManager;
  emit(event: AgentSessionEvent): void;
  setStreaming(value: boolean): void;
  calls: {
    prompt: string[];
    followUp: string[];
    steer: string[];
  };
} {
  const sessionManager = SessionManager.inMemory(initialCwd);
  let sessionFile = join(initialCwd, ".pi", "sessions", "current.jsonl");
  let isStreaming = false;
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const calls = {
    prompt: [] as string[],
    followUp: [] as string[],
    steer: [] as string[],
  };

  const session = {
    sessionManager,
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
      calls.prompt.push(text);
      sessionManager.appendMessage({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
    },
    async followUp(text: string) {
      calls.followUp.push(text);
    },
    async steer(text: string) {
      calls.steer.push(text);
    },
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
    switchSession: async () => ({ cancelled: false }),
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
    setStreaming(value: boolean) {
      isStreaming = value;
    },
    calls,
  };
}

describe("GroupRuntimeManager", () => {
  test("builds renderable snapshots from session history", async () => {
    const workspace = createWorkspace();
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = workspace.configPath;
      const cwd = join(workspace.dir, "groups", "main");
      const fake = createFakeRuntime(cwd);
      fake.sessionManager.appendMessage({
        role: "user",
        content: "你好",
        timestamp: 1,
      });
      fake.sessionManager.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "先分析" },
          { type: "thinking", thinking: "内部推理" },
          {
            type: "toolCall",
            id: "call_1",
            name: "read_file",
            arguments: { path: "README.md" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
        timestamp: 2,
      });
      fake.sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_file",
        content: [{ type: "text", text: "README 内容" }],
        isError: false,
        timestamp: 3,
      });
      fake.sessionManager.appendMessage({
        role: "bashExecution",
        command: "ls",
        output: "README.md",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 4,
      });
      fake.sessionManager.appendMessage({
        role: "custom",
        customType: "note",
        content: "扩展消息",
        display: true,
        timestamp: 5,
      });
      fake.sessionManager.appendCustomMessageEntry("desktop-note", "顶部提示", true);

      const manager = new GroupRuntimeManager({
        db: workspace.db,
        groupService: workspace.groupService,
        rootDir: workspace.dir,
        createMessageSender: () => createNoopMessageSender(),
        createGroupRuntime: async () => ({
          group: workspace.groupService.getGroupByFolder("main")!,
          runtime: fake.runtime,
          sessionRef: fake.runtime.session.sessionFile!,
        }),
      });

      const snapshot = await manager.getSnapshot("main");

      expect(snapshot.groupFolder).toBe("main");
      expect(snapshot.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "bashExecution",
        "custom",
        "custom",
      ]);
      expect(snapshot.messages[1]?.blocks).toEqual([
        { type: "text", text: "先分析" },
        { type: "thinking", text: "内部推理" },
        {
          type: "tool_call",
          toolCallId: "call_1",
          toolName: "read_file",
          argsText: JSON.stringify({ path: "README.md" }, null, 2),
        },
      ]);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });

  test("routes prompt, follow-up, and steer according to streaming state", async () => {
    const workspace = createWorkspace();
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = workspace.configPath;
      const cwd = join(workspace.dir, "groups", "main");
      const fake = createFakeRuntime(cwd);
      const manager = new GroupRuntimeManager({
        db: workspace.db,
        groupService: workspace.groupService,
        rootDir: workspace.dir,
        createMessageSender: () => createNoopMessageSender(),
        createGroupRuntime: async () => ({
          group: workspace.groupService.getGroupByFolder("main")!,
          runtime: fake.runtime,
          sessionRef: fake.runtime.session.sessionFile!,
        }),
      });

      await manager.prompt("main", { mode: "prompt", text: "hello" });
      expect(fake.calls.prompt).toEqual(["hello"]);

      fake.setStreaming(true);
      await manager.prompt("main", { mode: "follow_up", text: "next" });
      await manager.prompt("main", { mode: "steer", text: "adjust" });

      expect(fake.calls.followUp).toEqual(["next"]);
      expect(fake.calls.steer).toEqual(["adjust"]);
      await expect(
        manager.prompt("main", { mode: "prompt", text: "bad" }),
      ).rejects.toThrow("Cannot send mode=prompt while the Pi session is streaming");
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });

  test("bridges queue, tool, message, and snapshot events", async () => {
    const workspace = createWorkspace();
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = workspace.configPath;
      const cwd = join(workspace.dir, "groups", "main");
      const fake = createFakeRuntime(cwd);
      const manager = new GroupRuntimeManager({
        db: workspace.db,
        groupService: workspace.groupService,
        rootDir: workspace.dir,
        createMessageSender: () => createNoopMessageSender(),
        createGroupRuntime: async () => ({
          group: workspace.groupService.getGroupByFolder("main")!,
          runtime: fake.runtime,
          sessionRef: fake.runtime.session.sessionFile!,
        }),
      });
      const observed: GroupRuntimeEvent[] = [];

      await manager.getSnapshot("main");
      const unsubscribe = manager.subscribe("main", (event) => {
        observed.push(event);
      });

      fake.emit({
        type: "queue_update",
        steering: ["steer-1"],
        followUp: ["follow-1"],
      });
      fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_2",
        toolName: "read_file",
        args: { path: "README.md" },
      });
      fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_2",
        toolName: "read_file",
        args: { path: "README.md" },
        partialResult: { chunk: "part-1" },
      });
      fake.emit({
        type: "message_start",
        message: createAssistantMessage(""),
      });
      fake.emit({
        type: "message_update",
        message: createAssistantMessage("hello"),
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "hello",
          partial: createAssistantMessage("hello"),
        },
      });
      fake.sessionManager.appendMessage(createAssistantMessage("hello"));
      fake.emit({
        type: "message_end",
        message: createAssistantMessage("hello"),
      });
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_2",
        toolName: "read_file",
        result: { text: "done" },
        isError: false,
      });
      fake.emit({
        type: "agent_end",
        messages: [],
      });

      unsubscribe();

      expect(observed.map((event) => event.type)).toEqual([
        "queue_update",
        "tool_start",
        "tool_update",
        "message_start",
        "message_delta",
        "message_end",
        "snapshot",
        "tool_end",
        "agent_end",
        "snapshot",
      ]);
      expect(observed[0]).toMatchObject({
        type: "queue_update",
        steering: ["steer-1"],
        followUp: ["follow-1"],
      });
      expect(observed[4]).toMatchObject({
        type: "message_delta",
        delta: {
          kind: "text",
          text: "hello",
        },
      });
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });

  test("persists run lifecycle and idle unload state for chat runs", async () => {
    const workspace = createWorkspace();
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = workspace.configPath;
      const group = workspace.groupService.getGroupByFolder("main");
      if (!group) {
        throw new Error("group missing");
      }
      workspace.groupService.ensureWorkspace(group);
      const workspaceService = new WorkspaceService(workspace.db, {
        rootDir: workspace.dir,
      });
      const workspaceRow = workspaceService.getWorkspaceByFolder("main");
      if (!workspaceRow) {
        throw new Error("workspace row missing");
      }
      const chat = workspaceService.listChats(workspaceRow.id)[0];
      if (!chat) {
        throw new Error("default chat missing");
      }
      const cwd = getWorkspaceDirectory("main", { rootDir: workspace.dir });
      const fake = createFakeRuntime(cwd);
      const manager = new GroupRuntimeManager({
        db: workspace.db,
        workspaceService,
        rootDir: workspace.dir,
        createMessageSender: () => createNoopMessageSender(),
        createGroupRuntime: async () => ({
          group,
          runtime: fake.runtime,
          sessionRef: fake.runtime.session.sessionFile!,
        }),
      });

      await manager.prompt(chat.id, { mode: "prompt", text: "hello" });

      const runningState = getWorkspaceRuntimeState(workspace.db, workspaceRow.id);
      expect(runningState?.active_run_id).not.toBeNull();
      expect(runningState?.status).toBe("running");
      expect(runningState?.unload_after).toBeNull();

      fake.emit({
        type: "agent_end",
        messages: [],
      });

      const idleState = getWorkspaceRuntimeState(workspace.db, workspaceRow.id);
      expect(idleState?.active_run_id).toBeNull();
      expect(idleState?.status).toBe("idle");
      expect(idleState?.unload_after).not.toBeNull();

      const runs = workspace.db
        .query(
          `SELECT id, trigger_source, status
           FROM runs
           WHERE chat_id = $chatId
           ORDER BY started_at ASC`,
        )
        .all({ chatId: chat.id }) as Array<{
          id: string;
          trigger_source: string;
          status: string;
        }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        trigger_source: "prompt",
        status: "completed",
      });
      expect(listRunEvents(workspace.db, runs[0]!.id).map((event) => event.event_type)).toEqual([
        "run_started",
        "run_completed",
      ]);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });

  test("records branch switch operations as observable runs", async () => {
    const workspace = createWorkspace();
    const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

    try {
      process.env.AGENT_PROFILES_PATH = workspace.configPath;
      const group = workspace.groupService.getGroupByFolder("main");
      if (!group) {
        throw new Error("group missing");
      }
      workspace.groupService.ensureWorkspace(group);
      const workspaceService = new WorkspaceService(workspace.db, {
        rootDir: workspace.dir,
      });
      const workspaceRow = workspaceService.getWorkspaceByFolder("main");
      if (!workspaceRow) {
        throw new Error("workspace row missing");
      }
      const chat = workspaceService.listChats(workspaceRow.id)[0];
      if (!chat) {
        throw new Error("default chat missing");
      }
      const cwd = getWorkspaceDirectory("main", { rootDir: workspace.dir });
      createWorkspaceBranch(cwd, "feature", "main");
      const fake = createFakeRuntime(cwd);
      const manager = new GroupRuntimeManager({
        db: workspace.db,
        workspaceService,
        rootDir: workspace.dir,
        createMessageSender: () => createNoopMessageSender(),
        createGroupRuntime: async () => ({
          group,
          runtime: fake.runtime,
          sessionRef: fake.runtime.session.sessionFile!,
        }),
      });

      const snapshot = await manager.switchBranch(chat.id, "feature", {
        confirm: true,
      });

      expect(snapshot.activeBranch).toBe("feature");
      const runtimeState = getWorkspaceRuntimeState(workspace.db, workspaceRow.id);
      expect(runtimeState?.checked_out_branch).toBe("feature");
      expect(runtimeState?.unload_after).not.toBeNull();

      const runs = workspace.db
        .query(
          `SELECT id, trigger_source, status
           FROM runs
           WHERE chat_id = $chatId
           ORDER BY started_at ASC`,
        )
        .all({ chatId: chat.id }) as Array<{
          id: string;
          trigger_source: string;
          status: string;
        }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        trigger_source: "branch_switch",
        status: "completed",
      });
      expect(listRunEvents(workspace.db, runs[0]!.id).map((event) => event.event_type)).toEqual([
        "run_started",
        "branch_switched",
        "run_completed",
      ]);
    } finally {
      if (previousProfilesPath === undefined) {
        delete process.env.AGENT_PROFILES_PATH;
      } else {
        process.env.AGENT_PROFILES_PATH = previousProfilesPath;
      }
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });
});
