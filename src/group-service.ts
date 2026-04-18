import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  getGroupByFolder as getDbGroupByFolder,
  getGroupByJid as getDbGroupByJid,
  listGroups as listDbGroups,
  registerGroup,
  renameGroup as renameDbGroup,
  type RegisteredGroup,
} from "./db";
import { loadAgentProfilesConfig } from "./runtime/profile-config";
import { setupGroupWorkspace } from "./group-workspace";

export interface GroupServiceOptions {
  rootDir?: string;
  now?: () => Date;
}

export interface CreateCliGroupOptions {
  name?: string;
  profileKey?: string;
}

function formatTimestampForFolder(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function generateCliFolder(date: Date): string {
  return `cli_${formatTimestampForFolder(date)}_${randomUUID().slice(0, 6)}`;
}

function getDefaultProfileKey(): string {
  return loadAgentProfilesConfig().defaultProfile;
}

export function buildCliGroupJid(folder: string): string {
  return `cli:${folder}`;
}

export class GroupService {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: GroupServiceOptions = {},
  ) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.now = options.now ?? (() => new Date());
  }

  listGroups(): RegisteredGroup[] {
    return listDbGroups(this.db);
  }

  listCliGroups(): RegisteredGroup[] {
    return this.listGroups()
      .filter((group) => group.channel_type === "cli")
      .sort((left, right) => right.added_at.localeCompare(left.added_at));
  }

  getGroupByFolder(folder: string): RegisteredGroup | null {
    return getDbGroupByFolder(this.db, folder);
  }

  getGroupByJid(jid: string): RegisteredGroup | null {
    return getDbGroupByJid(this.db, jid);
  }

  ensureWorkspace(group: RegisteredGroup): void {
    setupGroupWorkspace(group.folder, group.is_main === 1, {
      rootDir: this.rootDir,
    });
  }

  createCliGroup(options: CreateCliGroupOptions = {}): RegisteredGroup {
    const existingGroups = this.listGroups();
    const isMain = !existingGroups.some((group) => group.is_main === 1);
    const folder = generateCliFolder(this.now());
    const name = options.name?.trim() || `CLI ${folder}`;
    const profileKey = options.profileKey?.trim() || getDefaultProfileKey();

    setupGroupWorkspace(folder, isMain, { rootDir: this.rootDir });
    registerGroup(this.db, {
      jid: buildCliGroupJid(folder),
      name,
      folder,
      channelType: "cli",
      requiresTrigger: false,
      isMain,
      profileKey,
    });

    const created = this.getGroupByFolder(folder);
    if (!created) {
      throw new Error(`Failed to load newly created CLI group: ${folder}`);
    }

    return created;
  }

  renameGroup(folder: string, name: string): RegisteredGroup {
    const nextName = name.trim();
    if (!nextName) {
      throw new Error("Group name cannot be empty");
    }

    const group = this.getGroupByFolder(folder);
    if (!group) {
      throw new Error(`Group not found: ${folder}`);
    }

    renameDbGroup(this.db, folder, nextName);
    const updated = this.getGroupByFolder(folder);
    if (!updated) {
      throw new Error(`Failed to load renamed group: ${folder}`);
    }

    return updated;
  }
}
