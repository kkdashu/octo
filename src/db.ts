import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadAgentProfilesConfig } from "./runtime/profile-config";

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

export function initDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      channel_type TEXT NOT NULL DEFAULT 'feishu',
      trigger_pattern TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      profile_key TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      mentions_me INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_ref TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS image_understanding_cache (
      cache_key TEXT PRIMARY KEY,
      image_path TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      analysis_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS group_memories (
      group_folder TEXT NOT NULL,
      key TEXT NOT NULL,
      key_type TEXT NOT NULL DEFAULT 'builtin',
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      profile_key TEXT NOT NULL,
      is_main INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_bindings (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(platform, external_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      active_branch TEXT NOT NULL,
      session_ref TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      trigger_pattern TEXT NOT NULL DEFAULT '',
      requires_trigger INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_bindings (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_thread_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(platform, external_chat_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_memories (
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL,
      key_type TEXT NOT NULL DEFAULT 'builtin',
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL,
      branch TEXT NOT NULL,
      trigger_source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      cancel_requested_at TEXT,
      error TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_runtime_state (
      workspace_id TEXT PRIMARY KEY,
      checked_out_branch TEXT NOT NULL,
      active_run_id TEXT,
      status TEXT NOT NULL,
      last_activity_at TEXT,
      unload_after TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  // Migrations: add columns that may not exist in older databases
  try {
    db.run("ALTER TABLE messages ADD COLUMN mentions_me INTEGER DEFAULT 0");
  } catch {
    // Column already exists, ignore
  }
  migrateRegisteredGroupsProfileKey(db);
  migrateSessionsSessionRef(db);
  migrateWorkspacesProfileKey(db);
  migrateChatsTriggerConfig(db);
  migrateLegacyGroupsToWorkspaces(db);

  return db;
}

type TableInfoRow = {
  name: string;
};

function getTableColumns(db: Database, tableName: string): string[] {
  return (db
    .query(`PRAGMA table_info(${tableName})`)
    .all() as TableInfoRow[]).map((row) => row.name);
}

function getDefaultProfileKey(): string {
  return loadAgentProfilesConfig().defaultProfile;
}

function migrateRegisteredGroupsProfileKey(db: Database): void {
  const columns = getTableColumns(db, "registered_groups");
  if (columns.includes("profile_key")) {
    return;
  }

  if (columns.includes("agent_provider")) {
    db.run("ALTER TABLE registered_groups RENAME COLUMN agent_provider TO profile_key");
    return;
  }

  db.run("ALTER TABLE registered_groups ADD COLUMN profile_key TEXT");
  db.query(
    `UPDATE registered_groups
     SET profile_key = $profileKey
     WHERE profile_key IS NULL OR trim(profile_key) = ''`,
  ).run({ profileKey: getDefaultProfileKey() });
}

function migrateSessionsSessionRef(db: Database): void {
  const columns = getTableColumns(db, "sessions");
  if (columns.includes("session_ref")) {
    return;
  }

  if (columns.includes("session_id")) {
    db.run("ALTER TABLE sessions RENAME COLUMN session_id TO session_ref");
  }
}

function migrateWorkspacesProfileKey(db: Database): void {
  const columns = getTableColumns(db, "workspaces");

  if (!columns.includes("profile_key")) {
    db.run("ALTER TABLE workspaces ADD COLUMN profile_key TEXT");
    db.query(
      `UPDATE workspaces
       SET profile_key = $profileKey
       WHERE profile_key IS NULL OR trim(profile_key) = ''`,
    ).run({ profileKey: getDefaultProfileKey() });
  }

  if (!columns.includes("is_main")) {
    db.run("ALTER TABLE workspaces ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0");
  }
}

function migrateChatsTriggerConfig(db: Database): void {
  const columns = getTableColumns(db, "chats");

  if (!columns.includes("trigger_pattern")) {
    db.run("ALTER TABLE chats ADD COLUMN trigger_pattern TEXT NOT NULL DEFAULT ''");
  }

  if (!columns.includes("requires_trigger")) {
    db.run("ALTER TABLE chats ADD COLUMN requires_trigger INTEGER NOT NULL DEFAULT 1");
  }
}

function getLegacyWorkspaceId(folder: string): string {
  return `workspace:${folder}`;
}

function getLegacyChatId(channelType: string, jid: string): string {
  return `chat:${channelType}:${jid}`;
}

function normalizeBindingPlatform(channelType: string): string {
  return channelType.trim() || "legacy";
}

function migrateLegacyGroupsToWorkspaces(db: Database): void {
  const groups = listGroups(db);
  if (groups.length === 0) {
    return;
  }

  for (const group of groups) {
    const workspace = ensureLegacyWorkspaceRecord(db, group);
    ensureLegacyWorkspaceBinding(db, workspace.id, group.folder, group.added_at);
    ensureLegacyChatRecord(db, workspace, group);
    migrateLegacyGroupMemories(db, workspace.id, group.folder);
    ensureLegacyWorkspaceRuntimeState(db, workspace.id, workspace.default_branch, group.added_at);
  }
}

function ensureLegacyWorkspaceRecord(
  db: Database,
  group: RegisteredGroup,
): WorkspaceRow {
  const existing = getWorkspaceByFolder(db, group.folder);
  if (existing) {
    db.query(
      `UPDATE workspaces
       SET name = $name,
           profile_key = $profileKey,
           is_main = $isMain,
           updated_at = $updatedAt
       WHERE id = $id`,
    ).run({
      id: existing.id,
      name: group.name,
      profileKey: group.profile_key || getDefaultProfileKey(),
      isMain: group.is_main,
      updatedAt: new Date().toISOString(),
    });

    return getWorkspaceByFolder(db, group.folder) ?? existing;
  }

  const createdAt = group.added_at || new Date().toISOString();
  const id = getLegacyWorkspaceId(group.folder);
  db.query(
    `INSERT INTO workspaces (
       id,
       name,
       folder,
       default_branch,
       status,
       profile_key,
       is_main,
       created_at,
       updated_at
     ) VALUES (
       $id,
       $name,
       $folder,
       'main',
       'active',
       $profileKey,
       $isMain,
       $createdAt,
       $updatedAt
     )`,
  ).run({
    id,
    name: group.name,
    folder: group.folder,
    profileKey: group.profile_key || getDefaultProfileKey(),
    isMain: group.is_main,
    createdAt,
    updatedAt: createdAt,
  });

  const created = getWorkspaceByFolder(db, group.folder);
  if (!created) {
    throw new Error(`Failed to migrate legacy workspace: ${group.folder}`);
  }

  return created;
}

function ensureLegacyWorkspaceBinding(
  db: Database,
  workspaceId: string,
  folder: string,
  createdAt: string,
): void {
  const existing = db
    .query(
      `SELECT id FROM workspace_bindings
       WHERE platform = 'legacy_group' AND external_id = $externalId`,
    )
    .get({ externalId: folder }) as { id: string } | null;

  if (existing) {
    return;
  }

  db.query(
    `INSERT INTO workspace_bindings (
       id,
       workspace_id,
       platform,
       external_id,
       created_at
     ) VALUES (
       $id,
       $workspaceId,
       'legacy_group',
       $externalId,
       $createdAt
     )`,
  ).run({
    id: `workspace-binding:${folder}`,
    workspaceId,
    externalId: folder,
    createdAt,
  });
}

function ensureLegacyChatRecord(
  db: Database,
  workspace: WorkspaceRow,
  group: RegisteredGroup,
): ChatRow {
  const bindingPlatform = normalizeBindingPlatform(group.channel_type);
  const existingByBinding = getChatByBinding(db, bindingPlatform, group.jid);
  const migratedSessionRef = getSessionRef(db, group.folder);

  if (existingByBinding) {
    db.query(
      `UPDATE chats
       SET workspace_id = $workspaceId,
           title = $title,
           active_branch = COALESCE(NULLIF(active_branch, ''), $activeBranch),
           session_ref = COALESCE(session_ref, $sessionRef),
           trigger_pattern = $triggerPattern,
           requires_trigger = $requiresTrigger,
           updated_at = $updatedAt
       WHERE id = $id`,
    ).run({
      id: existingByBinding.id,
      workspaceId: workspace.id,
      title: group.name,
      activeBranch: workspace.default_branch,
      sessionRef: migratedSessionRef,
      triggerPattern: group.trigger_pattern,
      requiresTrigger: group.requires_trigger,
      updatedAt: new Date().toISOString(),
    });

    return getChatById(db, existingByBinding.id) ?? existingByBinding;
  }

  const createdAt = group.added_at || new Date().toISOString();
  const chatId = getLegacyChatId(group.channel_type, group.jid);
  db.query(
    `INSERT INTO chats (
       id,
       workspace_id,
       title,
       active_branch,
       session_ref,
       status,
       trigger_pattern,
       requires_trigger,
       created_at,
       updated_at,
       last_activity_at
     ) VALUES (
       $id,
       $workspaceId,
       $title,
       $activeBranch,
       $sessionRef,
       'active',
       $triggerPattern,
       $requiresTrigger,
       $createdAt,
       $updatedAt,
       $lastActivityAt
     )`,
  ).run({
    id: chatId,
    workspaceId: workspace.id,
    title: group.name,
    activeBranch: workspace.default_branch,
    sessionRef: migratedSessionRef,
    triggerPattern: group.trigger_pattern,
    requiresTrigger: group.requires_trigger,
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
  });

  db.query(
    `INSERT INTO chat_bindings (
       id,
       chat_id,
       platform,
       external_chat_id,
       external_thread_id,
       created_at
     ) VALUES (
       $id,
       $chatId,
       $platform,
       $externalChatId,
       NULL,
       $createdAt
     )`,
  ).run({
    id: `chat-binding:${bindingPlatform}:${group.jid}`,
    chatId,
    platform: bindingPlatform,
    externalChatId: group.jid,
    createdAt,
  });

  const created = getChatById(db, chatId);
  if (!created) {
    throw new Error(`Failed to migrate legacy chat: ${group.jid}`);
  }

  return created;
}

function migrateLegacyGroupMemories(
  db: Database,
  workspaceId: string,
  groupFolder: string,
): void {
  db.query(
    `INSERT INTO workspace_memories (
       workspace_id,
       key,
       key_type,
       value,
       source,
       created_at,
       updated_at
     )
     SELECT
       $workspaceId,
       key,
       key_type,
       value,
       source,
       created_at,
       updated_at
     FROM group_memories
     WHERE group_folder = $groupFolder
     ON CONFLICT(workspace_id, key) DO UPDATE SET
       key_type = excluded.key_type,
       value = excluded.value,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run({
    workspaceId,
    groupFolder,
  });
}

function ensureLegacyWorkspaceRuntimeState(
  db: Database,
  workspaceId: string,
  defaultBranch: string,
  createdAt: string,
): void {
  db.query(
    `INSERT INTO workspace_runtime_state (
       workspace_id,
       checked_out_branch,
       active_run_id,
       status,
       last_activity_at,
       unload_after,
       last_error,
       updated_at
     ) VALUES (
       $workspaceId,
       $checkedOutBranch,
       NULL,
       'idle',
       $lastActivityAt,
       NULL,
       NULL,
       $updatedAt
     )
     ON CONFLICT(workspace_id) DO NOTHING`,
  ).run({
    workspaceId,
    checkedOutBranch: defaultBranch,
    lastActivityAt: createdAt,
    updatedAt: createdAt,
  });
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
  channel_type: string;
  trigger_pattern: string;
  added_at: string;
  requires_trigger: number;
  is_main: number;
  profile_key: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  folder: string;
  default_branch: string;
  status: string;
  profile_key: string;
  is_main: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceBindingRow {
  id: string;
  workspace_id: string;
  platform: string;
  external_id: string;
  created_at: string;
}

export interface ChatRow {
  id: string;
  workspace_id: string;
  title: string;
  active_branch: string;
  session_ref: string | null;
  status: string;
  trigger_pattern: string;
  requires_trigger: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
}

export interface ChatBindingRow {
  id: string;
  chat_id: string;
  platform: string;
  external_chat_id: string;
  external_thread_id: string | null;
  created_at: string;
}

export interface WorkspaceRuntimeStateRow {
  workspace_id: string;
  checked_out_branch: string;
  active_run_id: string | null;
  status: string;
  last_activity_at: string | null;
  unload_after: string | null;
  last_error: string | null;
  updated_at: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_confirmation";

export interface RunRow {
  id: string;
  workspace_id: string;
  chat_id: string;
  status: RunStatus;
  branch: string;
  trigger_source: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  cancel_requested_at: string | null;
  error: string | null;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  chat_id: string;
  event_type: string;
  payload: string;
  created_at: string;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
  mentions_me: number;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

export interface ImageUnderstandingCacheRow {
  cache_key: string;
  image_path: string;
  file_sha256: string;
  prompt_version: string;
  analysis_text: string;
  created_at: string;
  updated_at: string;
}

export const BUILTIN_GROUP_MEMORY_KEYS = [
  "topic_context",
  "response_language",
  "response_style",
  "interaction_rule",
] as const;

export type BuiltinGroupMemoryKey = (typeof BUILTIN_GROUP_MEMORY_KEYS)[number];
export type GroupMemoryKeyType = "builtin" | "custom";
export type GroupMemorySource = "user" | "tool";

export interface GroupMemoryRow {
  group_folder: string;
  key: string;
  key_type: GroupMemoryKeyType;
  value: string;
  source: GroupMemorySource;
  created_at: string;
  updated_at: string;
}

const GROUP_MEMORY_CUSTOM_KEY_PATTERN = /^[a-z]+(?:_[a-z]+)*$/;

export function isBuiltinGroupMemoryKey(
  key: string,
): key is BuiltinGroupMemoryKey {
  return BUILTIN_GROUP_MEMORY_KEYS.includes(key as BuiltinGroupMemoryKey);
}

export function isValidCustomGroupMemoryKey(key: string): boolean {
  return GROUP_MEMORY_CUSTOM_KEY_PATTERN.test(key);
}

export function isSupportedGroupMemoryKey(key: string): boolean {
  return isBuiltinGroupMemoryKey(key) || isValidCustomGroupMemoryKey(key);
}

export function validateGroupMemoryKey(
  key: string,
  keyType: GroupMemoryKeyType,
): string | null {
  if (keyType === "builtin") {
    if (isBuiltinGroupMemoryKey(key)) {
      return null;
    }

    return `Invalid builtin key: ${key}. Allowed keys: ${BUILTIN_GROUP_MEMORY_KEYS.join(", ")}`;
  }

  if (isValidCustomGroupMemoryKey(key)) {
    return null;
  }

  return `Invalid custom key: ${key}. Use lowercase letters and underscores only.`;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function insertMessage(
  db: Database,
  msg: {
    id: string;
    chatId: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    isBotMessage?: boolean;
    mentionsMe?: boolean;
  },
) {
  db.query(
    `INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, mentions_me)
     VALUES ($id, $chatJid, $sender, $senderName, $content, $timestamp, $isFromMe, $isBotMessage, $mentionsMe)`,
  ).run({
    id: msg.id,
    chatJid: msg.chatId,
    sender: msg.sender,
    senderName: msg.senderName,
    content: msg.content,
    timestamp: msg.timestamp,
    isFromMe: msg.isFromMe ? 1 : 0,
    isBotMessage: msg.isBotMessage ? 1 : 0,
    mentionsMe: msg.mentionsMe ? 1 : 0,
  });
}

export function insertMessages(
  db: Database,
  msgs: Array<{
    id: string;
    chatId: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
  }>,
) {
  const tx = db.transaction(() => {
    for (const msg of msgs) {
      insertMessage(db, msg);
    }
  });
  tx();
}

export function getUnprocessedMessages(
  db: Database,
  chatJid: string,
  since: string,
): MessageRow[] {
  return db
    .query(
      `SELECT * FROM messages
       WHERE chat_jid = $chatJid AND timestamp > $since
       ORDER BY timestamp ASC`,
    )
    .all({ chatJid, since }) as MessageRow[];
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function getGroupByJid(
  db: Database,
  jid: string,
): RegisteredGroup | null {
  return (
    (db
      .query("SELECT * FROM registered_groups WHERE jid = $jid")
      .get({ jid }) as RegisteredGroup | null) ?? null
  );
}

export function getGroupByFolder(
  db: Database,
  folder: string,
): RegisteredGroup | null {
  return (
    (db
      .query("SELECT * FROM registered_groups WHERE folder = $folder")
      .get({ folder }) as RegisteredGroup | null) ?? null
  );
}

export function listGroups(db: Database): RegisteredGroup[] {
  return db
    .query("SELECT * FROM registered_groups")
    .all() as RegisteredGroup[];
}

export function registerGroup(
  db: Database,
  group: {
    jid: string;
    name: string;
    folder: string;
    channelType?: string;
    triggerPattern?: string;
    requiresTrigger?: boolean;
    isMain?: boolean;
    profileKey?: string;
  },
) {
  db.query(
    `INSERT INTO registered_groups (jid, name, folder, channel_type, trigger_pattern, added_at, requires_trigger, is_main, profile_key)
     VALUES ($jid, $name, $folder, $channelType, $triggerPattern, $addedAt, $requiresTrigger, $isMain, $profileKey)
     ON CONFLICT(jid) DO UPDATE SET
       name = $name,
       folder = $folder,
       channel_type = $channelType,
       trigger_pattern = $triggerPattern,
       requires_trigger = $requiresTrigger,
       is_main = $isMain,
       profile_key = $profileKey`,
  ).run({
    jid: group.jid,
    name: group.name,
    folder: group.folder,
    channelType: group.channelType ?? "feishu",
    triggerPattern: group.triggerPattern ?? "",
    addedAt: new Date().toISOString(),
    requiresTrigger: group.requiresTrigger === false ? 0 : 1,
    isMain: group.isMain ? 1 : 0,
    profileKey: group.profileKey ?? getDefaultProfileKey(),
  });

  migrateLegacyGroupsToWorkspaces(db);
}

export function updateGroupProfile(
  db: Database,
  folder: string,
  profileKey: string,
) {
  db.query(
    "UPDATE registered_groups SET profile_key = $profileKey WHERE folder = $folder",
  ).run({ folder, profileKey });

  const workspace = getWorkspaceByFolder(db, folder);
  if (workspace) {
    updateWorkspace(db, workspace.id, { profileKey });
  }
}

export function updateGroupMetadata(
  db: Database,
  folder: string,
  patch: {
    name: string;
    triggerPattern: string;
    requiresTrigger: boolean;
    profileKey: string;
  },
) {
  db.query(
    `UPDATE registered_groups
     SET name = $name,
         trigger_pattern = $triggerPattern,
         requires_trigger = $requiresTrigger,
         profile_key = $profileKey
     WHERE folder = $folder`,
  ).run({
    folder,
    name: patch.name,
    triggerPattern: patch.triggerPattern,
    requiresTrigger: patch.requiresTrigger ? 1 : 0,
    profileKey: patch.profileKey,
  });

  const workspace = getWorkspaceByFolder(db, folder);
  if (workspace) {
    updateWorkspace(db, workspace.id, {
      name: patch.name,
      profileKey: patch.profileKey,
    });
    const chat = listChatsForWorkspace(db, workspace.id)[0] ?? null;
    if (chat) {
      updateChat(db, chat.id, {
        title: patch.name,
        triggerPattern: patch.triggerPattern,
        requiresTrigger: patch.requiresTrigger,
      });
    }
  }
}

export function renameGroup(
  db: Database,
  folder: string,
  name: string,
) {
  db.query(
    "UPDATE registered_groups SET name = $name WHERE folder = $folder",
  ).run({ folder, name });

  const workspace = getWorkspaceByFolder(db, folder);
  if (workspace) {
    updateWorkspace(db, workspace.id, { name });
    const chat = listChatsForWorkspace(db, workspace.id)[0] ?? null;
    if (chat) {
      updateChat(db, chat.id, { title: name });
    }
  }
}

// ---------------------------------------------------------------------------
// Workspaces / chats
// ---------------------------------------------------------------------------

export interface WorkspaceMemoryRow {
  workspace_id: string;
  key: string;
  key_type: GroupMemoryKeyType;
  value: string;
  source: GroupMemorySource;
  created_at: string;
  updated_at: string;
}

export function getWorkspaceById(
  db: Database,
  id: string,
): WorkspaceRow | null {
  return (
    (db
      .query("SELECT * FROM workspaces WHERE id = $id")
      .get({ id }) as WorkspaceRow | null) ?? null
  );
}

export function getWorkspaceByFolder(
  db: Database,
  folder: string,
): WorkspaceRow | null {
  return (
    (db
      .query("SELECT * FROM workspaces WHERE folder = $folder")
      .get({ folder }) as WorkspaceRow | null) ?? null
  );
}

export function getWorkspaceByBinding(
  db: Database,
  platform: string,
  externalId: string,
): WorkspaceRow | null {
  return (
    (db
      .query(
        `SELECT w.*
         FROM workspaces w
         INNER JOIN workspace_bindings wb ON wb.workspace_id = w.id
         WHERE wb.platform = $platform AND wb.external_id = $externalId`,
      )
      .get({
        platform,
        externalId,
      }) as WorkspaceRow | null) ?? null
  );
}

export function listWorkspaces(db: Database): WorkspaceRow[] {
  return db
    .query("SELECT * FROM workspaces ORDER BY is_main DESC, name ASC")
    .all() as WorkspaceRow[];
}

export function createWorkspace(
  db: Database,
  workspace: {
    id?: string;
    name: string;
    folder: string;
    defaultBranch?: string;
    profileKey?: string;
    isMain?: boolean;
    status?: string;
  },
): WorkspaceRow {
  const now = new Date().toISOString();
  const id = workspace.id ?? crypto.randomUUID();
  db.query(
    `INSERT INTO workspaces (
       id,
       name,
       folder,
       default_branch,
       status,
       profile_key,
       is_main,
       created_at,
       updated_at
     ) VALUES (
       $id,
       $name,
       $folder,
       $defaultBranch,
       $status,
       $profileKey,
       $isMain,
       $createdAt,
       $updatedAt
     )`,
  ).run({
    id,
    name: workspace.name,
    folder: workspace.folder,
    defaultBranch: workspace.defaultBranch ?? "main",
    status: workspace.status ?? "active",
    profileKey: workspace.profileKey ?? getDefaultProfileKey(),
    isMain: workspace.isMain ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  });

  const created = getWorkspaceById(db, id);
  if (!created) {
    throw new Error(`Failed to create workspace: ${workspace.folder}`);
  }

  return created;
}

export function updateWorkspace(
  db: Database,
  workspaceId: string,
  patch: {
    name?: string;
    defaultBranch?: string;
    profileKey?: string;
    isMain?: boolean;
    status?: string;
  },
): void {
  const current = getWorkspaceById(db, workspaceId);
  if (!current) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  db.query(
    `UPDATE workspaces
     SET name = $name,
         default_branch = $defaultBranch,
         profile_key = $profileKey,
         is_main = $isMain,
         status = $status,
         updated_at = $updatedAt
     WHERE id = $id`,
  ).run({
    id: workspaceId,
    name: patch.name ?? current.name,
    defaultBranch: patch.defaultBranch ?? current.default_branch,
    profileKey: patch.profileKey ?? current.profile_key,
    isMain: patch.isMain == null ? current.is_main : patch.isMain ? 1 : 0,
    status: patch.status ?? current.status,
    updatedAt: new Date().toISOString(),
  });
}

export function upsertWorkspaceBinding(
  db: Database,
  binding: {
    workspaceId: string;
    platform: string;
    externalId: string;
  },
): WorkspaceBindingRow {
  const now = new Date().toISOString();
  const existing = db
    .query(
      `SELECT * FROM workspace_bindings
       WHERE platform = $platform AND external_id = $externalId`,
    )
    .get({
      platform: binding.platform,
      externalId: binding.externalId,
    }) as WorkspaceBindingRow | null;

  if (existing) {
    db.query(
      `UPDATE workspace_bindings
       SET workspace_id = $workspaceId
       WHERE id = $id`,
    ).run({
      id: existing.id,
      workspaceId: binding.workspaceId,
    });

    return (db
      .query("SELECT * FROM workspace_bindings WHERE id = $id")
      .get({ id: existing.id }) as WorkspaceBindingRow);
  }

  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO workspace_bindings (
       id,
       workspace_id,
       platform,
       external_id,
       created_at
     ) VALUES (
       $id,
       $workspaceId,
       $platform,
       $externalId,
       $createdAt
     )`,
  ).run({
    id,
    workspaceId: binding.workspaceId,
    platform: binding.platform,
    externalId: binding.externalId,
    createdAt: now,
  });

  return db
    .query("SELECT * FROM workspace_bindings WHERE id = $id")
    .get({ id }) as WorkspaceBindingRow;
}

export function getChatById(
  db: Database,
  id: string,
): ChatRow | null {
  return (
    (db
      .query("SELECT * FROM chats WHERE id = $id")
      .get({ id }) as ChatRow | null) ?? null
  );
}

export function getChatByBinding(
  db: Database,
  platform: string,
  externalChatId: string,
): ChatRow | null {
  return (
    (db
      .query(
        `SELECT c.*
         FROM chats c
         INNER JOIN chat_bindings cb ON cb.chat_id = c.id
         WHERE cb.platform = $platform AND cb.external_chat_id = $externalChatId`,
      )
      .get({
        platform,
        externalChatId,
      }) as ChatRow | null) ?? null
  );
}

export function getChatBySessionRef(
  db: Database,
  sessionRef: string,
): ChatRow | null {
  return (
    (db
      .query("SELECT * FROM chats WHERE session_ref = $sessionRef")
      .get({ sessionRef }) as ChatRow | null) ?? null
  );
}

export function listChatBindingsForChat(
  db: Database,
  chatId: string,
): ChatBindingRow[] {
  return db
    .query(
      `SELECT * FROM chat_bindings
       WHERE chat_id = $chatId
       ORDER BY created_at ASC`,
    )
    .all({ chatId }) as ChatBindingRow[];
}

export function listChatsForWorkspace(
  db: Database,
  workspaceId: string,
): ChatRow[] {
  return db
    .query(
      `SELECT * FROM chats
       WHERE workspace_id = $workspaceId
       ORDER BY created_at ASC`,
    )
    .all({ workspaceId }) as ChatRow[];
}

export function createChat(
  db: Database,
  chat: {
    id?: string;
    workspaceId: string;
    title: string;
    activeBranch: string;
    sessionRef?: string | null;
    triggerPattern?: string;
    requiresTrigger?: boolean;
    status?: string;
    lastActivityAt?: string | null;
  },
): ChatRow {
  const now = new Date().toISOString();
  const id = chat.id ?? crypto.randomUUID();
  db.query(
    `INSERT INTO chats (
       id,
       workspace_id,
       title,
       active_branch,
       session_ref,
       status,
       trigger_pattern,
       requires_trigger,
       created_at,
       updated_at,
       last_activity_at
     ) VALUES (
       $id,
       $workspaceId,
       $title,
       $activeBranch,
       $sessionRef,
       $status,
       $triggerPattern,
       $requiresTrigger,
       $createdAt,
       $updatedAt,
       $lastActivityAt
     )`,
  ).run({
    id,
    workspaceId: chat.workspaceId,
    title: chat.title,
    activeBranch: chat.activeBranch,
    sessionRef: chat.sessionRef ?? null,
    status: chat.status ?? "active",
    triggerPattern: chat.triggerPattern ?? "",
    requiresTrigger: chat.requiresTrigger === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: chat.lastActivityAt ?? now,
  });

  const created = getChatById(db, id);
  if (!created) {
    throw new Error(`Failed to create chat for workspace: ${chat.workspaceId}`);
  }

  return created;
}

export function updateChat(
  db: Database,
  chatId: string,
  patch: {
    title?: string;
    activeBranch?: string;
    sessionRef?: string | null;
    triggerPattern?: string;
    requiresTrigger?: boolean;
    status?: string;
    lastActivityAt?: string | null;
  },
): void {
  const current = getChatById(db, chatId);
  if (!current) {
    throw new Error(`Chat not found: ${chatId}`);
  }

  db.query(
    `UPDATE chats
     SET title = $title,
         active_branch = $activeBranch,
         session_ref = $sessionRef,
         trigger_pattern = $triggerPattern,
         requires_trigger = $requiresTrigger,
         status = $status,
         last_activity_at = $lastActivityAt,
         updated_at = $updatedAt
     WHERE id = $id`,
  ).run({
    id: chatId,
    title: patch.title ?? current.title,
    activeBranch: patch.activeBranch ?? current.active_branch,
    sessionRef: patch.sessionRef === undefined ? current.session_ref : patch.sessionRef,
    triggerPattern: patch.triggerPattern ?? current.trigger_pattern,
    requiresTrigger:
      patch.requiresTrigger == null
        ? current.requires_trigger
        : patch.requiresTrigger ? 1 : 0,
    status: patch.status ?? current.status,
    lastActivityAt:
      patch.lastActivityAt === undefined
        ? current.last_activity_at
        : patch.lastActivityAt,
    updatedAt: new Date().toISOString(),
  });
}

export function upsertChatBinding(
  db: Database,
  binding: {
    chatId: string;
    platform: string;
    externalChatId: string;
    externalThreadId?: string | null;
  },
): ChatBindingRow {
  const now = new Date().toISOString();
  const existing = db
    .query(
      `SELECT * FROM chat_bindings
       WHERE platform = $platform AND external_chat_id = $externalChatId`,
    )
    .get({
      platform: binding.platform,
      externalChatId: binding.externalChatId,
    }) as ChatBindingRow | null;

  if (existing) {
    db.query(
      `UPDATE chat_bindings
       SET chat_id = $chatId,
           external_thread_id = $externalThreadId
       WHERE id = $id`,
    ).run({
      id: existing.id,
      chatId: binding.chatId,
      externalThreadId: binding.externalThreadId ?? null,
    });

    return (db
      .query("SELECT * FROM chat_bindings WHERE id = $id")
      .get({ id: existing.id }) as ChatBindingRow);
  }

  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO chat_bindings (
       id,
       chat_id,
       platform,
       external_chat_id,
       external_thread_id,
       created_at
     ) VALUES (
       $id,
       $chatId,
       $platform,
       $externalChatId,
       $externalThreadId,
       $createdAt
     )`,
  ).run({
    id,
    chatId: binding.chatId,
    platform: binding.platform,
    externalChatId: binding.externalChatId,
    externalThreadId: binding.externalThreadId ?? null,
    createdAt: now,
  });

  return db
    .query("SELECT * FROM chat_bindings WHERE id = $id")
    .get({ id }) as ChatBindingRow;
}

export function getWorkspaceForChat(
  db: Database,
  chatId: string,
): WorkspaceRow | null {
  return (
    (db
      .query(
        `SELECT w.*
         FROM workspaces w
         INNER JOIN chats c ON c.workspace_id = w.id
         WHERE c.id = $chatId`,
      )
      .get({ chatId }) as WorkspaceRow | null) ?? null
  );
}

export function listWorkspaceMemories(
  db: Database,
  workspaceId: string,
): WorkspaceMemoryRow[] {
  return db
    .query(
      `SELECT * FROM workspace_memories
       WHERE workspace_id = $workspaceId
       ORDER BY CASE key_type WHEN 'builtin' THEN 0 ELSE 1 END ASC, key ASC`,
    )
    .all({ workspaceId }) as WorkspaceMemoryRow[];
}

export function upsertWorkspaceMemory(
  db: Database,
  memory: {
    workspaceId: string;
    key: string;
    keyType: GroupMemoryKeyType;
    value: string;
    source?: GroupMemorySource;
  },
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO workspace_memories (
       workspace_id,
       key,
       key_type,
       value,
       source,
       created_at,
       updated_at
     ) VALUES (
       $workspaceId,
       $key,
       $keyType,
       $value,
       $source,
       $createdAt,
       $updatedAt
     )
     ON CONFLICT(workspace_id, key) DO UPDATE SET
       key_type = $keyType,
       value = $value,
       source = $source,
       updated_at = $updatedAt`,
  ).run({
    workspaceId: memory.workspaceId,
    key: memory.key,
    keyType: memory.keyType,
    value: memory.value,
    source: memory.source ?? "user",
    createdAt: now,
    updatedAt: now,
  });
}

export function deleteWorkspaceMemory(
  db: Database,
  workspaceId: string,
  key: string,
): boolean {
  const existing = db
    .query(
      `SELECT key FROM workspace_memories
       WHERE workspace_id = $workspaceId AND key = $key`,
    )
    .get({ workspaceId, key }) as { key: string } | null;

  if (!existing) {
    return false;
  }

  db.query(
    `DELETE FROM workspace_memories
     WHERE workspace_id = $workspaceId AND key = $key`,
  ).run({ workspaceId, key });

  return true;
}

export function getWorkspaceRuntimeState(
  db: Database,
  workspaceId: string,
): WorkspaceRuntimeStateRow | null {
  return (
    (db
      .query(
        `SELECT * FROM workspace_runtime_state
         WHERE workspace_id = $workspaceId`,
      )
      .get({ workspaceId }) as WorkspaceRuntimeStateRow | null) ?? null
  );
}

export function upsertWorkspaceRuntimeState(
  db: Database,
  state: {
    workspaceId: string;
    checkedOutBranch: string;
    activeRunId?: string | null;
    status: string;
    lastActivityAt?: string | null;
    unloadAfter?: string | null;
    lastError?: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO workspace_runtime_state (
       workspace_id,
       checked_out_branch,
       active_run_id,
       status,
       last_activity_at,
       unload_after,
       last_error,
       updated_at
     ) VALUES (
       $workspaceId,
       $checkedOutBranch,
       $activeRunId,
       $status,
       $lastActivityAt,
       $unloadAfter,
       $lastError,
       $updatedAt
     )
     ON CONFLICT(workspace_id) DO UPDATE SET
       checked_out_branch = $checkedOutBranch,
       active_run_id = $activeRunId,
       status = $status,
       last_activity_at = $lastActivityAt,
       unload_after = $unloadAfter,
       last_error = $lastError,
       updated_at = $updatedAt`,
  ).run({
    workspaceId: state.workspaceId,
    checkedOutBranch: state.checkedOutBranch,
    activeRunId: state.activeRunId ?? null,
    status: state.status,
    lastActivityAt: state.lastActivityAt ?? null,
    unloadAfter: state.unloadAfter ?? null,
    lastError: state.lastError ?? null,
    updatedAt: now,
  });
}

export function createRun(
  db: Database,
  run: {
    id?: string;
    workspaceId: string;
    chatId: string;
    status: RunStatus;
    branch: string;
    triggerSource: string;
    startedAt?: string;
    error?: string | null;
  },
): RunRow {
  const now = run.startedAt ?? new Date().toISOString();
  const id = run.id ?? crypto.randomUUID();
  db.query(
    `INSERT INTO runs (
       id,
       workspace_id,
       chat_id,
       status,
       branch,
       trigger_source,
       started_at,
       updated_at,
       ended_at,
       cancel_requested_at,
       error
     ) VALUES (
       $id,
       $workspaceId,
       $chatId,
       $status,
       $branch,
       $triggerSource,
       $startedAt,
       $updatedAt,
       NULL,
       NULL,
       $error
     )`,
  ).run({
    id,
    workspaceId: run.workspaceId,
    chatId: run.chatId,
    status: run.status,
    branch: run.branch,
    triggerSource: run.triggerSource,
    startedAt: now,
    updatedAt: now,
    error: run.error ?? null,
  });

  return db.query("SELECT * FROM runs WHERE id = $id").get({ id }) as RunRow;
}

export function getRunById(
  db: Database,
  id: string,
): RunRow | null {
  return (
    (db
      .query("SELECT * FROM runs WHERE id = $id")
      .get({ id }) as RunRow | null) ?? null
  );
}

export function updateRun(
  db: Database,
  runId: string,
  patch: {
    status?: RunStatus;
    endedAt?: string | null;
    cancelRequestedAt?: string | null;
    error?: string | null;
  },
): void {
  const current = getRunById(db, runId);
  if (!current) {
    throw new Error(`Run not found: ${runId}`);
  }

  db.query(
    `UPDATE runs
     SET status = $status,
         updated_at = $updatedAt,
         ended_at = $endedAt,
         cancel_requested_at = $cancelRequestedAt,
         error = $error
     WHERE id = $id`,
  ).run({
    id: runId,
    status: patch.status ?? current.status,
    updatedAt: new Date().toISOString(),
    endedAt: patch.endedAt === undefined ? current.ended_at : patch.endedAt,
    cancelRequestedAt:
      patch.cancelRequestedAt === undefined
        ? current.cancel_requested_at
        : patch.cancelRequestedAt,
    error: patch.error === undefined ? current.error : patch.error,
  });
}

export function appendRunEvent(
  db: Database,
  event: {
    id?: string;
    runId: string;
    chatId: string;
    eventType: string;
    payload: string;
    createdAt?: string;
  },
): RunEventRow {
  const id = event.id ?? crypto.randomUUID();
  const createdAt = event.createdAt ?? new Date().toISOString();
  db.query(
    `INSERT INTO run_events (
       id,
       run_id,
       chat_id,
       event_type,
       payload,
       created_at
     ) VALUES (
       $id,
       $runId,
       $chatId,
       $eventType,
       $payload,
       $createdAt
     )`,
  ).run({
    id,
    runId: event.runId,
    chatId: event.chatId,
    eventType: event.eventType,
    payload: event.payload,
    createdAt,
  });

  return db
    .query("SELECT * FROM run_events WHERE id = $id")
    .get({ id }) as RunEventRow;
}

export function listRunEvents(
  db: Database,
  runId: string,
): RunEventRow[] {
  return db
    .query(
      `SELECT * FROM run_events
       WHERE run_id = $runId
       ORDER BY created_at ASC`,
    )
    .all({ runId }) as RunEventRow[];
}

// ---------------------------------------------------------------------------
// Group memories
// ---------------------------------------------------------------------------

export function listGroupMemories(
  db: Database,
  groupFolder: string,
): GroupMemoryRow[] {
  return db
    .query(
      `SELECT * FROM group_memories
       WHERE group_folder = $groupFolder
       ORDER BY CASE key_type WHEN 'builtin' THEN 0 ELSE 1 END ASC, key ASC`,
    )
    .all({ groupFolder }) as GroupMemoryRow[];
}

export function upsertGroupMemory(
  db: Database,
  memory: {
    groupFolder: string;
    key: string;
    keyType: GroupMemoryKeyType;
    value: string;
    source?: GroupMemorySource;
  },
) {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO group_memories (
       group_folder,
       key,
       key_type,
       value,
       source,
       created_at,
       updated_at
     ) VALUES (
       $groupFolder,
       $key,
       $keyType,
       $value,
       $source,
       $createdAt,
       $updatedAt
     )
     ON CONFLICT(group_folder, key) DO UPDATE SET
       key_type = $keyType,
       value = $value,
       source = $source,
       updated_at = $updatedAt`,
  ).run({
    groupFolder: memory.groupFolder,
    key: memory.key,
    keyType: memory.keyType,
    value: memory.value,
    source: memory.source ?? "user",
    createdAt: now,
    updatedAt: now,
  });

  const workspace = getWorkspaceByFolder(db, memory.groupFolder);
  if (workspace) {
    upsertWorkspaceMemory(db, {
      workspaceId: workspace.id,
      key: memory.key,
      keyType: memory.keyType,
      value: memory.value,
      source: memory.source ?? "user",
    });
  }
}

export function deleteGroupMemory(
  db: Database,
  groupFolder: string,
  key: string,
): boolean {
  const existing = db
    .query(
      `SELECT key FROM group_memories
       WHERE group_folder = $groupFolder AND key = $key`,
    )
    .get({ groupFolder, key }) as { key: string } | null;

  if (!existing) {
    return false;
  }

  db.query(
    `DELETE FROM group_memories
     WHERE group_folder = $groupFolder AND key = $key`,
  ).run({ groupFolder, key });

  const workspace = getWorkspaceByFolder(db, groupFolder);
  if (workspace) {
    deleteWorkspaceMemory(db, workspace.id, key);
  }

  return true;
}

export function clearGroupMemories(
  db: Database,
  groupFolder: string,
): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM group_memories
       WHERE group_folder = $groupFolder`,
    )
    .get({ groupFolder }) as { count: number };

  if (row.count === 0) {
    return 0;
  }

  db.query(
    "DELETE FROM group_memories WHERE group_folder = $groupFolder",
  ).run({ groupFolder });

  const workspace = getWorkspaceByFolder(db, groupFolder);
  if (workspace) {
    db.query(
      "DELETE FROM workspace_memories WHERE workspace_id = $workspaceId",
    ).run({ workspaceId: workspace.id });
  }

  return row.count;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function getSessionRef(
  db: Database,
  folder: string,
): string | null {
  const row = db
    .query("SELECT session_ref FROM sessions WHERE group_folder = $groupFolder")
    .get({ groupFolder: folder }) as { session_ref: string } | null;
  return row?.session_ref ?? null;
}

export function saveSessionRef(
  db: Database,
  folder: string,
  sessionRef: string,
) {
  db.query(
    `INSERT INTO sessions (group_folder, session_ref) VALUES ($groupFolder, $sessionRef)
     ON CONFLICT(group_folder) DO UPDATE SET session_ref = $sessionRef`,
  ).run({ groupFolder: folder, sessionRef });

  const workspace = getWorkspaceByFolder(db, folder);
  if (workspace) {
    const chat = listChatsForWorkspace(db, workspace.id)[0] ?? null;
    if (chat) {
      updateChat(db, chat.id, { sessionRef });
    }
  }
}

export function deleteSessionRef(
  db: Database,
  folder: string,
) {
  db.query(
    "DELETE FROM sessions WHERE group_folder = $groupFolder",
  ).run({ groupFolder: folder });

  const workspace = getWorkspaceByFolder(db, folder);
  if (workspace) {
    const chat = listChatsForWorkspace(db, workspace.id)[0] ?? null;
    if (chat) {
      updateChat(db, chat.id, { sessionRef: null });
    }
  }
}

export function clearAllSessionRefs(
  db: Database,
): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sessions")
    .get() as { count: number };
  db.run("DELETE FROM sessions");
  db.run("UPDATE chats SET session_ref = NULL, updated_at = CURRENT_TIMESTAMP");
  return row.count;
}

// ---------------------------------------------------------------------------
// Image understanding cache
// ---------------------------------------------------------------------------

export function getImageUnderstandingCache(
  db: Database,
  cacheKey: string,
): ImageUnderstandingCacheRow | null {
  return (
    (db
      .query("SELECT * FROM image_understanding_cache WHERE cache_key = $cacheKey")
      .get({ cacheKey }) as ImageUnderstandingCacheRow | null) ?? null
  );
}

export function upsertImageUnderstandingCache(
  db: Database,
  row: ImageUnderstandingCacheRow,
) {
  db.query(
    `INSERT INTO image_understanding_cache (
       cache_key,
       image_path,
       file_sha256,
       prompt_version,
       analysis_text,
       created_at,
       updated_at
     ) VALUES (
       $cacheKey,
       $imagePath,
       $fileSha256,
       $promptVersion,
       $analysisText,
       $createdAt,
       $updatedAt
     )
     ON CONFLICT(cache_key) DO UPDATE SET
       image_path = $imagePath,
       file_sha256 = $fileSha256,
       prompt_version = $promptVersion,
       analysis_text = $analysisText,
       updated_at = $updatedAt`,
  ).run({
    cacheKey: row.cache_key,
    imagePath: row.image_path,
    fileSha256: row.file_sha256,
    promptVersion: row.prompt_version,
    analysisText: row.analysis_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

// ---------------------------------------------------------------------------
// Router state (cursor management)
// ---------------------------------------------------------------------------

export function getRouterState(
  db: Database,
  key: string,
): string | null {
  const row = db
    .query("SELECT value FROM router_state WHERE key = $key")
    .get({ key }) as { value: string } | null;
  return row?.value ?? null;
}

export function setRouterState(
  db: Database,
  key: string,
  value: string,
) {
  db.query(
    `INSERT INTO router_state (key, value) VALUES ($key, $value)
     ON CONFLICT(key) DO UPDATE SET value = $value`,
  ).run({ key, value });
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

export function createTask(
  db: Database,
  task: {
    groupFolder: string;
    chatJid: string;
    prompt: string;
    scheduleType: string;
    scheduleValue: string;
    contextMode?: string;
    nextRun?: string;
  },
) {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, created_at)
     VALUES ($id, $groupFolder, $chatJid, $prompt, $scheduleType, $scheduleValue, $contextMode, $nextRun, $createdAt)`,
  ).run({
    id,
    groupFolder: task.groupFolder,
    chatJid: task.chatJid,
    prompt: task.prompt,
    scheduleType: task.scheduleType,
    scheduleValue: task.scheduleValue,
    contextMode: task.contextMode ?? "isolated",
    nextRun: task.nextRun ?? null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export function listTasks(
  db: Database,
  groupFolder: string,
): ScheduledTask[] {
  return db
    .query(
      "SELECT * FROM scheduled_tasks WHERE group_folder = $groupFolder AND status != 'cancelled'",
    )
    .all({ groupFolder }) as ScheduledTask[];
}

export function updateTaskStatus(
  db: Database,
  taskId: string,
  groupFolder: string,
  status: string,
) {
  db.query(
    `UPDATE scheduled_tasks SET status = $status
     WHERE id = $taskId AND group_folder = $groupFolder`,
  ).run({ taskId, groupFolder, status });
}

export function getDueTasks(db: Database, now: string): ScheduledTask[] {
  return db
    .query(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= $now`,
    )
    .all({ now }) as ScheduledTask[];
}

export function updateTaskAfterRun(
  db: Database,
  taskId: string,
  nextRun: string | null,
  lastResult?: string,
) {
  db.query(
    `UPDATE scheduled_tasks
     SET next_run = $nextRun, last_run = $lastRun, last_result = $lastResult
     WHERE id = $taskId`,
  ).run({
    taskId,
    nextRun,
    lastRun: new Date().toISOString(),
    lastResult: lastResult ?? null,
  });
}
