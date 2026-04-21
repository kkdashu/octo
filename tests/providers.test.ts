import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPiMcpExtensionBundle } from "../src/providers/pi-mcp-extension";
import {
  annotateLocalFileLinksForAgent,
  annotateStandaloneLocalFilePathsForAgent,
  collectAssistantText,
  filterInternalContent,
  normalizePromptForAgent,
} from "../src/providers/prompt-normalizer";
import {
  getPiSessionDir,
  resolvePersistedPiSessionRef,
} from "../src/providers/pi-session-ref";
import {
  adaptOctoTools,
  OCTO_TOOL_PREFIX,
  toPiToolName,
} from "../src/providers/pi-tool-adapter";

const fakeMcpFixturePath = fileURLToPath(
  new URL("./fixtures/fake-mcp-server.ts", import.meta.url),
);
const bunExecutable = Bun.which("bun") ?? process.execPath;

type RegisteredExtensionTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >;
    details: unknown;
  }>;
};

describe("Pi session refs", () => {
  test("resolves existing absolute and relative local session refs", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-pi-session-ref-"));
    const workingDirectory = join(workspaceDir, "groups", "main");
    const sessionDir = getPiSessionDir(workingDirectory);
    const absoluteSessionRef = join(sessionDir, "absolute.jsonl");
    const relativeSessionRef = join(".pi", "sessions", "relative.jsonl");

    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(absoluteSessionRef, "");
      writeFileSync(join(workingDirectory, relativeSessionRef), "");

      expect(
        resolvePersistedPiSessionRef(workingDirectory, absoluteSessionRef),
      ).toBe(absoluteSessionRef);
      expect(
        resolvePersistedPiSessionRef(workingDirectory, relativeSessionRef),
      ).toBe(join(workingDirectory, relativeSessionRef));
      expect(
        resolvePersistedPiSessionRef(workingDirectory, join(sessionDir, "missing.jsonl")),
      ).toBeUndefined();
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("Pi tool adapter", () => {
  test("prefixes octo tools into Pi MCP-style names and preserves handler output", async () => {
    const piTools = adaptOctoTools([
      {
        name: "send_message",
        description: "Send a message",
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        handler: async (args) => ({
          content: [{ type: "text", text: `sent:${String(args.text)}` }],
        }),
      },
    ]);

    expect(OCTO_TOOL_PREFIX).toBe("mcp__octo-tools__");
    expect(toPiToolName("send_message")).toBe("mcp__octo-tools__send_message");
    expect(piTools[0]?.name).toBe("mcp__octo-tools__send_message");

    const result = await piTools[0]!.execute("call-1", { text: "hello" });
    expect(result.content).toEqual([{ type: "text", text: "sent:hello" }]);
  });
});

describe("Pi MCP bridge integration", () => {
  test("registers tools from a real stdio MCP server and normalizes text/non-text content", async () => {
    const bundle = await createPiMcpExtensionBundle(
      {
        fake: {
          command: bunExecutable,
          args: [fakeMcpFixturePath],
        },
      },
      process.cwd(),
    );
    const tools = new Map<string, RegisteredExtensionTool>();

    try {
      expect(bundle.extensionFactories).toHaveLength(1);

      await bundle.extensionFactories[0]!({
        registerTool: (tool: RegisteredExtensionTool) => {
          tools.set(tool.name, tool);
        },
      } as never);

      const echoTool = tools.get("mcp__fake__echo_content");
      expect(echoTool).toBeDefined();

      const textResult = await echoTool!.execute("call-text", {
        text: "hello",
        mode: "text",
      });
      expect(textResult.content).toEqual([{ type: "text", text: "echo:hello" }]);

      const resourceResult = await echoTool!.execute("call-resource", {
        text: "hello",
        mode: "resource",
      });
      expect(resourceResult.content).toEqual([{ type: "text", text: "resource:hello" }]);

      const resourceLinkResult = await echoTool!.execute("call-resource-link", {
        text: "hello",
        mode: "resource_link",
      });
      expect(resourceLinkResult.content).toEqual([
        { type: "text", text: "artifact: linked:hello (file:///tmp/hello.txt)" },
      ]);

      const imageResult = await echoTool!.execute("call-image", {
        text: "hello",
        mode: "image",
      });
      expect(imageResult.content).toEqual([
        {
          type: "image",
          data: Buffer.from("image:hello", "utf8").toString("base64"),
          mimeType: "image/png",
        },
      ]);
    } finally {
      await bundle.dispose();
    }
  });
});

describe("Prompt normalization", () => {
  test("uses preprocessed pure text content instead of legacy image placeholders", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-images-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const normalized = await normalizePromptForAgent(
        "前文\n![image](media/oc_test/om_test.png)\n后文",
        workspaceDir,
        workingDirectory,
        {
          preprocess: async (text: string, rootDir: string) => {
            expect(rootDir).toBe(workspaceDir);
            expect(text).toBe("前文\n![image](media/oc_test/om_test.png)\n后文");

            return [
              "前文",
              "[图片理解结果]",
              "路径: media/oc_test/om_test.png",
              "客观描述: 一只白猫趴着",
              "OCR文本: 无",
              "关键信息: 无票据或聊天界面",
              "[/图片理解结果]",
              "后文",
            ].join("\n");
          },
        },
        "test",
      );

      expect(normalized).toBe(
        [
          "前文",
          "[图片理解结果]",
          "路径: media/oc_test/om_test.png",
          "客观描述: 一只白猫趴着",
          "OCR文本: 无",
          "关键信息: 无票据或聊天界面",
          "[/图片理解结果]",
          "后文",
        ].join("\n"),
      );
      expect(normalized).not.toContain("Read");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("falls back to normalized markdown when image preprocessing throws", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-images-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const normalized = await normalizePromptForAgent(
        "旧格式图片：[IMAGE:media/oc_test/om_legacy.png]",
        workspaceDir,
        workingDirectory,
        {
          preprocess: async () => {
            throw new Error("preprocess failed");
          },
        },
        "test",
      );

      expect(normalized).toBe("旧格式图片：![image](media/oc_test/om_legacy.png)");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("annotates local file links with agent-readable paths", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-files-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const annotated = annotateLocalFileLinksForAgent(
        "请阅读这个文件：[AI素养评价_产品手册.md](media/oc_test/om_1-AI素养评价_产品手册.md)",
        workspaceDir,
        workingDirectory,
      );

      expect(annotated).toContain(
        "[AI素养评价_产品手册.md](media/oc_test/om_1-AI素养评价_产品手册.md)",
      );
      expect(annotated).toContain(
        "可读路径: ../../media/oc_test/om_1-AI素养评价_产品手册.md",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("keeps working-directory-relative file links unchanged", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-files-"));
    const workingDirectory = join(workspaceDir, "groups", "main");

    try {
      mkdirSync(workingDirectory, { recursive: true });

      const annotated = annotateLocalFileLinksForAgent(
        "请发送 [report.pdf](./artifacts/report.pdf)",
        workspaceDir,
        workingDirectory,
      );

      expect(annotated).toBe("请发送 [report.pdf](./artifacts/report.pdf)");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("annotates standalone local file paths so agents can treat them as sendable files", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "octo-provider-files-"));
    const workingDirectory = join(workspaceDir, "groups", "main");
    const filePath = join(workingDirectory, ".generated", "documents", "report.md");

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "# report");

      const annotated = annotateStandaloneLocalFilePathsForAgent(
        `${filePath}\n\n把这个文件发给我`,
        workspaceDir,
        workingDirectory,
      );

      expect(annotated).toContain(`[report.md](${filePath})`);
      expect(annotated).toContain("把这个文件发给我");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("collects assistant text and strips internal content", () => {
    expect(filterInternalContent("before<internal>secret</internal>after")).toBe(
      "beforeafter",
    );

    expect(
      collectAssistantText({
        role: "assistant",
        content: [
          { type: "text", text: "Visible" },
          { type: "text", text: "<internal>secret</internal>Shown" },
          { type: "image", data: "..." },
        ],
      }),
    ).toBe("Visible\n\nShown");
  });
});
