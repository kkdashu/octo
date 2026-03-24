import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface MemoryEntry {
  id: string;
  text: string;
}

export interface UserMemoryDocument {
  userKey: string;
  aliases: string[];
  entries: MemoryEntry[];
}

const MEMORY_ROOT = "store/memory";
const USERS_DIR = "users";
const INDEX_FILE = "MEMORY.md";
const USER_MEMORY_FILE = "MEMORY.md";
const BULLET_RE = /^-\s+(.+)$/;

function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(text: string): string {
  return createHash("sha1").update(normalizeForFingerprint(text)).digest("hex");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function sanitizeUserKeyForPath(userKey: string): string {
  return userKey.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function dedupeStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function readFileOrEmpty(filePath: string): string {
  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return readFileSync(filePath, "utf8");
    }
  } catch {
    // Ignore unreadable files and return empty content.
  }
  return "";
}

function parseUserMemoryDocument(content: string, userKey: string): UserMemoryDocument {
  const aliases: string[] = [];
  const entries: MemoryEntry[] = [];
  const seenEntries = new Set<string>();
  let section: "none" | "aliases" | "memories" = "none";

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^##\s+Aliases\b/i.test(trimmed)) {
      section = "aliases";
      continue;
    }
    if (/^##\s+Memories\b/i.test(trimmed)) {
      section = "memories";
      continue;
    }
    const bullet = trimmed.match(BULLET_RE);
    if (!bullet?.[1]) continue;

    const text = normalizeText(bullet[1]);
    if (!text) continue;

    if (section === "aliases") {
      aliases.push(text);
      continue;
    }

    if (section === "memories") {
      const id = fingerprint(text);
      if (seenEntries.has(id)) continue;
      seenEntries.add(id);
      entries.push({ id, text });
    }
  }

  return {
    userKey,
    aliases: dedupeStrings(aliases),
    entries,
  };
}

function serializeUserMemoryDocument(doc: UserMemoryDocument): string {
  const aliases = dedupeStrings(doc.aliases);
  const lines = [
    "# User Memory",
    "",
    `User Key: ${doc.userKey}`,
    "",
    "## Aliases",
  ];

  if (aliases.length > 0) {
    for (const alias of aliases) {
      lines.push(`- ${alias}`);
    }
  }

  lines.push("", "## Memories");

  if (doc.entries.length > 0) {
    for (const entry of doc.entries) {
      lines.push(`- ${entry.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function collectUserDocuments(memoryRoot: string): Array<{
  userKey: string;
  aliases: string[];
  entryCount: number;
  filePath: string;
}> {
  const usersRoot = resolve(memoryRoot, USERS_DIR);
  if (!existsSync(usersRoot)) return [];

  const result: Array<{
    userKey: string;
    aliases: string[];
    entryCount: number;
    filePath: string;
  }> = [];

  for (const name of readdirSync(usersRoot)) {
    const userDir = join(usersRoot, name);
    if (!statSync(userDir).isDirectory()) continue;
    const filePath = join(userDir, USER_MEMORY_FILE);
    const raw = readFileOrEmpty(filePath);
    if (!raw.trim()) continue;
    const userKeyLine = raw.split(/\r?\n/).find((line) => line.startsWith("User Key: "));
    const userKey = normalizeText(userKeyLine?.replace(/^User Key:\s*/, "") || name);
    const doc = parseUserMemoryDocument(raw, userKey);
    result.push({
      userKey,
      aliases: doc.aliases,
      entryCount: doc.entries.length,
      filePath,
    });
  }

  return result.sort((a, b) => a.userKey.localeCompare(b.userKey));
}

function refreshMemoryIndex(memoryRoot: string): void {
  ensureDir(memoryRoot);
  const docs = collectUserDocuments(memoryRoot);
  const lines = [
    "# Global User Memory Index",
    "",
    `Known Users: ${docs.length}`,
    "",
  ];

  if (docs.length === 0) {
    lines.push("- No user memories yet");
  } else {
    for (const doc of docs) {
      const aliasText = doc.aliases.length > 0 ? doc.aliases.join(", ") : "Unknown";
      const relPath = relative(memoryRoot, doc.filePath) || USER_MEMORY_FILE;
      lines.push(`- ${doc.userKey} | aliases: ${aliasText} | entries: ${doc.entryCount} | file: ${relPath}`);
    }
  }

  writeFileSync(join(memoryRoot, INDEX_FILE), `${lines.join("\n")}\n`, "utf8");
}

export function resolveMemoryRoot(projectRoot = "."): string {
  return resolve(projectRoot, MEMORY_ROOT);
}

export function buildUserKey(channelType: string, senderId: string): string | null {
  const normalizedChannel = normalizeText(channelType);
  const normalizedSender = normalizeText(senderId);
  if (!normalizedChannel || !normalizedSender) return null;
  return `${normalizedChannel}:${normalizedSender}`;
}

export function resolveUserMemoryFilePath(projectRoot: string, userKey: string): string {
  const memoryRoot = resolveMemoryRoot(projectRoot);
  const userDir = join(memoryRoot, USERS_DIR, sanitizeUserKeyForPath(userKey));
  return join(userDir, USER_MEMORY_FILE);
}

export function listUserMemoryEntries(
  projectRoot: string,
  userKey: string,
  query?: string,
): MemoryEntry[] {
  const filePath = resolveUserMemoryFilePath(projectRoot, userKey);
  const doc = parseUserMemoryDocument(readFileOrEmpty(filePath), userKey);
  const normalizedQuery = normalizeText(query || "").toLowerCase();
  if (!normalizedQuery) return doc.entries;
  return doc.entries.filter((entry) => entry.text.toLowerCase().includes(normalizedQuery));
}

export function rememberUserAlias(projectRoot: string, userKey: string, alias?: string): void {
  const normalizedAlias = normalizeText(alias || "");
  if (!normalizedAlias) return;

  const filePath = resolveUserMemoryFilePath(projectRoot, userKey);
  const raw = readFileOrEmpty(filePath);
  const doc = parseUserMemoryDocument(raw, userKey);
  doc.aliases = dedupeStrings([...doc.aliases, normalizedAlias]);

  ensureDir(dirname(filePath));
  writeFileSync(filePath, serializeUserMemoryDocument(doc), "utf8");
  refreshMemoryIndex(resolveMemoryRoot(projectRoot));
}

export function addUserMemoryEntry(
  projectRoot: string,
  userKey: string,
  text: string,
  alias?: string,
): MemoryEntry {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    throw new Error("Memory text is required");
  }

  const filePath = resolveUserMemoryFilePath(projectRoot, userKey);
  const doc = parseUserMemoryDocument(readFileOrEmpty(filePath), userKey);
  if (alias) {
    doc.aliases = dedupeStrings([...doc.aliases, alias]);
  }

  const nextEntry: MemoryEntry = {
    id: fingerprint(normalizedText),
    text: normalizedText,
  };

  if (!doc.entries.some((entry) => entry.id === nextEntry.id)) {
    doc.entries.push(nextEntry);
  }

  ensureDir(dirname(filePath));
  writeFileSync(filePath, serializeUserMemoryDocument(doc), "utf8");
  refreshMemoryIndex(resolveMemoryRoot(projectRoot));
  return nextEntry;
}

export function updateUserMemoryEntry(
  projectRoot: string,
  userKey: string,
  id: string,
  nextText: string,
): MemoryEntry | null {
  const normalizedText = normalizeText(nextText);
  if (!normalizedText) {
    throw new Error("Memory text is required");
  }

  const filePath = resolveUserMemoryFilePath(projectRoot, userKey);
  const doc = parseUserMemoryDocument(readFileOrEmpty(filePath), userKey);
  const index = doc.entries.findIndex((entry) => entry.id === id);
  if (index === -1) return null;

  const updated: MemoryEntry = {
    id: fingerprint(normalizedText),
    text: normalizedText,
  };
  doc.entries[index] = updated;
  doc.entries = doc.entries.filter((entry, entryIndex, all) =>
    all.findIndex((candidate) => candidate.id === entry.id) === entryIndex);

  ensureDir(dirname(filePath));
  writeFileSync(filePath, serializeUserMemoryDocument(doc), "utf8");
  refreshMemoryIndex(resolveMemoryRoot(projectRoot));
  return updated;
}

export function deleteUserMemoryEntry(projectRoot: string, userKey: string, id: string): boolean {
  const filePath = resolveUserMemoryFilePath(projectRoot, userKey);
  const doc = parseUserMemoryDocument(readFileOrEmpty(filePath), userKey);
  const filtered = doc.entries.filter((entry) => entry.id !== id);
  if (filtered.length === doc.entries.length) return false;
  doc.entries = filtered;

  ensureDir(dirname(filePath));
  writeFileSync(filePath, serializeUserMemoryDocument(doc), "utf8");
  refreshMemoryIndex(resolveMemoryRoot(projectRoot));
  return true;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
