import type { ConversationMessageInput } from "../providers/types";

export interface ClearGroupSessionResult {
  closedActiveSession: boolean;
  previousSessionRef: string | null;
  sessionRef: string;
  generation: number;
}

export interface GroupRuntimeController {
  pushMessage(groupFolder: string, input: ConversationMessageInput): boolean;
  isActive(groupFolder: string): boolean;
  enqueue(groupFolder: string, initialPrompt: string): Promise<void>;
  clearSession(groupFolder: string): Promise<ClearGroupSessionResult>;
}
