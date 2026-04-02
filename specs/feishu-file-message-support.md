# 飞书文件消息支持

## 问题说明

当前项目对飞书消息的支持仍有两个缺口：

1. 接收侧已经支持普通文本、富文本，以及图片消息，但仍不支持用户发送的 `file` 文件消息。
2. 发送侧已经支持 `send_message` 和 `send_image`，但 `send_message` 只能解析文本与图片，不支持在文本里声明“发送本地文件”。

现状链路如下：

- `src/channels/feishu.ts`
  - `extractIncomingContent()` 仅对 `image` 和 `post` 做特殊处理
  - `message_type = "file"` 时最终会返回 `null`
  - 文件消息会被跳过，日志表现为 `Skipping non-text or empty message`
- `src/message-parts.ts`
  - 当前只识别文本与 Markdown 图片
  - 不识别 Markdown 文件链接
- `src/channels/manager.ts`
  - `send(chatJid, text)` 只会拆成文本和图片
  - 即使 `send_message` 的文本里写了本地文件链接，也不会转成平台文件消息
- `src/tools.ts`
  - 当前已有 `send_message`
  - 但其描述里没有声明 Markdown 文件语法，也没有对应发送链路

这会导致两个直接问题：

1. 用户在飞书里上传文件给机器人时，消息会被丢弃，数据库里没有记录，也无法进入 Router 上下文。
2. agent 即使在本地生成了报告、日志、压缩包等文件，也不能通过现有 `send_message` 文本语法把文件发送回飞书。

本次需求目标是：

1. 支持接收飞书 `file` 消息，不再被通道层跳过。
2. 接收到的文件资源会被下载到本地工作区。
3. 接收侧把文件消息写成稳定的 Markdown file 语法，供 Router 与 agent 使用。
4. 发送侧不新增 `send_file` 工具，继续复用 `send_message`。
5. 当 `send_message` 文本中包含 Markdown file 链接时，系统会解析本地文件路径，并调用飞书发送文件 API。

本次明确不做的事：

- 不新增 `send_file` 工具
- 不改 `messages` 表结构
- 不新增附件表
- 不自动解析 PDF / DOC / XLS / ZIP 等文件内容
- 不扩展到 folder、audio、media、sticker 等其它非文本消息类型

## 对现有项目的影响

预计受影响文件：

- `src/channels/feishu.ts`
- `src/channels/types.ts`
- `src/channels/manager.ts`
- `src/message-parts.ts`
- `src/tools.ts`
- `tests/feishu.test.ts`
- `tests/channel-manager.test.ts`
- `tests/message-parts.test.ts`

行为变化：

1. 飞书用户发送 `file` 消息后，不再被跳过，会被下载并入库。
2. 下载后的文件会落到项目根目录下的 `media/<chatId>/...`。
3. 数据库里仍只保存字符串消息内容，但文件消息会使用 Markdown file 语法。
4. `send_message` 支持在文本里混排：
   - 普通文本
   - Markdown 图片
   - Markdown 文件链接
5. `ChannelManager.send()` 会按原顺序发送文本、图片和文件。

不变项：

- `Router` 仍然只消费数据库里的 `content TEXT`
- Provider 不新增文件附件 block；文件仍以文本形式进入 prompt
- 现有 `send_image` 工具继续保留，图片专门发送能力不变
- 现有图片接收、图片发送、图片理解预处理逻辑不变

风险点：

1. 飞书“接收文件消息”的下载不能走 `im.file.get`，因为该接口只保证下载应用自己上传的文件；用户发给机器人的文件应继续走 `im.message.resource.get`，且 `type` 必须是 `file`。
2. 文件落盘时需要保留可读文件名，但也必须做文件名清洗，避免路径穿越和非法字符。
3. Markdown file 链接不能误把普通网页链接当成附件上传，因此解析时必须只接受“无 URL scheme 的本地路径”。
4. 文件上传在 Bun + node-sdk 环境下可能遇到底层 multipart 兼容问题，因此实现上要优先选择与图片上传一致、可诊断的 `fetch + FormData + Blob` 方案。
5. 文件内容不会自动进入模型上下文，agent 只能先看到文件名和本地路径；如果后续要支持自动摘要，需要单独做第二阶段方案。

## 实现方案

本次方案继续遵循项目现有的最小侵入原则：

1. 仍然把消息主表示保持为字符串。
2. 接收文件后，下载资源并把消息内容写成 Markdown file 语法。
3. 发送文件不新增工具，而是把 Markdown file 解析并入现有 `send_message` 发送链路。

### 方案总览

接收链路：

1. 飞书推送 `im.message.receive_v1`
2. `message.message_type === "file"`
3. 解析 `message.content`，提取 `file_key`、`file_name`
4. 调用 `im.message.resource.get(..., type=file)` 下载文件
5. 文件保存到 `media/<chatId>/<messageId>-<sanitizedFileName>`
6. 入库内容写成 Markdown file 语法
7. Router 原样拼接到 prompt，agent 能看到文件名与路径

发送链路：

1. agent 调用现有 `send_message`
2. 文本中包含 Markdown 文件链接
3. `ChannelManager.send()` 解析出 file part
4. 对应 channel 调用飞书文件上传接口
5. 再调用飞书 `msg_type=file` 消息发送接口

### 1. Markdown file 语法定义

本次采用标准 Markdown 链接语法表示“发送本地文件”：

```md
[report.pdf](./report.pdf)
```

或：

```md
[构建日志](.generated/build.log)
```

识别规则：

1. 必须是标准 Markdown 链接 `[]()`
2. 链接目标必须是“本地路径”
3. 本地路径的判断规则：
   - 不允许有 URL scheme，如 `http:`, `https:`, `mailto:`
   - 不允许是纯锚点，如 `#section`
   - 允许相对路径、绝对路径、`media/...`、`.generated/...`
4. `![...](...)` 仍然只表示图片，不应被当成文件

也就是说：

- `[OpenAI](https://openai.com)` 仍然只是普通文本
- `[report.pdf](./report.pdf)` 会被识别为文件附件

### 2. 在接收侧新增文件消息识别

当前 `src/channels/feishu.ts` 的 `extractIncomingContent()` 逻辑大致如下：

```ts
if (message?.message_type === "image") {
  return this.extractImageContent(message);
}

if (message?.message_type === "post") {
  return this.extractPostContent(message);
}

return this.extractTextContent(message);
```

需要扩展为：

```ts
if (message?.message_type === "image") {
  return this.extractImageContent(message);
}

if (message?.message_type === "file") {
  return this.extractFileContent(message);
}

if (message?.message_type === "post") {
  return this.extractPostContent(message);
}

return this.extractTextContent(message);
```

建议新增以下类型与 helper：

```ts
type FeishuFileContent = {
  file_key?: unknown;
  file_name?: unknown;
};

function extractFilePayloadFromMessage(
  message: FeishuMessagePayload,
): { fileKey: string | null; fileName: string | null }
```

逻辑：

1. `JSON.parse(message.content)`
2. 读取 `file_key`
3. 读取 `file_name`
4. 两者都做 `trim()`
5. `file_key` 缺失则视为无效文件消息

### 3. 把现有 message resource 下载能力泛化为“图片 / 文件通用”

当前 `src/channels/feishu.ts` 已有一套围绕图片下载的辅助能力：

- `FeishuMessageResourceClient`
- `buildMessageResourceRequestSummary()`
- `extractMessageResourceErrorDetails()`
- `downloadIncomingImageResource()`

这套逻辑不应继续只绑定图片，建议改为通用资源下载 helper，例如：

```ts
type FeishuMessageResourceType = "image" | "file";

type FeishuMessageResourceRequestSummary = {
  message_id: string;
  file_key: string;
  type: FeishuMessageResourceType;
};

async function downloadIncomingMessageResource(
  messageResourceClient: FeishuMessageResourceClient,
  params: {
    messageId: string;
    fileKey: string;
    chatId: string;
    resourceType: FeishuMessageResourceType;
    preferredFileName?: string | null;
    rootDir?: string;
  },
): Promise<string>
```

泛化后的行为：

1. 图片仍然走原来的 `type=image`
2. 文件走新的 `type=file`
3. 统一保留飞书业务错误码与诊断提示

### 4. 文件落盘策略

图片当前落盘格式为：

```text
media/<chatId>/<messageId>.<ext>
```

文件如果沿用同样规则会丢失用户可读文件名，因此建议文件使用：

```text
media/<chatId>/<messageId>-<sanitizedFileName>
```

例如：

```text
media/oc_test/om_123456-report.pdf
media/oc_test/om_234567-build.log
```

其中 `sanitizedFileName` 需要满足：

1. 去掉路径分隔符
2. 去掉首尾空白
3. 将不安全字符替换为 `_`
4. 若结果为空，则退化为 `unnamed.bin`

建议新增 helper：

```ts
function sanitizeIncomingFileName(fileName: string | null): string
```

### 5. 接收文件消息时写成 Markdown file

数据库和 Router 当前都只处理字符串，因此接收文件后，建议直接写成 Markdown file 语法：

```md
[report.pdf](media/oc_test/om_123456-report.pdf)
```

这样有两个好处：

1. 接收侧与发送侧的文件表示统一
2. agent 如果后续想把同一个文件再次发回群里，可以直接复用这段 Markdown

下载失败时写成：

```text
[文件下载失败:file_key=file_v2_xxx,file_name=report.pdf]
```

建议 helper：

```ts
function buildMarkdownFileLink(fileName: string, filePath: string): string

function buildFileDownloadFailureText(
  fileKey: string,
  fileName: string | null,
): string
```

### 6. 新增 `extractFileContent()`

建议在 `FeishuChannel` 中新增：

```ts
private async extractFileContent(
  message: {
    message_id?: string;
    chat_id?: string;
    content?: string;
  },
): Promise<string | null>
```

建议流程：

1. 校验 `message_id` 与 `chat_id`
2. 解析 `file_key` 和 `file_name`
3. 若 `file_key` 缺失，记录 warn 并返回 `null`
4. 调用通用 `downloadIncomingMessageResource(..., resourceType: "file")`
5. 成功时返回 `buildMarkdownFileLink(...)`
6. 失败时记录结构化 error，并返回 `buildFileDownloadFailureText(...)`

核心调用形式应为：

```ts
await this.client.im.messageResource.get({
  path: {
    message_id: messageId,
    file_key: fileKey,
  },
  params: {
    type: "file",
  },
});
```

### 7. 在消息分片层新增 file part

当前 `src/message-parts.ts` 只有：

```ts
export type MessagePart =
  | { type: "text"; value: string }
  | { type: "image"; value: string };
```

需要扩展为：

```ts
export type MessagePart =
  | { type: "text"; value: string }
  | { type: "image"; value: string }
  | { type: "file"; label: string; value: string };
```

建议分片规则：

1. `![...](path)` -> `image`
2. `[...] (path)` 且 `path` 是本地路径 -> `file`
3. 其它内容 -> `text`

建议新增 helper：

```ts
function isLocalMarkdownLinkTarget(target: string): boolean
```

用于明确过滤：

- `https://...`
- `http://...`
- `mailto:...`
- `#anchor`

同时保留现有：

```ts
normalizeLegacyImageSyntax(text)
```

不新增 legacy file 语法，文件只支持标准 Markdown link。

### 8. 在 `ChannelManager.send()` 中支持按顺序发送文件

当前 `src/channels/manager.ts` 的 `send(chatJid, text)` 流程是：

1. 解析文本 / 图片 parts
2. 文本片段调用 `channel.sendMessage()`
3. 图片片段调用 `channel.sendImage()`

需要扩展为：

1. 解析文本 / 图片 / 文件 parts
2. 文本片段调用 `channel.sendMessage()`
3. 图片片段调用 `channel.sendImage()`
4. 文件片段调用 `channel.sendFile()`

行为要求：

1. 保持原始顺序
2. 若 channel 不支持图片或文件，则回退发送原始文本
3. 若单个文件发送失败，记录错误并给群里回退一条失败提示，然后继续发送后续片段

文件发送失败文案建议与图片一致：

```text
文件发送失败: <error message>
```

若错误对象里没有 message，则退化为：

```text
文件发送失败: <file path>
```

### 9. 为 Channel 增加 `sendFile?()`

当前 `src/channels/types.ts` 中：

```ts
export interface Channel {
  readonly type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendImage?(chatId: string, filePath: string): Promise<void>;
  listChats(): Promise<ChatInfo[]>;
}
```

需要扩展为：

```ts
sendFile?(chatId: string, filePath: string): Promise<void>;
```

原因：

1. 文件发送与图片发送是不同的平台消息类型
2. `ChannelManager.send()` 必须能分发 file part
3. 由 channel 自己判断平台是否支持最合理

### 10. 在 `FeishuChannel` 中实现文件上传与发送

飞书发送文件需要两步：

1. 上传文件，获取 `file_key`
2. 使用 `msg_type = "file"` 发送消息

参考本仓库图片上传现状，本次不直接使用 `client.im.file.create(...)`，而是优先采用与图片一致的 REST 方式：

1. 复用现有 `getTenantAccessToken()`
2. 新增 `uploadFileWithFetch(config, filePath)`
3. `fetch + FormData + Blob` POST 到：

```text
https://open.feishu.cn/open-apis/im/v1/files
```

表单字段建议为：

```text
file_type=<根据扩展名推断>
file_name=<原始文件名>
file=<二进制 Blob>
```

上传成功后，从响应中提取 `file_key`，随后发送：

```ts
await this.client.im.message.create({
  params: {
    receive_id_type: "chat_id",
  },
  data: {
    receive_id: chatId,
    content: JSON.stringify({ file_key: fileKey }),
    msg_type: "file",
  },
});
```

建议新增 helper：

```ts
type FeishuFileUploadResponse = {
  code?: number;
  msg?: string;
  data?: {
    file_key?: string;
  };
};

function inferFeishuFileType(filePath: string): string

async function uploadFileWithFetch(
  config: Pick<FeishuChannelConfig, "appId" | "appSecret">,
  filePath: string,
  fetchImpl: FetchLike = fetch,
): Promise<string>
```

`inferFeishuFileType()` 建议规则：

1. 取扩展名去掉 `.` 后转小写
2. 若为空，返回 `bin`
3. 第一版不做复杂 MIME 映射，直接以扩展名为准

例如：

- `report.pdf` -> `pdf`
- `archive.zip` -> `zip`
- `build.log` -> `log`
- `README` -> `bin`

### 11. 在 `send_message` 工具描述里显式暴露语法

本次不新增 `send_file` 工具，但需要让 agent 知道如何通过 `send_message` 发文件。

因此建议更新 `src/tools.ts` 中 `send_message` 的描述或参数说明，明确支持：

1. 普通文本
2. Markdown 图片语法
3. Markdown 文件链接语法

例如在描述里加入：

```text
Message content. Supports local Markdown images like ![alt](path.png) and local Markdown file links like [report.pdf](./report.pdf).
```

这样不需要增加新工具，也能让 agent 使用现有工具完成文件发送。

### 12. 错误处理与日志

需要保持与现有图片资源下载一致的可诊断性。

接收侧：

1. 解析 JSON 失败 -> `warn`
2. 缺少 `file_key` -> `warn`
3. 下载失败 -> `error`，记录：
   - `message_id`
   - `chat_id`
   - `file_key`
   - `type=file`
   - 飞书业务错误码与诊断建议

发送侧：

1. 文件大小 `<= 0` -> 直接抛错
2. token 获取失败 -> 报明确错误
3. 文件上传非 0 code -> 报明确错误
4. 最终 `message.create` 失败 -> 记录 `chatId`、`filePath`、`fileKey`

### 13. 测试方案

#### 13.1 `tests/feishu.test.ts`

新增或扩展以下覆盖：

1. `extractFilePayloadFromMessage()` 能正确提取 `file_key` 与 `file_name`
2. 通用资源下载 helper 在 `resourceType=file` 时会调用：
   - `params.type === "file"`
3. 文件下载会按预期落盘到：
   - `media/<chatId>/<messageId>-<sanitizedFileName>`
4. 下载成功后能生成 Markdown file 链接
5. 文件下载失败时，错误详情中的 `requestSummary.type` 为 `file`
6. `uploadFileWithFetch()` 能正确上传并返回 `file_key`
7. `uploadFileWithFetch()` 在飞书返回非 0 code 时会抛出明确错误

#### 13.2 `tests/message-parts.test.ts`

新增覆盖：

1. 继续保留 Markdown 图片解析
2. 本地 Markdown 文件链接会被解析成 `file` part
3. `https://...` 这类远程链接不会被解析成 `file`
4. 图片与文件混排时能保持顺序

#### 13.3 `tests/channel-manager.test.ts`

新增覆盖：

1. `send()` 能按顺序发送文本、图片、文件
2. channel 不支持文件发送时，回退到原始文本
3. 文件发送失败时会发送 `文件发送失败: ...` 提示并继续后续片段

本次不需要新增 `tests/providers.test.ts` 中的工具数量测试，因为不新增工具，只需要在需要时补充 `send_message` 描述的断言。

## Todo List

- [x] 在 `src/channels/feishu.ts` 中新增 `file` 消息识别分支
- [x] 在 `src/channels/feishu.ts` 中新增文件消息内容解析 helper
- [x] 将 message resource 下载 helper 泛化为支持 `image` / `file`
- [x] 为接收文件新增安全文件名清洗与落盘规则
- [x] 将接收文件转成 Markdown file 语法写入数据库
- [x] 在 `src/message-parts.ts` 中新增 Markdown file 解析能力
- [x] 在 `src/channels/types.ts` 中为 `Channel` 增加 `sendFile?()`
- [x] 在 `src/channels/manager.ts` 中扩展 `send()`，支持按顺序发送 file part
- [x] 在 `src/channels/feishu.ts` 中新增基于 `fetch + FormData` 的文件上传 helper
- [x] 在 `src/channels/feishu.ts` 中实现 `sendFile(chatId, filePath)`
- [x] 在 `src/tools.ts` 中更新 `send_message` 描述，显式说明 Markdown 文件语法
- [x] 增加或更新 `tests/feishu.test.ts`
- [x] 增加或更新 `tests/message-parts.test.ts`
- [x] 增加或更新 `tests/channel-manager.test.ts`
- [x] 运行相关测试并确认通过
