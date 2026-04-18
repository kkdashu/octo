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

  // Migrations: add columns that may not exist in older databases
  try {
    db.run("ALTER TABLE messages ADD COLUMN mentions_me INTEGER DEFAULT 0");
  } catch {
    // Column already exists, ignore
  }
  migrateRegisteredGroupsProfileKey(db);
  migrateSessionsSessionRef(db);

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
       is_main = $isMain`,
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
}

export function updateGroupProfile(
  db: Database,
  folder: string,
  profileKey: string,
) {
  db.query(
    "UPDATE registered_groups SET profile_key = $profileKey WHERE folder = $folder",
  ).run({ folder, profileKey });
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
}

export function deleteSessionRef(
  db: Database,
  folder: string,
) {
  db.query(
    "DELETE FROM sessions WHERE group_folder = $groupFolder",
  ).run({ groupFolder: folder });
}

export function clearAllSessionRefs(
  db: Database,
): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sessions")
    .get() as { count: number };
  db.run("DELETE FROM sessions");
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
