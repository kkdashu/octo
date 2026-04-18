import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { ConversationMessageInput } from "../providers/types";
import { getSessionRef, saveSessionRef, type RegisteredGroup } from "../db";
import { GroupService } from "../group-service";
import type { MessageSender } from "../tools";
import type { PiGroupRuntimeContext } from "../runtime/pi-group-runtime-factory";
import {
  createPiGroupRuntime,
  getGroupForWorkingDirectory,
} from "../runtime/pi-group-runtime-factory";
import {
  buildRenderableMessages,
  toRenderableAssistantDelta,
  toRenderableMessage,
} from "./renderable-message";
import { getSessionHeader } from "./session-file";
import type {
  GroupRuntimeEvent,
  GroupRuntimeListener,
  GroupRuntimeOperationResult,
  GroupRuntimeSnapshot,
  GroupRuntimeSnapshotController,
  GroupRuntimeSummary,
  RuntimeRenderableMessage,
} from "./types";

type CreateGroupRuntimeResult = {
  group: RegisteredGroup;
  runtime: AgentSessionRuntime;
  sessionRef: string;
};

type ManagedGroupRuntime = {
  group: RegisteredGroup;
  runtime: AgentSessionRuntime;
  unsubscribeSession: () => void;
  pendingFollowUp: string[];
  pendingSteering: string[];
  streamingMessageId: string | null;
};

export interface GroupRuntimeManagerOptions {
  db: Database;
  groupService: GroupService;
  rootDir?: string;
  createMessageSender: (
    context: PiGroupRuntimeContext,
  ) => MessageSender;
  getExtensionFactories?: (
    context: PiGroupRuntimeContext,
  ) => ExtensionFactory[] | Promise<ExtensionFactory[]>;
  createGroupRuntime?: (
    groupFolder: string,
  ) => Promise<CreateGroupRuntimeResult>;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? "", null, 2);
  } catch {
    return String(value);
  }
}

export class GroupRuntimeManager implements GroupRuntimeSnapshotController {
  private readonly rootDir: string;
  private readonly listeners = new Map<string, Set<GroupRuntimeListener>>();
  private readonly runtimes = new Map<string, ManagedGroupRuntime>();
  private readonly pendingLoads = new Map<string, Promise<ManagedGroupRuntime>>();
  private readonly createGroupRuntime: (
    groupFolder: string,
  ) => Promise<CreateGroupRuntimeResult>;

  constructor(private readonly options: GroupRuntimeManagerOptions) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.createGroupRuntime = options.createGroupRuntime
      ?? ((groupFolder) =>
        createPiGroupRuntime({
          db: options.db,
          rootDir: this.rootDir,
          groupFolder,
          createMessageSender: options.createMessageSender,
          getExtensionFactories: options.getExtensionFactories,
        }));
  }

  listGroups(): GroupRuntimeSummary[] {
    return this.options.groupService.listGroups().map((group) => ({
      folder: group.folder,
      name: group.name,
      channelType: group.channel_type,
      isMain: group.is_main === 1,
      profileKey: group.profile_key,
      sessionRef: getSessionRef(this.options.db, group.folder),
      isStreaming: this.runtimes.get(group.folder)?.runtime.session.isStreaming ?? false,
    }));
  }

  async ensureRuntime(groupFolder: string): Promise<AgentSessionRuntime> {
    return (await this.ensureManagedRuntime(groupFolder)).runtime;
  }

  getLoadedRuntime(groupFolder: string): AgentSessionRuntime | null {
    return this.runtimes.get(groupFolder)?.runtime ?? null;
  }

  async getSnapshot(groupFolder: string): Promise<GroupRuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(groupFolder);
    return this.buildSnapshot(managed);
  }

  async prompt(
    groupFolder: string,
    input: ConversationMessageInput,
  ): Promise<GroupRuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(groupFolder);
    await this.sendInput(managed, input);
    const snapshot = this.buildSnapshot(managed);
    this.emit(groupFolder, { type: "snapshot", snapshot });
    return snapshot;
  }

  async abort(groupFolder: string): Promise<GroupRuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(groupFolder);
    await managed.runtime.session.abort();
    const snapshot = this.buildSnapshot(managed);
    this.emit(groupFolder, { type: "snapshot", snapshot });
    return snapshot;
  }

  async newSession(groupFolder: string): Promise<GroupRuntimeSnapshot> {
    const result = await this.startNewSession(groupFolder);
    return result.snapshot;
  }

  async createNewSession(
    groupFolder: string,
    options?: Parameters<AgentSessionRuntime["newSession"]>[0],
  ): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(groupFolder);
    const result = await managed.runtime.newSession(options);
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async fork(
    groupFolder: string,
    entryId: string,
  ): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(groupFolder);
    const result = await managed.runtime.fork(entryId);
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async importFromJsonl(
    groupFolder: string,
    inputPath: string,
  ): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(groupFolder);
    const result = await managed.runtime.importFromJsonl(
      inputPath,
      managed.runtime.cwd,
    );
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async switchGroup(groupFolder: string): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(groupFolder);
    const snapshot = this.buildSnapshot(managed);
    return {
      cancelled: false,
      group: managed.group,
      runtime: managed.runtime,
      snapshot,
    };
  }

  async switchSession(
    _currentGroupFolder: string,
    sessionPath: string,
    cwdOverride?: string,
  ): Promise<GroupRuntimeOperationResult> {
    const targetCwd = cwdOverride ?? getSessionHeader(sessionPath)?.cwd;
    if (!targetCwd) {
      throw new Error(`Cannot resolve session cwd: ${sessionPath}`);
    }

    const targetGroup = getGroupForWorkingDirectory(
      this.options.db,
      targetCwd,
      this.rootDir,
    );
    if (!targetGroup) {
      throw new Error(`Session is outside Octo registered groups: ${sessionPath}`);
    }

    const managed = await this.ensureManagedRuntime(targetGroup.folder);
    const result = await managed.runtime.switchSession(sessionPath, targetCwd);
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  subscribe(groupFolder: string, listener: GroupRuntimeListener): () => void {
    const listeners = this.listeners.get(groupFolder) ?? new Set<GroupRuntimeListener>();
    listeners.add(listener);
    this.listeners.set(groupFolder, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(groupFolder);
      }
    };
  }

  async dispose(): Promise<void> {
    const managedRuntimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.pendingLoads.clear();

    for (const managed of managedRuntimes) {
      managed.unsubscribeSession();
      await managed.runtime.dispose();
    }
  }

  private async startNewSession(
    groupFolder: string,
  ): Promise<GroupRuntimeOperationResult> {
    return this.createNewSession(groupFolder);
  }

  private async ensureManagedRuntime(
    groupFolder: string,
  ): Promise<ManagedGroupRuntime> {
    const existing = this.runtimes.get(groupFolder);
    if (existing) {
      return existing;
    }

    const pending = this.pendingLoads.get(groupFolder);
    if (pending) {
      return pending;
    }

    const task = this.createManagedRuntime(groupFolder);
    this.pendingLoads.set(groupFolder, task);

    try {
      const managed = await task;
      this.runtimes.set(groupFolder, managed);
      return managed;
    } finally {
      this.pendingLoads.delete(groupFolder);
    }
  }

  private async createManagedRuntime(
    groupFolder: string,
  ): Promise<ManagedGroupRuntime> {
    const created = await this.createGroupRuntime(groupFolder);
    const managed: ManagedGroupRuntime = {
      group: created.group,
      runtime: created.runtime,
      unsubscribeSession: () => undefined,
      pendingFollowUp: [],
      pendingSteering: [],
      streamingMessageId: null,
    };

    this.bindSession(managed);
    this.persistSessionRef(managed.group.folder, created.sessionRef, managed.runtime);
    return managed;
  }

  private bindSession(managed: ManagedGroupRuntime): void {
    managed.unsubscribeSession();
    managed.pendingFollowUp = [];
    managed.pendingSteering = [];
    managed.streamingMessageId = null;
    managed.unsubscribeSession = managed.runtime.session.subscribe((event) => {
      this.handleSessionEvent(managed, event);
    });
  }

  private handleSessionEvent(
    managed: ManagedGroupRuntime,
    event: AgentSessionEvent,
  ): void {
    const groupFolder = managed.group.folder;

    if (event.type === "queue_update") {
      managed.pendingSteering = [...event.steering];
      managed.pendingFollowUp = [...event.followUp];
      this.emit(groupFolder, {
        type: "queue_update",
        groupFolder,
        steering: [...event.steering],
        followUp: [...event.followUp],
      });
      return;
    }

    if (event.type === "message_start") {
      const messageId = managed.streamingMessageId ?? randomUUID();
      managed.streamingMessageId = messageId;
      const message = toRenderableMessage(messageId, event.message);
      if (message) {
        this.emit(groupFolder, {
          type: "message_start",
          groupFolder,
          message,
        });
      }
      return;
    }

    if (event.type === "message_update") {
      const delta = toRenderableAssistantDelta(event.assistantMessageEvent);
      const messageId = managed.streamingMessageId ?? randomUUID();
      managed.streamingMessageId = messageId;
      const message = toRenderableMessage(messageId, event.message);
      if (delta && message) {
        this.emit(groupFolder, {
          type: "message_delta",
          groupFolder,
          message,
          delta,
        });
      }
      return;
    }

    if (event.type === "message_end") {
      const messageId = managed.streamingMessageId ?? randomUUID();
      const message = toRenderableMessage(messageId, event.message);
      managed.streamingMessageId = null;
      this.persistSessionRef(groupFolder, null, managed.runtime);
      if (message) {
        this.emit(groupFolder, {
          type: "message_end",
          groupFolder,
          message,
        });
      }
      this.emit(groupFolder, {
        type: "snapshot",
        snapshot: this.buildSnapshot(managed),
      });
      return;
    }

    if (event.type === "tool_execution_start") {
      this.emit(groupFolder, {
        type: "tool_start",
        groupFolder,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsText: stringifyUnknown(event.args),
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      this.emit(groupFolder, {
        type: "tool_update",
        groupFolder,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResultText: stringifyUnknown(event.partialResult),
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      this.emit(groupFolder, {
        type: "tool_end",
        groupFolder,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultText: stringifyUnknown(event.result),
        isError: event.isError,
      });
      return;
    }

    if (event.type === "agent_end") {
      this.persistSessionRef(groupFolder, null, managed.runtime);
      this.emit(groupFolder, {
        type: "agent_end",
        groupFolder,
      });
      this.emit(groupFolder, {
        type: "snapshot",
        snapshot: this.buildSnapshot(managed),
      });
      return;
    }

    if (
      event.type === "compaction_end"
      && event.errorMessage
    ) {
      this.emit(groupFolder, {
        type: "error",
        groupFolder,
        message: event.errorMessage,
      });
      return;
    }

    if (
      event.type === "auto_retry_start"
      || event.type === "auto_retry_end"
    ) {
      const message = event.type === "auto_retry_start"
        ? event.errorMessage
        : event.finalError;
      if (message) {
        this.emit(groupFolder, {
          type: "error",
          groupFolder,
          message,
        });
      }
    }
  }

  private buildSnapshot(managed: ManagedGroupRuntime): GroupRuntimeSnapshot {
    return {
      groupFolder: managed.group.folder,
      groupName: managed.group.name,
      profileKey: managed.group.profile_key,
      sessionRef: managed.runtime.session.sessionFile
        ?? getSessionRef(this.options.db, managed.group.folder),
      isStreaming: managed.runtime.session.isStreaming,
      pendingFollowUp: [...managed.pendingFollowUp],
      pendingSteering: [...managed.pendingSteering],
      messages: buildRenderableMessages(managed.runtime.session.sessionManager),
    };
  }

  private async sendInput(
    managed: ManagedGroupRuntime,
    input: ConversationMessageInput,
  ): Promise<void> {
    if (input.mode === "prompt") {
      if (managed.runtime.session.isStreaming) {
        throw new Error(
          "Cannot send mode=prompt while the Pi session is streaming. Use follow_up or steer.",
        );
      }

      await managed.runtime.session.prompt(input.text);
      return;
    }

    if (input.mode === "follow_up") {
      if (managed.runtime.session.isStreaming) {
        await managed.runtime.session.followUp(input.text);
        return;
      }

      await managed.runtime.session.prompt(input.text);
      return;
    }

    if (managed.runtime.session.isStreaming) {
      await managed.runtime.session.steer(input.text);
      return;
    }

    await managed.runtime.session.prompt(input.text);
  }

  private async afterRuntimeOperation(
    managed: ManagedGroupRuntime,
    cancelled: boolean,
  ): Promise<GroupRuntimeOperationResult> {
    if (!cancelled) {
      this.bindSession(managed);
      this.persistSessionRef(managed.group.folder, null, managed.runtime);
    }

    const snapshot = this.buildSnapshot(managed);
    if (!cancelled) {
      this.emit(managed.group.folder, {
        type: "snapshot",
        snapshot,
      });
    }

    return {
      cancelled,
      group: managed.group,
      runtime: managed.runtime,
      snapshot,
    };
  }

  private persistSessionRef(
    groupFolder: string,
    sessionRef: string | null,
    runtime: AgentSessionRuntime,
  ): void {
    const resolved = runtime.session.sessionFile ?? sessionRef;
    if (!resolved) {
      return;
    }

    saveSessionRef(this.options.db, groupFolder, resolved);
  }

  private emit(groupFolder: string, event: GroupRuntimeEvent): void {
    const listeners = this.listeners.get(groupFolder);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        const fallbackMessage = formatErrorMessage(error);
        const snapshotListeners = this.listeners.get(groupFolder);
        if (!snapshotListeners) {
          continue;
        }

        for (const nextListener of snapshotListeners) {
          if (nextListener === listener) {
            continue;
          }

          nextListener({
            type: "error",
            groupFolder,
            message: fallbackMessage,
          });
        }
      }
    }
  }
}
