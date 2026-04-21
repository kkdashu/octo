import type { ConversationMessageInput } from "../providers/types";

export interface ClearGroupSessionResult {
  closedActiveSession: boolean;
  previousSessionRef: string | null;
  sessionRef: string;
  generation: number;
}

export interface GroupRuntimeController {
  pushMessage(chatId: string, input: ConversationMessageInput): boolean;
  isActive(chatId: string): boolean;
  enqueue(chatId: string, initialPrompt: string): Promise<void>;
  clearSession(chatId: string): Promise<ClearGroupSessionResult>;
}
