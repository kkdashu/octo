import type { ResolvedAgentProfile } from "../runtime/types";

// ---------------------------------------------------------------------------
// Agent Provider abstraction — unified interface for different AI agent backends
// ---------------------------------------------------------------------------

/** Normalized event stream from any agent backend */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "result"; sessionId?: string }
  | { type: "error"; error: Error };

/** A running agent session */
export interface AgentSession {
  /** Push a follow-up message into the active session */
  push(text: string): void;
  /** Close / terminate the session */
  close(): void;
}

/** Configuration for starting a new agent session */
export interface SessionConfig {
  groupFolder: string;
  workingDirectory: string;
  initialPrompt: string;
  isMain: boolean;
  resumeSessionId?: string;
  tools: ToolDefinition[];
  profile: ResolvedAgentProfile;
}

/** Platform-agnostic tool definition */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

/** Agent provider — each backend implements this interface */
export interface AgentProvider {
  readonly name: string;

  startSession(config: SessionConfig): Promise<{
    session: AgentSession;
    events: AsyncIterable<AgentEvent>;
  }>;
}
