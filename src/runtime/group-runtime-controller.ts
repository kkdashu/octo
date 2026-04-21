import type { ConversationMessageInput } from "../providers/types";

export interface ClearGroupSessionResult {
  closedActiveSession: boolean;
  previousSessionRef: string | null;
  sessionRef: string;
  generation: number;
}

export interface EnqueueRuntimeResult {
  status: "completed" | "failed";
  failureMessage?: string;
  failureNotified: boolean;
}

export interface GroupRuntimeController {
  pushMessage(chatId: string, input: ConversationMessageInput): boolean;
  isActive(chatId: string): boolean;
  enqueue(chatId: string, initialPrompt: string): Promise<EnqueueRuntimeResult>;
  clearSession(chatId: string): Promise<ClearGroupSessionResult>;
}
