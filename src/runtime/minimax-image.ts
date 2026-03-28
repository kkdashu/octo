import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const MINIMAX_IMAGE_API_URL = "https://api.minimaxi.com/v1/image_generation";
export const MINIMAX_IMAGE_MODELS = ["image-01", "image-01-live"] as const;
export const MINIMAX_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "4:3",
  "3:2",
  "2:3",
  "3:4",
  "9:16",
  "21:9",
] as const;

export type MiniMaxImageModel = (typeof MINIMAX_IMAGE_MODELS)[number];
export type MiniMaxAspectRatio = (typeof MINIMAX_IMAGE_ASPECT_RATIOS)[number];

export interface GenerateMiniMaxImageParams {
  groupWorkdir: string;
  prompt: string;
  model: MiniMaxImageModel;
  aspectRatio: MiniMaxAspectRatio;
}

export interface GeneratedImageArtifact {
  model: MiniMaxImageModel;
  aspectRatio: MiniMaxAspectRatio;
  prompt: string;
  relativeFilePath: string;
  absoluteFilePath: string;
}

type FetchLike = typeof fetch;

type MiniMaxImageResponse = {
  data?: {
    image_base64?: string[] | string;
  };
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
};

function requireMiniMaxApiKey(): string {
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Environment variable MINIMAX_API_KEY is required for MiniMax image generation.");
  }
  return apiKey;
}

function isMiniMaxImageModel(value: string): value is MiniMaxImageModel {
  return (MINIMAX_IMAGE_MODELS as readonly string[]).includes(value);
}

function isMiniMaxAspectRatio(value: string): value is MiniMaxAspectRatio {
  return (MINIMAX_IMAGE_ASPECT_RATIOS as readonly string[]).includes(value);
}

function validateParams(params: GenerateMiniMaxImageParams): void {
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required for MiniMax image generation.");
  }

  if (!isMiniMaxImageModel(params.model)) {
    throw new Error(`Unsupported MiniMax image model: ${params.model}`);
  }

  if (!isMiniMaxAspectRatio(params.aspectRatio)) {
    throw new Error(`Unsupported MiniMax aspect ratio: ${params.aspectRatio}`);
  }

  if (params.model === "image-01-live" && params.aspectRatio === "21:9") {
    throw new Error("MiniMax model image-01-live does not support aspect ratio 21:9.");
  }
}

async function parseMiniMaxImageResponse(response: Response): Promise<MiniMaxImageResponse> {
  const rawBody = await response.text();
  if (!rawBody.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawBody) as MiniMaxImageResponse;
  } catch {
    throw new Error(
      `MiniMax image generation returned invalid JSON (HTTP ${response.status}).`,
    );
  }
}

function extractImageBase64(payload: MiniMaxImageResponse): string {
  const imageBase64 = payload.data?.image_base64;
  const firstImage = Array.isArray(imageBase64) ? imageBase64[0] : imageBase64;

  if (typeof firstImage !== "string" || !firstImage.trim()) {
    throw new Error("MiniMax image generation response did not include image_base64 data.");
  }

  return firstImage.includes(",") ? firstImage.slice(firstImage.indexOf(",") + 1) : firstImage;
}

function decodeImageBase64(imageBase64: string): Buffer {
  const bytes = Buffer.from(imageBase64, "base64");
  if (bytes.length === 0) {
    throw new Error("Failed to decode MiniMax image_base64 payload.");
  }
  return bytes;
}

export async function generateMiniMaxImage(
  params: GenerateMiniMaxImageParams,
  fetchLike: FetchLike = fetch,
): Promise<GeneratedImageArtifact> {
  validateParams(params);

  const apiKey = requireMiniMaxApiKey();
  const response = await fetchLike(MINIMAX_IMAGE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt.trim(),
      aspect_ratio: params.aspectRatio,
      response_format: "base64",
      n: 1,
      prompt_optimizer: false,
      aigc_watermark: false,
    }),
  });

  const payload = await parseMiniMaxImageResponse(response);
  const statusCode = payload.base_resp?.status_code;
  const statusMessage = payload.base_resp?.status_msg?.trim();

  if (!response.ok) {
    throw new Error(
      `MiniMax image generation failed: HTTP ${response.status}${statusMessage ? `, ${statusMessage}` : ""}.`,
    );
  }

  if (typeof statusCode === "number" && statusCode !== 0) {
    throw new Error(
      `MiniMax image generation failed: code=${statusCode}${statusMessage ? `, msg=${statusMessage}` : ""}.`,
    );
  }

  const imageBase64 = extractImageBase64(payload);
  const imageBuffer = decodeImageBase64(imageBase64);

  const outputDir = join(params.groupWorkdir, ".generated", "images");
  mkdirSync(outputDir, { recursive: true });

  const fileName = `${Date.now()}-${crypto.randomUUID()}.jpeg`;
  const absoluteFilePath = join(outputDir, fileName);
  writeFileSync(absoluteFilePath, imageBuffer);

  return {
    model: params.model,
    aspectRatio: params.aspectRatio,
    prompt: params.prompt.trim(),
    relativeFilePath: relative(params.groupWorkdir, absoluteFilePath),
    absoluteFilePath,
  };
}
