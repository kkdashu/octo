import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliStateStore } from "../src/cli/state-store";

describe("cli state store", () => {
  test("persists and clears the current workspace and chat selection", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-state-"));

    try {
      const filePath = join(rootDir, "cli-state.json");
      const store = new CliStateStore(filePath);

      expect(store.getCurrentGroupFolder()).toBeNull();
      expect(store.getCurrentWorkspaceFolder()).toBeNull();
      expect(store.getCurrentChatId()).toBeNull();

      store.setCurrentChat("chat_cli_demo", "cli_20260418_demo");
      expect(store.getCurrentGroupFolder()).toBe("cli_20260418_demo");
      expect(store.getCurrentWorkspaceFolder()).toBe("cli_20260418_demo");
      expect(store.getCurrentChatId()).toBe("chat_cli_demo");

      store.clear();
      expect(store.getCurrentGroupFolder()).toBeNull();
      expect(store.getCurrentWorkspaceFolder()).toBeNull();
      expect(store.getCurrentChatId()).toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("treats invalid JSON as empty state", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-cli-state-"));

    try {
      const filePath = join(rootDir, "cli-state.json");
      writeFileSync(filePath, "{ invalid json");

      const store = new CliStateStore(filePath);
      expect(store.getCurrentGroupFolder()).toBeNull();
      expect(store.getCurrentWorkspaceFolder()).toBeNull();
      expect(store.getCurrentChatId()).toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
