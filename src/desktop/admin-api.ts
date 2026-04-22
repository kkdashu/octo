import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  deleteWorkspaceMemory,
  getWorkspaceByFolder,
  listChatsForWorkspace,
  listWorkspaceMemories,
  listWorkspaces,
  type WorkspaceMemoryRow,
  upsertWorkspaceMemory,
  updateChat,
  updateWorkspace,
  validateWorkspaceMemoryKey,
} from "../db";
import { listAgentProfiles, loadAgentProfilesConfig } from "../runtime/profile-config";
import {
  createWorkspaceDirectory,
  DesktopAdminFileError,
  listWorkspaceDirectory,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from "./admin-files";
import type {
  DesktopAdminProfileOption,
  DesktopAdminWorkspaceDetailResponse,
  DesktopAdminWorkspaceDto,
  DesktopAdminWorkspaceListResponse,
  DesktopAdminWorkspaceMemoryDto,
} from "./admin-types";

type RouteRequest = Request & {
  params?: Record<string, string>;
};

export interface DesktopAdminApiRouter {
  listWorkspaces(req: Request): Response;
  getWorkspace(req: Request): Response;
  patchWorkspace(req: Request): Promise<Response>;
  putMemory(req: Request): Promise<Response>;
  deleteMemory(req: Request): Response;
  listFiles(req: Request): Response;
  getFile(req: Request): Response;
  putFile(req: Request): Promise<Response>;
  postFile(req: Request): Promise<Response>;
  postFolder(req: Request): Promise<Response>;
}

const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "workspace 名称不能为空"),
  triggerPattern: z.string(),
  requiresTrigger: z.boolean(),
  profileKey: z.string().trim().min(1, "模型线路不能为空"),
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

function toDesktopAdminProfileOption(): DesktopAdminProfileOption[] {
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

function mapWorkspaceRow(db: Database, folder: string): DesktopAdminWorkspaceDto {
  const workspace = getWorkspaceByFolder(db, folder);
  if (!workspace) {
    throw new Error(`Workspace not found: ${folder}`);
  }

  const chat = listChatsForWorkspace(db, workspace.id)[0] ?? null;
  return {
    id: workspace.id,
    name: workspace.name,
    folder: workspace.folder,
    triggerPattern: chat?.trigger_pattern ?? "",
    requiresTrigger: chat?.requires_trigger === 1,
    profileKey: workspace.profile_key,
    createdAt: workspace.created_at,
  };
}

function toDesktopAdminWorkspaceMemoryDto(
  memory: WorkspaceMemoryRow,
): DesktopAdminWorkspaceMemoryDto {
  return {
    key: memory.key,
    keyType: memory.key_type,
    value: memory.value,
    source: memory.source,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
  };
}

function buildWorkspaceListResponse(db: Database): DesktopAdminWorkspaceListResponse {
  const workspaces = listWorkspaces(db)
    .map((workspace) => mapWorkspaceRow(db, workspace.folder))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  return {
    workspaces,
    availableProfiles: toDesktopAdminProfileOption(),
  };
}

function buildWorkspaceDetailResponse(
  db: Database,
  folder: string,
): DesktopAdminWorkspaceDetailResponse | null {
  const workspace = getWorkspaceByFolder(db, folder);
  if (!workspace) {
    return null;
  }

  return {
    workspace: mapWorkspaceRow(db, folder),
    availableProfiles: toDesktopAdminProfileOption(),
    memories: listWorkspaceMemories(db, workspace.id).map(toDesktopAdminWorkspaceMemoryDto),
  };
}

function handleKnownError(error: unknown): Response {
  if (error instanceof DesktopAdminFileError) {
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

export function createDesktopAdminApiRouter(
  db: Database,
  options?: { rootDir?: string },
): DesktopAdminApiRouter {
  const rootDir = options?.rootDir ?? process.cwd();

  return {
    listWorkspaces() {
      return json(buildWorkspaceListResponse(db));
    },

    getWorkspace(req) {
      try {
        const folder = getFolderParam(req);
        const response = buildWorkspaceDetailResponse(db, folder);
        if (!response) {
          return errorResponse(404, "workspace_not_found", `Workspace not found: ${folder}`);
        }

        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async patchWorkspace(req) {
      try {
        const folder = getFolderParam(req);
        const workspace = getWorkspaceByFolder(db, folder);
        if (!workspace) {
          return errorResponse(404, "workspace_not_found", `Workspace not found: ${folder}`);
        }

        const body = patchWorkspaceSchema.parse(await req.json());
        const config = loadAgentProfilesConfig();
        if (!config.profiles[body.profileKey]) {
          return errorResponse(
            400,
            "invalid_profile",
            `Unknown profile: ${body.profileKey}`,
          );
        }

        updateWorkspace(db, workspace.id, {
          name: body.name,
          profileKey: body.profileKey,
        });
        const chat = listChatsForWorkspace(db, workspace.id)[0] ?? null;
        if (chat) {
          updateChat(db, chat.id, {
            title: body.name,
            triggerPattern: body.triggerPattern,
            requiresTrigger: body.requiresTrigger,
          });
        }

        const response = buildWorkspaceDetailResponse(db, folder);
        if (!response) {
          return errorResponse(404, "workspace_not_found", `Workspace not found: ${folder}`);
        }

        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async putMemory(req) {
      try {
        const folder = getFolderParam(req);
        const workspace = getWorkspaceByFolder(db, folder);
        if (!workspace) {
          return errorResponse(404, "workspace_not_found", `Workspace not found: ${folder}`);
        }

        const body = upsertMemorySchema.parse(await req.json());
        const validationError = validateWorkspaceMemoryKey(body.key, body.keyType);
        if (validationError) {
          return errorResponse(400, "invalid_memory_key", validationError);
        }

        upsertWorkspaceMemory(db, {
          workspaceId: workspace.id,
          key: body.key,
          keyType: body.keyType,
          value: body.value,
        });
        const response = buildWorkspaceDetailResponse(db, folder);
        if (!response) {
          return errorResponse(404, "workspace_not_found", `Workspace not found: ${folder}`);
        }

        return json(response);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    deleteMemory(req) {
      try {
        const folder = getFolderParam(req);
        const workspace = getWorkspaceByFolder(db, folder);
        if (!workspace) {
          return errorResponse(404, "workspace_not_found", `Workspace not found: ${folder}`);
        }

        const key = parseKeyQuery(req);
        if (!key) {
          return errorResponse(400, "invalid_request", "memory key 不能为空");
        }

        const deleted = deleteWorkspaceMemory(db, workspace.id, key);
        if (!deleted) {
          return errorResponse(404, "memory_not_found", `Memory not found: ${key}`);
        }

        return json({ ok: true });
      } catch (error) {
        return handleKnownError(error);
      }
    },

    listFiles(req) {
      try {
        const folder = getFolderParam(req);
        return json(listWorkspaceDirectory(folder, parsePathQuery(req), rootDir));
      } catch (error) {
        return handleKnownError(error);
      }
    },

    getFile(req) {
      try {
        const folder = getFolderParam(req);
        const path = parsePathQuery(req);
        if (path === ".") {
          return errorResponse(400, "invalid_request", "文件路径不能为空");
        }
        return json(readWorkspaceTextFile(folder, path, rootDir));
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async putFile(req) {
      try {
        const folder = getFolderParam(req);
        const body = updateFileSchema.parse(await req.json());
        return json(writeWorkspaceTextFile(folder, body.path, body.content, {
          overwrite: true,
          rootDir,
        }));
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async postFile(req) {
      try {
        const folder = getFolderParam(req);
        const body = createFileSchema.parse(await req.json());
        return json(writeWorkspaceTextFile(folder, body.path, body.content, {
          createParents: body.createParents,
          overwrite: false,
          rootDir,
        }), 201);
      } catch (error) {
        return handleKnownError(error);
      }
    },

    async postFolder(req) {
      try {
        const folder = getFolderParam(req);
        const body = createFolderSchema.parse(await req.json());
        return json(createWorkspaceDirectory(folder, body.path, rootDir), 201);
      } catch (error) {
        return handleKnownError(error);
      }
    },
  };
}
