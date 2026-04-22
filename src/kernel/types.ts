import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { ConversationMessageInput } from "../providers/types";
import type { ChatRow, WorkspaceRow } from "../db";

export type RuntimeRenderableBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      argsText: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      text: string;
      isError: boolean;
    }
  | {
      type: "bash";
      command: string;
      output: string;
      exitCode?: number;
      cancelled: boolean;
    }
  | {
      type: "custom";
      customType: string;
      text: string;
    };

export interface RuntimeRenderableMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom";
  timestamp: number | string;
  blocks: RuntimeRenderableBlock[];
  stopReason?: string;
  errorMessage?: string;
  customType?: string;
}

export interface RuntimeSnapshot {
  workspaceId: string;
  workspaceFolder: string;
  workspaceName: string;
  chatId: string;
  chatTitle: string;
  activeBranch: string;
  profileKey: string;
  sessionRef: string | null;
  currentRunId: string | null;
  isStreaming: boolean;
  pendingFollowUp: string[];
  pendingSteering: string[];
  messages: RuntimeRenderableMessage[];
}

export interface RuntimeSummary {
  workspaceId: string;
  workspaceFolder: string;
  workspaceName: string;
  chatId: string;
  chatTitle: string;
  activeBranch: string;
  platform: string;
  profileKey: string;
  sessionRef: string | null;
  isStreaming: boolean;
}

export interface CreateCliWorkspaceResult {
  workspace: WorkspaceRow;
  chat: ChatRow;
  summary: RuntimeSummary;
  snapshot: RuntimeSnapshot;
}

export type RuntimeMessageDelta =
  | { kind: "text"; contentIndex: number; text: string }
  | { kind: "thinking"; contentIndex: number; text: string }
  | {
      kind: "tool_call_start";
      contentIndex: number;
      toolCallId: string;
      toolName: string;
      argsText: string;
    }
  | { kind: "tool_call_delta"; contentIndex: number; text: string }
  | {
      kind: "tool_call_end";
      contentIndex: number;
      toolCallId: string;
      toolName: string;
      argsText: string;
    };

type RuntimeEventBase = {
  workspaceId: string;
  workspaceFolder: string;
  chatId: string;
  runId: string | null;
};

export type RuntimeEvent =
  | { type: "snapshot"; snapshot: RuntimeSnapshot }
  | (RuntimeEventBase & {
      type: "message_start";
      message: RuntimeRenderableMessage;
    })
  | (RuntimeEventBase & {
      type: "message_delta";
      message: RuntimeRenderableMessage;
      delta: RuntimeMessageDelta;
    })
  | (RuntimeEventBase & {
      type: "message_end";
      message: RuntimeRenderableMessage;
    })
  | (RuntimeEventBase & {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      argsText: string;
    })
  | (RuntimeEventBase & {
      type: "tool_update";
      toolCallId: string;
      toolName: string;
      partialResultText: string;
    })
  | (RuntimeEventBase & {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      resultText: string;
      isError: boolean;
    })
  | (RuntimeEventBase & {
      type: "queue_update";
      steering: string[];
      followUp: string[];
    })
  | (RuntimeEventBase & { type: "agent_end" })
  | (RuntimeEventBase & { type: "error"; message: string });

export type RuntimeListener = (event: RuntimeEvent) => void;

export interface RuntimeOperationResult {
  cancelled: boolean;
  workspace: WorkspaceRow;
  chat: ChatRow;
  runtime: AgentSessionRuntime;
  snapshot: RuntimeSnapshot;
}

export interface RuntimeSnapshotController {
  listChats(): RuntimeSummary[];
  getSnapshot(chatId: string): Promise<RuntimeSnapshot>;
  prompt(
    chatId: string,
    input: ConversationMessageInput,
    options?: {
      sourceType?: "cli" | "desktop" | "system";
      sourceRef?: string;
    },
  ): Promise<RuntimeSnapshot>;
  abort(chatId: string): Promise<RuntimeSnapshot>;
  newSession(chatId: string): Promise<RuntimeSnapshot>;
  subscribe(chatId: string, listener: RuntimeListener): () => void;
}
