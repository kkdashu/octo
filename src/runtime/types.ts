export type ApiFormat = "anthropic" | "openai";

export type UpstreamApiType = "chat_completions" | "responses";

export interface AgentProfileConfig {
  apiFormat: ApiFormat;
  upstreamApi?: UpstreamApiType;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  provider?: string;
  codingPlanEnabled?: boolean;
}

export interface AgentProfilesConfig {
  defaultProfile: string;
  profiles: Record<string, AgentProfileConfig>;
}

export interface ResolvedAgentProfile {
  profileKey: string;
  apiFormat: ApiFormat;
  upstreamApi?: UpstreamApiType;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  model: string;
  provider?: string;
  codingPlanEnabled: boolean;
}

export interface AgentProfileSummary {
  profileKey: string;
  apiFormat: ApiFormat;
  upstreamApi?: UpstreamApiType;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  provider?: string;
  codingPlanEnabled: boolean;
}
