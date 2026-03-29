import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  deleteGroupMemory,
  getGroupByFolder,
  listGroups,
  listGroupMemories,
  type RegisteredGroup,
  type GroupMemoryRow,
  upsertGroupMemory,
  updateGroupMetadata,
  validateGroupMemoryKey,
} from "../db";
import { listAgentProfiles, loadAgentProfilesConfig } from "../runtime/profile-config";
import {
  createGroupDirectory,
  GroupFileError,
  listGroupDirectory,
  readGroupTextFile,
  writeGroupTextFile,
} from "./group-files";
import type {
  AdminDirectoryListingDto,
  AdminFileContentDto,
  AdminGroupDetailResponse,
  AdminGroupDto,
  AdminGroupListResponse,
  AdminGroupMemoryDto,
  AdminProfileOption,
} from "./types";

type RouteRequest = Request & {
  params?: Record<string, string>;
};

export interface AdminApiRouter {
  listGroups(req: Request): Response;
  getGroup(req: Request): Response;
  patchGroup(req: Request): Promise<Response>;
  putMemory(req: Request): Promise<Response>;
  deleteMemory(req: Request): Response;
  listFiles(req: Request): Response;
  getFile(req: Request): Response;
  putFile(req: Request): Promise<Response>;
  postFile(req: Request): Promise<Response>;
  postFolder(req: Request): Promise<Response>;
}

const patchGroupSchema = z.object({
  name: z.string().trim().min(1, "群名称不能为空"),
  triggerPattern: z.string(),
  requiresTrigger: z.boolean(),
  agentProvider: z.string().trim().min(1, "AI 引擎不能为空"),
});

const createFileSchema = z.object({
  path: z.string().trim().min(1, "文件路径不能为空"),
  content: z.string(),
  createParents: z.boolean().optional(),
});

const updateFileSchema = z.object({
  path: z.string().trim().min(1, "文件路径不能为空"),
  content: z.string(),
});

const createFolderSchema = z.object({
  path: z.string().trim().min(1, "目录路径不能为空"),
});

const upsertMemorySchema = z.object({
  key: z.string().trim().min(1, "memory key 不能为空"),
  keyType: z.enum(["builtin", "custom"]),
  value: z.string().trim().min(1, "memory value 不能为空"),
});

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, error: string, details?: string): Response {
  return json(
    details ? { error, details } : { error },
    status,
  );
}

function parsePathQuery(req: Request): string {
  const { searchParams } = new URL(req.url);
  return searchParams.get("path")?.trim() || ".";
}

function parseKeyQuery(req: Request): string {
  const { searchParams } = new URL(req.url);
  return searchParams.get("key")?.trim() || "";
}

function getFolderParam(req: Request): string {
  const folder = (req as RouteRequest).params?.folder;
  if (!folder) {
    throw new Error("Missing route param: folder");
  }
  return folder;
}

function toAdminProfileOption(): AdminProfileOption[] {
  return listAgentProfiles()
    .map((profile) => ({
      profileKey: profile.profileKey,
      apiFormat: profile.apiFormat,
      upstreamApi: profile.upstreamApi,
      model: profile.model,
      provider: profile.provider,
      codingPlanEnabled: profile.codingPlanEnabled,
    }))
    .sort((a, b) => a.profileKey.localeCompare(b.profileKey));
}

function toAdminGroupDto(group: RegisteredGroup): AdminGroupDto {
  return {
    jid: group.jid,
    name: group.name,
    folder: group.folder,
    channelType: group.channel_type,
    triggerPattern: group.trigger_pattern,
    requiresTrigger: group.requires_trigger === 1,
    isMain: group.is_main === 1,
    agentProvider: group.agent_provider,
    addedAt: group.added_at,
  };
}

function toAdminGroupMemoryDto(memory: GroupMemoryRow): AdminGroupMemoryDto {
  return {
    key: memory.key,
    keyType: memory.key_type,
    value: memory.value,
    source: memory.source,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
  };
}

function buildGroupListResponse(db: Database): AdminGroupListResponse {
  const groups = listGroups(db)
    .map(toAdminGroupDto)
    .sort((a, b) => {
      if (a.isMain !== b.isMain) {
        return a.isMain ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });

  return {
    groups,
    availableProfiles: toAdminProfileOption(),
  };
}

function buildGroupDetailResponse(
  db: Database,
  folder: string,
): AdminGroupDetailResponse | null {
  const group = getGroupByFolder(db, folder);
  if (!group) {
    return null;
  }

  return {
    group: toAdminGroupDto(group),
    availableProfiles: toAdminProfileOption(),
    memories: listGroupMemories(db, folder).map(toAdminGroupMemoryDto),
  };
}

function handleKnownError(error: unknown): Response {
  if (error instanceof GroupFileError) {
    return errorResponse(error.status, error.code, error.message);
  }

  if (error instanceof z.ZodError) {
    const message = error.issues.map((issue) => issue.message).join("; ");
    return errorResponse(400, "invalid_request", message);
  }

  if (error instanceof Error) {
    return errorResponse(500, "internal_error", error.message);
  }

  return errorResponse(500, "internal_error");
}

export function createAdminApiRouter(
  db: Database,
  options?: { rootDir?: string },
): AdminApiRouter {
  const rootDir = options?.rootDir ?? process.cwd();

  return {
    listGroups() {
      return json(buildGroupListResponse(db));
    },

    getGroup(req) {
      try {
        const folder = getFolderParam(req);
        const response = buildGroupDetailResponse(db, folder);
        if (!response) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async patchGroup(req) {
      try {
        const folder = getFolderParam(req);
        const target = getGroupByFolder(db, folder);
        if (!target) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }

        const body = patchGroupSchema.parse(await req.json());
        const config = loadAgentProfilesConfig();
        if (!config.profiles[body.agentProvider]) {
          return errorResponse(
            400,
            "invalid_profile",
            `Unknown profile: ${body.agentProvider}`,
          );
        }

        updateGroupMetadata(db, folder, body);
        const response = buildGroupDetailResponse(db, folder);
        if (!response) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async putMemory(req) {
      try {
        const folder = getFolderParam(req);
        const target = getGroupByFolder(db, folder);
        if (!target) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }

        const body = upsertMemorySchema.parse(await req.json());
        const validationError = validateGroupMemoryKey(body.key, body.keyType);
        if (validationError) {
          return errorResponse(400, "invalid_request", validationError);
        }

        upsertGroupMemory(db, {
          groupFolder: folder,
          key: body.key,
          keyType: body.keyType,
          value: body.value,
          source: "tool",
        });

        const response = buildGroupDetailResponse(db, folder);
        if (!response) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    deleteMemory(req) {
      try {
        const folder = getFolderParam(req);
        const target = getGroupByFolder(db, folder);
        if (!target) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }

        const key = parseKeyQuery(req);
        if (!key) {
          return errorResponse(400, "invalid_request", "memory key 不能为空");
        }

        const deleted = deleteGroupMemory(db, folder, key);
        if (!deleted) {
          return errorResponse(404, "memory_not_found", `Memory not found: ${key}`);
        }

        const response = buildGroupDetailResponse(db, folder);
        if (!response) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    listFiles(req) {
      try {
        const folder = getFolderParam(req);
        if (!getGroupByFolder(db, folder)) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        const path = parsePathQuery(req);
        const response: AdminDirectoryListingDto = listGroupDirectory(folder, path, rootDir);
        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    getFile(req) {
      try {
        const folder = getFolderParam(req);
        if (!getGroupByFolder(db, folder)) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        const path = parsePathQuery(req);
        const response: AdminFileContentDto = readGroupTextFile(folder, path, rootDir);
        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async putFile(req) {
      try {
        const folder = getFolderParam(req);
        if (!getGroupByFolder(db, folder)) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        const body = updateFileSchema.parse(await req.json());
        const response = writeGroupTextFile(folder, body.path, body.content, {
          overwrite: true,
          rootDir,
        });
        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async postFile(req) {
      try {
        const folder = getFolderParam(req);
        if (!getGroupByFolder(db, folder)) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        const body = createFileSchema.parse(await req.json());
        const response = writeGroupTextFile(folder, body.path, body.content, {
          createParents: body.createParents ?? false,
          overwrite: false,
          rootDir,
        });
        return json(response, 201);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async postFolder(req) {
      try {
        const folder = getFolderParam(req);
        if (!getGroupByFolder(db, folder)) {
          return errorResponse(404, "group_not_found", `Group not found: ${folder}`);
        }
        const body = createFolderSchema.parse(await req.json());
        const response = createGroupDirectory(folder, body.path, rootDir);
        return json(response, 201);
      } catch (error) {
        return handleKnownError(error);
      }
    },
  };
}
