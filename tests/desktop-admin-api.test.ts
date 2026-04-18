import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopAdminApiRouter } from "../src/desktop/admin-api";
import { getGroupByFolder, initDatabase, registerGroup, upsertGroupMemory } from "../src/db";

function createWorkspace() {
  const dir = join(tmpdir(), `octo-desktop-admin-api-${crypto.randomUUID()}`);
  mkdirSync(join(dir, "groups", "test-group"), { recursive: true });
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
  registerGroup(db, {
    jid: "oc_test",
    name: "Test Group",
    folder: "test-group",
    channelType: "feishu",
    requiresTrigger: true,
    isMain: false,
    profileKey: "claude",
  });

  upsertGroupMemory(db, {
    groupFolder: "test-group",
    key: "topic_context",
    keyType: "builtin",
    value: "这个群主要用于英语学习",
    source: "tool",
  });

  writeFileSync(join(dir, "groups", "test-group", "AGENTS.md"), "hello admin\n", "utf-8");

  return { dir, db, configPath };
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
  test("lists groups with available profiles", async () => {
    const { dir, db, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });
    const response = router.listGroups(new Request("http://localhost/api/desktop/admin/groups"));
    const payload = await response.json() as {
      groups: Array<{ folder: string }>;
      availableProfiles: Array<{ profileKey: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.groups[0]?.folder).toBe("test-group");
    expect(payload.availableProfiles.map((profile) => profile.profileKey)).toEqual([
      "claude",
      "codex",
      "minimax",
    ]);
  });

  test("updates group metadata and rejects unknown profiles", async () => {
    const { dir, db, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });
    const successResponse = await router.patchGroup(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Renamed Group",
          triggerPattern: "@octo",
          requiresTrigger: false,
          profileKey: "minimax",
        }),
      }),
      { folder: "test-group" },
    ));

    expect(successResponse.status).toBe(200);
    const updated = getGroupByFolder(db, "test-group");
    expect(updated?.name).toBe("Renamed Group");
    expect(updated?.trigger_pattern).toBe("@octo");
    expect(updated?.requires_trigger).toBe(0);
    expect(updated?.profile_key).toBe("minimax");

    const invalidResponse = await router.patchGroup(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Broken Group",
          triggerPattern: "",
          requiresTrigger: true,
          profileKey: "missing-profile",
        }),
      }),
      { folder: "test-group" },
    ));

    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: "invalid_profile",
    });
  });

  test("returns group memories in group detail and supports memory CRUD", async () => {
    const { dir, db, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });

    const detailResponse = router.getGroup(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group"),
      { folder: "test-group" },
    ));
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      group: { folder: "test-group" },
      memories: [
        {
          key: "topic_context",
          keyType: "builtin",
          value: "这个群主要用于英语学习",
        },
      ],
    });

    const createMemoryResponse = await router.putMemory(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "study_goal",
          keyType: "custom",
          value: "重点提升英语口语",
        }),
      }),
      { folder: "test-group" },
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
      new Request("http://localhost/api/desktop/admin/groups/test-group/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "study_goal",
          keyType: "builtin",
          value: "不合法",
        }),
      }),
      { folder: "test-group" },
    ));
    expect(invalidBuiltinResponse.status).toBe(400);
    expect(await invalidBuiltinResponse.json()).toMatchObject({
      error: "invalid_request",
    });

    const deleteMemoryResponse = router.deleteMemory(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group/memory?key=topic_context", {
        method: "DELETE",
      }),
      { folder: "test-group" },
    ));
    expect(deleteMemoryResponse.status).toBe(200);
    expect(await deleteMemoryResponse.json()).toMatchObject({
      memories: expect.not.arrayContaining([
        expect.objectContaining({ key: "topic_context" }),
      ]),
    });

    const missingMemoryResponse = router.deleteMemory(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group/memory?key=missing_key", {
        method: "DELETE",
      }),
      { folder: "test-group" },
    ));
    expect(missingMemoryResponse.status).toBe(404);
    expect(await missingMemoryResponse.json()).toMatchObject({
      error: "memory_not_found",
    });
  });

  test("supports file read and write APIs", async () => {
    const { dir, db, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createDesktopAdminApiRouter(db, { rootDir: dir });

    const readResponse = router.getFile(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group/file?path=AGENTS.md"),
      { folder: "test-group" },
    ));
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      path: "AGENTS.md",
      content: "hello admin\n",
    });

    const writeResponse = await router.putFile(withParams(
      new Request("http://localhost/api/desktop/admin/groups/test-group/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "AGENTS.md",
          content: "updated\n",
        }),
      }),
      { folder: "test-group" },
    ));
    expect(writeResponse.status).toBe(200);
    expect(await writeResponse.json()).toMatchObject({
      path: "AGENTS.md",
      content: "updated\n",
    });
  });
});
