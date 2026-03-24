import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MessageRow } from "../src/db";
import {
  addUserMemoryEntry,
  buildUserKey,
  deleteUserMemoryEntry,
  listUserMemoryEntries,
  resolveMemoryRoot,
  resolveUserMemoryFilePath,
  updateUserMemoryEntry,
} from "../src/memory/files";
import {
  applyAutomaticMemoryUpdates,
  buildParticipantMemoryPrefix,
  runMemoryUserEditsTool,
} from "../src/memory/service";

const tempDirs: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "octo-memory-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(sender: string, senderName: string, content: string): MessageRow {
  return {
    id: `${sender}-${content}`,
    chat_jid: "oc_test_chat",
    sender,
    sender_name: senderName,
    content,
    timestamp: "2026-03-24T10:00:00.000Z",
    role: "user",
    is_from_me: 0,
    is_bot_message: 0,
    mentions_me: 0,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("markdown memory files", () => {
  test("buildUserKey uses channel type plus sender id", () => {
    expect(buildUserKey("feishu", "ou_123")).toBe("feishu:ou_123");
    expect(buildUserKey(" ", "ou_123")).toBeNull();
    expect(buildUserKey("feishu", " ")).toBeNull();
  });

  test("add, update, and delete memory entries in MEMORY.md files", () => {
    const projectRoot = makeProjectRoot();
    const userKey = "feishu:ou_alice";

    const created = addUserMemoryEntry(projectRoot, userKey, "I like pour-over coffee", "Alice");
    expect(created.text).toBe("I like pour-over coffee");

    const filePath = resolveUserMemoryFilePath(projectRoot, userKey);
    expect(existsSync(filePath)).toBe(true);

    let entries = listUserMemoryEntries(projectRoot, userKey);
    expect(entries).toEqual([created]);

    const updated = updateUserMemoryEntry(projectRoot, userKey, created.id, "I like hand-brewed coffee");
    expect(updated).not.toBeNull();
    expect(updated?.text).toBe("I like hand-brewed coffee");

    entries = listUserMemoryEntries(projectRoot, userKey);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("I like hand-brewed coffee");

    expect(deleteUserMemoryEntry(projectRoot, userKey, updated!.id)).toBe(true);
    expect(listUserMemoryEntries(projectRoot, userKey)).toEqual([]);

    const fileContent = readFileSync(filePath, "utf8");
    expect(fileContent).toContain("# User Memory");
    expect(fileContent).not.toContain("- (empty)");
    expect(fileContent).not.toContain("- Unknown");

    const indexPath = resolve(resolveMemoryRoot(projectRoot), "MEMORY.md");
    expect(readFileSync(indexPath, "utf8")).toContain(userKey);
  });
});

describe("participant memory prompt injection", () => {
  test("includes targetUserKey for participants even when they have no saved memories yet", () => {
    const projectRoot = makeProjectRoot();
    addUserMemoryEntry(projectRoot, "feishu:ou_alice", "Alice likes coffee", "Alice");

    const prefix = buildParticipantMemoryPrefix(projectRoot, "feishu", [
      makeMessage("ou_alice", "Alice", "我喜欢咖啡"),
      makeMessage("ou_bob", "Bob", "我是 Bob"),
    ]);

    expect(prefix).toContain('key="feishu:ou_alice"');
    expect(prefix).toContain('key="feishu:ou_bob"');
    expect(prefix).toContain("Alice likes coffee");
    expect(prefix).toContain("No saved memories yet.");
  });
});

describe("memory updates", () => {
  test("applies explicit automatic add and delete updates into markdown memory", () => {
    const projectRoot = makeProjectRoot();
    const userKey = "feishu:ou_alice";

    const addStats = applyAutomaticMemoryUpdates(
      projectRoot,
      "feishu",
      [makeMessage("ou_alice", "Alice", "记住：我喜欢手冲咖啡")],
      "好的，我记住了。",
    );
    expect(addStats.created).toBe(1);
    expect(listUserMemoryEntries(projectRoot, userKey).map((entry) => entry.text)).toEqual([
      "我喜欢手冲咖啡",
    ]);

    const deleteStats = applyAutomaticMemoryUpdates(
      projectRoot,
      "feishu",
      [makeMessage("ou_alice", "Alice", "忘掉：我喜欢手冲咖啡")],
      "好的，我删掉这条记忆。",
    );
    expect(deleteStats.deleted).toBe(1);
    expect(listUserMemoryEntries(projectRoot, userKey)).toEqual([]);
  });

  test("memory_user_edits rejects question-like text and lists stored entries", () => {
    const projectRoot = makeProjectRoot();
    const userKey = "feishu:ou_bob";

    const invalid = runMemoryUserEditsTool(projectRoot, {
      action: "add",
      targetUserKey: userKey,
      text: "你能帮我查一下天气吗？",
    });
    expect(invalid.isError).toBe(true);

    const added = runMemoryUserEditsTool(projectRoot, {
      action: "add",
      targetUserKey: userKey,
      text: "Bob 喜欢冷萃咖啡",
    });
    expect(added.isError).toBe(false);

    const listed = runMemoryUserEditsTool(projectRoot, {
      action: "list",
      targetUserKey: userKey,
    });
    expect(listed.isError).toBe(false);

    const payload = JSON.parse(listed.text) as {
      targetUserKey: string;
      entries: Array<{ text: string }>;
    };
    expect(payload.targetUserKey).toBe(userKey);
    expect(payload.entries.map((entry) => entry.text)).toEqual(["Bob 喜欢冷萃咖啡"]);
  });
});
