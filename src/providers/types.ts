import type { ResolvedAgentProfile } from "../runtime/types";

export interface ExternalMcpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type RuntimeInputMode = "prompt" | "follow_up" | "steer";

export interface ConversationMessageInput {
  text: string;
  mode: RuntimeInputMode;
}

export interface OpenConversationInput {
  groupFolder: string;
  workingDirectory: string;
  isMain: boolean;
  tools: ToolDefinition[];
  profile: ResolvedAgentProfile;
  externalMcpServers?: Record<string, ExternalMcpServerSpec>;
  resumeSessionRef?: string;
}

export interface ResetSessionInput {
  groupFolder: string;
  workingDirectory: string;
  profile: ResolvedAgentProfile;
  resumeSessionRef?: string;
}

export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        text?: string;
        blob?: string;
        mimeType?: string;
      };
    }
  | {
      type: "resource_link";
      name: string;
      uri: string;
      description?: string;
    };

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: ToolContentBlock[];
}

export type RuntimeDiagnosticName =
  | "turn_start"
  | "turn_end"
  | "auto_compaction_start"
  | "auto_compaction_end"
  | "auto_retry_start"
  | "auto_retry_end";

export type RuntimeEvent =
  | { type: "assistant_text"; text: string }
  | { type: "completed"; sessionRef?: string }
  | { type: "failed"; error: Error }
  | {
      type: "diagnostic";
      name: RuntimeDiagnosticName;
      message?: string;
    };

export interface RuntimeConversation {
  send(input: ConversationMessageInput): Promise<void>;
  close(): void;
}

export interface AgentRuntime {
  readonly name: string;

  openConversation(input: OpenConversationInput): Promise<{
    conversation: RuntimeConversation;
    events: AsyncIterable<RuntimeEvent>;
  }>;

  resetSession(input: ResetSessionInput): Promise<{
    sessionRef: string;
  }>;
}
