export interface AdminProfileOption {
  profileKey: string;
  apiFormat: "anthropic" | "openai";
  upstreamApi?: "chat_completions" | "responses";
  model: string;
  provider?: string;
  codingPlanEnabled: boolean;
}

export interface AdminGroupDto {
  jid: string;
  name: string;
  folder: string;
  channelType: string;
  triggerPattern: string;
  requiresTrigger: boolean;
  isMain: boolean;
  profileKey: string;
  addedAt: string;
}

export interface AdminGroupMemoryDto {
  key: string;
  keyType: "builtin" | "custom";
  value: string;
  source: "user" | "tool";
  createdAt: string;
  updatedAt: string;
}

export interface AdminGroupListResponse {
  groups: AdminGroupDto[];
  availableProfiles: AdminProfileOption[];
}

export interface AdminGroupDetailResponse {
  group: AdminGroupDto;
  availableProfiles: AdminProfileOption[];
  memories: AdminGroupMemoryDto[];
}

export type AdminDirectoryEntryKind = "file" | "directory";

export interface AdminDirectoryEntryDto {
  name: string;
  path: string;
  kind: AdminDirectoryEntryKind;
  size?: number;
}

export interface AdminDirectoryListingDto {
  path: string;
  entries: AdminDirectoryEntryDto[];
}

export interface AdminFileContentDto {
  path: string;
  content: string;
  size: number;
}
