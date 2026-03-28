# Anthropic 日志代理原始透传修复方案

## 问题说明

当前 `src/runtime/anthropic-logging-proxy.ts` 已经能记录直连 Anthropic 兼容 provider 的完整模型日志，但它在“转发上游响应”时并不是真正的原始透传。

现状的关键行为：

1. 代理先通过 `fetch(targetUrl, ...)` 请求上游。
2. 对非流式响应，调用 `await upstreamResponse.text()` 读取完整响应体。
3. 然后把 `upstreamResponse.headers` 原样写给下游，再用 `res.end(rawResponseBody)` 回写正文。
4. 对流式响应，调用 `upstreamResponse.body.getReader()` 逐段读取，再把读取到的 chunk `res.write(value)` 给下游。

这会带来一个关键问题：

- 在运行时自动解压响应体的情况下，代理拿到的 `text()` / `ReadableStream` 内容已经不是“上游原始字节流”。
- 但代理仍然把上游的 `content-encoding: br/gzip/...` 头原样返回给下游。
- 于是下游看到的是“已经被代理解压过的正文 + 仍然声明自己是压缩过的响应头”，HTTP 语义被破坏。

这正好解释了刚才 MiniMax 链路上的报错：

- model 日志显示 MiniMax 多次返回 `HTTP 200`，响应体本身也是完整的 Anthropic 兼容 JSON。
- 应用日志却持续出现 `api_retry`，最终 Claude SDK 抛出 `API Error: Unable to connect to API (InvalidHTTPResponse)`。
- 因此问题更像是代理破坏了 HTTP 响应传输语义，而不是 MiniMax 返回了坏 JSON。

本次修复的目标非常明确：

1. `AnthropicLoggingProxyManager` 必须成为“原始字节流透传代理”。
2. 模型日志仍然要完整记录请求、响应和流式 chunk。
3. 日志记录必须走旁路采集，不能通过“读出来再重发”来实现。
4. 不改变现有普通应用日志。
5. 不改变请求/响应的业务内容，不补字段，不重写 body。

本次修复的非目标：

- 不改 `OpenAIProxyManager` 的协议转换逻辑。
- 不改 `src/logger.ts`。
- 不改 group 日志目录结构。
- 不对请求/响应 body 做裁剪或脱敏（header 脱敏逻辑保持现状）。

## 对现有项目的影响

### 受影响的文件

- `src/runtime/anthropic-logging-proxy.ts`
- `tests/model-logging.test.ts`

### 可能复用、但原则上不需要修改的文件

- `src/runtime/model-logger.ts`
- `src/providers/claude.ts`
- `src/index.ts`

### 行为影响

#### 1. 代理语义从“读取后重发”改为“原始字节透传”

修复后，Anthropic 日志代理的链路应为：

```text
Claude SDK
  -> 本地 Anthropic logging proxy
    -> 原样转发到真实 Anthropic 兼容上游
    -> 上游原始状态码 / headers / body 字节流直通回 Claude SDK
```

与现在最大的差异是：

- 代理不再使用 `fetch().text()` 或 `getReader()` 作为对外回包的来源。
- 返回给 Claude SDK 的内容必须直接来自上游 socket / `IncomingMessage` 原始字节流。

#### 2. 日志采集将变成旁路观察

修复后日志仍然要保留：

- `sdk_request`
- `upstream_request`
- `upstream_response`
- `upstream_stream_chunk`
- `error`

但日志采集不能建立在“消费主响应流”基础上，而应建立在“旁路复制/观察同一份原始字节流”基础上。

#### 3. 压缩响应将不再被代理破坏

对于 `content-encoding: br`、`gzip`、`deflate` 等场景：

- 下游收到的 headers 与 body 必须匹配。
- 如果上游返回压缩字节流，下游就必须收到压缩字节流。
- 代理只允许为了日志目的在旁路进行解码，不能把解码后的结果回写给主响应。

### 风险与约束

- 如果仍然使用 `fetch` 读取上游响应，很难保证拿到的是未解压的原始字节流，因此实现应切到低层 `http` / `https` 请求。
- 为了保持“不要改任何内容”，请求体也不应以“解析 JSON 后重新序列化”的方式发给上游；应尽量保留原始字节。
- 流式 SSE 日志仍需保留 chunk 记录，因此旁路日志采集必须兼容流式读取。
- 非流式压缩响应如果要写入可读日志，需要旁路解压，仅用于日志，不得影响真实回包。

## 实现方案

### 方案总览

将 `AnthropicLoggingProxyManager` 的上游转发从 `fetch` 改为基于 Node `http` / `https` 的低层代理：

```text
IncomingMessage(req)
  -> 读取原始请求字节（仅用于鉴权、日志和向上游发送同一份字节）
  -> http/https.request(...)
  -> 获得上游 IncomingMessage(upstreamRes)
  -> writeHead(statusCode, upstream raw headers)
  -> upstreamRes 原始字节流直接 pipe 到下游 res
  -> 同时旁路观察 upstreamRes，用于模型日志
```

这样可以同时满足两个目标：

1. 对下游是原始字节透传
2. 对日志系统可以继续记录完整内容

### 一、请求转发改为原始字节发送

当前 `readRequestBody()` 返回字符串，再交给 `fetch`。这虽然能工作，但语义上已经不是“完全保留原始请求字节”。

修复后建议：

1. 新增 `readRequestBodyBuffer(req): Promise<Buffer>`，直接保留请求原始字节。
2. 从同一个 `Buffer` 中解析 JSON，仅用于日志：
   - `const requestBodyRaw = bodyBuffer.toString("utf-8")`
   - `const parsedRequestBody = tryParseJSON(requestBodyRaw)`
3. 向上游发送时使用同一个 `Buffer`，不做二次 `JSON.stringify`。

示意代码：

```ts
const bodyBuffer = await readRequestBodyBuffer(req);
const requestBodyRaw = bodyBuffer.toString("utf-8");
const parsedRequestBody = tryParseJSON(requestBodyRaw);

upstreamReq.write(bodyBuffer);
upstreamReq.end();
```

这保证了：

- 日志仍能看到完整 JSON 请求体
- 上游收到的是代理收到的同一份请求字节，而不是重新序列化后的 body

### 二、上游响应改为原始 headers + 原始字节流直通

修复的核心点在这里。

当前实现的问题点：

```ts
const rawResponseBody = await upstreamResponse.text();
res.writeHead(upstreamResponse.status, responseHeaders);
res.end(rawResponseBody);
```

修复后应改为：

1. 使用 `http.request` / `https.request` 获取 `IncomingMessage`。
2. 将上游 `statusCode` 和原始响应头直接写给下游。
3. 直接把 `upstreamRes` 的原始字节流 pipe 给 `res`。

示意代码：

```ts
res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.rawHeaders);
upstreamRes.pipe(res);
```

关键设计决策：

- 优先使用 `rawHeaders`，避免在 header 名大小写、重复 header、压缩相关 header 上再做一层对象重建。
- 主回包路径不再调用 `text()`、`json()`、`arrayBuffer()`、`getReader()` 等会消费并重组响应体的方法。

### 三、日志记录改为旁路采集

修复后主响应流不能再被日志系统消费，因此需要旁路采集。

#### 非流式响应

对于 `application/json` 等非流式响应：

1. 上游原始字节照常 pipe 到下游。
2. 旁路累计原始 `Buffer[]`。
3. 响应结束后，按 `content-encoding` 仅在内存中解码一份日志副本。
4. 将解码后的文本尝试 `JSON.parse`，写入 `upstream_response`。

示意代码：

```ts
const rawChunks: Buffer[] = [];
upstreamRes.on("data", (chunk) => rawChunks.push(Buffer.from(chunk)));
upstreamRes.on("end", async () => {
  const rawBody = Buffer.concat(rawChunks);
  const decoded = await decodeForLogging(rawBody, upstreamRes.headers["content-encoding"]);
  const parsed = tryParseJSON(decoded);
  writeModelLog({ stage: "upstream_response", body: parsed, ... });
});
```

注意：

- `decoded` 只用于日志。
- 真正返回给 Claude SDK 的仍然是 `rawBody` 对应的原始字节流。

#### 流式响应

对于 `text/event-stream`：

1. 主路径仍然是 `upstreamRes.pipe(res)`。
2. 旁路监听原始 chunk。
3. 若无压缩，直接按文本 decoder 累计并记录每个 chunk。
4. 若未来出现压缩 SSE，则在旁路加一个解压 transform，仅供日志使用。

这里的原则是：

- `upstream_stream_chunk` 记录的是“日志视角下可读的文本 chunk”
- 下游实际收到的仍然是上游原始 chunk

### 四、补充旁路解码辅助函数

建议在 `src/runtime/anthropic-logging-proxy.ts` 内新增小型辅助函数，不扩散到全局：

- `createUpstreamRequest(targetUrl, method, headers)`
- `copyRawResponseHeaders(upstreamRes)`
- `decodeBufferForLogging(buffer, contentEncoding)`
- `isStreamingResponse(contentType, requestStreamFlag)`

其中 `decodeBufferForLogging` 需支持：

- `br`
- `gzip`
- `deflate`
- 空 / `identity`

示意代码：

```ts
async function decodeBufferForLogging(
  raw: Buffer,
  contentEncoding?: string,
): Promise<string> {
  switch ((contentEncoding ?? "").toLowerCase()) {
    case "br":
      return brotliDecompressSync(raw).toString("utf-8");
    case "gzip":
      return gunzipSync(raw).toString("utf-8");
    case "deflate":
      return inflateSync(raw).toString("utf-8");
    default:
      return raw.toString("utf-8");
  }
}
```

### 五、错误处理保持现有语义，但避免破坏主流

需要保留当前错误行为：

- 请求体读取失败 -> `400 invalid_request_error`
- 上游连接失败 -> `502 api_error`
- 旁路日志写入失败 -> 吞掉，不影响代理主路径

新增约束：

- 即便日志侧解码失败，也不能影响真实响应透传。
- 如果压缩格式未知或解码失败，日志体可以退化为原始字节转 UTF-8 后的字符串，或在 `meta` 里标记 `decodeError`；但不能影响下游回包。

### 六、测试方案

本次修复至少补两类测试，全部放在 `tests/model-logging.test.ts`。

#### 1. 非流式 Brotli 压缩响应保持原样透传

新增测试场景：

- 上游服务返回：
  - `content-type: application/json`
  - `content-encoding: br`
  - `body: brotliCompressSync(JSON.stringify(payload))`
- 通过本地 Anthropic logging proxy 访问该上游。
- 使用低层 `http.request` 调用本地代理，读取代理回包的原始 bytes。

断言：

- 下游收到的 `content-encoding` 仍是 `br`
- 下游收到的原始 bytes 与上游发送 bytes 完全一致
- 手动 Brotli 解压后等于原始 JSON
- model 日志中的 `upstream_response.body` 仍是已解析的 JSON 对象

这条测试直接验证：

- 代理没有再把压缩响应“解开后重发”
- 日志侧仍保留了可读内容

#### 2. 现有 SSE chunk 日志能力保持不退化

保留并更新现有流式测试，确保：

- `text/event-stream` 仍能被正常返回给下游
- `upstream_stream_chunk` 仍然存在
- 最终仍会写 `upstream_response`

如有必要，可额外增加一个断言：

- 代理对流式返回不再手动重组 chunk 顺序

### 七、明确不做的实现

以下方案本次不采用：

- 不通过删除 `content-encoding` 头来“修补”现有 `fetch().text()` 方案
  - 这仍然是在改响应，不符合“proxy 只是代理”的要求
- 不通过给上游强制添加 `accept-encoding: identity` 来绕开压缩
  - 这会改请求，不符合“不要改任何内容”
- 不把完整原始压缩字节也落到日志里
  - 当前需求是可读的完整模型交互日志，不是二进制抓包

## Todo List

- [x] 将 `anthropic-logging-proxy` 的上游请求实现从 `fetch` 改为 `http` / `https` 原始请求
- [x] 将请求体读取从字符串改为原始 `Buffer`，日志解析与真实转发共用同一份字节
- [x] 将上游响应转发改为原始 status / raw headers / raw body 直通
- [x] 为非流式响应增加旁路原始字节累计与仅日志用途的解码逻辑
- [x] 保持流式响应的旁路 chunk 日志记录，不影响真实回包
- [x] 保持现有错误处理语义，确保日志侧失败不影响代理主路径
- [x] 在 `tests/model-logging.test.ts` 新增 Brotli 压缩非流式透传测试
- [x] 运行 `bun test tests/*.test.ts` 验证新旧测试全部通过
