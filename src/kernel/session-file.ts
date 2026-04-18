import { existsSync, readFileSync } from "node:fs";
import {
  parseSessionEntries,
  type SessionHeader,
} from "@mariozechner/pi-coding-agent";

export function getSessionHeader(sessionPath: string): SessionHeader | null {
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
