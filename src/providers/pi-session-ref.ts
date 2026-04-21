import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

export function getPiSessionDir(workingDirectory: string): string {
  return resolve(workingDirectory, ".pi", "sessions");
}

export function ensurePiSessionDir(workingDirectory: string): string {
  const sessionDir = getPiSessionDir(workingDirectory);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export function resolvePersistedPiSessionRef(
  workingDirectory: string,
  persistedSessionRef: string | null | undefined,
): string | undefined {
  if (!persistedSessionRef) {
    return undefined;
  }

  const resolvedRef = isAbsolute(persistedSessionRef)
    ? persistedSessionRef
    : resolve(workingDirectory, persistedSessionRef);

  return existsSync(resolvedRef) ? resolvedRef : undefined;
}

export function createPiSessionManager(
  workingDirectory: string,
  sessionRef?: string,
): SessionManager {
  const sessionDir = ensurePiSessionDir(workingDirectory);
  const manager = sessionRef
    ? SessionManager.open(sessionRef, sessionDir, workingDirectory)
    : SessionManager.create(workingDirectory, sessionDir);
  materializePiSessionRef(manager);
  return manager;
}

export function getPiSessionRef(sessionManager: SessionManager): string {
  const sessionRef = sessionManager.getSessionFile();
  if (!sessionRef) {
    throw new Error("Pi session manager did not produce a session file");
  }
  return sessionRef;
}

export function materializePiSessionRef(
  sessionManager: SessionManager,
): string {
  const sessionRef = getPiSessionRef(sessionManager);
  if (existsSync(sessionRef)) {
    return sessionRef;
  }

  const header = sessionManager.getHeader();
  if (!header) {
    throw new Error("Pi session manager did not produce a session header");
  }

  const content = [header, ...sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  writeFileSync(sessionRef, `${content}\n`);
  return sessionRef;
}
