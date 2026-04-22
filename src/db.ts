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
    CREATE TABLE IF NOT EXISTS inbound_messages (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      workspace_id TEXT,
      chat_id TEXT,
      external_message_id TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_thread_id TEXT,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL DEFAULT '',
      sender_type TEXT NOT NULL DEFAULT 'user',
      message_type TEXT NOT NULL DEFAULT 'text',
      content_text TEXT NOT NULL DEFAULT '',
      raw_payload TEXT NOT NULL,
      message_timestamp TEXT NOT NULL,
      received_at TEXT NOT NULL,
      mentions_me INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT NOT NULL,
      UNIQUE(platform, dedupe_key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inbound_dispatcher_cursors (
      consumer TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      last_inbound_message_id TEXT,
      last_message_timestamp TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (consumer, chat_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      profile_key TEXT NOT NULL,
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
      turn_request_id TEXT,
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
    CREATE TABLE IF NOT EXISTS turn_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      input_mode TEXT NOT NULL DEFAULT 'prompt',
      request_text TEXT NOT NULL,
      request_payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
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
  migrateWorkspacesTable(db);
  migrateChatsTriggerConfig(db);
  migrateRunsTurnRequestId(db);
  dropLegacySessionsTable(db);
  migrateScheduledTasksTable(db);
  dropLegacyGroupTables(db);

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

function rebuildWorkspacesTableWithoutMain(db: Database): void {
  db.run("ALTER TABLE workspaces RENAME TO workspaces_legacy");
  db.run(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      profile_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    INSERT INTO workspaces (
      id,
      name,
      folder,
      default_branch,
      status,
      profile_key,
      created_at,
      updated_at
    )
    SELECT
      id,
      name,
      folder,
      default_branch,
      status,
      profile_key,
      created_at,
      updated_at
    FROM workspaces_legacy
  `);
  db.run("DROP TABLE workspaces_legacy");
}

function migrateWorkspacesTable(db: Database): void {
  const columns = getTableColumns(db, "workspaces");

  if (!columns.includes("profile_key")) {
    db.run("ALTER TABLE workspaces ADD COLUMN profile_key TEXT");
    db.query(
      `UPDATE workspaces
       SET profile_key = $profileKey
       WHERE profile_key IS NULL OR trim(profile_key) = ''`,
    ).run({ profileKey: getDefaultProfileKey() });
  }

  if (columns.includes("is_main")) {
    rebuildWorkspacesTableWithoutMain(db);
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

function migrateRunsTurnRequestId(db: Database): void {
  const columns = getTableColumns(db, "runs");

  if (!columns.includes("turn_request_id")) {
    db.run("ALTER TABLE runs ADD COLUMN turn_request_id TEXT");
  }
}

function dropLegacySessionsTable(db: Database): void {
  db.run("DROP TABLE IF EXISTS sessions");
}

function migrateScheduledTasksTable(db: Database): void {
  const columns = getTableColumns(db, "scheduled_tasks");
  if (columns.includes("workspace_id") && columns.includes("chat_id")) {
    return;
  }

  db.run("ALTER TABLE scheduled_tasks RENAME TO scheduled_tasks_legacy");
  db.run(`
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
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
  db.run("DROP TABLE scheduled_tasks_legacy");
}

function dropLegacyGroupTables(db: Database): void {
  db.run("DROP TABLE IF EXISTS registered_groups");
  db.run("DROP TABLE IF EXISTS group_memories");
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  name: string;
  folder: string;
  default_branch: string;
  status: string;
  profile_key: string;
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
  turn_request_id: string | null;
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

export interface InboundMessageRow {
  id: string;
  platform: string;
  workspace_id: string | null;
  chat_id: string | null;
  external_message_id: string;
  external_chat_id: string;
  external_thread_id: string | null;
  sender_id: string;
  sender_name: string;
  sender_type: string;
  message_type: string;
  content_text: string;
  raw_payload: string;
  message_timestamp: string;
  received_at: string;
  mentions_me: number;
  dedupe_key: string;
}

export interface InboundDispatcherCursorRow {
  consumer: string;
  chat_id: string;
  last_inbound_message_id: string | null;
  last_message_timestamp: string | null;
  updated_at: string;
}

export type TurnRequestStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TurnRequestSourceType =
  | "channel_inbound"
  | "cli"
  | "desktop"
  | "scheduled_task"
  | "system";

export interface TurnRequestRow {
  id: string;
  workspace_id: string;
  chat_id: string;
  source_type: TurnRequestSourceType;
  source_ref: string | null;
  input_mode: "prompt" | "follow_up" | "steer";
  request_text: string;
  request_payload: string;
  status: TurnRequestStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
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
  workspace_id: string;
  chat_id: string;
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

export const BUILTIN_WORKSPACE_MEMORY_KEYS = [
  "topic_context",
  "response_language",
  "response_style",
  "interaction_rule",
] as const;

export type BuiltinWorkspaceMemoryKey = (typeof BUILTIN_WORKSPACE_MEMORY_KEYS)[number];
export type WorkspaceMemoryKeyType = "builtin" | "custom";
export type WorkspaceMemorySource = "user" | "tool";

export interface WorkspaceMemoryRow {
  workspace_id: string;
  key: string;
  key_type: WorkspaceMemoryKeyType;
  value: string;
  source: WorkspaceMemorySource;
  created_at: string;
  updated_at: string;
}

const WORKSPACE_MEMORY_CUSTOM_KEY_PATTERN = /^[a-z]+(?:_[a-z]+)*$/;

export function isBuiltinWorkspaceMemoryKey(
  key: string,
): key is BuiltinWorkspaceMemoryKey {
  return BUILTIN_WORKSPACE_MEMORY_KEYS.includes(key as BuiltinWorkspaceMemoryKey);
}

export function isValidCustomWorkspaceMemoryKey(key: string): boolean {
  return WORKSPACE_MEMORY_CUSTOM_KEY_PATTERN.test(key);
}

export function isSupportedWorkspaceMemoryKey(key: string): boolean {
  return isBuiltinWorkspaceMemoryKey(key) || isValidCustomWorkspaceMemoryKey(key);
}

export function validateWorkspaceMemoryKey(
  key: string,
  keyType: WorkspaceMemoryKeyType,
): string | null {
  if (keyType === "builtin") {
    if (isBuiltinWorkspaceMemoryKey(key)) {
      return null;
    }

    return `Invalid builtin key: ${key}. Allowed keys: ${BUILTIN_WORKSPACE_MEMORY_KEYS.join(", ")}`;
  }

  if (isValidCustomWorkspaceMemoryKey(key)) {
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

export function insertInboundMessage(
  db: Database,
  message: {
    id?: string;
    platform: string;
    workspaceId?: string | null;
    chatId?: string | null;
    externalMessageId: string;
    externalChatId: string;
    externalThreadId?: string | null;
    senderId: string;
    senderName?: string;
    senderType?: string;
    messageType?: string;
    contentText?: string;
    rawPayload: string;
    messageTimestamp: string;
    receivedAt?: string;
    mentionsMe?: boolean;
    dedupeKey?: string;
  },
): InboundMessageRow {
  const id = message.id ?? crypto.randomUUID();
  const receivedAt = message.receivedAt ?? new Date().toISOString();
  const dedupeKey = message.dedupeKey ?? message.externalMessageId;

  db.query(
    `INSERT OR IGNORE INTO inbound_messages (
       id,
       platform,
       workspace_id,
       chat_id,
       external_message_id,
       external_chat_id,
       external_thread_id,
       sender_id,
       sender_name,
       sender_type,
       message_type,
       content_text,
       raw_payload,
       message_timestamp,
       received_at,
       mentions_me,
       dedupe_key
     ) VALUES (
       $id,
       $platform,
       $workspaceId,
       $chatId,
       $externalMessageId,
       $externalChatId,
       $externalThreadId,
       $senderId,
       $senderName,
       $senderType,
       $messageType,
       $contentText,
       $rawPayload,
       $messageTimestamp,
       $receivedAt,
       $mentionsMe,
       $dedupeKey
     )`,
  ).run({
    id,
    platform: message.platform,
    workspaceId: message.workspaceId ?? null,
    chatId: message.chatId ?? null,
    externalMessageId: message.externalMessageId,
    externalChatId: message.externalChatId,
    externalThreadId: message.externalThreadId ?? null,
    senderId: message.senderId,
    senderName: message.senderName ?? "",
    senderType: message.senderType ?? "user",
    messageType: message.messageType ?? "text",
    contentText: message.contentText ?? "",
    rawPayload: message.rawPayload,
    messageTimestamp: message.messageTimestamp,
    receivedAt,
    mentionsMe: message.mentionsMe ? 1 : 0,
    dedupeKey,
  });

  return db
    .query(
      `SELECT * FROM inbound_messages
       WHERE platform = $platform AND dedupe_key = $dedupeKey`,
    )
    .get({
      platform: message.platform,
      dedupeKey,
    }) as InboundMessageRow;
}

export function listPendingInboundMessagesForChat(
  db: Database,
  chatId: string,
  afterTimestamp: string,
): InboundMessageRow[] {
  return db
    .query(
      `SELECT * FROM inbound_messages
       WHERE chat_id = $chatId AND message_timestamp > $afterTimestamp
       ORDER BY message_timestamp ASC, received_at ASC, id ASC`,
    )
    .all({
      chatId,
      afterTimestamp,
    }) as InboundMessageRow[];
}

export function getInboundDispatcherCursor(
  db: Database,
  consumer: string,
  chatId: string,
): InboundDispatcherCursorRow | null {
  return (
    (db
      .query(
        `SELECT * FROM inbound_dispatcher_cursors
         WHERE consumer = $consumer AND chat_id = $chatId`,
      )
      .get({ consumer, chatId }) as InboundDispatcherCursorRow | null) ?? null
  );
}

export function upsertInboundDispatcherCursor(
  db: Database,
  cursor: {
    consumer: string;
    chatId: string;
    lastInboundMessageId?: string | null;
    lastMessageTimestamp?: string | null;
  },
): void {
  const updatedAt = new Date().toISOString();
  db.query(
    `INSERT INTO inbound_dispatcher_cursors (
       consumer,
       chat_id,
       last_inbound_message_id,
       last_message_timestamp,
       updated_at
     ) VALUES (
       $consumer,
       $chatId,
       $lastInboundMessageId,
       $lastMessageTimestamp,
       $updatedAt
     )
     ON CONFLICT(consumer, chat_id) DO UPDATE SET
       last_inbound_message_id = $lastInboundMessageId,
       last_message_timestamp = $lastMessageTimestamp,
       updated_at = $updatedAt`,
  ).run({
    consumer: cursor.consumer,
    chatId: cursor.chatId,
    lastInboundMessageId: cursor.lastInboundMessageId ?? null,
    lastMessageTimestamp: cursor.lastMessageTimestamp ?? null,
    updatedAt,
  });
}

// ---------------------------------------------------------------------------
// Workspaces / chats
// ---------------------------------------------------------------------------

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
    .query("SELECT * FROM workspaces ORDER BY name ASC")
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
       created_at,
       updated_at
     ) VALUES (
       $id,
       $name,
       $folder,
       $defaultBranch,
       $status,
       $profileKey,
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
         status = $status,
         updated_at = $updatedAt
     WHERE id = $id`,
  ).run({
    id: workspaceId,
    name: patch.name ?? current.name,
    defaultBranch: patch.defaultBranch ?? current.default_branch,
    profileKey: patch.profileKey ?? current.profile_key,
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
    keyType: WorkspaceMemoryKeyType;
    value: string;
    source?: WorkspaceMemorySource;
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

export function clearWorkspaceMemories(
  db: Database,
  workspaceId: string,
): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM workspace_memories
       WHERE workspace_id = $workspaceId`,
    )
    .get({ workspaceId }) as { count: number };

  if (row.count === 0) {
    return 0;
  }

  db.query(
    "DELETE FROM workspace_memories WHERE workspace_id = $workspaceId",
  ).run({ workspaceId });

  return row.count;
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
    turnRequestId?: string | null;
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
       turn_request_id,
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
       $turnRequestId,
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
    turnRequestId: run.turnRequestId ?? null,
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

export function createTurnRequest(
  db: Database,
  request: {
    id?: string;
    workspaceId: string;
    chatId: string;
    sourceType: TurnRequestSourceType;
    sourceRef?: string | null;
    inputMode?: TurnRequestRow["input_mode"];
    requestText: string;
    requestPayload?: string;
    status?: TurnRequestStatus;
    createdAt?: string;
  },
): TurnRequestRow {
  const id = request.id ?? crypto.randomUUID();
  const createdAt = request.createdAt ?? new Date().toISOString();
  db.query(
    `INSERT INTO turn_requests (
       id,
       workspace_id,
       chat_id,
       source_type,
       source_ref,
       input_mode,
       request_text,
       request_payload,
       status,
       created_at,
       started_at,
       completed_at,
       error
     ) VALUES (
       $id,
       $workspaceId,
       $chatId,
       $sourceType,
       $sourceRef,
       $inputMode,
       $requestText,
       $requestPayload,
       $status,
       $createdAt,
       NULL,
       NULL,
       NULL
     )`,
  ).run({
    id,
    workspaceId: request.workspaceId,
    chatId: request.chatId,
    sourceType: request.sourceType,
    sourceRef: request.sourceRef ?? null,
    inputMode: request.inputMode ?? "prompt",
    requestText: request.requestText,
    requestPayload: request.requestPayload ?? "{}",
    status: request.status ?? "queued",
    createdAt,
  });

  return db
    .query("SELECT * FROM turn_requests WHERE id = $id")
    .get({ id }) as TurnRequestRow;
}

export function getTurnRequestById(
  db: Database,
  id: string,
): TurnRequestRow | null {
  return (
    (db
      .query("SELECT * FROM turn_requests WHERE id = $id")
      .get({ id }) as TurnRequestRow | null) ?? null
  );
}

export function listQueuedTurnRequestsForChat(
  db: Database,
  chatId: string,
): TurnRequestRow[] {
  return db
    .query(
      `SELECT * FROM turn_requests
       WHERE chat_id = $chatId AND status = 'queued'
       ORDER BY created_at ASC`,
    )
    .all({ chatId }) as TurnRequestRow[];
}

export function updateTurnRequest(
  db: Database,
  turnRequestId: string,
  patch: {
    status?: TurnRequestStatus;
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
  },
): void {
  const current = getTurnRequestById(db, turnRequestId);
  if (!current) {
    throw new Error(`Turn request not found: ${turnRequestId}`);
  }

  db.query(
    `UPDATE turn_requests
     SET status = $status,
         started_at = $startedAt,
         completed_at = $completedAt,
         error = $error
     WHERE id = $id`,
  ).run({
    id: turnRequestId,
    status: patch.status ?? current.status,
    startedAt: patch.startedAt === undefined ? current.started_at : patch.startedAt,
    completedAt: patch.completedAt === undefined ? current.completed_at : patch.completedAt,
    error: patch.error === undefined ? current.error : patch.error,
  });
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
    workspaceId: string;
    chatId: string;
    prompt: string;
    scheduleType: string;
    scheduleValue: string;
    contextMode?: string;
    nextRun?: string;
  },
) {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO scheduled_tasks (id, workspace_id, chat_id, prompt, schedule_type, schedule_value, context_mode, next_run, created_at)
     VALUES ($id, $workspaceId, $chatId, $prompt, $scheduleType, $scheduleValue, $contextMode, $nextRun, $createdAt)`,
  ).run({
    id,
    workspaceId: task.workspaceId,
    chatId: task.chatId,
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
  workspaceId: string,
): ScheduledTask[] {
  return db
    .query(
      "SELECT * FROM scheduled_tasks WHERE workspace_id = $workspaceId AND status != 'cancelled'",
    )
    .all({ workspaceId }) as ScheduledTask[];
}

export function updateTaskStatus(
  db: Database,
  taskId: string,
  workspaceId: string,
  status: string,
) {
  db.query(
    `UPDATE scheduled_tasks SET status = $status
     WHERE id = $taskId AND workspace_id = $workspaceId`,
  ).run({ taskId, workspaceId, status });
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
