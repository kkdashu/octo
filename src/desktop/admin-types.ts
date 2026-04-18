export interface DesktopAdminProfileOption {
  profileKey: string;
  apiFormat: "anthropic" | "openai";
  upstreamApi?: "chat_completions" | "responses";
  model: string;
  provider?: string;
  codingPlanEnabled: boolean;
}

export interface DesktopAdminGroupDto {
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

export interface DesktopAdminGroupMemoryDto {
  key: string;
  keyType: "builtin" | "custom";
  value: string;
  source: "user" | "tool";
  createdAt: string;
  updatedAt: string;
}

export interface DesktopAdminGroupListResponse {
  groups: DesktopAdminGroupDto[];
  availableProfiles: DesktopAdminProfileOption[];
}

export interface DesktopAdminGroupDetailResponse {
  group: DesktopAdminGroupDto;
  availableProfiles: DesktopAdminProfileOption[];
  memories: DesktopAdminGroupMemoryDto[];
}

export type DesktopAdminDirectoryEntryKind = "file" | "directory";

export interface DesktopAdminDirectoryEntryDto {
  name: string;
  path: string;
  kind: DesktopAdminDirectoryEntryKind;
  size?: number;
}

export interface DesktopAdminDirectoryListingDto {
  path: string;
  entries: DesktopAdminDirectoryEntryDto[];
}

export interface DesktopAdminFileContentDto {
  path: string;
  content: string;
  size: number;
}
