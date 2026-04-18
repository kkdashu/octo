import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { ConversationMessageInput } from "../providers/types";
import type { RegisteredGroup } from "../db";

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
  groupFolder: string;
  groupName: string;
  profileKey: string;
  sessionRef: string | null;
  isStreaming: boolean;
  pendingFollowUp: string[];
  pendingSteering: string[];
  messages: RuntimeRenderableMessage[];
}

export interface GroupRuntimeSummary {
  folder: string;
  name: string;
  channelType: RegisteredGroup["channel_type"];
  isMain: boolean;
  profileKey: string;
  sessionRef: string | null;
  isStreaming: boolean;
}

export interface CreateCliGroupResult {
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

export type GroupRuntimeEvent =
  | { type: "snapshot"; snapshot: GroupRuntimeSnapshot }
  | {
      type: "message_start";
      groupFolder: string;
      message: RuntimeRenderableMessage;
    }
  | {
      type: "message_delta";
      groupFolder: string;
      message: RuntimeRenderableMessage;
      delta: RuntimeMessageDelta;
    }
  | {
      type: "message_end";
      groupFolder: string;
      message: RuntimeRenderableMessage;
    }
  | {
      type: "tool_start";
      groupFolder: string;
      toolCallId: string;
      toolName: string;
      argsText: string;
    }
  | {
      type: "tool_update";
      groupFolder: string;
      toolCallId: string;
      toolName: string;
      partialResultText: string;
    }
  | {
      type: "tool_end";
      groupFolder: string;
      toolCallId: string;
      toolName: string;
      resultText: string;
      isError: boolean;
    }
  | {
      type: "queue_update";
      groupFolder: string;
      steering: string[];
      followUp: string[];
    }
  | { type: "agent_end"; groupFolder: string }
  | { type: "error"; groupFolder: string; message: string };

export type GroupRuntimeListener = (event: GroupRuntimeEvent) => void;

export interface GroupRuntimeOperationResult {
  cancelled: boolean;
  group: RegisteredGroup;
  runtime: AgentSessionRuntime;
  snapshot: GroupRuntimeSnapshot;
}

export interface GroupRuntimeSnapshotController {
  listGroups(): GroupRuntimeSummary[];
  getSnapshot(groupFolder: string): Promise<GroupRuntimeSnapshot>;
  prompt(
    groupFolder: string,
    input: ConversationMessageInput,
  ): Promise<GroupRuntimeSnapshot>;
  abort(groupFolder: string): Promise<GroupRuntimeSnapshot>;
  newSession(groupFolder: string): Promise<GroupRuntimeSnapshot>;
  subscribe(groupFolder: string, listener: GroupRuntimeListener): () => void;
}
