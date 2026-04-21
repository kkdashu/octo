import {
  AgentSessionRuntime,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSessionServices,
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import type { ChatRow, RegisteredGroup, WorkspaceRow } from "../db";
import { log } from "../logger";
import { CliStateStore } from "./state-store";
import { GroupRuntimeManager } from "../kernel/group-runtime-manager";

export interface OctoCliRuntimeHostOptions {
  manager: GroupRuntimeManager;
  stateStore: CliStateStore;
  currentWorkspace: WorkspaceRow;
  currentChat: ChatRow;
  currentGroup?: RegisteredGroup | null;
  runtime: AgentSessionRuntime;
}

type ExternalSwitchKind = "chat" | "workspace" | "group";

const TAG = "octo-cli-runtime-host";

export interface OctoCliRuntimeSwitchEvent {
  kind: ExternalSwitchKind;
  workspace: WorkspaceRow;
  chat: ChatRow;
  group: RegisteredGroup | null;
  runtime: AgentSessionRuntime;
}

const unsupportedCreateRuntime: CreateAgentSessionRuntimeFactory = async () => {
  throw new Error("OctoCliRuntimeHost delegates runtime creation to the wrapped AgentSessionRuntime");
};

export class OctoCliRuntimeHost extends AgentSessionRuntime {
  private currentWorkspace: WorkspaceRow;
  private currentChat: ChatRow;
  private currentGroup: RegisteredGroup | null;
  private currentRuntime: AgentSessionRuntime;
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
    this.currentGroup = options.currentGroup ?? null;
    this.currentRuntime = options.runtime;
    this.syncStateStore();
  }

  override get services(): AgentSessionServices {
    return this.currentRuntime.services;
  }

  override get session() {
    return this.currentRuntime.session;
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

  getCurrentGroup(): RegisteredGroup {
    return this.currentGroup ?? {
      jid: `workspace:${this.currentWorkspace.folder}`,
      name: this.currentWorkspace.name,
      folder: this.currentWorkspace.folder,
      channel_type: "workspace",
      trigger_pattern: this.currentChat.trigger_pattern,
      added_at: this.currentWorkspace.created_at,
      requires_trigger: this.currentChat.requires_trigger,
      is_main: this.currentWorkspace.is_main,
      profile_key: this.currentWorkspace.profile_key,
    };
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
      log.info(TAG, "Switched CLI chat", {
        chatId: this.currentChat.id,
        workspaceFolder: this.currentWorkspace.folder,
        sessionRef: this.currentChat.session_ref,
      });
      await this.notifyExternalSwitch("chat");
    } else {
      log.info(TAG, "CLI chat switch cancelled", {
        requestedChatId: chat.id,
      });
    }
    return { cancelled: result.cancelled };
  }

  async switchWorkspace(
    workspace: WorkspaceRow,
    chat?: ChatRow,
  ): Promise<{ cancelled: boolean }> {
    log.info(TAG, "Switching CLI workspace", {
      fromWorkspaceFolder: this.currentWorkspace.folder,
      toWorkspaceFolder: workspace.folder,
      requestedChatId: chat?.id ?? null,
    });
    const result = chat
      ? await this.options.manager.switchChat(chat.id)
      : await this.options.manager.switchGroup(workspace.folder);
    if (!result.cancelled) {
      this.applyResult(result);
      log.info(TAG, "Switched CLI workspace", {
        workspaceFolder: this.currentWorkspace.folder,
        chatId: this.currentChat.id,
        sessionRef: this.currentChat.session_ref,
      });
      await this.notifyExternalSwitch("workspace");
    } else {
      log.info(TAG, "CLI workspace switch cancelled", {
        requestedWorkspaceFolder: workspace.folder,
        requestedChatId: chat?.id ?? null,
      });
    }
    return { cancelled: result.cancelled };
  }

  async switchGroup(group: RegisteredGroup): Promise<{ cancelled: boolean }> {
    log.info(TAG, "Switching CLI group", {
      fromGroupFolder: this.currentGroup?.folder ?? this.currentWorkspace.folder,
      toGroupFolder: group.folder,
    });
    const result = await this.options.manager.switchGroup(group.folder);
    if (!result.cancelled) {
      this.applyResult(result, group);
      log.info(TAG, "Switched CLI group", {
        groupFolder: this.currentGroup?.folder ?? this.currentWorkspace.folder,
        chatId: this.currentChat.id,
        sessionRef: this.currentChat.session_ref,
      });
      await this.notifyExternalSwitch("group");
    } else {
      log.info(TAG, "CLI group switch cancelled", {
        requestedGroupFolder: group.folder,
      });
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
    fallbackGroup?: RegisteredGroup | null,
  ): void {
    this.currentWorkspace = result.workspace;
    this.currentChat = result.chat;
    this.currentGroup = result.group ?? fallbackGroup ?? null;
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
    log.debug(TAG, "Notifying CLI external switch handler", {
      kind,
      workspaceFolder: this.currentWorkspace.folder,
      chatId: this.currentChat.id,
      groupFolder: this.currentGroup?.folder ?? null,
    });
    await this.externalSwitchHandler?.({
      kind,
      workspace: this.currentWorkspace,
      chat: this.currentChat,
      group: this.currentGroup,
      runtime: this.currentRuntime,
    });
  }
}
