export interface DesktopAdminProfileOption {
  profileKey: string;
  apiFormat: "anthropic" | "openai";
  upstreamApi?: "chat_completions" | "responses";
  model: string;
  provider?: string;
  codingPlanEnabled: boolean;
}

export interface DesktopAdminWorkspaceDto {
  id: string;
  name: string;
  folder: string;
  triggerPattern: string;
  requiresTrigger: boolean;
  isMain: boolean;
  profileKey: string;
  createdAt: string;
}

export interface DesktopAdminWorkspaceMemoryDto {
  key: string;
  keyType: "builtin" | "custom";
  value: string;
  source: "user" | "tool";
  createdAt: string;
  updatedAt: string;
}

export interface DesktopAdminWorkspaceListResponse {
  workspaces: DesktopAdminWorkspaceDto[];
  availableProfiles: DesktopAdminProfileOption[];
}

export interface DesktopAdminWorkspaceDetailResponse {
  workspace: DesktopAdminWorkspaceDto;
  availableProfiles: DesktopAdminProfileOption[];
  memories: DesktopAdminWorkspaceMemoryDto[];
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
