import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { ConversationMessageInput } from "../providers/types";
import type { ChatRow, RegisteredGroup, WorkspaceRow } from "../db";

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

export interface GroupRuntimeSnapshot {
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
  groupFolder: string;
  groupName: string;
}

export interface GroupRuntimeSummary {
  workspaceId: string;
  workspaceFolder: string;
  workspaceName: string;
  chatId: string;
  chatTitle: string;
  activeBranch: string;
  channelType: string;
  isMain: boolean;
  profileKey: string;
  sessionRef: string | null;
  isStreaming: boolean;
  folder: string;
  name: string;
}

export interface CreateCliGroupResult {
  workspace: WorkspaceRow;
  chat: ChatRow;
  summary: GroupRuntimeSummary;
  group: GroupRuntimeSummary;
  snapshot: GroupRuntimeSnapshot;
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
  groupFolder: string;
  runId: string | null;
};

export type GroupRuntimeEvent =
  | { type: "snapshot"; snapshot: GroupRuntimeSnapshot }
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

export type GroupRuntimeListener = (event: GroupRuntimeEvent) => void;

export interface GroupRuntimeOperationResult {
  cancelled: boolean;
  group: RegisteredGroup | null;
  workspace: WorkspaceRow;
  chat: ChatRow;
  runtime: AgentSessionRuntime;
  snapshot: GroupRuntimeSnapshot;
}

export interface GroupRuntimeSnapshotController {
  listGroups(): GroupRuntimeSummary[];
  getSnapshot(chatId: string): Promise<GroupRuntimeSnapshot>;
  prompt(
    chatId: string,
    input: ConversationMessageInput,
  ): Promise<GroupRuntimeSnapshot>;
  abort(chatId: string): Promise<GroupRuntimeSnapshot>;
  newSession(chatId: string): Promise<GroupRuntimeSnapshot>;
  subscribe(chatId: string, listener: GroupRuntimeListener): () => void;
}
