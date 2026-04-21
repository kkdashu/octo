import {
  AgentSessionRuntime,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSessionServices,
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import type { ConversationMessageInput } from "../providers/types";
import type { ChatRow, WorkspaceRow } from "../db";
import { log } from "../logger";
import { CliStateStore } from "./state-store";
import { GroupRuntimeManager } from "../kernel/group-runtime-manager";

export interface OctoCliRuntimeHostOptions {
  manager: GroupRuntimeManager;
  stateStore: CliStateStore;
  currentWorkspace: WorkspaceRow;
  currentChat: ChatRow;
  runtime: AgentSessionRuntime;
}

type ExternalSwitchKind = "chat" | "workspace";

const TAG = "octo-cli-runtime-host";

export interface OctoCliRuntimeSwitchEvent {
  kind: ExternalSwitchKind;
  workspace: WorkspaceRow;
  chat: ChatRow;
  runtime: AgentSessionRuntime;
}

const unsupportedCreateRuntime: CreateAgentSessionRuntimeFactory = async () => {
  throw new Error("OctoCliRuntimeHost delegates runtime creation to the wrapped AgentSessionRuntime");
};

export class OctoCliRuntimeHost extends AgentSessionRuntime {
  private currentWorkspace: WorkspaceRow;
  private currentChat: ChatRow;
  private currentRuntime: AgentSessionRuntime;
  private readonly sessionProxy: AgentSessionRuntime["session"];
  private externalSwitchHandler:
    | ((event: OctoCliRuntimeSwitchEvent) => Promise<void> | void)
    | null = null;

  constructor(private readonly options: OctoCliRuntimeHostOptions) {
    super(
      options.runtime.session,
      options.runtime.services,
      unsupportedCreateRuntime,
      [...options.runtime.diagnostics],
      options.runtime.modelFallbackMessage,
    );
    this.currentWorkspace = options.currentWorkspace;
    this.currentChat = options.currentChat;
    this.currentRuntime = options.runtime;
    this.sessionProxy = new Proxy({} as AgentSessionRuntime["session"], {
      get: (_target, property, receiver) => {
        const currentSession = this.currentRuntime.session as Record<PropertyKey, unknown>;

        if (property === "prompt") {
          return async (text: string, promptOptions?: { streamingBehavior?: string }) => {
            const streamingBehavior = promptOptions?.streamingBehavior;
            let mode: ConversationMessageInput["mode"] = "prompt";
            if (streamingBehavior === "followUp") {
              mode = "follow_up";
            } else if (streamingBehavior === "steer") {
              mode = "steer";
            }

            await this.options.manager.prompt(this.currentChat.id, {
              text,
              mode,
            }, {
              sourceType: "cli",
            });
          };
        }

        if (property === "followUp") {
          return async (text: string) => {
            await this.options.manager.prompt(this.currentChat.id, {
              text,
              mode: "follow_up",
            }, {
              sourceType: "cli",
            });
          };
        }

        if (property === "steer") {
          return async (text: string) => {
            await this.options.manager.prompt(this.currentChat.id, {
              text,
              mode: "steer",
            }, {
              sourceType: "cli",
            });
          };
        }

        const value = Reflect.get(currentSession, property, receiver);
        return typeof value === "function" ? value.bind(currentSession) : value;
      },
    });
    this.syncStateStore();
  }

  override get services(): AgentSessionServices {
    return this.currentRuntime.services;
  }

  override get session() {
    return this.sessionProxy;
  }

  override get cwd(): string {
    return this.currentRuntime.cwd;
  }

  override get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
    return this.currentRuntime.diagnostics;
  }

  override get modelFallbackMessage(): string | undefined {
    return this.currentRuntime.modelFallbackMessage;
  }

  setExternalSwitchHandler(
    handler: ((event: OctoCliRuntimeSwitchEvent) => Promise<void> | void) | null,
  ): void {
    this.externalSwitchHandler = handler;
  }

  getCurrentWorkspace(): WorkspaceRow {
    return this.currentWorkspace;
  }

  getCurrentChat(): ChatRow {
    return this.currentChat;
  }

  override async newSession(options?: {
    parentSession?: string;
    setup?: Parameters<AgentSessionRuntime["newSession"]>[0] extends infer T
      ? T extends { setup?: infer TSetup }
        ? TSetup
        : never
      : never;
  }): Promise<{ cancelled: boolean }> {
    const result = await this.options.manager.createNewSession(
      this.currentChat.id,
      options,
    );
    this.applyResult(result);
    return { cancelled: result.cancelled };
  }

  override async fork(entryId: string): Promise<{
    cancelled: boolean;
    selectedText?: string;
  }> {
    const result = await this.options.manager.fork(this.currentChat.id, entryId);
    this.applyResult(result);
    return { cancelled: result.cancelled };
  }

  async switchChat(chat: ChatRow): Promise<{ cancelled: boolean }> {
    log.info(TAG, "Switching CLI chat", {
      fromChatId: this.currentChat.id,
      toChatId: chat.id,
      workspaceId: chat.workspace_id,
    });
    const result = await this.options.manager.switchChat(chat.id);
    if (!result.cancelled) {
      this.applyResult(result);
      await this.notifyExternalSwitch("chat");
    }
    return { cancelled: result.cancelled };
  }

  async switchWorkspace(
    workspace: WorkspaceRow,
    chat?: ChatRow,
  ): Promise<{ cancelled: boolean }> {
    const targetChatId = chat?.id ?? this.options.manager
      .listChats()
      .find((item) => item.workspaceId === workspace.id)?.chatId;
    if (!targetChatId) {
      throw new Error(`Workspace has no chat: ${workspace.id}`);
    }

    const result = await this.options.manager.switchChat(targetChatId);
    if (!result.cancelled) {
      this.applyResult(result);
      await this.notifyExternalSwitch("workspace");
    }
    return { cancelled: result.cancelled };
  }

  override async importFromJsonl(
    inputPath: string,
    _cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    const result = await this.options.manager.importFromJsonl(
      this.currentChat.id,
      inputPath,
    );
    this.applyResult(result);
    return { cancelled: result.cancelled };
  }

  override async dispose(): Promise<void> {
    this.syncStateStore();
    await this.options.manager.dispose();
  }

  private applyResult(
    result: Awaited<ReturnType<GroupRuntimeManager["switchChat"]>>,
  ): void {
    this.currentWorkspace = result.workspace;
    this.currentChat = result.chat;
    this.currentRuntime = result.runtime;
    this.syncStateStore();
  }

  private syncStateStore(): void {
    this.options.stateStore.setCurrentChat(
      this.currentChat.id,
      this.currentWorkspace.folder,
    );
    log.debug(TAG, "Synced CLI state store", {
      workspaceFolder: this.currentWorkspace.folder,
      chatId: this.currentChat.id,
    });
  }

  private async notifyExternalSwitch(kind: ExternalSwitchKind): Promise<void> {
    await this.externalSwitchHandler?.({
      kind,
      workspace: this.currentWorkspace,
      chat: this.currentChat,
      runtime: this.currentRuntime,
    });
  }
}
