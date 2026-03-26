import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminApiRouter } from "../src/admin/api";
import { ADMIN_HOSTNAME, startAdminServer } from "../src/admin/server";
import { getGroupByFolder, initDatabase, registerGroup } from "../src/db";

function createWorkspace() {
  const dir = join(tmpdir(), `octo-admin-api-${crypto.randomUUID()}`);
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
    agentProvider: "claude",
  });

  writeFileSync(join(dir, "groups", "test-group", "CLAUDE.md"), "hello admin\n", "utf-8");

  return { dir, db, configPath };
}

function withParams<T extends Request>(request: T, params: Record<string, string>): T & {
  params: Record<string, string>;
} {
  return Object.assign(request, { params });
}

const cleanupDirs: string[] = [];
let previousProfilesPath = process.env.AGENT_PROFILES_PATH;

afterEach(() => {
  process.env.AGENT_PROFILES_PATH = previousProfilesPath;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("admin api router", () => {
  test("lists groups with available profiles", async () => {
    const { dir, db, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createAdminApiRouter(db, { rootDir: dir });
    const response = router.listGroups(new Request("http://localhost/api/admin/groups"));
    const payload = await response.json() as {
      groups: Array<{ folder: string }>;
      availableProfiles: Array<{ profileKey: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.groups[0]?.folder).toBe("test-group");
    expect(payload.availableProfiles.map((profile) => profile.profileKey)).toEqual(["claude", "codex"]);
  });

  test("updates group metadata and rejects unknown profiles", async () => {
    const { dir, db, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createAdminApiRouter(db, { rootDir: dir });
    const successResponse = await router.patchGroup(withParams(
      new Request("http://localhost/api/admin/groups/test-group", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Renamed Group",
          triggerPattern: "@octo",
          requiresTrigger: false,
          agentProvider: "codex",
        }),
      }),
      { folder: "test-group" },
    ));

    expect(successResponse.status).toBe(200);
    const updated = getGroupByFolder(db, "test-group");
    expect(updated?.name).toBe("Renamed Group");
    expect(updated?.trigger_pattern).toBe("@octo");
    expect(updated?.requires_trigger).toBe(0);
    expect(updated?.agent_provider).toBe("codex");

    const invalidResponse = await router.patchGroup(withParams(
      new Request("http://localhost/api/admin/groups/test-group", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Broken Group",
          triggerPattern: "",
          requiresTrigger: true,
          agentProvider: "missing-profile",
        }),
      }),
      { folder: "test-group" },
    ));

    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: "invalid_profile",
    });
  });

  test("supports file read and write APIs", async () => {
    const { dir, db, configPath } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.AGENT_PROFILES_PATH = configPath;

    const router = createAdminApiRouter(db, { rootDir: dir });

    const readResponse = router.getFile(withParams(
      new Request("http://localhost/api/admin/groups/test-group/file?path=CLAUDE.md"),
      { folder: "test-group" },
    ));
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      path: "CLAUDE.md",
      content: "hello admin\n",
    });

    const writeResponse = await router.putFile(withParams(
      new Request("http://localhost/api/admin/groups/test-group/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "CLAUDE.md",
          content: "updated\n",
        }),
      }),
      { folder: "test-group" },
    ));
    expect(writeResponse.status).toBe(200);
    expect(await writeResponse.json()).toMatchObject({
      path: "CLAUDE.md",
      content: "updated\n",
    });
  });

  test("starts the admin server on localhost by default", () => {
    const originalServe = Bun.serve;
    let capturedHostname: string | undefined;
    let capturedPort: number | undefined;

    const bunObject = Bun as unknown as {
      serve: typeof Bun.serve;
    };

    bunObject.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
      capturedHostname = options.hostname;
      capturedPort = options.port;
      return {
        url: new URL(`http://${options.hostname}:${options.port}`),
        stop() {
          // no-op
        },
      } as ReturnType<typeof Bun.serve>;
    }) as typeof Bun.serve;

    try {
      const server = startAdminServer({
        port: 3210,
        api: {
          listGroups: () => Response.json({ groups: [], availableProfiles: [] }),
          getGroup: () => Response.json({}),
          patchGroup: async () => Response.json({}),
          listFiles: () => Response.json({ path: ".", entries: [] }),
          getFile: () => Response.json({ path: "x", content: "", size: 0 }),
          putFile: async () => Response.json({}),
          postFile: async () => Response.json({}),
          postFolder: async () => Response.json({}),
        },
      });

      expect(capturedHostname).toBe(ADMIN_HOSTNAME);
      expect(capturedPort).toBe(3210);
      expect(server.url.hostname).toBe(ADMIN_HOSTNAME);
    } finally {
      bunObject.serve = originalServe;
    }
  });
});
