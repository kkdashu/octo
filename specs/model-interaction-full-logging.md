# 模型交互完整日志方案

## 问题说明

当前项目虽然已经有通用 `logger`，但模型调用链路里的关键数据并没有被完整记录下来：

- `ClaudeProvider` 只记录了 session 级别摘要，例如 profile、model、是否 resume。
- `OpenAIProxyManager` 负责 Anthropic -> OpenAI / Responses 转换并转发请求，但没有把“原始 Anthropic 请求体”“转换后的上游请求体”“上游响应体/流式 chunk”完整落盘。
- 对 `kimi`、`kimi-cli`、`minimax`、`claude` 这类 **直连 Anthropic 兼容 endpoint** 的 profile，当前更拿不到真实 HTTP 请求体，因为 `@anthropic-ai/claude-agent-sdk` 是通过本地 `claude-code` 子进程发请求，不是在当前 Node 进程里直接 `fetch`。

这导致出现模型兼容性问题时，我们现在只能看到：

- 用了哪个 profile
- session 有没有启动成功
- agent 最终有没有报错

但看不到真正决定问题的上游交互细节，例如：

- 发到了哪个真实 URL
- 请求 headers 是什么（需脱敏）
- 请求 body 到底长什么样
- 如果走了兼容转换，Anthropic 请求体被改写成了什么 OpenAI / Responses payload
- 上游返回了什么 JSON，或者流式 SSE 究竟吐了哪些 chunk

这次需求要解决的是“模型交互完整日志”，并且要覆盖真实的 provider endpoint。这里需要把你提到的 URL 再明确一下：

- `kimi` 实际上游是 `https://api.moonshot.cn/anthropic`
- `kimi-cli` 实际上游是 `https://api.kimi.com/coding`
- `minimax` 实际上游是 `https://api.minimaxi.com/anthropic`

也就是说，如果你要查 Moonshot/Kimi 请求，完整日志里应出现 `https://api.moonshot.cn/anthropic` 或 `https://api.kimi.com/coding`；如果查 MiniMax，请求目标应是 `https://api.minimaxi.com/anthropic`。

本次需求的目标是：

1. 让模型调用的真实 HTTP 交互可追溯
2. 让直连 Anthropic 兼容 provider 也能拿到完整请求参数
3. 让 OpenAI 兼容代理链路也能看到转换前后 payload
4. 让日志可按一次请求关联，不是散落在文本日志里的碎片
5. 不改变现有应用日志格式和写入逻辑，模型日志走独立实现
6. 模型日志必须按 group 拆分，避免所有群组日志混在一起

本次需求的非目标：

- 不重构或替换现有 `src/logger.ts`
- 不改变各 profile 的实际上游 provider 选择
- 不修改数据库 schema
- 不引入外部日志系统或 SaaS
- 不在响应内容上做语义摘要，重点是保留原始交互数据

## 对现有项目的影响

### 受影响的模块

- `src/providers/claude.ts`
- `src/runtime/openai-proxy.ts`
- `src/runtime/types.ts`
- `src/index.ts`
- `env.example`
- `README.md` 或 `docs/octo.md`（至少一处需要补充日志查看说明）
- `tests/runtime.test.ts`
- 可能新增：
  - `src/runtime/model-logger.ts`
  - `src/runtime/anthropic-logging-proxy.ts`
  - `tests/model-logging.test.ts`

### 运行时影响

#### 1. Anthropic 直连 profile 将新增一层本地日志代理

目前：

```text
Claude Agent SDK 子进程
  -> https://api.moonshot.cn/anthropic
```

改造后：

```text
Claude Agent SDK 子进程
  -> 本地 anthropic-logging-proxy
    -> 真实 Anthropic 兼容上游
```

这样做不是为了改协议，而是为了让当前 Node 进程能截获完整 HTTP 请求体和响应流。

#### 2. OpenAI 兼容 profile 保持现有 proxy 架构，但补齐日志

目前：

```text
Claude Agent SDK
  -> local openai-proxy (Anthropic 入站)
    -> OpenAI / Moonshot / 其他兼容上游
```

这条链路已经能在当前进程里拿到请求，只是没有把关键阶段完整记录出来。本次会在现有 `openai-proxy` 上补：

- SDK 发给代理的原始 Anthropic body
- 转换后的 OpenAI / Responses body
- 真实上游 URL
- 上游响应 JSON 或 SSE chunk

#### 3. 日志量会显著增加

这是需求本身决定的结果。为了避免把完整 payload 直接刷到 stdout，本次方案不建议把完整 body 打到现有文本日志主文件里，而是单独写入结构化 JSONL 文件。

#### 4. 现有 log 保持不变

这次不改 `src/logger.ts` 的输出格式、目录结构和主日志写入行为。

模型日志必须通过新代码独立写入，原则是：

- 现有 `octo-YYYY-MM-DD.log` 继续保持当前行为
- 新增独立的模型日志目录和文件轮转逻辑
- 对现有运行时代码的改动尽量限制在“调用新模型日志模块”这一层，不扩散改造现有 logger

### 风险与约束

- 完整请求/响应日志天然包含 prompt、tool 输入输出、系统提示词等敏感数据，必须脱敏 header 里的密钥，但 body 不应再做内容裁剪，否则不满足“完整日志”目标。
- Anthropic 直连日志必须通过本地代理实现；仅靠 SDK hooks 或现有 logger 无法拿到直连 HTTP body。
- 流式响应如果只记录最终聚合文本，会丢失真实 chunk 边界，不满足“完整交互”要求；因此需要记录 chunk 级别事件。
- 日志文件会变大，需要按天分文件，避免单文件无限增长。

## 实现方案

### 方案总览

本次实现分成两条链路，但产出统一的“模型交互日志事件”：

```text
Anthropic 直连 profile:
Claude SDK -> local anthropic logging proxy -> upstream anthropic-compatible API

OpenAI 兼容 profile:
Claude SDK -> local openai proxy -> upstream openai/responses API
```

两条链路最终都写入统一规则的 JSONL 日志目录，但必须先按 group 拆分：

```text
$LOG_DIR/model/<group-folder>/
```

命名规则建议为：

```text
$LOG_DIR/model/<group-folder>/octo-model-YYYY-MM-DD.jsonl
$LOG_DIR/model/<group-folder>/octo-model-YYYY-MM-DD.1.jsonl
$LOG_DIR/model/<group-folder>/octo-model-YYYY-MM-DD.2.jsonl
```

规则如下：

1. 先按 `groupFolder` 拆目录
2. 每个 group 目录内按自然日切分
3. 单个文件写入前如果已达到或超过 `80MB`，则自动切到该 group 当日下一个序号文件
4. 每个 group 的轮转彼此独立，互不影响
5. 每一行仍是一条结构化 JSONL 事件，可按 `requestId` 关联一整次模型交互
6. 不与现有 `$LOG_DIR/octo-YYYY-MM-DD.log` 混写

按 group 拆分后的直接收益是：

- 查某个群的问题时，不需要先从全局日志里筛 group
- 同一天多个群并发调用模型时，日志可读性不会崩掉
- 某个高频群写爆 `80MB` 时，不会影响其他群的日志切分

### 一、增加独立的模型交互日志写入器

建议新增 `src/runtime/model-logger.ts`，专门负责写结构化 JSONL，而不是复用 `src/logger.ts` 的纯文本格式。

原因：

1. 现有 `logger.ts` 面向人读，适合摘要，不适合长 body 和流式 chunk。
2. 完整 payload 如果直接混进 `octo-YYYY-MM-DD.log`，会把普通运行日志污染得很难看。
3. JSONL 更适合后续按 `requestId`、`profileKey`、`url` 检索。
4. 你已经明确要求“不改变现在的 log”，因此模型日志必须走新模块。

建议数据结构：

```ts
export interface ModelInteractionLogEntry {
  ts: string;
  requestId: string;
  routeType: "anthropic_direct" | "openai_proxy";
  stage:
    | "sdk_request"
    | "upstream_request"
    | "upstream_response"
    | "upstream_stream_chunk"
    | "proxy_response"
    | "error";
  profileKey: string;
  provider?: string;
  model?: string;
  groupFolder: string;
  url: string;
  method: string;
  status?: number;
  stream: boolean;
  headers?: Record<string, unknown>;
  body?: unknown;
  meta?: Record<string, unknown>;
}
```

配套工具函数：

- `writeModelLog(entry)`
- `redactHeaders(headers)`
- `toSerializableBody(value)`
- `resolveModelLogFilePath(now)`
- `rotateModelLogFileIfNeeded(path)`

脱敏规则至少包括：

- `authorization`
- `x-api-key`
- `anthropic-api-key`
- 其他命名中包含 `token`、`secret`、`key` 的 header

脱敏策略建议保留前缀和后四位，例如：

```ts
"Bearer sk-***abcd"
```

但请求/响应 body 不做裁剪和脱敏，确保满足“完整请求参数”目标。

#### 文件目录与轮转策略

模型日志目录固定为：

```text
${LOG_DIR}/model/${groupFolder}
```

建议 `model-logger` 内部自己处理目录创建，不依赖现有 `logger.ts` 的初始化逻辑。

轮转策略：

1. 先根据 `groupFolder` 确定日志目录，例如 `${LOG_DIR}/model/main`
2. 再根据当前日期确定当天文件前缀，例如 `octo-model-2026-03-28`
3. 默认写入 `${LOG_DIR}/model/<group-folder>/octo-model-2026-03-28.jsonl`
4. 如果该文件大小已达到或超过 `80 * 1024 * 1024`，则尝试写入：
   - `octo-model-2026-03-28.1.jsonl`
   - `octo-model-2026-03-28.2.jsonl`
   - 依次递增
5. 新的一天从无后缀文件重新开始
6. 每个 group 独立判断是否需要切分

伪代码示意：

```ts
function resolveCurrentModelLogFile(groupFolder: string, now: Date): string {
  const baseName = `octo-model-${formatDate(now)}`;
  const groupDir = join(LOG_DIR, "model", groupFolder);
  const primary = join(groupDir, `${baseName}.jsonl`);
  if (size(primary) < MAX_BYTES) return primary;

  for (let i = 1; ; i += 1) {
    const nextPath = join(groupDir, `${baseName}.${i}.jsonl`);
    if (size(nextPath) < MAX_BYTES) return nextPath;
  }
}
```

`groupFolder` 建议直接使用项目里现有的 group folder 名称，因为它已经是当前运行时最稳定的群标识。只有在极端场景下拿不到 `groupFolder` 时，才回退到：

```text
${LOG_DIR}/model/_unknown/
```

### 二、为 Anthropic 直连 profile 增加本地日志代理

建议新增 `src/runtime/anthropic-logging-proxy.ts`，职责只有两个：

1. 接收 Claude SDK 子进程发来的 Anthropic 兼容请求
2. 原样转发到真实上游，同时记录完整请求/响应

#### 为什么必须单独加这个代理

因为 `@anthropic-ai/claude-agent-sdk` 当前是通过 `claude-code` 子进程发请求，调用栈不在当前 Bun 进程里。也就是说：

- 不能靠 monkey patch 当前进程的 `fetch`
- 不能靠现有 `logger`
- SDK hooks 主要针对 tool / session 事件，也拿不到原始 HTTP body

所以只能把 `ANTHROPIC_BASE_URL` 改成指向本地代理。

#### 代理设计

接口风格尽量和现有 `OpenAIProxyManager` 一致：

```ts
export class AnthropicLoggingProxyManager {
  async start(): Promise<void> {}
  acquire(upstream: ResolvedAgentProfile, context: { groupFolder: string }): ProxyRouteHandle {}
}
```

本地 route 形式建议沿用现有模式：

```text
http://127.0.0.1:<port>/proxy/<routeId>
```

代理转发逻辑：

1. 读取 SDK 发来的请求体
2. 生成 `requestId`
3. 写入 `sdk_request` 日志，URL 记录为真实上游目标 URL
4. 用真实 `Authorization` 头转发到 `upstream.baseUrl + 原始 path/query`
5. 如果是非流式响应，完整读取 body，写入 `upstream_response`
6. 如果是流式响应，按 chunk 写入 `upstream_stream_chunk`
7. 将上游响应原样回传给 Claude SDK

Anthropic 直连路径不做协议转换，因此请求 body 应与 SDK 发起内容保持一致。

### 三、补齐 OpenAI 兼容代理链路的完整日志

`src/runtime/openai-proxy.ts` 已经是当前进程里的入口，所以不需要新增代理层，只需要在关键阶段补日志。

建议记录以下阶段：

#### 1. SDK 入站 Anthropic 请求

也就是 `readRequestBody(req)` 读出来并 JSON.parse 成功后的内容：

```ts
writeModelLog({
  stage: "sdk_request",
  routeType: "openai_proxy",
  body: parsedRequestBody,
  ...
});
```

#### 2. 转换后的 OpenAI / Responses 请求

在这几个处理完成后记录：

- `anthropicToOpenAI(parsedRequestBody)`
- `filterOpenAIToolsForProvider(...)`
- `remapMessageRolesForMiniMax(...)`
- `hydrateOpenAIRequestToolCalls(...)`
- `convertChatCompletionsRequestToResponsesRequest(...)`（如适用）

也就是要记录“最终真正发给上游”的 payload，而不是只记录中间态。

```ts
writeModelLog({
  stage: "upstream_request",
  routeType: "openai_proxy",
  url: currentTargetURL,
  body: upstreamRequest,
  meta: {
    upstreamApiType,
    retryIndex,
  },
  ...
});
```

#### 3. 上游响应

非流式：

- 记录完整 JSON body
- 如果是 `responses` 再转 `openai` 再转 `anthropic`，可额外记录 `proxy_response`

流式：

- 记录原始 SSE packet 或 chunk 文本
- 每条 chunk 带 `chunkIndex`
- 流结束后再补一条 `upstream_response` / `proxy_response` 结束事件，标记 `done=true`

这样后续如果用户要查：

- Moonshot 的 OpenAI 兼容请求
- GPT-5.4 的 Responses payload
- MiniMax 特殊 role remap 后的最终请求

都能直接从日志文件里看出来。

### 四、在 `ClaudeProvider` 中按 profile 分流代理

当前逻辑只有：

```ts
const proxyRoute =
  config.profile.apiFormat === "openai"
    ? this.proxyManager.acquire(config.profile)
    : undefined;
```

这不够，因为 Anthropic 直连 profile 也需要被日志代理接管。

建议改成：

```ts
const proxyRoute =
  config.profile.apiFormat === "openai"
    ? this.openAIProxyManager.acquire(config.profile, context)
    : this.anthropicLoggingProxyManager.acquire(config.profile, context);
```

这里的 `context` 至少应包含：

- `groupFolder`
- `profileKey`
- `provider`

让代理落日志时不需要再回头猜上下文。

如果不想让 `claude` 官方 Anthropic 线路也经过日志代理，可以在 spec 审批后把范围收窄成：

- 仅 `provider === "moonshot" | "minimax" | "anthropic"` 时代理

但我更倾向于统一处理所有 `apiFormat === "anthropic"` 的 profile，行为更一致，也更容易维护。

### 五、环境变量与文件约定

建议在 `env.example` 中补充至少一条说明，不一定新增开关，但要明确日志文件位置：

```bash
# Structured model interaction logs
# Written to: ${LOG_DIR}/model/<group-folder>/octo-model-YYYY-MM-DD(.N).jsonl
```

本次我不建议额外引入 `MODEL_LOG_ENABLED=false` 这类开关，理由是你的需求就是“加完整日志”，而且项目当前已经默认记录详细应用日志。再额外加一个默认关闭的开关，会让功能看起来实现了、实际上默认又不可用。

如果后续你希望把完整模型日志改成可选功能，再在下一次需求里加开关更稳妥。

### 六、对现有代码的改动边界

这次实现要尽量让现有代码改动保持小而明确：

- `src/logger.ts` 不改
- `src/providers/claude.ts` 只增加新模型日志代理的接线
- `src/runtime/openai-proxy.ts` 只增加日志采集点，不重构核心转换逻辑
- 主要新能力放在新增文件里实现，例如：
  - `src/runtime/model-logger.ts`
  - `src/runtime/anthropic-logging-proxy.ts`

也就是说，旧代码主要负责“调用新组件”，而不是把现有 logger 或 proxy 大面积改造。

### 七、测试方案

建议新增独立测试文件 `tests/model-logging.test.ts`，避免把 `tests/runtime.test.ts` 继续堆大。

至少覆盖以下场景：

#### 1. 模型日志写入器

- 会写入 `${LOG_DIR}/model/octo-model-YYYY-MM-DD.jsonl`
- 会写入 `${LOG_DIR}/model/<group-folder>/octo-model-YYYY-MM-DD.jsonl`
- 超过 `80MB` 时会自动切到该 group 同日续号文件
- 不同 group 会写入各自独立目录
- 会把 header 中的 token / key 脱敏
- body 原样保留

#### 2. Anthropic 直连日志代理

启动一个本地假上游 HTTP server，返回固定 JSON 或 SSE，断言：

- 代理成功转发请求
- 日志里有 `sdk_request`
- 日志里有 `upstream_request`
- 非流式时有完整 `upstream_response`
- 流式时有多个 `upstream_stream_chunk`

#### 3. OpenAI 兼容代理日志

同样用假上游 server，断言：

- 入站 Anthropic body 被记录
- 最终 `upstreamRequest` 被记录
- 如果走 `responses`，日志里记录的是发往 `/v1/responses` 的真实 payload

#### 4. 关键 URL 断言

补一组 profile 解析 + 代理日志断言，至少覆盖：

- `kimi` -> `https://api.moonshot.cn/anthropic`
- `kimi-cli` -> `https://api.kimi.com/coding`
- `minimax` -> `https://api.minimaxi.com/anthropic`

这样可以避免后续有人把日志里的目标 URL 和真实 provider 混掉。

## 文件级改动建议

### 1. `src/runtime/model-logger.ts`

新增结构化日志写入器与脱敏工具。

### 2. `src/runtime/anthropic-logging-proxy.ts`

新增 Anthropic 直连日志代理。

### 3. `src/runtime/openai-proxy.ts`

补齐请求/响应日志点，尤其是：

- `parsedRequestBody`
- `upstreamRequest`
- `upstreamResponse`
- 流式 chunk

### 4. `src/providers/claude.ts`

注入两个 proxy manager，并根据 `apiFormat` 获取 route。

### 5. `src/index.ts`

启动新的 `AnthropicLoggingProxyManager`，并注入 `ClaudeProvider`。

### 6. `env.example`

补充模型日志目录和轮转说明。

### 7. `README.md` / `docs/octo.md`

补充“模型交互完整日志”查看方式，至少写明：

- 普通运行日志位置
- 完整模型交互 JSONL 日志位置
- 如何按 `requestId` 关联
- 为什么模型日志按 group 拆目录
- 同日单文件超过 `80MB` 时如何续号切分

## 验收标准

完成后应满足以下结果：

1. 当群组使用 `kimi` 时，可以在日志中看到发往 `https://api.moonshot.cn/anthropic` 的完整请求参数。
2. 当群组使用 `kimi-cli` 时，可以在日志中看到发往 `https://api.kimi.com/coding` 的完整请求参数。
3. 当群组使用 `minimax` 时，可以在日志中看到发往 `https://api.minimaxi.com/anthropic` 的完整请求参数。
4. 当群组使用 `codex` 等 OpenAI 兼容 profile 时，可以在日志中同时看到：
   - SDK 入站 Anthropic 请求
   - 转换后的上游 OpenAI / Responses 请求
   - 上游响应
5. 日志中的认证 header 已脱敏，但 body 未裁剪。
6. 流式请求能看到 chunk 级别日志，不只是最终摘要。
7. 模型日志写入 `${LOG_DIR}/model/<group-folder>/`，不影响现有应用日志文件。
8. 不同 group 的模型日志彼此隔离，不会混写到同一个文件。
9. 模型日志按天分割，且单文件超过 `80MB` 时会自动续号切分。
10. 用户可以通过文档说明快速定位某个 group 的日志文件并检索某次请求。

## Todo List

- [x] 新增 `specs/model-interaction-full-logging.md` 并完成评审
- [x] 新增结构化模型交互日志写入器
- [x] 为 Anthropic 直连 profile 新增本地日志代理
- [x] 为 `src/runtime/openai-proxy.ts` 补齐完整请求/响应日志
- [x] 在 `src/providers/claude.ts` 中接入 Anthropic / OpenAI 两类代理
- [x] 在 `src/index.ts` 中启动并注入新的代理组件
- [x] 实现 `${LOG_DIR}/model/<group-folder>/` 目录与按 group + 按天 + 80MB 自动切分逻辑
- [x] 更新 `env.example` 中的日志说明
- [x] 更新 README 或运行文档，说明如何查看完整模型交互日志
- [x] 新增或更新测试，覆盖非流式、流式、直连 Anthropic、OpenAI 兼容代理四类场景
- [x] 运行测试并验证日志文件内容符合预期
