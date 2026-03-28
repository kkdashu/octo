import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMiniMaxImage,
  MINIMAX_IMAGE_API_URL,
} from "../src/runtime/minimax-image";

const originalEnv = { ...process.env };

describe("MiniMax image generation runtime", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    process.env.MINIMAX_API_KEY = "minimax-test-key";
  });

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("requests MiniMax image generation and saves a jpeg artifact", async () => {
    const groupWorkdir = mkdtempSync(join(tmpdir(), "octo-minimax-image-"));
    cleanupDirs.push(groupWorkdir);
    const imageBytes = Buffer.from("generated-jpeg-binary");

    const artifact = await generateMiniMaxImage(
      {
        groupWorkdir,
        prompt: "draw a small orange cat",
        model: "image-01",
        aspectRatio: "1:1",
      },
      (async (input, init) => {
        expect(String(input)).toBe(MINIMAX_IMAGE_API_URL);
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({
          Authorization: "Bearer minimax-test-key",
          "Content-Type": "application/json",
        });

        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          model: "image-01",
          prompt: "draw a small orange cat",
          aspect_ratio: "1:1",
          response_format: "base64",
          n: 1,
          prompt_optimizer: false,
          aigc_watermark: false,
        });

        return Response.json({
          base_resp: {
            status_code: 0,
            status_msg: "success",
          },
          data: {
            image_base64: [imageBytes.toString("base64")],
          },
        });
      }) as typeof fetch,
    );

    expect(artifact.model).toBe("image-01");
    expect(artifact.aspectRatio).toBe("1:1");
    expect(artifact.prompt).toBe("draw a small orange cat");
    expect(artifact.relativeFilePath).toStartWith(".generated/images/");
    expect(artifact.relativeFilePath).toEndWith(".jpeg");
    expect(existsSync(artifact.absoluteFilePath)).toBe(true);
    expect(readFileSync(artifact.absoluteFilePath)).toEqual(imageBytes);
  });

  test("requires MINIMAX_API_KEY before making the request", async () => {
    delete process.env.MINIMAX_API_KEY;

    await expect(
      generateMiniMaxImage(
        {
          groupWorkdir: "/tmp/test-group",
          prompt: "draw a skyline",
          model: "image-01",
          aspectRatio: "1:1",
        },
        (async () => {
          throw new Error("fetch should not be called");
        }) as typeof fetch,
      ),
    ).rejects.toThrow("MINIMAX_API_KEY");
  });

  test("fails on unsupported live model aspect ratio before calling fetch", async () => {
    await expect(
      generateMiniMaxImage(
        {
          groupWorkdir: "/tmp/test-group",
          prompt: "draw a wide banner",
          model: "image-01-live",
          aspectRatio: "21:9",
        },
        (async () => {
          throw new Error("fetch should not be called");
        }) as typeof fetch,
      ),
    ).rejects.toThrow("image-01-live does not support aspect ratio 21:9");
  });

  test("surfaces HTTP-level failures from MiniMax", async () => {
    await expect(
      generateMiniMaxImage(
        {
          groupWorkdir: "/tmp/test-group",
          prompt: "draw a landscape",
          model: "image-01",
          aspectRatio: "16:9",
        },
        (async () =>
          new Response(
            JSON.stringify({
              base_resp: {
                status_code: 1001,
                status_msg: "invalid prompt",
              },
            }),
            { status: 400 },
          )) as typeof fetch,
      ),
    ).rejects.toThrow("MiniMax image generation failed: HTTP 400, invalid prompt.");
  });

  test("fails when response does not include image_base64 data", async () => {
    await expect(
      generateMiniMaxImage(
        {
          groupWorkdir: "/tmp/test-group",
          prompt: "draw a lotus flower",
          model: "image-01",
          aspectRatio: "1:1",
        },
        (async () =>
          Response.json({
            base_resp: {
              status_code: 0,
              status_msg: "success",
            },
            data: {},
          })) as typeof fetch,
      ),
    ).rejects.toThrow("did not include image_base64");
  });
});
