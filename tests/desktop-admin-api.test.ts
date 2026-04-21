import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopAdminApiRouter } from "../src/desktop/admin-api";
import {
  createChat,
  createWorkspace,
  getWorkspaceByFolder,
  initDatabase,
  listChatsForWorkspace,
  upsertWorkspaceMemory,
} from "../src/db";

function createFixture() {
  const dir = join(tmpdir(), `octo-desktop-admin-api-${crypto.randomUUID()}`);
  mkdirSync(join(dir, "workspaces", "test-workspace"), { recursive: true });
  mkdirSync(join(dir, "store"), { recursive: true });

  const configPath = join(dir, "agent-profiles.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "claude",
      profiles: {
        claude: {
          apiFormat: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          model: "claude-sonnet-4-6",
        },
        codex: {
          apiFormat: "openai",
          upstreamApi: "responses",
          baseUrl: "https://api.openai.com",
          apiKeyEnv: "OPENAI_API_KEY",
          model: "gpt-5.4",
        },
        minimax: {
          apiFormat: "anthropic",
          baseUrl: "https://api.minimaxi.com/anthropic",
          apiKeyEnv: "MINIMAX_API_KEY",
          model: "MiniMax-M2.7",
          provider: "minimax",
        },
      },
    }),
    "utf-8",
  );

  const db = initDatabase(join(dir, "store", "messages.db"));
  const workspace = createWorkspace(db, {
    name: "Test Workspace",
    folder: "test-workspace",
    defaultBranch: "main",
    profileKey: "claude",
    isMain: false,
  });
  createChat(db, {
    workspaceId: workspace.id,
    title: "Test Workspace",
    activeBranch: "main",
    triggerPattern: "@octo",
    requiresTrigger: true,
    sessionRef: null,
  });

  upsertWorkspaceMemory(db, {
    workspaceId: workspace.id,
    key: "topic_context",
    keyType: "builtin",
    value: "这个工作区主要用于英语学习",
    source: "tool",
  });

  writeFileSync(join(dir, "workspaces", "test-workspace", "AGENTS.md"), "hello admin\n", "utf-8");

  return { dir, db, configPath, workspace };
}

function withParams<T extends Request>(request: T, params: Record<string, string>): T & {
  params: Record<string, string>;
} {
  return Object.assign(request, { params });
}

const cleanupDirs: string[] = [];
const previousProfilesPath = process.env.AGENT_PROFILES_PATH;

afterEach(() => {
  process.env.AGENT_PROFILES_PATH = previousProfilesPath;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("desktop admin api router", () => {
  test("lists workspaces with available profiles", async () => {
    const { dir, db, configPath } = createFixture();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });
    const response = router.listWorkspaces(
      new Request("http://localhost/api/desktop/admin/workspaces"),
    );
    const payload = await response.json() as {
      workspaces: Array<{ folder: string; triggerPattern: string; requiresTrigger: boolean }>;
      availableProfiles: Array<{ profileKey: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.workspaces[0]).toMatchObject({
      folder: "test-workspace",
      triggerPattern: "@octo",
      requiresTrigger: true,
    });
    expect(payload.availableProfiles.map((profile) => profile.profileKey)).toEqual([
      "claude",
      "codex",
      "minimax",
    ]);
  });

  test("updates workspace metadata and rejects unknown profiles", async () => {
    const { dir, db, configPath, workspace } = createFixture();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });
    const successResponse = await router.patchWorkspace(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Renamed Workspace",
          triggerPattern: "@octo",
          requiresTrigger: false,
          profileKey: "minimax",
        }),
      }),
      { folder: "test-workspace" },
    ));

    expect(successResponse.status).toBe(200);
    const updatedWorkspace = getWorkspaceByFolder(db, "test-workspace");
    const updatedChat = listChatsForWorkspace(db, workspace.id)[0];
    expect(updatedWorkspace?.name).toBe("Renamed Workspace");
    expect(updatedWorkspace?.profile_key).toBe("minimax");
    expect(updatedChat).toMatchObject({
      title: "Renamed Workspace",
      trigger_pattern: "@octo",
      requires_trigger: 0,
    });

    const invalidResponse = await router.patchWorkspace(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Broken Workspace",
          triggerPattern: "",
          requiresTrigger: true,
          profileKey: "missing-profile",
        }),
      }),
      { folder: "test-workspace" },
    ));

    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: "invalid_profile",
    });
  });

  test("returns workspace memories in detail and supports memory CRUD", async () => {
    const { dir, db, configPath } = createFixture();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });

    const detailResponse = router.getWorkspace(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace"),
      { folder: "test-workspace" },
    ));
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      workspace: { folder: "test-workspace" },
      memories: [
        {
          key: "topic_context",
          keyType: "builtin",
          value: "这个工作区主要用于英语学习",
        },
      ],
    });

    const createMemoryResponse = await router.putMemory(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "study_goal",
          keyType: "custom",
          value: "重点提升英语口语",
        }),
      }),
      { folder: "test-workspace" },
    ));
    expect(createMemoryResponse.status).toBe(200);
    expect(await createMemoryResponse.json()).toMatchObject({
      memories: expect.arrayContaining([
        expect.objectContaining({
          key: "study_goal",
          keyType: "custom",
          value: "重点提升英语口语",
        }),
      ]),
    });

    const invalidBuiltinResponse = await router.putMemory(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "study_goal",
          keyType: "builtin",
          value: "不合法",
        }),
      }),
      { folder: "test-workspace" },
    ));
    expect(invalidBuiltinResponse.status).toBe(400);
    expect(await invalidBuiltinResponse.json()).toMatchObject({
      error: "invalid_memory_key",
    });

    const deleteMemoryResponse = router.deleteMemory(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/memory?key=topic_context", {
        method: "DELETE",
      }),
      { folder: "test-workspace" },
    ));
    expect(deleteMemoryResponse.status).toBe(200);
    expect(await deleteMemoryResponse.json()).toEqual({ ok: true });

    const afterDeleteResponse = router.getWorkspace(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace"),
      { folder: "test-workspace" },
    ));
    expect(await afterDeleteResponse.json()).toMatchObject({
      memories: expect.not.arrayContaining([
        expect.objectContaining({ key: "topic_context" }),
      ]),
    });

    const missingMemoryResponse = router.deleteMemory(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/memory?key=missing_key", {
        method: "DELETE",
      }),
      { folder: "test-workspace" },
    ));
    expect(missingMemoryResponse.status).toBe(404);
    expect(await missingMemoryResponse.json()).toMatchObject({
      error: "memory_not_found",
    });
  });

  test("supports file and folder admin APIs", async () => {
    const { dir, db, configPath } = createFixture();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });

    const readResponse = router.getFile(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/file?path=AGENTS.md"),
      { folder: "test-workspace" },
    ));
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      path: "AGENTS.md",
      content: "hello admin\n",
    });

    const writeResponse = await router.putFile(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "AGENTS.md",
          content: "updated\n",
        }),
      }),
      { folder: "test-workspace" },
    ));
    expect(writeResponse.status).toBe(200);
    expect(await writeResponse.json()).toMatchObject({
      path: "AGENTS.md",
      content: "updated\n",
    });

    const createFolderResponse = await router.postFolder(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "docs/specs",
        }),
      }),
      { folder: "test-workspace" },
    ));
    expect(createFolderResponse.status).toBe(201);
    expect(await createFolderResponse.json()).toMatchObject({
      path: "docs/specs",
    });

    const createFileResponse = await router.postFile(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "docs/specs/notes.md",
          content: "created\n",
        }),
      }),
      { folder: "test-workspace" },
    ));
    expect(createFileResponse.status).toBe(201);
    expect(await createFileResponse.json()).toMatchObject({
      path: "docs/specs/notes.md",
      content: "created\n",
    });

    const listFilesResponse = router.listFiles(withParams(
      new Request("http://localhost/api/desktop/admin/workspaces/test-workspace/files?path=docs"),
      { folder: "test-workspace" },
    ));
    expect(listFilesResponse.status).toBe(200);
    expect(await listFilesResponse.json()).toMatchObject({
      path: "docs",
      entries: [
        {
          kind: "directory",
          name: "specs",
          path: "docs/specs",
        },
      ],
    });
  });
});
