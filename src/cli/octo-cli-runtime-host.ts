import {
  AgentSessionRuntime,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSessionServices,
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import type { RegisteredGroup } from "../db";
import { CliStateStore } from "./state-store";
import { GroupRuntimeManager } from "../kernel/group-runtime-manager";

export interface OctoCliRuntimeHostOptions {
  manager: GroupRuntimeManager;
  stateStore: CliStateStore;
  currentGroup: RegisteredGroup;
  runtime: AgentSessionRuntime;
}

const unsupportedCreateRuntime: CreateAgentSessionRuntimeFactory = async () => {
  throw new Error("OctoCliRuntimeHost delegates runtime creation to the wrapped AgentSessionRuntime");
};

export class OctoCliRuntimeHost extends AgentSessionRuntime {
  private currentGroup: RegisteredGroup;
  private currentRuntime: AgentSessionRuntime;

  constructor(private readonly options: OctoCliRuntimeHostOptions) {
    super(
      options.runtime.session,
      options.runtime.services,
      unsupportedCreateRuntime,
      [...options.runtime.diagnostics],
      options.runtime.modelFallbackMessage,
    );
    this.currentGroup = options.currentGroup;
    this.currentRuntime = options.runtime;
    this.options.stateStore.setCurrentGroupFolder(this.currentGroup.folder);
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

  getCurrentGroup(): RegisteredGroup {
    return this.currentGroup;
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
      this.currentGroup.folder,
      options,
    );
    this.currentRuntime = result.runtime;
    return { cancelled: result.cancelled };
  }

  override async fork(entryId: string): Promise<{
    cancelled: boolean;
    selectedText?: string;
  }> {
    const result = await this.options.manager.fork(this.currentGroup.folder, entryId);
    this.currentRuntime = result.runtime;
    return { cancelled: result.cancelled };
  }

  override async switchSession(
    sessionPath: string,
    cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    const result = await this.options.manager.switchSession(
      this.currentGroup.folder,
      sessionPath,
      cwdOverride,
    );
    if (!result.cancelled) {
      this.currentGroup = result.group;
      this.currentRuntime = result.runtime;
      this.options.stateStore.setCurrentGroupFolder(result.group.folder);
    }
    return { cancelled: result.cancelled };
  }

  async switchGroup(group: RegisteredGroup): Promise<{ cancelled: boolean }> {
    const result = await this.options.manager.switchGroup(group.folder);
    this.currentGroup = result.group;
    this.currentRuntime = result.runtime;
    this.options.stateStore.setCurrentGroupFolder(group.folder);
    return { cancelled: false };
  }

  override async importFromJsonl(
    inputPath: string,
    _cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    const result = await this.options.manager.importFromJsonl(
      this.currentGroup.folder,
      inputPath,
    );
    this.currentRuntime = result.runtime;
    return { cancelled: result.cancelled };
  }

  override async dispose(): Promise<void> {
    this.options.stateStore.setCurrentGroupFolder(this.currentGroup.folder);
    await this.options.manager.dispose();
  }
}
