import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPiSessionManager,
  ensurePiSessionDir,
  getPiSessionRef,
} from "../src/providers/pi-session-ref";

describe("pi session ref helpers", () => {
  test("createPiSessionManager materializes fresh session files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-pi-session-ref-"));

    try {
      const workingDirectory = join(rootDir, "workspace");
      const sessionManager = createPiSessionManager(workingDirectory);
      const sessionRef = getPiSessionRef(sessionManager);

      expect(existsSync(sessionRef)).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("createPiSessionManager materializes missing explicit session files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-pi-session-ref-"));

    try {
      const workingDirectory = join(rootDir, "workspace");
      const sessionDir = ensurePiSessionDir(workingDirectory);
      const explicitSessionRef = join(sessionDir, "chat-2.jsonl");
      const sessionManager = createPiSessionManager(
        workingDirectory,
        explicitSessionRef,
      );

      expect(getPiSessionRef(sessionManager)).toBe(explicitSessionRef);
      expect(existsSync(explicitSessionRef)).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
