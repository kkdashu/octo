import { isQuestionLikeMemoryText, type MemoryGuardLevel } from "./extractor";

const FACTUAL_PROFILE_RE = /(我叫|我是|我的名字|我名字|我来自|我住在|我的职业|我有(?!\s*(?:一个|个)?问题)|我养了|我喜欢|我偏好|我习惯|\bmy\s+name\s+is\b|\bi\s+am\b|\bi['’]?m\b|\bi\s+live\s+in\b|\bi['’]?m\s+from\b|\bi\s+work\s+as\b|\bi\s+have\b|\bi\s+prefer\b|\bi\s+like\b|\bi\s+usually\b)/i;
const TRANSIENT_RE = /(今天|昨日|昨天|刚刚|刚才|本周|本月|临时|暂时|这次|当前|today|yesterday|this\s+week|this\s+month|temporary|for\s+now)/i;
const PROCEDURAL_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const REQUEST_STYLE_RE = /^(?:请|麻烦|帮我|请你|帮忙|请帮我|use|please|can you|could you|would you)/i;
const ASSISTANT_STYLE_RE = /((请|以后|后续|默认|请始终|不要再|请不要|优先|务必).*(回复|回答|语言|中文|英文|格式|风格|语气|简洁|详细|代码|命名|markdown|respond|reply|language|format|style|tone))/i;

export interface MemoryJudgeInput {
  text: string;
  isExplicit: boolean;
  guardLevel: MemoryGuardLevel;
}

export interface MemoryJudgeResult {
  accepted: boolean;
  score: number;
  reason: string;
}

function thresholdByGuardLevel(isExplicit: boolean, guardLevel: MemoryGuardLevel): number {
  if (isExplicit) {
    if (guardLevel === "strict") return 0.7;
    if (guardLevel === "relaxed") return 0.52;
    return 0.6;
  }
  if (guardLevel === "strict") return 0.8;
  if (guardLevel === "relaxed") return 0.62;
  return 0.72;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scoreMemoryText(text: string): { score: number; reason: string } {
  const normalized = normalizeText(text);
  if (!normalized) return { score: 0, reason: "empty" };
  if (isQuestionLikeMemoryText(normalized)) {
    return { score: 0.05, reason: "question-like" };
  }

  let score = 0.5;
  let strongestReason = "neutral";

  if (FACTUAL_PROFILE_RE.test(normalized)) {
    score += 0.28;
    strongestReason = "factual-personal";
  }
  if (ASSISTANT_STYLE_RE.test(normalized)) {
    score += 0.1;
    strongestReason = strongestReason === "neutral" ? "assistant-preference" : strongestReason;
  }
  if (REQUEST_STYLE_RE.test(normalized)) {
    score -= 0.14;
    if (strongestReason === "neutral") strongestReason = "request-like";
  }
  if (TRANSIENT_RE.test(normalized)) {
    score -= 0.18;
    if (strongestReason === "neutral") strongestReason = "transient-like";
  }
  if (PROCEDURAL_RE.test(normalized)) {
    score -= 0.4;
    strongestReason = "procedural-like";
  }
  if (normalized.length < 6) {
    score -= 0.2;
  } else if (normalized.length <= 120) {
    score += 0.06;
  } else if (normalized.length > 240) {
    score -= 0.08;
  }

  return { score: clamp01(score), reason: strongestReason };
}

export function judgeMemoryCandidate(input: MemoryJudgeInput): MemoryJudgeResult {
  const { score, reason } = scoreMemoryText(input.text);
  const threshold = thresholdByGuardLevel(input.isExplicit, input.guardLevel);
  return {
    accepted: score >= threshold,
    score,
    reason,
  };
}
