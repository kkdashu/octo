import { existsSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  AgentSessionRuntime,
  parseSessionEntries,
  type SessionHeader,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSessionServices,
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import { saveSessionRef, type RegisteredGroup } from "../db";
import { GroupService } from "../group-service";
import { resolveGroupSessionRef } from "../runtime/pi-group-runtime-factory";
import { CliStateStore } from "./state-store";

export interface OctoCliRuntimeHostOptions {
  db: Database;
  groupService: GroupService;
  stateStore: CliStateStore;
  rootDir?: string;
  currentGroup: RegisteredGroup;
}

function getSessionHeader(sessionPath: string): SessionHeader | null {
  if (!existsSync(sessionPath)) {
    return null;
  }

  const entries = parseSessionEntries(readFileSync(sessionPath, "utf8"));
  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") {
    return null;
  }

  return header;
}

const unsupportedCreateRuntime: CreateAgentSessionRuntimeFactory = async () => {
  throw new Error("OctoCliRuntimeHost delegates runtime creation to the wrapped AgentSessionRuntime");
};

export class OctoCliRuntimeHost extends AgentSessionRuntime {
  private currentGroup: RegisteredGroup;
  private readonly rootDir: string;
  private readonly wrappedRuntime: AgentSessionRuntime;

  constructor(
    runtimeHost: AgentSessionRuntime,
    private readonly options: OctoCliRuntimeHostOptions,
  ) {
    super(
      runtimeHost.session,
      runtimeHost.services,
      unsupportedCreateRuntime,
      [...runtimeHost.diagnostics],
      runtimeHost.modelFallbackMessage,
    );
    this.wrappedRuntime = runtimeHost;
    this.currentGroup = options.currentGroup;
    this.rootDir = options.rootDir ?? process.cwd();
    this.persistActiveSessionRef();
    this.options.stateStore.setCurrentGroupFolder(this.currentGroup.folder);
  }

  override get services(): AgentSessionServices {
    return this.wrappedRuntime.services;
  }

  override get session() {
    return this.wrappedRuntime.session;
  }

  override get cwd(): string {
    return this.wrappedRuntime.cwd;
  }

  override get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
    return this.wrappedRuntime.diagnostics;
  }

  override get modelFallbackMessage(): string | undefined {
    return this.wrappedRuntime.modelFallbackMessage;
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
    const result = await this.wrappedRuntime.newSession(options);
    if (!result.cancelled) {
      this.persistActiveSessionRef();
    }
    return result;
  }

  override async fork(entryId: string): Promise<{
    cancelled: boolean;
    selectedText?: string;
  }> {
    const result = await this.wrappedRuntime.fork(entryId);
    if (!result.cancelled) {
      this.persistActiveSessionRef();
    }
    return result;
  }

  override async switchSession(
    sessionPath: string,
    cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    const targetCwd = cwdOverride ?? getSessionHeader(sessionPath)?.cwd;
    if (!targetCwd) {
      throw new Error(`Cannot resolve session cwd: ${sessionPath}`);
    }

    const targetGroup = this.getGroupForCwd(targetCwd);
    if (!targetGroup) {
      throw new Error(`Session is outside Octo registered groups: ${sessionPath}`);
    }

    const result = await this.wrappedRuntime.switchSession(sessionPath, targetCwd);
    if (!result.cancelled) {
      this.currentGroup = targetGroup;
      this.persistActiveSessionRef();
      this.options.stateStore.setCurrentGroupFolder(targetGroup.folder);
    }
    return result;
  }

  async switchGroup(group: RegisteredGroup): Promise<{ cancelled: boolean }> {
    const workingDirectory = resolve(this.rootDir, "groups", group.folder);
    const sessionRef = resolveGroupSessionRef(
      this.options.db,
      group.folder,
      workingDirectory,
    );
    const result = await this.wrappedRuntime.switchSession(sessionRef, workingDirectory);
    if (!result.cancelled) {
      this.currentGroup = group;
      this.persistActiveSessionRef();
      this.options.stateStore.setCurrentGroupFolder(group.folder);
    }
    return result;
  }

  async importFromJsonl(
    inputPath: string,
    _cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    const result = await this.wrappedRuntime.importFromJsonl(inputPath, this.cwd);
    if (!result.cancelled) {
      this.persistActiveSessionRef();
    }
    return result;
  }

  override async dispose(): Promise<void> {
    this.options.stateStore.setCurrentGroupFolder(this.currentGroup.folder);
    await this.wrappedRuntime.dispose();
  }

  private getGroupForCwd(cwd: string): RegisteredGroup | null {
    const groupsRoot = resolve(this.rootDir, "groups");
    const normalizedCwd = resolve(cwd);
    const prefix = `${groupsRoot}/`;
    const prefixAlt = `${groupsRoot}\\`;

    if (
      normalizedCwd !== groupsRoot &&
      !normalizedCwd.startsWith(prefix) &&
      !normalizedCwd.startsWith(prefixAlt)
    ) {
      return null;
    }

    const folder = normalizedCwd
      .slice(groupsRoot.length)
      .replace(/^[/\\]+/, "")
      .split(/[\\/]/)[0];
    if (!folder) {
      return null;
    }

    return this.options.groupService.getGroupByFolder(folder);
  }

  private persistActiveSessionRef(): void {
    const sessionFile = this.wrappedRuntime.session.sessionFile;
    if (!sessionFile) {
      return;
    }

    saveSessionRef(this.options.db, this.currentGroup.folder, sessionFile);
  }
}

export const __test__ = {
  getSessionHeader,
};
